#!/bin/sh
# Command of the runner service of a consumer's accessibility stack (MAIR-317). The service runs
# the image named in runner-image and mounts:
#   ./cicd-repo/tests/a11y -> /engine   (read-only)
#   ./rgaa.yaml            -> /scope/rgaa.yaml
#   ./rgaa-report          -> /report
# The engine is copied out of the mount before `npm ci`: the container runs as root, and a
# node_modules written into the consumer's cicd-repo/ would be root-owned on the host.
set -eu
mkdir -p /tmp/engine
tar -C /engine --exclude=./node_modules -cf - . | tar -C /tmp/engine -xf -
cd /tmp/engine
npm ci --no-audit --no-fund --no-update-notifier --loglevel=error
exec node run.mjs "${RGAA_SCOPE:-/scope/rgaa.yaml}" "${RGAA_REPORT_DIR:-/report}"
