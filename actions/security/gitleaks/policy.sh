#!/usr/bin/env bash
# Writes the Gitleaks policy of a scan from a TRUSTED commit (MAIR-677), shared
# by actions/security/gitleaks and actions/security/gitleaks-binary.
#
#   policy.sh <pr-base> <default-branch> <out-dir> [default-config]
#
# A scanned commit must not choose the rules it is scanned with: a pull
# request adding a `.gitleaksignore` entry or an allowlist in `.gitleaks.toml`
# would otherwise silence its own secret. The policy is read from:
#   - <pr-base>, the base commit of a pull request (empty on a push);
#   - otherwise `origin/<default-branch>`;
#   - otherwise nothing: the default config, an empty ignore list.
# Writes <out-dir>/.gitleaksignore (always, maybe empty) and
# <out-dir>/gitleaks.toml (the trusted `.gitleaks.toml`, else a copy of
# [default-config]; absent when neither exists, i.e. Gitleaks' built-in
# rules). Prints the trusted commit, or nothing. The scan must then run on a
# clone without a working tree (`git clone --mirror`): Gitleaks loads a
# `.gitleaksignore` found in the scanned directory whatever its flags say.
set -euo pipefail

base="${1:-}"
default_branch="${2:-}"
out="${3:?usage: policy.sh <pr-base> <default-branch> <out-dir> [default-config]}"
default_config="${4:-}"
mkdir -p "$out"

trusted=""
if [ -n "$base" ] && git cat-file -e "$base^{commit}" 2>/dev/null; then
  trusted=$(git rev-parse "$base^{commit}")
elif [ -n "$default_branch" ] && git rev-parse -q --verify "refs/remotes/origin/$default_branch^{commit}" >/dev/null; then
  trusted=$(git rev-parse "refs/remotes/origin/$default_branch^{commit}")
fi

: > "$out/.gitleaksignore"
rm -f "$out/gitleaks.toml"
if [ -n "$trusted" ]; then
  git show "$trusted:.gitleaksignore" > "$out/.gitleaksignore" 2>/dev/null || : > "$out/.gitleaksignore"
  git show "$trusted:.gitleaks.toml" > "$out/gitleaks.toml" 2>/dev/null || rm -f "$out/gitleaks.toml"
fi
if [ ! -f "$out/gitleaks.toml" ] && [ -n "$default_config" ]; then
  cp "$default_config" "$out/gitleaks.toml"
fi
echo "$trusted"
