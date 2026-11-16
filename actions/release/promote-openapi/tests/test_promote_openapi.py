"""promote_openapi.py against a fake `npm` backed by a folder registry (MAIR-999).

The promotions used to regenerate the OpenAPI package (`cargo open_api` compiled the whole API in
the promote job); they now republish the package release-dev published for the commit.
"""
import io
import json
import os
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path

ACTION = Path(__file__).parents[1]
SCRIPT = ACTION / 'promote_openapi.py'
WORKFLOWS = Path(__file__).parents[4] / '.github' / 'workflows'

# Registry = $REGISTRY/<name with / as __>/<version>.tgz (+ .tag). Every call is logged.
FAKE_NPM = r'''#!/usr/bin/env python3
import os, shutil, sys, tarfile, json
from pathlib import Path
args = sys.argv[1:]
with open(os.environ['NPM_LOG'], 'a') as log:
    log.write(' '.join(args) + '\n')
registry = Path(os.environ['REGISTRY'])
if os.environ.get('NPM_BROKEN'):
    print('npm error code E401 Unable to authenticate', file=sys.stderr); sys.exit(1)
def split(spec):
    name, _, version = spec.rpartition('@')
    return registry / name.replace('/', '__') / (version + '.tgz')
cmd = args[0]
if cmd == 'view':
    path = split(args[1])
    if not path.exists():
        print('npm error code E404 404 Not Found', file=sys.stderr); sys.exit(1)
    print(json.dumps(path.name[:-4]))
elif cmd == 'pack':
    path = split(args[1])
    if not path.exists():
        print('npm error code ETARGET No matching version found', file=sys.stderr); sys.exit(1)
    dest = Path(args[args.index('--pack-destination') + 1])
    shutil.copy(path, dest / 'pkg.tgz')
    print('[]')
elif cmd == 'publish':
    pkg = Path(args[1])
    manifest = json.loads((pkg / 'package.json').read_text())
    out = registry / manifest['name'].replace('/', '__')
    out.mkdir(parents=True, exist_ok=True)
    with tarfile.open(out / (manifest['version'] + '.tgz'), 'w:gz') as tar:
        tar.add(pkg, arcname='package')
    (out / (manifest['version'] + '.tag')).write_text(args[args.index('--tag') + 1])
else:
    sys.exit(2)
'''

NAME = '@mairie360/project-api-openapi'


