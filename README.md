# CICD

Centralized CI/CD of the Mairie360 org: reusable GitHub workflows (`.github/workflows/*_cicd.yml`),
the composite actions they call (`actions/<type>/<stack>`), and the test files shared by every service (`tests/`).

Each application repo calls one reusable workflow and pins a release of this repo with
`cicd_version`:

```yaml
jobs:
  ci:
    uses: mairie360/CICD/.github/workflows/BFFs-cicd.yml@v2.3.0
    with:
      cicd_version: v2.3.0
      package_name: bff-user
    secrets: inherit
```

The jobs that need something from this repo check it out at that same `cicd_version` into
`cicd-repo/` at the root of the consumer checkout.

## Composite actions (`actions/`, MAIR-493)

The steps of every job live in composite actions sorted by check type, then by stack:

| Folder | Content | Stacks |
| --- | --- | --- |
| `actions/dependencies/<stack>` | toolchain setup, install, dependency audit where the stack runs one (`audit: 'true'` for the BFF / front `security_audit` jobs) | `apis`, `bffs`, `fronts`, `back-lib`, `bffs-lib`, `front-lib` |
| `actions/lint/<stack>` | lint command | `apis`, `bffs`, `fronts`, `back-lib`, `bffs-lib`, `front-lib` |
| `actions/build/<stack>` | build and its artifacts | `apis`, `bffs`, `fronts`, `back-lib`, `bffs-lib`, `front-lib` |
| `actions/unit-tests/<stack>` | tests and the Codecov upload | `apis`, `bffs`, `fronts`, `back-lib`, `bffs-lib`, `front-lib`, `db` |
| `actions/integration/<stack>` | integration tests against the dev image (`bffs` replays the repo's newman collection, MAIR-262: junit summary in the job summary + `newman-report-<package_name>` artifact); `container-logs` is the log dump shared by every job that starts a Docker stack; `frontend-isolated-qa` holds `target.py` of `frontend-isolated-qa.yml` | `apis`, `bffs`, `fronts` |
| `actions/security/<stack>` | stack-specific security check: OWASP ZAP (`apis`, `bffs`, `fronts`), `cargo audit` + `cargo deny` (`back-lib`), npm audit + typecheck (`front-lib`) | `apis`, `bffs`, `fronts`, `back-lib`, `front-lib` |
| `actions/security/semgrep`, `actions/security/gitleaks` | cross-stack SAST and secret scan (pinned Docker images), `security_sast` job of every workflow but the fronts' | all but `fronts` |
| `actions/security/semgrep-pypi`, `actions/security/gitleaks-binary` | the same scans from the hash-checked Semgrep wheel and Gitleaks release binary (no Docker Hub pull); `frontend-cicd.yml`, `frontend-dev-exception.yml` and this repo's `lint.yml` | `fronts` |
| `actions/performance/<stack>` | k6 load test (`apis`, `bffs`, `fronts`), schema bench (`db`) | `apis`, `bffs`, `fronts`, `db` |
| `actions/e2e/<stack>` | Playwright user journeys of a front on its `docker-compose-e2e.yml` stack, prod gate of `promote-prod.yml` (MAIR-602) | `fronts` |
| `actions/release/` | `docker-release`, `semantic-tag`, `publish-openapi-rust`, `publish-openapi-typescript`, `release-folder` (database), `docker-manual-build`, `frontend-dev-exception` (`check_policy.py` of `frontend-dev-exception.yml`) | — |
| `actions/promote/` | `resolve` (commit promoted and its checks), `next-version` (semantic-release dry run on a commit behind main's tip), used by `promote-staging.yml` / `promote-prod.yml` (MAIR-494) | — |
| `actions/notify/cicd-failure` | n8n notification of a failed run | all |

A job therefore reads as: checkout, checkout of this repo into `cicd-repo/`, then
`uses: ./cicd-repo/actions/<type>/<stack>`. Secrets are passed to the actions as inputs, and the
step timeouts stay on the workflow steps (a composite step cannot take `timeout-minutes`). The
jobs that did not use this repo before MAIR-493 only check out `actions/`
(`sparse-checkout: actions`), so that the consumer's tools (`eslint .`, jest, cargo, Docker build
contexts) never see this repo's files.

## Semgrep SAST (`actions/security/semgrep`)

Every stack workflow has a `security_sast` job ("Code Security Audit (Semgrep, Gitleaks)") that calls the
`security/semgrep` composite action. The action runs a pinned image
(`semgrep/semgrep:<version>@sha256:<digest>`, input `image`), writes a SARIF report and uploads
it as the `semgrep-sarif` workflow artifact. Its verdict comes from the Semgrep exit code: findings
fail the job when `fail_on_findings` is `true`, and only raise a warning annotation when it is
`false`. A Semgrep crash always fails the job. The `build` job (`release-dev` for the database, the
publish jobs for front libs) waits for it.

| Workflow | Default rulesets (`semgrep_config`) | Blocking by default (`semgrep_fail_on_findings`) |
| --- | --- | --- |
| `BFFs-cicd.yml` | `p/typescript p/owasp-top-ten p/nodejs p/expressjs p/secrets p/dockerfile p/github-actions cicd-repo/tests/semgrep/gdpr` | yes |
| `APIs_cicd.yml` | `p/rust p/secrets p/dockerfile p/github-actions cicd-repo/tests/semgrep/gdpr` | yes (since MAIR-416) |
| `back-lib-cicd.yml` | `p/rust p/secrets p/github-actions cicd-repo/tests/semgrep/gdpr` | no, report-only |
| `frontend-cicd.yml` | `p/typescript p/react p/owasp-top-ten p/secrets p/dockerfile p/github-actions cicd-repo/tests/semgrep/gdpr` | yes (since MAIR-416) |
| `front-libs-cicd.yml` | `p/typescript p/react p/secrets p/github-actions cicd-repo/tests/semgrep/gdpr` | no, report-only |
| `bffs-lib-cicd.yml` | `p/typescript p/nodejs p/expressjs p/secrets p/github-actions cicd-repo/tests/semgrep/gdpr` | no, report-only |
| `database_cicd.yml` | `p/secrets p/dockerfile p/github-actions cicd-repo/tests/semgrep/gdpr` | yes (since MAIR-416) |

`cicd-repo/tests/semgrep/gdpr` holds the GDPR rules of MAIR-291 (one file per language, each
tested by `semgrep --test` against the file of the same name in the `semgrep-rules` job of
`lint.yml`): `gdpr-rust-log-personal-value` and `gdpr-ts-log-personal-value` (a logging call that
prints an `email`, `password`, `token`, `accessToken`, `refreshToken` or request `body` value),
`gdpr-sql-whole-row-json` (`to_jsonb(OLD|NEW)` / `row_to_json` without removing the columns the
inventory marks `audit_log: false`). `gdpr-rust-redis-write-without-ttl` and `gdpr-ts-redis-write-without-ttl` (MAIR-499):
a Redis write without expiry (`SET` without `EX`/`PX`, `set` / `hset` / `mset` on a Redis client):
the APIs use `set_ex` of `mairie360_api_lib`, the BFFs `createTtlRedis` of `@mairie360/bffs-lib`. A consumer that overrides `semgrep_config` adds the folder to
its list to keep them. A false positive gets `// nosemgrep: <rule id>` with the reason.

The Semgrep registry has no SQL/PostgreSQL ruleset (`p/sql` and `p/postgres` do not exist), and
`p/nextjs` is currently empty, so neither is used.

A consumer repo can override both inputs:

```yaml
jobs:
  ci:
    uses: mairie360/CICD/.github/workflows/APIs_cicd.yml@vX.Y.Z
    with:
      cicd_version: vX.Y.Z
      semgrep_fail_on_findings: false          # temporary opt-out while the findings are triaged
      semgrep_config: "p/rust p/secrets"       # optional, replaces the default list
    secrets: inherit
```

**Rollout.** Every stack that ships an image (APIs, BFFs, fronts, database) blocks on findings by
default since MAIR-416; the libraries are still report-only. The scan already finds issues on
`main` in many repos (for example Dockerfiles without `USER`, consumer workflows using
`secrets: inherit`, third-party actions pinned by tag). Fix each finding, or justify it with an
inline `# nosemgrep: <rule-id>` comment that says why. A repo that cannot be cleaned before it bumps
`cicd_version` sets `semgrep_fail_on_findings: false` explicitly, and removes it once clean.

**Code scanning.** The action can also upload the SARIF to GitHub code scanning
(`upload_sarif: 'true'`), but the reusable workflows keep it off. That job would need
`security-events: write`, and a reusable workflow job cannot ask for more than its caller grants.
Every consumer `cicd.yml` sets a top-level `permissions:` block without it, so asking for it would
make those callers fail at startup. To enable it, grant `security-events: write` in the consumer
callers first, then turn the upload on in the workflows.

**Bumping Semgrep.** Update the `image` default in `actions/security/semgrep/action.yml`, and update the
version tag and the digest together. The digest is the one of the multi-arch tag
(`docker buildx imagetools inspect semgrep/semgrep:<version>`).

## Gitleaks (`actions/security/gitleaks`)

The `security_sast` job of every workflow also runs Gitleaks (pinned
`zricethezav/gitleaks:<version>@sha256:<digest>` image, not the `gitleaks-action`, which needs a
paid license on organizations). It only scans the commits the run adds: `base..head` of a pull
request, `before..after` of a push. When that base is unknown (new branch, force-push, history
rewrite), it scans every commit not on the default branch, or the whole history when there is
none (`actions/security/gitleaks/log-opts.sh`, MAIR-677): never the tip alone, which let a secret
added in an earlier commit of the push through. Inline `gitleaks:allow` comments are ignored
(`--ignore-gitleaks-allow`). A secret already in the
history therefore does not fail every later build: rotate it first, then add its fingerprint to a
`.gitleaksignore` at the root of the repo. The job checks the repo out with `fetch-depth: 0`.

`.gitleaksignore` and `.gitleaks.toml` are read from the pull request's base, or from the default
branch on a push to another branch (the commit before the push on a push to the default branch),
never from the scanned commits (`actions/security/gitleaks/policy.sh`, MAIR-677),
and the scan runs on a `git clone --mirror` of the checkout, where Gitleaks finds no working-tree
file to load: a pull request cannot allowlist its own secret. A change to either file applies once
it is merged.

Without a `.gitleaks.toml` in the repo, Gitleaks runs with `actions/security/gitleaks/gitleaks.toml`:
the built-in rules plus allowlists for known test values. Today it only allows the
`jwt_secret:` line of `rgaa.yaml` (the test-stack secret of the RGAA engine); any other secret
in that file, or a `jwt_secret` elsewhere, is still reported. A repo that adds its own
`.gitleaks.toml` replaces this default and must copy the allowlists it still needs.

## Image release (`actions/release/docker-release`, MAIR-416)

`APIs_cicd.yml`, `BFFs-cicd.yml`, `frontend-cicd.yml` and `database_cicd.yml` release their images
through the same action:

| Stage | What happens | Tags written |
| --- | --- | --- |
| `dev` | single build with an SBOM and a `mode=max` provenance attestation, push as `dev-<sha>` only, Trivy scan of that digest, cosign keyless signature, then the mobile tag | `dev-<sha>`, `dev` |
| `staging` | resolves the digest of `dev-<sha>` (the promoted commit, `source_sha`, never the mobile `dev`), checks it equals the digest `resolve` read, verifies the cosign signature, re-tags that digest | `staging-<sha>`, `staging` |
| `prod` | same from `staging-<sha>`, only when a version is released | `<version>`, `latest` |

`dev` runs in the main pipeline of the four stack workflows; `staging` and `prod` run in
`promote-staging.yml` / `promote-prod.yml` (see the next section).

Re-tagging uses `docker buildx imagetools create`, which copies the manifest index server side: the
digest, and so the signature, SBOM and provenance attached to it, are the same in every
environment. The mobile tags (`dev`, `staging`, `latest`) are only written for humans and Argo CD,
never read by the pipeline, so an approval that waits for hours still promotes the image of its
own commit, the one ZAP and k6 tested.

**Trivy.** Pinned `aquasec/trivy:<version>@sha256:<digest>` image (input `trivy_image`), not
`aquasecurity/trivy-action`, whose tags were rewritten during the March 2026 compromise. Fixable
`HIGH`/`CRITICAL` vulnerabilities fail the `release-dev` job: the image keeps its `dev-<sha>` tag
but never gets `dev` and is never promoted. Accept a risk with a `.trivyignore` at the root of the
repo (one CVE id per line, with a comment saying why and until when); opt out temporarily with
`image_scan_fail_on_findings: false`.

**Signature.** `cosign sign` uses the GitHub OIDC token of `release-dev`, so that job needs
`id-token: write`, and the consumer caller must grant it (see the migration below). Check an image
by hand with:

```bash
cosign verify ghcr.io/mairie360/<package>:<tag> \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-identity-regexp '^https://github\.com/mairie360/CICD/\.github/workflows/'
```

### Migrating a consumer to the MAIR-416 release

- **Every image repo:** add `id-token: write` to the `permissions:` block of `.github/workflows/cicd.yml`
  (fronts already have it). Without it the run fails at startup.
- **Fronts:** the npm token is now a BuildKit secret. Replace `ARG NODE_AUTH_TOKEN` and the
  `.npmrc` written from it with
  `RUN --mount=type=secret,id=node_auth_token,env=NODE_AUTH_TOKEN …` (same as the BFFs). A front
  must also define an `npm test` script (`--if-present` is gone).
- **Database:** the mobile tags are now `dev` / `staging` instead of `dev-latest` /
  `staging-latest`.
- **APIs, fronts, database:** Semgrep and Trivy now block; set `semgrep_fail_on_findings: false` /
  `image_scan_fail_on_findings: false`, or add a `.trivyignore`, while the findings are fixed.

## Promotion to staging and prod (`promote-staging.yml`, `promote-prod.yml`, MAIR-494)

A push to `main` only runs the checks and `release-dev`: every commit of `main` reaches dev, and
nothing waits on an approval any more. Staging and prod are manual runs of each service repo, one
workflow per environment, each calling a reusable workflow of this repo. No image is rebuilt: the
`dev-<sha>` digest the main pipeline built and signed is tagged `staging-<sha>`, then
`<version>` / `latest`.

| | `promote-staging.yml` | `promote-prod.yml` |
| --- | --- | --- |
| Commit | `sha` input, else main's newest commit (release journal / `[skip ci]` commits left out) | `sha` input, else main's newest commit released on staging |
| Refused unless | `dev-<sha>` exists (both images for the database) and the main run of the commit has a green `release-dev` and no failed job | `staging-<sha>` exists |
| Gates | integration tests (APIs; BFFs since MAIR-262, newman collection), ZAP and k6 (APIs, BFFs, fronts) on `<image>:dev-<sha>` | Liquibase release folder and GDPR inventory (database, MAIR-491, MAIR-285); end-to-end journeys (fronts, MAIR-602) on `<image>:staging-<sha>`; RGPD / RGAA plug in here (MAIR-604, MAIR-317/319) |
| Environment | `Staging` | `Prod` |
| Publishes | `staging-<sha>` / `staging`, `@mairie360/<name>-openapi@0.0.0-staging.<sha>` (APIs: 7 chars, BFFs: 40) | git tag `v<version>` + GitHub release on the commit, `<version>` / `latest`, OpenAPI `<version>` |

Prod computes the version with a semantic-release dry run on the promoted commit, which is usually
behind main's tip (Renovate keeps merging): `actions/promote/next-version` pushes the commit as
`main` to a local bare mirror and points the repository URL at it (`url.<mirror>.insteadOf`), so
semantic-release reads the tags and checks the branch there, and the release notes keep the real
repository links. The tag and the release are then created through the API on that commit. A run
with nothing to release (only `chore` / `ci` / `docs` commits since the last tag) stops after
`version`, with a notice.

Both runs take a lock per repo and target (`concurrency: promote-<repo>-<target>`, in the caller),
and only run on `main`. The commits a promotion creates (the release journal) carry `[skip ci]`;
the tag and the release, created with the run's `GITHUB_TOKEN`, start no workflow
(`actions/promote/resolve/tests` checks both).

Caller (`.github/workflows/promote-staging.yml`; `promote-prod.yml` is the same with `prod`,
`contents: write` and without `ci_workflow` / `npm_scope`):

```yaml
name: Promote to Staging

on:
  workflow_dispatch:
    inputs:
      sha:
        description: "Commit of main to promote (empty: main's newest commit)"
        required: false
        type: string

permissions:
  contents: read

concurrency:
  group: promote-${{ github.repository }}-staging
  cancel-in-progress: false

jobs:
  promote:
    permissions:
      contents: read
      packages: write
      actions: read
    uses: mairie360/CICD/.github/workflows/promote-staging.yml@v4.4.0
    with:
      stack: apis            # apis | bffs | fronts | database
      package_name: core-api
      cicd_version: v4.4.0
      sha: ${{ inputs.sha }}
    secrets:
      N8N_WEBHOOK_SECRET: ${{ secrets.N8N_WEBHOOK_SECRET }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      RELEASE_APP_ID: ${{ secrets.RELEASE_APP_ID }}
      RELEASE_APP_PK: ${{ secrets.RELEASE_APP_PK }}
```

BFFs also pass `openapi_spec_path` (the committed contract, same value as in `cicd.yml`). Run it
with `gh workflow run promote-staging.yml -R mairie360/<repo> [-f sha=<sha>]`.

### BFF integration gate (MAIR-262)

The `integration_tests` job of `promote-staging.yml` runs for the APIs and the BFFs. A BFF repo
provides an `integration_test.sh` of the same shape as its `security_test.sh` (builds
`bff-<name>:local` from `development.Dockerfile` when `IMAGE_REF` is empty, needs `.npmrc` +
`NODE_AUTH_TOKEN` for the `@mairie360/*` packages, sources `stack_secrets.sh`) driving a
`docker-compose-integration.yml` whose `newman` service replays the repo's collection against the
BFF with `--bail` and writes the junit report to `newman-reports/newman.xml` (relative to the
repo root, the script creates the folder). The script's exit code is newman's. The action
(`actions/integration/bffs`: `image_ref`, `npm_scope`, `github_token`) logs in to GHCR, writes
the build `.npmrc`, runs the script with `IMAGE_REF=<image>:dev-<sha>`, then, whatever the
outcome, summarizes the report in the job summary (total / passed / failed, the failed
assertions with their request and message, or a note when the file is missing) and uploads
`newman-reports/` as the `newman-report-<package_name>` artifact (14 days). The job has no step
timeout (the stacks pull the database and several API images) and a 40 min job timeout.

**Non-regression:** a BFF whose collection fails (an upstream contract field renamed, a status
code changed, a route gone) fails `integration_tests`, and `promote` is not run: the commit
stays on dev until the collection or the BFF is fixed, exactly like a ZAP or k6 failure.

### GDPR inventory gate (`actions/promote/gdpr-inventory`, MAIR-285)

`promote-prod.yml` runs a `gdpr_inventory` job for the database (`stack: database`), between
`version` and `promote`. It migrates an empty database with the staging images of the promoted commit and compares the columns with
the repo's `gdpr/inventory.yaml`, which classifies every column of the `public` tables (personal
or not, category, fate on erasure, visibility, audit log exclusion). A column missing from the
inventory, an entry naming a column that no longer exists, or a column referencing `users` not
classified as an `identifier` stops the prod release.

