"""Pins of this repository's own workflows."""

import pathlib
import re
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"


class UniqueKeyLoader(yaml.SafeLoader):
    """Refuses a duplicated key, which the default loader silently overwrites."""

    def construct_mapping(self, node, deep=False):
        keys = [self.construct_object(key, deep=deep) for key, _ in node.value]
        duplicated = {key for key in keys if keys.count(key) > 1}
        if duplicated:
            raise yaml.constructor.ConstructorError(None, None, f"duplicated keys {duplicated}", node.start_mark)
        return super().construct_mapping(node, deep=deep)


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
        job = yaml.load(self.text, Loader=UniqueKeyLoader)["jobs"]["gdpr"]
        self.assertEqual(job["secrets"], {
            "ANTHROPIC_REVIEW_API_KEY": "${{ secrets.ANTHROPIC_REVIEW_API_KEY }}",
            "ANTHROPIC_WORKSPACE_ID": "${{ secrets.ANTHROPIC_WORKSPACE_ID }}",
        })

    def test_mair_686_a_duplicated_key_is_refused(self):
        with self.assertRaises(yaml.constructor.ConstructorError):
            yaml.load("a: 1\na: 2\n", Loader=UniqueKeyLoader)

if __name__ == "__main__":
    unittest.main()
