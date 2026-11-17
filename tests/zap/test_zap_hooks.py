"""Unit tests of the OpenAPI coverage gate shared by every API and BFF (MAIR-542).

Run: python3 -m unittest discover -s tests/zap -v
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("zap_hooks", os.path.join(HERE, "zap_hooks.py"))
hooks = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hooks)

SPEC = {
    "servers": [{"url": "/api"}],
    "security": [{"bearer": []}],
    "paths": {
        "/health": {"get": {"security": []}},
        "/users/{id}": {"get": {}, "delete": {}},
        "/users/me": {"get": {}},
    },
}


def message(method, path, status):
    return {
        "requestHeader": "%s http://svc:3000%s HTTP/1.1\r\nHost: svc\r\n" % (method, path),
        "responseHeader": "HTTP/1.1 %s X\r\n" % status if status is not None else "",
    }


def evaluate(messages, spec_doc=SPEC):
    listing = hooks.list_operations(spec_doc)
    return hooks.evaluate_coverage(
        listing, messages, "http://svc:3000", hooks._server_base_paths(spec_doc)
    )


class ListOperationsTest(unittest.TestCase):
    def test_literal_path_wins_over_templated_one(self):
        ops = [o["op"] for o in hooks.list_operations(SPEC)["operations"]]
        self.assertLess(ops.index("GET /users/me"), ops.index("GET /users/{id}"))

    def test_explicit_empty_security_is_public(self):
        by_op = {o["op"]: o for o in hooks.list_operations(SPEC)["operations"]}
        self.assertTrue(by_op["GET /health"]["public"])
        self.assertFalse(by_op["GET /users/me"]["public"])

    def test_spec_without_security_disables_the_auth_rule(self):
        spec_doc = {"paths": {"/a": {"get": {}}}}
        self.assertFalse(hooks.list_operations(spec_doc)["spec_has_security"])
        result = evaluate([message("GET", "/a", 401)], spec_doc)
        self.assertEqual(result["unauthenticated"], [])
        self.assertFalse(result["failed"])


class EvaluateCoverageTest(unittest.TestCase):
    def full(self):
        return [
            message("GET", "/api/health", 200),
            message("GET", "/api/users/42", 200),
            message("DELETE", "/api/users/42", 204),
            message("GET", "/api/users/me", 200),
        ]

    def test_every_operation_reached_passes(self):
        result = evaluate(self.full())
        self.assertFalse(result["failed"])
        self.assertIn("OPENAPI COVERAGE PASSED", hooks.format_report(result))

    def test_operation_never_requested_fails(self):
        result = evaluate(self.full()[:-1])
        self.assertTrue(result["failed"])
        self.assertEqual([o["op"] for o in result["missing"]], ["GET /users/me"])
        self.assertIn("OPENAPI COVERAGE FAILED", hooks.format_report(result))

    def test_operation_only_answering_401_or_403_fails(self):
        messages = self.full()[:-1] + [message("GET", "/api/users/me", 401), message("GET", "/api/users/me", 403)]
        result = evaluate(messages)
        self.assertTrue(result["failed"])
        self.assertEqual([o["op"] for o in result["unauthenticated"]], ["GET /users/me"])

    def test_public_operation_may_only_answer_401(self):
        messages = [m for m in self.full() if "/health" not in m["requestHeader"]] + [message("GET", "/api/health", 401)]
        self.assertFalse(evaluate(messages)["failed"])

    def test_request_without_response_does_not_count(self):
        messages = self.full()[:-1] + [message("GET", "/api/users/me", None)]
        result = evaluate(messages)
        self.assertTrue(result["failed"])
        self.assertEqual(result["no_response"], 1)

    def test_path_variant_does_not_count_as_the_operation(self):
        # a trailing slash is the active scanner's variant, not the operation
        messages = self.full()[:-1] + [message("GET", "/api/users/me/", 200)]
        result = evaluate(messages)
        self.assertEqual([o["op"] for o in result["missing"]], ["GET /users/me"])
        self.assertEqual(result["unmatched"], 1)


class ParseMessageTest(unittest.TestCase):
    def test_query_string_is_dropped(self):
        self.assertEqual(
            hooks.parse_message({"requestHeader": "get /a?x=1 HTTP/1.1\r\n", "responseHeader": "HTTP/1.1 404 NF\r\n"}),
            ("GET", "/a", 404),
        )

    def test_unreadable_request_is_ignored(self):
        self.assertIsNone(hooks.parse_message({"requestHeader": "", "responseHeader": ""}))


class BaseUrlAndSpecTest(unittest.TestCase):
    def setUp(self):
        self.state = mock.patch.dict(hooks._state, {"target": "http://svc:3000/openapi.json", "host_override": None})
        self.state.start()
        self.env = mock.patch.dict(os.environ, {}, clear=False)
        self.env.start()
        os.environ.pop("OPENAPI_COVERAGE_BASE_URL", None)
        os.environ.pop("OPENAPI_COVERAGE_SPEC", None)

    def tearDown(self):
        self.env.stop()
        self.state.stop()

    def test_base_url_comes_from_the_target(self):
        self.assertEqual(hooks._base_url(), "http://svc:3000")

    def test_host_override_replaces_the_netloc(self):
        hooks.cli_opts([("-O", "other:8080")])
        self.assertEqual(hooks._base_url(), "http://other:8080")

    def test_env_override_wins(self):
        os.environ["OPENAPI_COVERAGE_BASE_URL"] = "http://x:1/"
        self.assertEqual(hooks._base_url(), "http://x:1")

    def test_file_target_without_scheme_needs_an_explicit_base_url(self):
        hooks.zap_started(None, "openapi.json")
        with self.assertRaises(RuntimeError):
            hooks._base_url()

    def test_spec_is_read_from_the_env_file(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(SPEC, handle)
        try:
            os.environ["OPENAPI_COVERAGE_SPEC"] = handle.name
            self.assertEqual(hooks._load_spec()["paths"], SPEC["paths"])
        finally:
            os.unlink(handle.name)


class PreExitTest(unittest.TestCase):
    def test_failed_coverage_exits_one(self):
        with mock.patch.dict(hooks._state, {"result": {"failed": True}}):
            with self.assertRaises(SystemExit) as raised:
                hooks.pre_exit(0, 0, 0)
        self.assertEqual(raised.exception.code, 1)

    def test_passed_coverage_does_not_exit(self):
        with mock.patch.dict(hooks._state, {"result": {"failed": False}}):
            hooks.pre_exit(0, 0, 0)

    def test_scan_that_crashed_before_the_hook_adds_nothing(self):
        with mock.patch.dict(hooks._state, {"result": None}):
            hooks.pre_exit(0, 0, 0)


if __name__ == "__main__":
    unittest.main()
