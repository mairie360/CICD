"""Pins of this repository's own workflows."""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"


def version(tag):
    return tuple(int(part) for part in tag.lstrip("v").split("."))


class GdprCallerTest(unittest.TestCase):
    """MAIR-686: Renovate's pull requests on this repository must pass the GDPR checklist."""

    def setUp(self):
        self.text = (WORKFLOWS / "gdpr-pr.yml").read_text(encoding="utf-8")

    def test_mair_686_gdpr_caller_runs_a_release_that_skips_bot_pull_requests(self):
        # v4.12.0 blocked every Renovate pull request: the bot exemption came with v4.12.1.
        uses = re.findall(r"uses: mairie360/CICD/\.github/workflows/gdpr-pr-cicd\.yml@(v\d+\.\d+\.\d+)", self.text)
        inputs = re.findall(r"cicd_version: (v\d+\.\d+\.\d+)", self.text)
        self.assertEqual(len(uses), 1)
        self.assertEqual(inputs, uses)
        self.assertGreaterEqual(version(uses[0]), (4, 12, 1))

    def test_mair_686_gdpr_caller_passes_only_the_ai_review_secrets(self):
        self.assertNotIn("secrets: inherit", self.text)
        passed = re.findall(r"(?m)^ {6}([A-Z0-9_]+): \$\{\{ secrets\.([A-Z0-9_]+) \}\}$", self.text)
        self.assertEqual(passed, [("ANTHROPIC_REVIEW_API_KEY", "ANTHROPIC_REVIEW_API_KEY"),
                                  ("ANTHROPIC_WORKSPACE_ID", "ANTHROPIC_WORKSPACE_ID")])


if __name__ == "__main__":
    unittest.main()
