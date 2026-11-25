"""Fits the release notes into the body of a GitHub release.

GitHub refuses a release body over 125 000 characters (HTTP 422 "body is too long"). A release
that follows many breaking changes carries their whole commit bodies in semantic-release's notes
and can pass it: the tag is pushed, the release is not created. When the notes are too long, the
changelog is cut at a line boundary and a link to the commits of the tag replaces the rest; the
`## Accessibilité (RGAA)` section, written last, is kept whole.

Usage: fit_notes.py <notes file> <tag> <owner/repo>  (rewrites the file in place)
"""
import sys

LIMIT = 125_000
# Headroom for the characters GitHub may count differently (line endings, astral symbols).
BUDGET = LIMIT - 1_000
KEPT_SECTION = '## Accessibilité (RGAA)'


def fit(text, tag, repository, budget=BUDGET):
    if len(text) <= budget:
        return text
    head, sep, kept = text.partition('\n' + KEPT_SECTION)
    tail = sep + kept if sep else ''
    note = ('\n\n_The notes were cut to fit the size limit of a GitHub release: see every commit of '
            f'{tag} at https://github.com/{repository}/commits/{tag}_\n')
    room = budget - len(tail) - len(note)
    if room <= 0:
        # The kept section alone is too long: cut everything as one block.
        head, tail, room = text, '', budget - len(note)
    cut = head[:room]
    if '\n' in cut:
        cut = cut[:cut.rindex('\n')]
    return cut.rstrip() + note + tail


def main(argv):
    path, tag, repository = argv
    with open(path, encoding='utf-8') as f:
        text = f.read()
    fitted = fit(text, tag, repository)
    if fitted != text:
        print(f'::warning title=Release notes::{len(text)} characters, cut to {len(fitted)} to fit a GitHub release')
        with open(path, 'w', encoding='utf-8') as f:
            f.write(fitted)


if __name__ == '__main__':
    main(sys.argv[1:])
