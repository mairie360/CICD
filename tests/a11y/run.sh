#!/bin/sh
# Command of the runner service of a consumer's accessibility stack (MAIR-317). The service runs
# the image named in runner-image and mounts:
#   ./cicd-repo/tests/a11y -> /engine   (read-write: dependencies are installed there)
#   ./rgaa.yaml            -> /scope/rgaa.yaml
#   ./rgaa-report          -> /report
set -eu
cd /engine
npm ci --no-audit --no-fund --no-update-notifier --loglevel=error
exec node run.mjs "${RGAA_SCOPE:-/scope/rgaa.yaml}" "${RGAA_REPORT_DIR:-/report}"
