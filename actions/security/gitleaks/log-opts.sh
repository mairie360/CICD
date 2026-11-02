#!/usr/bin/env bash
# Prints the `git log` range Gitleaks must scan (MAIR-677), shared by
# actions/security/gitleaks and actions/security/gitleaks-binary.
#
#   log-opts.sh <base> <sha> <default-branch>
#
# <base> is the pull request base or the push's `before` commit. When it is
# missing, all zeros (new branch) or no longer fetched (force-push, history
# rewrite), the scan never falls back to the tip alone, which let a secret
# added in an earlier commit of the push through:
#   - commits not on the default branch: `origin/<default>..<sha>`;
#   - none (the default branch itself was rewritten or pushed fresh): the
#     whole history of <sha>, i.e. fail closed.
# Needs a full clone (`fetch-depth: 0`), like the actions themselves.
set -euo pipefail

base="${1:-}"
sha="${2:?usage: log-opts.sh <base> <sha> <default-branch>}"
default_branch="${3:-}"
zero=0000000000000000000000000000000000000000

if [ -n "$base" ] && [ "$base" != "$zero" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then
  echo "$base..$sha"
  exit 0
fi

ref="refs/remotes/origin/$default_branch"
if [ -n "$default_branch" ] && git rev-parse -q --verify "$ref^{commit}" >/dev/null \
  && [ "$(git rev-list --count "$ref..$sha")" -gt 0 ]; then
  echo "$ref..$sha"
  exit 0
fi

echo "$sha"
