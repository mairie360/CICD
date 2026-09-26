# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Centralized CI/CD for the **mairie360** GitHub org (project "Mairie360"). It contains **no application code** — only:

- **Reusable workflows** in `.github/workflows/*_cicd.yml` (`on: workflow_call`), consumed by the org's application repos.
- **Composite actions** in `actions/*/action.yml`, invoked by those reusable workflows.
- **Shared test files** in `tests/` (`zap/zap_hooks.py`, `k6/coverage.js`): the OpenAPI coverage
  gate mounted by the consumers' ZAP / k6 compose stacks (see "OpenAPI coverage gate" below).
- This repo's own release pipeline (`.github/workflows/cicd.yml` + `.releaserc.json`), plus Renovate automation.

There is nothing to build, run, or unit-test locally. Changes are validated by the downstream repos that call these workflows. If you want static validation, run [`actionlint`](https://github.com/rhysd/actionlint) against `.github/workflows/` and `actions/`. The two files under `tests/` can be exercised by hand: `python3` with a fake `zap` object for the hook, `docker run grafana/k6` for the module.

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
dependencies → (lint, security_audit, security_sast) → build → test
  → release-dev        (environment: Dev)    build+push image, dev-<sha_tag> / dev
  → security_tests (OWASP ZAP)  + performance_tests (k6)   [run in parallel, main only]
  → release-staging    (environment: Staging) RE-TAG dev image → staging-<sha_tag> / staging
  → release-prod       (environment: Prod)    semantic-tag → RE-TAG staging image → <semver> / latest
```

Key invariants:

- **Images are built exactly once** (in `release-dev`). Staging and prod "releases" only `docker pull` + `docker tag` + `docker push` (via the shared `docker-release` action, on `APIs_cicd.yml` / `BFFs-cicd.yml` / `frontend-cicd.yml`) — never rebuild. Preserve this; rebuilding per-environment is a regression. `database_cicd.yml` is not migrated yet and still promotes inline.
- Deploy jobs gated on `if: github.ref == 'refs/heads/main'`. Note: in `APIs_cicd.yml` only `release-dev` (and the test jobs) carry the explicit `if`; `release-staging` / `release-prod` are gated **transitively** — their `needs` chain is main-only, so they skip off-main because a skipped dependency skips its dependents. Keep that chain intact if you reorder jobs.
- GitHub **Environments** (`Dev`, `Staging`, `Prod`, `Release`, and the misc `release`/`releasee` in `front-libs`) hold the approval gates and environment-scoped secrets. Environment names are load-bearing strings.
- Image registry is GHCR: `ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/<package_name>`. The `,,` lowercases the owner — this is **bash** parameter expansion and only works inside `run:` blocks, not in `${{ }}` expressions.
- Short SHA convention: the `docker-release` action uniformizes the SHA tag at 7 chars (`sha_length` input) for every stack it's wired into, computed once in `steps.meta` and reused for `dev-`/`staging-` tags at every stage — no more per-job `${GITHUB_SHA::7}` recomputation to keep in sync. `database_cicd.yml`, not yet migrated, still does its own (buggy, see below).

## Known landmines (unfixed as of this branch)

These are live bugs in the workflows — don't copy the pattern, and fix in place if you touch the job:

- **`database_cicd.yml`** `database_tests` references `needs.release-dev.outputs.sha_tag`, but `release-dev` declares no `outputs:` block — the value is always empty. Same job uses `${{ github.repository_owner,, }}` inside `${{ }}`; bash `,,` lowercasing does **not** work there (only in `run:` blocks), so `REPO` gets a mixed-case owner. Not migrated to `docker-release` yet, so it doesn't benefit from the fix described above.
- **`publish-openapi-typescript`** only creates a staging directory — it compiles and publishes nothing. Any BFF relying on OpenAPI type publishing gets a silent no-op.
- **Cross-repo drift (`Devops/Deploiment`)**: `docker-release` pushes mobile tags `dev` / `staging` (plus `<version>` / `latest` in prod), not the `dev-latest` / `staging-latest` the Argo CD umbrella chart's `dev`/`staging` instance `values.yaml` still pin for every image. This has been silently stale for the APIs since the `APIs_cicd.yml` pilot (their `dev-latest`/`staging-latest` tags stopped being pushed then); migrating `BFFs-cicd.yml` and `frontend-cicd.yml` to `docker-release` extends the same drift to every BFF and front. `Deploiment`'s values files need `dev-latest`/`staging-latest` → `dev`/`staging` before those environments will pick up new images again.

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

## Node version drift

No shared Node version. `cicd.yml`, `front-libs-cicd.yml`, and both composite actions pin `24`; `BFFs-cicd.yml` defaults to `20`; `frontend-cicd.yml` defaults to `23`. When adding a workflow, prefer `24` unless the stack needs otherwise.

## Composite actions (`actions/`)

- **`semantic-tag`** — wraps `cycjimmy/semantic-release-action@v6`; computes the next version, creates the git tag + GitHub Release. Outputs `new_release_published` (`'true'`/`'false'`) and `new_release_version`. Prod promotion steps are guarded by `if: steps.<id>.outputs.new_release_published == 'true'`. Uses the `semantic-release-cargo` plugin, so it also bumps `Cargo.toml` version for Rust repos. Defaults to `github.token`; callers that must push to a protected `main` (e.g. `back-lib-cicd.yml`) override it by passing `env: GITHUB_TOKEN` from a GitHub App token (`actions/create-github-app-token`, secrets `RELEASE_APP_ID` / `RELEASE_APP_PK`).
- **`docker-release`** — centralizes the shared Docker release lifecycle for the stack workflows. One entry point parameterized by `stage` (`dev` | `staging` | `prod`): `dev` builds once (Buildx + GHA cache) and pushes `dev-<sha_tag>` / `dev` (mobile); `staging` re-tags `dev` (mobile) → `staging-<sha_tag>` / `staging` (mobile); `prod` re-tags `staging` (mobile) → `<release_version>` / `latest`, gated on `release_published == 'true'` (the caller runs `semantic-tag` first and passes its outputs in). Supports `build_args` (frontend `NODE_AUTH_TOKEN`), `build_secrets` (inline-value secrets), `build_secret_files` / `build_secret_envs` (BFF's two-part `npmrc` file + `NODE_AUTH_TOKEN` env secret, kept as two separate BuildKit secrets so the raw token never appears inside the `.npmrc` content), and an optional `extra_package_name` / `extra_dockerfile` second image (database `liquibase-migrations`). Uniformizes the SHA tag at 7 chars (`sha_length`). Outputs `sha_tag` / `primary_image`. **Wired into `APIs_cicd.yml`, `BFFs-cicd.yml` and `frontend-cicd.yml`**; `semantic-tag` and OpenAPI publishing stay as separate adjacent steps in the caller. `database_cicd.yml` is not migrated yet and still promotes inline. Each job that uses it must first checkout `mairie360/CICD` into `cicd-repo/` **before** the docker build step — that checkout ends up inside the build context (`COPY . .` picks it up in the intermediate builder stage only, since every consumer Dockerfile here is multi-stage and the final `COPY --from=builder` never copies it through).
- **`semgrep`** (MAIR-230) — SAST with a Semgrep image pinned by **version + digest** (input `image`; the org's "major tag" pinning rule does not apply here, bump tag and digest together). Inputs: `config` (space/newline-separated rulesets, one `--config` each), `paths`, `exclude` (defaults to `cicd-repo`, which every workflow checks out inside the workspace), `fail_on_findings` (default `'true'`), `upload_sarif` (default `'false'`, needs `security-events: write`), `sarif_category`, `artifact_name` (`semgrep-sarif`). The scan step never fails by itself: it records the exit code, the SARIF is uploaded (artifact, optionally code scanning), then a last step applies the verdict (exit 1 → findings, fail or warn; any other non-zero → Semgrep error, always fails). Outputs `findings`, `exit_code`, `sarif_file`. Called by the `security_sast` job of **every** stack workflow through the `semgrep_config` / `semgrep_fail_on_findings` workflow inputs (per-stack defaults and the rollout are in `README.md`). Code-scanning upload stays off in the workflows: consumer callers declare top-level `permissions:` without `security-events`, and a nested job cannot request more than its caller grants (startup failure).
- **`publish-openapi-rust`** — `cargo open_api > openapi.json` → `npx -y orval` → publishes `@<org>/<package_name>-openapi` to `npm.pkg.github.com`.
- **`publish-openapi-typescript`** — same intent for TS BFFs; currently a **stub** (only stages a directory, does not publish). Treat as incomplete.
- **`docker/docker_manual_build`** — manual/off-main image build escape hatch; refuses to run on `main`. **Currently malformed**: the file mixes reusable-workflow syntax (`on: workflow_call`, top-level `permissions:`) with composite-action syntax and uses `run:` where a composite needs `runs:`. It is neither a valid composite action nor a valid workflow as written — fix the shape before relying on it.

## Per-stack workflow notes

| Workflow | Stack | Extra behavior |
|---|---|---|
| `APIs_cicd.yml` | Rust API | `cargo audit`, `cargo clippy -D warnings`, Semgrep (`security_sast`, report-only by default, `build` needs it); coverage via the downstream **`cargo cov` alias** (must run tests, enforce the threshold, and emit `codecov.json`) + Codecov upload (main / PR-to-main, `CODECOV_TOKEN` is a **required** secret); `unit_test` needs only `lint` and runs in parallel with `build` (so `release-dev` needs both); integration tests via the downstream `./integration_test.sh` (Docker Compose, no external service), publishes OpenAPI (rust). Uses `docker-release` for all three release stages; `release-dev` exposes `image` / `sha_tag` outputs and the three test jobs (`integration_tests`, `integration_and_security`, `performance_isolated`) log in to GHCR and export `IMAGE_REF=<image>:dev-<sha_tag>` so the compose stacks test the published image instead of rebuilding from `development.Dockerfile`. The ZAP and k6 jobs also check out `cicd-repo/` for the OpenAPI coverage gate files. |
| `back-lib-cicd.yml` | Rust library | `cargo audit` + `cargo deny check advisories licenses`, Semgrep (report-only by default), `cargo lint_check` (a cargo alias the repo must define), Codecov upload, `cargo publish` to crates.io, commits version bump to `main` |
| `BFFs-cicd.yml` | Node/TS BFF | `npm audit --audit-level=high`, Semgrep via the `semgrep` action (`p/typescript`, `p/owasp-top-ten`, `p/nodejs`, `p/expressjs`, `p/secrets`, `p/dockerfile`, `p/github-actions`, blocking), Docker build with GH Packages `.npmrc` secret, publishes OpenAPI (typescript). Uses `docker-release` for all three release stages; `security_tests`/`performance_tests` target `<image>:dev-<sha_tag>` and check out `cicd-repo/` for the OpenAPI coverage gate files. |
| `frontend-cicd.yml` | Next.js | `npm audit`, Semgrep (report-only by default), `npm run build`, Docker image only (no npm publish). Uses `docker-release` for all three release stages. |
| `front-libs-cicd.yml` | npm component library | Semgrep (report-only by default; `storybook` and `package` need it). Publishes to GitHub Packages via manual git-tag bump (`vMAJOR.MINOR.PATCH`, rolls at 10), deploys Storybook to GitHub Pages when `src/` changed |
| `database_cicd.yml` | DB + Liquibase | runs `./test.sh`, Semgrep (report-only by default, `release-dev` needs it), builds two images (`<package_name>` and `liquibase-migrations` from `./liquibase/Dockerfile`), migration/integrity tests |
| `cicd.yml` | **this repo** | semantic-release on push to `main` (angular preset, `feat`→minor / `fix`,`perf`→patch) |
| `auto-approve.yml` | — | auto-approves `renovate[bot]` PRs (`pull_request_target`) |

## What downstream repos must provide

Depending on which workflow they call: a root `Dockerfile`; a `docker-compose.test.yml` exposing services named `security-scan` (ZAP), `k6-perf-test` or `db-test` (jobs use `--exit-code-from <that service>`); for `APIs_cicd.yml`, an `integration_test.sh` (same shape as `security_test.sh`) driving a `docker-compose-integration.yml` whose test-runner service exercises the API and sets the exit code; for `APIs_cicd.yml` and `BFFs-cicd.yml`, compose stacks whose service under test reads `${IMAGE_REF}` (no `build:` block), `*_test.sh` scripts that build a local image and export `IMAGE_REF` themselves when the variable is empty and clone `cicd-repo/` at the pinned `cicd_version` when it is absent, a ZAP service that mounts `cicd-repo/tests/zap/zap_hooks.py` and passes it with `--hook`, and a `load-test.js` built on `cicd-repo/tests/k6/coverage.js` with one handler per operation of `openapi.json`; `test.sh` (database); npm scripts `lint` / `build` / `test` / `typecheck` / `build-storybook`; cargo commands `cargo open_api` and the `cargo lint_check` alias (plus the `cargo cov` alias for `APIs_cicd.yml`, which must emit `codecov.json` and enforce the coverage threshold itself); an `openapi-spec.json` / `openapi.json` at repo root for OpenAPI publishing.

## Conventions

- Commit messages: Conventional Commits (angular) — `feat:`, `fix:`, `perf:`, `chore(deps):`, breaking via `!` or footer. This drives every semantic-release version bump.
- Pin third-party actions by major tag (`@v7`); the org's own refs use `inputs.cicd_version`.
- French is used in comments and step names throughout; `# [CHANGEMENT]` / `# [NOUVEAU]` mark deliberate deviations from a previous version — keep annotating significant changes the same way.

## Pull request reviewers

Every PR requests a review from the whole team, minus its author: `CarolinHugo`, `LAURETbenjamin`, `MathTek` and `Quentintnrl` (`gh pr create … --reviewer CarolinHugo,LAURETbenjamin,MathTek`). `.github/CODEOWNERS` makes GitHub request them automatically as well.
