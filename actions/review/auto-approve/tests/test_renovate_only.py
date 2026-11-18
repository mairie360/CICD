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


def run(sender, commits, event_head=None, current_head=None):
    lines = "".join(json.dumps(c) + "\n" for c in commits)
    head = commits[-1]["sha"] if commits else "f" * 40
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--sender", sender,
         "--event-head", event_head or head, "--current-head", current_head or head],
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

    def test_mair_685_a_stale_event_is_not_approved(self):
        # A later push moved the head: that push has its own run, this one approves nothing.
        a, b = commit("a" * 40), commit("b" * 40)
        approvable, reasons = renovate_only.decide("renovate[bot]", [a], "a" * 40, "b" * 40)
        self.assertFalse(approvable)
        self.assertEqual(reasons, ["stale event: head aaaaaaa, pull request now at bbbbbbb"])
        self.assertEqual(run("renovate[bot]", [a], current_head="b" * 40).returncode, 3)
        self.assertEqual(run("someone", [a], current_head="b" * 40).returncode, 3)
        # Head reset to an earlier Renovate commit after a later event: still refused.
        self.assertFalse(renovate_only.decide("renovate[bot]", [a], "b" * 40, "a" * 40)[0])
        # The commits were read after another push: their last one is not the event head.
        self.assertFalse(renovate_only.decide("renovate[bot]", [a, b], "a" * 40, "a" * 40)[0])

    def test_mair_685_the_event_head_read_with_its_commits_is_approved(self):
        a, b = commit("a" * 40), commit("b" * 40)
        self.assertEqual(renovate_only.decide("renovate[bot]", [a, b], "b" * 40, "b" * 40), (True, []))

    def test_mair_685_no_commit_is_not_approved(self):
        self.assertEqual(renovate_only.decide("renovate[bot]", []), (False, ["no commit"]))

    def test_mair_685_unreadable_input_exits_2(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPT), "--sender", "renovate[bot]", "--event-head", "a", "--current-head", "a"],
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
        refs = re.findall(r"(?m)^\s+ref: (.*)$", self.text)
        self.assertEqual(refs, ["${{ inputs.cicd_version || github.event.pull_request.base.sha }}"])

    def test_mair_685_approval_taken_back_whenever_the_check_did_not_say_true(self):
        steps = re.split(r"(?m)^      - name: ", self.text)
        approve = next(step for step in steps if step.startswith("Approve"))
        take_back = next(step for step in steps if step.startswith("Take back"))
        self.assertIn("if: steps.check.outputs.renovate_only == 'true'", approve)
        self.assertIn(
            "if: always() && steps.check.outputs.renovate_only != 'true' && steps.check.outputs.renovate_only != 'stale'",
            take_back,
        )
        check = next(step for step in steps if step.startswith("Check that"))
        self.assertIn('3) echo "renovate_only=stale"', check)

    def test_mair_685_approval_names_the_checked_revision(self):
        steps = re.split(r"(?m)^      - name: ", self.text)
        approve = next(step for step in steps if step.startswith("Approve"))
        self.assertIn('-f commit_id="$EVENT_HEAD"', approve)
        self.assertIn("EVENT_HEAD: ${{ github.event.pull_request.head.sha }}", approve)
        self.assertNotIn("hmarr/", self.text)
        check = next(step for step in steps if step.startswith("Check that"))
        self.assertIn('--event-head "$EVENT_HEAD" --current-head "$current"', check)
        self.assertLess(check.index("current=$("), check.index("commits=$("))
        # A head already known to have moved ends the step as stale before the commits are fetched.
        stale_exit = check.index('if [ "$current" != "$EVENT_HEAD" ]; then')
        self.assertLess(check.index("current=$("), stale_exit)
        self.assertLess(stale_exit, check.index("commits=$("))
        self.assertIn('echo "renovate_only=stale" >> "$GITHUB_OUTPUT"\n            exit 0', check)

    def test_mair_685_decision_comes_from_the_tested_script(self):
        self.assertIn("renovate_only.py", self.text)


if __name__ == "__main__":
    unittest.main()
