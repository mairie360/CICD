#!/usr/bin/env python3
"""Accessibility (RGAA) section of a front's prod release.

Appends to the release notes a section built from the `report.json` the `rgaa` gate of
promote-prod wrote (tests/a11y): CI rate, criteria to review, the invalidated criteria with the
pages (states) and elements that fail, and the criteria whose status changed since the previous
prod release (its `rgaa-report.json` asset). The section is in French, like the release journal:
it is read by the team and the mentors.

Never fails the release: an unreadable report gives a one-line warning section, an unreadable
previous report gives "first measure". Standard library only.

Usage: accessibility_section.py --notes <notes.md> --report <report.json> [--previous <report.json>]
       [--output <file>] (default: the notes file, rewritten in place)
"""
import argparse
import json
import os
import re
import sys
import tempfile

HEADING = '## Accessibilité (RGAA)'
MAX_STATES = 5        # pages listed per invalidated criterion
MAX_ELEMENTS = 5      # elements listed per invalidated criterion
MAX_TEXT = 160        # characters of a selector or message
STATUS_LABELS = {'validated': 'validé', 'invalidated': 'invalidé', 'to_review': 'à vérifier',
                 'to review': 'à vérifier'}


def load(path):
    """Report dict, or None when the file is missing or is not a usable RGAA report."""
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, encoding='utf-8') as f:
            report = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(report, dict) or not isinstance(report.get('rate'), dict) \
            or not isinstance(report.get('criteria'), list):
        return None
    return report


def status(criterion):
    value = str(criterion.get('status', '')).replace(' ', '_')
    return value if value in ('validated', 'invalidated', 'to_review') else 'to_review'


def code(text):
    """Inline code span that cannot break out: one line, bounded, backticks replaced."""
    text = ' '.join(str(text).split()).replace('`', "'")
    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT - 1] + '…'
    return f'`{text}`' if text else '`?`'


def plain(text):
    """One line of prose: no Markdown / HTML control characters, bounded."""
    text = re.sub(r'(?i)\b(?:https?|ftp)://\S+|\bwww\.\S+', 'URL retirée', ' '.join(str(text).split()))
    for ch in '<>[]`*_|#!':
        text = text.replace(ch, ' ')
    text = ' '.join(text.split())
    return text if len(text) <= MAX_TEXT else text[:MAX_TEXT - 1] + '…'


def criterion_key(cid):
    try:
        return tuple(int(p) for p in str(cid).split('.'))
    except ValueError:
        return (999, str(cid))


def first_line(message):
    for line in str(message).splitlines():
        line = line.strip()
        if line and not line.lower().startswith('fix any of the following') \
                and not line.lower().startswith('fix all of the following'):
            return line
    return ''


def invalidated_lines(criterion):
    failures = [f for f in criterion.get('failures') or [] if isinstance(f, dict)]
    states = []
    for f in failures:
        s = str(f.get('state', '?'))
        if s not in states:
            states.append(s)
    pages = ', '.join(code(s) for s in states[:MAX_STATES])
    if len(states) > MAX_STATES:
        pages += f' et {len(states) - MAX_STATES} autre(s)'
    lines = [f'- **Critère {plain(criterion.get("id", "?"))}** : {len(failures)} élément(s) en échec'
             + (f' sur {pages}' if pages else '')]
    seen = set()
    shown = 0
    for f in failures:
        key = (f.get('target'), f.get('check'))
        if key in seen:
            continue
        seen.add(key)
        if shown == MAX_ELEMENTS:
            lines.append(f'  - … {len({(x.get("target"), x.get("check")) for x in failures}) - MAX_ELEMENTS}'
                         ' autre(s) élément(s), voir `rgaa-report.json`')
            break
        detail = plain(first_line(f.get('message', '')))
        lines.append(f'  - {code(f.get("target", "?"))} ({code(f.get("check", "?"))})'
                     + (f' : {detail}' if detail else ''))
        shown += 1
    return lines


def changes(report, previous):
    now = {str(c.get('id')): status(c) for c in report['criteria']}
    before = {str(c.get('id')): status(c) for c in previous['criteria']}
    rows = []
    for cid in sorted(set(now) | set(before), key=criterion_key):
        old, new = before.get(cid), now.get(cid)
        if old == new:
            continue
        label = lambda s: STATUS_LABELS.get(s, 'hors périmètre') if s else 'hors périmètre'
        rows.append(f'- Critère {plain(cid)} : {label(old)} → {label(new)}')
    return rows


def section(report, previous, previous_tag=''):
    if report is None:
        return [HEADING, '',
                "Rapport RGAA indisponible pour cette release (la porte `rgaa` n'a pas produit de "
                '`report.json`) : voir les logs du job `rgaa` de la promotion.']
    rate = report['rate']
    validated, invalidated = int(rate.get('validated', 0)), int(rate.get('invalidated', 0))
    to_review = int(rate.get('to_review', 0))
    value, minimum = rate.get('value'), rate.get('min')
    lines = [HEADING, '']
    if validated + invalidated:
        lines.append(f'- Taux de conformité mesuré en CI : **{value} %** ({validated} critère(s) validé(s) '
                     f'sur {validated + invalidated} décidé(s) automatiquement ; seuil de la porte : {minimum} %).')
    else:
        lines.append('- Taux de conformité mesuré en CI : aucun critère décidé automatiquement.')
    lines.append(f'- Critères à vérifier manuellement : {to_review}.')
    states = [s for s in report.get('states') or [] if isinstance(s, dict)]
    if states:
        reached = sum(1 for s in states if s.get('reached'))
        lines.append(f'- Pages testées : {reached} sur {len(states)}.')
    lines.append('- Ce taux ne vaut pas audit : seuls les critères vérifiables automatiquement sont '
                 'comptés, le rapport complet est joint (`rgaa-report.json`).')

    failing = sorted((c for c in report['criteria'] if isinstance(c, dict) and status(c) == 'invalidated'),
                     key=lambda c: criterion_key(c.get('id')))
    lines += ['', '### Critères non conformes', '']
    if failing:
        for c in failing:
            lines += invalidated_lines(c)
    else:
        lines.append('Aucun critère invalidé par les tests automatiques.')

    lines += ['', '### Évolution depuis la release précédente', '']
    if previous is None:
        lines.append('Première mesure : aucun rapport RGAA joint à la release précédente'
                     + (f' ({code(previous_tag)}).' if previous_tag else '.'))
    else:
        prev_rate = previous['rate'].get('value')
        lines.append(f'Taux précédent ({code(previous_tag) if previous_tag else "release précédente"}) : '
                     f'{prev_rate} % → {value} %.')
        rows = changes(report, previous)
        lines += [''] + rows if rows else ['', 'Aucun critère n\'a changé de statut.']
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--notes', required=True)
    parser.add_argument('--report', required=True)
    parser.add_argument('--previous', default='')
    parser.add_argument('--previous-tag', default='')
    parser.add_argument('--output', default='')
    args = parser.parse_args(argv)

    try:
        with open(args.notes, encoding='utf-8') as f:
            notes = f.read()
    except OSError:
        notes = ''
    report = load(args.report)
    if report is None:
        print(f'::warning title=RGAA::no usable RGAA report at {args.report}: the release says so')
    previous = load(args.previous)
    text = notes.rstrip('\n') + '\n\n' + '\n'.join(section(report, previous, args.previous_tag)) + '\n'

    output = args.output or args.notes
    # Atomic: a crash halfway leaves the notes as they were.
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(output)) or '.')
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(text)
    os.replace(tmp, output)
    return 0


if __name__ == '__main__':
    sys.exit(main())
