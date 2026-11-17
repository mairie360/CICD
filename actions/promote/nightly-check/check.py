"""Decide whether the nightly rehearsal of the promotion gates runs, and with Claude or not (MAIR-1008).

The gates of promote-staging / promote-prod used to run only on release day, so their failures were
found at the worst moment. Each service repo's `nightly-gates.yml` replays them every night on main,
in dry run (MAIR-1007), through this check:

- `sha`: main's newest commit that has a pipeline (journal / `[skip ci]` commits left out, the same
  rule as `resolve`), passed to both promotions so they test the same commit;
- `run`: 'false' on a scheduled run when that commit is the one the last green run of the workflow
  tested: nothing changed since a green night. A manual run always runs;
- `ai`: 'true' on the weekly day (`AI_WEEKDAY`, ISO 1 = Monday, UTC) or when a manual run asks for
  it. The gates that call Claude (GDPR simulation review, RGAA pre-audit, GDPR inventory proposals)
  only get the API key then; the rest of every gate runs each night without it.

Standard library only; the caller checks the repo out with `fetch-depth: 0`.
"""

import datetime
import importlib.util
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request
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


def last_green_head(repository, workflow, branch, token):
    """head_sha of the newest successful run of the workflow on the branch, None without one."""
    query = urllib.parse.urlencode({'branch': branch, 'status': 'success', 'per_page': 1})
    path = '/repos/{}/actions/workflows/{}/runs?{}'.format(repository, urllib.parse.quote(workflow), query)
    runs = resolve.api(path, token).get('workflow_runs', [])
    return runs[0].get('head_sha') if runs else None


def decide(env, today, last_green):
    """(outputs, reason) for the given environment, weekday and last green head."""
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
    if tested == current:
        # The weekly AI night still runs: the Claude reviews have not seen this commit yet.
        if ai:
            return outputs, 'weekly run with the AI reviews, {} unchanged'.format(current[:7])
        outputs['run'] = 'false'
        return outputs, '{} already passed the gates on {}'.format(current[:7], last_green[:7])
    return outputs, '{} moved to {}'.format(branch, current[:7])


def main(env):
    subprocess.run(['git', 'fetch', '--quiet', 'origin', env.get('BRANCH', 'main')], check=True)
    last = None
    if env.get('EVENT_NAME') != 'workflow_dispatch':
        last = last_green_head(env['GITHUB_REPOSITORY'], env['WORKFLOW_FILE'], env.get('BRANCH', 'main'), env['GITHUB_TOKEN'])
    return decide(env, datetime.datetime.now(datetime.timezone.utc).date(), last)


if __name__ == '__main__':
    try:
        outputs, reason = main(os.environ)
    except resolve.Refused as refusal:
        print('::error title=nightly-gates::{}'.format(refusal))
        sys.exit(1)
    print('Nightly gates: run={run} ai={ai} sha={sha} ({reason})'.format(reason=reason, **outputs))
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as out:
        for key, value in outputs.items():
            out.write('{}={}\n'.format(key, value))
    with open(os.environ.get('GITHUB_STEP_SUMMARY', os.devnull), 'a', encoding='utf-8') as summary:
        summary.write('Nightly gates on `{}`: {} ({}){}\n'.format(
            outputs['sha'], 'run' if outputs['run'] == 'true' else 'skipped', reason,
            ', with the AI reviews' if outputs['ai'] == 'true' else ''))
