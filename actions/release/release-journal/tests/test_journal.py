import importlib.util
import json
import os
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


def answer(**sections):
    return {'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': json.dumps(sections)}]}


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

    def stage(self, stage, sha, version='', text=''):
        context = journal.build_context(stage, sha, version, text)
        return context, journal.render(context, None)

    def test_dev_release_lists_main_since_the_last_prod_tag(self):
        context, _ = self.stage('dev', self.feat)
        self.assertEqual(context['refs']['prod_tag'], 'v1.0.0')
        self.assertEqual(subjects(context['ranges']['since_prod']),
                         ['feat: MAIR-3 Add projects (#3)', 'fix: MAIR-2 Refuse revoked sessions (#2)'])
        self.assertEqual(context['ranges']['since_prod'], context['ranges']['dev_staging'])
        self.assertEqual(context['ranges']['staging_prod'], [])

    def test_staging_promotion_moves_the_commits_from_dev_staging_to_staging_prod(self):
        _, text = self.stage('dev', self.feat)
        context, text = self.stage('staging', self.fix, text=text)
        self.assertEqual(subjects(context['ranges']['dev_staging']), ['feat: MAIR-3 Add projects (#3)'])
        self.assertEqual(subjects(context['ranges']['staging_prod']), ['fix: MAIR-2 Refuse revoked sessions (#2)'])

    def test_prod_release_empties_staging_prod_and_resets_since_prod_on_the_new_tag(self):
        _, text = self.stage('dev', self.feat)
        _, text = self.stage('staging', self.fix, text=text)
        run('git', 'tag', 'v1.1.0', self.fix)
        context, text = self.stage('prod', self.fix, version='1.1.0', text=text)
        self.assertEqual(context['refs']['prod_tag'], 'v1.1.0')
        self.assertEqual(context['ranges']['staging_prod'], [])
        self.assertEqual(subjects(context['ranges']['since_prod']), ['feat: MAIR-3 Add projects (#3)'])
        self.assertIn('| prod | v1.1.0 |', text)

    def test_a_late_older_run_never_moves_a_pointer_back(self):
        _, text = self.stage('dev', self.feat)
        context, _ = self.stage('dev', self.fix, text=text)
        self.assertEqual(context['refs']['dev'], self.feat)

    def test_journal_commits_are_not_listed_as_changes(self):
        self.repo.commit('docs(release-journal): dev abc1234 [skip ci]', path='RELEASE_JOURNAL.md')
        context, _ = self.stage('dev', run('git', 'rev-parse', 'HEAD'))
        self.assertNotIn('docs(release-journal): dev abc1234 [skip ci]', subjects(context['ranges']['since_prod']))

    def test_state_and_history_survive_a_rewrite(self):
        _, text = self.stage('dev', self.feat)
        _, text = self.stage('staging', self.fix, text=text)
        self.assertEqual(journal.read_state(text)['staging'], self.fix)
        self.assertEqual(len(journal.read_history(text)), 2)
        self.assertTrue(journal.read_history(text)[0].split('|')[2].strip() == 'staging')

    def test_plain_lists_link_the_squash_pull_request_when_claude_is_unavailable(self):
        _, text = self.stage('dev', self.feat)
        self.assertIn('- fix: MAIR-2 Refuse revoked sessions (#2) ([#2](https://github.com/mairie360/Core_API/pull/2))', text)
        self.assertIn('Résumé Claude indisponible', text)

    def test_claude_sections_replace_the_plain_lists(self):
        context, _ = self.stage('dev', self.feat)
        sections = journal.parse_response(answer(
            since_prod='#### Nouveautés\n- Projets.', dev_staging='#### Nouveautés\n- Projets.', staging_prod=''))
        text = journal.render(context, sections)
        self.assertIn('#### Nouveautés\n- Projets.', text)
        self.assertNotIn('Résumé Claude indisponible', text)

    def test_unusable_answers_fall_back_to_the_plain_lists(self):
        self.assertIsNone(journal.parse_response({'stop_reason': 'refusal', 'content': []}))
        self.assertIsNone(journal.parse_response({'stop_reason': 'max_tokens', 'content': [{'type': 'text', 'text': '{"since'}]}))
        self.assertIsNone(journal.parse_response(answer(since_prod='x')))

    def test_request_asks_for_the_three_sections_as_structured_output(self):
        context, _ = self.stage('dev', self.feat)
        request = journal.build_request(context)
        self.assertEqual(request['model'], 'claude-opus-5-5')
        schema = request['output_config']['format']['schema']
        self.assertEqual(schema['required'], ['since_prod', 'dev_staging', 'staging_prod'])
        self.assertIn('MAIR-3 Add projects', request['messages'][0]['content'])
        self.assertIn('FONCTIONNELS', request['system'])

    def test_request_carries_each_commit_diff_once_without_lockfiles(self):
        self.repo.commit('lockfileVersion 3', path='package-lock.json')
        run('git', 'commit', '-q', '--amend', '-m', 'chore(deps): refresh the lockfile')
        self.repo.commit('route GET /projects/{id}/members', path='routes.rs')
        context, _ = self.stage('dev', run('git', 'rev-parse', 'HEAD'))
        content = journal.build_request(context)['messages'][0]['content']
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


if __name__ == '__main__':
    unittest.main()
