import contextlib
import importlib.util
import io
import pathlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    'newman_summary', pathlib.Path(__file__).parents[1] / 'newman_summary.py'
)
newman_summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(newman_summary)

# Shape of newman's junit reporter: one <testsuite> per request, one <testcase> per assertion.
WITH_FAILURES = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="BFF user" tests="4" time="1.2">
  <testsuite name="GET /api/v1/users/me" id="a" timestamp="2026-10-21T10:00:00.000Z" tests="2" failures="1" errors="0" time="0.3">
    <testcase name="Status code is 200" time="0.1" classname="BFF user"/>
    <testcase name="Body has the role" time="0.1" classname="BFF user">
      <failure type="AssertionFailure" message="expected { Object (id, roles) } to have property 'role'"><![CDATA[Failed 1 times.
Collection JSON ID: x]]></failure>
    </testcase>
  </testsuite>
  <testsuite name="POST /api/v1/projects | create" tests="2" failures="0" errors="1" time="0.3">
    <testcase name="Status code is 201" time="0.1" classname="BFF user"/>
    <testcase name="Location header" time="0.1" classname="BFF user">
      <error type="Error"><![CDATA[
      TypeError: Cannot read properties of undefined
      ]]></error>
    </testcase>
  </testsuite>
</testsuites>
"""

ALL_GREEN = """<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="BFF user" tests="3" time="0.9">
  <testsuite name="GET /health" tests="1" failures="0" errors="0" time="0.1">
    <testcase name="Status code is 200" time="0.1" classname="BFF user"/>
  </testsuite>
  <testsuite name="GET /api/v1/users/me" tests="2" failures="0" errors="0" time="0.3">
    <testcase name="Status code is 200" time="0.1" classname="BFF user"/>
    <testcase name="Body has the role" time="0.1" classname="BFF user"/>
  </testsuite>
</testsuites>
"""


class NewmanSummaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)

    def write(self, content):
        path = self.dir / 'newman-reports' / 'newman.xml'
        path.parent.mkdir()
        path.write_text(content, encoding='utf-8')
        return path

    def test_lists_the_failed_cases_with_their_request_and_message(self):
        report = newman_summary.parse(self.write(WITH_FAILURES))
        self.assertEqual((report['total'], report['passed'], report['failed']), (4, 2, 2))
        self.assertEqual(
            [(f['suite'], f['name']) for f in report['failures']],
            [('GET /api/v1/users/me', 'Body has the role'),
             ('POST /api/v1/projects | create', 'Location header')],
        )
        # The `message` attribute wins; an <error> without one falls back to its first text line.
        self.assertEqual(report['failures'][0]['message'], "expected { Object (id, roles) } to have property 'role'")
        self.assertEqual(report['failures'][1]['message'], 'TypeError: Cannot read properties of undefined')

        summary = newman_summary.render(self.dir / 'newman-reports' / 'newman.xml')
        self.assertIn('**4 tests, 2 passed, 2 failed** — failed', summary)
        self.assertIn('| Request | Assertion | Message |', summary)
        self.assertIn("| GET /api/v1/users/me | Body has the role | expected { Object (id, roles) } to have property 'role' |", summary)
        # A pipe in a request name must not break the Markdown table.
        self.assertIn('| POST /api/v1/projects \\| create | Location header | TypeError', summary)

    def test_reports_a_green_run_without_a_failure_table(self):
        summary = newman_summary.render(self.write(ALL_GREEN))
        self.assertIn('**3 tests, 3 passed, 0 failed** — passed', summary)
        self.assertNotIn('| Request |', summary)

    def test_notes_a_missing_report_instead_of_failing(self):
        missing = self.dir / 'newman-reports' / 'newman.xml'
        summary = newman_summary.render(missing)
        self.assertIn(f'No report at `{missing}`', summary)
        self.assertIn('never started', summary)
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(newman_summary.main(['newman_summary.py', str(missing)]), 0)
        self.assertEqual(out.getvalue(), summary)

    def test_notes_a_report_that_is_not_xml(self):
        summary = newman_summary.render(self.write('not xml at all'))
        self.assertIn('not a valid junit file', summary)

    def test_truncates_long_messages(self):
        long_message = 'x' * 1000
        xml = WITH_FAILURES.replace("expected { Object (id, roles) } to have property 'role'", long_message)
        report = newman_summary.parse(self.write(xml))
        self.assertEqual(len(report['failures'][0]['message']), newman_summary.MESSAGE_LIMIT)
        self.assertTrue(report['failures'][0]['message'].endswith('…'))


if __name__ == '__main__':
    unittest.main()
