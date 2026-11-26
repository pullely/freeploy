# Deployment goldens (DP-56, DP-61, DP-72)

What Coolify's own PHP does when it deploys an application — a Docker image (DP-56), and the builds
on the server: a Dockerfile in a public Git repository, a pasted Dockerfile, Nixpacks and a static
site (DP-61), and a private repository cloned through a GitHub App or with a deploy key
(DP-72) — so that the TypeScript ports in `apps/deploy-core-worker/src/deployments/` can be
held to it: the compose file and the `.env` file byte for byte, and the whole deployment command
by command.

- `cases.json` — the cases. A **run** is one deployment: the application, its settings, variables,
  storages, server and destination (only the fields that differ from `defaults`), the deployment's
  own flags, and what each SSH process answers (`responses`). A **function** case is one helper of
  Coolify's and its arguments.
- `emit.php` — runs every case through Coolify's real code and prints the results. Nothing in it
  is a port. It boots the Laravel application as Coolify's own test suite does (the `testing`
  connection: SQLite in memory, `database/schema/testing-schema.sql` and every later migration),
  builds each run's team, server, destination, project, environment and application as real
  models, queues the deployment with `queue_application_deployment()` and lets the sync queue run
  the real `ApplicationDeploymentJob`. No server is contacted: `Process::fake()` answers every SSH
  process with what the case scripts and records the script (and the standard input) it was
  given. `Sleep`, notifications, the other queued jobs and the two broadcast events are Laravel's
  fakes, and time stands still at 2026-11-20 10:11:12 UTC. Each run is a database transaction that
  is rolled back. The public GitHub source (id 0) is created once, as Coolify's `GithubAppSeeder`
  creates it. A run can say what an earlier deployment stored (`earlierDeployments`, with
  `"configuration_snapshot": "current"` for the configuration the application has) and what the
  user changed since (`changedSince`).
- `goldens.json` — its output. Never edited by hand. Its head comment in `emit.php` describes the
  format (what a process or a log entry leaves out, and the `strings` table of repeated strings).

## What a run records

