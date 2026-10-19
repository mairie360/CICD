"""Release journal of a repo (RELEASE_JOURNAL.md), rewritten at each dev, staging and prod release.

Two sub-commands, around the Claude API call made by action.yml with curl:

  prepare <stage> <sha> <version> <journal> <out_dir>
      Reads the state kept in the journal, moves the pointer of <stage> to <sha> (or the
      v<version> tag in prod), lists the commits of the three ranges (main since the last prod
      release, dev -> staging, staging -> prod) with their pull requests, and writes
      <out_dir>/context.json and the Messages API request <out_dir>/request.json.

  render <journal> <out_dir> [response.json]
      Writes the journal from context.json and Claude's answer, or from the plain commit lists
      when the answer is missing or unusable.

Standard library only (python3 -I). Git runs in the current directory, a checkout of main with
its history and tags; pull requests are read through the GitHub API (GITHUB_TOKEN,
GITHUB_REPOSITORY, GITHUB_API_URL).
"""

import datetime
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request

STAGES = ('dev', 'staging', 'prod')
JOURNAL_COMMIT_PREFIX = 'docs(release-journal):'
SQUASH_RE = re.compile(r'\(#(\d+)\)\s*$')
STATE_RE = re.compile(r'<!-- release-journal-state (\{.*?\}) -->')
HISTORY_START = '<!-- release-journal-history:start -->'
HISTORY_END = '<!-- release-journal-history:end -->'
HISTORY_KEEP = 50
MAX_COMMITS = 200
MAX_BODY = 1500
MODEL = os.environ.get('RELEASE_JOURNAL_MODEL', 'claude-opus-5-5')

SECTIONS = (
    ('since_prod', 'Ajouté sur main depuis la dernière release prod'),
    ('dev_staging', 'Différence dev → staging (en dev, pas encore en staging)'),
    ('staging_prod', 'Différence staging → prod (en staging, pas encore en prod)'),
)

SYSTEM_PROMPT = """Tu rédiges le journal des releases d'un dépôt de la plateforme Mairie 360 \
(logiciel pour les mairies françaises), lu par l'équipe de développement et ses mentors.

Tu reçois, pour trois plages de commits, la liste des commits (Conventional Commits, souvent \
avec une clé Jira MAIR-XXX) et la pull request de chacun (titre, description). Pour chaque plage, \
écris en français une liste Markdown de ce qui a été ajouté ou changé :
- regroupe sous des titres de niveau 4 (`#### Nouveautés`, `#### Corrections`, `#### Technique`) \
et n'écris que les groupes non vides ;
- une puce par changement, une phrase claire sur ce que ça apporte, puis la clé Jira et le lien \
de la PR, par exemple : `- Les sessions révoquées sont refusées. (MAIR-264, [#123](url))` ;
- fusionne les commits qui portent sur le même changement ; les mises à jour de dépendances \
(chore(deps), Renovate) tiennent en une seule puce qui les compte ;
- garde tels quels les identifiants, noms de paquets, routes et messages d'erreur ;
- n'invente rien qui ne soit pas dans les commits ou les PR.
Pour une plage sans commit, renvoie une chaîne vide."""


def git(*args):
    return subprocess.run(['git', *args], check=True, capture_output=True, text=True).stdout.strip()


def git_ok(*args):
    return subprocess.run(['git', *args], capture_output=True, text=True).returncode == 0


def resolve(ref):
    if not ref:
        return ''
    result = subprocess.run(['git', 'rev-parse', '--verify', '--quiet', ref + '^{commit}'], capture_output=True, text=True)
    return result.stdout.strip() if result.returncode == 0 else ''


def is_ancestor(older, newer):
    return git_ok('merge-base', '--is-ancestor', older, newer)


def read_state(text):
    match = STATE_RE.search(text)
    if not match:
        return {}
    try:
        state = json.loads(match.group(1))
    except ValueError:
        return {}
    return state if isinstance(state, dict) else {}


def read_history(text):
    if HISTORY_START not in text or HISTORY_END not in text:
        return []
    block = text.split(HISTORY_START, 1)[1].split(HISTORY_END, 1)[0]
    return [line for line in block.splitlines() if line.startswith('| ') and not line.startswith('| Date') and not line.startswith('| ---')]


def last_prod_tag(ref):
    try:
        return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', ref)
    except subprocess.CalledProcessError:
        return ''


def advance(previous, sha):
    """The pointer only moves forward: an older run finishing late keeps the newer commit."""
    if previous and resolve(previous) and is_ancestor(sha, previous):
        return resolve(previous)
    return sha


