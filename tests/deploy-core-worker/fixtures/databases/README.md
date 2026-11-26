# Database goldens (DP-57, DP-112)

What Coolify's own PHP does for a standalone database, so that the TypeScript ports in
`apps/deploy-core-worker/src/databases/` and the SQL in `packages/db/src/deploy/databases.ts` can be
held to it (`src/databases.test.ts` here, `tests/db/src/deploy-databases.test.ts`).

- `cases.mjs` — writes `cases.json` (`node cases.mjs cases.json`): the cases are generated, so that
  every engine gets the same ones.
- `cases.json` — the cases. `created`: a database type and, for PostgreSQL and Redis, its image.
  `urls`: a model's attributes, the server's address and, for Redis, KeyDB and Dragonfly, the
  credential variables. `validation`: the properties of an engine's General form; a case gives only
  what differs from its type's entry in `validationBase` (the fields of `input`; `stored` and
  `environmentVariables` whole).
- `emit.php` — runs every case through Coolify's real code and prints the results. It boots the
  Laravel application. Nothing in it is a port.
  - `types`: each model's table, `getMorphClass()`, `type()`, `encrypted` casts and
    `isBackupSolutionAvailable()`.
  - `created`: `create_standalone_postgresql()`, `_redis()`, `_mongodb()`, `_mysql()`, `_mariadb()`,
    `_keydb()`, `_dragonfly()`, `_clickhouse()` and — since DP-112 — `_sqlite()`, called as `Resource\Create::createResource()`
    calls them, against an in-memory SQLite database that holds only the tables they write, with
    every column nullable: what is read back non-null is what Coolify's code set (the helper, the
    models' hooks), not a schema default. A random value is given as its shape (length, character
    set), the uuid inside a name as `{uuid}`.
  - `urls`: the `internal_db_url` and `external_db_url` accessors of models built in memory.
  - `validation`: Laravel's validator with each General component's own `rules()`, `messages()` and
    `$validationAttributes`, on the component's properties after PHP has coerced the values to their
    types. A value a typed property cannot hold is listed under `typeErrors`: Livewire fails on it
    before any rule runs.
  - `password`: `Str::password(length: 64, symbols: false)`, as shapes.
- `goldens.json` — its output, one case per line. Never edited by hand.

## Regenerating

With a checkout of coollabsio/coolify at commit `91b7e3e`, in a copy you can write to (the same
setup as `../labels/README.md`):

```sh
composer install --no-dev --no-scripts --ignore-platform-reqs --no-interaction
printf 'APP_ENV=testing\nAPP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nDB_CONNECTION=sqlite\nDB_DATABASE=:memory:\nCACHE_STORE=array\nSESSION_DRIVER=array\nQUEUE_CONNECTION=sync\n' > .env
node /path/to/freeploy/tests/deploy-core-worker/fixtures/databases/cases.mjs \
  /path/to/freeploy/tests/deploy-core-worker/fixtures/databases/cases.json
php /path/to/freeploy/tests/deploy-core-worker/fixtures/databases/emit.php "$PWD" \
  /path/to/freeploy/tests/deploy-core-worker/fixtures/databases/cases.json \
  > /path/to/freeploy/tests/deploy-core-worker/fixtures/databases/goldens.json
```

The committed file was emitted with PHP 8.3.6 (cli) with pdo_sqlite. DP-112 emitted it again with SQLite's
`types`, `created`, `validationBase` and `validation` cases (`Sqlite\General` has no Access section and
no credentials: its cases are its own, after the eight engines'); every earlier line came out unchanged. Nothing in it changes between
two runs: the random values are recorded as shapes.

## Not covered

- The schema's defaults (the image of an engine without an image step, `status`, the limits): the
  SQLite tables have none. They are Freeploy's folded schema, checked in `tests/db`.
- `connectionPassword()` with a `REDIS_PASSWORD` variable that references a shared variable or a
  remote secret: the models are built without those relations.
- PHP's `version_compare()` beyond the Redis image cases: `src/databases.test.ts` lists what PHP 8.3.6
  answers for a set of versions against `6.0`.