The job summary, shown before the Prod approval, holds:

- the gaps, if any;
- the inventory changes since the last release tag: **review them before approving Prod**;
- for each unclassified column, a classification proposed by Claude (`gdpr_ai_model`, default
  `claude-sonnet-5-5`, only with the `ANTHROPIC_API_KEY` secret), as YAML to review and paste into
  the inventory in a PR. The proposals never decide the gate.

The Database repo's `promote-prod.yml` already passes `ANTHROPIC_API_KEY` (optional: AI proposals);
`ANTHROPIC_WORKSPACE_ID` is only needed for a key that is not scoped to a workspace.

Run the check by hand on a migrated database:

```bash
cd tests/gdpr && npm ci
psql -At -q -d core -f schema.sql > /tmp/schema.json
node check.mjs ../../../Database/gdpr/inventory.yaml /tmp/schema.json /tmp/gdpr-report
```

### GDPR log marker (`actions/promote/gdpr-marker`, MAIR-290)

`promote-prod.yml` runs a `gdpr_marker` job for the APIs and the BFFs, between `version` and
`promote`, on the staging image of the promoted commit (by digest), so its summary is read before
the Prod approval. A runner creates a **marker user** with unique values (e-mail, first and last name,
phone, password), plays the journey the repo declares, deliberate errors included, and the logs of
**every container** of the stack are then searched for those values: raw, URL-encoded,
JSON-escaped, in base64, the phone also as the national number the database stores, plus the
values the journey captures as `sensitive` (tokens). One line found fails the job. Rule: a log
describes an error by its type and context, never by the value it received.

