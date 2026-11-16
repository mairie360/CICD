"""Check the internal pins of the commit a promote-prod run promotes (MAIR-1005).

Prod only ships published, reproducible internal artifacts (user decisions of 2026-11-16,
MAIR-998). Pins read at the promoted commit (`git show <sha>:<file>`, the checkout is main's tip):

- `package.json`: every `@<owner>/*` dependency (OpenAPI contracts, bffs-lib, lib-components) must
  be an exact version that the registry knows (`npm view`): a release `X.Y.Z` or a dev / staging
  build (`0.0.0-dev…`, `0.0.0-staging…`). Contracts are only bumped when the code needs a new
  route or field; compatibility with the upstream is proven by the gates, which run against its
  prod images. Ranges and dist-tags are refused (not reproducible).
- the test stacks `docker-compose-*.yml` at the repo root (not the local `docker-compose.yml`):
  every upstream `ghcr.io/<owner>/<name>` must use the moving tag of the stage,
  `${UPSTREAM_TAG:-dev}`, which the prod gates resolve to `latest` (what prod runs); an `X.Y.Z`
  tag that exists is still accepted, and so is a `dev-<sha>` / `staging-<sha>` tag with the digest
  of `:latest`. A hard-coded moving tag (`latest`, `dev`, `staging`, none) or another variable is
  refused. The repo's own images (`package_name`, `extra_package_name`) are left out: their stacks
  run the promoted digest.

MODE=enforce fails (exit 1) on any finding, naming each pin; MODE=report (dry runs, MAIR-1007)
only warns. Standard library only; writes a summary table to $GITHUB_STEP_SUMMARY.
"""

import json
import os
import re
import subprocess
import sys

SEMVER = re.compile(r'^\d+\.\d+\.\d+$')
# The test stacks of the gates (docker-compose-integration.yml, -security, -e2e...); the plain
# docker-compose.yml is the local dev stack, never run by CI, and holds placeholders.
COMPOSE = re.compile(r'^docker-compose[-.](?!ya?ml$)[^/]*\.ya?ml$')
# Dev / staging builds: exact, reproducible versions (packages), or the prod digest (images).
PRERELEASE_PACKAGE = re.compile(r'^0\.0\.0-(dev|staging)[.-][0-9a-f]{7,40}$')
PRERELEASE_TAG = re.compile(r'^(dev|staging)-[0-9a-f]{7,40}$')
# The moving tag of the stage, set by the CICD workflows (dev / staging / latest), MAIR-998.
STAGE_TAG = re.compile(r'^\$\{UPSTREAM_TAG(:?-[a-z]+)?$')
NOT_FOUND = ('E404', '404 Not Found', 'is not in this registry', 'No matching version')


class Error(Exception):
    pass


def git(*args):
    return subprocess.run(['git', *args], check=True, capture_output=True, text=True).stdout


def show(sha, path):
    result = subprocess.run(['git', 'show', '{}:{}'.format(sha, path)], capture_output=True, text=True)
    return result.stdout if result.returncode == 0 else None


def package_pins(manifest_text, owner):
    """(name, version, section) of every @<owner>/* dependency of a package.json."""
    manifest = json.loads(manifest_text)
    prefix = '@{}/'.format(owner)
    pins = []
    for section in ('dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'):
        for name, version in sorted((manifest.get(section) or {}).items()):
            if name.lower().startswith(prefix):
                pins.append((name, str(version), section))
    return pins


def image_pins(text, owner, own_images):
    """(image, tag, line number) of every ghcr.io/<owner>/<name>:<tag> of a compose file."""
    pattern = re.compile(r'ghcr\.io/{}/([a-z0-9][a-z0-9._-]*)(?::([^\s"\'}}@]+))?(@sha256:[0-9a-f]{{64}})?'
                         .format(re.escape(owner)), re.IGNORECASE)
    pins = []
    for number, line in enumerate(text.splitlines(), 1):
        if line.lstrip().startswith('#'):
            continue
        for match in pattern.finditer(line):
            name, tag = match.group(1).lower(), match.group(2) or ''
            if name in own_images:
                continue
            pins.append(('ghcr.io/{}/{}'.format(owner, name), tag, number))
    return pins


def package_exists(name, version):
    result = subprocess.run(['npm', 'view', '{}@{}'.format(name, version), 'version', '--json'],
                            capture_output=True, text=True)
    if result.returncode == 0:
        return bool(result.stdout.strip())
    if any(marker in result.stderr + result.stdout for marker in NOT_FOUND):
        return False
    raise Error('npm view {}@{} failed: {}'.format(name, version, (result.stderr or result.stdout).strip()))


