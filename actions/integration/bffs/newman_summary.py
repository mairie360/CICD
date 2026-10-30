#!/usr/bin/env python3
"""Job summary of a newman junit report (`integration/bffs`, MAIR-262).

Reads the junit file newman wrote (`newman-reports/newman.xml` by default) and prints a Markdown
summary for `$GITHUB_STEP_SUMMARY`: the number of test cases, how many passed and failed, then
the failed cases with their suite (the request) and the assertion message. A missing or
unreadable file gives a short note instead (the stack never started, newman never ran, ...).

Standard library only. Never fails the step: the verdict is the exit code of
`integration_test.sh`, this script only reports it.
"""

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

DEFAULT_REPORT = Path("newman-reports/newman.xml")
MESSAGE_LIMIT = 300


def _first_line(text):
    for line in (text or "").splitlines():
        line = line.strip()
        if line:
            return line
    return ""


def _message(node):
    """Assertion message of a `<failure>` / `<error>`: the attribute, else the element's text."""
    message = (node.get("message") or "").strip() or _first_line(node.text)
    if len(message) > MESSAGE_LIMIT:
        message = message[: MESSAGE_LIMIT - 1] + "…"
    return message


def parse(path):
    """Counts and failed cases of a junit file.

    Returns `{"total", "passed", "failed", "skipped", "failures": [{"suite", "name", "message"}]}`.
    Raises `FileNotFoundError` when the file is missing and `ET.ParseError` when it is not XML.
    """
    root = ET.parse(path).getroot()
    total = failed = skipped = 0
    failures = []
    for suite in root.iter("testsuite"):
        suite_name = suite.get("name") or "(no suite)"
        for case in suite.findall("testcase"):
            total += 1
            problem = case.find("failure")
            if problem is None:
                problem = case.find("error")
            if problem is not None:
                failed += 1
                failures.append(
                    {
                        "suite": suite_name,
                        "name": case.get("name") or "(no name)",
                        "message": _message(problem),
                    }
                )
            elif case.find("skipped") is not None:
                skipped += 1
    return {
        "total": total,
        "passed": total - failed - skipped,
        "failed": failed,
        "skipped": skipped,
        "failures": failures,
    }


def _cell(text):
    return text.replace("|", "\\|").replace("\n", " ")


def render(path=DEFAULT_REPORT):
    """Markdown summary of the report at `path`, a note when it cannot be read."""
    path = Path(path)
    try:
        report = parse(path)
    except FileNotFoundError:
        return (
            "## Integration tests (newman)\n\n"
            f"No report at `{path}`: newman wrote nothing, the stack probably never started "
            "(see the \"Run integration tests\" step and the container logs).\n"
        )
    except OSError as error:
        return (
            "## Integration tests (newman)\n\n"
            f"The report `{path}` could not be read ({error.strerror or error}).\n"
        )
    except ET.ParseError as error:
        return (
            "## Integration tests (newman)\n\n"
            f"The report `{path}` is not a valid junit file ({error}).\n"
        )

    verdict = "passed" if report["failed"] == 0 else "failed"
    lines = [
        "## Integration tests (newman)",
        "",
        f"**{report['total']} tests, {report['passed']} passed, {report['failed']} failed**"
        + (f", {report['skipped']} skipped" if report["skipped"] else "")
        + f" — {verdict}",
        "",
    ]
    if report["failures"]:
        lines += [
            "| Request | Assertion | Message |",
            "| --- | --- | --- |",
        ]
        lines += [
            f"| {_cell(f['suite'])} | {_cell(f['name'])} | {_cell(f['message'])} |"
            for f in report["failures"]
        ]
        lines.append("")
    return "\n".join(lines)


def main(argv):
    path = argv[1] if len(argv) > 1 else DEFAULT_REPORT
    sys.stdout.write(render(path))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
