"""The npm audit of the BFFs and of bffs-lib blocks on production dependencies only (MAIR-682)."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
ACTIONS = {
    'bffs': ROOT / 'actions' / 'dependencies' / 'bffs' / 'action.yml',
    'bffs-lib': ROOT / 'actions' / 'dependencies' / 'bffs-lib' / 'action.yml',
}


def steps(text):
    return re.split(r'\n    - ', text)[1:]


class AuditTest(unittest.TestCase):
    def test_MAIR_682_the_blocking_audit_omits_dev_dependencies(self):
        for name, path in ACTIONS.items():
            with self.subTest(action=name):
                runs = [s for s in steps(path.read_text()) if 'npm audit' in s and 'run: npm audit' in s]
                self.assertEqual(len(runs), 1, 'one blocking audit step')
                self.assertIn('run: npm audit --omit=dev --audit-level=high', runs[0])

    def test_MAIR_682_the_full_audit_never_fails_the_job_and_reaches_the_summary(self):
        for name, path in ACTIONS.items():
            with self.subTest(action=name):
                report = [s for s in steps(path.read_text()) if s.startswith('name: Report development dependencies')]
                self.assertEqual(len(report), 1)
                self.assertIn('!cancelled()', report[0])
                self.assertIn('npm audit > "$report" 2>&1 || true', report[0])
                self.assertIn('GITHUB_STEP_SUMMARY', report[0])
                self.assertNotIn('continue-on-error', report[0])

    def test_MAIR_682_the_bff_audits_only_run_in_the_security_audit_job(self):
        for step in steps(ACTIONS['bffs'].read_text()):
            if 'npm audit' in step:
                self.assertIn("inputs.audit == 'true'", step)


if __name__ == '__main__':
    unittest.main()
