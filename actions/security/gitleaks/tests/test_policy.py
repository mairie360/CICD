"""MAIR-677: the scanned commits must not choose the rules they are scanned with.

The actions used to let Gitleaks load the checkout's `.gitleaks.toml` and
`.gitleaksignore`, so a pull request could allowlist its own secret.
`policy.sh` now reads both from the pull request's base (or the default
branch on a push) and the scan runs on a clone without a working tree. The
Docker cases replay that flow with the pinned image; they are skipped when
docker is not available.
"""
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest

from test_inline_allow import LEAK_EXIT, image

HERE = os.path.dirname(__file__)
POLICY = os.path.join(HERE, "..", "policy.sh")
DEFAULT_CONFIG = os.path.join(HERE, "..", "gitleaks.toml")
ENV = dict(os.environ, GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@t",
           GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@t")
# Fake PAT built at runtime, so this file never matches a rule itself.
TOKEN = "ghp" + "_" + hashlib.sha256(b"mair-677-policy").hexdigest()[:36]


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, env=ENV, check=True,
                          capture_output=True, text=True).stdout.strip()


def write(cwd, name, text):
    with open(os.path.join(cwd, name), "w") as f:
        f.write(text)


def commit(cwd, files, message="c"):
    for name, text in files.items():
        write(cwd, name, text)
    git(cwd, "add", "-A")
    git(cwd, "commit", "-q", "-m", message)
    return git(cwd, "rev-parse", "HEAD")


class Repo:
    """An `origin` with a `main`, cloned like actions/checkout does."""

    def __init__(self, main_files):
        self.tmp = tempfile.TemporaryDirectory()
        origin = os.path.join(self.tmp.name, "origin")
        os.makedirs(origin)
        git(origin, "init", "-q", "-b", "main")
        self.main = commit(origin, {"README": "x", **main_files})
        self.path = os.path.join(self.tmp.name, "clone")
        git(self.tmp.name, "clone", "-q", origin, self.path)
        git(self.path, "checkout", "-q", "-b", "feature")

    def policy(self, base, default_config=DEFAULT_CONFIG):
        out = os.path.join(self.tmp.name, "policy")
        trusted = subprocess.run(
            [POLICY, base, "main", out, *([default_config] if default_config else [])],
            cwd=self.path, check=True, capture_output=True, text=True).stdout.strip()
        files = {}
        for name in (".gitleaksignore", "gitleaks.toml"):
            p = os.path.join(out, name)
            if os.path.exists(p):
                with open(p) as f:
                    files[name] = f.read()
        return trusted, out, files

    def close(self):
        self.tmp.cleanup()


class PolicySourceTest(unittest.TestCase):
    def setUp(self):
        self.repo = Repo({".gitleaksignore": "base-fingerprint\n",
                          ".gitleaks.toml": "# base config\n"})
        commit(self.repo.path, {".gitleaksignore": "head-fingerprint\n",
                                ".gitleaks.toml": "# head config\n"})

    def tearDown(self):
        self.repo.close()

    def test_pull_request_reads_the_base_not_the_head(self):
        trusted, _, files = self.repo.policy(self.repo.main)
        self.assertEqual(trusted, self.repo.main)
        self.assertEqual(files[".gitleaksignore"], "base-fingerprint\n")
        self.assertEqual(files["gitleaks.toml"], "# base config\n")

    def test_push_reads_the_default_branch(self):
        trusted, _, files = self.repo.policy("")
        self.assertEqual(trusted, self.repo.main)
        self.assertEqual(files[".gitleaksignore"], "base-fingerprint\n")

    def test_push_to_the_default_branch_reads_the_commit_before_it(self):
        # Pushed straight to main: origin/main is the scanned commit, so the
        # callers pass `before` and no fallback branch.
        head = git(self.repo.path, "rev-parse", "HEAD")
        git(self.repo.path, "update-ref", "refs/remotes/origin/main", head)
        out = os.path.join(self.repo.tmp.name, "policy-main")
        trusted = subprocess.run([POLICY, self.repo.main, "", out, DEFAULT_CONFIG],
                                 cwd=self.repo.path, check=True, capture_output=True,
                                 text=True).stdout.strip()
        self.assertEqual(trusted, self.repo.main)
        with open(os.path.join(out, ".gitleaksignore")) as f:
            self.assertEqual(f.read(), "base-fingerprint\n")

    def test_new_default_branch_without_before_gets_the_defaults(self):
        head = git(self.repo.path, "rev-parse", "HEAD")
        git(self.repo.path, "update-ref", "refs/remotes/origin/main", head)
        out = os.path.join(self.repo.tmp.name, "policy-new")
        trusted = subprocess.run([POLICY, "0" * 40, "", out, DEFAULT_CONFIG],
                                 cwd=self.repo.path, check=True, capture_output=True,
                                 text=True).stdout.strip()
        self.assertEqual(trusted, "")
        with open(os.path.join(out, ".gitleaksignore")) as f:
            self.assertEqual(f.read(), "")

    def test_unknown_base_falls_back_to_the_default_branch(self):
        trusted, _, _ = self.repo.policy("0" * 40)
        self.assertEqual(trusted, self.repo.main)


