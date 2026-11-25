A = '/artifacts/' + DEP
D = dict(REPO, build_pack='dockerfile')
N = dict(REPO, build_pack='nixpacks')
S = dict(REPO, build_pack='static', ports_exposes='80')
P = dict(build_pack='dockerfile', docker_registry_image_name=None, docker_registry_image_tag=None, dockerfile=DOCKERFILE, ports_exposes='3000', git_repository='coollabsio/coolify', git_branch='main')
DF = cat(A + '/Dockerfile', DOCKERFILE)
NIXDF = 'FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067\n\nENTRYPOINT ["/bin/bash", "-l", "-c"]\nWORKDIR /app/\n\nCOPY .nixpacks/nixpkgs-ffeebf0.nix .nixpacks/nixpkgs-ffeebf0.nix\nRUN nix-env -if .nixpacks/nixpkgs-ffeebf0.nix && nix-collect-garbage -d\n\nARG CI NIXPACKS_METADATA NODE_ENV NPM_CONFIG_PRODUCTION\nENV CI=$CI NIXPACKS_METADATA=$NIXPACKS_METADATA NODE_ENV=$NODE_ENV NPM_CONFIG_PRODUCTION=$NPM_CONFIG_PRODUCTION\n\nCOPY . /app/.\nRUN --mount=type=cache,id=app-/root/npm,target=/root/.npm npm ci\n\nCOPY . /app/.\nRUN --mount=type=cache,id=app-node_modules/cache,target=/app/node_modules/.cache npm run build\n\nCOPY . /app\n\nCMD ["npm run start"]\n'
NDF = cat(A + '/.nixpacks/Dockerfile', NIXDF)
OLD_LINE = '{"ID":"old1","Names":"' + APP + '-20261119T090000","State":"running","Labels":"coolify.managed=true,coolify.pullRequestId=0","Image":"' + APP + ':old"}\n'
NEW_LINE = '{"ID":"new1","Names":"' + APP + '-20261120T101112","State":"running","Labels":"coolify.managed=true,coolify.pullRequestId=0","Image":"' + APP + ':new"}\n'
OLD = {'match': 'docker ps -a --filter', 'output': OLD_LINE}
IMG = {'match': 'docker images -q', 'output': 'sha256:1f2e3d4c5b6a\n'}
SECRETS = {'match': "grep -q 'secret'", 'output': 'supported\n'}
SNAP = [{'deployment_uuid': 'dep0000000000000000000000', 'status': 'finished', 'commit': SHA, 'configuration_snapshot': 'current', 'commit_message': 'feat: an earlier deployment'}]


def V(key, value, **flags):
    v = {'key': key, 'value': value, 'is_runtime': True, 'is_buildtime': True, 'is_literal': False, 'is_multiline': False}
    v.update(flags)
    return v


VARS = [
    V('APP_NAME', 'My App'),
    V('NODE_ENV', 'production'),
    V('GREETING', "it's \"quoted\" $HOME `x` \\ end"),
    V('LITERAL', "pa$$word 'single'", is_literal=True),
    V('MULTI', "line one\nline two", is_multiline=True),
    V('RUNTIME_ONLY', 'at-runtime', is_buildtime=False),
    V('BUILD_ONLY', 'at-build', is_runtime=False),
    V('JSON', '{"a": [1, 2], "b": "c"}'),
    V('EMPTY', ''),
    V('REF', '$APP_NAME/${NODE_ENV}'),
]

