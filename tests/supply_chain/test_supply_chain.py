"""Supply-chain guards of the mairie360 CI/CD (MAIR-1193, control C-07 / D-12).

Static, replayable tests of the guards that protect the delivery chain from a public fork PR, from
dependency confusion on the internal packages, and from an unsigned image reaching a promotion. They
assert the configuration holds; the live scenarios (a real fork PR, an unsigned push) are run by hand
in a campaign window, these tests keep the guards from regressing.
"""

import pathlib
import re
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
ACTIONS = ROOT / "actions"
DOCKER_RELEASE = (ACTIONS / "release" / "docker-release" / "action.yml").read_text()


def load(path):
    return yaml.safe_load(path.read_text())


def workflow_files():
    return sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))


def triggers(doc):
    on = doc.get(True, doc.get("on", {}))  # PyYAML parses the bare key `on:` as the boolean True
    if isinstance(on, str):
        return {on}
    if isinstance(on, list):
        return set(on)
    return set(on or {})


# --------------------------------------------------------------------------- fork-PR safety

PR_REF = re.compile(r"pull_request\.head|head_ref|head\.sha|head\.ref", re.I)


class ForkPullRequestSafety(unittest.TestCase):
    def test_mair_1193_pull_request_target_never_checks_out_pr_code(self):
        offenders = []
        for path in workflow_files():
            doc = load(path)
            if "pull_request_target" not in triggers(doc):
                continue
            for job in (doc.get("jobs") or {}).values():
                for step in job.get("steps", []) or []:
                    uses, with_ = step.get("uses", ""), step.get("with", {}) or {}
                    if "actions/checkout" in uses and PR_REF.search(str(with_.get("ref", ""))):
                        offenders.append(f"{path.name}: checks out the PR head under pull_request_target")
        self.assertEqual(offenders, [], offenders)

    def test_mair_1193_only_auto_approve_uses_pull_request_target(self):
        using = {p.name for p in workflow_files() if "pull_request_target" in triggers(load(p))}
        # A new pull_request_target workflow must be reviewed here before it is added.
        self.assertEqual(using, {"auto-approve.yml"}, using)

    def test_mair_1193_auto_approve_is_minimal_and_code_free(self):
        doc = load(WORKFLOWS / "auto-approve.yml")
        self.assertEqual(doc.get("permissions"), {})  # no permission at the top level
        for job in doc["jobs"].values():
            perms = job.get("permissions", {})
            self.assertEqual(set(perms) - {"pull-requests"}, set(), f"extra permissions: {perms}")
            for step in job.get("steps", []) or []:
                if "actions/checkout" in step.get("uses", ""):
                    # A checkout is allowed only of this repo's own code at the BASE (never the PR
                    # head), with no credentials persisted, to run renovate_only.py.
                    with_ = step.get("with", {}) or {}
                    self.assertNotRegex(str(with_.get("ref", "")), PR_REF,
                                        "auto-approve must not check out the PR head")
                    self.assertIn("base.sha", str(with_.get("ref", "")))
                    self.assertIs(with_.get("persist-credentials"), False)

    def test_mair_1193_renovate_only_guard_is_tested(self):
        self.assertTrue((ACTIONS / "review" / "auto-approve" / "renovate_only.py").is_file())
        self.assertTrue((ACTIONS / "review" / "auto-approve" / "tests").is_dir())


# --------------------------------------------------------------------------- dependency confusion

