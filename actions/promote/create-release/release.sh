#!/usr/bin/env bash
# Tags SHA as v$VERSION (git push) and creates the GitHub release of that tag (MAIR-494).
# Env: VERSION, SHA, NOTES, GITHUB_REPOSITORY, GH_TOKEN. Run inside the repository's checkout.
set -euo pipefail
tag="v$VERSION"

git fetch --quiet --no-tags origin "+refs/tags/$tag:refs/tags/$tag" 2>/dev/null || true
if target=$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}"); then
  # A rerun after a failure further down: the tag must already point to this commit.
  if [ "$target" != "$SHA" ]; then
    echo "::error::$tag already exists on ${target::7}, not on ${SHA::7}"
    exit 1
  fi
  echo "$tag already on ${SHA::7}"
else
  git tag "$tag" "$SHA"
  git push --quiet origin "refs/tags/$tag"
  echo "$tag pushed on ${SHA::7}"
fi

if gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  echo "release $tag already exists"
else
  gh release create "$tag" --repo "$GITHUB_REPOSITORY" --verify-tag --title "$tag" --notes-file "$NOTES"
fi
