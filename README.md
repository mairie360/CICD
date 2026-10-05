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
| `states` | renderings to capture: `id`, then either `route` (+ optional `as: <user>`) for a front, or `story` (Storybook id) for `lib-components`, and optional `steps` |

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

The secret is the test stack's, committed in clear like in the compose files; ask for the
`rgaa.yaml` finding to be added to the repo's `.gitleaksignore` if Gitleaks flags it.

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
