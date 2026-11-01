"""Runs the "Mirror the commit as main" step of next-version/action.yml on a throwaway repo (MAIR-494).

v4.4.0 only redirected `<repo url>.git` to the mirror, while semantic-release reads the checkout's
`origin` (`https://github.com/<owner>/<repo>`, no `.git`): it saw main's real tip, found the commit
"behind the remote" and every prod promotion skipped its release.
"""
import os
import re
import subprocess
import tempfile
import textwrap
from pathlib import Path
import unittest

ACTION = Path(__file__).parents[1] / 'action.yml'
URL = 'https://github.com/mairie360/Example_API'


def run(*args, cwd=None, env=None):
    return subprocess.run(args, cwd=cwd, env=env, check=True, capture_output=True, text=True).stdout.strip()


def step_script(name):
    text = ACTION.read_text(encoding='utf-8')
    block = text.split('- name: {}\n'.format(name), 1)[1].split('\n    - name: ', 1)[0]
    script = block.split('run: |\n', 1)[1]
    return textwrap.dedent(script)


class MirrorStepTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.repo = root / 'repo'
        self.repo.mkdir()
        git = lambda *a: run('git', *a, cwd=self.repo)
        git('init', '-q', '-b', 'main')
        git('config', 'user.email', 't@example.com')
        git('config', 'user.name', 't')
        git('commit', '-q', '--allow-empty', '-m', 'feat: first')
        git('tag', 'v1.0.0')
        git('commit', '-q', '--allow-empty', '-m', 'feat: promoted')
        self.sha = git('rev-parse', 'HEAD')
        git('commit', '-q', '--allow-empty', '-m', 'fix: newer, not promoted')
        # Same remote as actions/checkout: the https URL without `.git`.
        git('remote', 'add', 'origin', URL)
        self.env = dict(os.environ, SHA=self.sha, BRANCH='main', SERVER_URL='https://github.com',
                        GITHUB_REPOSITORY='mairie360/Example_API', RUNNER_TEMP=str(root),
                        GITHUB_OUTPUT=str(root / 'out'), GIT_TERMINAL_PROMPT='0')
        run('bash', '-c', step_script('Mirror the commit as main'), cwd=self.repo, env=self.env)

    def heads(self, url):
        return run('git', 'ls-remote', '--heads', url, 'main', cwd=self.repo, env=self.env).split('\t')[0]

    def test_both_url_forms_resolve_to_the_promoted_commit(self):
        for url in (URL, URL + '.git', run('git', 'remote', 'get-url', 'origin', cwd=self.repo)):
            with self.subTest(url=url):
                self.assertEqual(self.heads(url), self.sha)

    def test_the_mirror_carries_the_tags(self):
        tags = run('git', 'ls-remote', '--tags', URL, cwd=self.repo, env=self.env)
        self.assertRegex(tags, r'refs/tags/v1\.0\.0$')

    def test_the_checkout_is_the_promoted_commit_on_main(self):
        self.assertEqual(run('git', 'rev-parse', 'HEAD', cwd=self.repo), self.sha)
        self.assertEqual(run('git', 'rev-parse', '--abbrev-ref', 'HEAD', cwd=self.repo), 'main')

    def test_the_action_no_longer_relies_on_repository_url(self):
        # cycjimmy passes it as `{ r: ... }`, which semantic-release's API ignores.
        self.assertIsNone(re.search(r'^\s*repository_url:', ACTION.read_text(encoding='utf-8'), re.M))


if __name__ == '__main__':
    unittest.main()
