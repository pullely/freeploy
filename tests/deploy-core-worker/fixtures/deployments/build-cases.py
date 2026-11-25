#!/usr/bin/env python3
"""Writes the DP-61 build cases into cases.json (replacing any earlier DP-61 cases).
The cases are data: Coolify's PHP decides every expectation.  Usage: python3 build-cases.py cases.json build-cases-body.py"""
import json, sys
path = sys.argv[1]
doc = json.load(open(path))
PREFIXES = ('simple.', 'dockerfile.', 'static.', 'nixpacks.')
doc['runs'] = [r for r in doc['runs'] if not r['id'].startswith(PREFIXES)]
SHA = '4a3c2b1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b'
SHA2 = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c'
DEP = 'dep0000000000000000000001'
APP = 'app0000000000000000000001'
REPO = {'docker_registry_image_name': None, 'docker_registry_image_tag': None, 'source_id': 0, 'source_type': 'App\\Models\\GithubApp',
        'git_repository': 'coollabsio/coolify-examples', 'git_branch': 'main', 'ports_exposes': '3000'}
LS = {'match': 'ls-remote', 'output': SHA + '\trefs/heads/main\n'}
runs = []


def case(id, about, app=None, settings=None, responses=None, **more):
    c = {'id': id, 'about': about}
    if app is not None:
        c['application'] = app
    if settings:
        c['settings'] = settings
    if responses:
        c['responses'] = responses
    c.update(more)
    runs.append(c)


DOCKERFILE = 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["node", "server.js"]\n'
PLAN_OBJECT = {'providers': [], 'buildImage': 'ghcr.io/railwayapp/nixpacks:ubuntu-1745885067',
               'variables': {'CI': 'true', 'NIXPACKS_METADATA': 'node', 'NODE_ENV': 'production', 'NPM_CONFIG_PRODUCTION': 'false'},
               'phases': {'build': {'dependsOn': ['install'], 'cmds': ['npm run build'], 'cacheDirectories': ['node_modules/.cache']},
                          'install': {'dependsOn': ['setup'], 'cmds': ['npm ci'], 'cacheDirectories': ['/root/.npm']},
                          'setup': {'nixPkgs': ['nodejs_22', 'npm-9_x'], 'nixOverlays': [], 'nixpkgsArchive': 'ffeebf0acf3ae8b29f8c7049cd911b9636efd7e7'}},
               'start': {'cmd': 'npm run start'}}


def plan(**changes):
    p = json.loads(json.dumps(PLAN_OBJECT))
    for key, value in changes.items():
        p[key] = value
    return json.dumps(p) + '\n'


def nix(plan_output=None, kind='node'):
    return [{'match': 'nixpacks plan', 'output': plan_output if plan_output is not None else plan()}, {'match': 'nixpacks detect', 'output': kind + '\n'}]


def cat(path, output):
    return {'match': 'cat ' + path, 'output': output}


exec(open(sys.argv[2]).read())
ids = [r['id'] for r in runs]
assert len(ids) == len(set(ids)), sorted(i for i in set(ids) if ids.count(i) > 1)
doc['runs'] += runs
json.dump(doc, open(path, 'w'), indent=2, ensure_ascii=False)
open(path, 'a').write('\n')
from collections import Counter
print(Counter(i.split('.')[0] for i in ids), len(doc['runs']), 'runs in all')
