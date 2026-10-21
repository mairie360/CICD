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

- `create-release/`: tags the promoted commit `v<version>` with `git push` and creates the GitHub
  release on that tag (`--verify-tag`). The releases API cannot create the tag with the run's
  token when the commit changes `.github/workflows` (HTTP 403). Idempotent on a rerun. Tests:
  `python3 -m unittest discover -s actions/promote/create-release/tests`.