def image_digest(ref):
    result = subprocess.run(['docker', 'buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest}}'],
                            capture_output=True, text=True)
    if result.returncode != 0:
        return None
    try:
        manifest = json.loads(result.stdout)
    except ValueError:
        return None
    return manifest.get('digest') if isinstance(manifest, dict) else None


def prod_image(image, tag):
    """True when image:tag has the digest of image:latest."""
    digest = image_digest('{}:{}'.format(image, tag))
    return bool(digest) and digest == image_digest(image + ':latest')


def image_exists(ref):
    result = subprocess.run(['docker', 'buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest}}'],
                            capture_output=True, text=True)
    return result.returncode == 0


def check(sha, owner, own_images, package_exists=package_exists, image_exists=image_exists,
          prod_image=prod_image):
    """Rows (kind, file, pin, verdict) and the list of findings."""
    rows, findings = [], []

    def add(kind, where, pin, problem):
        rows.append((kind, where, pin, problem or 'ok'))
        if problem:
            findings.append('{} ({}): {}'.format(pin, where, problem))

    manifest = show(sha, 'package.json')
    if manifest is not None:
        for name, version, section in package_pins(manifest, owner):
            pin = '{}@{}'.format(name, version)
            if not (SEMVER.match(version) or PRERELEASE_PACKAGE.match(version)):
                add('npm', 'package.json ' + section, pin, 'not an exact published version: prod needs X.Y.Z or a dev / staging build')
            elif not package_exists(name, version):
                add('npm', 'package.json ' + section, pin, 'not published')
            else:
                add('npm', 'package.json ' + section, pin, None)

    files = [path for path in git('ls-tree', '--name-only', sha).splitlines() if COMPOSE.match(path)]
    for path in sorted(files):
        for image, tag, number in image_pins(show(sha, path) or '', owner, own_images):
            where = '{}:{}'.format(path, number)
            pin = '{}:{}'.format(image, tag) if tag else image
            if STAGE_TAG.match(tag):
                add('image', where, pin + '}', None)
                rows[-1] = rows[-1][:3] + ('ok (moving tag of the stage: latest in prod)',)
            elif not tag:
                add('image', where, pin, 'no tag (latest): use ${UPSTREAM_TAG:-dev} or an X.Y.Z tag')
            elif PRERELEASE_TAG.match(tag):
                same = prod_image(image, tag)
                add('image', where, pin, None if same else 'not the current prod image (latest): use ${UPSTREAM_TAG:-dev}')
                if same:
                    rows[-1] = rows[-1][:3] + ('ok (= prod digest)',)
            elif not SEMVER.match(tag):
                add('image', where, pin, 'not reproducible: use ${UPSTREAM_TAG:-dev} or an X.Y.Z tag')
            elif not image_exists(pin):
                add('image', where, pin, 'tag not found')
            else:
                add('image', where, pin, None)
    return rows, findings


def summary(rows, findings, mode, sha):
    lines = ['### Internal pins of `{}` (MAIR-1005)'.format(sha[:7]), '']
    if not rows:
        lines.append('No internal pin.')
    else:
        lines += ['| Kind | File | Pin | Check |', '| --- | --- | --- | --- |']
        lines += ['| {} | `{}` | `{}` | {} |'.format(*row) for row in rows]
    if findings:
        lines += ['', '{} pin(s) not released{}.'.format(
            len(findings), '' if mode == 'enforce' else ' (report only: dry run)')]
    return '\n'.join(lines) + '\n'


def main(env):
    mode = env.get('MODE', 'enforce')
    if mode not in ('enforce', 'report'):
        raise Error('unknown mode `{}` (enforce | report)'.format(mode))
    sha = env['SHA']
    owner = env['GITHUB_REPOSITORY_OWNER'].lower()
    own = {name.strip().lower() for name in (env.get('PACKAGE_NAME', ''), env.get('EXTRA_PACKAGE_NAME', '')) if name.strip()}
    rows, findings = check(sha, owner, own)
    with open(env.get('GITHUB_STEP_SUMMARY', os.devnull), 'a', encoding='utf-8') as out:
        out.write(summary(rows, findings, mode, sha))
    level = 'error' if mode == 'enforce' else 'warning'
    for finding in findings:
        print('::{} title=verify-pins::{}'.format(level, finding))
    print('{} internal pin(s) checked, {} not released'.format(len(rows), len(findings)))
    return 1 if findings and mode == 'enforce' else 0


if __name__ == '__main__':
    try:
        sys.exit(main(os.environ))
    except Error as error:
        print('::error title=verify-pins::{}'.format(error))
        sys.exit(1)