# What every build pack shares, case by case: (suffix, about, extra application fields, settings, extra responses, more)
PACKS = [
    ('dockerfile', 'a Dockerfile in a public repository', D, [LS, DF]),
    ('simple', 'a pasted Dockerfile', P, [DF]),
    ('nixpacks', 'a Nixpacks application', N, [LS, NDF] + nix()),
    ('static', 'a static site', S, [LS]),
]
HEALTH = {'health_check_enabled': True, 'health_check_interval': 2, 'health_check_start_period': 1, 'health_check_retries': 3}
SHARED = [
    ('first', 'built for the first time', {}, {}, [], {}),
    ('rolling', 'a rolling update over a running container', {}, {}, [OLD], {}),
    ('health', 'a rolling update whose health check passes', HEALTH, {}, [{'match': 'docker ps -a --filter', 'sequence': [{'output': OLD_LINE}, {'output': OLD_LINE + NEW_LINE}]}], {}),
    ('unhealthy', 'the new container is unhealthy: the old one stays', HEALTH, {}, [OLD, {'match': 'State.Health.Status', 'output': '"unhealthy"\n'}, {'match': 'docker logs -n 100', 'output': 'Error: listen EADDRINUSE\n'}], {}),
    ('force', 'a forced rebuild: no cache, and the image of the commit is not looked for', {}, {}, [IMG], {'deployment': {'force_rebuild': True}}),
    ('no-cache', 'the build cache is disabled', {}, {'disable_build_cache': True}, [], {}),
    ('args', 'build-time variables of every kind', {}, {}, [], {'variables': VARS}),
    ('args.sorted', 'build-time variables, sorted by name', {}, {'is_env_sorting_enabled': True}, [], {'variables': VARS}),
    ('secrets', 'build secrets: the variables come in with --secret', {}, {'use_build_secrets': True}, [SECRETS], {'variables': VARS}),
    ('secrets.none', 'build secrets on, and no variable of the user', {}, {'use_build_secrets': True}, [SECRETS], {}),
    ('secrets.unsupported', 'build secrets on, and a Docker that has none', {}, {'use_build_secrets': True}, [{'match': "grep -q 'secret'", 'output': 'not-supported\n'}], {'variables': VARS}),
    ('secrets.force', 'build secrets and a forced rebuild', {}, {'use_build_secrets': True}, [SECRETS], {'variables': VARS, 'deployment': {'force_rebuild': True}}),
    ('no-buildkit', 'a Docker without BuildKit: the legacy builder', {}, {}, [{'match': 'docker buildx version', 'output': 'not-available\n'}, {'match': 'DOCKER_BUILDKIT=1 docker build --help', 'output': 'not-supported\n'}], {'variables': VARS[:2]}),
    ('no-buildkit.force', 'the legacy builder and a forced rebuild', {}, {}, [{'match': 'docker buildx version', 'output': 'not-available\n'}, {'match': 'DOCKER_BUILDKIT=1 docker build --help', 'output': 'not-supported\n'}], {'deployment': {'force_rebuild': True}}),
    ('build-fails', 'the build fails', {}, {}, [OLD, {'match': 'bash /artifacts/build.sh', 'output': '#5 [2/4] RUN npm ci\n', 'errorOutput': 'ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1\n', 'exitCode': 1}], {}),
    ('source-commit', 'SOURCE_COMMIT is part of the build', {}, {'include_source_commit_in_build': True}, [], {'variables': VARS[:1]}),
    ('registry', 'the image is pushed to the registry of the application', {'docker_registry_image_name': 'ghcr.io/acme/app'}, {}, [], {}),
    ('registry.tag', 'the image is pushed with its commit and with the tag of the application', {'docker_registry_image_name': 'ghcr.io/acme/app', 'docker_registry_image_tag': 'stable'}, {}, [], {}),
    ('registry.push-fails', 'the push is refused', {'docker_registry_image_name': 'ghcr.io/acme/app'}, {}, [{'match': 'docker push', 'errorOutput': 'denied: requested access to the resource is denied\n', 'exitCode': 1}], {}),
    ('commands', 'a pre-deployment and a post-deployment command', {'pre_deployment_command': 'php artisan down', 'post_deployment_command': 'php artisan up'}, {}, [OLD, {'match': 'php artisan up', 'output': 'Application is now live.\n'}], {}),
    ('cancel', 'cancelled while the image builds', {}, {}, [OLD], {'cancelOn': 'bash /artifacts/build.sh'}),
    ('add-hosts', 'the containers of the network are hosts of the build', {}, {}, [{'match': 'docker network inspect', 'output': json.dumps({
        'c1': {'Name': 'postgres-db', 'EndpointID': 'e1', 'MacAddress': '02:42:ac:12:00:03', 'IPv4Address': '172.18.0.3/16', 'IPv6Address': ''},
        'c2': {'Name': 'coolify-proxy', 'EndpointID': 'e2', 'MacAddress': '02:42:ac:12:00:02', 'IPv4Address': '172.18.0.2/16', 'IPv6Address': ''},
        'c3': {'Name': APP + '-20261119T090000', 'EndpointID': 'e3', 'MacAddress': '02:42:ac:12:00:04', 'IPv4Address': '172.18.0.4/16', 'IPv6Address': ''},
        'c4': {'Name': DEP, 'EndpointID': 'e4', 'MacAddress': '02:42:ac:12:00:05', 'IPv4Address': '172.18.0.5/16', 'IPv6Address': ''},
        'c5': {'Name': 'app-pr-12', 'EndpointID': 'e5', 'MacAddress': '02:42:ac:12:00:06', 'IPv4Address': '172.18.0.6/16', 'IPv6Address': ''},
        'c6': {'Name': 'backup-of-db', 'EndpointID': 'e6', 'MacAddress': '02:42:ac:12:00:07', 'IPv4Address': '172.18.0.7/16', 'IPv6Address': ''},
        'c7': {'Name': 'a-redis', 'EndpointID': 'e7', 'MacAddress': '02:42:ac:12:00:08', 'IPv4Address': '172.18.0.8/16', 'IPv6Address': ''},
        'c8': {'Name': 'no-ip', 'EndpointID': 'e8', 'MacAddress': '', 'IPv4Address': '', 'IPv6Address': ''},
    }) + '\n'}], {}),
    ('no-domain', 'an application without a domain', {'fqdn': None}, {}, [], {}),
    ('ports', 'a port mapped to the host: the old container stops first', {'ports_mappings': '8080:3000'}, {}, [OLD], {}),
    ('legacy-keys', 'names new variables cannot use are left out of the build', {}, {}, [], {'variables': [V('L1', '1', stored_key='my-var'), V('with.dot', '2'), V('L3', '3', is_buildtime=False, stored_key='9lives'), V('L4', '4', is_runtime=False, stored_key='build-only'), V('OK', 'fine')]}),
    ('invalid-key', 'a build-time name no build can be given stops the deployment before the build', {}, {}, [], {'variables': [V('L1', '1', stored_key='my var')]}),
    ('vault', 'a {{vault.KEY}} reference without a secret manager stops the build', {}, {}, [], {'variables': [V('TOKEN', 'prefix-{{vault.API_KEY}}')]}),
    ('vault.literal', 'a literal keeps {{vault.KEY}} as text', {}, {}, [], {'variables': [V('TOKEN', '{{vault.API_KEY}}', is_literal=True)]}),
    ('warnings', 'build-time variables that often break a build are named in the log', {}, {}, [], {'variables': [V('NODE_ENV', 'production'), V('CI', 'true'), V('DJANGO_SETTINGS_MODULE', 'app.settings.prod'), V('APP_ENV', 'production', is_buildtime=False)]}),
    ('docker-old', 'a Docker that is too old for BuildKit', {}, {}, [{'match': 'docker version --format', 'output': '18.06.3\n'}], {}),
    ('helper-fails', 'the helper container does not start', {}, {}, [{'match': 'docker run -d --network', 'errorOutput': 'docker: Error response from daemon: network coolify not found.\n', 'exitCode': 125}], {}),
    ('up-fails', 'the new container does not start', {}, {}, [OLD, {'match': 'up --build -d', 'errorOutput': 'Error response from daemon: driver failed programming external connectivity\n', 'exitCode': 1}], {}),
]
for pack, what, app, responses in PACKS:
    for suffix, about, extra, settings, more_responses, more in SHARED:
        case(pack + '.' + suffix, what + ': ' + about, dict(app, **extra), settings, more_responses + responses, **more)

