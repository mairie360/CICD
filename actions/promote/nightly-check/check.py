"""Decide whether the nightly rehearsal of the promotion gates runs, and with Claude or not (MAIR-1008).

The gates of promote-staging / promote-prod used to run only on release day, so their failures were
found at the worst moment. Each service repo's `nightly-gates.yml` replays them every night on main,
in dry run (MAIR-1007), through this check:

- `sha`: main's newest commit that has a pipeline (journal / `[skip ci]` commits left out, the same
  rule as `resolve`), passed to both promotions so they test the same commit;
- `run`: 'false' on a scheduled run when that commit is the one the last green run of the workflow
  tested and the upstream images of the stage tags (`ghcr.io/mairie360/<name>:${UPSTREAM_TAG...}` in
  the repo's compose files, tags dev / staging / latest, MAIR-998) still have the digests that run
  saw: nothing changed since a green night. The tags move without a commit of the repo, so an
  unreadable digest counts as a change. A manual run always runs;
- `ai`: 'true' on the weekly day (`AI_WEEKDAY`, ISO 1 = Monday, UTC) or when a manual run asks for
  it. The gates that call Claude (GDPR simulation review, RGAA pre-audit, GDPR inventory proposals)
  only get the API key then; the rest of every gate runs each night without it.

Standard library only; the caller checks the repo out with `fetch-depth: 0`.
"""

import base64
import datetime
import hashlib
import importlib.util
import io
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

_spec = importlib.util.spec_from_file_location('resolve', Path(__file__).parents[1] / 'resolve' / 'resolve.py')
resolve = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(resolve)


def candidate(ref):
    """Newest first-parent commit of `ref` with a pipeline of its own, None when there is none."""
    for sha, subject in resolve.first_parent_commits(ref):
        if not resolve.skipped(subject):
            return sha
    return None


STAGE_TAGS = ('dev', 'staging', 'latest')
FINGERPRINT_ARTIFACT = 'nightly-fingerprint'
COMPOSE_IMAGE = re.compile(r'ghcr\.io/mairie360/([a-z0-9][a-z0-9._-]*):\$\{UPSTREAM_TAG')
MANIFEST_TYPES = ', '.join((
    'application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json'))


def last_green_run(repository, workflow, branch, token):
    """Newest successful run of the workflow on the branch, None without one."""
    query = urllib.parse.urlencode({'branch': branch, 'status': 'success', 'per_page': 1})
    path = '/repos/{}/actions/workflows/{}/runs?{}'.format(repository, urllib.parse.quote(workflow), query)
    runs = resolve.api(path, token).get('workflow_runs', [])
    return runs[0] if runs else None


def last_green_head(repository, workflow, branch, token):
    """head_sha of the newest successful run of the workflow on the branch, None without one."""
    run = last_green_run(repository, workflow, branch, token)
    return run.get('head_sha') if run else None


def upstream_images(root='.'):
    """Names of the mairie360 images the compose files of `root` pull on the stage tag, sorted."""
    names = set()
    for path in Path(root).glob('docker-compose*.y*ml'):
        names.update(COMPOSE_IMAGE.findall(path.read_text(encoding='utf-8')))
    return sorted(names)


def registry_digest(name, tag, token):
    """Manifest digest of ghcr.io/mairie360/<name>:<tag>, None when it cannot be read."""
    try:
        scope = urllib.parse.quote('repository:mairie360/{}:pull'.format(name), safe='')
        # The token endpoint of GHCR reads HTTP Basic credentials (any user name works with a
        # GITHUB_TOKEN); a Bearer header is ignored and yields an anonymous token, which cannot
        # read a private image.
        user = os.environ.get('GITHUB_ACTOR') or 'github-actions'
        basic = base64.b64encode('{}:{}'.format(user, token).encode()).decode()
        auth = urllib.request.Request('https://ghcr.io/token?scope=' + scope,
                                      headers={'Authorization': 'Basic ' + basic})
        with urllib.request.urlopen(auth, timeout=60) as response:
            registry_token = json.load(response)['token']
        request = urllib.request.Request(
            'https://ghcr.io/v2/mairie360/{}/manifests/{}'.format(name, tag), method='HEAD',
            headers={'Authorization': 'Bearer ' + registry_token, 'Accept': MANIFEST_TYPES})
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.headers.get('Docker-Content-Digest')
    except Exception:  # an unreadable digest is reported as 'changed', never as 'unchanged'
        return None


