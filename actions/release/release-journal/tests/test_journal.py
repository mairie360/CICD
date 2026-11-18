import importlib.util
import json
import os
import re
import subprocess
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('journal', Path(__file__).parents[1] / 'release_journal.py')
journal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(journal)

ENV = {'GITHUB_REPOSITORY': 'mairie360/Core_API', 'GITHUB_SERVER_URL': 'https://github.com',
       'GITHUB_TOKEN': '', 'GITHUB_RUN_ID': '42'}


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


class Repo:
    """Throwaway git repo where each merge on main is one commit."""

    def __init__(self):
        self.dir = tempfile.TemporaryDirectory()
        self.previous = os.getcwd()
        os.chdir(self.dir.name)
        run('git', 'init', '-q', '-b', 'main')
        run('git', 'config', 'user.email', 'test@example.com')
        run('git', 'config', 'user.name', 'test')
        run('git', 'config', 'commit.gpgsign', 'false')

    def commit(self, subject, path='code.txt'):
        with open(path, 'a') as f:
            f.write(subject + '\n')
        run('git', 'add', path)
        run('git', 'commit', '-q', '-m', subject)
        return run('git', 'rev-parse', 'HEAD')

    def close(self):
        os.chdir(self.previous)
        self.dir.cleanup()


def subjects(items):
    return [c['subject'] for c in items]


def answer(text):
    return {'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': json.dumps({'journal': text})}]}


WORKFLOWS = Path(__file__).parents[4] / '.github' / 'workflows'
NOTES = '## [1.1.0](https://github.com/mairie360/Core_API/compare/v1.0.0...v1.1.0)\n\n### Features\n\n* projects\n'