# ── What needs a repository: the three build packs that clone ──
GITPACKS = PACKS[:1] + PACKS[2:]
KNOWN = 'git.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n'
GIT = [
    ('pinned', 'a pinned commit: the head of the branch is not asked for it', {'git_commit_sha': SHA2}, {}, [], {}),
    ('pinned.short', 'a pinned short commit: the tips of the branches are fetched', {'git_commit_sha': 'abc1234'}, {}, [], {}),
    ('pinned.message', 'a pinned commit takes the message an earlier deployment stored', {'git_commit_sha': SHA2}, {}, [], {'earlierDeployments': [{'deployment_uuid': 'dep0000000000000000000000', 'status': 'finished', 'commit': SHA2, 'commit_message': 'fix: the earlier one'}], 'deployment': {'force_rebuild': True}}),
    ('rollback', 'a rollback deploys its commit', {}, {}, [OLD], {'deployment': {'rollback': True, 'commit': SHA2}}),
    ('message', 'the message of the commit is stored', {}, {}, [{'match': 'git log -1', 'output': 'feat: the new thing\n\nCo-authored-by: Someone <someone@example.com>\n'}], {}),
    ('clone-fails', 'the repository cannot be cloned', {}, {}, [OLD, {'match': 'git clone', 'errorOutput': "fatal: Remote branch main not found in upstream origin\n", 'exitCode': 128}], {}),
    ('clone-fails.host', 'the Git host cannot be reached from the helper container', {}, {}, [{'match': 'git clone', 'errorOutput': "fatal: unable to access 'https://github.com/coollabsio/coolify-examples/': Could not resolve host: github.com\n", 'exitCode': 128}], {}),
    ('clone-fails.host-key', 'the Git host sent another SSH host key', {}, {}, [{'match': 'git clone', 'errorOutput': 'Host key verification failed.\nfatal: Could not read from remote repository.\n', 'exitCode': 128}], {}),
    ('clone-retry', 'the SSH connection drops during the clone: it is tried again', {}, {}, [{'match': 'git clone', 'sequence': [{'errorOutput': 'Connection to 10.0.0.5 closed by remote host.\n', 'exitCode': 255}, {'output': ''}]}], {}),
    ('clone-retry.fails', 'the SSH connection drops three times during the clone', {}, {}, [{'match': 'git clone', 'errorOutput': 'Connection to 10.0.0.5 closed by remote host.\n', 'exitCode': 255}], {}),
    ('ls-remote-fails', 'the head of the branch cannot be read', {}, {}, [{'match': 'ls-remote', 'errorOutput': "fatal: unable to access 'https://github.com/coollabsio/coolify-examples/': Failed to connect to github.com port 443 after 30001 ms: Timeout was reached\n", 'exitCode': 128}], {}),
    ('ls-remote.warning', 'the answer to ls-remote has warnings around the commit', {}, {}, [{'match': 'ls-remote', 'output': 'warning: redirecting to https://github.com/coollabsio/coolify-examples.git/\n' + SHA + '\trefs/heads/main\n'}], {}),
    ('ls-remote.empty', 'the branch has no head: the commit stays HEAD', {}, {}, [{'match': 'ls-remote', 'output': ''}], {}),
    ('known-hosts', 'git accepted the SSH key of a new host: it is saved', {}, {}, [{'match': 'cat /root/.ssh/coolify_git', 'output': KNOWN}], {}),
    ('known-hosts.saved', 'the SSH key git accepted is the saved one', {'git_ssh_known_hosts': KNOWN}, {}, [{'match': 'cat /root/.ssh/coolify_git', 'output': KNOWN}], {}),
    ('base-directory', 'an application in a folder of its repository', {'base_directory': '/apps/web'}, {}, [cat(A + '/apps/web/Dockerfile', DOCKERFILE)], {'variables': VARS[:1]}),
    ('git-options', 'no shallow clone, no submodules, no LFS', {}, {'is_git_shallow_clone_enabled': False, 'is_git_submodules_enabled': False, 'is_git_lfs_enabled': False}, [], {}),
    ('git-options.pinned', 'a pinned commit without a shallow clone', {'git_commit_sha': SHA2}, {'is_git_shallow_clone_enabled': False}, [], {}),
    ('other-source', 'a public repository of another host, by its URL', {'source_id': None, 'source_type': None, 'git_repository': 'https://gitlab.com/acme/site.git', 'git_branch': 'release/1.x'}, {}, [{'match': 'ls-remote', 'output': SHA + '\trefs/heads/release/1.x\n'}], {}),
    ('image-exists', 'the image of the commit exists, and the last deployment stored no configuration: it is built again', {}, {}, [IMG, OLD], {}),
    ('image-exists.same', 'the image of the commit exists and nothing of its build changed: the build is skipped', {}, {}, [IMG, OLD], {'earlierDeployments': SNAP}),
    ('image-exists.changed', 'the image of the commit exists, and the build configuration changed since', {}, {}, [IMG, OLD], {'earlierDeployments': SNAP, 'changedSince': {'application': {'base_directory': '/apps/web'}}}),
    ('image-exists.no-cache', 'the image of the commit exists, the build changed and the cache is off', {}, {'disable_build_cache': True}, [IMG], {'earlierDeployments': SNAP, 'deployment': {'restart_only': True}}),
    ('image-exists.registry', 'the image of the commit is not on the server: it is pulled from the registry, and started', {'docker_registry_image_name': 'ghcr.io/acme/app'}, {}, [{'match': 'docker images -q', 'sequence': [{'output': ''}, {'output': 'sha256:1f2e3d4c5b6a\n'}]}, OLD], {'earlierDeployments': SNAP}),
    ('image-exists.vault', 'the image of the commit exists, and a build-time variable references a remote secret', {}, {}, [IMG], {'earlierDeployments': SNAP, 'variables': [V('TOKEN', '{{vault.API_KEY}}')]}),
    ('restart', 'a restart', {}, {}, [IMG, OLD], {'earlierDeployments': SNAP, 'deployment': {'restart_only': True}}),
    ('restart.no-image', 'a restart whose image is gone', {}, {}, [OLD], {'earlierDeployments': SNAP, 'deployment': {'restart_only': True}}),
    ('restart.secrets', 'a restart with build secrets: the helper starts again with the commit', {}, {'use_build_secrets': True}, [SECRETS, IMG, OLD], {'earlierDeployments': SNAP, 'deployment': {'restart_only': True}, 'variables': VARS[:2]}),
]
for pack, what, app, responses in GITPACKS:
    for suffix, about, extra, settings, more_responses, more in GIT:
        case(pack + '.' + suffix, what + ': ' + about, dict(app, **extra), settings, more_responses + responses, **more)

