"""The RGAA result of a front's prod promotion is published in its GitHub release."""
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ACTION = Path(__file__).parents[1]
SCRIPT = ACTION / 'accessibility_section.py'
WORKFLOW = Path(__file__).parents[4] / '.github' / 'workflows' / 'promote-prod.yml'
spec = importlib.util.spec_from_file_location('accessibility_section', SCRIPT)
section_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(section_module)


def failure(state, target, check='axe:color-contrast'):
    return {'state': state, 'check': check, 'target': target, 'html': '<span>x</span>',
            'message': 'Fix any of the following:\n  Element has insufficient color contrast of 1.28'}


def report(criteria, value=64.7, states=('month', 'week')):
    statuses = [c['status'] for c in criteria]
    return {
        'version': 1, 'target': 'http://calendar-front:5002',
        'rate': {'validated': statuses.count('validated'), 'invalidated': statuses.count('invalidated'),
                 'to_review': statuses.count('to review'), 'value': value, 'min': 60, 'passed': value >= 60},
        'criteria': criteria,
        'states': [{'id': s, 'reached': True, 'url': f'http://calendar-front:5002/{s}'} for s in states],
    }


CURRENT = report([
    {'id': '3.2', 'status': 'invalidated', 'failures': [failure('month', 'button > .label'),
                                                        failure('week', 'button > .label'),
                                                        failure('week', '.event-title')]},
    {'id': '11.1', 'status': 'invalidated', 'failures': [failure('month', '#search', 'axe:label')]},
    {'id': '1.1', 'status': 'validated', 'failures': []},
    {'id': '10.4', 'status': 'to review', 'failures': []},
])
PREVIOUS = report([
    {'id': '3.2', 'status': 'invalidated', 'failures': [failure('month', 'button > .label')]},
    {'id': '11.1', 'status': 'validated', 'failures': []},
    {'id': '1.1', 'status': 'validated', 'failures': []},
    {'id': '10.4', 'status': 'invalidated', 'failures': [failure('month', 'x')]},
], value=50)


