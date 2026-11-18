"""The GDPR gates are wired into the prod promotion, and only there.

Each gate has its own detection tests (tests/gdpr: a leaking service is caught, an inventory gap
blocks, a forbidden contract field fails). These tests keep the gates connected to the promotion:
a gate dropped from `promote.needs`, or its result left out of the `if`, would let a leaking
image reach prod while every detection test stays green.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[4]
WORKFLOWS = ROOT / '.github' / 'workflows'

# gate job -> (stacks it runs for, action it calls)
GATES = {
    'gdpr_inventory': ({'database'}, 'actions/promote/gdpr-inventory'),
    'gdpr_marker': ({'apis', 'bffs'}, 'actions/promote/gdpr-marker'),
    'gdpr_simulation': ({'apis', 'bffs', 'fronts'}, 'actions/promote/gdpr-simulation'),
}
STACKS = {'database', 'apis', 'bffs', 'fronts'}


def job_block(text, name):
    """Text of the top-level job `name` of a workflow, up to the next top-level job."""
    start = text.index(f'\n  {name}:\n')
    nxt = re.search(r'\n  [a-z][a-z0-9_-]*:\n', text[start + 1:])
    return text[start:start + 1 + nxt.start()] if nxt else text[start:]


def needs_of(job):
    line = next(l for l in job.splitlines() if l.strip().startswith('needs:'))
    return [n.strip() for n in line.split('[', 1)[1].rstrip(']').split(',')]


def stacks_of(job):
    line = next(l for l in job.splitlines() if l.strip().startswith('if:'))
    return set(re.findall(r"inputs\.stack == '([a-z]+)'", line))


class PromoteProdGdprGates(unittest.TestCase):
    def setUp(self):
        self.text = (WORKFLOWS / 'promote-prod.yml').read_text(encoding='utf-8')

    def test_each_gate_runs_for_its_stacks_only(self):
        for gate, (stacks, _) in GATES.items():
            with self.subTest(gate=gate):
                self.assertEqual(stacks, stacks_of(job_block(self.text, gate)))
                self.assertTrue(stacks <= STACKS)

    def test_each_gate_calls_its_action_on_the_promoted_commit(self):
        for gate, (_, action) in GATES.items():
            with self.subTest(gate=gate):
                job = job_block(self.text, gate)
                self.assertIn(f'uses: ./cicd-repo/{action}', job)
                self.assertIn('ref: ${{ needs.resolve.outputs.sha }}', job)
                self.assertEqual({'resolve', 'version'}, set(needs_of(job)))

    def test_the_image_gates_test_the_staging_digest(self):
        # By digest, never the mobile staging-<sha> tag: the gate tests what prod will get.
        for gate in ('gdpr_marker', 'gdpr_simulation'):
            with self.subTest(gate=gate):
                self.assertIn('image_ref: ${{ needs.resolve.outputs.image }}@${{ needs.resolve.outputs.digest }}',
                              job_block(self.text, gate))
        inventory = job_block(self.text, 'gdpr_inventory')
        self.assertIn('digest: ${{ needs.resolve.outputs.digest }}', inventory)
        self.assertIn('migrations_digest: ${{ needs.resolve.outputs.extra_digest }}', inventory)

    def test_a_failed_gate_skips_the_release(self):
        promote = job_block(self.text, 'promote')
        for gate in GATES:
            with self.subTest(gate=gate):
                self.assertIn(gate, needs_of(promote))
                # `skipped` is the gate of another stack; `failure` / `cancelled` block.
                self.assertIn(f"(needs.{gate}.result == 'success' || needs.{gate}.result == 'skipped')", promote)

    def test_a_failed_gate_is_notified(self):
        notify = job_block(self.text, 'notify-cicd-failure')
        for gate in GATES:
            with self.subTest(gate=gate):
                self.assertIn(gate, needs_of(notify))


class NoGdprGateOutsideThePromotion(unittest.TestCase):
    def test_promote_staging_and_the_stack_workflows_run_no_promotion_gate(self):
        # The dev pipelines keep their pre-dev GDPR checks (OpenAPI contract, Semgrep rules); the
        # gates on the staging image belong to promote-prod only.
        for path in sorted(WORKFLOWS.glob('*.yml')):
            if path.name == 'promote-prod.yml':
                continue
            text = path.read_text(encoding='utf-8')
            for _, action in GATES.values():
                with self.subTest(workflow=path.name, action=action):
                    self.assertNotIn(action, text)


if __name__ == '__main__':
    unittest.main()
