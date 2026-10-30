# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Centralized CI/CD for the **mairie360** GitHub org (project "Mairie360"). It contains **no application code** — only:

- **Reusable workflows** in `.github/workflows/*_cicd.yml` (`on: workflow_call`), consumed by the org's application repos.
- **Composite actions** in `actions/<type>/<stack>/action.yml` (MAIR-493, see "Composite actions" below), invoked by those reusable workflows.
- **Shared test files** in `tests/` (`zap/zap_hooks.py`, `k6/coverage.js`): the OpenAPI coverage
  gate mounted by the consumers' ZAP / k6 compose stacks (see "OpenAPI coverage gate" below),
  and `gdpr/`, the GDPR checks: the inventory gate of the database and the log marker test of
  the APIs and BFFs (see "GDPR inventory gate" and "GDPR log marker" below).
- This repo's own release pipeline (`.github/workflows/cicd.yml` + `.releaserc.json`), plus Renovate automation.

Apart from `tests/gdpr` (`npm ci && npm test` there, also the `gdpr` job of `lint.yml`), there is nothing to build, run, or unit-test locally. Changes are validated by the downstream repos that call these workflows. `.github/workflows/lint.yml` runs [`actionlint`](https://github.com/rhysd/actionlint) on every PR and, as a reusable workflow, as the `lint` job that `cicd.yml`'s `release` depends on (SC2086/SC2016/SC2129 shellcheck findings are ignored until the existing ones are cleaned up) and checks that each `actions/**/action.yml` has a `runs:` block; run the same locally with `docker run --rm -v "$PWD":/repo -w /repo rhysd/actionlint:1.7.12`. The two files under `tests/` can be exercised by hand: `python3` with a fake `zap` object for the hook, `docker run grafana/k6` for the module.

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

**Composite actions are not called directly across repos.** Each reusable workflow re-checks-out `mairie360/CICD` at `${{ inputs.cicd_version }}` into `cicd-repo/`, then uses `./cicd-repo/actions/<type>/<stack>` (or `./cicd-repo/actions/<group>/<name>` for the release, shared security and notify actions). This is why `cicd_version` is a required input on almost every workflow. When you change a composite action's inputs/outputs, every reusable workflow that consumes it (and every downstream caller) must be updated in lockstep.

Every stack workflow, `front-libs-cicd.yml` included, now takes `cicd_version` and checks out `cicd-repo/` (at least for `security/semgrep` and `notify/cicd-failure`). Since MAIR-493 every check job checks it out too, to run its `actions/<type>/<stack>` action: the jobs that did not need this repo before only check out `actions/` (`sparse-checkout: actions`) so that the consumer's own tools (`eslint .`, jest, cargo, a `COPY . .` build context) never see this repo's files; the jobs that already checked it out (`security_sast`, ZAP / k6, release and notify jobs) keep the full checkout, since the ZAP / k6 stacks mount `cicd-repo/tests/`.

## Release / promotion model (shared by all stack workflows)

Since v4.4.0 (MAIR-494) a push to `main` stops at `release-dev`; staging and prod are manual runs of
two reusable workflows, called by a `promote-staging.yml` / `promote-prod.yml` of each service repo
(`workflow_dispatch` on main, `sha` input). Shape of `APIs_cicd`, `BFFs-cicd`, `frontend-cicd`,
`database_cicd`, then of the promotions:

```
dependencies → (lint, security_audit, security_sast) → build ∥ test   (unit tests only need lint, run in parallel with build)
  → release-dev        (no environment)      build once + SBOM/provenance → dev-<sha_tag> → Trivy → cosign sign → dev

promote-staging.yml   resolve (dev-<sha> exists, main run green) → integration (APIs, BFFs) ∥ ZAP ∥ k6 on <image>:dev-<sha>
                      → promote (environment: Staging) verify + RE-TAG digest of dev-<sha> → staging-<sha> / staging
promote-prod.yml      resolve (staging-<sha> exists) → version (semantic-release dry run on the commit) → [release_folder, database]
                      → promote (environment: Prod) tag + GitHub release on the commit → RE-TAG digest of staging-<sha> → <semver> / latest
```

Key invariants:

- **Images are built exactly once** (in `release-dev`). Staging and prod "releases" only add tags to an existing digest (`docker buildx imagetools create`, via the shared `docker-release` action, on all four stack workflows) — never rebuild. Preserve this; rebuilding per-environment is a regression.
- **Promotion is by digest of the promoted commit** (MAIR-416, MAIR-494): staging resolves `dev-<sha>`, prod resolves `staging-<sha>` of the commit `actions/promote/resolve` picked (`source_sha` of `docker-release`, which is not the run's `GITHUB_SHA`: a promotion runs on main's tip), each checked against the digest `resolve` read (`expected_digest`) and against its cosign signature (`--certificate-github-workflow-sha` = that commit). Never promote from a mobile tag (`dev`, `staging`, `latest`): an approval can wait for hours while another commit moves it.
- `release-dev` is gated on `if: github.ref == 'refs/heads/main'`; the promotions' `resolve` job on the default branch, and every other promotion job needs it.
- **Prod tags a commit that is usually behind main's tip** (Renovate keeps merging): `actions/promote/next-version` runs semantic-release in dry-run against a local bare mirror where `main` is that commit (`url.<mirror>.insteadOf` on `<repo url>` and `<repo url>.git`: semantic-release reads `origin`, which has no `.git`, and cycjimmy's `repository_url` input never reaches it; `actions/promote/next-version/tests` runs that step), then `actions/promote/create-release` pushes the `v<version>` tag with a token of the release app Acme-Global-Bot (`contents` + `workflows` write) and creates the GitHub release on it (`--verify-tag`) with GITHUB_TOKEN. GitHub refuses a new ref from an app without `workflows` when the commit's workflows differ from main's (always the case once Renovate bumped the CICD pin), and GITHUB_TOKEN can never have that permission. The app must keep `Workflows: write`, and since its tag push starts workflows, a service's `on.push` must filter `branches`. `release/semantic-tag` (which tags main's tip) is no longer used by the service stacks, only by the libraries.
- **Promotions create no CI-triggering commit**: the journal commit is `[skip ci]`, the tag (pushed alone by `create-release`, with the release app token) starts no pipeline as long as the services' `on.push` filters `branches`, and the release uses the run's `GITHUB_TOKEN`. `actions/promote/resolve/tests` asserts it; keep `git push` / `git commit` out of the promote workflows and any push other than that tag out of `create-release`.
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

