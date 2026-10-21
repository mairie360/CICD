import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).parents[1]
ROOT = Path(__file__).parents[4]
spec = importlib.util.spec_from_file_location('summarize', HERE / 'summarize.py')
summarize = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summarize)


def report(*tests):
    """Playwright JSON report with one top-level suite per (title, status)."""
    return {'suites': [{'title': 'projects.spec.ts', 'suites': [
        {'title': 'project manager', 'specs': [{'title': title, 'tests': [{'status': status}]}]}
        for title, status in tests]}]}


class CheckJourneys(unittest.TestCase):
    """MAIR-602: a front without journeys fails the job instead of passing silently."""

    def run_check(self, files):
        with tempfile.TemporaryDirectory() as front:
            for name in files:
                path = Path(front) / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('')
            return subprocess.run([str(HERE / 'check_journeys.sh')], cwd=front, capture_output=True, text=True)

    def test_fails_without_the_runner_script(self):
        result = self.run_check(['e2e/projects.spec.ts'])
        self.assertEqual(result.returncode, 1)
        self.assertIn('e2e_test.sh is missing', result.stdout)

    def test_fails_without_a_spec(self):
        result = self.run_check(['e2e_test.sh', 'e2e/support/session.ts'])
        self.assertEqual(result.returncode, 1)
        self.assertIn('no Playwright spec in e2e/', result.stdout)

    def test_passes_with_the_script_and_a_spec(self):
        result = self.run_check(['e2e_test.sh', 'e2e/projects.spec.ts'])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('e2e/projects.spec.ts', result.stdout)


class Summary(unittest.TestCase):
    def write(self, payload):
        self.tmp = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False)
        self.tmp.write(payload if isinstance(payload, str) else json.dumps(payload))
        self.tmp.close()
        self.addCleanup(os.unlink, self.tmp.name)
        return self.tmp.name

    def test_counts_and_lists_every_journey(self):
        text = summarize.render(self.write(report(('creates a project', 'expected'), ('deletes it', 'unexpected'),
                                                  ('renames it', 'flaky'))), 'ghcr.io/x/front:staging-abc1234')
        self.assertIn('Image under test: `ghcr.io/x/front:staging-abc1234`', text)
        self.assertIn('**1 passed**, 1 failed, 1 flaky, 0 skipped', text)
        self.assertIn('| projects.spec.ts › project manager › creates a project | ✅ expected |', text)
        self.assertIn('| projects.spec.ts › project manager › deletes it | ❌ unexpected |', text)

    def test_missing_report_is_explained(self):
        text = summarize.render('/nonexistent/results.json')
        self.assertIn('did not start', text)
        self.assertIn('local build', text)

    def test_unreadable_report_is_explained(self):
        self.assertIn('not a Playwright JSON report', summarize.render(self.write('{not json')))


class PromoteProdWiring(unittest.TestCase):
    """The journeys gate the prod promotion of the fronts."""

    def setUp(self):
        self.text = (ROOT / '.github' / 'workflows' / 'promote-prod.yml').read_text(encoding='utf-8')

    def test_job_runs_the_action_on_the_staging_image_of_fronts(self):
        job = self.text[self.text.index('  e2e_tests:'):self.text.index('  promote:')]
        self.assertIn("if: inputs.stack == 'fronts'", job)
        self.assertIn('uses: ./cicd-repo/actions/e2e/fronts', job)
        self.assertIn('target_image: ${{ needs.resolve.outputs.image }}:staging-${{ needs.resolve.outputs.sha_tag }}', job)
        self.assertIn('uses: ./cicd-repo/actions/integration/container-logs', job)

    def test_release_waits_for_the_journeys(self):
        promote = self.text[self.text.index('  promote:'):self.text.index('  notify-cicd-failure:')]
        self.assertIn('needs: [resolve, version, release_folder, e2e_tests]', promote)
        self.assertIn("(needs.e2e_tests.result == 'success' || needs.e2e_tests.result == 'skipped')", promote)
        self.assertIn('needs: [resolve, version, release_folder, e2e_tests, promote]', self.text)


if __name__ == '__main__':
    unittest.main()
