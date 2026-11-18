"""The GDPR gates are wired into the prod promotion, and only there.

Each gate has its own detection tests (tests/gdpr: a leaking service is caught, an inventory gap
blocks). These tests keep the gates connected to the promotion: a gate dropped from
`promote.needs`, or its result left out of the `if`, would let a leaking image reach prod while
every detection test stays green. The workflows are parsed and the job conditions evaluated, so a
value left in a comment or a condition joined with the wrong operator does not pass.
"""
import re
import unittest
from pathlib import Path
from types import SimpleNamespace

import yaml

ROOT = Path(__file__).parents[4]
WORKFLOWS = ROOT / '.github' / 'workflows'

# gate job -> (stacks it runs for, action it calls)
GATES = {
    'gdpr_inventory': ({'database'}, 'actions/promote/gdpr-inventory'),
    'gdpr_marker': ({'apis', 'bffs'}, 'actions/promote/gdpr-marker'),
    'gdpr_simulation': ({'apis', 'bffs', 'fronts'}, 'actions/promote/gdpr-simulation'),
}
STACKS = {'database', 'apis', 'bffs', 'fronts'}
PROMOTED_SHA = '${{ needs.resolve.outputs.sha }}'
STAGING_IMAGE = '${{ needs.resolve.outputs.image }}@${{ needs.resolve.outputs.digest }}'


def load(path):
    with open(path, encoding='utf-8') as f:
        return yaml.safe_load(f)


def evaluate(expression, inputs, needs, failure=False):
    """Evaluates the subset of GitHub expressions the promotion conditions use."""
    expr = str(expression).strip()
    if expr.startswith('${{') and expr.endswith('}}'):
        expr = expr[3:-2]
    expr = expr.replace('&&', ' and ').replace('||', ' or ')
    expr = re.sub(r'!(?!=)', ' not ', expr)
    expr = expr.replace('always()', 'True').replace('failure()', repr(failure)).replace('!cancelled()', 'True')
    ns = SimpleNamespace(inputs=SimpleNamespace(**inputs),
                         needs=SimpleNamespace(**{k.replace('-', '_'): v for k, v in needs.items()}))
    return bool(eval(expr, {'__builtins__': {}, 'True': True, 'False': False}, vars(ns)))  # noqa: S307


def need(result='success', **outputs):
    return SimpleNamespace(result=result, outputs=SimpleNamespace(**outputs))


def needs_list(job):
    value = job.get('needs', [])
    return [value] if isinstance(value, str) else list(value)


def step_using(job, action):
    steps = [s for s in job.get('steps', []) if s.get('uses') == './cicd-repo/' + action]
    return steps[0] if len(steps) == 1 else None


class PromoteProdGdprGates(unittest.TestCase):
    def setUp(self):
        self.jobs = load(WORKFLOWS / 'promote-prod.yml')['jobs']

    def context(self, **results):
        needs = {name: need() for name in needs_list(self.jobs['promote'])}
        needs['version'] = need(published='true')
        for name, result in results.items():
            needs[name] = need(result)
        return needs

    def test_each_gate_runs_for_its_stacks_only(self):
        for gate, (stacks, _) in GATES.items():
            for stack in sorted(STACKS):
                with self.subTest(gate=gate, stack=stack):
                    runs = evaluate(self.jobs[gate]['if'], {'stack': stack, 'dry_run': False}, {})
                    self.assertEqual(runs, stack in stacks)

    def test_each_gate_calls_its_action_on_the_promoted_commit(self):
        for gate, (_, action) in GATES.items():
            with self.subTest(gate=gate):
                job = self.jobs[gate]
                self.assertIsNotNone(step_using(job, action), 'one step must use ./cicd-repo/' + action)
                repo_checkouts = [s for s in job['steps'] if str(s.get('uses', '')).startswith('actions/checkout@')
                                  and 'repository' not in (s.get('with') or {})]
                self.assertEqual(len(repo_checkouts), 1)
                self.assertEqual(repo_checkouts[0]['with']['ref'], PROMOTED_SHA)
                self.assertEqual(set(needs_list(job)), {'resolve', 'version'})

    def test_the_gates_test_the_staging_digest(self):
        # By digest, never the moving staging-<sha> tag: the gate tests what prod will get.
        for gate in ('gdpr_marker', 'gdpr_simulation'):
            with self.subTest(gate=gate):
                step = step_using(self.jobs[gate], GATES[gate][1])
                self.assertEqual(step['with']['image_ref'], STAGING_IMAGE)
        step = step_using(self.jobs['gdpr_inventory'], GATES['gdpr_inventory'][1])
        self.assertEqual(step['with']['digest'], '${{ needs.resolve.outputs.digest }}')
        self.assertEqual(step['with']['migrations_digest'], '${{ needs.resolve.outputs.extra_digest }}')

    def test_a_failed_gate_skips_the_release(self):
        condition = self.jobs['promote']['if']
        inputs = {'stack': 'apis', 'dry_run': False}
        self.assertTrue(evaluate(condition, inputs, self.context()))
        for gate in GATES:
            self.assertIn(gate, needs_list(self.jobs['promote']))
            for result, allowed in (('success', True), ('skipped', True), ('failure', False), ('cancelled', False)):
                with self.subTest(gate=gate, result=result):
                    self.assertEqual(evaluate(condition, inputs, self.context(**{gate: result})), allowed)

    def test_a_failed_gate_is_notified(self):
        notify = self.jobs['notify-cicd-failure']
        for gate in GATES:
            with self.subTest(gate=gate):
                self.assertIn(gate, needs_list(notify))
        # The notification runs when a needed job failed, and only then.
        self.assertTrue(evaluate(notify['if'], {'stack': 'apis'}, {}, failure=True))
        self.assertFalse(evaluate(notify['if'], {'stack': 'apis'}, {}, failure=False))


class NoGdprGateOutsideThePromotion(unittest.TestCase):
    def test_promote_staging_and_the_stack_workflows_run_no_promotion_gate(self):
        # The dev pipelines keep their pre-dev GDPR checks (OpenAPI contract, Semgrep rules); the
        # gates on the staging image belong to promote-prod only.
        paths = sorted(list(WORKFLOWS.glob('*.yml')) + list(WORKFLOWS.glob('*.yaml')))
        self.assertTrue(paths)
        for path in paths:
            if path.name == 'promote-prod.yml':
                continue
            uses = {str(step.get('uses', '')) for job in (load(path).get('jobs') or {}).values()
                    for step in job.get('steps') or []}
            for _, action in GATES.values():
                with self.subTest(workflow=path.name, action=action):
                    self.assertNotIn('./cicd-repo/' + action, uses)


if __name__ == '__main__':
    unittest.main()
