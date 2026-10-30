"""Resolve and check the commit a promote-staging / promote-prod run promotes (MAIR-494).

Standard library only. Reads its parameters from the environment (see `main`) and writes `sha`,
`sha_tag`, `image`, `digest` and `extra_digest` to $GITHUB_OUTPUT. A promotion is refused (exit 1)
when the commit is not on main, or is not yet on the previous environment:

- staging: `dev-<sha>` exists (both images for the database) and the main CI run of the commit
  released it (`release-dev` job green, no failed job);
- prod: `staging-<sha>` exists.

The cosign signature and the digest are checked again by `release/docker-release` when it tags.
"""

import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request

# Commits that never get an image of their own: the release journal (pushed by the release app
# after a release) and anything else pushed with `[skip ci]`.
SKIP_RE = re.compile(r'^docs\(release-journal\):|\[skip ci\]|\[ci skip\]', re.IGNORECASE)
RELEASE_DEV_JOB_RE = re.compile(r'release[ _-](to[ _-])?dev$', re.IGNORECASE)
FAILED = {'failure', 'timed_out', 'startup_failure'}
SOURCE_STAGE = {'staging': 'dev', 'prod': 'staging'}
MAX_COMMITS = 50


class Refused(Exception):
    pass


def git(*args):
    return subprocess.run(['git', *args], check=True, capture_output=True, text=True).stdout.strip()


def skipped(subject):
    return bool(SKIP_RE.search(subject))


def first_parent_commits(branch_ref):
    """(sha, subject) of the first-parent history of the branch, newest first."""
    out = git('log', '--first-parent', f'--max-count={MAX_COMMITS}', '--format=%H %s', branch_ref)
    return [tuple(line.split(' ', 1)) if ' ' in line else (line, '') for line in out.splitlines()]


def pick_default(commits, target, has_source_tag):
    """Commit promoted when no sha is given.

    staging: the newest commit of main that has a pipeline (journal / `[skip ci]` commits left
    out); it is refused later if its dev release is not done. prod: the newest commit of main
    already released on staging.
    """
    for sha, subject in commits:
        if skipped(subject):
            continue
        if target == 'staging' or has_source_tag(sha):
            return sha
    if target == 'staging':
        raise Refused('no commit with a pipeline in the last {} commits of main'.format(MAX_COMMITS))
    raise Refused('none of the last {} commits of main is released on staging'.format(MAX_COMMITS))


def check_ci_jobs(jobs):
    """Refusal reason for the jobs of the main CI run of the commit, or None when it is good."""
    release_dev = [job for job in jobs if RELEASE_DEV_JOB_RE.search(job.get('name', ''))]
    if not release_dev:
        return 'the main CI run has no release-dev job'
    if not any(job.get('conclusion') == 'success' for job in release_dev):
        states = ', '.join('{}={}'.format(job.get('status'), job.get('conclusion')) for job in release_dev)
        return 'release-dev of the main CI run did not succeed ({})'.format(states)
    failed = sorted(job['name'] for job in jobs if job.get('conclusion') in FAILED)
    if failed:
        return 'jobs of the main CI run failed: {}'.format(', '.join(failed))
    return None


def check_run_status(run):
    """Refusal reason while the main run of the commit can still fail, None once it is settled.

    `waiting` is a v4 run held on its Staging / Prod approval: every check before it has a verdict.
    """
    if run.get('status') in ('completed', 'waiting'):
        return None
    return 'the main CI run is still {}: wait for it to finish'.format(run.get('status'))


def latest_run(runs, branch):
    candidates = [run for run in runs if run.get('head_branch') == branch and run.get('event') == 'push']
    if not candidates:
        return None
    return max(candidates, key=lambda run: (run.get('run_number', 0), run.get('run_attempt', 0)))


