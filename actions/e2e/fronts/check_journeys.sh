#!/usr/bin/env bash
# Refuses a front without end-to-end journeys (MAIR-602 acceptance criteria): the prod promotion
# must fail, not pass silently, when `e2e_test.sh` or the Playwright specs of `e2e/` are missing.
set -euo pipefail

if [ ! -f ./e2e_test.sh ]; then
  echo "::error title=e2e::./e2e_test.sh is missing: the front has no end-to-end stack (MAIR-603)"
  exit 1
fi
if ! ls e2e/*.spec.ts >/dev/null 2>&1; then
  echo "::error title=e2e::no Playwright spec in e2e/: a front without journeys cannot be promoted to prod (MAIR-603)"
  exit 1
fi
echo "Journeys: $(ls e2e/*.spec.ts | tr '\n' ' ')"