class ActionWiringTest(unittest.TestCase):
    def test_both_actions_scan_a_mirror_with_the_trusted_policy(self):
        for name in ("gitleaks", "gitleaks-binary"):
            with open(os.path.join(HERE, "..", "..", name, "action.yml")) as f:
                text = f.read()
            with self.subTest(action=name):
                self.assertIn("policy.sh", text)
                self.assertIn("git clone -q --mirror", text)
                self.assertIn("--gitleaks-ignore-path", text)
                self.assertNotIn('-v "$GITHUB_WORKSPACE:/repo"', text)
                self.assertIn('elif [ "$GITHUB_REF" = "refs/heads/$DEFAULT_BRANCH" ]', text)


class PolicyDefaultsTest(unittest.TestCase):
    def setUp(self):
        self.repo = Repo({})
        commit(self.repo.path, {".gitleaksignore": "head-fingerprint\n",
                                ".gitleaks.toml": "# head config\n"})

    def tearDown(self):
        self.repo.close()

    def test_base_without_policy_gives_the_action_defaults(self):
        _, _, files = self.repo.policy(self.repo.main)
        self.assertEqual(files[".gitleaksignore"], "")
        with open(DEFAULT_CONFIG) as f:
            self.assertEqual(files["gitleaks.toml"], f.read())

    def test_without_default_config_gitleaks_keeps_its_built_in_rules(self):
        _, _, files = self.repo.policy(self.repo.main, default_config=None)
        self.assertNotIn("gitleaks.toml", files)


@unittest.skipUnless(shutil.which("docker"), "docker not available")
class SelfAllowlistTest(unittest.TestCase):
    """A pull request that adds a secret and its own `.gitleaksignore` entry."""

    def scan(self, repo, source, policy_dir=None, log_opts=None):
        args = ["docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
                "-v", f"{source}:/repo:ro", "-w", "/repo"]
        flags = []
        if policy_dir:
            args += ["-v", f"{policy_dir}:/policy:ro"]
            flags = ["--config", "/policy/gitleaks.toml",
                     "--gitleaks-ignore-path", "/policy/.gitleaksignore"]
        if log_opts:
            flags.append(f"--log-opts={log_opts}")
        return subprocess.run(
            [*args, image(), "git", "/repo", *flags, "--redact", "--no-banner",
             "--ignore-gitleaks-allow", "--exit-code", str(LEAK_EXIT)],
            capture_output=True, text=True)

    def fingerprint(self, repo):
        result = subprocess.run(
            ["docker", "run", "--rm", "--user", f"{os.getuid()}:{os.getgid()}",
             "-v", f"{repo.path}:/repo:ro", "-w", "/repo", image(), "git", "/repo",
             "--no-banner", "--report-format", "json", "--report-path", "-"],
            capture_output=True, text=True)
        return json.loads(result.stdout)[0]["Fingerprint"]

    def test_head_ignore_entry_no_longer_silences_its_own_secret(self):
        repo = Repo({})
        try:
            commit(repo.path, {"values.yaml": f'token: "{TOKEN}"\n'})
            fp = self.fingerprint(repo)
            head = commit(repo.path, {".gitleaksignore": fp + "\n"})
            log_opts = f"{repo.main}..{head}"
            # Before: the checkout's own ignore list silenced the finding.
            self.assertEqual(self.scan(repo, repo.path, log_opts=log_opts).returncode, 0)
            # Now: policy from the base, scan of a mirror clone.
            _, policy_dir, _ = repo.policy(repo.main)
            mirror = os.path.join(repo.tmp.name, "repo.git")
            git(repo.tmp.name, "clone", "-q", "--mirror", repo.path, mirror)
            result = self.scan(repo, mirror, policy_dir, log_opts)
            self.assertEqual(result.returncode, LEAK_EXIT, result.stderr[-500:])
        finally:
            repo.close()

    def test_ignore_entry_merged_on_the_default_branch_still_applies(self):
        repo = Repo({})
        try:
            origin = os.path.join(repo.tmp.name, "origin")
            commit(origin, {"values.yaml": f'token: "{TOKEN}"\n'})
            git(repo.path, "fetch", "-q")
            git(repo.path, "checkout", "-q", "-B", "main", "origin/main")
            fp = self.fingerprint(repo)
            commit(origin, {".gitleaksignore": fp + "\n"})
            git(repo.path, "fetch", "-q")
            git(repo.path, "reset", "-q", "--hard", "origin/main")
            _, policy_dir, files = repo.policy("")
            self.assertEqual(files[".gitleaksignore"], fp + "\n")
            mirror = os.path.join(repo.tmp.name, "repo.git")
            git(repo.tmp.name, "clone", "-q", "--mirror", repo.path, mirror)
            result = self.scan(repo, mirror, policy_dir)
            self.assertEqual(result.returncode, 0, result.stdout[-500:] + result.stderr[-500:])
        finally:
            repo.close()


if __name__ == "__main__":
    unittest.main()
