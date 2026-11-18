"""Decides whether a Renovate pull request may be approved automatically.

Renovate commits through the GitHub API: each of its commits has renovate[bot] as author,
web-flow (or renovate[bot]) as committer and a signature GitHub verified. The pull request may
be approved only when every commit looks like that and the push that triggered the run was made
by renovate[bot] (the event sender): a commit written or pushed by anyone else means a human
changed the branch, and the change needs a human review.

Usage: gh api --paginate repos/<repo>/pulls/<n>/commits --jq '.[]' \
         | python3 renovate_only.py --sender <login>
Reads one commit object per line (the REST API shape). Exit 0: Renovate's alone; 1: not; 2: the
input could not be read.
"""

import argparse
import json
import sys

RENOVATE = "renovate[bot]"
RENOVATE_COMMITTERS = {"web-flow", RENOVATE}


def login(user):
    return user.get("login") if isinstance(user, dict) else None


def foreign_commits(commits):
    """Short SHAs of the commits that are not Renovate's own, with the reason."""
    found = []
    for commit in commits:
        sha = str(commit.get("sha", "?"))[:7]
        verified = (((commit.get("commit") or {}).get("verification")) or {}).get("verified") is True
        if login(commit.get("author")) != RENOVATE:
            found.append(f"{sha} (author {login(commit.get('author'))})")
        elif login(commit.get("committer")) not in RENOVATE_COMMITTERS:
            found.append(f"{sha} (committer {login(commit.get('committer'))})")
        elif not verified:
            found.append(f"{sha} (unverified signature)")
    return found


def decide(sender, commits):
    """(approvable, reasons): approvable only for a push by Renovate of Renovate's commits."""
    reasons = []
    if sender != RENOVATE:
        reasons.append(f"pushed by {sender}")
    if not commits:
        reasons.append("no commit")
    reasons.extend(f"commit {entry}" for entry in foreign_commits(commits))
    return not reasons, reasons


def read_commits(stream):
    commits = []
    for line in stream:
        line = line.strip()
        if not line:
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError("each line must be a commit object")
        commits.append(value)
    return commits


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--sender", required=True)
    args = parser.parse_args(argv)
    try:
        commits = read_commits(sys.stdin)
    except ValueError as error:
        print(f"Unreadable commit list: {error}", file=sys.stderr)
        return 2
    approvable, reasons = decide(args.sender, commits)
    if approvable:
        print(f"{len(commits)} commit(s), all Renovate's: approve.")
        return 0
    print("Not Renovate's alone, no approval: " + "; ".join(reasons))
    return 1


if __name__ == "__main__":
    sys.exit(main())