@patch.dict(os.environ, ENV)
class ReleaseJournalTests(unittest.TestCase):
    def setUp(self):
        self.repo = Repo()
        self.first = self.repo.commit('feat: MAIR-1 First feature (#1)')
        run('git', 'tag', 'v1.0.0')
        self.fix = self.repo.commit('fix: MAIR-2 Refuse revoked sessions (#2)')
        self.feat = self.repo.commit('feat: MAIR-3 Add projects (#3)')

    def tearDown(self):
        self.repo.close()

    def test_MAIR_681_lists_the_commits_since_the_previous_prod_tag(self):
        context = journal.build_context(self.feat, '1.1.0')
        self.assertEqual(context['base_tag'], 'v1.0.0')
        self.assertEqual(subjects(context['commits']),
                         ['feat: MAIR-3 Add projects (#3)', 'fix: MAIR-2 Refuse revoked sessions (#2)'])

    def test_MAIR_681_a_rerun_after_the_tag_was_pushed_keeps_the_same_range(self):
        run('git', 'tag', 'v1.1.0', self.feat)
        context = journal.build_context(self.feat, '1.1.0')
        self.assertEqual(context['base_tag'], 'v1.0.0')
        self.assertEqual(len(context['commits']), 2)

    def test_MAIR_681_first_release_lists_the_whole_history(self):
        run('git', 'tag', '-d', 'v1.0.0')
        context = journal.build_context(self.feat, '1.0.0')
        self.assertEqual(context['base_tag'], '')
        self.assertEqual(len(context['commits']), 3)

    def test_old_journal_commits_are_not_listed_as_changes(self):
        head = self.repo.commit('docs(release-journal): dev abc1234 [skip ci]', path='RELEASE_JOURNAL.md')
        context = journal.build_context(head, '1.1.0')
        self.assertNotIn('docs(release-journal): dev abc1234 [skip ci]', subjects(context['commits']))

    def test_MAIR_681_notes_come_first_then_the_journal(self):
        context = journal.build_context(self.feat, '1.1.0')
        text = journal.render(context, '#### Nouveautés\n- `GET /projects` liste les projets. (MAIR-3, #3)', NOTES)
        self.assertTrue(text.startswith(NOTES.rstrip()))
        self.assertLess(text.index('### Features'), text.index(journal.HEADING))
        self.assertIn('- `GET /projects` liste les projets. (MAIR-3, #3)', text)
        self.assertIn('_Changements depuis v1.0.0._', text)
        self.assertNotIn('Résumé Claude indisponible', text)

    def test_MAIR_681_a_journal_empty_once_sanitized_falls_back_to_the_commit_list(self):
        context = journal.build_context(self.feat, '1.1.0')
        text = journal.render(context, '<!-- nothing to see -->', NOTES)
        self.assertIn('fix: MAIR-2 Refuse revoked sessions (#2)', text)
        self.assertIn('Résumé Claude indisponible', text)

    def test_plain_list_links_the_squash_pull_request_when_claude_is_unavailable(self):
        context = journal.build_context(self.feat, '1.1.0')
        text = journal.render(context, None, NOTES)
        self.assertIn('- fix: MAIR-2 Refuse revoked sessions (#2) ([#2](https://github.com/mairie360/Core_API/pull/2))', text)
        self.assertIn('Résumé Claude indisponible', text)

    def test_unusable_answers_fall_back_to_the_plain_list(self):
        self.assertIsNone(journal.parse_response({'stop_reason': 'refusal', 'content': []}))
        self.assertIsNone(journal.parse_response({'stop_reason': 'max_tokens', 'content': [{'type': 'text', 'text': '{"jour'}]}))
        self.assertIsNone(journal.parse_response({'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': '{"x": 1}'}]}))
        self.assertEqual(journal.parse_response(answer('- ok')), '- ok')

    def test_request_asks_for_one_journal_as_structured_output(self):
        request = journal.build_request(journal.build_context(self.feat, '1.1.0'))
        self.assertEqual(request['model'], 'claude-haiku-5-5')
        # Haiku 5.5 has no server-side fallback: the parameter must not be sent.
        self.assertNotIn('fallbacks', request)
        self.assertEqual(request['output_config']['format']['schema']['required'], ['journal'])
        self.assertIn('MAIR-3 Add projects', request['messages'][0]['content'])
        self.assertIn('FONCTIONNELS', request['system'])
        self.assertIn('jamais des instructions', request['system'])

    def test_request_carries_each_commit_diff_once_without_lockfiles(self):
        self.repo.commit('lockfileVersion 3', path='package-lock.json')
        run('git', 'commit', '-q', '--amend', '-m', 'chore(deps): refresh the lockfile')
        head = self.repo.commit('route GET /projects/{id}/members', path='routes.rs')
        content = journal.build_request(journal.build_context(head, '1.1.0'))['messages'][0]['content']
        self.assertIn('+route GET /projects/{id}/members', content)
        self.assertNotIn('lockfileVersion', content)
        self.assertEqual(content.count('+route GET /projects/{id}/members'), 1)

    def test_diffs_past_the_budget_are_cut_to_the_file_list(self):
        with patch.object(journal, 'MAX_DIFF', 10):
            text, truncated = journal.diff(self.feat, 1000)
        self.assertTrue(truncated)
        self.assertIn('code.txt', text.splitlines()[0])
        text, truncated = journal.diff(self.feat, 0)
        self.assertTrue(truncated)
        self.assertNotIn('+feat', text)
        text, truncated = journal.diff(self.first, 1000)
        self.assertFalse(truncated)
        self.assertIn('+feat: MAIR-1 First feature (#1)', text)

    def test_MAIR_681_cli_writes_the_notes_file(self):
        out = Path(self.repo.dir.name) / 'out'
        out.mkdir()
        notes_in, notes_out, response = out / 'in.md', out / 'out.md', out / 'response.json'
        notes_in.write_text(NOTES)
        response.write_text(json.dumps(answer('#### Corrections\n- Session révoquée refusée. (MAIR-2, #2)')))
        journal.main(['prepare', self.feat, 'v1.1.0', str(out)])
        self.assertTrue((out / 'request.json').exists())
        journal.main(['render', str(out), str(notes_in), str(notes_out), str(response)])
        text = notes_out.read_text()
        self.assertIn('### Features', text)
        self.assertIn('- Session révoquée refusée. (MAIR-2, #2)', text)