# ── A Dockerfile, pasted or in the repository ──
HEALTHY_DF = 'FROM node:22-alpine AS build\nWORKDIR /app\nCOPY . .\nRUN npm ci\n\nFROM node:22-alpine\nCOPY --from=build /app /app\nHEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=4 CMD wget -qO- http://localhost:3000/health || exit 1\nCMD ["node", "server.js"]\n'
HEREDOC_DF = '# syntax=docker/dockerfile:1\n# escape=\\\nFROM python:3.12 AS base\nRUN <<EOF\nfrom app import x\npip install -r requirements.txt\nEOF\nRUN pip install \\\n    gunicorn\nfrom debian:12\nCOPY --from=base /app /app\nRUN --mount=type=secret,id=TOKEN cat /run/secrets/TOKEN\n'
for pack, what, app, responses in PACKS[:2]:
    def df(text):
        return dict(app, dockerfile=text) if 'dockerfile' in app else app

    def dfr(text, extra=None):
        return (extra or []) + [cat(A + '/Dockerfile', text)] + [r for r in responses if not r['match'].startswith('cat ')]
    case(pack + '.healthcheck', what + ': its HEALTHCHECK gives its timings to an application whose own health check is off', df(HEALTHY_DF), None, dfr(HEALTHY_DF, [OLD]))
    case(pack + '.healthcheck.own', what + ': its HEALTHCHECK is ignored when the application has its own', dict(df(HEALTHY_DF), **HEALTH), None, dfr(HEALTHY_DF, [OLD]))
    case(pack + '.healthcheck.removed', what + ': the HEALTHCHECK it had is gone, so the timings are reset', dict(df(DOCKERFILE), custom_healthcheck_found=True, health_check_interval=15, health_check_timeout=3, health_check_retries=4, health_check_start_period=20), None, dfr(DOCKERFILE))
    case(pack + '.stages', what + ': every stage gets the ARGs', df(HEALTHY_DF), None, dfr(HEALTHY_DF), variables=VARS[:3])
    case(pack + '.stages.secrets', what + ': every RUN of every stage gets the secret mounts', df(HEREDOC_DF), {'use_build_secrets': True}, dfr(HEREDOC_DF, [SECRETS]), variables=VARS[:3])
    case(pack + '.heredoc', what + ': a heredoc and a continued line are one instruction', df(HEREDOC_DF), None, dfr(HEREDOC_DF), variables=VARS[:2])
    case(pack + '.no-from', what + ': a file without FROM is left as it is', df('# nothing here\nRUN echo hi\n'), None, dfr('# nothing here\nRUN echo hi\n'), variables=VARS[:1])
    case(pack + '.no-inject', what + ': the ARG injection is turned off', df(DOCKERFILE), {'inject_build_args_to_dockerfile': False}, dfr(DOCKERFILE), variables=VARS[:2])
    case(pack + '.target', what + ': one stage is the target', dict(df(HEALTHY_DF), dockerfile_target_build='build'), None, dfr(HEALTHY_DF), variables=VARS[:1])
    case(pack + '.target.secrets', what + ': a target stage and build secrets', dict(df(HEALTHY_DF), dockerfile_target_build='build'), {'use_build_secrets': True}, dfr(HEALTHY_DF, [SECRETS]), variables=VARS[:1], deployment={'force_rebuild': True})
    case(pack + '.target.legacy', what + ': a target stage and the legacy builder', dict(df(HEALTHY_DF), dockerfile_target_build='build'), None, dfr(HEALTHY_DF, [{'match': 'docker buildx version', 'output': 'not-available\n'}, {'match': 'DOCKER_BUILDKIT=1 docker build --help', 'output': 'not-supported\n'}]))
    case(pack + '.target.invalid', what + ': a target that is no stage name stops the deployment', dict(df(DOCKERFILE), dockerfile_target_build='build; rm -rf /'), None, dfr(DOCKERFILE))
    case(pack + '.static', what + ': built, and served as a static site', dict(df(DOCKERFILE), publish_directory='/dist'), {'is_static': True}, dfr(DOCKERFILE, [OLD]), variables=VARS[:2])
    case(pack + '.static.spa', what + ': built, and served as a single page application', df(DOCKERFILE), {'is_static': True, 'is_spa': True}, dfr(DOCKERFILE), deployment={'force_rebuild': True})
    case(pack + '.static.secrets', what + ': built with build secrets, and served as a static site', df(DOCKERFILE), {'is_static': True, 'use_build_secrets': True}, dfr(DOCKERFILE, [SECRETS]), variables=VARS[:2])
    case(pack + '.env-empty', what + ': no variable reaches the container', dict(df(DOCKERFILE), fqdn=None, ports_exposes=''), {'include_coolify_default_variables': False}, dfr(DOCKERFILE), variables=[V('SOURCE_COMMIT', '', is_runtime=False, is_buildtime=False), V('COOLIFY_FQDN', '', is_runtime=False, is_buildtime=False), V('COOLIFY_URL', '', is_runtime=False, is_buildtime=False), V('COOLIFY_BRANCH', '', is_runtime=False, is_buildtime=False), V('COOLIFY_RESOURCE_UUID', '', is_runtime=False, is_buildtime=False), V('COOLIFY_CONTAINER_NAME', '', is_runtime=False, is_buildtime=False), V('HOST', '', is_runtime=False, is_buildtime=False)])
