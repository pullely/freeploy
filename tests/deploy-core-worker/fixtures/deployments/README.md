# Deployment goldens (DP-56)

What Coolify's own PHP does when it deploys a Docker image application, so that the TypeScript
ports in `apps/deploy-core-worker/src/deployments/` can be held to it: the compose file and the
`.env` file byte for byte, and the whole deployment command by command.

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
  is rolled back.
- `goldens.json` — its output. Never edited by hand. Its head comment in `emit.php` describes the
  format (what a process or a log entry leaves out, and the `strings` table of repeated strings).

## What a run records

Every process in order (the script after Coolify's SSH wrapping is taken off, its standard input),
the deployment row at the end (status, every log entry with its command, type, hidden flag and
batch), the application's status, `custom_labels` and restart counters, the application's other
deployments, every sleep, every notification, every other job that was queued, and the exception
the job ended with. A run with `"view": true` also records what `Show` renders
(`decode_remote_command_output`) and what the two exports return.

Out of the runs come 131 different compose files (`generate_compose_file()`) and as many `.env`
files (`generate_runtime_environment_variables()`), each compared byte for byte in
`src/deployments-compose.test.ts`. `src/deployments-engine.test.ts` replays 144 runs through the
engine with a fake executor that answers what the PHP run was answered, and compares the
processes, the log, the statuses, the sleeps, the notifications, the queued jobs and the
exception. The function cases (`convertDockerRunToCompose`, the `.env` value escaping, log
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

It takes about half a minute. A third argument keeps only the cases whose id starts with it
(`php emit.php "$PWD" cases.json compose.` — for looking at one case, not for the committed
file). The committed file was emitted with PHP 8.3.6 (cli) with the sqlite3 extension, Laravel
12.72.0 and Coolify 4.7.6. The `APP_KEY` only serves the models' `encrypted` casts in memory. Two
runs of the emitter give the same file.

`cases.json` is the artifact: it was first written by a script and is edited as JSON since.

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

## Not covered

Only what `ApplicationDeploymentJob` does for a `dockerimage` application on one standalone
Docker server reached as root is emitted and ported. No golden exists, and the engine refuses or
does not reach, a build (Nixpacks, Dockerfile, Docker Compose, static, Railpack), a build server,
additional servers, a preview deployment, Docker Swarm, a non-root server user (`sudo`), a file
storage with content, `preserveRepository`, the image scan gate, the SSH retry of a dropped
connection, and the Git host key cache. The notifications, `GetContainersStatus`,
`CleanupHelperContainersJob` and the events are recorded as what the job asked for; nothing
behind them is run.
