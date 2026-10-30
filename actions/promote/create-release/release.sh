#!/usr/bin/env bash
# Tags SHA as v$VERSION (git push) and creates the GitHub release of that tag (MAIR-494).
# Env: VERSION, SHA, NOTES, GITHUB_REPOSITORY, GH_TOKEN (release), PUSH_TOKEN (release app token
# with `workflows: write`, for the tag). Run inside the repository's checkout.
set -euo pipefail
tag="v$VERSION"
: "${PUSH_TOKEN:?the release app token is required to push the tag}"

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
  # The empty value drops the checkout's GITHUB_TOKEN header, then the app token replaces it.
  auth=$(printf 'x-access-token:%s' "$PUSH_TOKEN" | base64 -w0)
  echo "::add-mask::$auth"
  git -c http.https://github.com/.extraheader= -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $auth" \
    push --quiet origin "refs/tags/$tag"
  echo "$tag pushed on ${SHA::7}"
fi

if gh release view "$tag" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  echo "release $tag already exists"
else
  gh release create "$tag" --repo "$GITHUB_REPOSITORY" --verify-tag --title "$tag" --notes-file "$NOTES"
fi
