import importlib.util
import os
import subprocess
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('policy', Path(__file__).parents[1] / 'check_policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def reports():
    full = {'auditReportVersion': 2, 'metadata': {'vulnerabilities': {'high': 5, 'critical': 0, 'total': 5}}, 'vulnerabilities': {}}
    lock = {'lockfileVersion': 3, 'packages': {}}
    for name, parent in policy.CHAIN.items():
        node = 'node_modules/' + name
        via = [parent] if parent else [{'url': policy.ADVISORY, 'name': 'braces',
            'dependency': 'braces', 'severity': 'high', 'range': '<=3.0.3'}]
        full['vulnerabilities'][name] = {'name': name, 'severity': 'high', 'nodes': [node], 'via': via}
        lock['packages'][node] = {'dev': True}
    production = {'auditReportVersion': 2, 'vulnerabilities': {}, 'metadata': {'vulnerabilities': {'total': 0}}}
    return full, production, lock


def jobs():
    names = ['Install Dependencies', 'Lint Code', 'Unit Tests', 'Code Security Audit (Semgrep, Gitleaks)']
    values = [{'name': 'CICD / ' + name, 'status': 'completed', 'conclusion': 'success'} for name in names]
    values.append({'name': 'CICD / Security Audit (npm audit)', 'status': 'completed', 'conclusion': 'failure'})
    values.append({'name': 'CICD / Build Check (Next.js)', 'status': 'completed', 'conclusion': 'skipped'})
    return values


class AuditPolicyTests(unittest.TestCase):
    def test_known_dev_chain_and_clean_production_are_narrowly_accepted(self):
        result = policy.validate_audits(*reports())
        self.assertEqual(result['fullAudit'], 'failure')
        self.assertEqual(result['productionFindings'], 0)

    def test_any_production_advisory_blocks_publication(self):
        full, production, lock = reports()
        production['vulnerabilities']['runtime-package'] = {'severity': 'low'}
        with self.assertRaises(ValueError): policy.validate_audits(full, production, lock)

    def test_affected_package_reachable_in_production_blocks_exception(self):
        full, production, lock = reports()
        lock['packages']['node_modules/braces']['dev'] = False
        with self.assertRaises(ValueError): policy.validate_audits(full, production, lock)

    def test_duplicate_installation_must_also_be_dev_only(self):
        full, production, lock = reports()
        full['vulnerabilities']['braces']['nodes'].append('node_modules/other/node_modules/braces')
        with self.assertRaises(ValueError): policy.validate_audits(full, production, lock)

    def test_another_advisory_under_the_same_package_blocks_exception(self):
        full, production, lock = reports()
        full['vulnerabilities']['braces']['via'].append({'url': 'https://github.com/advisories/other'})
        with self.assertRaises(ValueError): policy.validate_audits(full, production, lock)

    def test_changed_critical_advisory_blocks_exception(self):
        full, production, lock = reports()
        full['vulnerabilities']['braces']['via'][0]['severity'] = 'critical'
        with self.assertRaises(ValueError): policy.validate_audits(full, production, lock)

    def test_additional_findings_block_exception_even_when_not_high(self):
        full, production, lock = reports()
        full['vulnerabilities']['another-package'] = {'severity': 'moderate'}
        with self.assertRaises(ValueError): policy.validate_audits(full, production, lock)

    def test_network_error_report_is_never_a_clean_audit(self):
        full, production, lock = reports()
        production['error'] = {'code': 'ECONNRESET'}
        with self.assertRaises(ValueError): policy.validate_audits(full, production, lock)


class ExistingControlTests(unittest.TestCase):
    def test_original_audit_failure_is_retained(self):
        policy.validate_jobs(jobs())

    def test_any_additional_failure_blocks_exception(self):
        values = jobs(); values[0]['conclusion'] = 'failure'
        with self.assertRaises(ValueError): policy.validate_jobs(values)

    def test_pending_control_blocks_exception(self):
        values = jobs(); values[0]['status'] = 'in_progress'
        with self.assertRaises(ValueError): policy.validate_jobs(values)

    def test_unknown_skipped_control_blocks_exception(self):
        values = jobs(); values.append({'name': 'New required verification', 'status': 'completed', 'conclusion': 'skipped'})
        with self.assertRaises(ValueError): policy.validate_jobs(values)

    def test_rgaa_cannot_be_failed_or_skipped(self):
        for result in ['failure', 'skipped']:
            with self.subTest(result=result):
                values = jobs(); values.append({'name': 'RGAA accessibility audit', 'status': 'completed', 'conclusion': result})
                with self.assertRaises(ValueError): policy.validate_jobs(values)

    def test_missing_successful_scanner_blocks_exception(self):
        values = [j for j in jobs() if not j['name'].endswith('Code Security Audit (Semgrep, Gitleaks)')]
        with self.assertRaises(ValueError): policy.validate_jobs(values)


class RegistryAbsenceTests(unittest.TestCase):
    def test_confirmed_missing_manifest_is_accepted(self):
        ref = 'ghcr.io/mairie360/administrator-front:dev-aaaaaaa'
        result = subprocess.CompletedProcess([], 1, '', 'ERROR: ' + ref + ': not found')
        self.assertEqual(policy.validate_missing_tag(ref, result), {'devTagAbsent': ref})

    def test_existing_tag_must_never_be_overwritten(self):
        with self.assertRaises(ValueError):
            policy.validate_missing_tag('ref', subprocess.CompletedProcess([], 0, 'digest', ''))

    def test_authentication_and_network_failures_do_not_prove_absence(self):
        for message in ['unauthorized', 'TLS handshake timeout', 'host not found', '403 forbidden']:
            with self.subTest(message=message), self.assertRaises(ValueError):
                policy.validate_missing_tag('ref', subprocess.CompletedProcess([], 1, '', message))


class TargetTests(unittest.TestCase):
    def setUp(self):
        self.head = 'a' * 40
        self.env = {'GITHUB_REPOSITORY': 'mairie360/Administrator_Web_Service',
                    'PACKAGE_NAME': 'administrator-front', 'CICD_REF': 'b' * 40,
                    'EXCEPTION_REASON': 'Known development-only advisory, real audit retained',
                    'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main',
                    'GITHUB_SHA': self.head}

    def check(self, changed=None, current_head=None):
        values = {**self.env, **(changed or {})}
        with patch.dict(os.environ, values, clear=True), patch.object(policy, 'github', return_value={'commit': {'sha': current_head or self.head}}):
            policy.validate_target()

    def test_existing_frontend_main_is_allowed(self): self.check()

    def test_excluded_and_backend_repositories_are_refused(self):
        for name in ['Emails_Web_Service', 'Files_Web_Service', 'BFF_user', 'Core_API', 'n8n']:
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.check({'GITHUB_REPOSITORY': 'mairie360/' + name})

    def test_image_name_cannot_target_another_service(self):
        with self.assertRaises(ValueError): self.check({'PACKAGE_NAME': 'bff-user'})

    def test_other_environments_and_candidate_branches_are_refused(self):
        for ref in ['refs/heads/staging', 'refs/heads/prod', 'refs/heads/fix/example', 'refs/tags/v1.0.0']:
            with self.subTest(ref=ref), self.assertRaises(ValueError): self.check({'GITHUB_REF': ref})

    def test_new_automatic_trigger_is_not_accepted(self):
        with self.assertRaises(ValueError): self.check({'GITHUB_EVENT_NAME': 'push'})

    def test_main_advance_stops_publication(self):
        with self.assertRaises(ValueError): self.check(current_head='c' * 40)

    def test_floating_ci_tag_is_refused(self):
        with self.assertRaises(ValueError): self.check({'CICD_REF': 'v4.2.0'})

    def test_exception_requires_a_reason(self):
        with self.assertRaises(ValueError): self.check({'EXCEPTION_REASON': ' '})


if __name__ == '__main__': unittest.main()
