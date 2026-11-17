"""MAIR-1009: one build per front pipeline on main and node_modules shared between jobs."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[4]
ACTIONS = ROOT / 'actions'
WORKFLOWS = ROOT / '.github' / 'workflows'


def code(path):
    """The file without its comment lines."""
    return '\n'.join(line for line in path.read_text().splitlines() if not line.lstrip().startswith('#'))


def job(text, name):
    start = text.index('\n  {}:\n'.format(name))
    following = re.search(r'\n  [a-z_-]+:\n', text[start + 1:])
    return text[start:start + 1 + following.start()] if following else text[start:]


class NodeInstallTest(unittest.TestCase):
    def test_every_node_job_of_the_fronts_and_bffs_installs_through_the_cache(self):
        for stack in ('fronts', 'bffs'):
            for kind in ('dependencies', 'lint', 'build', 'unit-tests'):
                with self.subTest(stack=stack, kind=kind):
                    text = code(ACTIONS / kind / stack / 'action.yml')
                    self.assertIn('uses: ./cicd-repo/actions/dependencies/node-install', text)
                    self.assertIsNone(re.search(r'run:\s*npm ci', text), 'runs npm ci itself')
                    self.assertEqual("save: 'true'" in text, kind == 'dependencies')

    def test_cache_key_is_exact_and_covers_the_lockfile_and_node_version(self):
        text = code(ACTIONS / 'dependencies' / 'node-install' / 'action.yml')
        self.assertIn("key: node-modules-${{ runner.os }}-node${{ inputs.node_version }}-${{ hashFiles('package-lock.json', 'vendor/**') }}", text)
        self.assertNotIn('restore-keys', text)
        # npm ci on a miss only, the install checks on a hit.
        self.assertIn("if: steps.restore.outputs.cache-hit != 'true'\n      shell: bash\n      run: npm ci", text)
        self.assertIn('npm run --if-present postinstall', text)


class SingleFrontBuildTest(unittest.TestCase):
    def setUp(self):
        self.text = (WORKFLOWS / 'frontend-cicd.yml').read_text()

    def test_build_check_does_not_run_on_main(self):
        self.assertIn("if: github.ref != 'refs/heads/main'", job(self.text, 'build'))

    def test_release_dev_waits_for_every_check_but_not_the_build(self):
        needs = re.search(r'needs: \[([^\]]*)\]', job(self.text, 'release-dev')).group(1)
        self.assertEqual({n.strip() for n in needs.split(',')}, {'lint', 'security_audit', 'security_sast', 'test'})

    def test_bff_build_job_stays_for_the_openapi_spec(self):
        text = (WORKFLOWS / 'BFFs-cicd.yml').read_text()
        self.assertIn('build', re.search(r'needs: \[([^\]]*)\]', job(text, 'release-dev')).group(1))


if __name__ == '__main__':
    unittest.main()