case('dockerfile.location', 'a Dockerfile in a public repository: at its own path', dict(D, dockerfile_location='/docker/Dockerfile.prod'), None, [LS, cat(A + '/docker/Dockerfile.prod', DOCKERFILE)], variables=VARS[:1])
case('dockerfile.location.base', 'a Dockerfile in a public repository: at its own path under the base directory', dict(D, base_directory='/apps/api', dockerfile_location='/docker/Dockerfile'), {'use_build_secrets': True}, [SECRETS, LS, cat(A + '/apps/api/docker/Dockerfile', DOCKERFILE)], variables=VARS[:1])
case('dockerfile.location.missing', 'a Dockerfile in a public repository: the file is not there', dict(D, dockerfile_location='/Dockerfile.missing'), None, [LS, {'match': 'cat ' + A + '/Dockerfile.missing', 'errorOutput': 'cat: ' + A + '/Dockerfile.missing: No such file or directory\n', 'exitCode': 1}, {'match': 'bash /artifacts/build.sh', 'errorOutput': 'ERROR: failed to read dockerfile: open Dockerfile.missing: no such file or directory\n', 'exitCode': 1}])
case('simple.restart', 'a pasted Dockerfile: a restart starts the image that is there', P, None, [IMG, OLD, DF], deployment={'restart_only': True}, earlierDeployments=[dict(SNAP[0], commit='HEAD')])
case('simple.restart.no-image', 'a pasted Dockerfile: a restart builds when the image is gone', P, None, [OLD, DF], deployment={'restart_only': True}, earlierDeployments=[dict(SNAP[0], commit='HEAD')])
case('simple.restart.legacy', 'a pasted Dockerfile: a restart builds when the last deployment stored no configuration', P, None, [IMG, OLD, DF], deployment={'restart_only': True})
case('simple.restart.force', 'a pasted Dockerfile: a forced restart builds', P, None, [IMG, OLD, DF], deployment={'restart_only': True, 'force_rebuild': True})
case('simple.restart.registry', 'a pasted Dockerfile with a registry image: a restart pulls the image, starts it and pushes it again', dict(P, docker_registry_image_name='ghcr.io/acme/app'), None, [{'match': 'docker images -q', 'sequence': [{'output': ''}, {'output': 'sha256:1f2e3d4c5b6a\n'}]}, OLD, DF], deployment={'restart_only': True}, earlierDeployments=[dict(SNAP[0], commit='HEAD')])
case('simple.location', 'a pasted Dockerfile: the location of a repository Dockerfile is not used', dict(P, dockerfile_location='/docker/Dockerfile.prod', base_directory='/'), None, [DF])
case('simple.empty-env', 'a pasted Dockerfile: no build-time variable at all', dict(P, fqdn=None), None, [DF], variables=[V('COOLIFY_FQDN', 'x', is_buildtime=False), V('COOLIFY_URL', 'x', is_buildtime=False), V('COOLIFY_BRANCH', 'x', is_buildtime=False), V('COOLIFY_RESOURCE_UUID', 'x', is_buildtime=False)])

