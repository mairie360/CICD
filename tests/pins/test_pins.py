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


def uses_references(text):
    """Every `uses:` reference of a workflow or composite action, with the comment that follows it."""
    return re.findall(r"^\s*-?\s*uses:\s*(\S+)[ \t]*(#[^\n]*)?$", text, flags=re.MULTILINE)


def unpinned_third_party(text):
    """Third-party references that are not a commit SHA followed by a `# <ref>` comment on the same line.

    The comment is the tag Renovate keeps up to date (`# v7`), or the branch or tool it follows
    (`# stable`, `# cargo-llvm-cov`); on another line Renovate does not read it.

    Local actions (`./`) and our own `mairie360/` references are not third-party: the latter stay on
    their release tags and move with `cicd_version`.
    """
    problems = []
    for reference, comment in uses_references(text):
        if reference.startswith("./") or reference.startswith("mairie360/") or reference.startswith("docker://"):
            continue
        if not re.fullmatch(r"[\w.-]+/[\w./-]+@[0-9a-f]{40}", reference) or not re.fullmatch(r"#\s*[\w.+-]+", comment or ""):
            problems.append(reference)
    return problems


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

class ThirdPartyActionsPinnedTest(unittest.TestCase):
    """MAIR-686: a moved tag must not change what runs with the CI secrets."""

    def test_mair_686_every_third_party_action_is_pinned_by_sha_with_its_tag_in_a_comment(self):
        files = sorted(list(WORKFLOWS.glob("*.y*ml")) + list((ROOT / "actions").rglob("action.y*ml")) + list((ROOT / ".github" / "actions").rglob("action.y*ml")))
        self.assertGreater(len(files), 50)
        references = 0
        problems = {}
        for path in files:
            text = path.read_text(encoding="utf-8")
            references += len(uses_references(text))
            found = unpinned_third_party(text)
            if found:
                problems[str(path.relative_to(ROOT))] = found
        self.assertGreater(references, 100)
        self.assertEqual(problems, {})

    def test_mair_686_a_moving_tag_a_missing_comment_and_an_abbreviated_sha_are_refused(self):
        sha = "3d3c42e" + "0" * 33
        self.assertEqual(unpinned_third_party(f"      - uses: actions/checkout@{sha} # v7\n"), [])
        self.assertEqual(unpinned_third_party("      - uses: actions/checkout@v7\n"), ["actions/checkout@v7"])
        self.assertEqual(unpinned_third_party("      - uses: actions/checkout@main # v7\n"), ["actions/checkout@main"])
        self.assertEqual(unpinned_third_party(f"      - uses: actions/checkout@{sha}\n"), [f"actions/checkout@{sha}"])
        self.assertEqual(unpinned_third_party(f"      # v7\n      - uses: actions/checkout@{sha}\n"), [f"actions/checkout@{sha}"])
        self.assertEqual(unpinned_third_party(f"      - uses: actions/checkout@{sha[:7]} # v7\n"), [f"actions/checkout@{sha[:7]}"])
        self.assertEqual(unpinned_third_party(f"      - uses: actions/cache/save@{sha} # v5.0.1\n"), [])

    def test_mair_686_local_and_own_references_are_not_third_party(self):
        text = "uses: ./actions/promote/resolve\nuses: mairie360/CICD/.github/workflows/x.yml@v5.14.2\nuses: docker://alpine:3\n"
        self.assertEqual(unpinned_third_party(text), [])


if __name__ == "__main__":
    unittest.main()