def api(path, token):
    base = os.environ.get('GITHUB_API_URL', 'https://api.github.com')
    request = urllib.request.Request(base + path, headers={
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token,
        'X-GitHub-Api-Version': '2022-11-28',
    })
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def check_ci(repository, workflow, sha, branch, token):
    query = urllib.parse.urlencode({'head_sha': sha, 'event': 'push', 'per_page': 30})
    runs = api('/repos/{}/actions/workflows/{}/runs?{}'.format(repository, urllib.parse.quote(workflow), query), token)
    run = latest_run(runs.get('workflow_runs', []), branch)
    if run is None:
        raise Refused('no {} run on {} for {}'.format(workflow, branch, sha[:7]))
    reason = check_run_status(run)
    if reason:
        raise Refused('{} ({})'.format(reason, run.get('html_url', run['id'])))
    jobs = api('/repos/{}/actions/runs/{}/jobs?per_page=100'.format(repository, run['id']), token).get('jobs', [])
    reason = check_ci_jobs(jobs)
    if reason:
        raise Refused('{} ({})'.format(reason, run.get('html_url', run['id'])))
    print('Main CI run OK: {}'.format(run.get('html_url', run['id'])))


def image_digest(ref):
    """Digest of an image tag, None when the tag does not exist."""
    result = subprocess.run(['docker', 'buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest}}'],
                            capture_output=True, text=True)
    if result.returncode != 0:
        return None
    digest = json.loads(result.stdout).get('digest', '')
    return digest if re.fullmatch(r'sha256:[0-9a-f]{64}', digest) else None


def resolve_sha(requested, branch_ref):
    if not re.fullmatch(r'[0-9a-fA-F]{7,40}', requested):
        raise Refused('`{}` is not a commit sha'.format(requested))
    try:
        sha = git('rev-parse', '--verify', '--quiet', requested + '^{commit}')
    except subprocess.CalledProcessError:
        raise Refused('commit {} not found'.format(requested))
    if subprocess.run(['git', 'merge-base', '--is-ancestor', sha, branch_ref]).returncode != 0:
        raise Refused('commit {} is not on {}'.format(sha[:7], branch_ref))
    return sha


def main(env):
    target = env['TARGET']
    if target not in SOURCE_STAGE:
        raise Refused('unknown target `{}` (staging | prod)'.format(target))
    source = SOURCE_STAGE[target]
    branch = env.get('BRANCH', 'main')
    branch_ref = 'origin/' + branch
    length = int(env.get('SHA_LENGTH', '7'))
    owner = env['GITHUB_REPOSITORY_OWNER'].lower()
    images = ['ghcr.io/{}/{}'.format(owner, env['PACKAGE_NAME'])]
    if env.get('EXTRA_PACKAGE_NAME'):
        images.append('ghcr.io/{}/{}'.format(owner, env['EXTRA_PACKAGE_NAME']))

    def source_ref(image, sha):
        return '{}:{}-{}'.format(image, source, sha[:length])

    requested = env.get('SHA_INPUT', '').strip()
    if requested:
        sha = resolve_sha(requested, branch_ref)
    else:
        sha = pick_default(first_parent_commits(branch_ref), target,
                           lambda candidate: image_digest(source_ref(images[0], candidate)) is not None)
        print('No sha given: promoting {}'.format(sha[:7]))

    digests = []
    for image in images:
        digest = image_digest(source_ref(image, sha))
        if digest is None:
            raise Refused('{} does not exist: promote {} to {} first'.format(source_ref(image, sha), sha[:7], source))
        print('{} -> {}'.format(source_ref(image, sha), digest))
        digests.append(digest)

    if target == 'staging':
        check_ci(env['GITHUB_REPOSITORY'], env.get('CI_WORKFLOW', 'cicd.yml'), sha, branch, env['GITHUB_TOKEN'])

    return {
        'sha': sha,
        'sha_tag': sha[:length],
        'image': images[0],
        'digest': digests[0],
        'extra_digest': digests[1] if len(digests) > 1 else '',
    }


if __name__ == '__main__':
    try:
        outputs = main(os.environ)
    except Refused as refusal:
        print('::error title=promote::{}'.format(refusal))
        sys.exit(1)
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as out:
        for key, value in outputs.items():
            out.write('{}={}\n'.format(key, value))
    with open(os.environ.get('GITHUB_STEP_SUMMARY', os.devnull), 'a', encoding='utf-8') as summary:
        summary.write('Promoting `{}` to **{}** (`{}`)\n'.format(outputs['sha'], os.environ['TARGET'], outputs['digest']))
