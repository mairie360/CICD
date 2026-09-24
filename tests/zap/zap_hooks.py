"""OpenAPI coverage gate for `zap-api-scan.py` (OWASP ZAP).

Shared by every API and BFF repo of the org. Mount this file into the ZAP
container and pass it with `--hook`:

    security-scan:
      image: zaproxy/zap-stable
      volumes:
        - ./cicd-repo/tests/zap/zap_hooks.py:/zap/wrk/zap_hooks.py:ro
      command:
        - zap-api-scan.py
        - -t
        - http://my-service:4000/openapi.json
        - -f
        - openapi
        - --hook
        - /zap/wrk/zap_hooks.py
        - ...

What it does, once the scan is over (`zap_pre_shutdown` hook, ZAP still up):

1. loads the OpenAPI spec (same document ZAP imported, see `_load_spec`),
2. reads every HTTP message ZAP sent to the target (`core/view/messages`),
3. maps each request (method + path) to an operation of the spec,
4. fails the scan (exit code 1, from the `pre_exit` hook) when
   - an operation of the spec received no request at all, or
   - an operation that requires authentication only received 401/403.

An operation is "public" (exempt from the authentication rule) when the spec
says so: an explicit `security: []` on the operation, or no `security`
requirement at all (neither on the operation nor at the top level). When the
spec declares no `security` anywhere, the authentication rule is disabled and a
warning is printed: declare the scheme in the spec to enable it.

Environment variables (all optional):

- `OPENAPI_COVERAGE_SPEC`: path of the spec to read instead of downloading the
  scan target (useful when the target is a file or is not served over HTTP).
- `OPENAPI_COVERAGE_BASE_URL`: base URL of the scanned service when it cannot
  be derived from the target / `-O` host override.

Only the Python standard library is used: the file must keep working inside the
stock `zaproxy/zap-stable` image.
"""

import json
import os
import re
import sys
import urllib.request
from urllib.parse import urlparse

HTTP_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")
UNAUTHENTICATED_STATUSES = {401, 403}
MESSAGES_PAGE_SIZE = 500

# Filled by the hooks below, in call order.
_state = {
    "target": None,
    "host_override": None,
    "result": None,
}


# ---------------------------------------------------------------------------
# Hooks called by zap-api-scan.py
# ---------------------------------------------------------------------------


def cli_opts(opts):
    """Remember the `-O` host override, it changes the base URL ZAP scanned."""
    for opt, arg in opts:
        if opt == "-O":
            _state["host_override"] = arg


def zap_started(zap, target):
    """Remember the scan target (`-t`)."""
    _state["target"] = target


def zap_pre_shutdown(zap):
    """Evaluate the coverage while ZAP is still reachable and print the report."""
    spec = _load_spec()
    listing = list_operations(spec)
    base_url = _base_url()
    messages = _fetch_messages(zap, base_url)
    result = evaluate_coverage(listing, messages, base_url, _server_base_paths(spec))
    _state["result"] = result
    print(format_report(result))


def pre_exit(fail_count, warn_count, pass_count):
    """Fail the scan after ZAP stopped so the report above is the last output."""
    result = _state["result"]
    if result is None:
        # zap_pre_shutdown never ran (scan crashed earlier): the script already
        # exits with code 3 in that case, nothing to add.
        return
    if result["failed"]:
        sys.stdout.flush()
        sys.exit(1)


# ---------------------------------------------------------------------------
# Spec handling
# ---------------------------------------------------------------------------


def list_operations(spec):
    """Return one dict per operation: method, path, public flag, matcher.

    Operations are sorted so that literal paths win over templated ones when a
    request matches both (`/sessions/history` before `/sessions/{id}`).
    """
    top_level_security = spec.get("security")
    spec_has_security = top_level_security not in (None, []) or any(
        op.get("security") not in (None, [])
        for item in spec.get("paths", {}).values()
        for method, op in item.items()
        if method in HTTP_METHODS and isinstance(op, dict)
    )
    operations = []
    for path, item in spec.get("paths", {}).items():
        if not isinstance(item, dict):
            continue
        for method in HTTP_METHODS:
            op = item.get(method)
            if not isinstance(op, dict):
                continue
            operations.append(
                {
                    "op": "%s %s" % (method.upper(), path),
                    "method": method.upper(),
                    "path": path,
                    "public": _is_public(op, top_level_security),
                    "regex": _path_regex(path),
                    "literal_segments": _literal_segments(path),
                    "statuses": [],
                }
            )
    operations.sort(key=lambda o: -o["literal_segments"])
    return {"operations": operations, "spec_has_security": spec_has_security}


def _is_public(operation, top_level_security):
    security = operation.get("security", top_level_security)
    return not security


def _path_regex(path_template):
    parts = re.split(r"(\{[^}]+\})", path_template)
    pattern = "".join("[^/]+" if p.startswith("{") else re.escape(p) for p in parts)
    # Exact match on purpose: ZAP builds its requests from the same spec, and the
    # active scanner's path variants (`/op/`, `/op/../x`) must not count as the
    # operation. They would let an operation that always answers 401 pass on a
    # router-level 404.
    return re.compile("^" + pattern + "$")


def _literal_segments(path_template):
    return sum(1 for seg in path_template.split("/") if seg and not seg.startswith("{"))


def _server_base_paths(spec):
    """Path prefixes the spec's `servers` may add in front of every path."""
    prefixes = {""}
    for server in spec.get("servers", []) or []:
        url = server.get("url", "") if isinstance(server, dict) else ""
        path = urlparse(url).path if "://" in url else url
        path = path.rstrip("/")
        if path and path.startswith("/"):
            prefixes.add(path)
    return prefixes


