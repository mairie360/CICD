#!/bin/sh
# Command of the `gdpr-marker` service of a repo's marker stack (MAIR-290). The service runs a
# node:24 image and mounts:
#   ./cicd-repo/tests/gdpr -> /engine            (read-only)
#   ./gdpr-marker.yaml     -> /journey/gdpr-marker.yaml
#   ./gdpr-report          -> /report
# The engine is copied out of the mount before `npm ci`, so that no root-owned node_modules
# lands in the repo's cicd-repo/ on the host.
set -eu
[ -w "${HOME:-/nonexistent}" ] || export HOME=/tmp
mkdir -p /tmp/engine
tar -C /engine --exclude=./node_modules -cf - . | tar -C /tmp/engine -xf -
cd /tmp/engine
npm ci --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error
exec node marker/run.mjs "${GDPR_MARKER_JOURNEY:-/journey/gdpr-marker.yaml}" "${GDPR_MARKER_REPORT_DIR:-/report}"
