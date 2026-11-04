#!/usr/bin/env python3
"""Job summary of the Playwright journeys (results.json of the `json` reporter), in Markdown.

Usage: summarize.py <results.json> [<image under test>]
       summarize.py --check <results.json>
The first form prints the Markdown on stdout; a missing report yields an explanation, never a crash.
`--check` is the evidence gate of the successful path: exit 1 unless the report is a readable
Playwright JSON report with at least one journey that passed and none that failed (an exit code
of 0 with no report, or with every journey skipped, proves nothing).
"""
import json
import sys
from collections import Counter
from pathlib import Path

ICONS = {"expected": "✅", "unexpected": "❌", "flaky": "⚠️", "skipped": "⏭️"}


def journeys(report):
    """(title path, status) of every test, suites flattened in report order."""
    rows = []

    def walk(suite, path):
        for spec in suite.get("specs", []):
            for test in spec.get("tests", []):
                rows.append((" › ".join(path + [spec.get("title", "")]), test.get("status", "unknown")))
        for child in suite.get("suites", []):
            walk(child, path + [child.get("title", "")])

    for suite in report.get("suites", []):
        walk(suite, [suite.get("title", "")])
    return rows


def render(report_path, image=""):
    lines = ["## End-to-end journeys (Playwright)", "", f"Image under test: `{image or 'local build'}`", ""]
    path = Path(report_path)
    if not path.is_file():
        lines.append(f"No `{report_path}`: the stack or the Playwright runner did not start (see the job log).")
        return "\n".join(lines) + "\n"
    try:
        rows = journeys(json.loads(path.read_text(encoding="utf-8")))
    except (ValueError, AttributeError):
        lines.append(f"`{report_path}` is not a Playwright JSON report (see the job log).")
        return "\n".join(lines) + "\n"
    counts = Counter(status for _, status in rows)
    lines.append(
        f"**{counts['expected']} passed**, {counts['unexpected']} failed, "
        f"{counts['flaky']} flaky, {counts['skipped']} skipped"
    )
    lines += ["", "| Journey | Result |", "| --- | --- |"]
    lines += [f"| {title} | {ICONS.get(status, '')} {status} |".replace("|  ", "| ") for title, status in rows]
    return "\n".join(lines) + "\n"


def check(report_path):
    """(ok, message): the report proves that the journeys ran and passed."""
    path = Path(report_path)
    if not path.is_file():
        return False, f"no {report_path}: the runner exited 0 without a Playwright report"
    try:
        rows = journeys(json.loads(path.read_text(encoding="utf-8")))
    except (ValueError, AttributeError):
        return False, f"{report_path} is not a Playwright JSON report"
    counts = Counter(status for _, status in rows)
    if counts["unexpected"]:
        return False, f"{counts['unexpected']} journey(s) failed although the runner exited 0"
    # A flaky journey failed once and passed on the retry: it counts as a pass.
    passed = counts["expected"] + counts["flaky"]
    if not passed:
        return False, f"no journey passed ({len(rows)} in the report, {counts['skipped']} skipped)"
    return True, f"{passed} journey(s) passed, {counts['skipped']} skipped"


if __name__ == "__main__":
    if sys.argv[1:2] == ["--check"]:
        ok, message = check(sys.argv[2])
        print(message if ok else f"::error title=e2e::{message}")
        sys.exit(0 if ok else 1)
    sys.stdout.write(render(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ""))
