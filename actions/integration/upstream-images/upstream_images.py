"""Log the digest behind each moving upstream tag of the test stacks (MAIR-998).

The compose stacks of the services pull their upstreams (database, APIs, BFFs) with the moving
tag of the stage under test: `ghcr.io/<owner>/<name>:${UPSTREAM_TAG:-dev}`, where the CICD
workflows set UPSTREAM_TAG to `dev` (PRs, main), `staging` (promote-staging gates) or `latest`
(promote-prod gates). Nothing is pinned, so a run must say what it tested: this script lists those
images in the root `docker-compose*.yml` files and writes the digest each tag points to now into
the job summary. It never fails the job (an unresolved tag is reported as such).
"""
import json
import os
import re
import subprocess
import sys

COMPOSE = re.compile(r'^docker-compose[-.][^/]*\.ya?ml$|^docker-compose\.ya?ml$')


def moving_images(text, owner):
    pattern = re.compile(r'ghcr\.io/{}/([a-z0-9][a-z0-9._-]*):\$\{{UPSTREAM_TAG\b'.format(re.escape(owner)), re.IGNORECASE)
    return {match.group(1).lower() for line in text.splitlines() if not line.lstrip().startswith('#')
            for match in pattern.finditer(line)}


def digest(ref):
    result = subprocess.run(['docker', 'buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest}}'],
                            capture_output=True, text=True)
    if result.returncode != 0:
        return None
    try:
        manifest = json.loads(result.stdout)
    except ValueError:
        return None
    return manifest.get('digest') if isinstance(manifest, dict) else None


def main(env, root='.', resolve=digest):
    tag = env.get('UPSTREAM_TAG') or 'dev'
    owner = env['GITHUB_REPOSITORY_OWNER'].lower()
    names = set()
    for name in sorted(os.listdir(root)):
        if COMPOSE.match(name):
            with open(os.path.join(root, name), encoding='utf-8') as handle:
                names |= moving_images(handle.read(), owner)
    lines = ['### Upstream images (`UPSTREAM_TAG={}`, MAIR-998)'.format(tag), '']
    if not names:
        lines.append('No upstream image on a moving tag.')
    else:
        lines += ['| Image | Digest now |', '| --- | --- |']
        for name in sorted(names):
            ref = 'ghcr.io/{}/{}:{}'.format(owner, name, tag)
            found = resolve(ref)
            lines.append('| `{}` | {} |'.format(ref, '`{}`'.format(found) if found else 'not resolved'))
            print('{} -> {}'.format(ref, found or 'not resolved'))
    with open(env.get('GITHUB_STEP_SUMMARY', os.devnull), 'a', encoding='utf-8') as out:
        out.write('\n'.join(lines) + '\n\n')
    return 0


if __name__ == '__main__':
    sys.exit(main(os.environ))
