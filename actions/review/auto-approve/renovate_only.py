"""Decides whether a Renovate pull request may be approved automatically.

Renovate commits through the GitHub API: each of its commits has renovate[bot] as author,
web-flow (or renovate[bot]) as committer and a signature GitHub verified. The pull request may
be approved only when every commit looks like that and the push that triggered the run was made
by renovate[bot] (the event sender): a commit written or pushed by anyone else means a human
changed the branch, and the change needs a human review. The decision is bound to one revision:
the head of the event must still be the head of the pull request and the last commit read, or the
event is stale (a later push has its own run) and nothing is approved; the approval names that
revision (`commit_id`), so a push landing after the check is never approved with it. Reopening
does not push: a `reopened` event sent by someone else keeps the approval Renovate's revision
already has, but only when that approval names the event head, so nothing was pushed since it.

Usage: gh api --paginate repos/<repo>/pulls/<n>/commits --jq '.[] | tojson' \
         | python3 renovate_only.py --sender <login> --event-head <sha> --current-head <sha> \
             [--action <pull request event action>] [--approved-at-head]
Reads one commit object per line (the REST API shape). Exit 0: Renovate's alone; 1: not; 2: the
input could not be read; 3: stale event (neither approve nor take back: the run of the later push
decides).
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


def is_stale(commits, event_head, current_head):
    """The pull request moved since the event: a later push has its own run."""
    return current_head != event_head or bool(commits) and commits[-1].get("sha") != event_head


def decide(sender, commits, event_head=None, current_head=None, action=None, approved_at_head=False):
    """(approvable, reasons): approvable only for a push by Renovate of Renovate's commits, read at
    the revision of the event."""
    reasons = []
    if event_head is not None and current_head != event_head:
        reasons.append(f"stale event: head {str(event_head)[:7]}, pull request now at {str(current_head)[:7]}")
    if event_head is not None and commits and commits[-1].get("sha") != event_head:
        reasons.append(f"commits read at {str(commits[-1].get('sha'))[:7]}, not at the event head {str(event_head)[:7]}")
    # A reopen pushes nothing: the approval of this very revision stands, whoever reopened.
    reopened_unchanged = action == "reopened" and approved_at_head
    if sender != RENOVATE and not reopened_unchanged:
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
    parser.add_argument("--event-head", required=True, help="head SHA of the event under review")
    parser.add_argument("--current-head", required=True, help="head SHA of the pull request, read before the commits")
    parser.add_argument("--action", default=None, help="action of the pull_request_target event")
    parser.add_argument("--approved-at-head", action="store_true",
                        help="an approval of this workflow already names the event head")
    args = parser.parse_args(argv)
    try:
        commits = read_commits(sys.stdin)
    except ValueError as error:
        print(f"Unreadable commit list: {error}", file=sys.stderr)
        return 2
    approvable, reasons = decide(
        args.sender, commits, args.event_head, args.current_head, args.action, args.approved_at_head
    )
    if is_stale(commits, args.event_head, args.current_head):
        print("Stale event, left to the run of the later push: " + "; ".join(reasons))
        return 3
    if approvable:
        print(f"{len(commits)} commit(s), all Renovate's: approve.")
        return 0
    print("Not Renovate's alone, no approval: " + "; ".join(reasons))
    return 1


if __name__ == "__main__":
    sys.exit(main())
