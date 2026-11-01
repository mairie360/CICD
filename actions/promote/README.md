# `actions/promote/`

Actions of the promotion workflows `promote-staging.yml` / `promote-prod.yml` (MAIR-494, epic
MAIR-492). The gates between two environments go here too, one sub-folder per check and stack, like
the other types (`actions/<type>/<stack>`).

- `resolve/`: picks the promoted commit (`sha` input, else main's newest eligible one) and refuses
  it unless it is on the previous environment: `dev-<sha>` released by a green main run for
  staging, `staging-<sha>` for prod. Outputs the full sha, the short tag, the image and the
  digest(s) the promotion must re-tag. Tests: `python3 -m unittest discover -s actions/promote/resolve/tests`.
- `next-version/`: semantic-release dry run on a commit that may be behind main's tip (local bare
  mirror + `url.<mirror>.insteadOf`), for the version and notes promote-prod releases.

- `create-release/`: tags the promoted commit `v<version>` with `git push` and a token of the
  release app (`contents` + `workflows` write: GitHub refuses the ref to any token without
  `workflows` when the commit's workflows differ from main's), then creates the GitHub release on
  that tag (`--verify-tag`) with the run's token. Idempotent on a rerun. Tests:
  `python3 -m unittest discover -s actions/promote/create-release/tests`.
- `gdpr-inventory/` (MAIR-285, database): migrates an empty database with the staging images of
  the promoted commit and checks every column against the repo's `gdpr/inventory.yaml`
  (`tests/gdpr/check.mjs`); job `gdpr_inventory` of promote-prod. Tests: `cd tests/gdpr && npm test`.
- `gdpr-marker/` (MAIR-290, APIs / BFFs): plays the repo's `gdpr-marker.yaml` journey on the staging
  image and searches every container's logs for the marker user's values; job `gdpr_marker`.
- `gdpr-simulation/` (MAIR-497, APIs / BFFs): GDPR usage simulation on the staging image, then
  deterministic checks and an AI review (`tests/gdpr/simulation`); job `gdpr_simulation`.
