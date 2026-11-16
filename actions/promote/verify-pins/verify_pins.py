"""Check the internal pins of the commit a promote-prod run promotes (MAIR-1005).

Prod only ships released artifacts: every internal pin of the promoted commit must be a semver
release that exists, or a dev / staging build that IS the upstream's current prod release (user
decision, 2026-11-16): a service that pins `dev-<sha>` of an upstream can go to prod without a
re-pinning wave when that upstream's prod (`latest`) is the same artifact. Until now the rule was only
checked on the image tags of Deploiment's values (`scripts/check-image-tags.sh`); a service could
reach prod with a dev contract or a dev image in its test stacks, which the next release then had
to re-pin by hand.

Pins read at the promoted commit (`git show <sha>:<file>`, the checkout is main's tip):

- `package.json`: every `@<owner>/*` dependency (OpenAPI contracts, bffs-lib, lib-components),
  which must be an exact `X.Y.Z` that the registry knows (`npm view`), or a `0.0.0-dev…` /
  `0.0.0-staging…` version whose package has the same contents (version aside) as the `latest`
  dist-tag: promotions republish that very tarball (MAIR-999);
- the test stacks `docker-compose-*.yml` at the repo root (not the local `docker-compose.yml`): every `ghcr.io/<owner>/<name>:<tag>`, which
  must be an `X.Y.Z` tag that exists (`docker buildx imagetools inspect`), or a `dev-<sha>` /
  `staging-<sha>` tag with the digest of `:latest` (promotions re-tag one digest). The repo's own images
  (`package_name`, `extra_package_name`) are left out: their stacks run the promoted digest.

MODE=enforce fails (exit 1) on any finding, naming each pin; MODE=report (dry runs, MAIR-1007)
only warns. Standard library only; writes a summary table to $GITHUB_STEP_SUMMARY.
"""

import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile

SEMVER = re.compile(r'^\d+\.\d+\.\d+$')
# The test stacks of the gates (docker-compose-integration.yml, -security, -e2e...); the plain
# docker-compose.yml is the local dev stack, never run by CI, and holds placeholders.
COMPOSE = re.compile(r'^docker-compose[-.](?!ya?ml$)[^/]*\.ya?ml$')
# Dev / staging builds, accepted when they are the upstream's current prod release.
PRERELEASE_PACKAGE = re.compile(r'^0\.0\.0-(dev|staging)[.-][0-9a-f]{7,40}$')
PRERELEASE_TAG = re.compile(r'^(dev|staging)-[0-9a-f]{7,40}$')
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


def npm_json(args):
    """Parsed `npm <args> --json`, None on a 404, raises on any other error."""
    result = subprocess.run(['npm', *args, '--json'], capture_output=True, text=True)
    if result.returncode == 0:
        try:
            return json.loads(result.stdout or 'null')
        except ValueError:
            return None
    if any(marker in result.stderr + result.stdout for marker in NOT_FOUND):
        return None
    raise Error('npm {} failed: {}'.format(' '.join(args), (result.stderr or result.stdout).strip()))


def package_files(tarball):
    """{path: sha256} of a package tarball, `version` left out of package.json."""
    files = {}
    with tarfile.open(tarball) as archive:
        for member in archive.getmembers():
            if not member.isfile():
                continue
            data = archive.extractfile(member).read()
            if member.name == 'package/package.json':
                manifest = json.loads(data)
                manifest.pop('version', None)
                data = json.dumps(manifest, sort_keys=True).encode()
            files[member.name] = hashlib.sha256(data).hexdigest()
    return files


def prod_package(name, version):
    """The `latest` version of `name` when `name@version` has the same contents, else None."""
    latest = npm_json(['view', name, 'dist-tags.latest'])
    if not isinstance(latest, str) or not SEMVER.match(latest):
        return None
    with tempfile.TemporaryDirectory() as workdir:
        contents = []
        for spec in ('{}@{}'.format(name, version), '{}@{}'.format(name, latest)):
            packed = npm_json(['pack', spec, '--pack-destination', workdir])
            if not packed:
                return None
            contents.append(package_files(os.path.join(workdir, packed[0]['filename'])))
    return latest if contents[0] == contents[1] else None


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
          prod_package=prod_package, prod_image=prod_image):
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
            if PRERELEASE_PACKAGE.match(version):
                prod = prod_package(name, version)
                add('npm', 'package.json ' + section, pin,
                    None if prod else 'not the current prod release (latest): prod needs X.Y.Z or the same package')
                if prod:
                    rows[-1] = rows[-1][:3] + ('ok (= prod {})'.format(prod),)
            elif not SEMVER.match(version):
                add('npm', 'package.json ' + section, pin, 'not a release: prod needs an exact X.Y.Z')
            elif not package_exists(name, version):
                add('npm', 'package.json ' + section, pin, 'not published')
            else:
                add('npm', 'package.json ' + section, pin, None)

    files = [path for path in git('ls-tree', '--name-only', sha).splitlines() if COMPOSE.match(path)]
    for path in sorted(files):
        for image, tag, number in image_pins(show(sha, path) or '', owner, own_images):
            where = '{}:{}'.format(path, number)
            pin = '{}:{}'.format(image, tag) if tag else image
            if not tag:
                add('image', where, pin, 'no tag (latest): prod needs an X.Y.Z tag')
            elif PRERELEASE_TAG.match(tag):
                same = prod_image(image, tag)
                add('image', where, pin, None if same else 'not the current prod image (latest): prod needs an X.Y.Z tag or the same digest')
                if same:
                    rows[-1] = rows[-1][:3] + ('ok (= prod digest)',)
            elif not SEMVER.match(tag):
                add('image', where, pin, 'not a release: prod needs an X.Y.Z tag')
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
