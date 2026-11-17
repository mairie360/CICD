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


if __name__ == '__main__':
    unittest.main()
