"""MAIR-677: range the Gitleaks actions scan when the push base is unknown.

The actions used to fall back to `-1 <sha>` (the tip only) on a new branch or
a force-push, so a secret added in an earlier commit of that push was never
scanned. Each case builds a throwaway clone and checks which commits
`log-opts.sh` makes `git log` (hence Gitleaks) walk.
"""
import os
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(__file__), "..", "log-opts.sh")
ZERO = "0" * 40


def git(cwd, *args):
    env = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
               GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True,
                          capture_output=True, text=True).stdout.strip()


class LogOptsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        origin = os.path.join(self.tmp.name, "origin")
        os.makedirs(origin)
        git(origin, "init", "-q", "-b", "main")
        self.main_commits = [self.commit(origin, f"main{i}") for i in range(2)]
        self.repo = os.path.join(self.tmp.name, "clone")
        git(self.tmp.name, "clone", "-q", origin, self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    def commit(self, cwd, name):
        with open(os.path.join(cwd, name), "w") as f:
            f.write(name)
        git(cwd, "add", name)
        git(cwd, "commit", "-q", "-m", name)
        return git(cwd, "rev-parse", "HEAD")

    def scanned(self, base, sha, default="main"):
        opts = subprocess.run([SCRIPT, base, sha, default], cwd=self.repo, check=True,
                              capture_output=True, text=True).stdout.split()
        return set(git(self.repo, "log", "--format=%H", *opts).split())

    def test_known_base_scans_the_new_commits_only(self):
        git(self.repo, "checkout", "-q", "-b", "feature")
        new = [self.commit(self.repo, f"f{i}") for i in range(2)]
        self.assertEqual(self.scanned(self.main_commits[-1], new[-1]), set(new))

    def test_new_branch_scans_every_commit_of_the_branch(self):
        # The secret sits in the first commit, the tip is clean.
        git(self.repo, "checkout", "-q", "-b", "feature")
        leak = self.commit(self.repo, "leak")
        tip = self.commit(self.repo, "clean")
        self.assertEqual(self.scanned(ZERO, tip), {leak, tip})

    def test_force_push_with_a_lost_base_scans_the_rewritten_commits(self):
        git(self.repo, "checkout", "-q", "-b", "feature")
        leak = self.commit(self.repo, "leak")
        tip = self.commit(self.repo, "clean")
        lost = "1" * 40  # previous tip, no longer fetched
        self.assertEqual(self.scanned(lost, tip), {leak, tip})

    def test_rewritten_default_branch_scans_the_whole_history(self):
        tip = git(self.repo, "rev-parse", "HEAD")
        self.assertEqual(self.scanned("", tip), set(self.main_commits))

    def test_unknown_default_branch_fails_closed(self):
        git(self.repo, "checkout", "-q", "-b", "feature")
        tip = self.commit(self.repo, "f")
        self.assertEqual(self.scanned(ZERO, tip, default=""), set(self.main_commits) | {tip})


if __name__ == "__main__":
    unittest.main()
