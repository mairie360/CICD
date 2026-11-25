"""MAIR-1204: Messages v1.0.0 carried 142 484 characters of notes; GitHub refused the release
(HTTP 422 "body is too long (maximum is 125000 characters)") after the tag was pushed."""
import importlib.util
import os
import subprocess
import tempfile
from pathlib import Path
import unittest

ACTION = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('fit_notes', ACTION / 'fit_notes.py')
fit_notes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fit_notes)

SECTION = '## Accessibilité (RGAA)\n\nTaux CI : 66 %\n'


def changelog(lines):
    return '## 1.0.0 (2026-11-25)\n\n' + ''.join(f'* feat: change {i} with a long body\n' for i in range(lines))


class FitNotesTest(unittest.TestCase):
    def test_mair_1204_notes_over_the_github_limit_are_cut_under_it(self):
        text = changelog(6000) + '\n' + SECTION
        self.assertGreater(len(text), fit_notes.LIMIT)
        fitted = fit_notes.fit(text, 'v1.0.0', 'mairie360/Messages_Web_Service')
        self.assertLessEqual(len(fitted), fit_notes.LIMIT)
        self.assertIn('https://github.com/mairie360/Messages_Web_Service/commits/v1.0.0', fitted)

    def test_the_accessibility_section_is_kept_whole(self):
        text = changelog(6000) + '\n' + SECTION
        fitted = fit_notes.fit(text, 'v1.0.0', 'o/r')
        self.assertTrue(fitted.endswith('\n' + SECTION))

    def test_the_changelog_is_cut_at_a_line_boundary(self):
        fitted = fit_notes.fit(changelog(6000), 'v1.0.0', 'o/r')
        body = fitted.split('\n\n_The notes were cut')[0]
        self.assertTrue(body.splitlines()[-1].endswith('with a long body'))

    def test_notes_under_the_limit_are_unchanged(self):
        text = changelog(10) + '\n' + SECTION
        self.assertEqual(fit_notes.fit(text, 'v1.0.0', 'o/r'), text)

    def test_an_oversized_accessibility_section_is_cut_too(self):
        text = changelog(10) + '\n## Accessibilité (RGAA)\n' + 'x\n' * 70000
        self.assertLessEqual(len(fit_notes.fit(text, 'v1.0.0', 'o/r')), fit_notes.LIMIT)

    def test_release_sh_fits_the_notes_before_creating_the_release(self):
        script = (ACTION / 'release.sh').read_text(encoding='utf-8')
        fit_at = script.index('fit_notes.py" "$NOTES" "$tag" "$GITHUB_REPOSITORY"')
        self.assertLess(fit_at, script.index('gh release create'))

    def test_the_cli_rewrites_the_file_in_place(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'notes.md'
            path.write_text(changelog(6000), encoding='utf-8')
            out = subprocess.run(['python3', '-I', str(ACTION / 'fit_notes.py'), str(path), 'v1.0.0', 'o/r'],
                                 check=True, capture_output=True, text=True, env=dict(os.environ))
            self.assertIn('::warning', out.stdout)
            self.assertLessEqual(len(path.read_text(encoding='utf-8')), fit_notes.LIMIT)


if __name__ == '__main__':
    unittest.main()
