import importlib.util
import os
import subprocess
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('resolve', Path(__file__).parents[1] / 'resolve.py')
resolve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolve)

ROOT = Path(__file__).parents[4]
DIGEST = 'sha256:' + 'a' * 64
EXTRA = 'sha256:' + 'b' * 64


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def job(name, conclusion, status='completed'):
    return {'name': name, 'status': status, 'conclusion': conclusion}


class Repo:
    """Throwaway clone whose `origin/main` holds the given commit subjects, oldest first."""

    def __init__(self, subjects):
        self.dir = tempfile.TemporaryDirectory()
        self.previous = os.getcwd()
        os.chdir(self.dir.name)
        run('git', 'init', '-q', '-b', 'main')
        run('git', 'config', 'user.email', 't@example.com')
        run('git', 'config', 'user.name', 't')
        self.shas = []
        for subject in subjects:
            run('git', 'commit', '-q', '--allow-empty', '-m', subject)
            self.shas.append(run('git', 'rev-parse', 'HEAD'))
        run('git', 'update-ref', 'refs/remotes/origin/main', 'HEAD')

    def close(self):
        os.chdir(self.previous)
        self.dir.cleanup()


class PickDefaultTest(unittest.TestCase):
    COMMITS = [('j2', 'docs(release-journal): dev c3 [skip ci]'), ('c3', 'fix: c3'),
               ('j1', 'docs(release-journal): staging c2 [skip ci]'), ('c2', 'feat: c2'), ('c1', 'fix: c1')]

    def test_staging_takes_the_newest_commit_with_a_pipeline(self):
        self.assertEqual(resolve.pick_default(self.COMMITS, 'staging', lambda sha: False), 'c3')

    def test_prod_takes_the_newest_commit_released_on_staging(self):
        on_staging = {'c2', 'c1'}
        self.assertEqual(resolve.pick_default(self.COMMITS, 'prod', on_staging.__contains__), 'c2')

    def test_prod_never_looks_up_skip_ci_commits(self):
        looked_up = []
        resolve.pick_default(self.COMMITS, 'prod', lambda sha: looked_up.append(sha) or sha == 'c1')
        self.assertEqual(looked_up, ['c3', 'c2', 'c1'])

    def test_prod_refuses_when_nothing_is_on_staging(self):
        with self.assertRaises(resolve.Refused):
            resolve.pick_default(self.COMMITS, 'prod', lambda sha: False)


class CheckCiJobsTest(unittest.TestCase):
    def test_green_release_dev_passes(self):
        jobs = [job('APIs-cicd / lint', 'success'), job('APIs-cicd / release-dev', 'success')]
        self.assertIsNone(resolve.check_ci_jobs(jobs))

    def test_job_names_of_every_stack_are_recognised(self):
        for name in ('APIs-cicd / release-dev', 'CICD / Release Dev', 'Database-cicd / Release to Dev'):
            with self.subTest(name=name):
                self.assertIsNone(resolve.check_ci_jobs([job(name, 'success')]))

    def test_release_dev_not_green_is_refused(self):
        for conclusion in ('failure', 'skipped', 'cancelled', None):
            with self.subTest(conclusion=conclusion):
                self.assertIn('did not succeed', resolve.check_ci_jobs([job('CICD / Release Dev', conclusion)]))

    def test_any_failed_job_is_refused(self):
        jobs = [job('CICD / Release Dev', 'success'), job('CICD / Dynamic Security Tests (OWASP ZAP)', 'failure')]
        self.assertIn('OWASP ZAP', resolve.check_ci_jobs(jobs))

    def test_cancelled_approvals_of_the_old_pipeline_do_not_block(self):
        # Runs of the v4 pipeline end `cancelled` when nobody approves Staging / Prod.
        jobs = [job('APIs-cicd / release-dev', 'success'), job('APIs-cicd / release-staging', 'cancelled'),
                job('APIs-cicd / release-prod', 'cancelled')]
        self.assertIsNone(resolve.check_ci_jobs(jobs))

    def test_missing_release_dev_is_refused(self):
        self.assertIn('no release-dev', resolve.check_ci_jobs([job('CICD / lint', 'success')]))


class LatestRunTest(unittest.TestCase):
    def test_newest_push_run_on_the_branch(self):
        runs = [{'id': 1, 'run_number': 5, 'head_branch': 'main', 'event': 'push'},
                {'id': 2, 'run_number': 7, 'head_branch': 'main', 'event': 'push'},
                {'id': 3, 'run_number': 9, 'head_branch': 'feature', 'event': 'push'},
                {'id': 4, 'run_number': 8, 'head_branch': 'main', 'event': 'workflow_dispatch'}]
        self.assertEqual(resolve.latest_run(runs, 'main')['id'], 2)

    def test_none_without_a_main_run(self):
        self.assertIsNone(resolve.latest_run([], 'main'))


