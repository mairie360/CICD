"""nightly-check/check.py: when the nightly rehearsal of the promotion gates runs (MAIR-1008)."""
import datetime
import importlib.util
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('check', Path(__file__).parents[1] / 'check.py')
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

MONDAY = datetime.date(2026, 11, 16)
TUESDAY = datetime.date(2026, 11, 17)


def git(*args):
    return subprocess.run(['git', *args], check=True, capture_output=True, text=True).stdout.strip()


class DecideTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        previous = os.getcwd()
        os.chdir(tmp.name)
        self.addCleanup(os.chdir, previous)
        git('init', '-q', '-b', 'main')
        git('config', 'user.email', 't@example.com')
        git('config', 'user.name', 't')
        self.env = {'EVENT_NAME': 'schedule', 'AI_WEEKDAY': '1'}

    def commit(self, subject):
        git('commit', '-q', '--allow-empty', '-m', subject)
        git('update-ref', 'refs/remotes/origin/main', 'HEAD')
        return git('rev-parse', 'HEAD')

    def test_first_night_runs_on_the_newest_commit_with_a_pipeline(self):
        feat = self.commit('feat: one')
        self.commit('docs(release-journal): dev one [skip ci]')
        outputs, _ = check.decide(self.env, TUESDAY, None)
        self.assertEqual(outputs, {'sha': feat, 'run': 'true', 'ai': 'false'})

    def test_skipped_when_only_journal_commits_landed_since_the_green_night(self):
        self.commit('feat: one')
        green_head = self.commit('docs(release-journal): dev one [skip ci]')
        self.commit('docs(release-journal): staging one [skip ci]')
        outputs, reason = check.decide(self.env, TUESDAY, green_head)
        self.assertEqual(outputs['run'], 'false')
        self.assertIn('already passed', reason)

    def test_runs_again_when_the_upstream_images_moved_without_a_commit(self):
        green_head = self.commit('feat: one')
        outputs, reason = check.decide(self.env, TUESDAY, green_head, 'new', 'old')
        self.assertEqual(outputs['run'], 'true')
        self.assertIn('upstream images', reason)

    def test_runs_again_when_the_upstream_digests_cannot_be_read(self):
        green_head = self.commit('feat: one')
        outputs, _ = check.decide(self.env, TUESDAY, green_head, None, 'old')
        self.assertEqual(outputs['run'], 'true')

    def test_skipped_when_commit_and_upstream_digests_are_unchanged(self):
        green_head = self.commit('feat: one')
        outputs, _ = check.decide(self.env, TUESDAY, green_head, 'same', 'same')
        self.assertEqual(outputs['run'], 'false')

    def test_runs_when_the_last_green_run_recorded_no_fingerprint(self):
        green_head = self.commit('feat: one')
        outputs, _ = check.decide(self.env, TUESDAY, green_head, 'same', None)
        self.assertEqual(outputs['run'], 'true')

    def test_runs_again_when_main_moved(self):
        green_head = self.commit('feat: one')
        two = self.commit('fix(deps): two')
        outputs, _ = check.decide(self.env, TUESDAY, green_head)
        self.assertEqual((outputs['run'], outputs['sha']), ('true', two))

    def test_weekly_day_runs_with_ai_even_when_unchanged(self):
        green_head = self.commit('feat: one')
        outputs, _ = check.decide(self.env, MONDAY, green_head)
        self.assertEqual((outputs['run'], outputs['ai']), ('true', 'true'))

    def test_manual_run_always_runs_and_ai_only_on_request(self):
        green_head = self.commit('feat: one')
        manual = dict(self.env, EVENT_NAME='workflow_dispatch')
        self.assertEqual(check.decide(manual, TUESDAY, green_head)[0]['run'], 'true')
        self.assertEqual(check.decide(manual, TUESDAY, green_head)[0]['ai'], 'false')
        self.assertEqual(check.decide(dict(manual, AI_INPUT='true'), TUESDAY, green_head)[0]['ai'], 'true')

    def test_a_green_head_no_longer_in_the_repo_runs(self):
        self.commit('feat: one')
        outputs, reason = check.decide(self.env, TUESDAY, 'f' * 40)
        self.assertEqual(outputs['run'], 'true')
        self.assertIn('no longer', reason)

    def test_no_commit_with_a_pipeline_is_an_error(self):
        self.commit('docs(release-journal): dev x [skip ci]')
        with self.assertRaises(check.resolve.Refused):
            check.decide(self.env, TUESDAY, None)


class FingerprintTest(unittest.TestCase):
    def test_upstream_images_lists_the_stage_tagged_mairie360_images_of_the_compose_files(self):
        with tempfile.TemporaryDirectory() as root:
            Path(root, 'docker-compose.yml').write_text(
                'image: ${DB_IMAGE:-ghcr.io/mairie360/database:${UPSTREAM_TAG:-dev}}\n'
                'image: ghcr.io/mairie360/core-api:${UPSTREAM_TAG:-dev}@sha256:abc\n'
                'image: ghcr.io/mairie360/self:dev-abc1234\n')
            Path(root, 'docker-compose-e2e.yaml').write_text('image: ghcr.io/mairie360/database:${UPSTREAM_TAG:-dev}\n')
            self.assertEqual(check.upstream_images(root), ['core-api', 'database'])

    def test_fingerprint_changes_with_a_digest_and_is_unknown_when_one_is_unreadable(self):
        digests = {('database', 'dev'): 'a', ('database', 'staging'): 'b', ('database', 'latest'): 'c'}
        first = check.fingerprint(['database'], 't', lambda n, t, _: digests[(n, t)])
        digests[('database', 'staging')] = 'moved'
        self.assertNotEqual(first, check.fingerprint(['database'], 't', lambda n, t, _: digests[(n, t)]))
        self.assertIsNone(check.fingerprint(['database'], 't', lambda n, t, _: None))
        self.assertEqual(check.fingerprint([], 't', lambda n, t, _: None), '')


if __name__ == '__main__':
    unittest.main()
