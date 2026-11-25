#!/usr/bin/env python3
"""Writes the DP-72 private Git source runs into cases.json (replacing any earlier ones): a private repository
cloned through a GitHub App (an installation token in the clone URL) and through a deploy key (the key written
in the helper container, GIT_SSH_COMMAND). The cases are data: Coolify's PHP decides every expectation.
Usage: python3 private-cases.py cases.json ../sources/cases.json"""
import json, sys

path, sources = sys.argv[1], sys.argv[2]
doc = json.load(open(path))
PREFIXES = ('ghapp.', 'deploykey.')
doc['runs'] = [r for r in doc['runs'] if not r['id'].startswith(PREFIXES)]

# Test keys only, made for these cases (the App's is ../sources' RSA test key; the deploy key a throwaway
# ed25519 key): they protect nothing.
APP_KEY = next(f['args']['privateKey'] for f in json.load(open(sources))['functions'] if f['id'] == 'jwt.pkcs1')
DEPLOY_KEY = """-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtz
c2gtZWQyNTUxOQAAACBRA7i5Th4DYoMYywfRDk10fl6bFLmcOGrLMWcfqQlcmAAA
AIiu9QcRrvUHEQAAAAtzc2gtZWQyNTUxOQAAACBRA7i5Th4DYoMYywfRDk10fl6b
FLmcOGrLMWcfqQlcmAAAAECTSD2qxDZ3IU4JVXJlawhcd/Ksr92kiYe8qKs4xqk/
pFEDuLlOHgNigxjLB9EOTXR+XpsUuZw4assxZx+pCVyYAAAAAAECAwQF
-----END OPENSSH PRIVATE KEY-----"""

SHA = '4a3c2b1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b'
SHA2 = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c'
DEP = 'dep0000000000000000000001'
APP = 'app0000000000000000000001'
A = '/artifacts/' + DEP
DOCKERFILE = 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci\nCMD ["node", "server.js"]\n'
DF = {'match': 'cat ' + A + '/Dockerfile', 'output': DOCKERFILE}
LS = {'match': 'ls-remote', 'output': SHA + '\trefs/heads/main\n'}
OLD = {'match': 'docker ps -a --filter', 'output': '{"ID":"old1","Names":"' + APP + '-20261119T090000","State":"running","Labels":"coolify.managed=true,coolify.pullRequestId=0","Image":"' + APP + ':old"}\n'}
KNOWN = 'git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n'
NIXPLAN = json.dumps({'providers': [], 'buildImage': 'ghcr.io/railwayapp/nixpacks:ubuntu-1745885067', 'variables': {'CI': 'true', 'NIXPACKS_METADATA': 'node', 'NODE_ENV': 'production', 'NPM_CONFIG_PRODUCTION': 'false'},
                      'phases': {'setup': {'nixPkgs': ['nodejs_22'], 'nixOverlays': [], 'nixpkgsArchive': 'ffeebf0acf3ae8b29f8c7049cd911b9636efd7e7'}}, 'start': {'cmd': 'npm run start'}}) + '\n'
NIX = [{'match': 'nixpacks plan', 'output': NIXPLAN}, {'match': 'nixpacks detect', 'output': 'node\n'}, {'match': 'cat ' + A + '/.nixpacks/Dockerfile', 'output': 'FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067\nWORKDIR /app/\nCOPY . /app\nCMD ["npm run start"]\n'}]

BASE = {'docker_registry_image_name': None, 'docker_registry_image_tag': None, 'git_branch': 'main', 'ports_exposes': '3000', 'build_pack': 'dockerfile'}
GITHUB_APP = {'name': 'freeploy-test', 'organization': 'acme', 'api_url': 'https://api.github.com', 'html_url': 'https://github.com', 'custom_user': 'git', 'custom_port': 22,
              'app_id': 4242, 'installation_id': 777, 'is_public': False, 'privateKey': APP_KEY}
TOKEN = {'match': r'^POST https://api\.github\.com/app/installations/777/access_tokens$', 'status': 201, 'body': {'token': 'ghs_TestInstallationToken0123456789'}}
REPO = {'match': r'^GET https://api\.github\.com/repos/acme/private-app$', 'body': {'id': 987654, 'full_name': 'acme/private-app'}}
runs = []


def case(id, about, app, settings=None, responses=None, **more):
    c = {'id': id, 'about': about, 'application': app}
    if settings:
        c['settings'] = settings
    c['responses'] = responses or []
    c.update(more)
    runs.append(c)