The job summary lists the leaks per service (values masked), the journey with each status, the
marker fields the journey never sends (so not tested) and the services left out with their
reason. The `gdpr-marker` artifact holds the same report; the raw logs never leave the runner.
The job is skipped with a warning while the repo has no `gdpr-marker.yaml`.

#### Wiring an API or a BFF

Three files at the root of the repo.

**`gdpr-marker.yaml`**: the journey. Placeholders: `{{marker.email}}`, `{{marker.first_name}}`,
`{{marker.last_name}}`, `{{marker.phone}}` (French mobile, `06…`), `{{marker.password}}`,
`{{env.NAME}}` for the variables listed in `env` (passed to the runner by the compose file), and
the captures of earlier steps. `expect` defaults to any 2xx; list the codes of the deliberate
errors. A capture comes from `body.<path>`, `header.<name>` or `cookie.<name>`; mark tokens
`sensitive: true` so that they are searched too (a captured `Authorization: Bearer <jwt>` header
is also searched for the JWT alone). Put the values in query strings and in bodies of the wrong
type too: a request logger that prints the URL, or an error that quotes the refused value, leaks
them. The journey stops at the first step that does not
answer as expected (the logs then prove nothing).

```yaml
version: 1
target: http://core:3000        # the service under test, inside the stack
wait: /ready                    # polled until it answers below 400 (3 min)
env: [ADMIN_JWT]
ignore:                         # services allowed to hold the marker, with the reason
  - service: mailpit
    reason: SMTP sink of the stack, it receives the marker's e-mails by design
steps:
  - name: register the marker
    request:
      method: POST
      path: /api/v1/auth/register
      json: {email: "{{marker.email}}", password: "{{marker.password}}", first_name: "{{marker.first_name}}", last_name: "{{marker.last_name}}", phone: "{{marker.phone}}"}
    expect: [201]
  - name: register the same e-mail again (deliberate error)
    request: {method: POST, path: /api/v1/auth/register, json: {email: "{{marker.email}}", password: "{{marker.password}}", first_name: "{{marker.first_name}}", last_name: "{{marker.last_name}}"}}
    expect: [409]
  - name: log in with a wrong password (deliberate error)
    request: {method: POST, path: /api/v1/auth/login, json: {email: "{{marker.email}}", password: "x{{marker.password}}"}}
    expect: [401]
  - name: log in
    request: {method: POST, path: /api/v1/auth/login, json: {email: "{{marker.email}}", password: "{{marker.password}}"}}
    capture:
      token: {from: body.token, sensitive: true}
  - name: read the profile
    request: {method: GET, path: /api/v1/user/me, headers: {Authorization: "Bearer {{token}}"}}
```

**`docker-compose-gdpr-marker.yml`**: the security stack without ZAP (the service under test on
`${IMAGE_REF}`, its databases, seeders and upstreams), plus the runner:

```yaml
  gdpr-marker:
    image: node:24-bookworm-slim
    user: "${GDPR_UID:-0}:${GDPR_GID:-0}"
    depends_on:
      core-ready:
        condition: service_completed_successfully
    environment:
      ADMIN_JWT: ${ADMIN_JWT}           # only the variables listed in `env`
    volumes:
      - ./cicd-repo/tests/gdpr:/engine:ro
      - ./gdpr-marker.yaml:/journey/gdpr-marker.yaml:ro
      - ./gdpr-report:/report
    command: ["/engine/marker/run.sh"]
    networks:
      - backend
```

**`gdpr_marker_test.sh`**: starts the stack, waits for the runner, saves the logs of every
container **before** `down`, then scans them (plain Node, no dependency):

