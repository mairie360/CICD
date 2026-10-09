# Verified frontend secret scanner

The frontend pipelines use Gitleaks 8.30.1 from its [published release](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1). The Linux x64 archive SHA-256 is `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`, verified from the release asset metadata before this action was written. Download integrity is checked before extraction or execution.

The existing Docker action and backend/library workflows remain available with their current implementation. This dedicated frontend action preserves the PR/push base selection, fallback to the last commit, redaction, existing repository ignore/config behavior and blocking finding/error exits. One Go execution thread keeps the runner load bounded. It changes scanner installation and preserves the actual secret-scan verdict.