def fingerprint(names, token, lookup=registry_digest):
    """Hash of the digests of the stage tags of `names`: '' without upstream images, None when one is unreadable."""
    lines = []
    for name in names:
        for tag in STAGE_TAGS:
            digest = lookup(name, tag, token)
            if not digest:
                return None
            lines.append('{}:{}@{}'.format(name, tag, digest))
    return hashlib.sha256('\n'.join(lines).encode()).hexdigest() if lines else ''


def stored_fingerprint(repository, run_id, token):
    """Fingerprint the given run recorded in its `nightly-fingerprint` artifact, None without one."""
    try:
        artifacts = resolve.api('/repos/{}/actions/runs/{}/artifacts'.format(repository, run_id), token)
        found = [a for a in artifacts.get('artifacts', []) if a.get('name') == FINGERPRINT_ARTIFACT and not a.get('expired')]
        if not found:
            return None
        base = os.environ.get('GITHUB_API_URL', 'https://api.github.com')
        request = urllib.request.Request('{}/repos/{}/actions/artifacts/{}/zip'.format(base, repository, found[0]['id']),
                                         headers={'Authorization': 'Bearer ' + token})
        with urllib.request.urlopen(request, timeout=60) as response:
            archive = zipfile.ZipFile(io.BytesIO(response.read()))
        return archive.read(archive.namelist()[0]).decode().strip()
    except Exception:
        return None


def decide(env, today, last_green, upstream='', last_upstream=''):
    """(outputs, reason) for the given environment, weekday, last green head and upstream fingerprints."""
    branch = env.get('BRANCH', 'main')
    current = candidate('origin/' + branch)
    if current is None:
        raise resolve.Refused('no commit with a pipeline in the last {} commits of {}'.format(resolve.MAX_COMMITS, branch))
    manual = env.get('EVENT_NAME') == 'workflow_dispatch'
    ai = today.isoweekday() == int(env.get('AI_WEEKDAY', '1')) or (manual and env.get('AI_INPUT', 'false') == 'true')
    outputs = {'sha': current, 'run': 'true', 'ai': 'true' if ai else 'false'}
    if manual:
        return outputs, 'manual run'
    if last_green is None:
        return outputs, 'no green run yet'
    try:
        tested = candidate(last_green)
    except subprocess.CalledProcessError:
        return outputs, 'the last green run tested a commit no longer on {}'.format(branch)
    if tested == current and upstream is None:
        return outputs, 'upstream image digests unreadable, {} not trusted as already tested'.format(current[:7])
    if tested == current and upstream != '' and upstream != last_upstream:
        return outputs, 'upstream images of the stage tags moved since the last green run'
    if tested == current:
        # The weekly AI night still runs: the Claude reviews have not seen this commit yet.
        if ai:
            return outputs, 'weekly run with the AI reviews, {} unchanged'.format(current[:7])
        outputs['run'] = 'false'
        return outputs, '{} already passed the gates on {}'.format(current[:7], last_green[:7])
    return outputs, '{} moved to {}'.format(branch, current[:7])


def main(env):
    subprocess.run(['git', 'fetch', '--quiet', 'origin', env.get('BRANCH', 'main')], check=True)
    upstream = fingerprint(upstream_images(), env['GITHUB_TOKEN'])
    run = None
    if env.get('EVENT_NAME') != 'workflow_dispatch':
        run = last_green_run(env['GITHUB_REPOSITORY'], env['WORKFLOW_FILE'], env.get('BRANCH', 'main'), env['GITHUB_TOKEN'])
    last_upstream = stored_fingerprint(env['GITHUB_REPOSITORY'], run['id'], env['GITHUB_TOKEN']) if run else None
    outputs, reason = decide(env, datetime.datetime.now(datetime.timezone.utc).date(),
                             run.get('head_sha') if run else None, upstream, last_upstream)
    return outputs, reason, upstream


if __name__ == '__main__':
    try:
        outputs, reason, upstream = main(os.environ)
    except resolve.Refused as refusal:
        print('::error title=nightly-gates::{}'.format(refusal))
        sys.exit(1)
    print('Nightly gates: run={run} ai={ai} sha={sha} ({reason})'.format(reason=reason, **outputs))
    # Recorded by the next step of the action so the following night can compare against it.
    Path(os.environ.get('FINGERPRINT_FILE', os.devnull)).write_text('unknown' if upstream is None else upstream, encoding='utf-8')
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as out:
        for key, value in outputs.items():
            out.write('{}={}\n'.format(key, value))
    with open(os.environ.get('GITHUB_STEP_SUMMARY', os.devnull), 'a', encoding='utf-8') as summary:
        summary.write('Nightly gates on `{}`: {} ({}){}\n'.format(
            outputs['sha'], 'run' if outputs['run'] == 'true' else 'skipped', reason,
            ', with the AI reviews' if outputs['ai'] == 'true' else ''))