Every process in order (the script after Coolify's SSH wrapping is taken off, its standard input),
the deployment row at the end (status, every log entry with its command, type, hidden flag and
batch), the application's status, `custom_labels` and restart counters, the application's other
deployments, every sleep, every notification, every other job that was queued, and the exception
the job ended with. A run with `"view": true` also records what `Show` renders
(`decode_remote_command_output`) and what the two exports return.

For a build a run also records, under `build`, what the job read and what it left: the Git and
build columns of the application and its settings as Coolify stored them before the job ran (`row`:
after the models' mutators and defaults), its variables in the order the job reads them
(`variables`: with the ones a creating hook made, such as a Nixpacks application's
`NIXPACKS_NODE_VERSION`), what `pendingDeploymentConfigurationDiff()` answered (`configurationDiff`),
and afterwards the health check columns, the saved SSH host keys and the variables the job created.
The deployment row has its `commit_message`.

Out of the runs come 131 different compose files (`generate_compose_file()`) and as many `.env`
files (`generate_runtime_environment_variables()`), each compared byte for byte in
`src/deployments-compose.test.ts` for the Docker image runs. `src/deployments-engine.test.ts`
replays 475 runs through the engine — 149 of a Docker image, and 326 builds: 79 of a Dockerfile in a
repository (`dockerfile.*`), 55 of a pasted Dockerfile (`simple.*`), 85 of Nixpacks (`nixpacks.*`),
67 of a static site (`static.*`), 21 of a private repository through a GitHub App (`ghapp.*`) and 19
with a deploy key (`deploykey.*`) — with a fake executor that answers what the PHP run was
answered, and compares the processes (script and standard input, so every Dockerfile, build script,
build-time and runtime `.env` file, Nixpacks plan and compose file a build writes), the log, the
statuses, the sleeps, the notifications, the queued jobs, the exception, and for a build the commit,
its message and what it left on the application. Every build is replayed a second time one step at
a time, with only the engine's state kept as JSON between the steps. The function cases (`convertDockerRunToCompose`, the `.env` value escaping, log
redaction, `escapeshellarg`, Symfony's `Yaml::dump`, the docker stop timeout, the Git SSH setup
command, the incomplete-line buffer of a process's output) are compared in
`src/deployments-functions.test.ts`.

## Regenerating

With a checkout of coollabsio/coolify at commit `91b7e3e`, in a copy you can write to:

```sh
composer install --no-dev --no-scripts --ignore-platform-reqs --no-interaction
printf 'APP_ENV=testing\nAPP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAPP_DEBUG=true\nDB_CONNECTION=sqlite\nDB_DATABASE=:memory:\nCACHE_STORE=array\nCACHE_DRIVER=array\nSESSION_DRIVER=array\nQUEUE_CONNECTION=sync\n' > .env
php /path/to/freeploy/tests/deploy-core-worker/fixtures/deployments/emit.php "$PWD" \
  /path/to/freeploy/tests/deploy-core-worker/fixtures/deployments/cases.json \
  > /path/to/freeploy/tests/deploy-core-worker/fixtures/deployments/goldens.json
```

It takes about a minute and a half. A third argument keeps only the cases whose id starts with it
(`php emit.php "$PWD" cases.json compose.` — for looking at one case, not for the committed
file). The committed file was emitted with PHP 8.3.6 (cli) with the sqlite3 extension, Laravel
12.72.0 and Coolify 4.7.6. The emitter runs in Laravel's `testing` environment, so the `APP_KEY`
that counts is the one of Coolify's own `.env.testing` (the `.env` above only has to exist): it
serves the models' `encrypted` casts in memory, and it is the key of the build secrets hash
(`COOLIFY_BUILD_SECRETS_HASH`), which the tests give the engine as `GOLDEN_APP_KEY`. Two runs of
the emitter give the same file.

`cases.json` is the artifact: it was first written by a script and is edited as JSON since.
The build runs (DP-61: `dockerfile.*`, `simple.*`, `nixpacks.*`, `static.*`) are the exception:
`build-cases.py` writes them from `build-cases-body.py`, replacing the earlier build runs and
leaving every other run as it is (`python3 build-cases.py cases.json build-cases-body.py`), so they
are changed there and written again, then emitted. The private repository runs (DP-72: `ghapp.*`,
`deploykey.*`) are written the same way by `private-cases.py`
(`python3 private-cases.py cases.json ../sources/cases.json`). A GitHub App run gives the App (its
key is the RSA test key of `../sources`) and what GitHub answers (`github`, through `Http::fake()`:
the installation token, the repository); a deploy key run gives the key, a throwaway ed25519 test
key that protects nothing. The run records the requests sent to GitHub and the
`repository_project_id` the job stored.

## What the port does differently, on purpose

- A log line that names Coolify in prose reads "Freeploy" (the test applies the same rule to the
  golden before comparing). Names on the server stay Coolify's: the `coolify` network,
  `coolify-proxy`, `/data/coolify`, the `COOLIFY_*` variables, the `coolify.*` labels, the helper
  image, and the links to coolify.io.
- A failed deployment's two hidden log lines that give a PHP file and line ("Location: …", "at
  …") are not written; the test leaves them out of the golden.
- A script's standard input (the compose file, the `.env` file) travels to the executor as
  base64 inside the command batch; the goldens record Coolify's script and input, and the fake
  executor in the tests receives the same two.

- The goldens were made on SQLite, Coolify runs on Postgres, and the two order a `NULL` differently.
  A variable the job creates has no `order` (Laravel's two Nixpacks variables): Postgres reads it
  after the ordered ones, SQLite before. The engine does what Postgres does, and the cases keep away
  from the difference (`nixpacks.laravel.own` sorts its variables by name).

## Not covered

Only what `ApplicationDeploymentJob` does for a `dockerimage`, `dockerfile`, `nixpacks` or `static`
application on one standalone Docker server reached as root is emitted and ported, and of a Git
source only a public repository (the public GitHub source, or any host's repository by its URL), a
private one through a GitHub App, and one with a deploy key. No
golden exists, and the engine refuses or does not reach, Docker Compose and Railpack, a build
server, additional servers, a preview deployment, Docker Swarm, a non-root server user (`sudo`), a
Git source on GitLab or Gitea, HTTPS credentials, a file storage with content,
`preserveRepository`, the image scan gate, the SSH retry of a dropped connection (but for the
clone, which Coolify retries itself), and the Git host key cache. Coolify's configuration snapshot
is not ported either: the goldens say what `should_skip_build()` does for each answer of
`pendingDeploymentConfigurationDiff()` (no snapshot, nothing changed, the build changed), and the
replay gives the engine Coolify's answer for the case; Freeploy itself stores no snapshot yet, so
its own deployments get the first answer and rebuild. The notifications, `GetContainersStatus`,
`CleanupHelperContainersJob` and the events are recorded as what the job asked for; nothing
behind them is run.