def make_tarball(path, manifest, files, extra_member=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tarfile.open(path, 'w:gz') as tar:
        for name, content in {'package.json': json.dumps(manifest), **files}.items():
            data = content.encode()
            info = tarfile.TarInfo('package/' + name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        if extra_member:
            tar.addfile(extra_member)


class PromoteOpenapiTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.registry = self.root / 'registry'
        self.registry.mkdir()
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        npm = bin_dir / 'npm'
        npm.write_text(FAKE_NPM)
        npm.chmod(0o755)
        self.log = self.root / 'npm.log'
        self.output = self.root / 'output'
        self.env = {
            'PATH': '{}:{}'.format(bin_dir, os.environ['PATH']),
            'NPM_LOG': str(self.log),
            'REGISTRY': str(self.registry),
            'GITHUB_OUTPUT': str(self.output),
            'GITHUB_REPOSITORY_OWNER': 'Mairie360',
            'PACKAGE_NAME': 'project-api',
            'FROM_VERSION': '0.0.0-dev-abc1234',
            'TO_VERSION': '0.0.0-staging.abc1234',
            'DIST_TAG': 'staging',
            'NODE_AUTH_TOKEN': 'token',
        }

    def package(self, version):
        return self.registry / NAME.replace('/', '__') / (version + '.tgz')

    def publish_source(self, **kwargs):
        make_tarball(self.package('0.0.0-dev-abc1234'),
                     {'name': NAME, 'version': '0.0.0-dev-abc1234', 'main': './index.ts'},
                     {'endpoints/projects.ts': 'export const getProjects = 1;\n', 'model/index.ts': 'export {};\n'},
                     **kwargs)

    def run_script(self, **env):
        return subprocess.run([sys.executable, '-I', str(SCRIPT)], env={**self.env, **env},
                              capture_output=True, text=True)

    def outputs(self):
        return dict(line.split('=', 1) for line in self.output.read_text().splitlines())

    def test_republishes_the_dev_package_under_the_staging_version_unchanged(self):
        self.publish_source()
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.outputs(), {'published': 'true'})
        target = self.package('0.0.0-staging.abc1234')
        self.assertTrue(target.exists())
        self.assertEqual(target.with_suffix('.tag').read_text(), 'staging')
        with tarfile.open(target) as tar:
            manifest = json.load(tar.extractfile('package/package.json'))
            endpoint = tar.extractfile('package/endpoints/projects.ts').read().decode()
        self.assertEqual(manifest['version'], '0.0.0-staging.abc1234')
        self.assertEqual(manifest['main'], './index.ts')
        self.assertEqual(endpoint, 'export const getProjects = 1;\n')
        calls = self.log.read_text()
        self.assertIn('publish', calls)
        self.assertIn('--access restricted --tag staging', calls)

    def test_missing_source_reports_false_so_the_caller_regenerates(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.outputs(), {'published': 'false'})
        self.assertIn('::warning', result.stdout)
        self.assertNotIn('publish', self.log.read_text())

    def test_rerun_after_publish_is_a_no_op(self):
        self.publish_source()
        make_tarball(self.package('0.0.0-staging.abc1234'), {'name': NAME, 'version': '0.0.0-staging.abc1234'}, {})
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.outputs(), {'published': 'true'})
        self.assertNotIn('pack', self.log.read_text())

    def test_registry_errors_fail_instead_of_falling_back(self):
        self.publish_source()
        result = self.run_script(NPM_BROKEN='1')
        self.assertEqual(result.returncode, 1)
        self.assertIn('::error', result.stdout)
        self.assertFalse(self.output.exists())

    def test_refuses_a_tarball_escaping_the_extraction_folder(self):
        evil = tarfile.TarInfo('package/../../evil.txt')
        evil.size = 0
        self.publish_source(extra_member=evil)
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn('unexpected path', result.stdout)
        self.assertFalse(self.package('0.0.0-staging.abc1234').exists())

    def test_refuses_a_tarball_of_another_package(self):
        make_tarball(self.package('0.0.0-dev-abc1234'), {'name': '@mairie360/other-openapi', 'version': 'x'}, {})
        result = self.run_script()
        self.assertEqual(result.returncode, 1)
        self.assertIn('expected', result.stdout)


class WorkflowWiringTest(unittest.TestCase):
    """The promotions republish the package and only regenerate it when the source is missing."""

    def check(self, workflow, stack_from):
        text = (WORKFLOWS / workflow).read_text()
        self.assertTrue('uses: ./cicd-repo/actions/release/promote-openapi' in text, workflow)
        for stack, source in stack_from.items():
            self.assertTrue(source in text, '{} {}: source version'.format(workflow, stack))
        self.assertEqual(text.count("steps.promote_openapi.outputs.published != 'true'"), 2, workflow)

    def test_promote_staging(self):
        self.check('promote-staging.yml', {
            'apis': "format('0.0.0-dev-{0}', needs.resolve.outputs.sha_tag)",
            'bffs': "format('0.0.0-dev.{0}', needs.resolve.outputs.sha)",
        })

    def test_promote_prod(self):
        self.check('promote-prod.yml', {
            'apis': "format('0.0.0-staging.{0}', needs.resolve.outputs.sha_tag)",
            'bffs': "format('0.0.0-staging.{0}', needs.resolve.outputs.sha)",
        })

    def test_api_pipeline_builds_the_spec_once(self):
        text = (WORKFLOWS / 'APIs_cicd.yml').read_text()
        build = '\n'.join(line for line in (ACTION.parents[1] / 'build' / 'apis' / 'action.yml').read_text().splitlines()
                          if not line.lstrip().startswith('#'))
        self.assertFalse('cargo build' in build, 'the build job compiles the API again')
        self.assertIn('cargo open_api', build)
        # gdpr_contract and release-dev reuse the spec of `build` instead of compiling again.
        self.assertFalse('cargo open_api' in text, 'APIs_cicd.yml still compiles the spec')
        self.assertGreaterEqual(text.count('name: openapi-spec'), 2)


if __name__ == '__main__':
    unittest.main()