```bash
#!/usr/bin/env bash
# GDPR log marker test (MAIR-290). The CI exports IMAGE_REF (the image promoted to staging).
COMPOSE_FILE="docker-compose-gdpr-marker.yml"
REPORT_DIR="gdpr-report"

if [ -z "${IMAGE_REF:-}" ]; then
    IMAGE_REF="core-api:local"
    docker build -f development.Dockerfile -t "$IMAGE_REF" . || exit 1
fi
export IMAGE_REF
source ./stack_secrets.sh || exit 1   # APIs: random JWT_SECRET and ADMIN_JWT of the run

CICD_DIR="cicd-repo"
if [ ! -f "$CICD_DIR/tests/gdpr/marker/scan.mjs" ]; then
    CICD_VERSION="${CICD_VERSION:-$(sed -n 's/^[[:space:]]*cicd_version:[[:space:]]*\([^[:space:]#]*\).*/\1/p' .github/workflows/cicd.yml | head -n 1)}"
    rm -rf "$CICD_DIR"
    git clone --quiet --depth 1 --branch "$CICD_VERSION" https://github.com/mairie360/CICD "$CICD_DIR" || exit 1
fi

rm -rf "$REPORT_DIR" && mkdir -p "$REPORT_DIR"
trap 'docker compose -f "$COMPOSE_FILE" down -v >/dev/null 2>&1' EXIT   # also on timeout
docker compose -f "$COMPOSE_FILE" up -d
docker compose -f "$COMPOSE_FILE" wait gdpr-marker
docker compose -f "$COMPOSE_FILE" logs --no-color > "$REPORT_DIR/containers.log"
docker compose -f "$COMPOSE_FILE" logs --no-color --tail 30 gdpr-marker
docker compose -f "$COMPOSE_FILE" down -v

docker run --rm -v "$PWD/$REPORT_DIR:/report" -v "$PWD/$CICD_DIR/tests/gdpr:/engine:ro" \
    node:24-bookworm-slim node /engine/marker/scan.mjs /report
EXIT_CODE=$?
echo "Final exit code: $EXIT_CODE"
exit $EXIT_CODE
```

Add `/gdpr-report/` to `.gitignore` (and `gdpr-report`, `gdpr-marker.yaml`,
`gdpr_marker_test.sh` to `.dockerignore`). BFFs: the job writes the same build `.npmrc` as the ZAP
job, for stacks that build an image.

### GDPR contract (`actions/security/gdpr-contract`, MAIR-291)

`APIs_cicd.yml` and `BFFs-cicd.yml` run a `gdpr_contract` job on every event (APIs: after `lint`,
on `cargo open_api`; BFFs: after `build`, on the `openapi-spec` artifact). `release-dev` does not
need it, but promote-staging refuses a commit whose main run has a failed job.
It reads the personal data inventory of the database (`gdpr/inventory.yaml` of
mairie360/Database, input `gdpr_inventory_ref`, `main` by default) and walks every response schema
of the spec (`$ref`, `allOf`/`oneOf`/`anyOf`, arrays, maps): a field that carries a `credentials`
column (`users.password`, `sessions.token_hash`) fails the job. A field carries a column when it has
its name, or when the repo maps it in its decision file. Claude (`gdpr_ai_model`, secret
`ANTHROPIC_API_KEY`, optional) proposes a column for the other field names, cached by fingerprint
(field name, schemas, model) with `actions/cache`: the proposals fill the summary, a human writes
the mapping. The job summary also lists the allowed exceptions; `report.json` (artifact
`gdpr-contract`) adds, per operation, the personal columns its responses carry, the input of the
access matrix (MAIR-288).

**`gdpr-contract.yaml`** (optional, at the root of the repo): the decisions.

```yaml
version: 1
fields:                     # API field names that carry a column under another name
  phone: users.phone_number
allow:                      # credentials a response may carry, and why
  - operation: POST /api/v1/auth/login
    field: refresh_token
    reason: the client keeps its own refresh token, Core only stores its hash
```

Locally: `cd tests/gdpr && npm ci && node contract/check.mjs <openapi.json> <inventory.yaml> <report dir> [gdpr-contract.yaml]`
(`GDPR_AI=off` to skip the proposals, `GDPR_AI_CACHE=<file>` to keep them).

### End-to-end journeys of the fronts (`actions/e2e/fronts`, MAIR-602)

