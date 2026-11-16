"""Republish an OpenAPI contract package under the version of a promotion (MAIR-999).

The package of a commit is generated once, by `release-dev` (`0.0.0-dev-<sha7>` for the APIs,
`0.0.0-dev.<sha40>` for the BFFs). promote-staging and promote-prod used to regenerate it (`cargo
open_api` compiles the whole API, orval runs again) only to publish the same files under another
version. This script downloads the package of the source version, changes `version` in its
`package.json` and publishes it under the target version and dist-tag: the contents cannot differ
from what dev tested, and the promotion no longer compiles anything.

Standard library only. Parameters come from the environment (see `main`); writes
`published=true|false` to $GITHUB_OUTPUT:

- `true`: the target version exists (published now, or by an earlier attempt of the run);
- `false`: the source version does not exist (a commit released before MAIR-999, a package
  removed): the caller falls back to generating the package.

Any other npm error fails the step: a registry or token problem must not silently fall back.
"""

import json
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

NOT_FOUND = ('E404', '404 Not Found', 'is not in this registry', 'No matching version')


class Failed(Exception):
    pass


def npm(args, userconfig, cwd=None):
    return subprocess.run(['npm', *args, '--userconfig', str(userconfig)], cwd=cwd,
                          capture_output=True, text=True)


def not_found(result):
    return any(marker in (result.stderr or '') + (result.stdout or '') for marker in NOT_FOUND)


def exists(spec, userconfig):
    """True when `spec` (name@version) is published, False on a 404, raises on any other error."""
    result = npm(['view', spec, 'version', '--json'], userconfig)
    if result.returncode == 0:
        return bool(result.stdout.strip())
    if not_found(result):
        return False
    raise Failed('npm view {} failed: {}'.format(spec, (result.stderr or result.stdout).strip()))


def safe_members(archive, root):
    """Members of the npm tarball, refusing anything that would land outside `root`."""
    base = Path(root).resolve()
    for member in archive.getmembers():
        target = (base / member.name).resolve()
        if base != target and base not in target.parents:
            raise Failed('unexpected path in the package tarball: {}'.format(member.name))
        if not (member.isfile() or member.isdir()):
            raise Failed('unexpected entry in the package tarball: {}'.format(member.name))
        yield member


def repack(name, source, target, dist_tag, userconfig, workdir):
    result = npm(['pack', '{}@{}'.format(name, source), '--json', '--pack-destination', str(workdir)], userconfig,
                 cwd=workdir)
    if result.returncode != 0:
        if not_found(result):
            return False
        raise Failed('npm pack {}@{} failed: {}'.format(name, source, (result.stderr or result.stdout).strip()))
    tarballs = sorted(Path(workdir).glob('*.tgz'))
    if len(tarballs) != 1:
        raise Failed('npm pack produced {} tarballs'.format(len(tarballs)))
    extract = Path(workdir) / 'extract'
    extract.mkdir()
    with tarfile.open(tarballs[0]) as archive:
        archive.extractall(extract, members=list(safe_members(archive, extract)))
    package_dir = extract / 'package'
    manifest_path = package_dir / 'package.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('name') != name:
        raise Failed('the tarball holds {}, expected {}'.format(manifest.get('name'), name))
    manifest['version'] = target
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    result = npm(['publish', str(package_dir), '--access', 'restricted', '--tag', dist_tag], userconfig, cwd=workdir)
    if result.returncode != 0:
        raise Failed('npm publish {}@{} failed: {}'.format(name, target, (result.stderr or result.stdout).strip()))
    return True


def main(env):
    owner = env['GITHUB_REPOSITORY_OWNER'].lower()
    name = '@{}/{}-openapi'.format(owner, env['PACKAGE_NAME'].lower())
    source, target = env['FROM_VERSION'].strip(), env['TO_VERSION'].strip()
    dist_tag = env.get('DIST_TAG', '').strip() or 'latest'
    if not source or not target:
        raise Failed('from_version and to_version are required')
    with tempfile.TemporaryDirectory() as tmp:
        userconfig = Path(tmp) / '.npmrc'
        # The token stays in the environment: npm expands ${NODE_AUTH_TOKEN} when it reads the file.
        userconfig.write_text('@{}:registry=https://npm.pkg.github.com\n'
                              '//npm.pkg.github.com/:_authToken=${{NODE_AUTH_TOKEN}}\n'.format(owner),
                              encoding='utf-8')
        if exists('{}@{}'.format(name, target), userconfig):
            print('{}@{} is already published (earlier attempt): nothing to do'.format(name, target))
            return True
        workdir = Path(tmp) / 'work'
        workdir.mkdir()
        if not repack(name, source, target, dist_tag, userconfig, workdir):
            print('::warning title=promote-openapi::{}@{} does not exist: the package is generated again'
                  .format(name, source))
            return False
    print('Published {}@{} (dist-tag {}) from {}'.format(name, target, dist_tag, source))
    return True


if __name__ == '__main__':
    try:
        published = main(os.environ)
    except Failed as failure:
        print('::error title=promote-openapi::{}'.format(failure))
        sys.exit(1)
    with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as out:
        out.write('published={}\n'.format('true' if published else 'false'))
