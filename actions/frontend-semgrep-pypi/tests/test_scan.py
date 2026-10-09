import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("frontend_scan", ROOT / "run_scan.py")
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)


class FrontendScanTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.report = Path(self.directory.name) / "report.sarif"

    def report_data(self, count=0):
        self.report.write_text(json.dumps({"version": "2.1.0", "runs": [{"results": [{"ruleId": "finding"}] * count}]}))

    def test_preserves_all_real_rule_and_exclude_arguments_without_a_shell(self):
        args = scan.arguments("p/typescript\np/react p/secrets", "'a file.ts' --metrics=on", "cicd-repo dist", self.report)
        self.assertEqual(args[1:8], ["scan", "--config", "p/typescript", "--config", "p/react", "--config", "p/secrets"])
        self.assertIn("--error", args)
        self.assertIn("--metrics=off", args)
        self.assertIn("--disable-version-check", args)
        self.assertEqual(args[-3:], ["--", "a file.ts", "--metrics=on"])
        self.assertEqual(args[8:12], ["--exclude", "cicd-repo", "--exclude", "dist"])

    def test_empty_config_is_refused_before_scanning(self):
        with self.assertRaises(ValueError):
            scan.arguments("  \n", ".", "", self.report)

    def test_real_clean_report_and_exit_agree(self):
        self.report_data()
        self.assertEqual(scan.report_findings(self.report, 0), (0, True))

    def test_real_findings_report_and_exit_agree(self):
        self.report_data(2)
        self.assertEqual(scan.report_findings(self.report, 1), (2, True))

    def test_missing_or_empty_report_cannot_certify_clean_or_findings(self):
        for code in (0, 1):
            with self.subTest(code=code), self.assertRaises(ValueError):
                scan.report_findings(self.report, code)
        self.report.write_text("")
        with self.assertRaises(ValueError):
            scan.report_findings(self.report, 0)

    def test_unreported_scanner_error_stays_an_error(self):
        self.assertEqual(scan.report_findings(self.report, 2), (0, False))
        self.assertEqual(scan.verdict(2, 0, "false"), 1)
        self.assertEqual(scan.verdict(125, 0, "true"), 1)

    def test_malformed_and_inconsistent_reports_are_refused(self):
        for data in [[], {}, {"version": "2.0", "runs": []}, {"version": "2.1.0", "runs": []},
                     {"version": "2.1.0", "runs": [None]}, {"version": "2.1.0", "runs": [{"results": {}}]}]:
            self.report.write_text(json.dumps(data))
            with self.subTest(data=data), self.assertRaises(ValueError):
                scan.report_findings(self.report, 0)
        self.report_data(1)
        with self.assertRaises(ValueError):
            scan.report_findings(self.report, 0)
        self.report_data()
        with self.assertRaises(ValueError):
            scan.report_findings(self.report, 1)

    def test_blocking_findings_fail_and_optional_reporting_retains_real_count(self):
        self.assertEqual(scan.verdict(1, 3, "true"), 1)
        self.assertEqual(scan.verdict(1, 3, "false"), 0)
        self.assertEqual(scan.verdict(0, 0, "true"), 0)
        for values in [(1, 0, "false"), (0, 3, "true"), (-9, 0, "true"), (0, -1, "true"), (0, 0, "yes")]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                scan.verdict(*values)

    def test_a_stale_report_is_removed_and_cannot_turn_a_new_error_green(self):
        temp = Path(self.directory.name)
        report = temp / "frontend-semgrep" / "semgrep.sarif"
        report.parent.mkdir(); report.write_text('{"version":"2.1.0","runs":[{"results":[]}]}')
        output = temp / "output"
        with patch.dict(os.environ, {"RUNNER_TEMP": str(temp), "GITHUB_OUTPUT": str(output), "SEMGREP_CONFIG": "p/react"}), \
             patch.object(scan.importlib.metadata, "version", return_value="1.177.0"), \
             patch.object(scan.subprocess, "run", return_value=subprocess.CompletedProcess([], 2)):
            scan.scan()
        self.assertFalse(report.exists())
        self.assertIn("exit_code=2\nhas_sarif=false\nfindings=0", output.read_text())
        self.assertEqual(scan.verdict(2, 0, "true"), 1)

    def test_other_semgrep_versions_are_refused(self):
        with patch.object(scan.importlib.metadata, "version", return_value="1.178.0"), self.assertRaises(ValueError):
            scan.scan()

    def test_lock_contains_the_verified_wheel_and_only_exact_hash_pins(self):
        entries = [line for line in (ROOT / "requirements-linux-python314.lock").read_text().splitlines() if line and not line.startswith("#")]
        self.assertEqual(len(entries), 66)
        for line in entries:
            self.assertRegex(line, r"^[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+ --hash=sha256:[a-f0-9]{64}$")
        self.assertIn("semgrep==1.177.0 --hash=sha256:32d92d0cd2e18a1495b32abfef926be0ed3c972d8cd169bffe6cbb8418e3bb5e", entries)


if __name__ == "__main__":
    unittest.main()