The prod promotion of a front (`stack: fronts`) runs its Playwright user journeys before the
release, in the `e2e_tests` job, next to the database's `release_folder`. The job logs in to GHCR,
checks out the promoted commit and runs the front's `./e2e_test.sh` with
`TARGET_IMAGE=<image>:staging-<sha>`: the image `resolve` checked on staging, never a rebuild. The
script starts the front's `docker-compose-e2e.yml` (database, APIs, BFFs at the tags pinned in
the file, the front image under test, and a `playwright` service that runs the specs of `e2e/`),
then tears it down. RGPD, RGAA and E2E are three independent gates: each has its own stack and
its own sessions (the journeys sign their seeded users in with the stack's shared `JWT_SECRET`).

The action refuses a front without `./e2e_test.sh` or without `e2e/*.spec.ts` (`check_journeys.sh`),
so a front cannot reach prod without journeys, and a failed journey blocks `promote`. It writes a
job summary from the `json` reporter (`summarize.py`: one line per journey) and uploads
`e2e-report/` (HTML report, traces and videos of the failed journeys, `e2e-report` artifact, 30
days). Tests: `python3 -m unittest discover -s actions/e2e/fronts/tests` (in `lint.yml`). What a
front must ship is described in the fronts' `CLAUDE.md` (MAIR-603): `e2e/` with its own
`package.json` pinning `@playwright/test` at the version of the `mcr.microsoft.com/playwright`
image of the compose file, `playwright.config.ts` reading `E2E_BASE_URL` / `E2E_REPORT_DIR`,
at least one nominal and one refusal journey, and `npm run e2e` for local iterations.

### Migrating a consumer to the promotion workflows (v4.4.0, MAIR-494)

- `cicd.yml`: bump the `uses:` ref and `cicd_version` to v4.4.0 or later. The main run now ends after
  `release-dev`; its `Staging` / `Prod` jobs are gone, and so are the BFF workflow outputs
  `release_published` / `release_version`.
- Add `promote-staging.yml` and `promote-prod.yml` as above, pinned to the same ref as `cicd.yml`,
  and add them to the Renovate custom manager of the repo, so one Renovate PR bumps the three files.
- Commits released by the v4 pipeline promote as is: `resolve` only needs their `dev-<sha>` (and a
  green `release-dev`; the `cancelled` Staging / Prod jobs of the old runs do not count as failures)
  or their `staging-<sha>`.

## GDPR PR checklist (`gdpr-pr-cicd.yml`, MAIR-295)

The organization pull request template (mairie360/.github) asks in its **Personal data** section
whether the PR touches personal data (`- [x] No` / `- [x] Yes` + an `Inventory:` line). The reusable
workflow fails the PR check when no answer or both are ticked, or when "Yes" comes without the
inventory: in Database, `gdpr/inventory.yaml` must change in the PR; elsewhere the `Inventory:`
line links the Database PR that updates it, or says why it does not change. Claude
(`gdpr_ai_model`, secret `ANTHROPIC_API_KEY`, optional) reads the diff (lock files and generated
contracts left out) with the inventory of mairie360/Database and, **without blocking**, warns in
the job summary and as an annotation when a PR answered "No" seems to touch personal data, or when
a "Yes" seems to need an inventory change. Reviews are cached by fingerprint (model, diff, answer)
with `actions/cache`, so editing the description does not ask again.

A repo opts in with its own workflow, so that ticking the answer (an `edited` event) re-runs it:

```yaml
# .github/workflows/gdpr-pr.yml
name: GDPR PR checklist
on:
  pull_request:
    types: [opened, edited, synchronize, reopened]
permissions:
  contents: read
jobs:
  gdpr:
    uses: mairie360/CICD/.github/workflows/gdpr-pr-cicd.yml@vX.Y.Z
    with:
      cicd_version: vX.Y.Z
      # Database only: inventory_path: gdpr/inventory.yaml
    secrets: inherit # nosemgrep: yaml.github-actions.security.secrets-inherit.secrets-inherit
```

## GDPR simulation (`actions/promote/gdpr-simulation`, MAIR-497)

`promote-prod.yml` runs a `gdpr_simulation` job for the APIs, the BFFs and the fronts, between `version` and
`promote`, on the staging image of the promoted commit (by digest), so its summary is read before
the Prod approval. It is skipped with a warning while the repo has
no `gdpr-simulation.yaml`. **Test stacks only**: the action exports `GDPR_SIMULATION=test-stack`,
and the engine refuses to run without it or when a target is not a host of the stack's network
(a compose service, `localhost`, a private address, `*.test`).

The run (`tests/gdpr/simulation/`):
1. `simulate.mjs` generates fictitious personas (unique values, like the marker of MAIR-290), plays
   the repo's journey (`gdpr-marker.yaml` format) for each of them, then the `erase` steps for the
   ones to erase, and writes `gdpr-simulation/personas.json`;
2. the repo's script then runs k6 once over every operation (`load-test.js`, errors included),
   back-dates rows (`back_date`), runs the purge, saves the logs of every container, dumps the
   schema (`tests/gdpr/schema.sql`) and runs the database checks `sql.mjs` writes (values of the
   erased personas outside the `keep` columns of the inventory, rows past their retention, a sample
   of the free-text and JSON columns). `sql.mjs` stops the run when a column of the stack is not in
   the inventory, since the checks would skip it; inventory entries the stack does not have yet are
   fine;
3. `analyze.mjs` is the gate. **Deterministic**: a persona value (or a captured token) in any log,
   browser console message or browser storage entry fails, and so does a Redis key without TTL,
   above the maximum TTL or outside the prefixes of the inventory's `redis` section (MAIR-499). The erasure and retention checks are
   reported as expected failures until the erasure exists (MAIR-289); `GDPR_SIMULATION_ERASURE=enforce`
   makes them block. **AI review** (`gdpr_simulation_ai_model`, `claude-haiku-5-5` by default,
   `ANTHROPIC_API_KEY`): the log lines grouped into templates (numbers, ids, dates, addresses
   replaced, persona values masked), the console, the storage and the database sample, each with a
   risk (`none` / `low` / `medium` / `high`), a justification and a fingerprint. Verdicts are cached
   by fingerprint and model (`actions/cache`), so two runs on the same code give the same verdicts.
   A `high` risk blocks unless the repo accepts it:

```yaml
# gdpr-accepted-risks.yaml
version: 1
risks:
  - fingerprint: 0123456789abcdef01234567   # from the job summary
    reason: the request id and the user id are needed to investigate an incident, kept 30 days
    date: 2026-10-08
    author: Quentintnrl
```

**`gdpr-simulation.yaml`**:

```yaml
version: 1
journey: gdpr-marker.yaml        # played for every persona
personas: 4
erased: 1                        # the last ones are erased after their journey
erase:                           # steps that erase a persona (captures of the journey available)
  - name: archive the persona
    request: {method: DELETE, path: "/api/v1/admin/users/{{user_id}}/", headers: {Authorization: "Bearer {{env.ADMIN_JWT}}"}}
ignore:                          # services allowed to hold the values, with the reason
  - service: mailpit
    reason: SMTP sink of the stack
```

**`gdpr_simulation_test.sh`** (outline): start the stack with a `gdpr-simulation` runner service
(`node:24`, mounts `cicd-repo/tests/gdpr`, `gdpr-simulation.yaml`, the journey and
`gdpr-simulation/`, passes `GDPR_SIMULATION`, runs `simulate.mjs`), wait for it, run k6 once, apply
the repo's back-dating SQL and `SELECT fn_apply_retention_policies();` on the stack's database, then

Every step below stops the run on failure (a skipped check must not pass as clean):

```bash
docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U postgres -d "$DB" -At -f - < cicd-repo/tests/gdpr/schema.sql > gdpr-simulation/schema.json || exit 1
node cicd-repo/tests/gdpr/simulation/sql.mjs "$INVENTORY" gdpr-simulation/schema.json gdpr-simulation || exit 1
for q in erasure retention content; do
  docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U postgres -d "$DB" -At -f - < "gdpr-simulation/db/$q.sql" > "gdpr-simulation/db/$q.sql.json" || exit 1
done
mkdir -p gdpr-simulation/redis
docker compose -f "$COMPOSE_FILE" exec -T redis sh -c 'set -e; keys="$(redis-cli --scan)"; printf "%s\n" "$keys" | while IFS= read -r k; do [ -n "$k" ] || continue; ttl="$(redis-cli TTL "$k")"; [ -n "$ttl" ] || exit 1; printf "%s\t%s\n" "$k" "$ttl"; done' > gdpr-simulation/redis/keys.tsv || exit 1
docker compose -f "$COMPOSE_FILE" logs --no-color > gdpr-simulation/containers.log || exit 1
docker compose -f "$COMPOSE_FILE" down -v --remove-orphans || exit 1
```

The action then runs `analyze.mjs`. Only the masked report (`summary.md`, `report.json`) is
uploaded.

**Fronts.** A front's journey goes through its own origin (the same-origin proxy the browser uses,
`Cookie: accessToken=…` and `Origin` headers), so the front's server logs see the persona values.
Its `gdpr-simulation.yaml` adds a `browser` section: after each persona's journey, and before its
`erase` steps, `simulate.mjs` opens these pages in a fresh Chromium context with the session
cookies, through `tests/gdpr/privacy` (MAIR-292), and writes `browser/console.json`,
`browser/storage.json` (a persona value there blocks, like in a log) and `browser/privacy.json`
(requests outside the front's origin, cookies, legal links: added to the summary, report-only).
A page whose status breaks its rule (by default a status of 400 or more; with `expect`, a status
outside that list, so `expect: [404]` passes on a 404), or ending on another origin or path after
its redirects (a login page answers 200 too), fails the run; a browser failure still lets
the persona's `erase` steps run. Console messages and storage values are searched whole; the
third-party request examples of the privacy findings are masked like the logs. A page waits for
`networkidle` by default; a front that keeps a stream open (Server-Sent Events) sets
`wait_until: load` (or `domcontentloaded`), and each page is then left 2 s for its client-side
requests.

```yaml
browser:
  target: http://projects-front:5001            # the front's origin on the stack
  cookies: {accessToken: "{{env.ADMIN_JWT}}"}  # session, set before each page
  allowed_origins:                              # optional, with the reason
    - {origin: "http://login-front.test", reason: login redirect of the stack}
  wait_until: networkidle                       # optional: load / domcontentloaded for a stream
  pages:                                        # journey captures, marker.<field>, env.<NAME>
    - {name: project, path: "/projects/{{project_id}}"}
    - {name: search, path: "/?q={{marker.last_name}}", expect: [200]}
```

The front's runner uses the Playwright image of `tests/gdpr/privacy/runner-image` instead of
`node:24` and installs the engine with its dev dependencies (`npm ci`, with
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`: the image holds the browsers of the pinned version).

**Telemetry (MAIR-501).** A stack that runs an OpenTelemetry collector adds a `file` exporter
writing OTLP JSON to `gdpr-simulation/traces.jsonl`, and the job that builds the usage ledger
writes it to `gdpr-simulation/usage.json`. Telemetry may only carry actions: a persona value in a
span or in the ledger blocks, and so does a span attribute that identifies the caller
(`enduser.*`, `user.*`, `user_id`, `session.id`, `http.request.header.authorization` / `cookie`,
`url.query`, a query string in `url.full` / `http.url` / `http.target`) or a ledger key that names a
person (`user_id`, `email`, `first_name`, `phone`, `ip`…). The span templates go through the AI
review like the log templates. Without these files, the summary lists them as not checked.

```yaml
  otel-collector:
    image: otel/opentelemetry-collector-contrib
    volumes:
      - ./otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro
      - ./gdpr-simulation:/out
# otel-collector.yaml: exporters: { file: { path: /out/traces.jsonl } }, in the traces pipeline
```

## GDPR in the browser (`tests/gdpr/privacy`, MAIR-292)

`privacy.mjs` records, on a Playwright browser context, every request of the browser, the cookies
the front sets (`Set-Cookie` answers and `document.cookie`, the session a driver injects excluded),
the links of the page, the console messages and `localStorage` / `sessionStorage`. Findings
(`evaluatePrivacy`): a request outside the front's origin (unless allowed with a reason), a cookie
other than `accessToken` / `passwordChangeToken` or without `HttpOnly`, `Secure` or `SameSite`, a page
without a link to the legal notice (`Mentions légales`) and the privacy policy (`confidentialité`).
Report-only until the fronts carry their legal pages. The console and storage feed the GDPR
simulation (`browser/console.json`, `browser/storage.json`).

The module is standalone: `recordPage(browser, url, { cookies })` drives one page. The RGAA engine
(`tests/a11y`) will call it for every state it plays in a follow-up PR, once the RGAA and GDPR stacks
are both merged. On the HTTP test stacks a front that sets `Secure` from the scheme is reported:
set it from the front's configuration.

## OpenAPI coverage gate (ZAP + k6)

`openapi.json` is the contract of every API and BFF. Two shared files turn it into a coverage
reference for the security (OWASP ZAP) and performance (k6) stacks, so that the pipeline on
`main` fails as soon as an operation of the spec is not tested:

| File | Used by | Fails the job when |
| --- | --- | --- |
| `tests/zap/zap_hooks.py` | `zap-api-scan.py` (`--hook`) | an operation received no request from ZAP, or an operation that requires authentication only got 401/403 answers |
| `tests/k6/coverage.js` | `load-test.js` (`import`) | an operation has no handler (k6 aborts at init), or a handler ran without sending its request (`operations_uncovered` counter, threshold `count==0`) |

In CI both files are available under `cicd-repo/tests/` in the ZAP and k6 jobs of
`APIs_cicd.yml` and `BFFs-cicd.yml`. Locally, `security_test.sh` / `performance_test.sh`
fetch them at the pinned `cicd_version` when the folder is missing (see below).

### Wiring a repo

**Compose, ZAP service** (`docker-compose-security.yml`): mount the hook and pass it with
`--hook`. Authenticated operations must be reached with valid credentials, so keep the
`replacer` rule that injects a JWT on every request:

```yaml
  security-scan:
    image: zaproxy/zap-stable
    volumes:
      - ./.zap/rules.tsv:/zap/wrk/rules.tsv:ro
      - ./cicd-repo/tests/zap/zap_hooks.py:/zap/wrk/zap_hooks.py:ro
    command:
      - zap-api-scan.py
      - -t
      - http://bff-user:4000/openapi.json
      - -f
      - openapi
      - -c
      - rules.tsv
      - --hook
      - /zap/wrk/zap_hooks.py
      - -z
      - "-config replacer.full_list(0).description=auth ... replacement=Bearer <jwt>"
```

The hook downloads the spec from the `-t` URL. Set `OPENAPI_COVERAGE_SPEC=/zap/wrk/openapi.json`
(and mount the file) when the target is not served over HTTP, and
`OPENAPI_COVERAGE_BASE_URL` when the scanned base URL cannot be derived from `-t` / `-O`.

**Compose, k6 service** (`docker-compose-performance.yml`): mount the module and the spec next
to `load-test.js`:

```yaml
  k6-perf-test:
    image: grafana/k6:latest
    volumes:
      - ./load-test.js:/load-test.js:ro
      - ./openapi.json:/openapi.json:ro
      - ./cicd-repo/tests/k6/coverage.js:/coverage.js:ro
    environment:
      BASE_URL: http://bff-user:4000
    command: ["run", "/load-test.js"]
```

**`load-test.js`**: declare one handler per operation (`"METHOD /path"`, path exactly as in
the spec), spread `coverage.thresholds` into your thresholds and call `coverage.run()` in the
default function. `request()` builds the URL from the spec (path template + `servers` base
path), JSON-encodes object bodies and tags the request with `op`:

```js
import { check, sleep } from 'k6';
import { createCoverage } from '/coverage.js';

const USER_ID = __ENV.PERF_USER_ID || '2';

const coverage = createCoverage({
  'GET /health': ({ request }) => check(request(), { 'health 200': (r) => r.status === 200 }),
  'GET /user/{userId}/about': ({ request }) =>
    check(request({ path: { userId: USER_ID } }), { 'about 200': (r) => r.status === 200 }),
  'POST /auth/login': ({ request }) =>
    check(request({ body: { email: 'perf@example.com', password: 'secret' } }), {
      'login 200': (r) => r.status === 200,
    }),
});

export const options = {
  stages: [{ duration: '30s', target: 20 }, { duration: '1m', target: 20 }, { duration: '10s', target: 0 }],
  thresholds: {
    ...coverage.thresholds,
    http_req_failed: ['rate<0.01'],
    'http_req_duration{op:GET /health}': ['p(95)<50'],
  },
};

export function setup() {
  return { token: mintJwt() };
}

export default function (data) {
  coverage.run({ headers: { Authorization: `Bearer ${data.token}` } });
  sleep(1);
}
```

`request()` accepts `{ path, query, body, headers, params }`; `run()` accepts
`{ headers, params, data }` (defaults applied to every request, `data` is handed to the
handlers as `api.data`). Handlers also receive `op`, `method`, `path` and `url(pathParams,
query)`. Environment: `BASE_URL` (service root) and `OPENAPI_SPEC` (default `/openapi.json`).

**`security_test.sh` / `performance_test.sh`**: fetch the shared files when running outside
CI, before `docker compose up`, and add `cicd-repo/` to `.gitignore`:

```bash
# Shared CI test files (ZAP hook, k6 coverage module): present in CI as cicd-repo/,
# fetched at the pinned cicd_version when running locally.
CICD_DIR="${CICD_DIR:-cicd-repo}"
if [ ! -f "$CICD_DIR/tests/k6/coverage.js" ]; then
  CICD_VERSION="$(sed -n 's/^[[:space:]]*cicd_version:[[:space:]]*//p' .github/workflows/cicd.yml | head -n 1)"
  git clone --quiet --depth 1 --branch "$CICD_VERSION" https://github.com/mairie360/CICD "$CICD_DIR"
fi
```

**Spec**: the ZAP rule "reached with a non-401/403 answer" only applies to operations that
require authentication *according to the spec*. Declare the scheme (top-level `security` or
per operation) and mark public operations with `security: []`. A spec with no `security` at all
disables that rule and the hook prints a warning.

### Adding an endpoint

1. Add the operation to the code, so it lands in `openapi.json` (APIs: `cargo open_api`;
   BFFs: `npm run build`).
2. Add its handler in `load-test.js`: `'METHOD /path': ({ request }) => ...`. Without it k6
   aborts at init with the list of operations that have no handler. Send the request through
   `request()` (raw `http.*` calls are not counted). If the operation needs data (an existing
   id, a valid body), create it in `setup()` or seed it in `init-test.sql`.
3. Nothing to add for ZAP: it imports the spec, so the new operation is scanned automatically.
   If the hook reports it as `MISSING`, ZAP could not build a request for it (check the spec's
   parameters and request body); if it reports `UNAUTHENTICATED`, the JWT injected by the
   `replacer` rule is refused (wrong secret, expired, missing role) or the operation should be
   declared public with `security: []`.
4. Run `./security_test.sh` and `./performance_test.sh` locally; both print a per-operation
   report.

### Reading a failure

ZAP (end of the `security-scan` logs, exit code 1):

```
OpenAPI coverage (ZAP) for http://bff-user:4000
  34 operations in the spec, 812 messages recorded by ZAP (590 outside the spec, 2 without response)
  ok              GET    /health  statuses=200  (public)
  MISSING         PATCH  /bff/admin/users/{userId}/password  statuses=-
  UNAUTHENTICATED GET    /me  statuses=401
OPENAPI COVERAGE FAILED: 1 operation(s) not reached, 1 only answered 401/403
```

k6 (init error, exit code 107):

```
Error: openapi coverage: 1 problem(s) between the spec and load-test.js:
  - operation "PATCH /bff/admin/users/{userId}/password" has no handler
```

k6 (threshold, exit code 99): `operations_uncovered ✗ 'count==0' count=40`, with the `op`
tag of the offending operation in the metric breakdown.

## RGAA scope (`rgaa.yaml`, MAIR-316)

Each front, and `lib-components`, declares its RGAA 4.1.2 scope in a `rgaa.yaml` at the root of
its repo. This repo only holds the format (`tests/a11y/rgaa.schema.json`), its validator and the
test engine that plays the scope (MAIR-317 to MAIR-319); no front-specific file lives here.

| Key | Content |
| --- | --- |
| `version` | `1` |
| `target` | URL of the front in the test stack (`http://settings-front:5000`), or of the Storybook for `lib-components` |
| `criteria` | applicable criteria, transverse ones (12.1 to 12.5) included. A criterion that is not listed is not applicable: give the reason in a YAML comment |
| `session` | `jwt_secret` and `jwt_timeout` (default 3600): the `JWT_SECRET` / `JWT_TIMEOUT` of the test stack. The engine signs an HS256 JWT `{sub, role, exp}` per user, like the static token of the ZAP stacks, and sets it as `cookie` (default `accessToken`) on the target origin |
| `users` | seed users by name (`admin`, `agent`…), one per role that changes what the page shows: `id` (must exist in the seed, the APIs check it) and `role` |
| `states` | renderings to capture: `id`, then either `route` (+ optional `as: <user>`) for a front, or `story` (Storybook id) for `lib-components`, optional `viewport: { width, height }` (default 1280 × 800, e.g. a mobile layout; the 320 px reflow check comes back to it) and optional `steps` |

A step is exactly one action. `click`, `hover`, `wait_for` and `wait_for_hidden` take a locator,
`fill` and `select` a locator plus `value`, `press` a key name and `goto` a route. A locator is one
of `role` (+ `name`), `label`, `text`, `test_id` or `selector`, in that order of preference:

```yaml
version: 1
target: http://projects-front:5000
session:
  jwt_secret: b"secret"            # JWT_SECRET of the test stack, test-only
users:
  agent: { id: 2, role: user }      # id from init-test.sql
criteria:
  # 2.x: no iframe. 4.x: no media.
  - "1.1"
  - "11.1"
states:
  - id: create-project-errors
    route: /
    as: agent
    steps:
      - click: { role: button, name: Nouveau projet }
      - click: { role: button, name: Créer }
```

The secret is the test stack's, committed in clear like in the compose files; the default
Gitleaks config of this repo allows that line (see "Gitleaks"). Test stacks do not set
`JWT_REQUIRE_SESSION`, so these tokens without `sid` are accepted; it is a production setting.

Cover at least the normal load and the empty list, form errors, every modal and view, and
every role that changes the page. Full examples: `tests/a11y/examples/`.

For completion and checks in the editor, start the file with
`# yaml-language-server: $schema=https://raw.githubusercontent.com/mairie360/CICD/<cicd_version>/tests/a11y/rgaa.schema.json`.
Validate it locally:

```bash
git clone --depth 1 --branch <cicd_version> https://github.com/mairie360/CICD.git cicd-repo
(cd cicd-repo/tests/a11y && npm ci) && node cicd-repo/tests/a11y/validate.mjs rgaa.yaml
```

Errors come out as GitHub annotations, one per problem, e.g.
`/states/0/steps/0/click: needs a locator: one of role, label, text, test_id, selector`.

## RGAA gate (MAIR-317)

For the fronts the RGAA check is a prod gate: the `rgaa` job of `promote-prod.yml` (`stack:
fronts`, action `actions/promote/rgaa-front`) runs between `version` and `promote`, on
`<image>@<staging digest>` of the promoted commit, so the Prod approver reads its report first; a
failure skips the prod release (no tag, no prod image). `front-libs-cicd.yml` runs the same engine
on the lib's Storybook stories in an `accessibility_tests` job, at release time only: on `main`,
once the unit tests pass, and `storybook` / `package` need it. Neither runs on pull requests. Both
fail right away when the scope is missing, keep `rgaa-report/` as an artifact (`report.json`,
`summary.md`, a full-page screenshot per failed state under `failures/`) and add `summary.md` to
the job summary. The job fails when a state cannot be reached, a criterion is undeclared, the scope
is invalid or the rate is below the minimum (see below). The front steps live in the `actions/promote/rgaa-front`
composite action, called by the `rgaa` job of `promote-prod.yml`.

The runner image is pinned by version and digest in `tests/a11y/runner-image`, matching the
`playwright` dependency of the engine (a test keeps them in sync): consumers never write it.

### Wiring a front

Besides `rgaa.yaml`, a front provides two files. The gate exports `IMAGE_REF` (the image under
test); without it, `accessibility_test.sh` builds the front locally.

`docker-compose-accessibility.yml`: the stack of `docker-compose-security.yml` (database + seed,
APIs, BFF), the front on `${IMAGE_REF}`, and the runner instead of ZAP. Lessons from the eight
fronts:

- **Every env var the front reads** (`grep -rn process.env src`): its BFF URL(s), every
  `*_FRONT_URL` (dummy `http://<x>-front.invalid/` values, the front's own URL pointing at itself)
  and `COOKIE_DOMAIN` (the front service name). A missing one renders an error page instead of
  the page under test (Login: "Connexion temporairement indisponible", every login a 503).
- **The data the states need** in an `init-accessibility.sql`, run by a second seeder service
  after `seeder`, in this stack only: ZAP / k6 keep `init-test.sql` and their thresholds. Every
  seeded user needs a `user_roles` row (core-api answers 502 without a role); roles come from the
  database (`Admin`, `Responsable`, …), the BFFs ignore the JWT `role` claim. Insert the users and
  their roles in one transaction (a deferred trigger adds `Guest` otherwise), use fixed dates
  (the engine fixes the browser clock at 2026-01-15T09:00+01:00, the servers keep the real one)
  and ids that do not clash with `init-test.sql`.
- **States run in parallel** (4 at a time): a state that writes data uses its own seed user, so
  that the others never see its writes.

```yaml
  seeder-a11y:
    image: postgres:18-alpine
    depends_on:
      seeder:
        condition: service_completed_successfully
    volumes:
      - ./init-accessibility.sql:/init-accessibility.sql:ro
    environment:
      PGPASSWORD: password
    command: ["psql", "-v", "ON_ERROR_STOP=1", "-h", "postgres", "-U", "postgres", "-d", "mairie_360_database", "-f", "/init-accessibility.sql"]
    networks:
      - backend
    # the services that depended on `seeder` depend on `seeder-a11y`

  settings-front:
    image: ${IMAGE_REF:?}
    environment:
      SETTINGS_BFF_URL: http://bff-settings:4008
      LOGIN_FRONT_URL: http://login-front.invalid/
      SETTINGS_FRONT_URL: http://settings-front:5000/
      # ... every other *_FRONT_URL
      COOKIE_DOMAIN: settings-front
    # ... healthcheck, networks as in docker-compose-security.yml

  a11y:
    image: ${A11Y_RUNNER_IMAGE:?}
    user: "${RGAA_UID:-0}:${RGAA_GID:-0}"   # the script exports them: rgaa-report/ is not root-owned
    depends_on:
      settings-front:
        condition: service_healthy
    command: ["sh", "/engine/run.sh"]
    environment:
      RGAA_MIN_RATE: ${RGAA_MIN_RATE:-}   # set by the job from the rgaa_min_rate input
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}   # AI pre-audit (MAIR-320), optional
      ANTHROPIC_WORKSPACE_ID: ${ANTHROPIC_WORKSPACE_ID:-}
      RGAA_AI_MODEL: ${RGAA_AI_MODEL:-}
    volumes:
      - ./.rgaa-ai-cache:/ai-cache        # AI verdicts kept between runs by the job
      - ./cicd-repo/tests/a11y:/engine:ro
      - ./rgaa.yaml:/scope/rgaa.yaml:ro
      - ./rgaa-report:/report
    networks:
      - backend
```

`accessibility_test.sh`, same shape as `security_test.sh`:

```bash
#!/usr/bin/env bash
COMPOSE_FILE="docker-compose-accessibility.yml"

# The CI exports IMAGE_REF (<image>@<staging digest>). Locally, build the front under test.
if [ -z "${IMAGE_REF:-}" ]; then
  docker build -t settings-front:local --secret id=node_auth_token,env=NODE_AUTH_TOKEN . || exit 1
  export IMAGE_REF="settings-front:local"
fi

# RGAA engine at the cicd_version pinned in .github/workflows/cicd.yml (CI checks it out itself).
if [ ! -f cicd-repo/tests/a11y/run.sh ]; then
  CICD_VERSION="${CICD_VERSION:-$(sed -n 's/^[[:space:]]*cicd_version:[[:space:]]*\([^[:space:]#]*\).*/\1/p' .github/workflows/cicd.yml | head -n 1)}"
  rm -rf cicd-repo
  git clone --quiet --depth 1 --branch "$CICD_VERSION" https://github.com/mairie360/CICD cicd-repo || exit 1
fi
export A11Y_RUNNER_IMAGE="$(cat cicd-repo/tests/a11y/runner-image)"
export RGAA_UID="$(id -u)" RGAA_GID="$(id -g)"   # run the runner as the caller

mkdir -p rgaa-report .rgaa-ai-cache
docker compose -f "$COMPOSE_FILE" up -d
docker compose -f "$COMPOSE_FILE" wait a11y
EXIT_CODE=$?
docker compose -f "$COMPOSE_FILE" logs a11y
# The stack is removed below: print it now when something failed (a seeder or an API that did not
# start), the job cannot dump the containers afterwards.
[ "$EXIT_CODE" -eq 0 ] || docker compose -f "$COMPOSE_FILE" logs --tail 100
docker compose -f "$COMPOSE_FILE" down -v
exit $EXIT_CODE
```

The report stays in `rgaa-report/` (add it, `.rgaa-ai-cache/` and `cicd-repo/` to `.gitignore`;
add the RGAA files and `init-accessibility.sql` to `.dockerignore`).

### Wiring lib-components

Only `rgaa.yaml`, with `target: http://storybook:6006` and `story` states: the job builds the
Storybook (`npm run build-storybook`) and serves it under that name.

## RGAA checks and report (MAIR-318)

Every reached state is captured and checked, then the results are grouped per criterion.

**Snapshot.** For each state, `rgaa-report/states/<id>/` holds:
- `page.html`: the normalized HTML, without scripts and styles. Classes and inline styles are
  removed, generated ids (React `useId`, Radix…) become `gen-<n>`, Next.js build hashes become
  `<build>` and attributes are sorted;
- `aria.yml`: the accessibility tree (Playwright ARIA snapshot);
- `desktop.png` and `mobile-320.png`;
- `checks.json`.

The `fingerprint` of a state is the SHA-256 of `page.html` and `aria.yml`. The browser runs with
a fixed date (2026-01-15), reduced motion and the `fr-FR` locale, so the same image and seed always
give the same fingerprints. The verdicts of the n8n chain (MAIR-298, MAIR-320) are keyed on them.

**Checks.** `tests/a11y/criteria.yaml` maps each of the 106 criteria to its checklist `level`
(auto / semi / manual), its `checks` and its automated `coverage`:
- `full`: the checks decide the criterion;
- `partial`: a failure invalidates the criterion, a pass still needs a review;
- `none`: always reviewed.

There are two kinds of checks. `axe:<rule>` runs axe-core 4.14, pinned, injected in the page.
`scenario:<id>` runs a scenario from `scenarios.mjs`:

| Scenario | Criteria | What it does |
| --- | --- | --- |
| `doctype`, `duplicate-ids`, `lang-fr`, `page-title` | 8.1, 8.2, 8.4, 8.6 | DOM checks: `<!doctype html>`, unique ids, `lang="fr…"`, a non-generic title |
| `presentational-attrs`, `new-window`, `decorative-svg`, `figure-caption` | 10.1, 13.2, 1.2, 1.9 | presentational markup, `target="_blank"` without a warning, an unnamed svg that is not `aria-hidden`, a caption not repeated in `aria-label` |
| `table-title`, `layout-table`, `group-legend`, `invalid-fields` | 5.4, 5.8, 11.6, 11.10 | a data table without a title, data markup in a layout table, a `fieldset` / group without a name, an `aria-invalid` field without a linked message |
| `reflow-320`, `zoom-200`, `text-spacing`, `orientation` | 10.11, 10.4, 10.12, 13.9 | horizontal scroll at 320×256 (outside scrollable containers), text cut by its box at 200 % or with the WCAG spacing, elements hidden or rotated under an `@media (orientation: …)` rule (a layout change at a width breakpoint is not a lock) |
| `keyboard`, `modal-focus`, `focus-visible`, `skip-link` | 12.9, 7.3, 12.8, 7.1, 10.7, 12.7 | one Tab walk: focus cycling inside part of the page without ever getting out while other controls are never reached (trap), focus leaving the open modal dialog (7.1), no visible change on focus, first stop is not a skip link to an existing target |
| `hover-content` | 10.13, 12.11 | hovers each control (40 at most). What appears must stay when the pointer moves onto it, close with Escape and also show on keyboard focus |
| `status-messages` | 7.5 | `status-observer.js` records the DOM changes made by the state's steps. **Failure**: a live region (`status`, `alert`, `log`, `aria-live`, `output`) inserted together with its text, which is never announced; this includes toasts that close themselves. **Review**: text that appeared after a step outside any live region, while the focus did not move into it and no dialog opened. Only states with steps (save, create, search…) exercise it |

A scenario that throws puts its criteria in review; it never counts as a pass.

**Undeclared criteria.** A page that contains an image (1.1), a frame (2.1), a media element
(4.1), a data table (5.6), a link (6.2) or a form field (11.1) whose criterion is missing from the
front's `rgaa.yaml` fails the run, with the element.

**Report.** `report.json` holds:
- `criteria[]`: `id`, `level`, `coverage`, `checks`, `failures[]` and `review[]` (axe
  "incomplete" results, scenario errors), each item with its `state`, `check`, `target`, `html`
  and `message`;
- `states[]`: `id`, `reached`, `url`, `fingerprint` and `files`;
- `undeclared[]`.

States run in parallel, 4 at a time by default (`RGAA_CONCURRENCY`, 1-16), each in its own browser
context; the report keeps the order of `rgaa.yaml`. Table, group and legend checks only look at
visible elements (Storybook keeps hidden docs markup in its iframe).

The runner copies the engine out of its read-only `/engine` mount before `npm ci`, so it never
writes a root-owned `node_modules` into the consumer's `cicd-repo/`.

The job fails on an unreachable state or an undeclared criterion, and on the rate gate below.

## RGAA rate gate (MAIR-319)

Boolean and unweighted, like the official RGAA rate: a criterion is validated only if every check
passes on every element of every state. Each criterion of `report.json` gets a `status`:
- `invalidated`: a check failed (certain, whatever the coverage);
- `validated`: `coverage: full`, no failure and nothing to review;
- `to_review`: everything else (partial or no coverage, axe "incomplete", scenario error). These
  go to the RGAA reviewer in the n8n chain (MAIR-298) and are left out of the CI rate.

**CI rate** = validated ÷ (validated + invalidated), rounded to one decimal, in `report.rate`
(`validated`, `invalidated`, `to_review`, `value`, `min`, `passed`). Below `rgaa_min_rate`
(input of `promote-prod.yml` and `front-libs-cicd.yml`, default **60**), the engine exits 3: the `rgaa` job of `promote-prod.yml` fails and the front is not
promoted (for the lib, `accessibility_tests` fails and blocks `storybook` / `package`). With no criterion decided, `value` is
`null` and the gate passes. Locally, `RGAA_MIN_RATE=<percent> ./accessibility_test.sh`.

The release gate of the n8n chain (MAIR-298, at least 60 % per front and 50 % overall) uses the
full rate, once the reviewed criteria are in.

## RGAA AI pre-audit (MAIR-320)

Most criteria end up `to_review` because they are about relevance: is this `alt` right, is this
link explicit. The engine extracts the elements those criteria judge, and Claude proposes a
verdict for each one. The proposals **never change the gating rate**. They give the RGAA reviewer
of the n8n chain (MAIR-298) a pre-filled answer and the report an **estimated rate**.

| Criterion | Element sent (JSON, plus a screenshot for images) |
| --- | --- |
| 1.3 | informative images: `alt` / accessible name, `src`, surrounding text, screenshot. Decorative ones (`alt=""`) belong to 1.2 |
| 6.1 | links: name, `href`, surrounding text |
| 11.2 | fields: label, type, placeholder, required |
| 11.9 | buttons: accessible name, visible text |
| 13.5 / 13.6 | emoji, symbols or ASCII art used as content, with their alternative |

Only the criteria declared in `rgaa.yaml` are extracted.

**How each element is judged.** Each element has a fingerprint: SHA-256 of the criterion, the
extracted fields and `EXTRACTION_VERSION` (bump it when a prompt changes). An element already in
the verdict cache is never sent again: a run without change makes no API call.

The other elements go to Claude (`@anthropic-ai/sdk`), with these settings:
- 15 elements per request, 3 requests in parallel;
- one system prompt per criterion, prompt-cached;
- structured output (`valid` / `invalid` / `uncertain`, plus a reason in French);
- effort `low`;
- `fallbacks: "default"` on the models that accept it.

API errors and refusals give `uncertain` and are not cached, so they are retried at the next run. When **every** request fails (key, workspace or model name), the pre-audit fails instead: a
`::warning`, `ai.error` in the report and the summary, with the API message.

**What a criterion gets.** One `invalid` element proposes `invalidated`. All elements `valid`
proposes `validated`. Anything else is `uncertain`. The estimated rate counts these proposals for
the criteria left `to_review`. Both appear in `report.json` (`ai`, with `ai.elements`: every judged element and its verdict, the input of the reviewer form, MAIR-298) and in the job summary, with the
invalid elements, the model, the number of judged and cached elements, and the cost.

**Settings.**

| Setting | Value |
| --- | --- |
| Secret `ANTHROPIC_API_KEY` | optional; without it the pre-audit is skipped and the run is unchanged |
| Secret `ANTHROPIC_WORKSPACE_ID` | only when the key is not scoped to a workspace (the API otherwise answers 400 "must include the anthropic-workspace-id header"); sent as the `anthropic-workspace-id` header |
| Input `rgaa_ai_model` (`RGAA_AI_MODEL`) | default `claude-sonnet-5-5` |
| `RGAA_AI=off` | disables the pre-audit |

The verdict cache (`.rgaa-ai-cache/verdicts.json`, mounted as `/ai-cache`) is restored and saved
by the job with `actions/cache`, per repository, until the n8n store (MAIR-275) holds the
verdicts.

What is sent is the rendered UI of the test stack: seed data and Storybook demo data, never
production data.