# (suffix, about, application fields, settings, responses, more): the clone and ls-remote paths both sources take.
SHARED = [
    ('first', 'built for the first time', {}, {}, [], {}),
    ('rolling', 'a rolling update over a running container', {}, {}, [OLD], {}),
    ('pinned', 'a pinned commit: the head of the branch is not asked for it', {'git_commit_sha': SHA2}, {}, [], {}),
    ('pinned.short', 'a pinned short commit: the tips of the branches are fetched', {'git_commit_sha': 'abc1234'}, {}, [], {}),
    ('pinned.full-history', 'a pinned commit without a shallow clone', {'git_commit_sha': SHA2}, {'is_git_shallow_clone_enabled': False}, [], {}),
    ('message', 'the message of the commit is stored', {}, {}, [{'match': 'git log -1', 'output': 'feat: private things\n'}], {}),
    ('clone-fails', 'the repository cannot be cloned', {}, {}, [OLD, {'match': ' clone ', 'errorOutput': 'fatal: Authentication failed\n', 'exitCode': 128}], {}),
    ('clone-retry', 'the SSH connection drops during the clone: it is tried again', {}, {}, [{'match': ' clone ', 'sequence': [{'errorOutput': 'Connection to 10.0.0.5 closed by remote host.\n', 'exitCode': 255}, {'output': ''}]}], {}),
    ('ls-remote-fails', 'the head of the branch cannot be read', {}, {}, [{'match': 'ls-remote', 'errorOutput': 'fatal: could not read Username for \'https://github.com\': terminal prompts disabled\n', 'exitCode': 128}], {}),
    ('known-hosts', 'git accepted the SSH key of a new host: it is saved', {}, {}, [{'match': 'cat /root/.ssh/coolify_git', 'output': KNOWN}], {}),
    ('base-directory', 'an application in a folder of its repository', {'base_directory': '/apps/web'}, {}, [{'match': 'cat ' + A + '/apps/web/Dockerfile', 'output': DOCKERFILE}], {}),
    ('git-options', 'no shallow clone, no submodules, no LFS', {}, {'is_git_shallow_clone_enabled': False, 'is_git_submodules_enabled': False, 'is_git_lfs_enabled': False}, [], {}),
    ('submodules-only', 'submodules without LFS', {}, {'is_git_lfs_enabled': False}, [], {}),
    ('force', 'a forced rebuild', {}, {}, [], {'deployment': {'force_rebuild': True}}),
]

# ── A GitHub App: the installation token in the clone URL and in the -c url.<…>.insteadOf options ──
GH = dict(BASE, git_repository='acme/private-app')
for suffix, about, extra, settings, responses, more in SHARED:
    case('ghapp.' + suffix, 'a private repository through a GitHub App: ' + about, dict(GH, **extra), settings, responses + [LS, DF], githubApp=GITHUB_APP, github=[TOKEN, REPO], **more)
case('ghapp.nixpacks', 'a private repository through a GitHub App, built with Nixpacks', dict(GH, build_pack='nixpacks'), None, [LS] + NIX, githubApp=GITHUB_APP, github=[TOKEN, REPO])
case('ghapp.repository-id-known', 'the repository id is already stored: it is not written again', dict(GH, repository_project_id=987654), None, [LS, DF], githubApp=GITHUB_APP, github=[TOKEN, REPO])
case('ghapp.repository-id-moved', 'GitHub answers another id for the repository: it is stored', dict(GH, repository_project_id=111), None, [LS, DF], githubApp=GITHUB_APP, github=[TOKEN, REPO])
case('ghapp.token-fails', 'GitHub refuses the installation token: the deployment fails', GH, None, [LS, DF], githubApp=GITHUB_APP, github=[{'match': 'access_tokens', 'status': 404, 'body': {'message': 'Not Found'}}])
case('ghapp.token-refused', 'GitHub refuses the installation token with its own message', GH, None, [LS, DF], githubApp=GITHUB_APP, github=[{'match': 'access_tokens', 'status': 403, 'body': {'message': 'Resource not accessible by integration'}}])
case('ghapp.repository-fails', 'GitHub cannot say what the repository is: the deployment fails', GH, None, [LS, DF], githubApp=GITHUB_APP, github=[TOKEN, {'match': 'repos/acme/private-app', 'status': 404, 'body': {'message': 'Not Found'}}])
# (A GitHub Enterprise Server App is not emitted: Coolify's Http::GitSource() resolves the App's host before it asks
# it, and the emitter runs without DNS, so the run would only record that failure.)
case('ghapp.custom-user', 'an App whose SSH user is not git: the submodule rewrite uses it', GH, None, [LS, DF], githubApp=dict(GITHUB_APP, custom_user='deployer'), github=[TOKEN, REPO])

# ── A deploy key: the key written in the helper container and given to ssh ──
for suffix, about, extra, settings, responses, more in SHARED:
    case('deploykey.' + suffix, 'a private repository through a deploy key: ' + about, dict(BASE, git_repository='git@github.com:acme/private-app.git', **extra), settings, responses + [LS, DF], deployKey=DEPLOY_KEY, **more)
case('deploykey.github-https', 'a github.com URL with the public source: rewritten to SSH for the deploy key', dict(BASE, git_repository='acme/private-app', source_id=0, source_type='App\\Models\\GithubApp'), None, [LS, DF], deployKey=DEPLOY_KEY)
case('deploykey.ssh-port', 'an ssh:// URL with its own port', dict(BASE, git_repository='ssh://git@git.example.com:2222/acme/private-app.git'), None, [LS, DF], deployKey=DEPLOY_KEY)
case('deploykey.scp-port', 'an scp-style URL with a port', dict(BASE, git_repository='git@git.example.com:2222/acme/private-app.git'), None, [LS, DF], deployKey=DEPLOY_KEY)
case('deploykey.nixpacks', 'a deploy key and Nixpacks', dict(BASE, git_repository='git@github.com:acme/private-app.git', build_pack='nixpacks'), None, [LS] + NIX, deployKey=DEPLOY_KEY)
case('deploykey.host-key-changed', 'the Git host sent another SSH host key', dict(BASE, git_repository='git@git.example.com:acme/private-app.git'), None, [{'match': 'ls-remote', 'errorOutput': 'Host key verification failed.\nfatal: Could not read from remote repository.\n', 'exitCode': 128}], deployKey=DEPLOY_KEY)

ids = [r['id'] for r in runs]
assert len(ids) == len(set(ids))
doc['runs'] += runs
json.dump(doc, open(path, 'w'), indent=2, ensure_ascii=False)
open(path, 'a').write('\n')
from collections import Counter
print(Counter(i.split('.')[0] for i in ids), len(doc['runs']), 'runs in all')
