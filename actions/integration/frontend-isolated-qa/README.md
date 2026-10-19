# Isolated frontend QA

Run `Isolated frontend QA` with an included frontend repository, its exact current
main SHA, the digest from its successful verified dev-image job, and security,
performance or both. The historic Formation repository is `Elearning_Web_Service`.

The workflow checks the immutable dev tag and the existing publisher signature,
then uses that digest with the frontend's existing isolated Compose stack and
scanner settings. It does not rebuild or publish images. The actual scanner
container exit code controls the result; redirects, thresholds and ZAP rules
retain their existing verdicts. One scanner runs at a time and disposable stacks
are removed after success or failure. Results and stack logs are retained.

The current signature identity is pinned to the already verified publisher
`frontend-dev-exception.yml@f5ea4257ac51aa2969f9ddb84730fbebce8f42a7`.
An image produced by a different publisher is rejected until its identity is
explicitly reviewed. Existing release workflows and audit gates are unchanged.

These runs test published frontend binaries with the pinned local test-service
images. They do not demonstrate the actual application rollout, deployed IdP
authentication, roles or persistence in dev. A skipped or failed scanner remains
unvalidated; its result must be reported with the exact frontend SHA and digest.
