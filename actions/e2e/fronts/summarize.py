#!/usr/bin/env python3
"""Job summary of the Playwright journeys (results.json of the `json` reporter), in Markdown.

Usage: summarize.py <results.json> [<image under test>]
Prints the Markdown on stdout; a missing report yields an explanation, never a crash.
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


if __name__ == "__main__":
    sys.stdout.write(render(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ""))
