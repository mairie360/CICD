"""Runs create-release/release.sh against a local bare remote and a fake `gh` (MAIR-494).

v4.4.1 created the tag through the releases API (`gh release create --target <sha>`), which the
run's token is refused (HTTP 403) when the commit changes `.github/workflows`: images reached prod
but no tag or release was created. The tag is now pushed with git and the release made on it.
"""
import os
import re
import subprocess
import tempfile
from pathlib import Path
import unittest

ACTION = Path(__file__).parents[1]
SCRIPT = ACTION / 'release.sh'
WORKFLOW = Path(__file__).parents[4] / '.github' / 'workflows' / 'promote-prod.yml'

# Records every call; `release view` succeeds once `release create` ran (state in $GH_STATE).
FAKE_GH = """#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "release view") [ -f "$GH_STATE/$3" ] ;;
  "release create") touch "$GH_STATE/$3" ;;
  *) exit 1 ;;
esac
"""


def run(*args, cwd=None, env=None, check=True):
    return subprocess.run(args, cwd=cwd, env=env, check=check, capture_output=True, text=True)


class CreateReleaseTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.remote = root / 'remote.git'
        run('git', 'init', '-q', '--bare', str(self.remote))
        self.repo = root / 'repo'
        self.repo.mkdir()
        git = lambda *a: run('git', *a, cwd=self.repo).stdout.strip()
        git('init', '-q', '-b', 'main')
        git('config', 'user.email', 't@example.com')
        git('config', 'user.name', 't')
        git('commit', '-q', '--allow-empty', '-m', 'feat: older')
        self.older = git('rev-parse', 'HEAD')
        git('commit', '-q', '--allow-empty', '-m', 'ci: promoted, changes .github/workflows')
        self.sha = git('rev-parse', 'HEAD')
        git('remote', 'add', 'origin', str(self.remote))
        git('push', '-q', 'origin', 'main')
        bin_dir = root / 'bin'
        bin_dir.mkdir()
        (bin_dir / 'gh').write_text(FAKE_GH)
        (bin_dir / 'gh').chmod(0o755)
        (root / 'state').mkdir()
        self.log = root / 'gh.log'
        self.log.touch()
        notes = root / 'notes.md'
        notes.write_text('notes')
        self.env = dict(os.environ, PATH='{}:{}'.format(bin_dir, os.environ['PATH']), GH_LOG=str(self.log),
                        GH_STATE=str(root / 'state'), VERSION='2.2.0', SHA=self.sha, NOTES=str(notes),
                        GITHUB_REPOSITORY='mairie360/Example_API', GH_TOKEN='x')

    def release(self, check=True):
        return run('bash', str(SCRIPT), cwd=self.repo, env=self.env, check=check)

    def remote_tag(self):
        out = run('git', 'ls-remote', '--tags', str(self.remote), 'refs/tags/v2.2.0').stdout.split()
        return out[0] if out else None

    def gh_calls(self):
        return self.log.read_text().splitlines()

    def test_the_tag_is_pushed_with_git_on_the_promoted_commit(self):
        self.release()
        self.assertEqual(self.remote_tag(), self.sha)

    def test_the_release_is_created_on_the_existing_tag_not_by_the_api(self):
        self.release()
        creates = [c for c in self.gh_calls() if c.startswith('release create')]
        self.assertEqual(len(creates), 1)
        self.assertIn('--verify-tag', creates[0])
        self.assertNotIn('--target', creates[0])

    def test_a_rerun_keeps_the_tag_and_the_release(self):
        self.release()
        self.release()
        self.assertEqual(self.remote_tag(), self.sha)
        self.assertEqual(len([c for c in self.gh_calls() if c.startswith('release create')]), 1)

    def test_an_existing_tag_without_release_gets_its_release(self):
        run('git', 'push', '-q', str(self.remote), '{}:refs/tags/v2.2.0'.format(self.sha), cwd=self.repo)
        self.release()
        self.assertEqual(len([c for c in self.gh_calls() if c.startswith('release create')]), 1)

    def test_a_tag_on_another_commit_is_refused(self):
        run('git', 'push', '-q', str(self.remote), '{}:refs/tags/v2.2.0'.format(self.older), cwd=self.repo)
        result = self.release(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('already exists on', result.stdout)
        self.assertEqual(self.remote_tag(), self.older)
        self.assertEqual([c for c in self.gh_calls() if c.startswith('release create')], [])

    def test_promote_prod_uses_the_action(self):
        text = WORKFLOW.read_text(encoding='utf-8')
        self.assertIn('./cicd-repo/actions/promote/create-release', text)
        self.assertIsNone(re.search(r'gh release create[^\n]*--target', text))


if __name__ == '__main__':
    unittest.main()