class MainTest(unittest.TestCase):
    def setUp(self):
        self.repo = Repo(['feat: one', 'fix: two', 'docs(release-journal): dev two [skip ci]'])
        self.addCleanup(self.repo.close)
        self.env = {'TARGET': 'staging', 'PACKAGE_NAME': 'core-api', 'GITHUB_REPOSITORY_OWNER': 'Mairie360',
                    'GITHUB_REPOSITORY': 'mairie360/Core_API', 'GITHUB_TOKEN': 't'}
        self.tags = {}
        patcher = patch.object(resolve, 'image_digest', side_effect=lambda ref: self.tags.get(ref))
        patcher.start()
        self.addCleanup(patcher.stop)
        ci = patch.object(resolve, 'check_ci')
        self.check_ci = ci.start()
        self.addCleanup(ci.stop)

    def test_staging_default_skips_the_journal_commit(self):
        two = self.repo.shas[1]
        self.tags['ghcr.io/mairie360/core-api:dev-' + two[:7]] = DIGEST
        out = resolve.main(self.env)
        self.assertEqual(out, {'sha': two, 'sha_tag': two[:7], 'image': 'ghcr.io/mairie360/core-api',
                               'digest': DIGEST, 'extra_digest': ''})
        self.check_ci.assert_called_once_with('mairie360/Core_API', 'cicd.yml', two, 'main', 't')

    def test_short_sha_is_expanded(self):
        one = self.repo.shas[0]
        self.tags['ghcr.io/mairie360/core-api:dev-' + one[:7]] = DIGEST
        self.assertEqual(resolve.main(dict(self.env, SHA_INPUT=one[:9]))['sha'], one)

    def test_staging_refuses_a_commit_not_released_on_dev(self):
        with self.assertRaisesRegex(resolve.Refused, 'dev-.* does not exist'):
            resolve.main(dict(self.env, SHA_INPUT=self.repo.shas[0]))

    def test_prod_refuses_a_commit_not_on_staging(self):
        one = self.repo.shas[0]
        self.tags['ghcr.io/mairie360/core-api:dev-' + one[:7]] = DIGEST
        with self.assertRaisesRegex(resolve.Refused, 'staging-.* does not exist'):
            resolve.main(dict(self.env, TARGET='prod', SHA_INPUT=one))

    def test_prod_does_not_read_the_ci_run(self):
        one = self.repo.shas[0]
        self.tags['ghcr.io/mairie360/core-api:staging-' + one[:7]] = DIGEST
        self.assertEqual(resolve.main(dict(self.env, TARGET='prod'))['sha'], one)
        self.check_ci.assert_not_called()

    def test_both_database_images_must_exist(self):
        one = self.repo.shas[0]
        env = dict(self.env, TARGET='prod', SHA_INPUT=one, PACKAGE_NAME='database',
                   EXTRA_PACKAGE_NAME='liquibase-migrations')
        self.tags['ghcr.io/mairie360/database:staging-' + one[:7]] = DIGEST
        with self.assertRaisesRegex(resolve.Refused, 'liquibase-migrations:staging-'):
            resolve.main(env)
        self.tags['ghcr.io/mairie360/liquibase-migrations:staging-' + one[:7]] = EXTRA
        self.assertEqual(resolve.main(env)['extra_digest'], EXTRA)

    def test_commit_outside_main_is_refused(self):
        run('git', 'checkout', '-q', '-b', 'feature')
        run('git', 'commit', '-q', '--allow-empty', '-m', 'feat: not merged')
        with self.assertRaisesRegex(resolve.Refused, 'is not on origin/main'):
            resolve.main(dict(self.env, SHA_INPUT=run('git', 'rev-parse', 'HEAD')))

    def test_input_that_is_not_a_sha_is_refused(self):
        for value in ('main', 'HEAD~1', '$(id)', 'abc'):
            with self.subTest(value=value), self.assertRaisesRegex(resolve.Refused, 'not a commit sha'):
                resolve.main(dict(self.env, SHA_INPUT=value))


class PromotionCommitsSkipCiTest(unittest.TestCase):
    """MAIR-494: the commits a promotion creates must not start a pipeline."""

    def test_promote_workflows_only_push_through_the_release_journal(self):
        for name in ('promote-staging.yml', 'promote-prod.yml'):
            with self.subTest(workflow=name):
                text = (ROOT / '.github' / 'workflows' / name).read_text(encoding='utf-8')
                self.assertNotIn('git push', text)
                self.assertNotIn('git commit', text)

    def test_the_release_journal_commit_is_skip_ci(self):
        text = (ROOT / 'actions' / 'release' / 'release-journal' / 'action.yml').read_text(encoding='utf-8')
        commits = [line for line in text.splitlines() if 'git commit' in line]
        self.assertEqual(len(commits), 1)
        self.assertIn('[skip ci]', commits[0])

    def test_the_prod_tag_is_created_through_the_api(self):
        # A tag or release created with the run's GITHUB_TOKEN starts no workflow.
        text = (ROOT / '.github' / 'workflows' / 'promote-prod.yml').read_text(encoding='utf-8')
        self.assertIn('gh release create', text)
        self.assertIn('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}', text)


if __name__ == '__main__':
    unittest.main()
