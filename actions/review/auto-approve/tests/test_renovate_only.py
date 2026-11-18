import io
import json
import pathlib
import re
import subprocess
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import renovate_only  # noqa: E402

SCRIPT = HERE.parent / "renovate_only.py"
WORKFLOW = HERE.parents[3] / ".github" / "workflows" / "auto-approve.yml"


def commit(sha="a" * 40, author="renovate[bot]", committer="web-flow", verified=True):
    return {
        "sha": sha,
        "author": {"login": author} if author else None,
        "committer": {"login": committer} if committer else None,
        "commit": {"verification": {"verified": verified}},
    }


def run(sender, commits):
    lines = "".join(json.dumps(c) + "\n" for c in commits)
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--sender", sender],
        input=lines, capture_output=True, text=True, check=False,
    )


class RenovateOnlyTest(unittest.TestCase):
    """MAIR-685: approve a Renovate pull request only while Renovate alone wrote and pushed it."""

    def test_mair_685_renovate_commits_pushed_by_renovate_are_approved(self):
        self.assertEqual(renovate_only.decide("renovate[bot]", [commit(), commit("b" * 40)]), (True, []))
        self.assertEqual(run("renovate[bot]", [commit()]).returncode, 0)

    def test_mair_685_a_human_commit_blocks_the_approval(self):
        approvable, reasons = renovate_only.decide("renovate[bot]", [commit(), commit("c" * 40, author="someone")])
        self.assertFalse(approvable)
        self.assertEqual(reasons, ["commit ccccccc (author someone)"])
        self.assertEqual(run("renovate[bot]", [commit(author="someone")]).returncode, 1)

    def test_mair_685_a_push_by_someone_else_blocks_the_approval(self):
        # A human can forge the author of a commit made through the API: the pusher still shows.
        self.assertEqual(renovate_only.decide("someone", [commit()]), (False, ["pushed by someone"]))

    def test_mair_685_a_local_or_unsigned_commit_blocks_the_approval(self):
        self.assertFalse(renovate_only.decide("renovate[bot]", [commit(committer="someone")])[0])
        self.assertFalse(renovate_only.decide("renovate[bot]", [commit(verified=False)])[0])
        self.assertFalse(renovate_only.decide("renovate[bot]", [commit(author=None)])[0])

    def test_mair_685_no_commit_is_not_approved(self):
        self.assertEqual(renovate_only.decide("renovate[bot]", []), (False, ["no commit"]))

    def test_mair_685_unreadable_input_exits_2(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--sender", "renovate[bot]"],
            input="not json\n", capture_output=True, text=True, check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertEqual(renovate_only.read_commits(io.StringIO("\n")), [])


class WorkflowWiringTest(unittest.TestCase):
    """MAIR-685: the reusable workflow keeps its scope minimal and never runs the pull request's code."""

    def setUp(self):
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def test_mair_685_callable_and_triggered_on_every_push_to_the_branch(self):
        self.assertRegex(self.text, r"(?m)^  workflow_call:")
        self.assertRegex(self.text, r"(?m)^    types: \[opened, reopened, synchronize\]$")

    def test_mair_685_only_pull_requests_write(self):
        self.assertRegex(self.text, r"(?m)^permissions: \{\}$")
        scopes = re.findall(r"(?m)^ {6}([a-z-]+): (read|write)$", self.text)
        self.assertEqual(scopes, [("pull-requests", "write")])

    def test_mair_685_third_party_action_pinned_by_full_sha(self):
        uses = re.findall(r"(?m)^\s+(?:- )?uses: (\S+)", self.text)
        third_party = [ref for ref in uses if not ref.startswith("./")]
        self.assertTrue(third_party)
        for ref in third_party:
            self.assertRegex(ref, r"@[0-9a-f]{40}$", ref)

    def test_mair_685_never_checks_out_the_pull_request(self):
        for block in re.findall(r"actions/checkout@[^\n]*\n((?:\s{8,}.*\n)*)", self.text):
            self.assertIn("repository: mairie360/CICD", block)
        self.assertNotIn("head.sha", self.text)
        self.assertNotIn("head.ref", self.text)

    def test_mair_685_decision_comes_from_the_tested_script(self):
        self.assertIn("renovate_only.py", self.text)


if __name__ == "__main__":
    unittest.main()