## GDPR inventory gate (`tests/gdpr/`, MAIR-285, epic MAIR-284)

The inventory itself lives in the Database repo (`gdpr/inventory.yaml`, format documented in its
header): this repo only holds the check. `inventory.mjs` (`parseInventory` format check with
readable errors, `compare` with the migrated schema: unclassified columns, stale entries, columns
referencing `users` not classified `identifier`; `diff` between two inventories), `ai.mjs`
(Claude proposes an entry per unclassified column, `client.beta.messages.parse` +
`betaZodOutputFormat`, default `claude-sonnet-5-5` / `GDPR_AI_MODEL`, the whole inventory as a
cached system block; errors only leave the proposals out), `check.mjs` (CLI: exit 0 / 1 gap /
2 invalid input; writes `summary.md`, `report.json`, `proposals.yaml`). The proposals never change
the exit code. Placement: the `gdpr_inventory` job of `promote-prod.yml` (database only), between
`version` and `promote`, so that the Prod approver reads the summary (inventory changes since the
last tag) before approving; a PR that adds a column is not blocked, the next prod release is. `inventory.test.mjs` mocks the
client; no test calls the real API.

## GDPR log marker (`tests/gdpr/marker/`, MAIR-290, epic MAIR-284)

Each API / BFF declares its journey in `gdpr-marker.yaml` and provides
`docker-compose-gdpr-marker.yml` + `gdpr_marker_test.sh` (templates in `README.md`); this repo
only holds the engine. `marker.mjs` (`generateMarker`: unique values that pass the usual
validations; `needles`: raw, URL-encoded, JSON-escaped, base64 at the three alignments, national
phone number, sensitive captures), `journey.mjs` (`loadJourney`: format check with readable
errors, unknown placeholders included; `play`: steps in order, stops at the first unexpected
status, captures from `body.` / `header.` / `cookie.`), `run.mjs` (runner, inside the stack
through `run.sh`, like `tests/a11y`: copies `/engine` out of the read-only mount before `npm ci`;
writes `marker.json`, never prints a value), `scan.mjs` (no dependency, runs on a plain
`node:24` image after `docker compose logs --no-color > containers.log`: attributes each line to
its service, skips the `gdpr-marker` runner and the `ignore`d services, masks the values in the
excerpts; exit 0 / 1 leak or journey failed / 2 missing input). Placement: `gdpr_marker` job of
`promote-prod.yml` (APIs and BFFs), between `version` and `promote`, on `<image>@<staging digest>`
of the promoted commit, before the Prod approval. `marker.test.mjs` includes an end-to-end run against a local
HTTP server (clean and leaky).

