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
