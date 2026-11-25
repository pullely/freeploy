# Coolify's real schema (DP-60)

`coolify-schema.json` is the physical schema of coollabsio/coolify at commit `91b7e3e`: what a PostgreSQL
holds after Laravel's own migrator has run all 531 migrations. It is the reference the `deploy` schema is
held to by `tests/db/src/deploy-schema-parity.test.ts`, and the source of
`specs/epics/freeploy-coolify-parity/parity/schema-diff.md`.

The schema fold of DP2 (`parity/migrations.json`, read by `../generate-deploy-schema.ts`) parses the
Blueprint calls of the migration files. It cannot see a raw `DB::statement`, a loop over a list held in a
variable, a call inside `if (Schema::hasColumn(…))`, a `->change()` on a column another file created, or a
table named through `config()`. This dump has none of those limits, because nothing is parsed: the
migrations ran.

- `catalog.ts` — the catalog queries: per table its columns (type with length, nullability, default,
  auto-increment), primary key, indexes (unique or not, method, columns in order with `DESC`, predicate),
  foreign keys (columns, target, `ON DELETE` / `ON UPDATE`), CHECK constraints and storage options. The same
  module reads Freeploy's `deploy` schema in `tests/db`, so both sides are described by the same queries.
- `dump-coolify-schema.ts` — runs them on Coolify's database and writes `coolify-schema.json`. It refuses a
  database in which not every migration file of the checkout has run. It also records `rawStatements`:
  every `DB::statement` / `DB::unprepared` call outside `down()`, with the driver test around it — the
  statements a fold of Blueprint calls never sees. At the pin: 46 calls in 16 migrations, 37 of them behind
  a driver test. All 46 ran here; on SQLite, which the PHP fixtures of other tasks use, the 37 do not.
- `coolify-schema.json` — the output. Never edited by hand.

## Regenerating

With a checkout of coollabsio/coolify at commit `91b7e3e`, in a copy you can write to, PHP with `pdo_pgsql`,
Composer, and PostgreSQL's server binaries (`initdb`, `pg_ctl`; no running server or root database is needed
— PostgreSQL refuses to run as root, so as root run the two `pg` commands as another user, for example with
`runuser -u postgres --`, on directories that user owns):

```sh
# 1. a throwaway PostgreSQL
PG=/usr/lib/postgresql/16/bin
$PG/initdb -D /tmp/dp60-work/pgdata -U coolify --auth=trust -E UTF8
$PG/pg_ctl -D /tmp/dp60-work/pgdata -o "-p 54360 -k /tmp/dp60-work/pgsock -c listen_addresses=127.0.0.1" -l /tmp/dp60-work/pgsock/pg.log -w start
$PG/psql -h 127.0.0.1 -p 54360 -U coolify -d postgres -c "create database coolify"

# 2. Coolify's migrations, by Laravel (in the writable copy of the checkout)
composer install --no-dev --no-scripts --ignore-platform-reqs --no-interaction
printf 'APP_ENV=testing\nAPP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nDB_CONNECTION=pgsql\nDB_HOST=127.0.0.1\nDB_PORT=54360\nDB_DATABASE=coolify\nDB_USERNAME=coolify\nDB_PASSWORD=\nCACHE_STORE=array\nSESSION_DRIVER=array\nQUEUE_CONNECTION=sync\n' > .env
php artisan migrate --force

# 3. the dump (from the Freeploy checkout; add --check to compare with the committed file instead)
node packages/db/scripts/coolify-schema/dump-coolify-schema.ts \
  --url postgres://coolify@127.0.0.1:54360/coolify --coolify /path/to/the/coolify/copy

# 4. the report
UPDATE_SCHEMA_DIFF=1 pnpm --filter ./tests/db test -- deploy-schema-parity

$PG/pg_ctl -D /tmp/dp60-work/pgdata stop
```

The committed file was produced with PostgreSQL 16.15, PHP 8.3.6 (cli) with `pdo_pgsql`, Composer 2.8.12,
Laravel 12.72.0 (Coolify's `composer.lock`), Node 22.23.5 and `pg` 8.23.1. `APP_ENV=testing` only keeps
Laravel from asking for confirmation; no migration of the pin reads the environment.

## What changes between two runs

Nothing. The one fact that depends on the run — the value of a `->default(now())`, which Laravel freezes to
the moment the migration ran (14 columns, `last_online_at` and `sentinel_updated_at`) — is written as
`'<the time the migration ran>'`. A second run on a fresh database gives the same file, byte for byte
(`--check`).

## Not covered

- Rows. Coolify's migrations also move data (`max_restart_count` 10 → 0, duplicate environment variables
  removed, …); only the schema is dumped. Where such a step matters to `deploy`, the migration that closes
  the gap says so.
- Sequences, grants, row-level security and comments: Coolify has none worth comparing, and Freeploy's are
  its own (`tests/db/src/deploy-isolation.test.ts`).
- The seeders (`php artisan db:seed`): they add rows, not schema.
