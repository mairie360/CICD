"""Fail-closed guards for a manual, frontend-only dev release exception."""
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

FRONTENDS = {
    'Login_Web_Service': 'login-front',
    'Projects_Web_Service': 'projects-front',
    'Calendars_Web_Service': 'calendar-front',
    'Messages_Web_Service': 'message-front',
    'Elearning_Web_Service': 'elearning-front',
    'Administrator_Web_Service': 'administrator-front',
    'Dashboard_Web_Service': 'dashboard-front',
    'Settings_Web_Service': 'settings-front',
}
ADVISORY = 'https://github.com/advisories/GHSA-vfj7-8cjw-p6xm'
CHAIN = {'braces': None, 'micromatch': 'braces', 'fast-glob': 'micromatch',
         '@next/eslint-plugin-next': 'fast-glob', 'eslint-config-next': '@next/eslint-plugin-next'}
RGAA = re.compile(r'rgaa|accessibility|a11y|pa11y|\baxe\b', re.I)
ALLOWED_SKIPS = {'Build Check (Next.js)', 'release-dev', 'Dynamic Security Tests (OWASP ZAP)',
                 'Isolated Performance Tests (k6)', 'release-staging', 'release-prod'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_audits(full, production, lock):
    for report in (full, production):
        require(report.get('auditReportVersion') == 2 and 'error' not in report,
                'A complete npm audit v2 report is required')
    require(production.get('vulnerabilities') == {}, 'Production dependencies must have no advisories')
    require(production.get('metadata', {}).get('vulnerabilities', {}).get('total') == 0,
            'Production audit must confirm zero findings')
    vulnerabilities = full.get('vulnerabilities', {})
    require(set(vulnerabilities) == set(CHAIN), 'Only the five known development dependency entries are allowed')
    counts = full.get('metadata', {}).get('vulnerabilities', {})
    require(counts.get('high') == 5 and counts.get('total') == 5 and counts.get('critical') == 0,
            'The exception does not cover additional findings')
    packages = lock.get('packages', {})
    require(lock.get('lockfileVersion') == 3 and packages, 'A complete lockfile v3 is required')
    for name, parent in CHAIN.items():
        item = vulnerabilities[name]
        require(item.get('name') == name and item.get('severity') == 'high', 'Unexpected audit entry')
        require(item.get('nodes'), 'Missing affected package locations')
        for node in item['nodes']:
            require(packages.get(node, {}).get('dev') is True, 'Every affected installation must be dev-only')
        if parent is None:
            via = item.get('via', [])
            require(len(via) == 1 and isinstance(via[0], dict) and via[0].get('url') == ADVISORY,
                    'The exception covers exactly one known advisory')
            require(via[0].get('name') == 'braces' and via[0].get('dependency') == 'braces'
                    and via[0].get('severity') == 'high' and via[0].get('range') == '<=3.0.3',
                    'The known advisory details changed; re-evaluate the exception')
        else:
            require(item.get('via') == [parent], 'Unexpected advisory dependency chain')
    return {'advisory': ADVISORY, 'fullAudit': 'failure', 'productionFindings': 0,
            'scope': 'manual dev only', 'allowedDevelopmentEntries': sorted(CHAIN)}


def validate_jobs(jobs):
    require(jobs and all(j.get('status') == 'completed' for j in jobs), 'The existing pipeline must have finished')
    failed = [j for j in jobs if j.get('conclusion') == 'failure']
    require(len(failed) == 1 and failed[0]['name'].endswith('Security Audit (npm audit)'),
            'Only the original npm audit job may have failed')
    for job in jobs:
        if RGAA.search(job['name']):
            require(job.get('conclusion') == 'success', 'An RGAA check cannot be skipped or bypassed')
        require(job.get('conclusion') in {'success', 'failure', 'skipped'}, 'Unexpected pipeline conclusion')
        if job.get('conclusion') == 'skipped':
            require(any(job['name'].endswith(name) for name in ALLOWED_SKIPS), 'An unrecognized skipped control blocks the exception')
    for name in ['Install Dependencies', 'Lint Code', 'Unit Tests', 'Code Security Audit (Semgrep, Gitleaks)']:
        require(any(j['name'].endswith(name) and j.get('conclusion') == 'success' for j in jobs),
                'Required existing control did not succeed: ' + name)


def github(path):
    token = os.environ['GH_TOKEN']
    request = urllib.request.Request('https://api.github.com/repos/' + os.environ['GITHUB_REPOSITORY'] + '/' + path,
        headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json',
                 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'frontend-dev-release-guard'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def collection(path, key):
    values = []
    for page in range(1, 21):
        data = github(path + ('&' if '?' in path else '?') + f'per_page=100&page={page}')
        items = data[key]
        values.extend(items)
        if len(items) < 100:
            return values
    raise ValueError('GitHub pagination limit reached; no partial proof accepted')


def validate_target():
    repo = os.environ['GITHUB_REPOSITORY']
    require(repo.startswith('mairie360/') and len(repo.split('/')) == 2, 'Only the existing organization is allowed')
    require(FRONTENDS.get(repo.split('/')[1]) == os.environ['PACKAGE_NAME'], 'Only the eight included frontend images are allowed')
    require(os.environ['GITHUB_EVENT_NAME'] == 'workflow_dispatch' and os.environ['GITHUB_REF'] == 'refs/heads/main',
            'The exception is manual and restricted to main')
    require(re.fullmatch('[0-9a-f]{40}', os.environ['CICD_REF']) is not None, 'The CI tools must be pinned to a reviewed commit')
    require(os.environ.get('EXCEPTION_REASON', '').strip(), 'An explicit exception reason is required')
    require(github('branches/main')['commit']['sha'] == os.environ['GITHUB_SHA'], 'main advanced; dispatch its actual head instead')


def preflight():
    validate_target()
    head = os.environ['GITHUB_SHA']
    runs = collection('actions/runs?head_sha=' + head + '&event=push', 'workflow_runs')
    pipelines = [r for r in runs if r['name'].endswith('CICD')]
    require(pipelines, 'No existing main pipeline was found')
    run = max(pipelines, key=lambda r: r['id'])
    require(run['status'] == 'completed' and run['conclusion'] == 'failure', 'Wait for the original main pipeline verdict')
    jobs = collection(f"actions/runs/{run['id']}/jobs?filter=latest", 'jobs')
    validate_jobs(jobs)
    contracts = [r for r in runs if r['name'] == 'BFF contract consistency']
    require(contracts and max(contracts, key=lambda r: r['id'])['conclusion'] == 'success', 'Published contract checks must pass')
    checks = collection('commits/' + head + '/check-runs', 'check_runs')
    latest = {}
    for check in checks:
        if check['id'] > latest.get(check['name'], {}).get('id', -1):
            latest[check['name']] = check
    for name, check in latest.items():
        if RGAA.search(name):
            require(check['status'] == 'completed' and check['conclusion'] == 'success', 'Existing RGAA check must pass: ' + name)
    return {'head': head, 'originalRun': run['html_url'], 'jobs': jobs,
            'originalAudit': 'failure', 'rgaaConfigurationChanged': False}


def validate_missing_tag(reference, result):
    require(result.returncode != 0, 'The immutable dev tag already exists; never overwrite it')
    require(reference + ': not found' in result.stderr or 'manifest unknown' in result.stderr.lower(),
            'Registry absence was not confirmed; authentication/network errors do not authorize a write')
    return {'devTagAbsent': reference}


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'audit':
            data = validate_audits(*(json.loads(Path(p).read_text()) for p in sys.argv[2:5]))
            with urllib.request.urlopen('https://registry.npmjs.org/braces/latest', timeout=30) as response:
                latest = json.load(response)['version']
            require(latest == '3.0.3', 'A newer braces version is published; re-evaluate dependencies instead')
            data['registryLatestBraces'] = latest
        elif sys.argv[1] == 'preflight':
            data = preflight()
        elif sys.argv[1] == 'target':
            validate_target()
            data = {'head': os.environ['GITHUB_SHA'], 'mainStillCurrent': True}
        elif sys.argv[1] == 'tag-absent':
            validate_target()
            reference = 'ghcr.io/mairie360/' + os.environ['PACKAGE_NAME'] + ':dev-' + os.environ['GITHUB_SHA'][:7]
            result = subprocess.run(['docker', 'buildx', 'imagetools', 'inspect', reference],
                                    capture_output=True, text=True, timeout=30, check=False)
            data = {'head': os.environ['GITHUB_SHA'], 'mainStillCurrent': True,
                    **validate_missing_tag(reference, result)}
        else:
            raise ValueError('Unknown guard mode')
        print(json.dumps(data, indent=2))
    except (ValueError, KeyError, IndexError) as error:
        print('Release guard refused: ' + str(error), file=sys.stderr)
        sys.exit(1)
