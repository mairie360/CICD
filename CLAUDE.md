# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Centralized CI/CD for the **mairie360** GitHub org (project "Mairie360"). It contains **no application code** — only:

- **Reusable workflows** in `.github/workflows/*_cicd.yml` (`on: workflow_call`), consumed by the org's application repos.
- **Composite actions** in `actions/*/action.yml`, invoked by those reusable workflows.
- **Shared test files** in `tests/` (`zap/zap_hooks.py`, `k6/coverage.js`): the OpenAPI coverage
  gate mounted by the consumers' ZAP / k6 compose stacks (see "OpenAPI coverage gate" below),
  and `a11y/`, the RGAA engine (see "RGAA engine" below).
- This repo's own release pipeline (`.github/workflows/cicd.yml` + `.releaserc.json`), plus Renovate automation.

Apart from `tests/a11y` (`npm ci && npm test` there), there is nothing to build, run, or unit-test locally. Changes are validated by the downstream repos that call these workflows. `.github/workflows/lint.yml` runs [`actionlint`](https://github.com/rhysd/actionlint) on every PR and, as a reusable workflow, as the `lint` job that `cicd.yml`'s `release` depends on (SC2086/SC2016/SC2129 shellcheck findings are ignored until the existing ones are cleaned up) and checks that each `actions/**/action.yml` has a `runs:` block; run the same locally with `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.12`. The ZAP and k6 files under `tests/` can be exercised by hand: `python3` with a fake `zap` object for the hook, `docker run grafana/k6` for the module.

Dependency automation is delegated: `renovate.json` only does `"extends": ["github>mairie360/renovate-config"]`, so the actual Renovate rules live in the org's `mairie360/renovate-config` repo, not here.

## How consumers use this repo

A downstream repo references a reusable workflow and passes `cicd_version` (a ref of this repo — tag or SHA):

```yaml
jobs:
  ci:
    uses: mairie360/CICD/.github/workflows/APIs_cicd.yml@v1.4.0
    with:
      cicd_version: v1.4.0
      package_name: my-api
    secrets: inherit
```

**Composite actions are not called directly across repos.** Each reusable workflow re-checks-out `mairie360/CICD` at `${{ inputs.cicd_version }}` into `cicd-repo/`, then uses `./cicd-repo/actions/<name>`. This is why `cicd_version` is a required input on almost every workflow. When you change a composite action's inputs/outputs, every reusable workflow that consumes it (and every downstream caller) must be updated in lockstep.

Every stack workflow, `front-libs-cicd.yml` included, now takes `cicd_version` and checks out `cicd-repo/` (at least for `semgrep` and `notify-cicd-failure`).

## Release / promotion model (shared by all stack workflows)

Pipeline shape, roughly identical across `APIs_cicd`, `BFFs-cicd`, `frontend-cicd`, `database_cicd`:

```
dependencies → (lint, security_audit, security_sast) → build ∥ test   (unit tests only need lint, run in parallel with build)
  → release-dev        (no environment)      build once + SBOM/provenance → dev-<sha_tag> → Trivy → cosign sign → dev
  → security_tests (OWASP ZAP)  + performance_tests (k6)   [run in parallel, main only]
  → release-staging    (environment: Staging) verify + RE-TAG digest of dev-<sha_tag> → staging-<sha_tag> / staging
  → release-prod       (environment: Prod)    semantic-tag → verify + RE-TAG digest of staging-<sha_tag> → <semver> / latest
```

Key invariants:

- **Images are built exactly once** (in `release-dev`). Staging and prod "releases" only add tags to an existing digest (`docker buildx imagetools create`, via the shared `docker-release` action, on all four stack workflows) — never rebuild. Preserve this; rebuilding per-environment is a regression.
- **Promotion is by digest of the run's own commit** (MAIR-416): staging resolves `dev-<sha>`, prod resolves `staging-<sha>`, each checked against the digest the previous job exposes as its `digest` output (`expected_digest`) and against its cosign signature. Never promote from a mobile tag (`dev`, `staging`, `latest`): an approval can wait for hours while another commit moves it.
- Deploy jobs gated on `if: github.ref == 'refs/heads/main'`. Note: in `APIs_cicd.yml` only `release-dev` (and the test jobs) carry the explicit `if`; `release-staging` / `release-prod` are gated **transitively** — their `needs` chain is main-only, so they skip off-main because a skipped dependency skips its dependents. Keep that chain intact if you reorder jobs.
- GitHub **Environments** (`Staging`, `Prod`, `Release`, and the misc `release`/`releasee` in `front-libs`) hold the approval gates and environment-scoped secrets. Environment names are load-bearing strings. `release-dev` has no environment on purpose (MAIR-416): every commit on `main` goes to dev without approval; keep env-scoped secrets out of it.
- Image registry is GHCR: `ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/<package_name>`. The `,,` lowercases the owner — this is **bash** parameter expansion and only works inside `run:` blocks, not in `${{ }}` expressions.
- Short SHA convention: the `docker-release` action uniformizes the SHA tag at 7 chars (`sha_length` input) for every stack it's wired into, computed once in `steps.meta` and reused for `dev-`/`staging-` tags at every stage — no more per-job `${GITHUB_SHA::7}` recomputation to keep in sync.

## Known landmines (unfixed as of this branch)

These are live bugs in the workflows — don't copy the pattern, and fix in place if you touch the job:

- **`publish-openapi-typescript`** only creates a staging directory — it compiles and publishes nothing. Any BFF relying on OpenAPI type publishing gets a silent no-op.
- **Cross-repo drift (`Devops/Deploiment`)**: `docker-release` pushes mobile tags `dev` / `staging` (plus `<version>` / `latest` in prod), not the `dev-latest` / `staging-latest` the Argo CD umbrella chart's `dev`/`staging` instance `values.yaml` still pin for every image. This has been silently stale for the APIs since the `APIs_cicd.yml` pilot (their `dev-latest`/`staging-latest` tags stopped being pushed then); migrating `BFFs-cicd.yml`, `frontend-cicd.yml` and (MAIR-416) `database_cicd.yml` to `docker-release` extends the same drift to every BFF, front and the database images. `Deploiment`'s values files need `dev-latest`/`staging-latest` → `dev`/`staging` before those environments will pick up new images again.

## OpenAPI coverage gate (`tests/`, MAIR-194)

`openapi.json` is the coverage reference of the ZAP and k6 stacks. `tests/zap/zap_hooks.py` is a
`zap-api-scan.py` hook file (`--hook`): in `zap_pre_shutdown` it downloads the spec from the `-t`
target (or `OPENAPI_COVERAGE_SPEC`), pages through `core/view/messages`, maps each request to an
operation (literal paths win over templated ones, `servers` base paths are stripped) and prints a
per-operation report; `pre_exit` then exits 1 when an operation was never reached or when a
non-public operation only got 401/403. "Public" follows OpenAPI semantics: `security: []` on the
operation, or no `security` anywhere (then the auth rule is disabled with a warning). Standard
library only, it must run in the stock `zaproxy/zap-stable` image. `tests/k6/coverage.js` is a k6
module: `createCoverage(handlers)` throws at init when the handler keys (`"METHOD /path"`) and the
spec's operations differ, `run()` calls every handler once per iteration, `request()` tags each
request with `op`, and the `operations_uncovered` / `operation_handler_errors` counters carry the
`count==0` thresholds. The ZAP and k6 jobs of `APIs_cicd.yml` / `BFFs-cicd.yml` check out
`cicd-repo/` so consumer compose files can mount `./cicd-repo/tests/...`; locally the consumers'
`*_test.sh` clone it at the pinned `cicd_version`. The consumer-side wiring (compose mounts,
`--hook`, `load-test.js` handlers, `security` in the spec) is documented in `README.md`; changing
the hook's report format, the handler key format or the counter names is a breaking change for
every consumer.

## RGAA engine (`tests/a11y/`, epic MAIR-297)

Rule: this repo holds **only the testing logic**. Each front and `lib-components` declare their
own scope in a `rgaa.yaml` at their root (applicable criteria, transverse ones included, and the
page states or Storybook stories to capture); never add a front-specific file here.
`tests/a11y/` is a Node package (`npm ci` there, `node_modules/` is git-ignored):
`rgaa.schema.json` (format, MAIR-316; the 106 criterion ids are an enum, a step is exactly one
action, a locator one of `role`/`label`/`text`/`test_id`/`selector`; sessions are HS256 JWTs `{sub, role, exp}` the engine signs with the stack's `jwt_secret`, no login call), `validate.mjs` (CLI +
`loadScope()` for the engine; it reports steps and states itself because the schema `oneOf`s
give unreadable errors), `validate.test.mjs` (`node --test`) and `examples/`, all run by the
`a11y` job of `lint.yml`. Changing the format is a breaking change for every front: bump
`version`. Engine (MAIR-317): `run.sh` (runner command: `npm ci` then `run.mjs <scope> <report
dir>`), `run.mjs` (exit 0 / 1 a state failed / 2 invalid scope), `states.mjs` (`playState`:
fresh context per state, JWT cookie, steps, `onReached` hook where MAIR-318 captures),
`session.mjs` (HS256 signing, tested against the ZAP stacks' static token). The runner image is
pinned in `tests/a11y/runner-image` (version + digest) and must match the exact `playwright`
dependency (a test checks it); bump both together. `states.e2e.test.mjs` only runs with
`RGAA_E2E=1` inside that image (`a11y` job of `lint.yml`). Placement: in `frontend-cicd.yml` the RGAA
check is a set of steps of `release-prod` (needs `release-dev` + `release-staging`), after the Prod
approval and before `semantic-tag` / promotion, on `<image>:staging-<sha_tag>`; a failure means no
tag and no prod image (the front provides `accessibility_test.sh` +
`docker-compose-accessibility.yml`). In `front-libs-cicd.yml` it is the `accessibility_tests` job (main only, `needs: test`: release
time, after the unit tests)
(serves `storybook-static` as `http://storybook:6006`; required by `storybook` / `package`).
MAIR-317 also moved the front ZAP / k6 jobs to `IMAGE_REF=<image>:dev-<sha_tag>`. Checks
(MAIR-318): `criteria.yaml` (106 criteria: checklist `level`, `checks` = `axe:<rule>` /
`scenario:<id>`, `coverage` full/partial/none; `criteria.test.mjs` keeps it consistent with
axe-core and `SCENARIOS`), `capture.mjs` (`captureState`: injects `page-helpers.js` and axe-core
4.14 (pinned, no `@axe-core/playwright` wrapper), writes the snapshot, fingerprint = sha256 of
normalized HTML + ARIA snapshot, runs only the checks of the declared criteria, detects elements of
undeclared criteria through `PRESENCE`), `scenarios.mjs` (order matters: DOM checks, layout checks
that restore viewport/styles, then keyboard/hover which move the focus), `criteria.mjs`
(`aggregate` per declared criterion). The context uses `bypassCSP` (the fronts' CSP blocks the
injected scripts), a fixed clock and reduced motion for stable fingerprints. `capture.e2e.test.mjs`
seeds known defects (one per main scenario). The rate / 80 % gate (MAIR-319) comes next.

## Node version drift

No shared Node input. `cicd.yml`, `front-libs-cicd.yml`, and both composite actions pin `24`; `BFFs-cicd.yml` and `frontend-cicd.yml` now default to `24` too. When adding a workflow, prefer `24` unless the stack needs otherwise.

## Composite actions (`actions/`)

- **`semantic-tag`** — wraps `cycjimmy/semantic-release-action@v6`; computes the next version, creates the git tag + GitHub Release. Outputs `new_release_published` (`'true'`/`'false'`) and `new_release_version`. Prod promotion steps are guarded by `if: steps.<id>.outputs.new_release_published == 'true'`. Uses the `semantic-release-cargo` plugin, so it also bumps `Cargo.toml` version for Rust repos. Defaults to `github.token`; callers that must push to a protected `main` (e.g. `back-lib-cicd.yml`) override it by passing `env: GITHUB_TOKEN` from a GitHub App token (`actions/create-github-app-token`, secrets `RELEASE_APP_ID` / `RELEASE_APP_PK`).
- **`docker-release`** — centralizes the shared Docker release lifecycle for the stack workflows. One entry point parameterized by `stage` (`dev` | `staging` | `prod`): `dev` builds once (Buildx + GHA cache, SBOM + `mode=max` provenance) and pushes `dev-<sha_tag>` only, scans that digest with Trivy (pinned image, blocking on fixable HIGH/CRITICAL, `.trivyignore` honoured, `scan_fail_on_findings`), signs it with cosign keyless (`sign`, the job needs `id-token: write`), then tags it `dev` (mobile); `staging` resolves the digest of `dev-<sha_tag>`, checks it against `expected_digest` and the signature, tags it `staging-<sha_tag>` / `staging`; `prod` does the same from `staging-<sha_tag>` → `<release_version>` / `latest`, gated on `release_published == 'true'` (the caller runs `semantic-tag` first and passes its outputs in). Outputs `digest` / `extra_digest`, which each workflow chains from job to job. Supports `build_args` (never for secrets: they land in the provenance), `build_secrets` (inline-value secrets), `build_secret_files` / `build_secret_envs` (BFF's two-part `npmrc` file + `NODE_AUTH_TOKEN` env secret, kept as two separate BuildKit secrets so the raw token never appears inside the `.npmrc` content), and an optional `extra_package_name` / `extra_dockerfile` second image (database `liquibase-migrations`). Uniformizes the SHA tag at 7 chars (`sha_length`). Outputs `sha_tag` / `primary_image` too. **Wired into `APIs_cicd.yml`, `BFFs-cicd.yml`, `frontend-cicd.yml` and `database_cicd.yml`** (fronts pass the npm token as the `node_auth_token` secret env, like the BFFs); `semantic-tag` and OpenAPI publishing stay as separate adjacent steps in the caller. Each job that uses it must first checkout `mairie360/CICD` into `cicd-repo/` **before** the docker build step — that checkout ends up inside the build context (`COPY . .` picks it up in the intermediate builder stage only, since every consumer Dockerfile here is multi-stage and the final `COPY --from=builder` never copies it through).
- **`gitleaks`** (MAIR-416) — secret scan with a Gitleaks image pinned by version + digest (not `gitleaks-action`, which needs a paid org license), run as the checkout's uid. Scans only the commits of the run (`pull_request.base.sha..sha`, `event.before..sha`, else the last commit), so the caller checks out with `fetch-depth: 0`; `.gitleaksignore` for rotated secrets. Called after Semgrep in the `security_sast` job of every workflow. Without a `.gitleaks.toml` in the calling repo it mounts its own `actions/gitleaks/gitleaks.toml` (built-in rules + allowlists; MAIR-316 allows only the `jwt_secret:` line of `rgaa.yaml`); a repo config replaces it entirely.
- **`notify-cicd-failure`** — posts the failure to the n8n webhook. Context values and the secret go through `env:` and the JSON is built with `jq -n --arg` (MAIR-416: a forged branch name used to be able to inject shell code); keep it that way.
- **`semgrep`** (MAIR-230) — SAST with a Semgrep image pinned by **version + digest** (input `image`; the org's "major tag" pinning rule does not apply here, bump tag and digest together). Inputs: `config` (space/newline-separated rulesets, one `--config` each), `paths`, `exclude` (defaults to `cicd-repo`, which every workflow checks out inside the workspace), `fail_on_findings` (default `'true'`), `upload_sarif` (default `'false'`, needs `security-events: write`), `sarif_category`, `artifact_name` (`semgrep-sarif`). The scan step never fails by itself: it records the exit code, the SARIF is uploaded (artifact, optionally code scanning), then a last step applies the verdict (exit 1 → findings, fail or warn; any other non-zero → Semgrep error, always fails). Outputs `findings`, `exit_code`, `sarif_file`. Called by the `security_sast` job of **every** stack workflow through the `semgrep_config` / `semgrep_fail_on_findings` workflow inputs (per-stack defaults and the rollout are in `README.md`). Code-scanning upload stays off in the workflows: consumer callers declare top-level `permissions:` without `security-events`, and a nested job cannot request more than its caller grants (startup failure).
- **`publish-openapi-rust`** — `cargo open_api > openapi.json` → `npx -y orval` → publishes `@<org>/<package_name>-openapi` to `npm.pkg.github.com`.
- **`publish-openapi-typescript`** — same intent for TS BFFs; currently a **stub** (only stages a directory, does not publish). Treat as incomplete.
- **`docker/docker_manual_build`** — manual/off-main image build escape hatch; refuses to run on `main`. Composite action taking `package_name` and `github_token`; the caller must pass the token explicitly (composites cannot read `secrets`).

## Per-stack workflow notes

| Workflow | Stack | Extra behavior |
|---|---|---|
| `APIs_cicd.yml` | Rust API | `cargo audit`, `cargo clippy -D warnings`, Semgrep + Gitleaks (`security_sast`, blocking by default since MAIR-416, `build` needs it); coverage via the downstream **`cargo cov` alias** (must run tests, enforce the threshold, and emit `codecov.json`) + Codecov upload (main / PR-to-main, `CODECOV_TOKEN` is a **required** secret); `unit_test` needs only `lint` and runs in parallel with `build` (so `release-dev` needs both); integration tests via the downstream `./integration_test.sh` (Docker Compose, no external service), publishes OpenAPI (rust). Uses `docker-release` for all three release stages; `release-dev` exposes `image` / `sha_tag` outputs and the three test jobs (`integration_tests`, `integration_and_security`, `performance_isolated`) log in to GHCR and export `IMAGE_REF=<image>:dev-<sha_tag>` so the compose stacks test the published image instead of rebuilding from `development.Dockerfile`. The ZAP and k6 jobs also check out `cicd-repo/` for the OpenAPI coverage gate files. |
| `back-lib-cicd.yml` | Rust library | `cargo audit` + `cargo deny check advisories licenses`, Semgrep (report-only by default), `cargo lint_check` (a cargo alias the repo must define), tests run once through `cargo llvm-cov` (which also writes `codecov.json`, MAIR-467) + Codecov upload, `cargo publish` to crates.io, then lands the version bump on `main` through a `chore/release-bump-<version>` PR squash-merged with a `[skip ci]` subject (`main` rejects direct pushes with `GH013`; the release app needs `contents` + `pull_requests` write) |
| `BFFs-cicd.yml` | Node/TS BFF | `npm audit --audit-level=high`, Semgrep via the `semgrep` action (`p/typescript`, `p/owasp-top-ten`, `p/nodejs`, `p/expressjs`, `p/secrets`, `p/dockerfile`, `p/github-actions`, blocking), Docker build with GH Packages `.npmrc` secret, publishes OpenAPI (typescript). Uses `docker-release` for all three release stages; `security_tests`/`performance_tests` target `<image>:dev-<sha_tag>` and check out `cicd-repo/` for the OpenAPI coverage gate files. |
| `frontend-cicd.yml` | Next.js | `npm audit`, Semgrep (blocking by default since MAIR-416), `npm run build`, `npm test` (mandatory, no `--if-present`), Docker image only (no npm publish), npm token as a BuildKit secret (`node_auth_token`). Uses `docker-release` for all three release stages. |
| `front-libs-cicd.yml` | npm component library | Semgrep (report-only by default; `storybook` and `package` need it). Publishes to GitHub Packages via manual git-tag bump (`vMAJOR.MINOR.PATCH`, rolls at 10), deploys Storybook to GitHub Pages when `src/` changed |
| `bffs-lib-cicd.yml` | npm library shared by the BFFs (`bffs_lib`, MAIR-234) | `npm audit`, `npm run lint`, Semgrep (report-only by default, `build` needs it), `npm run build` (tsc), `npm test` (the repo's jest config enforces its coverage thresholds) + Codecov upload (`coverage/lcov.info`, `CODECOV_TOKEN` required). On `main`, `package` runs `semantic-tag`, then sets the version in the workspace only and publishes `@mairie360/bffs-lib` to GitHub Packages when a release is published (no version commit back, like `front-libs`). No Storybook. |
| `database_cicd.yml` | DB + Liquibase | runs `./test.sh`, Semgrep (blocking by default since MAIR-416, `release-dev` needs it), builds two images (`<package_name>` and `liquibase-migrations` from `./liquibase/Dockerfile`) through `docker-release` (`extra_package_name`), so its mobile tags are `dev` / `staging` like the other stacks |
| `cicd.yml` | **this repo** | semantic-release on push to `main` (angular preset, `feat`→minor / `fix`,`perf`→patch) |
| `auto-approve.yml` | — | auto-approves `renovate[bot]` PRs (`pull_request_target`) |

## What downstream repos must provide

Depending on which workflow they call: a root `Dockerfile`; a `docker-compose.test.yml` exposing services named `security-scan` (ZAP), `k6-perf-test` or `db-test` (jobs use `--exit-code-from <that service>`); for `APIs_cicd.yml`, an `integration_test.sh` (same shape as `security_test.sh`) driving a `docker-compose-integration.yml` whose test-runner service exercises the API and sets the exit code; for `APIs_cicd.yml` and `BFFs-cicd.yml`, compose stacks whose service under test reads `${IMAGE_REF}` (no `build:` block), `*_test.sh` scripts that build a local image and export `IMAGE_REF` themselves when the variable is empty and clone `cicd-repo/` at the pinned `cicd_version` when it is absent, a ZAP service that mounts `cicd-repo/tests/zap/zap_hooks.py` and passes it with `--hook`, and a `load-test.js` built on `cicd-repo/tests/k6/coverage.js` with one handler per operation of `openapi.json`; for `frontend-cicd.yml`, a `rgaa.yaml`, an `accessibility_test.sh` and a `docker-compose-accessibility.yml` whose front reads `${IMAGE_REF}` and whose `a11y` runner service runs `cicd-repo/tests/a11y/run.sh` (ZAP / k6 stacks read `${IMAGE_REF}` too); for `front-libs-cicd.yml`, a `rgaa.yaml` of Storybook stories; `test.sh` (database); npm scripts `lint` / `build` / `test` / `typecheck` / `build-storybook`; cargo commands `cargo open_api` and the `cargo lint_check` alias (plus the `cargo cov` alias for `APIs_cicd.yml`, which must emit `codecov.json` and enforce the coverage threshold itself); an `openapi-spec.json` / `openapi.json` at repo root for OpenAPI publishing.

## Conventions

- Commit messages: Conventional Commits (angular) — `feat:`, `fix:`, `perf:`, `chore(deps):`, breaking via `!` or footer. This drives every semantic-release version bump.
- Pin third-party actions by major tag (`@v7`); the org's own refs use `inputs.cicd_version`. Exception: actions that publish no floating major tag (e.g. `sigstore/cosign-installer`, only `vX.Y.Z`) are pinned by full version, since `@vN` fails to resolve at job start.
- Codecov uploads are **never blocking** (`fail_ci_if_error: false` everywhere, MAIR-467): Codecov only reports coverage, thresholds are enforced by the test commands (`cargo cov`, jest config). A Codecov outage (expired certificate on 2026-10-05) used to fail `unit_test` and skip every release.
- Every job that starts a Docker stack (`*_test.sh`, `test.sh`) is bounded (MAIR-468): job `timeout-minutes` (25 for APIs / fronts / database, 60 for BFFs) and, outside the BFFs, a 15 min step timeout followed by an `if: failure()` "Dump container logs" step. A stack that never gets ready (e.g. a `*-ready` service polling `/health` forever) used to hold a runner for GitHub's 6 h default and starve the whole org's queue.
- French is used in comments and step names throughout; `# [CHANGEMENT]` / `# [NOUVEAU]` mark deliberate deviations from a previous version — keep annotating significant changes the same way.

## Pull request reviewers

Every PR requests a review from the whole team, minus its author: `CarolinHugo`, `LAURETbenjamin`, `MathTek` and `Quentintnrl` (`gh pr create … --reviewer CarolinHugo,LAURETbenjamin,MathTek`). `.github/CODEOWNERS` makes GitHub request them automatically as well.