## GDPR contract and Semgrep rules (`tests/gdpr/contract/`, `tests/semgrep/gdpr/`, MAIR-291)

`contract/contract.mjs` walks every response schema of an OpenAPI document (`$ref` with cycle
guard, `allOf`/`oneOf`/`anyOf`, `items`, `additionalProperties`) and fails on a field carrying a
`credentials` column of the inventory (same name, or mapped under `fields` in the consumer's
`gdpr-contract.yaml`), unless `allow` lists it with a reason; `contract/ai.mjs` asks Claude a column
for the unmapped names, cached by fingerprint (`GDPR_AI_CACHE`, `actions/cache` in the action),
never deciding; `contract/check.mjs` is the CLI (exit 0 / 1 violation / 2 invalid input). The
inventory comes from mairie360/Database (`gdpr_inventory_ref`). The action is
`actions/security/gdpr-contract` (a check of every event, like Semgrep; the promotion gates of
MAIR-285 / MAIR-290 are under `actions/promote/`), the `gdpr_contract` job of `APIs_cicd.yml` (on
`cargo open_api`) and `BFFs-cicd.yml` (on the `openapi-spec` artifact) runs on every event;
`release-dev` does not need it, but a failure blocks promote-staging (main run not green). The per-operation personal
columns of `report.json` are the input of the access matrix (MAIR-288, not decided yet). The
Semgrep rules (`tests/semgrep/gdpr/<rule>.yml` + annotated `<rule>.<ext>`, `semgrep --test` in
`lint.yml`) are in every workflow's default `semgrep_config`. Gitleaks already runs everywhere
(MAIR-416); the subcontractor-domain rule waits for the decision file of MAIR-294.

## GDPR PR checklist (`tests/gdpr/pr/`, `gdpr-pr-cicd.yml`, MAIR-295)

`pr/checklist.mjs` reads the "Personal data" section of the PR description (template of
mairie360/.github): exactly one of `- [x] No` / `- [x] Yes`, and for "Yes" the inventory (changed in
the PR when the repo holds it, `inventory_path`; else a non-placeholder `Inventory:` line).
`pr/ai.mjs` asks Claude about the diff (cached by model + diff + answer), warning only.
`pr/check.mjs` is the CLI (exit 0 / 1 / 2). Action `actions/security/gdpr-pr-checklist`, reusable workflow
`gdpr-pr-cicd.yml`, called by a per-repo `gdpr-pr.yml` on `pull_request` with the `edited` type (the
stack workflows do not get `edited` events).

## Node version drift

No shared Node input. `cicd.yml`, the library actions (`actions/*/bffs-lib`, `actions/*/front-lib`, used by `bffs-lib-cicd.yml` / `front-libs-cicd.yml`) and the release actions that run Node (`semantic-tag`, `publish-openapi-*`) pin `24`; `BFFs-cicd.yml` and `frontend-cicd.yml` now default to `24` too. When adding a workflow, prefer `24` unless the stack needs otherwise.

## Composite actions (`actions/`)

Tree (MAIR-493, epic MAIR-492): one folder per check type, then one per stack.

```
actions/
  dependencies/<stack>   install (+ dependency audit where the stack runs one)   apis bffs fronts back-lib bffs-lib front-lib
  lint/<stack>           lint command                                             apis bffs fronts back-lib bffs-lib front-lib
  build/<stack>          build + build artifacts                                  apis bffs fronts back-lib bffs-lib front-lib
  unit-tests/<stack>     tests + Codecov upload                                   apis bffs fronts back-lib bffs-lib front-lib db
  integration/<stack>    integration tests against the dev image                  apis, bffs (newman collection, junit summary + artifact)
  integration/container-logs   "Dump container logs" step shared by every job that starts a Docker stack
  integration/frontend-isolated-qa   target.py of frontend-isolated-qa.yml (ZAP / k6 of a front against a verified dev digest)
  security/<stack>       stack-specific security check                            apis bffs fronts (ZAP) back-lib (cargo audit/deny) front-lib (npm audit + typecheck)
  security/gdpr-contract   GDPR check of the OpenAPI contract (MAIR-291, APIs / BFFs, every event)
  security/gdpr-pr-checklist   GDPR question of the PR description (MAIR-295, gdpr-pr-cicd.yml)
  security/semgrep, security/gitleaks   cross-stack SAST / secret scan (security_sast job of every workflow but the fronts')
  security/semgrep-pypi, security/gitleaks-binary   same scans from the hash-checked Semgrep wheel / Gitleaks release binary, no Docker Hub pull (fronts, frontend-dev-exception.yml, lint.yml)
  performance/<stack>    load / bench test                                        apis bffs fronts (k6) db (schema bench)
  release/               docker-release, semantic-tag, publish-openapi-rust, publish-openapi-typescript, release-folder, release-journal, docker-manual-build,
                         frontend-dev-exception (check_policy.py of frontend-dev-exception.yml)
  promote/               resolve (commit + checks), next-version (dry run on a commit behind main), create-release; the prod gates of MAIR-492 go here:
                         gdpr-inventory (MAIR-285, database), gdpr-marker (MAIR-290, APIs / BFFs)
  notify/cicd-failure    n8n failure notification
```

