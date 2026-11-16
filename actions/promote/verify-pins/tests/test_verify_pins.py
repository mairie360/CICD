"""verify_pins.py on a scratch repo with a fake `npm` and `docker` (MAIR-1005).

Prod must only ship released internal artifacts: a promoted commit that still pins a dev contract
package or a dev image in its test stacks is refused before the gates, naming the pin.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ACTION = Path(__file__).parents[1]
SCRIPT = ACTION / 'verify_pins.py'
WORKFLOW = Path(__file__).parents[4] / '.github' / 'workflows' / 'promote-prod.yml'

# Published: whatever is listed in $KNOWN (one `name@version` or image ref per line).
FAKE = r'''#!/usr/bin/env bash
echo "$0 $*" >> "$CALLS"
if [ -n "$BROKEN" ]; then echo "npm error code E401" >&2; exit 1; fi
case "$(basename "$0")" in
  npm) ref="$2" ;;
  docker) ref="$4" ;;
esac
if grep -qxF "$ref" "$KNOWN"; then echo '"ok"'; exit 0; fi
echo "npm error code E404 404 Not Found" >&2
exit 1
'''

PACKAGE = {
    'name': 'bff-project',
    'dependencies': {
        '@mairie360/bffs-lib': '2.7.0',
        '@mairie360/core-api-openapi': '2.3.0',
        'express': '^5.1.0',
    },
    'devDependencies': {'@mairie360/project-api-openapi': '1.3.0'},
}

COMPOSE = '''services:
  bff:
    image: ${IMAGE_REF:-ghcr.io/mairie360/bff-project:dev-abc1234}
  db:
    image: ${DB_IMAGE:-ghcr.io/mairie360/database:3.4.0}
  core:
    image: ghcr.io/mairie360/core-api:2.3.0
  # image: ghcr.io/mairie360/core-api:dev-1111111 (commented out)
'''


class VerifyPinsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.repo = root / 'repo'
        self.repo.mkdir()
        bin_dir = root / 'bin'
        bin_dir.mkdir()
        for tool in ('npm', 'docker'):
            (bin_dir / tool).write_text(FAKE)
            (bin_dir / tool).chmod(0o755)
        self.known = root / 'known'
        self.known.write_text('\n'.join([
            '@mairie360/bffs-lib@2.7.0', '@mairie360/core-api-openapi@2.3.0',
            '@mairie360/project-api-openapi@1.3.0', 'ghcr.io/mairie360/database:3.4.0',
            'ghcr.io/mairie360/core-api:2.3.0',
        ]) + '\n')
        self.summary = root / 'summary.md'
        self.calls = root / 'calls'
        self.env = {
            'PATH': '{}:{}'.format(bin_dir, os.environ['PATH']),
            'KNOWN': str(self.known), 'CALLS': str(self.calls),
            'GITHUB_REPOSITORY_OWNER': 'Mairie360', 'PACKAGE_NAME': 'bff-project',
            'GITHUB_STEP_SUMMARY': str(self.summary), 'HOME': str(root),
        }
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.email', 't@example.com')
        self.git('config', 'user.name', 't')

    def git(self, *args):
        return subprocess.run(['git', *args], cwd=self.repo, check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, package=PACKAGE, compose=COMPOSE, extra=None):
        if package is not None:
            (self.repo / 'package.json').write_text(json.dumps(package))
        if compose is not None:
            (self.repo / 'docker-compose-integration.yml').write_text(compose)
        for name, text in (extra or {}).items():
            (self.repo / name).write_text(text)
        self.git('add', '-A')
        self.git('commit', '-q', '-m', 'state')
        return self.git('rev-parse', 'HEAD')

    def run_script(self, sha, **env):
        return subprocess.run([sys.executable, '-I', str(SCRIPT)], cwd=self.repo,
                              env={**self.env, 'SHA': sha, **env}, capture_output=True, text=True)

    def test_released_pins_pass_and_own_image_is_left_out(self):
        sha = self.commit()
        result = self.run_script(sha)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('5 internal pin(s) checked, 0 not released', result.stdout)
        self.assertNotIn('bff-project:dev', self.summary.read_text())
        self.assertNotIn('express', self.summary.read_text())

    def test_dev_contract_package_is_refused_by_name(self):
        package = json.loads(json.dumps(PACKAGE))
        package['dependencies']['@mairie360/core-api-openapi'] = '0.0.0-dev-156a9b9'
        sha = self.commit(package=package)
        result = self.run_script(sha)
        self.assertEqual(result.returncode, 1)
        self.assertIn('::error title=verify-pins::@mairie360/core-api-openapi@0.0.0-dev-156a9b9 (package.json dependencies)', result.stdout)

    def test_dev_image_of_a_test_stack_is_refused_with_its_line(self):
        sha = self.commit(compose=COMPOSE.replace('database:3.4.0', 'database:dev-c5b8e22'))
        result = self.run_script(sha)
        self.assertEqual(result.returncode, 1)
        self.assertIn('ghcr.io/mairie360/database:dev-c5b8e22 (docker-compose-integration.yml:5)', result.stdout)

    def test_unpublished_release_and_untagged_image_are_refused(self):
        package = json.loads(json.dumps(PACKAGE))
        package['dependencies']['@mairie360/bffs-lib'] = '9.9.9'
        sha = self.commit(package=package, compose=COMPOSE + '  other:\n    image: ghcr.io/mairie360/project-api\n')
        result = self.run_script(sha)
        self.assertEqual(result.returncode, 1)
        self.assertIn('@mairie360/bffs-lib@9.9.9 (package.json dependencies): not published', result.stdout)
        self.assertIn('ghcr.io/mairie360/project-api (docker-compose-integration.yml:10): no tag', result.stdout)

    def test_reads_the_promoted_commit_not_the_checkout(self):
        bad = self.commit(compose=COMPOSE.replace('core-api:2.3.0', 'core-api:staging-0fdca60'))
        self.commit()  # main's tip is clean again
        self.assertEqual(self.run_script(self.git('rev-parse', 'HEAD')).returncode, 0)
        self.assertEqual(self.run_script(bad).returncode, 1)

    def test_local_dev_stack_is_not_checked(self):
        sha = self.commit(extra={'docker-compose.yml': 'x-service: &t\n  image: ghcr.io/mairie360/service_name:latest\n'})
        result = self.run_script(sha)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn('service_name', self.summary.read_text())

    def test_report_mode_only_warns(self):
        sha = self.commit(compose=COMPOSE.replace('database:3.4.0', 'database:dev-c5b8e22'))
        result = self.run_script(sha, MODE='report')
        self.assertEqual(result.returncode, 0)
        self.assertIn('::warning title=verify-pins::', result.stdout)
        self.assertIn('report only', self.summary.read_text())

    def test_repo_without_package_json_checks_compose_only(self):
        sha = self.commit(package=None, compose='services:\n  db:\n    image: ghcr.io/mairie360/database:3.4.0\n')
        result = self.run_script(sha, PACKAGE_NAME='core-api')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_database_leaves_both_of_its_images_out(self):
        compose = 'services:\n  db:\n    image: ghcr.io/mairie360/database:dev-1\n  lb:\n    image: ghcr.io/mairie360/liquibase-migrations:dev-1\n'
        sha = self.commit(package=None, compose=compose)
        result = self.run_script(sha, PACKAGE_NAME='database', EXTRA_PACKAGE_NAME='liquibase-migrations')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_registry_error_fails_instead_of_passing(self):
        sha = self.commit()
        result = self.run_script(sha, BROKEN='1')
        self.assertEqual(result.returncode, 1)
        self.assertIn('npm view', result.stdout)


class WorkflowWiringTest(unittest.TestCase):
    def test_promote_prod_verifies_the_pins_in_resolve(self):
        text = WORKFLOW.read_text()
        resolve = text[text.index('  resolve:'):text.index('  version:')]
        self.assertTrue('uses: ./cicd-repo/actions/promote/verify-pins' in resolve, 'verify-pins is not in resolve')
        self.assertTrue('sha: ${{ steps.resolve.outputs.sha }}' in resolve, 'verify-pins must read the promoted commit')


if __name__ == '__main__':
    unittest.main()
