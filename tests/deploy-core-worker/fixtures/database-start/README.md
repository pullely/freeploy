# Database start goldens (DP-62, DP-112)

What Coolify's own PHP does when it starts, restarts or stops a standalone database and when it
starts or stops a database's TCP proxy, so that the TypeScript ports in
`apps/deploy-core-worker/src/databases/` (`start-plan.ts`, `proxy-plan.ts`, `content-files.ts`,
`start-engine.ts`) can be held to it: the docker-compose file and the command list of a start byte
for byte, and every action process by process.

- `cases.mjs` — writes `cases.json` (`node cases.mjs cases.json`). The cases are generated so that
  each of the nine engines gets the same ones (SQLite, which has no TCP proxy, none of the public-port, port-mapping
  and proxy runs, and one with its database files).
- `cases.json` — the cases: 698 runs (SQLite's 54 since DP-112, after the eight engines' 644). A run is one action on one database: the engine, the action
  (`start`, `restart`, `stop`, `proxy-start`, `proxy-stop`), the database's row, its variables,
  volumes, file mounts and certificates, its server and destination (only what differs from
  `defaults`), and what each SSH process answers (`responses`). A value `"@text:<name>"` stands for
  a long text of `texts` (a certificate, a key).
- `emit.php` — runs every case through Coolify's real code and prints the results. Nothing in it
  is a port. It boots the Laravel application as Coolify's own test suite does (the `testing`
  connection: SQLite in memory, `database/schema/testing-schema.sql` and every later migration),
  builds each run's team, server, destination, project, environment and database as real models,
  and calls the real action: `StartDatabase::run()`, `RestartDatabase::run()`,
  `StopDatabase::run($database, false, …)` (as the page's Stop dispatches it),
  `StartDatabaseProxy::run()`, `StopDatabaseProxy::run()`. The `DatabaseStartJob` a start queues
  is then run as a queue worker runs it — `handle()`, and `failed()` when that throws — so the
  engine's own Start action (`StartPostgresql` … `StartClickhouse`), `DatabaseStartCommandExecutor`
  and `ResourceStatusRefresher` all run. No server is contacted: `Process::fake()` answers every
  SSH process with what the case scripts and records the script it was given. `Sleep`,
  notifications, the other queued jobs and the broadcast events are Laravel's fakes, and time
  stands still at 2026-11-20 10:11:12 UTC. Each run is a database transaction that is rolled back.
- `goldens.json` — its output. Never edited by hand. The head comment of `emit.php` describes the
  format.

## What a run records

Every SSH process in order (the command batch that reached the remote shell, and what it was
answered), what the action returned or threw, what the queued start job threw, the start's
activity (status, exit code, error, every log entry), the database's row afterwards (status,
`started_at`, `last_online_at`, `is_public`, the restart counters `restart_count`, `last_restart_at`
and `last_restart_type`, the engine's configuration), its certificate rows, its
file mounts and its variables, every sleep, every notification, every other job that was queued,
and every broadcast event.

A start is three kinds of process: what Coolify asks the server before (the state of the content
files, a ClickHouse container's data volume, the CA file of a new CA) and writes there (a missing
certificate or configuration file), the one batch of the start itself — `mkdir`, the certificate
and configuration files, the compose file as `echo '<base64>' | base64 -d | tee …`, the README, the
image pull, the stop and removal of the old container, `docker compose up -d` — and the inspection
of the container afterwards. The compose file is inside the batch, so comparing the batch compares
it; the tests also decode it and compare it on its own.

## The cases

For each engine: the defaults; custom images (for PostgreSQL also a Supabase image and PostgreSQL
18); a public port; port mappings; SSL — with nothing there (Coolify generates the server's CA and
the database's certificate), with only the CA there, with both there once for each `ssl_mode` the
engine has (PostgreSQL five, MySQL four, MongoDB four, the others none), with the certificate
files missing or unreadable on the server, switched off again, with a custom configuration, and
public; a custom configuration, one that sets a port, and an empty one; extra volumes (named, a
host path), no volume at all, file mounts (a directory, a file with content, an empty file, a file
that is there, a host file; files outside the database's directory, behind a symbolic link, with a
relative path, with a path Coolify refuses, with placeholder content; files the server does not
let Coolify check or write); variables (plain, with `$`, literal, multiline, JSON, edge spaces,
quotes, empty, shared variables of the four scopes, a missing shared variable, a locked one), the
engine's credentials as variables, as literal variables, and with the old escaping; the
`COOLIFY_*` variables overridden and switched off; a `{{vault.…}}` reference with and without
`is_literal`; names that need slugging; resource limits; a log drain (Fluent Bit, CloudWatch, off
on either side); custom Docker options (with and without `--ip`); the health check's settings and
the health check switched off; an IPv6 server; Docker 29. Redis, KeyDB and Dragonfly also have the
password quoting (quoted, a legacy database's unquoted password, a password variable); Redis a
blank username, shared credentials and no variables; PostgreSQL init scripts (also one whose name
tries to leave the directory), `initdb` arguments and the host auth method; ClickHouse a container
whose data is in an unnamed volume. Then what goes wrong: a failed pull, a command that fails
without output, output without a final line break, a server that is unreachable or disabled, a
container that is still starting, never healthy, without a health check, exited or missing. The
restart counters a crash-restarting container leaves (`restart_count` 3, `last_restart_at`,
`last_restart_type` "crash"): reset by a start, kept by a start on an unreachable server and — for
ClickHouse — by a start refused for its unnamed data volume, reset by a restart and by a stop, kept by a
stop without the cleanup checkbox. Then restart (also public, on an unreachable server, with a vault reference), stop (also public, with a
failing `docker stop`, with a failing proxy removal, on an unreachable server, on Docker 29), and
the proxy (plain, with IPv6 and a timeout, with a zero and a null timeout, with SSL, with the port
taken, failing, and its stop, also failing).

Start cases per engine: PostgreSQL 65, Redis 62, MySQL 58, MariaDB 55, MongoDB 58, KeyDB 59,
Dragonfly 55, ClickHouse 49 — 461 — and 183 restart, stop and proxy cases (23 per engine, 22 for
ClickHouse, which has no SSL proxy case).

## Certificates: what is masked, and how

A case that gives the server's CA and the database's certificate (`caCertificate`, `certificate`,
and the certificate's file mounts) has nothing random in it: every byte is Coolify's and is
compared as it is. The CA is DP-48's (`../ssl/php-ca.crt`, made by Coolify's own `SslHelper`), the
leaf `../ssl/php-leaf.crt`, and the leaf's key a throwaway one written in `cases.mjs`.

Where Coolify generates a certificate (`SslHelper::generateSslCertificate()`: a fresh key and a
random serial, signed by OpenSSL at the real time), its PEM texts cannot be reproduced. `emit.php`
replaces each generated text — wherever it stands in a script, as it is or in base64, and in the
rows — by a mask: `{{generated:ca-certificate}}`, `{{generated:ca-private-key}}`,
`{{generated:certificate}}`, `{{generated:private-key}}` and `{{generated:certificate-and-key}}`
(the certificate, a line break, the key: MongoDB's `server.pem`). The replay generates its own
certificates with DP-48's port of `SslHelper` and masks them the same way
(`masked()` in `src/database-start-fixtures.ts`) before comparing; everything around the masked
text — the command, the path, the order — is compared byte for byte. Of the generated
certificates themselves the golden keeps what can be said (`generated`: subject, issuer,
alternative names, basic constraints, days of validity, the key's curve, the signature algorithm),
and the replay holds its own certificates to the subject, issuer, validity, curve and signature;
their rows (`common_name`, `subject_alternative_names`, `configuration_dir`, `mount_path`,
`valid_until`) and their file mounts are compared in full. That DP-48's generator writes the same
certificate as OpenSSL does is `src/ssl.test.ts`'s matter.

## Regenerating

With a checkout of coollabsio/coolify at commit `91b7e3e`, in a copy you can write to:

```sh
composer install --no-dev --no-scripts --ignore-platform-reqs --no-interaction
printf 'APP_ENV=testing\nAPP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nAPP_DEBUG=true\nDB_CONNECTION=sqlite\nDB_DATABASE=:memory:\nCACHE_STORE=array\nCACHE_DRIVER=array\nSESSION_DRIVER=array\nQUEUE_CONNECTION=sync\n' > .env
node /path/to/freeploy/tests/deploy-core-worker/fixtures/database-start/cases.mjs \
  /path/to/freeploy/tests/deploy-core-worker/fixtures/database-start/cases.json
php /path/to/freeploy/tests/deploy-core-worker/fixtures/database-start/emit.php "$PWD" \
  /path/to/freeploy/tests/deploy-core-worker/fixtures/database-start/cases.json \
  > /path/to/freeploy/tests/deploy-core-worker/fixtures/database-start/goldens.json
```

It takes about ten seconds. A third argument keeps only the cases whose id starts with it
(`php emit.php "$PWD" cases.json postgresql.ssl` — for looking at one case, not for the committed
file). The committed file was emitted with PHP 8.3.6 (cli) with the sqlite3 and openssl
extensions, OpenSSL 3.0.13, Laravel 12.72.0 and Coolify 4.7.6. The `APP_KEY` only serves the
models' `encrypted` casts in memory. Two runs of the emitter give the same file. DP-112 emitted the
whole file again with SQLite's runs: the 644 committed runs came out unchanged, and the new runs and
their two new `strings` (indices 64 and 65) were appended.

## How the tests use it

`src/database-start.test.ts` replays all 698 runs through the engine with an executor that plays
the same server: it refuses a process that is not the one Coolify started at that point, and
answers what the case scripted. All 698 match: no case is excluded, and nothing but what is listed
below is read with a rule.
Beside the processes it compares what the action answered, the start's activity and log, the rows,
the sleeps, and what was queued, broadcast and notified. `src/database-operations-api.test.ts`
drives the routes with the same worlds.

Four things of a golden are read with a rule, each for a reason:

- `echo 'Warning: …'` lines name Freeploy where Coolify names itself (see below).

- `started_at`. Coolify never sets it in these actions (its page does, later, when it sees a
  started database running). Freeploy sets it before the first command of a start reaches the
  server, so the test expects the run's instant wherever a start got past "Server is not
  functional", and Coolify's value elsewhere.
- `jobs`. `DatabaseStartJob` is left out: the engine is that job. The rest must be the same set.
- A faked process's output ends with a line break, which Laravel's fake adds when the case's text
  has none; the replaying executor does the same, as a real command's output would have it.

## What the port does differently, on purpose

- The start runs where it is called and its log is part of what it answers: Freeploy has no
  activity table and no queue for it yet. Coolify's guard against a second start, restart or
  import of the same database (`DatabaseOperationReservation`, `ResourceStartActivity`) has
  nothing to hold on to and is not ported.
- A warning about a content file, which a start echoes into its log ("Warning: Coolify cannot
  write the configuration file …"), reads "Freeploy" (the test applies the same rule to the
  golden's `echo 'Warning: …'` lines before comparing).
- Names on the server stay Coolify's: `/data/coolify/databases/<uuid>`, `/data/coolify/ssl/
  coolify-ca.crt`, the `coolify.*` labels, the `COOLIFY_*` variables, `coolify-ca.crt` inside the
  containers, the CA's common name "Coolify CA Certificate".
- The file of a new certificate, which Coolify writes in a queued job (`ServerStorageSaveJob`), is
  written by the route before the start checks which files are missing. The engine hands the job
  over as Coolify does (the goldens hold that); the route does the work in place.

## Not covered

No golden exists, and the engine refuses or does not reach: a non-root server user (`sudo`, the
`DOCKER_CONFIG` prefix of the pull), Swarm, the pull of a scanned image build
(`ImageStartPin`) and the image scan after a start, a secret manager (a `{{vault.…}}` reference
has no source: the goldens hold Coolify's refusal), SQLite, a service's database
(`ServiceDatabase`) and its proxy, a directory file mount's own handling on the server,
`RegenerateSslCertJob`, the Docker cleanup after a stop, and the stop notification. The broadcast events, the notification and the queued jobs are
recorded as what Coolify asked for; nothing behind them is run by the goldens.