# ── Nixpacks ──
def ncase(id, about, app=None, settings=None, responses=None, plan_output=None, kind='node', **more):
    case('nixpacks.' + id, 'a Nixpacks application: ' + about, dict(N, **(app or {})), settings, (responses or []) + [LS, NDF] + nix(plan_output, kind), **more)


ncase('own-commands', 'its own install, build and start commands', {'install_command': 'pnpm install --frozen-lockfile', 'build_command': "pnpm build && echo 'done'", 'start_command': 'node dist/server.js'})
ncase('variables', 'NIXPACKS_ variables steer the plan and stay out of the build arguments', variables=[V('NIXPACKS_BUILD_CMD', 'npm run build:prod'), V('NIXPACKS_PKGS', 'ffmpeg imagemagick', is_literal=True), V('NIXPACKS_EMPTY', ''), V('APP_NAME', 'My App')])
ncase('node-version', 'the plan names a Node version: no warning', plan_output=plan(variables={'CI': 'true', 'NIXPACKS_NODE_VERSION': '22', 'NODE_ENV': 'production'}))
ncase('apt', 'the plan has apt packages: curl and wget join them', plan_output=plan(phases={'setup': {'nixPkgs': ['nodejs_22'], 'aptPkgs': ['git', 'curl']}, 'build': {'cmds': ['npm run build']}}))
ncase('apt.none', 'a plan without phases gets its setup phase', plan_output=plan(phases={}))
ncase('python', 'a Python application', kind='python', plan_output=plan(variables={'NIXPACKS_METADATA': 'python', 'PYTHONUNBUFFERED': '1'}, start={'cmd': 'gunicorn app:app'}))
ncase('laravel', 'a Laravel application gets its two variables', kind='php', plan_output=plan(variables={'IS_LARAVEL': 'yes', 'NIXPACKS_METADATA': 'php', 'PORT': '80'}))
ncase('laravel.own', 'a Laravel application that has one of the two variables keeps it', None, {'is_env_sorting_enabled': True}, kind='php', plan_output=plan(variables={'IS_LARAVEL': 'yes', 'NIXPACKS_METADATA': 'php'}), variables=[V('NIXPACKS_PHP_ROOT_DIR', '/app/web')])
ncase('elixir', 'an Elixir application is told which variables it misses', kind='elixir', plan_output=plan(variables={'MIX_ENV': 'prod', 'NIXPACKS_METADATA': 'elixir'}), variables=[V('SECRET_KEY_BASE', 'abcdefghijklmnopqrstuvwxyz0123456789')])
ncase('rust', 'a Rust application has no curl to be checked with: its health check is turned off', {'health_check_enabled': True}, kind='rust', plan_output=plan(variables={'NIXPACKS_METADATA': 'rust', 'ROCKET_ADDRESS': '0.0.0.0'}))
ncase('detect-fails', 'Nixpacks does not know the application', kind='', plan_output=plan())
ncase('detect-silent', 'Nixpacks says nothing about the type', responses=[{'match': 'nixpacks detect', 'output': ''}])
ncase('plan-fails', 'Nixpacks cannot plan', responses=[{'match': 'nixpacks plan', 'errorOutput': 'Error: Nixpacks was unable to generate a build plan for this app.\n', 'exitCode': 1}])
ncase('plan-empty', 'Nixpacks prints no plan', plan_output='')
ncase('plan-not-json', 'Nixpacks prints something that is no JSON', plan_output='Warning: something\n')
ncase('plan-values', 'a plan with numbers, non-ASCII text, empty objects and lists', plan_output=json.dumps({'providers': ['node'], 'buildImage': 'img', 'variables': {'N': 1, 'F': 1.5, 'WHOLE': 2.0, 'BIG': 1e25, 'T': True, 'NO': False, 'NIL': None, 'TEXT': 'Grüße / "quoted" 日本語 😀', 'ZERO': 0}, 'phases': {'setup': {'nixPkgs': [], 'nixOverlays': {}, 'weights': {'0': 'a', '1': 'b'}, 'ratio': 0.1, 'tiny': 1.5e-7}}, 'start': {}}) + '\n')
ncase('plan-invalid-key', 'a plan with a variable name no shell can read stops the build', plan_output=plan(variables={'CI': 'true', 'MY KEY': 'x'}))
ncase('plan-dotted', 'a dotted name cannot be passed to Nixpacks', plan_output=plan(variables={'CI': 'true', 'app.name': 'x'}), variables=[V('with.dot', '2'), V('OK', 'fine')])
ncase('plan-coolify', "the plan's own COOLIFY_ and SERVICE_ variables give way to Coolify's", plan_output=plan(variables={'COOLIFY_URL': 'from-plan', 'SERVICE_X': 'y', 'CI': 'true'}), variables=[V('CI', 'false')])
ncase('static', 'built, and served as a static site', {'publish_directory': 'dist/'}, {'is_static': True}, [OLD], variables=VARS[:2])
ncase('static.force', 'built without cache, and served as a single page application with its own web server configuration', {'custom_nginx_configuration': 'server {\n    listen 80;\n    location / { try_files $uri /index.html; }\n}\n'}, {'is_static': True, 'is_spa': True}, deployment={'force_rebuild': True})
ncase('static.secrets', 'built with build secrets, and served as a static site', None, {'is_static': True, 'use_build_secrets': True}, [SECRETS], variables=VARS[:2])
ncase('static.image', 'a web server image Coolify no longer supports stops the build', {'static_image': 'httpd:alpine'}, {'is_static': True})
ncase('nixpacks-build-fails', 'nixpacks build fails', responses=[{'match': 'nixpacks build', 'errorOutput': 'Error: Failed to write the Dockerfile\n', 'exitCode': 1}])
ncase('dockerfile-content', 'an application with a pasted Dockerfile is built from it, whatever its build pack', {'dockerfile': DOCKERFILE}, responses=[DF])

# ── A static site ──
def scase(id, about, app=None, settings=None, responses=None, **more):
    case('static.' + id, 'a static site: ' + about, dict(S, **(app or {})), settings, (responses or []) + [LS], **more)


scase('spa', 'a single page application', None, {'is_spa': True})
scase('nginx', 'its own web server configuration', {'custom_nginx_configuration': 'server {\n    listen 80;\n    root /usr/share/nginx/html;\n    location /api { return 404; }\n}\n'}, {'is_spa': True})
scase('image', 'a web server image Coolify no longer supports stops the build', {'static_image': 'httpd:alpine'})
scase('pull-fails', 'the web server image cannot be pulled', responses=[{'match': 'docker pull', 'errorOutput': 'Error response from daemon: toomanyrequests: You have reached your pull rate limit.\n', 'exitCode': 1}])
scase('healthcheck', 'its health check asks port 80, whatever the application exposes', dict(HEALTH, ports_exposes='3000', health_check_path='/index.html'), None, [OLD])
scase('is-static', 'the static setting of another build pack changes nothing', None, {'is_static': True}, variables=VARS[:2])
scase('consistent-name', 'a consistent container name: the old container stops first', None, {'is_consistent_container_name_enabled': True}, [OLD])
