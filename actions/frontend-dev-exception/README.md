# Manual frontend dev dependency exception

The eight included frontend main pipelines are blocked by the five npm audit entries rooted
in GHSA-vfj7-8cjw-p6xm. The separate `frontend-dev-exception.yml` reusable workflow allows a
reviewed, manual **dev-only** release for this exact development dependency chain. Existing
frontend pipelines and their automatic staging/production triggers are unchanged.

The original main run must have finished with only its npm audit job failed, and successful
installation, lint, unit tests, Semgrep/Gitleaks and published-contract checks. Unknown skipped
controls, failed or skipped RGAA checks, another advisory, any affected non-dev installation,
any production audit finding, a registry version newer than braces 3.0.3, an unpinned CI ref,
an excluded/backend repository, or a main advance refuse the exception. This workflow reruns
contracts, types, lint, tests, build and both strict source scans. Its full audit job still fails
and the workflow retains that failed verdict; the separate policy records the narrow exception.

The calling workflow must use only `workflow_dispatch`, hardcode the reviewed full CI commit
in both `uses` and `cicd_ref`, pass the repository's existing image name, and grant its existing
contents/actions/checks read, packages write and id-token write permissions. The image release
preserves the normal `Dev` environment gate. A documented reason is required. This reusable
workflow has no staging or production release jobs.

The image is built once with an ephemeral npm BuildKit secret, SBOM and provenance, under
`candidate-<full sha>`. The existing image-updater dev policy in `mairie360/ansible`,
`roles/k8s_argocd/defaults/main.yml`, is `regexp:^dev-.*`, so this candidate tag is not eligible
for automatic rollout. Trivy keeps the existing pinned image and blocking fixable HIGH/CRITICAL
policy. Only after a successful digest scan, keyless signature verification and another main
check is that exact digest tagged `dev-<short sha>`. No mobile, staging, production or semantic
version tag is created, and no updater/protection/access/RGAA configuration is changed.
An existing immutable dev tag is refused both before building and before promotion; registry
authentication or network errors are not treated as evidence that a tag is absent.

Release artifacts preserve preflight, both npm audits, raw exit codes, policy decision,
signature verification, head and image digest. A published image does **not** prove the
deployed digest, real dev authentication, BFF permissions, persistence or feature acceptance.
Those require separate dev evidence; unavailable accounts remain an explicit validation blocker.

Local guard checks: `python3 -m unittest discover -s actions/frontend-dev-exception/tests -v`.
The existing workflow lint job also runs these checks. Runtime behavior, registry permissions,
image scan/signature and rollout remain unvalidated until the manual workflow actually runs.
