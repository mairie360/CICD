"""Frontend-only adapter preserving actual Semgrep exits and SARIF evidence."""
import importlib.metadata
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

VERSION = "1.177.0"


def arguments(config, paths, exclude, report):
    configs = shlex.split(config)
    if not configs:
        raise ValueError("A non-empty Semgrep config is required")
    args = ["semgrep", "scan"]
    for value in configs:
        args += ["--config", value]
    for value in shlex.split(exclude):
        args += ["--exclude", value]
    return args + ["--metrics=off", "--disable-version-check", "--error", "--jobs=1",
                   "--sarif-output", str(report), "--"] + (shlex.split(paths) or ["."])


def report_findings(report, code):
    if not report.is_file() or report.stat().st_size == 0:
        if code in (0, 1):
            raise ValueError("A successful scan or finding verdict requires its actual SARIF report")
        return 0, False
    data = json.loads(report.read_text())
    if not isinstance(data, dict) or data.get("version") != "2.1.0" or not isinstance(data.get("runs"), list) or not data["runs"]:
        raise ValueError("Malformed SARIF report")
    count = 0
    for run in data["runs"]:
        if not isinstance(run, dict):
            raise ValueError("Malformed SARIF run")
        results = run.get("results", [])
        if not isinstance(results, list):
            raise ValueError("Malformed SARIF results")
        count += len(results)
    if (code == 0 and count) or (code == 1 and not count):
        raise ValueError("Scanner exit and report findings disagree")
    return count, True


def verdict(code, findings, blocking):
    if blocking not in ("true", "false") or code < 0 or findings < 0:
        raise ValueError("Invalid scanner verdict inputs")
    if code == 0:
        if findings:
            raise ValueError("A clean scan cannot contain findings")
        return 0
    if code == 1:
        if not findings:
            raise ValueError("A findings exit requires real report findings")
        return 1 if blocking == "true" else 0
    return 1


def scan():
    if importlib.metadata.version("semgrep") != VERSION:
        raise ValueError("The published pinned Semgrep version is required")
    directory = Path(os.environ["RUNNER_TEMP"]) / "frontend-semgrep"
    directory.mkdir(parents=True, exist_ok=True)
    report = directory / "semgrep.sarif"
    # A prior report cannot certify a fresh failed process.
    report.unlink(missing_ok=True)
    command = arguments(os.environ.get("SEMGREP_CONFIG", ""),
                        os.environ.get("SEMGREP_PATHS", "."),
                        os.environ.get("SEMGREP_EXCLUDE", "cicd-repo"), report)
    # The executable is fixed to this isolated interpreter's installed scanner;
    # caller values are separate arguments and targets follow the -- sentinel.
    code = subprocess.run(["semgrep", *command[1:]],
                          executable=str(Path(sys.executable).with_name("semgrep")),
                          check=False, shell=False).returncode
    findings, has_sarif = report_findings(report, code)
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"exit_code={code}\nhas_sarif={str(has_sarif).lower()}\nfindings={findings}\nsarif_file={report}\n")
    print(f"Semgrep exit code: {code}, findings: {findings}")


if __name__ == "__main__":
    try:
        if sys.argv[1:] == ["scan"]:
            scan()
        elif sys.argv[1:] == ["verdict"]:
            code = verdict(int(os.environ["EXIT_CODE"]), int(os.environ["FINDINGS"]), os.environ["FAIL_ON_FINDINGS"])
            if code:
                print("::error::Frontend Semgrep findings or scanner error; see the actual report and scan log")
            sys.exit(code)
        else:
            raise ValueError("Use scan or verdict")
    except (ValueError, KeyError, OSError, importlib.metadata.PackageNotFoundError) as error:
        print(f"::error::Frontend scanner refused: {error}", file=sys.stderr)
        sys.exit(1)
