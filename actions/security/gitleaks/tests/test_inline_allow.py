"""MAIR-677: an inline `gitleaks:allow` comment must not silence a finding.

Both secret-scan actions pass `--ignore-gitleaks-allow` and take their range
from `log-opts.sh` (never the tip alone). The Docker case runs the pinned
image on a throwaway repo; it is skipped when docker is not available.
"""
import hashlib
import os
import re
import shutil
import subprocess
import tempfile
import unittest

HERE = os.path.dirname(__file__)
ACTIONS = {
    "gitleaks": os.path.join(HERE, "..", "action.yml"),
    "gitleaks-binary": os.path.join(HERE, "..", "..", "gitleaks-binary", "action.yml"),
}


def image():
    with open(ACTIONS["gitleaks"]) as f:
        return re.search(r'default: "(zricethezav/gitleaks:[^"]+)"', f.read()).group(1)


class ActionFlagsTest(unittest.TestCase):
    def test_both_actions_ignore_inline_allow_and_share_the_range(self):
        for name, path in ACTIONS.items():
            with open(path) as f:
                text = f.read()
            with self.subTest(action=name):
                self.assertIn("--ignore-gitleaks-allow", text)
                self.assertIn("log-opts.sh", text)
                self.assertNotIn("-1 $GITHUB_SHA", text)


@unittest.skipUnless(shutil.which("docker"), "docker not available")
class InlineAllowTest(unittest.TestCase):
    def scan(self, *flags):
        with tempfile.TemporaryDirectory() as repo:
            # Fake PAT built at runtime, so this file never matches a rule itself.
            token = "ghp" + "_" + hashlib.sha256(b"mair-677").hexdigest()[:36]
            with open(os.path.join(repo, "values.yaml"), "w") as f:
                f.write(f'token: "{token}" # gitleaks:allow\n')
            env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
                       GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
            for cmd in (["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "t"]):
                subprocess.run(["git", *cmd], cwd=repo, env=env, check=True)
            return subprocess.run(
                ["docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
                 "-v", f"{repo}:/repo", "-w", "/repo", image(),
                 "git", "/repo", "--redact", "--no-banner", "--exit-code", "1", *flags],
                capture_output=True).returncode

    def test_inline_allow_is_honoured_without_the_flag(self):
        self.assertEqual(self.scan(), 0)

    def test_inline_allow_is_ignored_with_the_flag(self):
        self.assertEqual(self.scan("--ignore-gitleaks-allow"), 1)


if __name__ == "__main__":
    unittest.main()
