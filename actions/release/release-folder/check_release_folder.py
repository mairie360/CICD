#!/usr/bin/env python3
"""Check that the Liquibase release changesets match the git tag about to be cut (MAIR-491).

Usage: check_release_folder.py <repo> <last tag> <next version or "">

Compares the release changesets (everything included by <liquibase dir>/changelog.xml
outside repeatable/) at <last tag> and in the working tree, by their Liquibase identity
(id, author, logical file path) and content (attributes and referenced SQL files, paths
excluded so that a moved file keeps its content hash):

- a changeset shipped by <last tag> must still exist with the same content; only a changeset
  holding nothing but a tagDatabase may be dropped;
- with a next version, every new changeset lives in releases/v<next>/, whose changelog is
  included by changelog.xml and ends with a tag-v<next> changeset tagging v<next>;
- without one, there is no new changeset;
- a new changeset has the logical file path `releases` and an id `mair-<n>-NN` (or
  `tag-v<next>`), so that renaming its folder after it reached dev keeps its identity;
- in both cases, a new tagDatabase changeset of an earlier git tag is allowed in the folder
  of that tag (tags added after the fact, MAIR-490).

Writes a Markdown report on stdout and exits 1 on any finding. Standard library only.
"""
import hashlib
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

NS = "{http://www.liquibase.org/xml/ns/dbchangelog}"
LIQUIBASE_DIR = os.environ.get("LIQUIBASE_DIR", "liquibase")
# Identity of the changesets added from MAIR-491 on: independent of the folder name.
LOGICAL_PATH = "releases"
NEW_ID = re.compile(r"^(mair-\d+-\d{2}|tag-v\d+\.\d+\.\d+)$")


class Tree:
    """Reads files either from the working tree or from a git revision."""

    def __init__(self, repo, rev=None):
        self.repo, self.rev = repo, rev

    def read(self, path):
        if self.rev is None:
            with open(os.path.join(self.repo, path), "rb") as f:
                return f.read()
        return subprocess.run(["git", "-C", self.repo, "show", f"{self.rev}:{path}"],
                              check=True, capture_output=True).stdout

    def exists(self, path):
        if self.rev is None:
            return os.path.isfile(os.path.join(self.repo, path))
        return subprocess.run(["git", "-C", self.repo, "cat-file", "-e", f"{self.rev}:{path}"],
                              capture_output=True).returncode == 0


def tag(elem):
    return elem.tag.replace(NS, "")


def fingerprint(elem, tree, changelog_dir):
    """Content of a changeset element: attributes and children, SQL files by their content."""
    attrs = {k: v for k, v in sorted(elem.attrib.items())
             if k not in ("path", "logicalFilePath", "relativeToChangelogFile")}
    parts = [tag(elem), repr(attrs), (elem.text or "").strip()]
    if tag(elem) == "sqlFile":
        path = elem.attrib["path"]
        if elem.attrib.get("relativeToChangelogFile") == "true":
            path = os.path.normpath(os.path.join(changelog_dir, path))
        parts.append(hashlib.sha256(tree.read(path)).hexdigest())
    for child in elem:
        parts.append(fingerprint(child, tree, changelog_dir))
        parts.append((child.tail or "").strip())
    return hashlib.sha256("\x00".join(parts).encode()).hexdigest()


def changesets(tree):
    """{identity: changeset} of the release changelogs, in include order."""
    found = {}
    root_path = f"{LIQUIBASE_DIR}/changelog.xml"
    root = ET.fromstring(tree.read(root_path))
    for include in root.iter(f"{NS}include"):
        rel = include.attrib["file"]
        if rel.startswith("repeatable/"):
            continue
        path = os.path.normpath(os.path.join(LIQUIBASE_DIR, rel))
        log = ET.fromstring(tree.read(path))
        log_logical = log.attrib.get("logicalFilePath", rel)
        sets = [cs for cs in log if tag(cs) == "changeSet"]
        for i, cs in enumerate(sets):
            logical = cs.attrib.get("logicalFilePath", log_logical)
            key = (cs.attrib["id"], cs.attrib["author"], logical)
            changes = [c for c in cs if tag(c) not in ("preConditions", "rollback", "comment",
                                                       "validCheckSum")]
            tags = [c.attrib["tag"] for c in changes if tag(c) == "tagDatabase"]
            found[key] = {
                "file": path,
                "folder": os.path.basename(os.path.dirname(path)),
                "last_in_file": i == len(sets) - 1,
                "tag_only": len(changes) == 1 and len(tags) == 1,
                "tag": tags[0] if tags else None,
                "fingerprint": fingerprint(cs, tree, os.path.dirname(path)),
            }
    return found