class DependencyConfusion(unittest.TestCase):
    def test_mair_1193_internal_npm_scope_is_pinned_to_github_packages(self):
        # The OpenAPI publishers pin the @<org> scope to GitHub Packages, so npm never resolves an
        # internal package name from the public registry (dependency confusion).
        for name in ("publish-openapi-rust", "publish-openapi-typescript"):
            text = (ACTIONS / "release" / name / "action.yml").read_text()
            self.assertIn(":registry=https://npm.pkg.github.com", text, name)

    def test_mair_1193_no_untrusted_npm_registry(self):
        allowed = ("registry.npmjs.org", "npm.pkg.github.com")
        for path in list(WORKFLOWS.glob("*.y*ml")) + list(ACTIONS.rglob("action.yml")):
            for match in re.finditer(r"registry=https?://([^\s\"'/]+)", path.read_text()):
                self.assertIn(match.group(1), allowed, f"{path}: npm registry {match.group(1)}")

    def test_mair_1193_no_cargo_source_replacement(self):
        # A replaced crates-io source or an alternate registry would let a crates.io name resolve
        # elsewhere. This repo ships no Cargo source/registry override.
        for config in list(ROOT.rglob(".cargo/config*")) + list(ROOT.rglob("Cargo.toml")):
            text = config.read_text()
            self.assertNotIn("replace-with", text, str(config))
            self.assertNotRegex(text, r"\[registries\.", str(config))


# --------------------------------------------------------------------------- image signing (C-07/D-12)

class ImageSigning(unittest.TestCase):
    def test_mair_1193_dev_stage_signs_the_image(self):
        self.assertIn("cosign sign --yes", DOCKER_RELEASE)

    def test_mair_1193_promotion_verifies_the_signature(self):
        # staging / prod verify the dev / staging digest's signature, bound to the signing workflow's
        # identity and to the promoted commit, before re-tagging it.
        for needle in ("cosign verify",
                       "--certificate-oidc-issuer https://token.actions.githubusercontent.com",
                       "--certificate-identity-regexp",
                       "--certificate-github-workflow-sha"):
            self.assertIn(needle, DOCKER_RELEASE, needle)

    def test_mair_1193_unsigned_digest_is_refused(self):
        # The promotion's verify step must let cosign's failure propagate: an unsigned digest cannot
        # be promoted. Isolate that step and check its failure is not suppressed.
        doc = load(ACTIONS / "release" / "docker-release" / "action.yml")
        steps = doc["runs"]["steps"]
        verify = next(s for s in steps if "Verify signature" in s.get("name", ""))
        run = verify["run"]
        self.assertIn("cosign verify", run)
        self.assertNotEqual(verify.get("continue-on-error"), True)
        self.assertTrue(run.lstrip().startswith("set -euo pipefail"), "verify must run under set -e")
        # No failure suppression on the verification itself (the verify helper, or its calls).
        for line in run.splitlines():
            if "cosign verify" in line or line.strip().startswith("verify "):
                self.assertNotIn("|| true", line)
                self.assertNotIn("|| :", line)


# --------------------------------------------------------------------------- zizmor is blocking

class ZizmorBlocking(unittest.TestCase):
    def test_mair_1193_zizmor_blocks_at_high(self):
        doc = load(WORKFLOWS / "lint.yml")
        job = doc["jobs"]["zizmor"]
        self.assertNotEqual(job.get("continue-on-error"), True)
        blocking = [s for s in job["steps"] if "--min-severity=high" in s.get("run", "")]
        self.assertEqual(len(blocking), 1, "exactly one blocking zizmor step at the High severity")
        step = blocking[0]
        # The blocking step must not swallow a failure, nor be marked continue-on-error.
        self.assertNotEqual(step.get("continue-on-error"), True)
        for token in ("|| true", "|| :", "|| echo", "exit 0"):
            self.assertNotIn(token, step["run"], f"blocking zizmor step suppresses failure with {token}")
        # The separate non-blocking reporting step is allowed to swallow (it does not gate).
        reporting = [s for s in job["steps"] if "--min-severity" not in s.get("run", "") and "zizmor" in s.get("run", "")]
        self.assertTrue(reporting, "a non-blocking reporting step still runs")

    def test_mair_1193_zizmor_config_justifies_each_ignore(self):
        config = load(ROOT / ".github" / "zizmor.yml")
        self.assertIn("rules", config)
        # Every ignored rule is present with at least one entry; the comments justify them in the file.
        for rule, body in config["rules"].items():
            self.assertTrue(body.get("ignore"), rule)


if __name__ == "__main__":
    unittest.main()
