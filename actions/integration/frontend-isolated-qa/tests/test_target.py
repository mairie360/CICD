import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('target', pathlib.Path(__file__).parents[1] / 'target.py')
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)

class TargetTests(unittest.TestCase):
    def test_current_scope_produces_only_immutable_frontend_images(self):
        for repo, package in qa.PACKAGES.items():
            with self.subTest(repo=repo):
                value = qa.target(repo, 'a' * 40, 'sha256:' + 'b' * 64, 'both')
                self.assertEqual(value['image'], f'ghcr.io/mairie360/{package}@sha256:' + 'b' * 64)
                self.assertEqual(value['tag'], f'ghcr.io/mairie360/{package}:dev-aaaaaaa')

    def test_rejects_excluded_repositories_and_unbounded_refs(self):
        for repo, sha, digest, kind in [
            ('n8n_Web_Service', 'a' * 40, 'sha256:' + 'b' * 64, 'both'),
            ('Files_Web_Service', 'a' * 40, 'sha256:' + 'b' * 64, 'both'),
            ('BFF_User', 'a' * 40, 'sha256:' + 'b' * 64, 'both'),
            ('Projects_Web_Service', 'main', 'sha256:' + 'b' * 64, 'both'),
            ('Projects_Web_Service', 'a' * 40, 'latest', 'both'),
            ('Projects_Web_Service', 'a' * 40, 'sha256:' + 'b' * 64, 'production'),
        ]:
            with self.subTest(repo=repo, sha=sha, kind=kind):
                with self.assertRaises(ValueError):
                    qa.target(repo, sha, digest, kind)

    def test_selects_existing_scanner_without_rewriting_backend_configuration(self):
        model = {'services': {'front': {'image': 'verified@sha256:abc'},
                             'api': {'image': 'ghcr.io/mairie360/core-api:1.3.0'},
                             'load': {'image': 'grafana/k6:latest'}}}
        before = repr(model)
        self.assertEqual(qa.scanner(model, 'verified@sha256:abc', 'performance'), 'load')
        self.assertEqual(repr(model), before)

    def test_refuses_ambiguous_images_and_scanners(self):
        for model in [
            {'services': {'load': {'image': 'grafana/k6:latest'}}},
            {'services': {'front': {'image': 'verified'}, 'other': {'image': 'verified'}, 'load': {'image': 'grafana/k6:latest'}}},
            {'services': {'front': {'image': 'verified'}, 'load': {'image': 'grafana/k6:latest'}, 'other': {'image': 'grafana/k6:latest'}}},
        ]:
            with self.assertRaises(ValueError):
                qa.scanner(model, 'verified', 'performance')

if __name__ == '__main__':
    unittest.main()