def _load_spec():
    explicit = os.environ.get("OPENAPI_COVERAGE_SPEC")
    target = _state["target"] or ""
    if explicit:
        source = explicit
    elif target.startswith("http://") or target.startswith("https://"):
        source = target
    else:
        # zap-api-scan.py resolves file targets relative to /zap/wrk.
        source = target if os.path.isabs(target) else os.path.join("/zap/wrk", target)

    if source.startswith("http://") or source.startswith("https://"):
        # Bypass any proxy configuration: we want the service itself, not ZAP.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(source, timeout=30) as response:
            raw = response.read()
    else:
        with open(source, "rb") as handle:
            raw = handle.read()
    spec = json.loads(raw)
    spec["__source__"] = source
    return spec


def _base_url():
    explicit = os.environ.get("OPENAPI_COVERAGE_BASE_URL")
    if explicit:
        return explicit.rstrip("/")
    target = _state["target"] or ""
    parsed = urlparse(target)
    override = _state["host_override"]
    if override:
        # `urlparse("host:8080")` reads "host" as a scheme: test for "://" instead.
        if "://" in override:
            parsed = urlparse(override)
        else:
            parsed = parsed._replace(netloc=override)
    if not parsed.scheme or not parsed.netloc:
        raise RuntimeError(
            "cannot derive the scanned base URL from target %r; set OPENAPI_COVERAGE_BASE_URL"
            % target
        )
    return "%s://%s" % (parsed.scheme, parsed.netloc)


# ---------------------------------------------------------------------------
# ZAP messages
# ---------------------------------------------------------------------------


def _fetch_messages(zap, base_url):
    """Page through `core/view/messages` for the scanned base URL."""
    messages = []
    start = 0
    while True:
        page = zap.core.messages(baseurl=base_url, start=start, count=MESSAGES_PAGE_SIZE)
        if not page:
            break
        messages.extend(page)
        if len(page) < MESSAGES_PAGE_SIZE:
            break
        start += len(page)
    return messages


def parse_message(message):
    """Return (method, path, status) from a ZAP message, or None if unreadable."""
    request_line = (message.get("requestHeader") or "").split("\r\n", 1)[0]
    response_line = (message.get("responseHeader") or "").split("\r\n", 1)[0]
    request_parts = request_line.split(" ")
    if len(request_parts) < 2:
        return None
    method = request_parts[0].upper()
    url = request_parts[1]
    path = urlparse(url).path if "://" in url else url.split("?", 1)[0]
    status = None
    response_parts = response_line.split(" ")
    if len(response_parts) >= 2 and response_parts[1].isdigit():
        status = int(response_parts[1])
    return method, path, status


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------


def evaluate_coverage(listing, messages, base_url, base_paths=None):
    operations = listing["operations"]
    base_paths = sorted(base_paths or {""}, key=len, reverse=True)
    unmatched = 0
    no_response = 0
    for message in messages:
        parsed = parse_message(message)
        if parsed is None:
            continue
        method, path, status = parsed
        operation = _match(operations, method, path, base_paths)
        if operation is None:
            unmatched += 1
            continue
        # ZAP records a status of 0 (or no response line) when the request got no
        # answer: that does not count as reaching the operation.
        if not status:
            no_response += 1
            continue
        operation["statuses"].append(status)

    missing = [op for op in operations if not op["statuses"]]
    unauthenticated = []
    if listing["spec_has_security"]:
        unauthenticated = [
            op
            for op in operations
            if op["statuses"]
            and not op["public"]
            and all(status in UNAUTHENTICATED_STATUSES for status in op["statuses"])
        ]
    return {
        "base_url": base_url,
        "operations": sorted(operations, key=lambda o: (o["path"], o["method"])),
        "messages": len(messages),
        "unmatched": unmatched,
        "no_response": no_response,
        "missing": missing,
        "unauthenticated": unauthenticated,
        "spec_has_security": listing["spec_has_security"],
        "failed": bool(missing or unauthenticated),
    }


def _match(operations, method, path, base_paths):
    for prefix in base_paths:
        if prefix and not path.startswith(prefix + "/") and path != prefix:
            continue
        relative = path[len(prefix):] or "/"
        for operation in operations:
            if operation["method"] == method and operation["regex"].match(relative):
                return operation
    return None


def format_report(result):
    lines = [
        "",
        "OpenAPI coverage (ZAP) for %s" % result["base_url"],
        "  %d operations in the spec, %d messages recorded by ZAP "
        "(%d outside the spec, %d without response)"
        % (len(result["operations"]), result["messages"], result["unmatched"], result["no_response"]),
    ]
    if not result["spec_has_security"]:
        lines.append(
            "  WARNING: the spec declares no `security` requirement, the authenticated-reach "
            "rule is disabled; declare the auth scheme in the spec to enable it"
        )
    for op in result["operations"]:
        statuses = sorted(set(op["statuses"]))
        if not statuses:
            state = "MISSING"
        elif op in result["unauthenticated"]:
            state = "UNAUTHENTICATED"
        else:
            state = "ok"
        lines.append(
            "  %-15s %-6s %s  statuses=%s%s"
            % (
                state,
                op["method"],
                op["path"],
                ",".join(str(s) for s in statuses) or "-",
                "  (public)" if op["public"] else "",
            )
        )
    if result["failed"]:
        lines.append(
            "OPENAPI COVERAGE FAILED: %d operation(s) not reached, %d only answered 401/403"
            % (len(result["missing"]), len(result["unauthenticated"]))
        )
        lines.append(
            "  Every operation of the spec must be exercised by ZAP with valid credentials "
            "(see mairie360/CICD README, 'OpenAPI coverage gate')."
        )
    else:
        lines.append("OPENAPI COVERAGE PASSED: every operation reached with a non-401/403 answer")
    return "\n".join(lines)