def git_tags(repo):
    out = subprocess.run(["git", "-C", repo, "tag", "--list", "v*"], check=True,
                         capture_output=True, text=True).stdout
    return set(out.split())


def label(key):
    return f"`{key[0]}` ({key[2]})"


def main():
    repo, last_tag, version = sys.argv[1], sys.argv[2], sys.argv[3].lstrip("v")
    expected = f"v{version}" if version else None
    old = changesets(Tree(repo, last_tag))
    try:
        new = changesets(Tree(repo))
    except (OSError, ET.ParseError) as error:
        print(f"## Liquibase release folder\n\n### Errors\n\n- Cannot read the changelog: {error}")
        return 1
    tags = git_tags(repo)
    errors, notes = [], []

    for key, cs in old.items():
        if key not in new:
            if cs["tag_only"]:
                notes.append(f"{label(key)} (tag `{cs['tag']}`) is no longer in the changelog; "
                             "databases that ran it keep the tag.")
            else:
                errors.append(f"{label(key)}, shipped by `{last_tag}`, is gone: a shipped "
                              "changeset must stay, or every database that ran it diverges.")
        elif new[key]["fingerprint"] != cs["fingerprint"]:
            errors.append(f"{label(key)}, shipped by `{last_tag}`, was modified "
                          f"(now in `{new[key]['file']}`): add a new changeset instead.")

    added = [(k, cs) for k, cs in new.items() if k not in old]
    for key, cs in added:
        if cs["tag_only"] and cs["tag"] in tags and cs["tag"] != expected:
            if cs["folder"] != cs["tag"]:
                errors.append(f"{label(key)} tags `{cs['tag']}` but lives in "
                              f"`releases/{cs['folder']}/`.")
            continue
        if key[2] != LOGICAL_PATH or not NEW_ID.match(key[0]):
            errors.append(f"{label(key)} (`{cs['file']}`): a new changeset needs "
                          f"`logicalFilePath=\"{LOGICAL_PATH}\"` and an id `mair-<n>-NN` "
                          "(`tag-vX.Y.Z` for the tag), so that renaming its folder does not "
                          "make dev and staging run it again.")
        if expected is None:
            errors.append(f"{label(key)} (`{cs['file']}`) is new but the commits since "
                          f"`{last_tag}` cut no release: use a `fix:` / `feat:` commit for a "
                          "schema change.")
        elif cs["folder"] != expected:
            errors.append(f"{label(key)} is in `releases/{cs['folder']}/` but ships in "
                          f"`{expected}`: move it to `releases/{expected}/` (rename the folder "
                          "and its changelog).")

    if expected and any(cs["folder"] == expected for _, cs in added):
        closing = [cs for k, cs in new.items() if cs["folder"] == expected and cs["last_in_file"]]
        if not any(cs["tag_only"] and cs["tag"] == expected for cs in closing):
            errors.append(f"`releases/{expected}/` must end with a `tag-{expected}` changeset "
                          f"(`<tagDatabase tag=\"{expected}\"/>`).")

    print(f"## Liquibase release folder\n\nLast tag: `{last_tag}` · next release: "
          f"`{expected or 'none'}` · new changesets: {len(added)}\n")
    for title, items in (("Errors", errors), ("Notes", notes)):
        if items:
            print(f"### {title}\n")
            print("\n".join(f"- {item}" for item in items) + "\n")
    if not errors:
        print("The release changesets match the release about to be cut.")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