Rules:

- A check job reads as: checkout the repo, checkout `mairie360/CICD` into `cicd-repo/`, then one (or a few) `uses: ./cicd-repo/actions/<type>/<stack>`. The action holds the job's whole toolchain setup (setup-node / rust-toolchain, caches, `npm ci`), the command and its uploads; only add an action for a check a workflow actually runs.
- Secrets cannot be read in a composite action: the workflow passes them as inputs (`node_auth_token`, `codecov_token`, `github_token`), like the release actions.
- Step timeouts stay on the workflow step that uses the action (composite steps cannot take `timeout-minutes`). Whatever must stay outside that timeout stays a workflow step of its own: the GHCR login of the API test jobs, the `integration/container-logs` dump (`if: failure()`, it must still run when the timeout kills the action), the database's Codecov upload and bench artifact.
- Composite `run:` steps need an explicit `shell:`; they use `shell: bash` (`-eo pipefail`) where the workflows had GitHub's default `bash -e {0}`: none of the moved commands has a pipeline, so the result is the same.
- `dependencies/<stack>` takes `audit: 'true'` for the BFF / front `security_audit` jobs (`npm audit --audit-level=high` after the same install).

Release, shared and notify actions:

- **`release/semantic-tag`** — wraps `cycjimmy/semantic-release-action@v6`; computes the next version, creates the git tag + GitHub Release. Outputs `new_release_published` (`'true'`/`'false'`), `new_release_version` and `last_release_git_tag`. `dry_run: 'true'` (MAIR-491) only computes them; semantic-release still checks it could push, so the job needs `contents: write`. Prod promotion steps are guarded by `if: steps.<id>.outputs.new_release_published == 'true'`. Uses the `semantic-release-cargo` plugin, so it also bumps `Cargo.toml` version for Rust repos. Defaults to `github.token`; callers that must push to a protected `main` (e.g. `back-lib-cicd.yml`) override it by passing `env: GITHUB_TOKEN` from a GitHub App token (`actions/create-github-app-token`, secrets `RELEASE_APP_ID` / `RELEASE_APP_PK`).
- **`release/docker-release`** — centralizes the shared Docker release lifecycle for the stack workflows. One entry point parameterized by `stage` (`dev` | `staging` | `prod`): `dev` builds once (Buildx + GHA cache, SBOM + `mode=max` provenance) and pushes `dev-<sha_tag>` only, scans that digest with Trivy (pinned image, blocking on fixable HIGH/CRITICAL, `.trivyignore` honoured, `scan_fail_on_findings`), signs it with cosign keyless (`sign`, the job needs `id-token: write`), then tags it `dev` (mobile); `staging` resolves the digest of `dev-<sha_tag>`, checks it against `expected_digest` and the signature, tags it `staging-<sha_tag>` / `staging`; `prod` does the same from `staging-<sha_tag>` → `<release_version>` / `latest`, gated on `release_published == 'true'` (promote-prod passes the version `next-version` computed). Outputs `digest` / `extra_digest`, which each workflow chains from job to job. Supports `build_args` (never for secrets: they land in the provenance), `build_secrets` (inline-value secrets), `build_secret_files` / `build_secret_envs` (BFF's two-part `npmrc` file + `NODE_AUTH_TOKEN` env secret, kept as two separate BuildKit secrets so the raw token never appears inside the `.npmrc` content), and an optional `extra_package_name` / `extra_dockerfile` second image (database `liquibase-migrations`). Uniformizes the SHA tag at 7 chars (`sha_length`). Outputs `sha_tag` / `primary_image` too. `source_sha` (MAIR-494, staging / prod only) names the promoted commit when it is not the run's own. **Wired into `APIs_cicd.yml`, `BFFs-cicd.yml`, `frontend-cicd.yml` and `database_cicd.yml`** (fronts pass the npm token as the `node_auth_token` secret env, like the BFFs); `semantic-tag` and OpenAPI publishing stay as separate adjacent steps in the caller. Each job that uses it must first checkout `mairie360/CICD` into `cicd-repo/` **before** the docker build step — that checkout ends up inside the build context (`COPY . .` picks it up in the intermediate builder stage only, since every consumer Dockerfile here is multi-stage and the final `COPY --from=builder` never copies it through).
- **`release/release-folder`** (MAIR-491) — Database only. `check_release_folder.py` (standard library) compares the Liquibase release changesets (everything `changelog.xml` includes outside `repeatable/`) at the last tag and in the checkout, by identity (`id`, `author`, logical file path: `logicalFilePath` of the changeset, else of its changelog, else the include path) and content (attributes, children, SQL files by content hash; paths ignored, so moving a file is fine). Findings: a shipped changeset modified or gone (a changeset holding only a `tagDatabase` may go), a new changeset outside `releases/v<next>/` or with no release cut, `releases/v<next>/` not closed by a `tag-v<next>` changeset, a new changeset without `logicalFilePath="releases"` and an id `mair-<n>-NN` / `tag-vX.Y.Z`. A new `tagDatabase` of an earlier git tag is allowed in that tag's folder (tags added after the fact by MAIR-490). Inputs `last_tag`, `next_version` (no `v`, empty when no release), `liquibase_dir`; the report goes to the job summary. Run it by hand with `python3 actions/release/release-folder/check_release_folder.py <Database checkout> <last tag> <next version or "">`.
- **`release/release-journal`** — last step of `release-dev` of the four stack workflows and of the `promote` job of promote-staging / promote-prod (which pass the promoted commit as `sha`), `continue-on-error: true` so it never fails a release. Checks out main's tip into `.release-journal/`, then `release_journal.py prepare` reads the state kept in the journal (HTML comment `release-journal-state`: dev / staging commits, prod tag), moves the pointer of the stage forward only (an older run finishing late never moves it back), lists the first-parent commits of main since the last `v*` tag, dev → staging and staging → prod (journal commits left out) with their PR (GitHub API, else the squash `(#n)`), and writes the Messages API request, which also carries each commit's diff once (lockfiles, snapshots, `.svg` / `.min.js` and the journal left out; 15 000 characters per commit, 400 000 per request, then the file list only) so Claude describes the functional changes (routes, fields, rules, screens, errors, columns) rather than paraphrasing the PRs; `curl` calls Claude (`claude-haiku-5-5`, effort `medium`, JSON-schema output, no `fallbacks`: Haiku 5.5 has no server-side fallback) with the org secret `ANTHROPIC_API_KEY` (optional workflow secret); `render` writes `RELEASE_JOURNAL.md` in French (state table, three sections, last 50 promotions), with plain commit lists when the key is missing or the answer is unusable. Commits `docs(release-journal): <stage> <sha|vX> [skip ci]` straight on main with a token of the org's release app Acme-Global-Bot (`actions/create-github-app-token`, org secrets `RELEASE_APP_ID` / `RELEASE_APP_PK`, optional workflow secrets), which must be a bypass actor (integration `2844369`) of the repo's main rulesets: the GitHub Actions app cannot be one (422, not installed on the org), and the `[skip ci]` subject keeps the app's push from starting a pipeline, retrying from the new tip when the push is rejected. Because those commits land after the dev / staging release of a commit, `release/semantic-tag` fast-forwards over them (only when every commit ahead is a journal commit touching only the journal) before semantic-release, which otherwise publishes nothing from a branch behind its remote. Tests: `python3 -m unittest discover -s actions/release/release-journal/tests` (in `lint.yml`).
- **`security/gitleaks`** (MAIR-416) — secret scan with a Gitleaks image pinned by version + digest (not `gitleaks-action`, which needs a paid org license), run as the checkout's uid. Scans only the commits of the run (`pull_request.base.sha..sha`, `event.before..sha`, else the last commit), so the caller checks out with `fetch-depth: 0`; `.gitleaksignore` for rotated secrets. Called after Semgrep in the `security_sast` job of every workflow.
- **`promote/gdpr-inventory`** (MAIR-285) — GDPR inventory gate of the database, called by the `gdpr_inventory` job of `promote-prod.yml` (`stack: database`) with the staging digests `resolve` read: runs the database image, applies the migrations image (same invocation as Deploiment's migration job), dumps the columns (`tests/gdpr/schema.sql`), then `tests/gdpr/check.mjs` against the repo's `gdpr/inventory.yaml` and the inventory of the last tag before the promoted commit (`sha` input, `git describe --tags "<sha>^"`, so the caller checks out with `fetch-depth: 0`). Job summary + `gdpr-inventory` artifact. Skipped with a warning when the repo has no inventory.
- **`promote/gdpr-marker`** (MAIR-290) — personal data in logs test of an API or a BFF, called by the `gdpr_marker` job of `promote-prod.yml` (`stack: apis | bffs`) with `<image>@<staging digest>` of the promoted commit: runs the repo's `gdpr_marker_test.sh` (checked out at that commit), whose `docker-compose-gdpr-marker.yml` starts the service and the `gdpr-marker` runner (`tests/gdpr/marker`), then searches the logs of every container for the marker's values. Job summary + `gdpr-marker` artifact (values masked). Skipped with a warning without `gdpr-marker.yaml`. BFFs get the `npm_scope` / token `.npmrc` like the ZAP job.
- **`notify/cicd-failure`** — posts the failure to the n8n webhook. Context values and the secret go through `env:` and the JSON is built with `jq -n --arg` (MAIR-416: a forged branch name used to be able to inject shell code); keep it that way.
- **`security/semgrep`** (MAIR-230) — SAST with a Semgrep image pinned by **version + digest** (input `image`; the org's "major tag" pinning rule does not apply here, bump tag and digest together). Inputs: `config` (space/newline-separated rulesets, one `--config` each), `paths`, `exclude` (defaults to `cicd-repo`, which every workflow checks out inside the workspace), `fail_on_findings` (default `'true'`), `upload_sarif` (default `'false'`, needs `security-events: write`), `sarif_category`, `artifact_name` (`semgrep-sarif`). The scan step never fails by itself: it records the exit code, the SARIF is uploaded (artifact, optionally code scanning), then a last step applies the verdict (exit 1 → findings, fail or warn; any other non-zero → Semgrep error, always fails). Outputs `findings`, `exit_code`, `sarif_file`. Called by the `security_sast` job of **every** stack workflow through the `semgrep_config` / `semgrep_fail_on_findings` workflow inputs (per-stack defaults and the rollout are in `README.md`). Code-scanning upload stays off in the workflows: consumer callers declare top-level `permissions:` without `security-events`, and a nested job cannot request more than its caller grants (startup failure).
- **`release/publish-openapi-rust`** — `cargo open_api > openapi.json` → `npx -y orval` → publishes `@<org>/<package_name>-openapi` to `npm.pkg.github.com`.
- **`release/publish-openapi-typescript`** — same intent for TS BFFs; currently a **stub** (only stages a directory, does not publish). Treat as incomplete.
- **`release/docker-manual-build`** (formerly `docker/docker_manual_build`) — manual/off-main image build escape hatch; refuses to run on `main`. Composite action taking `package_name` and `github_token`; the caller must pass the token explicitly (composites cannot read `secrets`).

## Per-stack workflow notes

| Workflow | Stack | Extra behavior |
|---|---|---|
| `APIs_cicd.yml` | Rust API | Check actions `*/apis` (`integration/apis` too). `cargo audit`, `cargo clippy -D warnings`, Semgrep + Gitleaks (`security_sast`, blocking by default since MAIR-416, `build` needs it); coverage via the downstream **`cargo cov` alias** (must run tests, enforce the threshold, and emit `codecov.json`) + Codecov upload (main / PR-to-main, `CODECOV_TOKEN` is a **required** secret); `unit_test` needs only `lint` and runs in parallel with `build` (so `release-dev` needs both); publishes OpenAPI (rust, `0.0.0-dev-<sha7>`). The integration (`./integration_test.sh`), ZAP and k6 stacks are staging gates of `promote-staging.yml` (MAIR-494): they log in to GHCR and export `IMAGE_REF=<image>:dev-<sha_tag>` so the compose stacks test the published image instead of rebuilding from `development.Dockerfile`; the ZAP and k6 jobs check out the full `cicd-repo/` for the OpenAPI coverage gate files. |
| `back-lib-cicd.yml` | Rust library | Check actions `*/back-lib` (`security/back-lib` = `security_audit`). `cargo audit` + `cargo deny check advisories licenses`, Semgrep (report-only by default), `cargo lint_check` (a cargo alias the repo must define), tests run once through `cargo llvm-cov` (which also writes `codecov.json`, MAIR-467) + Codecov upload, `cargo publish` to crates.io, then lands the version bump on `main` through a `chore/release-bump-<version>` PR squash-merged with a `[skip ci]` subject (`main` rejects direct pushes with `GH013`; the release app needs `contents` + `pull_requests` write) |
| `BFFs-cicd.yml` | Node/TS BFF | Check actions `*/bffs` (`dependencies/bffs` with `audit: 'true'` = `security_audit`). `npm audit --audit-level=high`, Semgrep via the `security/semgrep` action (`p/typescript`, `p/owasp-top-ten`, `p/nodejs`, `p/expressjs`, `p/secrets`, `p/dockerfile`, `p/github-actions`, blocking), Docker build with GH Packages `.npmrc` secret, publishes OpenAPI (typescript, from the committed `openapi_spec_path`). The integration (`./integration_test.sh`, MAIR-262), ZAP and k6 stacks on `<image>:dev-<sha_tag>` are staging gates of `promote-staging.yml` (MAIR-494): `integration/bffs` logs in to GHCR, writes the build `.npmrc`, runs the script with `IMAGE_REF` + `NODE_AUTH_TOKEN`, then (`if: always()`) summarizes `newman-reports/newman.xml` in the job summary (`newman_summary.py`, tested in `lint.yml`) and uploads the folder as the `newman-report-<package_name>` artifact; the ZAP / k6 jobs check out the full `cicd-repo/` for the OpenAPI coverage gate files; the workflow outputs `release_published` / `release_version` are gone. |
| `frontend-cicd.yml` | Next.js | Check actions `*/fronts` (`dependencies/fronts` with `audit: 'true'` = `security_audit`, `security/fronts` / `performance/fronts` take `target_image`). `npm audit --omit=dev --audit-level=high` (blocking, production dependencies only since MAIR-510; the full audit including dev dependencies runs report-only), Semgrep (blocking by default since MAIR-416), `npm run build`, `npm test` (mandatory, no `--if-present`), Docker image only (no npm publish), npm token as a BuildKit secret (`node_auth_token`). `security_tests` (ZAP) and `performance_tests` (k6) run the front's `./security_test.sh` / `./performance_test.sh` on pull requests to `main` (local image build); on the published image (`TARGET_IMAGE=<image>:dev-<sha_tag>`, MAIR-516) they are staging gates of `promote-staging.yml` (MAIR-494). Top-level `permissions: contents: read, packages: read` (MAIR-436): only the release jobs request write scopes, and the fronts grant `contents`/`packages`/`id-token: write` on their calling `CICD` job only (workflow default `contents: read`). |
| `front-libs-cicd.yml` | npm component library | Check actions `*/front-lib` (`security/front-lib` = `security`: npm audit + `typecheck`). The blocking `npm audit` covers production dependencies only (`--omit=dev`, #161: the `braces` advisory GHSA-vfj7-8cjw-p6xm has no fixed release and only reaches lint tooling); the full audit, development tools included, runs after it as a warning with the report in the job summary (`dependencies/front-lib` and `security/front-lib`). Semgrep (report-only by default; `storybook` and `package` need it). Publishes to GitHub Packages via manual git-tag bump (`vMAJOR.MINOR.PATCH`, rolls at 10), deploys Storybook to GitHub Pages when `src/` changed |
| `bffs-lib-cicd.yml` | npm library shared by the BFFs (`bffs_lib`, MAIR-234) | Check actions `*/bffs-lib`. `npm audit`, `npm run lint`, Semgrep (report-only by default, `build` needs it), `npm run build` (tsc), `npm test` (the repo's jest config enforces its coverage thresholds) + Codecov upload (`coverage/lcov.info`, `CODECOV_TOKEN` required). On `main`, `package` runs `semantic-tag`, then sets the version in the workspace only and publishes `@mairie360/bffs-lib` to GitHub Packages when a release is published (no version commit back, like `front-libs`). No Storybook. |
| `database_cicd.yml` | DB + Liquibase | Check actions `unit-tests/db`, `performance/db`. Runs `./test.sh`, Semgrep (blocking by default since MAIR-416, `release-dev` needs it), builds two images (`<package_name>` and `liquibase-migrations` from `./liquibase/Dockerfile`) through `docker-release` (`extra_package_name`), so its mobile tags are `dev` / `staging` like the other stacks. `performance_tests` (MAIR-476) runs the repo's `./performance_test.sh` (schema bench with latency thresholds) on every event, PRs included, in parallel with the other jobs; `release-dev` does not need it, but promote-staging refuses a commit whose main run has a failed job. Skipped with a warning when the script is missing. `release_folder` (MAIR-491) is a job of `promote-prod.yml` (`stack: database`): the version `next-version` computed for the commit goes to the `release/release-folder` action, and a finding skips the prod release; `gdpr_inventory` (MAIR-285) is another database job of `promote-prod.yml` (see "GDPR inventory gate") |
| `cicd.yml` | **this repo** | semantic-release on push to `main` (angular preset, `feat`→minor / `fix`,`perf`→patch) |
| `auto-approve.yml` | — | auto-approves `renovate[bot]` PRs (`pull_request_target`) |

## What downstream repos must provide

Depending on which workflow they call: a root `Dockerfile`; a `docker-compose.test.yml` exposing services named `security-scan` (ZAP), `k6-perf-test` or `db-test` (jobs use `--exit-code-from <that service>`); for `APIs_cicd.yml`, an `integration_test.sh` (same shape as `security_test.sh`) driving a `docker-compose-integration.yml` whose test-runner service exercises the API and sets the exit code; for `BFFs-cicd.yml` (MAIR-262), the same `integration_test.sh` + `docker-compose-integration.yml` with a `newman` service that replays the repo's collection against the BFF (`--bail`, its exit code is the script's) and writes the junit report to `newman-reports/newman.xml` (relative to the repo root; the script creates the folder); for `APIs_cicd.yml` and `BFFs-cicd.yml`, compose stacks whose service under test reads `${IMAGE_REF}` (no `build:` block), `*_test.sh` scripts that build a local image and export `IMAGE_REF` themselves when the variable is empty and clone `cicd-repo/` at the pinned `cicd_version` when it is absent, a ZAP service that mounts `cicd-repo/tests/zap/zap_hooks.py` and passes it with `--hook`, and a `load-test.js` built on `cicd-repo/tests/k6/coverage.js` with one handler per operation of `openapi.json`; `test.sh` (database); npm scripts `lint` / `build` / `test` / `typecheck` / `build-storybook`; cargo commands `cargo open_api` and the `cargo lint_check` alias (plus the `cargo cov` alias for `APIs_cicd.yml`, which must emit `codecov.json` and enforce the coverage threshold itself); an `openapi-spec.json` / `openapi.json` at repo root for OpenAPI publishing. Since MAIR-493 the check jobs that did not use this repo before (dependencies, lint, build, unit tests, the API integration job, the front ZAP / k6 jobs, the database tests and bench) hold a **sparse** `cicd-repo/` with `actions/` only: a script that needs `cicd-repo/tests/` there must test for the file, not the folder, and cannot `git clone` into the existing `cicd-repo/` (the full checkout, with `tests/`, is only in `security_sast` and the ZAP / k6 jobs of `APIs_cicd.yml` / `BFFs-cicd.yml`).

## Conventions

- Commit messages: Conventional Commits (angular) — `feat:`, `fix:`, `perf:`, `chore(deps):`, breaking via `!` or footer. This drives every semantic-release version bump.
- Pin third-party actions by major tag (`@v7`); the org's own refs use `inputs.cicd_version`. Exception: actions that publish no floating major tag (e.g. `sigstore/cosign-installer`, only `vX.Y.Z`) are pinned by full version, since `@vN` fails to resolve at job start.
- Codecov uploads are **never blocking** (`fail_ci_if_error: false` everywhere, MAIR-467): Codecov only reports coverage, thresholds are enforced by the test commands (`cargo cov`, jest config). A Codecov outage (expired certificate on 2026-10-05) used to fail `unit_test` and skip every release.
- Every job that starts a Docker stack (`*_test.sh`, `test.sh`) is bounded (MAIR-468): job `timeout-minutes` (25 for APIs / fronts / database, 60 for the BFF ZAP / k6 jobs, 40 for the BFF integration job) and, outside the BFFs, a 15 min step timeout followed by an `if: failure()` "Dump container logs" step. A stack that never gets ready (e.g. a `*-ready` service polling `/health` forever) used to hold a runner for GitHub's 6 h default and starve the whole org's queue.
- **Non-regression through the staging gates** (MAIR-262): a BFF whose newman collection fails (e.g. an upstream contract field renamed, a status code changed) makes the `integration_tests` job of `promote-staging.yml` fail, and `promote` (`!contains(needs.*.result, 'failure')`) is not run, exactly like a ZAP or k6 failure. The report stays readable in the job summary and the `newman-report-<package_name>` artifact.
- French is used in comments and step names throughout; `# [CHANGEMENT]` / `# [NOUVEAU]` mark deliberate deviations from a previous version — keep annotating significant changes the same way.

## Pull request reviewers

Every PR requests a review from the whole team, minus its author: `CarolinHugo`, `LAURETbenjamin`, `MathTek` and `Quentintnrl` (`gh pr create … --reviewer CarolinHugo,LAURETbenjamin,MathTek`). `.github/CODEOWNERS` makes GitHub request them automatically as well.
