"""Runs create-release/release.sh against a local bare remote and a fake `gh` (MAIR-494).

v4.4.1 created the tag through the releases API (`gh release create --target <sha>`) and v4.4.2
pushed it with the checkout's GITHUB_TOKEN: GitHub refuses both (no `workflows` permission) when
the commit's workflows differ from main's, so images reached prod with no tag or release. The tag
is now pushed with the release app token and the release made on it.
"""
import base64
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

# Logs each git call, then runs the real git.
FAKE_GIT = """#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$GIT_LOG"
exec {real} "$@"
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
        real_git = run('bash', '-c', 'command -v git').stdout.strip()
        (bin_dir / 'git').write_text(FAKE_GIT.format(real=real_git))
        (bin_dir / 'git').chmod(0o755)
        self.git_log = root / 'git.log'
        (root / 'state').mkdir()
        self.log = root / 'gh.log'
        self.log.touch()
        notes = root / 'notes.md'
        notes.write_text('notes')
        self.env = dict(os.environ, PATH='{}:{}'.format(bin_dir, os.environ['PATH']), GH_LOG=str(self.log),
                        GH_STATE=str(root / 'state'), VERSION='2.2.0', SHA=self.sha, NOTES=str(notes),
                        GITHUB_REPOSITORY='mairie360/Example_API', GH_TOKEN='x',
                        PUSH_TOKEN='app-token', GIT_LOG=str(self.git_log))

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

    def test_the_tag_is_pushed_with_the_app_token_not_the_checkouts(self):
        self.release()
        pushes = [c for c in self.git_log.read_text().splitlines() if ' push ' in ' {} '.format(c)]
        self.assertEqual(len(pushes), 1)
        auth = base64.b64encode(b'x-access-token:app-token').decode()
        # The empty extraheader comes first: it drops the GITHUB_TOKEN header of the checkout.
        self.assertIn('-c http.https://github.com/.extraheader= -c http.https://github.com/.extraheader=AUTHORIZATION: basic {}'.format(auth), pushes[0])

    def test_without_the_app_token_nothing_is_pushed(self):
        self.env['PUSH_TOKEN'] = ''
        result = self.release(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIsNone(self.remote_tag())
        self.assertEqual(self.gh_calls(), [])

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

    def test_promote_prod_uses_the_action_with_the_release_app(self):
        text = WORKFLOW.read_text(encoding='utf-8')
        step = text.split('uses: ./cicd-repo/actions/promote/create-release', 1)[1].split('- name:', 1)[0]
        self.assertIn('app_id: ${{ secrets.RELEASE_APP_ID }}', step)
        self.assertIn('app_private_key: ${{ secrets.RELEASE_APP_PK }}', step)
        self.assertIsNone(re.search(r'gh release create[^\n]*--target', text))

    def test_the_app_credentials_are_checked_before_the_retag(self):
        text = WORKFLOW.read_text(encoding='utf-8')
        self.assertRegex(text, r'RELEASE_APP_ID:\n\s+required: true')
        self.assertRegex(text, r'RELEASE_APP_PK:\n\s+required: true')
        check = text.index('- name: Check the release app credentials')
        self.assertLess(check, text.index('- name: Promote image(s) to Prod'))

    def test_the_app_token_can_push_workflows(self):
        action = (ACTION / 'action.yml').read_text(encoding='utf-8')
        self.assertIn('permission-workflows: write', action)
        self.assertIn('PUSH_TOKEN: ${{ steps.app_token.outputs.token }}', action)


if __name__ == '__main__':
    unittest.main()