def compute_refs(stage, sha, version, state):
    """Commit of each environment after this release, plus the prod tag."""
    sha = resolve(sha)
    if stage == 'prod':
        prod_tag = 'v' + version if version else last_prod_tag(sha)
    else:
        prod_tag = state.get('prod_tag') or last_prod_tag(sha)
    prod = resolve(prod_tag) if prod_tag else ''
    dev = resolve(state.get('dev', ''))
    staging = resolve(state.get('staging', ''))
    if stage == 'dev':
        dev = advance(dev, sha)
    if stage in ('staging', 'prod'):
        # Prod promotes the image staging tested for this same commit.
        staging = advance(staging, sha)
        dev = advance(dev or resolve('HEAD'), staging)
    staging = staging or prod
    dev = dev or staging or resolve('HEAD')
    return {'dev': dev, 'staging': staging, 'prod': prod, 'prod_tag': prod_tag}


def commits(base, head):
    """First-parent commits of base..head (everything up to head without base), journal commits left out."""
    if not head:
        return []
    spec = head if not base else base + '..' + head
    out = git('log', '--first-parent', '--format=%H%x1f%s%x1f%an%x1f%aI', '-n', str(MAX_COMMITS + 50), spec)
    result = []
    for line in out.splitlines():
        sha, subject, author, date = line.split('\x1f')
        if subject.startswith(JOURNAL_COMMIT_PREFIX):
            continue
        result.append({'sha': sha, 'subject': subject, 'author': author, 'date': date})
    return result[:MAX_COMMITS]


def pull_request(sha, cache):
    if sha in cache:
        return cache[sha]
    token, repo = os.environ.get('GITHUB_TOKEN'), os.environ.get('GITHUB_REPOSITORY')
    api = os.environ.get('GITHUB_API_URL', 'https://api.github.com')
    pr = None
    if token and repo:
        request = urllib.request.Request(api + '/repos/' + repo + '/commits/' + sha + '/pulls', headers={
            'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json'})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                pulls = json.load(response)
            merged = [p for p in pulls if p.get('merged_at')] or pulls
            if merged:
                p = merged[0]
                pr = {'number': p['number'], 'title': p['title'], 'url': p['html_url'],
                      'body': (p.get('body') or '')[:MAX_BODY]}
        except (urllib.error.URLError, ValueError, KeyError, TimeoutError):
            pr = None
    cache[sha] = pr
    return pr


def pr_from_subject(subject, server_url, repository):
    """Squash merges end their subject with (#<n>): enough for a link when the API is out of reach."""
    match = SQUASH_RE.search(subject)
    if not match or not repository:
        return None
    number = int(match.group(1))
    return {'number': number, 'title': subject, 'url': '{}/{}/pull/{}'.format(server_url, repository, number), 'body': ''}


def build_context(stage, sha, version, journal_text):
    state = read_state(journal_text)
    refs = compute_refs(stage, sha, version, state)
    cache = {}
    ranges = {
        'since_prod': commits(refs['prod'], refs['dev']),
        'dev_staging': commits(refs['staging'], refs['dev']) if refs['staging'] != refs['dev'] else [],
        'staging_prod': commits(refs['prod'], refs['staging']) if refs['staging'] != refs['prod'] else [],
    }
    for items in ranges.values():
        for commit in items:
            commit['pr'] = pull_request(commit['sha'], cache) or pr_from_subject(
                commit['subject'], os.environ.get('GITHUB_SERVER_URL', 'https://github.com'), os.environ.get('GITHUB_REPOSITORY', ''))
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    updated = dict(state.get('updated', {}))
    updated[stage] = now
    run_url = ''
    if os.environ.get('GITHUB_RUN_ID'):
        run_url = '{}/{}/actions/runs/{}'.format(os.environ.get('GITHUB_SERVER_URL', 'https://github.com'),
                                                os.environ.get('GITHUB_REPOSITORY', ''), os.environ['GITHUB_RUN_ID'])
    return {
        'repository': os.environ.get('GITHUB_REPOSITORY', ''),
        'server_url': os.environ.get('GITHUB_SERVER_URL', 'https://github.com'),
        'stage': stage, 'sha': resolve(sha), 'version': version, 'now': now, 'run_url': run_url,
        'refs': refs, 'updated': updated, 'ranges': ranges,
        'history': read_history(journal_text),
    }


def build_request(context):
    payload = {}
    for key, title in SECTIONS:
        payload[key] = {'titre': title, 'commits': [
            {'sujet': c['subject'], 'auteur': c['author'], 'sha': c['sha'][:7],
             'pr': c['pr'] and {'numero': c['pr']['number'], 'titre': c['pr']['title'],
                                'url': c['pr']['url'], 'description': c['pr']['body']}}
            for c in context['ranges'][key]]}
    prompt = ('Dépôt : {}. Passage en cours : {}{}. Rédige les trois sections.\n\n{}').format(
        context['repository'], context['stage'],
        ' (version v{})'.format(context['version']) if context['version'] else '',
        json.dumps(payload, ensure_ascii=False, indent=1))
    keys = [key for key, _ in SECTIONS]
    return {
        'model': MODEL,
        'max_tokens': 16000,
        'fallbacks': 'default',
        'output_config': {'effort': 'low', 'format': {'type': 'json_schema', 'schema': {
            'type': 'object', 'properties': {key: {'type': 'string'} for key in keys},
            'required': keys, 'additionalProperties': False}}},
        'system': SYSTEM_PROMPT,
        'messages': [{'role': 'user', 'content': prompt}],
    }


