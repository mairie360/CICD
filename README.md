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
| `BFFs-cicd.yml` | `p/typescript p/owasp-top-ten p/nodejs p/expressjs p/secrets p/dockerfile p/github-actions` | yes |
| `APIs_cicd.yml` | `p/rust p/secrets p/dockerfile p/github-actions` | yes (since MAIR-416) |
| `back-lib-cicd.yml` | `p/rust p/secrets p/github-actions` | no, report-only |
| `frontend-cicd.yml` | `p/typescript p/react p/owasp-top-ten p/secrets p/dockerfile p/github-actions` | yes (since MAIR-416) |
| `front-libs-cicd.yml` | `p/typescript p/react p/secrets p/github-actions` | no, report-only |
| `bffs-lib-cicd.yml` | `p/typescript p/nodejs p/expressjs p/secrets p/github-actions` | no, report-only |
| `database_cicd.yml` | `p/secrets p/dockerfile p/github-actions` | yes (since MAIR-416) |

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
request, `before..after` of a push, the last commit for a new branch. A secret already in the
history therefore does not fail every later build: rotate it first, then add its fingerprint to a
`.gitleaksignore` at the root of the repo. The job checks the repo out with `fetch-depth: 0`.

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
| Gates | integration tests (APIs; BFFs since MAIR-262, newman collection), ZAP and k6 (APIs, BFFs, fronts) on `<image>:dev-<sha>` | Liquibase release folder and GDPR inventory (database, MAIR-491, MAIR-285); RGPD / RGAA / E2E plug in here (MAIR-604, MAIR-317/319, MAIR-602) |
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

### Migrating a consumer to the promotion workflows (v4.4.0, MAIR-494)

- `cicd.yml`: bump the `uses:` ref and `cicd_version` to v4.4.0 or later. The main run now ends after
  `release-dev`; its `Staging` / `Prod` jobs are gone, and so are the BFF workflow outputs
  `release_published` / `release_version`.
- Add `promote-staging.yml` and `promote-prod.yml` as above, pinned to the same ref as `cicd.yml`,
  and add them to the Renovate custom manager of the repo, so one Renovate PR bumps the three files.
- Commits released by the v4 pipeline promote as is: `resolve` only needs their `dev-<sha>` (and a
  green `release-dev`; the `cancelled` Staging / Prod jobs of the old runs do not count as failures)
  or their `staging-<sha>`.

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