class Run(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.notes = self.dir / 'notes.md'
        self.notes.write_text('## 1.2.0\n\n* fix: something\n', encoding='utf-8')

    def write(self, name, data):
        path = self.dir / name
        path.write_text(data if isinstance(data, str) else json.dumps(data), encoding='utf-8')
        return path

    def run_script(self, *args):
        return subprocess.run([sys.executable, '-I', str(SCRIPT), '--notes', str(self.notes), *args],
                              capture_output=True, text=True)


class Section(Run):
    def test_MAIR_321_rate_and_failing_criteria_with_pages_and_elements(self):
        proc = self.run_script('--report', str(self.write('r.json', CURRENT)))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        text = self.notes.read_text(encoding='utf-8')
        self.assertTrue(text.startswith('## 1.2.0\n\n* fix: something\n\n## Accessibilité (RGAA)'))
        self.assertIn('**64.7 %** (1 critère(s) validé(s) sur 3 décidé(s) automatiquement ; seuil de la porte : 60 %)', text)
        self.assertIn('Critères à vérifier manuellement : 1.', text)
        self.assertIn('- **Critère 3.2** : 3 élément(s) en échec sur `month`, `week`', text)
        self.assertIn('- **Critère 11.1** : 1 élément(s) en échec sur `month`', text)
        # The same element on two pages is listed once.
        self.assertEqual(text.count('`button > .label`'), 1)
        self.assertIn('Element has insufficient color contrast of 1.28', text)
        self.assertNotIn('Fix any of the following', text)
        self.assertLess(text.index('Critère 3.2'), text.index('Critère 11.1'))
        self.assertIn('Première mesure', text)

    def test_MAIR_321_changes_since_the_previous_release(self):
        self.run_script('--report', str(self.write('r.json', CURRENT)),
                        '--previous', str(self.write('p.json', PREVIOUS)), '--previous-tag', 'v1.1.0')
        text = self.notes.read_text(encoding='utf-8')
        self.assertIn('Taux précédent (`v1.1.0`) : 50 % → 64.7 %.', text)
        self.assertIn('- Critère 10.4 : invalidé → à vérifier', text)
        self.assertIn('- Critère 11.1 : validé → invalidé', text)
        self.assertNotIn('Critère 3.2 : ', text)
        self.assertNotIn('Critère 1.1 : ', text)

    def test_MAIR_321_no_failing_criterion(self):
        ok = report([{'id': '1.1', 'status': 'validated', 'failures': []}], value=100)
        self.run_script('--report', str(self.write('r.json', ok)))
        self.assertIn('Aucun critère invalidé', self.notes.read_text(encoding='utf-8'))

    def test_MAIR_321_element_lists_are_bounded(self):
        many = report([{'id': '3.2', 'status': 'invalidated',
                        'failures': [failure(f's{i}', f'.e{i}') for i in range(30)]}],
                      states=[f's{i}' for i in range(30)])
        self.run_script('--report', str(self.write('r.json', many)))
        text = self.notes.read_text(encoding='utf-8')
        self.assertIn('et 25 autre(s)', text)
        self.assertIn('… 25 autre(s) élément(s)', text)
        self.assertNotIn('`.e5`', text)

    def test_MAIR_321_report_content_cannot_inject_markdown(self):
        evil = report([{'id': '3.2', 'status': 'invalidated', 'failures': [
            {'state': 'a`b', 'check': 'axe:x', 'target': 'x` [click](https://evil.example) `',
             'message': '<img src=x onerror=alert(1)> [link](https://evil.example)\n'}]}])
        self.run_script('--report', str(self.write('r.json', evil)))
        text = self.notes.read_text(encoding='utf-8')
        self.assertNotIn('<img', text)
        # Outside code spans (rendered literally), no link and no bare URL GitHub would autolink.
        prose = re.sub(r'`[^`\n]*`', '', text)
        self.assertNotIn('evil.example', prose)
        self.assertNotIn('](', prose)
        # Every backtick span stays closed on its line.
        for line in text.splitlines():
            self.assertEqual(line.count('`') % 2, 0, line)


class NeverBlocks(Run):
    def test_MAIR_321_missing_report_gives_a_warning_line(self):
        proc = self.run_script('--report', str(self.dir / 'missing.json'))
        self.assertEqual(proc.returncode, 0)
        self.assertIn('::warning', proc.stdout)
        text = self.notes.read_text(encoding='utf-8')
        self.assertIn('* fix: something', text)
        self.assertIn('Rapport RGAA indisponible', text)

    def test_MAIR_321_unreadable_reports_are_ignored(self):
        proc = self.run_script('--report', str(self.write('r.json', '{not json')),
                               '--previous', str(self.write('p.json', '[]')))
        self.assertEqual(proc.returncode, 0)
        self.assertIn('Rapport RGAA indisponible', self.notes.read_text(encoding='utf-8'))
        proc = self.run_script('--report', str(self.write('r2.json', CURRENT)),
                               '--previous', str(self.write('p2.json', '{"rate": 1}')))
        self.assertEqual(proc.returncode, 0)
        self.assertIn('Première mesure', self.notes.read_text(encoding='utf-8'))


class Wiring(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text(encoding='utf-8')
        start = self.text.index('\n  promote:\n')
        end = self.text.index('\n  notify-cicd-failure:\n')
        self.promote = self.text[start:end]

    def step(self, marker):
        at = self.promote.index(marker)
        start = self.promote.rindex('- name:', 0, at)
        nxt = self.promote.find('\n      - name:', at)
        return self.promote[start:nxt if nxt != -1 else None]

    def test_MAIR_321_section_written_before_the_release_on_the_chosen_notes(self):
        section = self.promote.index('uses: ./cicd-repo/actions/release/accessibility-section')
        self.assertLess(self.promote.index('uses: ./cicd-repo/actions/release/release-journal'), section)
        self.assertLess(section, self.promote.index('uses: ./cicd-repo/actions/promote/create-release'))
        step = self.step('uses: ./cicd-repo/actions/release/accessibility-section')
        create = self.step('uses: ./cicd-repo/actions/promote/create-release')
        notes = re.search(r'notes_file: (.+)', create).group(1)
        self.assertIn(f'notes_file: {notes}', step)
        self.assertIn('previous_tag: ${{ needs.version.outputs.last_tag }}', step)

    def test_MAIR_321_fronts_only_and_never_blocking(self):
        for marker in ('name: rgaa-report', 'actions/release/accessibility-section',
                       'gh release upload "v$VERSION" "$RUNNER_TEMP/rgaa-report.json"'):
            with self.subTest(step=marker):
                step = self.step(marker)
                self.assertIn("if: inputs.stack == 'fronts'", step)
                self.assertIn('continue-on-error: true', step)

    def test_MAIR_321_report_attached_after_the_release_exists(self):
        self.assertLess(self.promote.index('uses: ./cicd-repo/actions/promote/create-release'),
                        self.promote.index('gh release upload'))
        self.assertNotIn('hashFiles(format(', self.promote)

    def test_MAIR_321_the_rgaa_gate_uploads_the_artifact_promote_reads(self):
        gate = (Path(__file__).parents[3] / 'promote' / 'rgaa-front' / 'action.yml').read_text(encoding='utf-8')
        self.assertIn('name: rgaa-report', gate)
        self.assertIn('rgaa', re.search(r'\n    needs: \[(.+)\]', self.promote).group(1).split(', '))


if __name__ == '__main__':
    unittest.main()