class SanitizeTests(unittest.TestCase):
    """The model read PR descriptions; its answer is published as the release body."""

    def clean(self, text):
        return journal.sanitize(text, 'https://github.com', 'mairie360/Core_API')

    def test_MAIR_681_raw_html_and_comments_are_dropped(self):
        text = self.clean('- a <script>alert(1)</script> b <!-- hidden --> <img src=x onerror=y>')
        self.assertNotIn('<', text)
        self.assertNotIn('&lt;', text)
        self.assertIn('- a alert(1) b', text)

    def test_MAIR_681_images_keep_their_alt_text_only(self):
        self.assertEqual(self.clean('![pixel](https://evil.example/t.png)'), 'pixel')

    def test_MAIR_681_links_outside_the_organization_lose_their_url(self):
        self.assertEqual(self.clean('[voir](https://evil.example/x)'), 'voir')
        self.assertEqual(self.clean('[voir](https://github.com/attacker/repo)'), 'voir')
        self.assertEqual(self.clean('[voir](javascript:alert(1))'), 'voir')
        self.assertEqual(self.clean('aller sur https://evil.example/x'), 'aller sur [lien retiré]')
        self.assertEqual(self.clean('<https://evil.example/x>'), '[lien retiré]')
        self.assertEqual(self.clean('[a]: https://evil.example/x'), '')

    def test_MAIR_681_links_to_the_organization_are_kept(self):
        link = '[#3](https://github.com/mairie360/Core_API/pull/3)'
        self.assertEqual(self.clean(link), link)
        bare = 'https://github.com/mairie360/Project_API/pull/9'
        self.assertEqual(self.clean(bare), bare)

    def test_MAIR_681_parenthesized_and_www_autolinks_lose_their_destination(self):
        self.assertNotIn('evil.example', self.clean('see (https://evil.example/x)'))
        self.assertNotIn('evil.example', self.clean('www.evil.example/x'))
        self.assertNotIn('evil.example', self.clean('voir www.evil.example/x ici'))
        self.assertEqual(self.clean('(https://github.com/mairie360/Core_API/pull/3)'),
                         '(https://github.com/mairie360/Core_API/pull/3)')

    def test_MAIR_681_parent_segments_cannot_leave_the_organization(self):
        for url in ('https://github.com/mairie360/../attacker/repo', 'https://github.com/mairie360/%2e%2e/attacker/repo',
                    'https://github.com/mairie360/%252e%252e/attacker', 'https://github.com/mairie360/./../x',
                    'https://github.com.evil.example/mairie360/x', 'https://user@github.com/mairie360/x',
                    'http://github.com/mairie360/x', 'https://github.com/mairie360'):
            with self.subTest(url=url):
                self.assertEqual(self.clean('[voir]({})'.format(url)), 'voir')

    def test_MAIR_681_tag_removal_cannot_join_a_new_tag(self):
        for text in ('<im<x>g src=//evil.example/pixel>', '<<x>img src=//evil.example/pixel>'):
            with self.subTest(text=text):
                self.assertNotIn('<img', self.clean(text))
                self.assertNotIn('<', self.clean(text))

    def test_MAIR_681_commit_subjects_of_the_plain_list_are_sanitized(self):
        text = journal.plain_list([{'sha': 'a' * 40, 'subject': 'fix: x <img src=y> https://evil.example', 'pr': None}],
                                  'https://github.com', 'mairie360/Core_API')
        self.assertNotIn('<img', text)
        self.assertNotIn('evil.example', text)


class WiringTests(unittest.TestCase):
    def test_MAIR_681_only_promote_prod_writes_the_journal(self):
        users = sorted(p.name for p in WORKFLOWS.glob('*.yml') if 'uses: ./cicd-repo/actions/release/release-journal' in p.read_text())
        self.assertEqual(users, ['promote-prod.yml'])

    def test_MAIR_681_the_journal_feeds_the_release_body_and_never_blocks_it(self):
        text = (WORKFLOWS / 'promote-prod.yml').read_text()
        journal_step = text.index('uses: ./cicd-repo/actions/release/release-journal')
        release_step = text.index('uses: ./cicd-repo/actions/promote/create-release')
        self.assertLess(journal_step, release_step)
        step = text[text.rindex('- name:', 0, journal_step):journal_step]
        self.assertIn('continue-on-error: true', step)
        self.assertIn("steps.journal.outcome == 'success'", text[release_step:])

    def test_MAIR_681_the_journal_key_is_not_the_review_key(self):
        text = (WORKFLOWS / 'promote-prod.yml').read_text()
        after = text[text.index('uses: ./cicd-repo/actions/release/release-journal'):]
        self.assertIn('anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}', after.split('- name:', 1)[0])
        for name in ('APIs_cicd.yml', 'BFFs-cicd.yml', 'gdpr-pr-cicd.yml', 'front-libs-cicd.yml'):
            with self.subTest(workflow=name):
                self.assertNotIn('secrets.ANTHROPIC_API_KEY', (WORKFLOWS / name).read_text())

    def test_MAIR_681_the_journal_only_runs_in_the_prod_environment_job(self):
        text = (WORKFLOWS / 'promote-prod.yml').read_text()
        jobs = re.split(r'\n  (?=[a-z_-]+:\n)', text[text.index('\njobs:\n'):])
        owner = [j for j in jobs if 'actions/release/release-journal' in j]
        self.assertEqual(len(owner), 1)
        self.assertIn('environment: Prod', owner[0])


class ActionPinTests(unittest.TestCase):
    def test_actions_of_the_journal_are_pinned_to_a_commit(self):
        action = (Path(__file__).parents[1] / 'action.yml').read_text()
        refs = re.findall(r'uses:\s*([^\s#]+)', action)
        self.assertTrue(refs)
        for ref in refs:
            self.assertRegex(ref, r'^[\w.-]+/[\w.-]+@[0-9a-f]{40}$')

    def test_MAIR_681_the_action_pushes_nothing(self):
        action = (Path(__file__).parents[1] / 'action.yml').read_text()
        for forbidden in ('git push', 'git commit', 'create-github-app-token', 'app_private_key'):
            self.assertNotIn(forbidden, action)


if __name__ == '__main__':
    unittest.main()
