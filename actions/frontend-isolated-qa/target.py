"""Validate the existing frontend scope and select an unmodified Compose scanner."""
import argparse
import json
import os
import pathlib
import re
import subprocess

PACKAGES = {
    'Login_Web_Service': 'login-front',
    'Projects_Web_Service': 'projects-front',
    'Calendars_Web_Service': 'calendar-front',
    'Messages_Web_Service': 'message-front',
    'Elearning_Web_Service': 'elearning-front',
    'Administrator_Web_Service': 'administrator-front',
    'Dashboard_Web_Service': 'dashboard-front',
    'Settings_Web_Service': 'settings-front',
}

def target(repo, sha, digest, kind):
    if repo not in PACKAGES:
        raise ValueError('Frontend repository is outside the permitted scope')
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('An exact commit SHA is required')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
        raise ValueError('An exact image digest is required')
    if kind not in ('security', 'performance', 'both'):
        raise ValueError('Unsupported scanner selection')
    image = 'ghcr.io/mairie360/' + PACKAGES[repo]
    return dict(repo=repo, sha=sha, image=image + '@' + digest,
                tag=image + ':dev-' + sha[:7],
                matrix=json.dumps({'kind': ['security', 'performance'] if kind == 'both' else [kind]}))

def scanner(model, image, kind):
    services = model['services']
    fronts = [name for name, service in services.items() if service.get('image') == image]
    if len(fronts) != 1:
        raise ValueError('The verified digest must select exactly one frontend service')
    prefix = 'zaproxy/zap-' if kind == 'security' else 'grafana/k6'
    matches = [name for name, service in services.items() if service.get('image', '').startswith(prefix)]
    if len(matches) != 1:
        raise ValueError('Exactly one existing scanner service is required')
    return matches[0]

def write_outputs(values):
    with pathlib.Path(os.environ['GITHUB_OUTPUT']).open('a') as output:
        for key, value in values.items():
            output.write(f'{key}={value}\n')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=('inputs', 'compose'))
    args = parser.parse_args()
    if args.mode == 'inputs':
        write_outputs(target(os.environ['FRONT_REPO'], os.environ['FRONT_SHA'],
                             os.environ['IMAGE_DIGEST'], os.environ['TEST_KIND']))
    else:
        kind = os.environ['TEST_KIND']
        if kind not in ('security', 'performance'):
            raise ValueError('A single scanner is required for this job')
        filename = f'docker-compose-{kind}.yml'
        result = subprocess.run(['docker', 'compose', '-f', filename, 'config', '--format', 'json'],
                                check=True, capture_output=True, text=True)
        name = scanner(json.loads(result.stdout), os.environ['TARGET_IMAGE'], kind)
        write_outputs({'file': filename, 'service': name})

if __name__ == '__main__':
    main()
