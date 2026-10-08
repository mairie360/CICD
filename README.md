# CICD

Centralized CI/CD of the Mairie360 org: reusable GitHub workflows (`.github/workflows/*_cicd.yml`),
the composite actions they call (`actions/`), and the test files shared by every service (`tests/`).

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

## Semgrep SAST (`actions/semgrep`)

Every stack workflow has a `security_sast` job ("Code Security Audit (Semgrep, Gitleaks)") that calls the
`semgrep` composite action. The action runs a pinned image
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
inventory marks `audit_log: false`). A consumer that overrides `semgrep_config` adds the folder to
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

**Bumping Semgrep.** Update the `image` default in `actions/semgrep/action.yml`, and update the
version tag and the digest together. The digest is the one of the multi-arch tag
(`docker buildx imagetools inspect semgrep/semgrep:<version>`).

## Gitleaks (`actions/gitleaks`)

The `security_sast` job of every workflow also runs Gitleaks (pinned
`zricethezav/gitleaks:<version>@sha256:<digest>` image, not the `gitleaks-action`, which needs a
paid license on organizations). It only scans the commits the run adds: `base..head` of a pull
request, `before..after` of a push, the last commit for a new branch. A secret already in the
history therefore does not fail every later build: rotate it first, then add its fingerprint to a
`.gitleaksignore` at the root of the repo. The job checks the repo out with `fetch-depth: 0`.

## Image release (`actions/docker-release`, MAIR-416)

`APIs_cicd.yml`, `BFFs-cicd.yml`, `frontend-cicd.yml` and `database_cicd.yml` release their images
through the same action:

| Stage | What happens | Tags written |
| --- | --- | --- |
| `dev` | single build with an SBOM and a `mode=max` provenance attestation, push as `dev-<sha>` only, Trivy scan of that digest, cosign keyless signature, then the mobile tag | `dev-<sha>`, `dev` |
| `staging` | resolves the digest of `dev-<sha>` (the commit of this run, never the mobile `dev`), checks it equals the digest `release-dev` built, verifies the cosign signature, re-tags that digest | `staging-<sha>`, `staging` |
| `prod` | same from `staging-<sha>`, only when semantic-release published a version | `<version>`, `latest` |

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

## GDPR inventory gate (`actions/gdpr-inventory`, MAIR-285)

`database_cicd.yml` runs a `gdpr_inventory` job after `release-staging`; `release-prod` needs it.
It migrates an empty database with the images promoted to staging and compares the columns with
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

To wire it, the Database repo passes the secrets to the workflow:

```yaml
    secrets:
      N8N_WEBHOOK_SECRET: ${{ secrets.N8N_WEBHOOK_SECRET }}
      CODECOV_TOKEN: ${{ secrets.CODECOV_TOKEN }}
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}  # optional: AI proposals
```

Run the check by hand on a migrated database:

```bash
cd tests/gdpr && npm ci
psql -At -q -d core -f schema.sql > /tmp/schema.json
node check.mjs ../../../Database/gdpr/inventory.yaml /tmp/schema.json /tmp/gdpr-report
```

## GDPR log marker (`actions/gdpr-marker`, MAIR-290)

`APIs_cicd.yml` and `BFFs-cicd.yml` run a `gdpr_marker` job after `release-staging`, on the image
promoted to staging (by digest); `release-prod` needs it, so its summary is read before the Prod
approval. A runner creates a **marker user** with unique values (e-mail, first and last name,
phone, password), plays the journey the repo declares, deliberate errors included, and the logs of
**every container** of the stack are then searched for those values: raw, URL-encoded,
JSON-escaped, in base64, the phone also as the national number the database stores, plus the
values the journey captures as `sensitive` (tokens). One line found fails the job. Rule: a log
describes an error by its type and context, never by the value it received.

The job summary lists the leaks per service (values masked), the journey with each status, the
marker fields the journey never sends (so not tested) and the services left out with their
reason. The `gdpr-marker` artifact holds the same report; the raw logs never leave the runner.
The job is skipped with a warning while the repo has no `gdpr-marker.yaml`.

### Wiring an API or a BFF

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

## GDPR contract (`actions/gdpr/contract`, MAIR-291)

`APIs_cicd.yml` and `BFFs-cicd.yml` run a `gdpr_contract` job on every event (APIs: after `lint`,
on `cargo open_api`; BFFs: after `build`, on the `openapi-spec` artifact); `release-prod` needs it.
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

## GDPR simulation (`actions/gdpr/simulation`, MAIR-497)

`APIs_cicd.yml` and `BFFs-cicd.yml` run a `gdpr_simulation` job after `release-staging`, on the
image promoted to staging; `release-prod` needs it. It is skipped with a warning while the repo has
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
   of the free-text and JSON columns);
3. `analyze.mjs` is the gate. **Deterministic**: a persona value (or a captured token) in any log,
   browser console message or browser storage entry fails. The erasure and retention checks are
   reported as expected failures until the erasure exists (MAIR-289); `GDPR_SIMULATION_ERASURE=enforce`
   makes them block. **AI review** (`gdpr_simulation_ai_model`, `claude-haiku-4-5` by default,
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

```bash
docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U postgres -d "$DB" -At -f - < cicd-repo/tests/gdpr/schema.sql > gdpr-simulation/schema.json
node cicd-repo/tests/gdpr/simulation/sql.mjs "$INVENTORY" gdpr-simulation/schema.json gdpr-simulation
for q in erasure retention content; do
  docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U postgres -d "$DB" -At -f - < "gdpr-simulation/db/$q.sql" > "gdpr-simulation/db/$q.sql.json"
done
docker compose -f "$COMPOSE_FILE" logs --no-color > gdpr-simulation/containers.log
docker compose -f "$COMPOSE_FILE" down -v
```

The action then runs `analyze.mjs`. The fronts add `gdpr-simulation/browser/console.json` and
`storage.json`, written by the RGAA engine while it plays their states (MAIR-292). Only the masked
report (`summary.md`, `report.json`) is uploaded.

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
