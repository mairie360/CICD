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


class ScratchRepo(unittest.TestCase):
    """Scratch repo, fake tools and helpers; no test of its own."""

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


class VerifyPinsTest(ScratchRepo):
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


# Registry fake for the prod-equivalence rule: `npm view <name> dist-tags.latest` reads
# $LATEST/<name with / as _>, `npm pack <spec>` copies $TARBALLS/<spec with / as _>.tgz, and
# `docker buildx imagetools inspect <ref>` prints the digest listed for <ref> in $DIGESTS.
PROD_FAKE = r"""#!/usr/bin/env bash
case "$(basename "$0") $1" in
  "npm view")
    if [ "$3" = dist-tags.latest ]; then
      f="$LATEST/$(echo "$2" | tr / _)"; [ -f "$f" ] && { printf '"%s"' "$(cat "$f")"; exit 0; }
    elif grep -qxF "$2" "$KNOWN"; then echo '"ok"'; exit 0; fi ;;
  "npm pack")
    f="$TARBALLS/$(echo "$2" | tr / _).tgz"
    if [ -f "$f" ]; then cp "$f" "$4/x-$(basename "$f")"; printf '[{"filename":"x-%s"}]' "$(basename "$f")"; exit 0; fi ;;
  "docker buildx")
    d=$(awk -v r="$4" '$1 == r {print $2}' "$DIGESTS")
    [ -n "$d" ] && { printf '{"digest":"%s"}' "$d"; exit 0; } ;;
esac
echo "npm error code E404 404 Not Found" >&2
exit 1
"""


def make_tarball(path, version, endpoint='export const getProject = 1;\n'):
    import io
    import tarfile
    with tarfile.open(path, 'w:gz') as archive:
        for name, text in (('package/package.json', json.dumps({'name': '@mairie360/core-api-openapi', 'version': version})),
                           ('package/endpoints/project.ts', endpoint)):
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))


class ProdEquivalentPinsTest(ScratchRepo):
    """MAIR-998 / MAIR-1005: a dev or staging pin of an upstream goes to prod when it is the
    upstream's current prod release (same package contents, same image digest)."""

    DEV = '0.0.0-dev-156a9b9'

    def setUp(self):
        super().setUp()
        root = Path(self.env['HOME'])
        for tool in ('npm', 'docker'):
            (root / 'bin' / tool).write_text(PROD_FAKE)
        latest, tarballs = root / 'latest', root / 'tarballs'
        latest.mkdir()
        tarballs.mkdir()
        (latest / '@mairie360_core-api-openapi').write_text('2.3.0')
        make_tarball(tarballs / '@mairie360_core-api-openapi@2.3.0.tgz', '2.3.0')
        make_tarball(tarballs / '@mairie360_core-api-openapi@{}.tgz'.format(self.DEV), self.DEV)
        make_tarball(tarballs / '@mairie360_core-api-openapi@0.0.0-dev-2222222.tgz', '0.0.0-dev-2222222',
                     endpoint='export const getProject = 2;\n')
        self.digests = root / 'digests'
        self.digests.write_text('\n'.join([
            'ghcr.io/mairie360/database:latest sha256:aaa', 'ghcr.io/mairie360/database:dev-c5b8e22 sha256:aaa',
            'ghcr.io/mairie360/database:dev-0000000 sha256:old', 'ghcr.io/mairie360/database:3.4.0 sha256:aaa',
            'ghcr.io/mairie360/core-api:2.3.0 sha256:ccc', 'ghcr.io/mairie360/core-api:latest sha256:ccc',
        ]) + '\n')
        self.env.update(LATEST=str(latest), TARBALLS=str(tarballs), DIGESTS=str(self.digests))

    def package(self, version):
        package = json.loads(json.dumps(PACKAGE))
        package['dependencies']['@mairie360/core-api-openapi'] = version
        return package

    def test_dev_package_identical_to_prod_is_accepted(self):
        sha = self.commit(package=self.package(self.DEV))
        result = self.run_script(sha)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('ok (= prod 2.3.0)', self.summary.read_text())

    def test_dev_package_of_another_commit_is_refused(self):
        sha = self.commit(package=self.package('0.0.0-dev-2222222'))
        result = self.run_script(sha)
        self.assertEqual(result.returncode, 1)
        self.assertIn('@mairie360/core-api-openapi@0.0.0-dev-2222222 (package.json dependencies): not the current prod release', result.stdout)

    def test_dev_image_with_the_prod_digest_is_accepted(self):
        sha = self.commit(compose=COMPOSE.replace('database:3.4.0', 'database:dev-c5b8e22'))
        result = self.run_script(sha)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('ok (= prod digest)', self.summary.read_text())

    def test_dev_image_behind_prod_is_refused(self):
        sha = self.commit(compose=COMPOSE.replace('database:3.4.0', 'database:dev-0000000'))
        result = self.run_script(sha)
        self.assertEqual(result.returncode, 1)
        self.assertIn('ghcr.io/mairie360/database:dev-0000000 (docker-compose-integration.yml:5): not the current prod image', result.stdout)

    def test_moving_and_non_build_tags_stay_refused(self):
        for tag in ('latest', 'dev', 'staging'):
            sha = self.commit(compose=COMPOSE.replace('database:3.4.0', 'database:' + tag))
            self.assertEqual(self.run_script(sha).returncode, 1, tag)


class PackageFilesTest(unittest.TestCase):
    def test_only_the_version_may_differ(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('verify_pins', SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as tmp:
            a, b, c = (Path(tmp) / n for n in ('a.tgz', 'b.tgz', 'c.tgz'))
            make_tarball(a, '0.0.0-dev-156a9b9')
            make_tarball(b, '2.3.0')
            make_tarball(c, '2.3.0', endpoint='changed\n')
            self.assertEqual(module.package_files(a), module.package_files(b))
            self.assertNotEqual(module.package_files(b), module.package_files(c))


class WorkflowWiringTest(unittest.TestCase):
    def test_promote_prod_verifies_the_pins_in_resolve(self):
        text = WORKFLOW.read_text()
        resolve = text[text.index('  resolve:'):text.index('  version:')]
        self.assertTrue('uses: ./cicd-repo/actions/promote/verify-pins' in resolve, 'verify-pins is not in resolve')
        self.assertTrue('sha: ${{ steps.resolve.outputs.sha }}' in resolve, 'verify-pins must read the promoted commit')


if __name__ == '__main__':
    unittest.main()