def parse_response(response):
    """Claude's three sections, or None when the answer is unusable (error, refusal, truncation)."""
    if not isinstance(response, dict) or response.get('stop_reason') != 'end_turn':
        return None
    text = ''.join(block.get('text', '') for block in response.get('content', []) if block.get('type') == 'text')
    try:
        sections = json.loads(text)
    except ValueError:
        return None
    if not isinstance(sections, dict) or not all(isinstance(sections.get(key), str) for key, _ in SECTIONS):
        return None
    return sections


def plain_list(items, server_url, repository):
    lines = []
    for c in items:
        link = ' ([#{}]({}))'.format(c['pr']['number'], c['pr']['url']) if c.get('pr') else \
            ' ([`{}`]({}/{}/commit/{}))'.format(c['sha'][:7], server_url, repository, c['sha'])
        lines.append('- ' + c['subject'] + link)
    return '\n'.join(lines)


def short(sha):
    return '`' + sha[:7] + '`' if sha else '—'


def render(context, sections):
    refs, updated, repo = context['refs'], context['updated'], context['repository']
    state = {'dev': refs['dev'], 'staging': refs['staging'], 'prod': refs['prod'],
             'prod_tag': refs['prod_tag'], 'updated': updated}
    prod_label = refs['prod_tag'] or 'aucune release prod'
    out = [
        '# Journal des releases' + (' — ' + repo.split('/')[-1] if repo else ''),
        '',
        '<!-- release-journal-state ' + json.dumps(state, sort_keys=True) + ' -->',
        '> Tenu à jour par la CI (`mairie360/CICD`, action `release/release-journal`) à chaque passage '
        'en dev, staging et prod. Ne pas modifier à la main : le fichier est réécrit au passage suivant.',
        '',
        '| Environnement | Version | Commit | Mis à jour |',
        '| --- | --- | --- | --- |',
        '| prod | {} | {} | {} |'.format(refs['prod_tag'] or '—', short(refs['prod']), updated.get('prod', '—')),
        '| staging | — | {} | {} |'.format(short(refs['staging']), updated.get('staging', '—')),
        '| dev | — | {} | {} |'.format(short(refs['dev']), updated.get('dev', '—')),
        '',
    ]
    for key, title in SECTIONS:
        heading = title + (' ({})'.format(prod_label) if key == 'since_prod' else '')
        items = context['ranges'][key]
        if not items:
            body = '_Rien._'
        elif sections and sections.get(key, '').strip():
            body = sections[key].strip()
        else:
            body = plain_list(items, context['server_url'], repo)
        out += ['## ' + heading, '', body, '']
    if not sections and any(context['ranges'].values()):
        out += ['> Résumé Claude indisponible pour ce passage : listes brutes des commits.', '']
    version = 'v' + context['version'] if context['version'] else '—'
    run = '[run]({})'.format(context['run_url']) if context['run_url'] else '—'
    row = '| {} | {} | {} | {} | {} |'.format(context['now'], context['stage'], version, short(context['sha']), run)
    history = [row] + context['history'][:HISTORY_KEEP - 1]
    out += ['## Historique des passages', '', HISTORY_START, '| Date | Environnement | Version | Commit | Run |',
            '| --- | --- | --- | --- | --- |', *history, HISTORY_END, '']
    return '\n'.join(out)


def main(argv):
    if len(argv) >= 6 and argv[0] == 'prepare':
        stage, sha, version, journal, out_dir = argv[1:6]
        if stage not in STAGES:
            sys.exit('release-journal: unknown stage {!r} (dev | staging | prod)'.format(stage))
        text = open(journal, encoding='utf-8').read() if os.path.exists(journal) else ''
        context = build_context(stage, sha, version.lstrip('v'), text)
        with open(os.path.join(out_dir, 'context.json'), 'w', encoding='utf-8') as f:
            json.dump(context, f, ensure_ascii=False)
        with open(os.path.join(out_dir, 'request.json'), 'w', encoding='utf-8') as f:
            json.dump(build_request(context), f, ensure_ascii=False)
        total = sum(len(v) for v in context['ranges'].values())
        print('changes={}'.format('true' if total else 'false'))
        return
    if len(argv) >= 3 and argv[0] == 'render':
        journal, out_dir = argv[1:3]
        context = json.load(open(os.path.join(out_dir, 'context.json'), encoding='utf-8'))
        sections = None
        if len(argv) >= 4 and os.path.exists(argv[3]):
            try:
                sections = parse_response(json.load(open(argv[3], encoding='utf-8')))
            except ValueError:
                sections = None
        with open(journal, 'w', encoding='utf-8') as f:
            f.write(render(context, sections))
        print('claude={}'.format('true' if sections else 'false'))
        return
    sys.exit(__doc__)


if __name__ == '__main__':
    main(sys.argv[1:])
