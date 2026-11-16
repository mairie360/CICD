"""upstream_images.py: digests of the moving upstream tags of the test stacks (MAIR-998)."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).parents[1] / 'upstream_images.py'
SPEC = importlib.util.spec_from_file_location('upstream_images', SCRIPT)
upstream = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(upstream)

COMPOSE = '''services:
  db:
    image: ${DB_IMAGE:-ghcr.io/mairie360/database:${UPSTREAM_TAG:-dev}}
  core:
    image: ghcr.io/mairie360/core-api:${UPSTREAM_TAG:-dev}
  me:
    image: ${IMAGE_REF:-bff-project:local}
  pinned:
    image: ghcr.io/mairie360/project-api:1.3.0
  # image: ghcr.io/mairie360/old-api:${UPSTREAM_TAG:-dev}
'''


class UpstreamImagesTest(unittest.TestCase):
    def run_in(self, files, tag):
        with tempfile.TemporaryDirectory() as tmp:
            for name, text in files.items():
                (Path(tmp) / name).write_text(text)
            summary = Path(tmp) / 'summary.md'
            asked = []
            env = {'GITHUB_REPOSITORY_OWNER': 'Mairie360', 'GITHUB_STEP_SUMMARY': str(summary)}
            if tag:
                env['UPSTREAM_TAG'] = tag
            code = upstream.main(env, root=tmp, resolve=lambda ref: asked.append(ref) or (
                None if 'core-api' in ref else 'sha256:abc'))
            return code, asked, summary.read_text()

    def test_lists_the_moving_upstream_images_with_the_stage_tag(self):
        code, asked, summary = self.run_in({'docker-compose-integration.yml': COMPOSE}, 'latest')
        self.assertEqual(code, 0)
        self.assertEqual(asked, ['ghcr.io/mairie360/core-api:latest', 'ghcr.io/mairie360/database:latest'])
        self.assertIn('`ghcr.io/mairie360/database:latest` | `sha256:abc`', summary)
        self.assertIn('`ghcr.io/mairie360/core-api:latest` | not resolved', summary)

    def test_defaults_to_dev_and_ignores_other_files(self):
        _, asked, _ = self.run_in({'docker-compose.yml': COMPOSE, 'other.yml': 'ghcr.io/mairie360/x-api:${UPSTREAM_TAG:-dev}'}, None)
        self.assertEqual(asked, ['ghcr.io/mairie360/core-api:dev', 'ghcr.io/mairie360/database:dev'])

    def test_no_moving_image(self):
        code, asked, summary = self.run_in({'docker-compose-security.yml': 'services: {}\n'}, 'dev')
        self.assertEqual((code, asked), (0, []))
        self.assertIn('No upstream image on a moving tag.', summary)


ROOT = Path(__file__).parents[4]
STACK_ACTIONS = ['integration/apis', 'integration/bffs', 'security/apis', 'security/bffs', 'security/fronts',
                 'performance/apis', 'performance/bffs', 'performance/fronts', 'e2e/fronts',
                 'promote/gdpr-marker', 'promote/gdpr-simulation', 'promote/rgaa-front']


class WiringTest(unittest.TestCase):
    def test_each_workflow_tests_against_its_stage(self):
        for workflow, tag in {'APIs_cicd.yml': 'dev', 'BFFs-cicd.yml': 'dev', 'frontend-cicd.yml': 'dev',
                              'frontend-isolated-qa.yml': 'dev', 'promote-staging.yml': 'staging',
                              'promote-prod.yml': 'latest'}.items():
            text = (ROOT / '.github' / 'workflows' / workflow).read_text()
            self.assertIn('\nenv:\n  UPSTREAM_TAG: {}\n'.format(tag), text, workflow)

    def test_every_stack_action_logs_the_upstream_digests_first(self):
        for action in STACK_ACTIONS:
            text = (ROOT / 'actions' / action / 'action.yml').read_text()
            steps = text[text.index('  steps:'):]
            self.assertTrue(steps.index('uses: ./cicd-repo/actions/integration/upstream-images') < steps.index('run:'), action)


if __name__ == '__main__':
    unittest.main()
