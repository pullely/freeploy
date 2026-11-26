# Coolify's /api/v1 goldens (DP-70, DP-71, DP-73, DP-74, DP-78, DP-81, DP-84, DP-85)

What Coolify's real API answers, so that Freeploy's `/api/v1` (api-edge's middleware and limiters,
identity-worker's teams and tokens, deploy-core-worker's projects, environments, private keys and servers —
DP-70 —, its applications and their environment variables — DP-71 — and its standalone databases and their backup
schedules — DP-73 — and its services and their environment variables, an application's deployments, cancelling a deployment and
deploying by uuid or tag — DP-74 — and the deployments in progress and one deployment, every resource of the team, an
environment's resources, creating and deleting a server and a server's resources and domains — DP-78 — and the team's
tags and those of an application, a database and a service, the shared variables of a project and of an environment, and
S3 storages — DP-81 — and the storages of an application, a database and a service, the scheduled tasks of an
application and of a service, a database's environment variables and the team's shared variables — DP-84 — and the
team's notification channels, a service's applications and databases, destinations, a server's shared variables and
its Docker cleanup — DP-85) can be replayed against it byte for byte.

| File | What it is |
|---|---|
| `cases.mjs` | writes `cases.json` (`node cases.mjs > cases.json`): the fixture and every request |
| `cases.json` | the fixture (teams, users with their roles, projects and environments, private keys from `../ssh-keys`, a server per team with its default destination, applications and their variables, an S3 storage per team, the eight standalone database engines — made by Coolify's `create_standalone_<engine>()` helpers, so the created hook's volumes and Redis's variables are made too — and another team's PostgreSQL, four backup schedules and two executions, a service per team with its parts and variables and five deployments (DP-74), API tokens with fixed plain text) and the requests: a method, a path, a token of the fixture (sent as `Bearer <id>\|<plain text>`) or a raw `Authorization` header, a JSON body or raw content, the client IP, the instance settings (`is_api_enabled`, `allowed_ips`) and the limits (`API_RATE_LIMIT`, `API_FAILED_REQUEST_RATE_LIMIT`); a `sequence` is several requests sharing one cache, with `advance` moving the clock |
| `emit.php` | sends each request through Coolify's HTTP kernel and prints the answers. Nothing in it is a port |
| `goldens.json` | its output: per request the status, the rate-limit headers and content type, and the body exactly as Coolify wrote it; for a write, the rows it left (`after`); and the column order of the tables whose rows the API writes unsorted (`columns`: a loaded relation such as an application's destination, its server and their settings). Never edited by hand |
| `freeploy-rows.json` | not Coolify's: the rows Freeploy's own database gives for the fixture (every column, type and default), written and checked by `tests/db/src/deploy-api-v1.test.ts`; DP-70's replay (`src/api-v1.test.ts`) makes its memory stores from them |

DP-71's replay (`src/api-v1-resources.test.ts`) runs on Freeploy's own database instead: `src/api-v1-database.ts`
makes PGlite with every migration of the deploy bounded context, makes the fixture with Freeploy's insert functions in
Coolify's order (so every serial id is the fixture's), and runs each case in a transaction it rolls back, as `emit.php`
does; the handler calls the services with their SQL stores, so a write's rows are compared too (the golden's `after`,
the same SQL run on Freeploy's tables). PGlite is tests/db's dependency, mapped by this package's jest and tsconfig.
DP-73's replay (`src/api-v1-databases.test.ts`) is the same, with the databases made by `insertDatabase()` (the columns
Coolify's helpers filled, the data volumes, Redis's two variables), the S3 storages, the schedules and their executions.
A sequence does not roll back with its transaction, so an id a case's write takes is not compared (`after` reads
whether a row is the fixture's instead), and the schedules' numeric retention sizes are read as `::float8::text`: the
two drivers give a numeric differently.
DP-74's replay (`src/api-v1-services.test.ts`) adds a service per team (`insertParsedService()` with the columns, parts and
variables emit.php makes through the models) and five deployments in the queue, and runs a case's `setup` (SQL emit.php runs
before the request, on the tables of the same names). A write that makes random values is compared on what is not random: the
`after` queries write a uuid the request made as `<uuid>` and the random name of a service made from a Compose file without
one (`str()->random(10)`) as `service-<random>`, inside the names, domains and generated Compose files they read.
DP-78's replay (`src/api-v1-continued.test.ts`; the deployments in progress and one deployment are DP-74's file's) runs on
the same database with no new fixture rows: a case's `setup` soft-deletes the resources of the fixture's server
(`deleted_at`, on both sides) so that it can be deleted, the `after` queries of a created server write a generated name as
`<random-name>` and leave out the other team's server (Freeploy's org sees only its own), and the team a deployment's
application nests is the fixture's team as membership-worker would answer it (`org`, a runner of the handler).
DP-81's replay (`src/api-v1-tags-variables-storages.test.ts`: the team's tags and a resource's, the shared variables of a
project and of an environment, S3 storages) adds fixture rows at the end of both fixtures: four tags (three of team 1, one
of team 2) and their pivot rows in a fixed order (an application, a Redis, a service; Coolify's `$resource->tags` has no
ORDER BY, and PostgreSQL gives the pivot's order), and five shared variables of projects and environments, whose ids follow
the four predefined variables each server's created hook makes (Freeploy's fixture now makes those too, so the ids agree).
The `after` queries of the database and service creates read only the tags after the fixture's (`t.id > 4`), so those
goldens are unchanged; a created shared variable's id is the sequence's (`after` reads the fixture's ids only); and
emit.php resolves host names through `SafeWebhookUrl::resolveHostsUsing()` (`unresolvable.example` to nothing,
`private.example` to 10.0.0.5, every other name to 93.184.216.34; no DNS is asked), which the test's resolver repeats.
No golden case reaches an S3 endpoint (the emitter has none); the test's own case answers a ListObjectsV2 through the
injected fetch. Freeploy's fixture storage now uses path-style URLs, the column's default that Coolify's `forceCreate()`
leaves.
DP-84's replay (`src/api-v1-storages-tasks-envs.test.ts`: the storages of an application, a database and a service, the
scheduled tasks of an application and of a service, a database's environment variables, the team's shared variables) adds
fixture rows at the end of both fixtures: three shared variables of type team (ids 10–12, after DP-81's), three volumes
(ids 12–14, after the databases' data volumes: `$advanceSequences()` moved that sequence before the first volume was
made, so they start at 2, and Freeploy's fixture now moves it the same way), six file mounts (an application's managed
file, host file and directory, a PostgreSQL's file, a service's file, the other team's host file), four scheduled tasks and
three executions. A case's `after` reads a created row's id as null (`case when id <= N`), and DP-74's service `after`
queries leave out the fixture's volume of the service's web part (`v.uuid <> 'l2parityservicevolume002'`), so those
goldens are unchanged. The storages are answered with `response()->json()` of the models (unsorted), so `columns` gains
`local_persistent_volumes` and `local_file_volumes`.
DP-85's replay (`src/api-v1-notifications-parts-destinations.test.ts`: the six notification channels, a service's
applications and databases, destinations, a server's shared variables and its Docker cleanup) adds three Docker cleanup
runs at the end of both fixtures, and Freeploy's fixture now makes the rows Coolify's Team created hook makes — the six
notification channels' settings of each team, team 1's first, so their ids are 1 and 2 on both sides — and the servers'
predefined variables literal, as Freeploy's server creation and Coolify's hook make them. A case's `config` may set
`self_hosted: false`: emit.php then runs it as Coolify Cloud (`constants.coolify.self_hosted`), whose SafeSmtpHost
blocks private networks, as Freeploy (a hosted service) does; the email cases that check an SMTP host run so. The `after`
queries read a channel's encrypted columns as whether they are set (`has_<column>`: the ciphertexts differ), the JSON
columns of a service application as `::jsonb::text` (Coolify's text columns hold `\/`), and the fixture's default
destination's name as `<default-destination-name>` (Coolify's `coolify`, Freeploy's `freeploy`); the cases that answer it
name it first (`setup`). No masking is added.

## How the goldens are made

In a scratch copy of coollabsio/coolify@91b7e3e with `vendor/` and a `.env` (prepared as
`../services/README.md` says), against a PostgreSQL database — Coolify's production database, not the
SQLite of its test suite: the API writes model attributes as the driver returns them, and SQLite gives a
boolean column without a cast as `0`/`1` (and `ApiAllowed`'s `is_api_enabled === false` is never true there):

```sh
node cases.mjs > cases.json
DB_HOST=127.0.0.1 DB_PORT=5432 DB_DATABASE=<scratch db> DB_USERNAME=<user> DB_PASSWORD=<password> \
  php emit.php <scratch copy> cases.json > goldens.json
```

`emit.php` runs `migrate:fresh`, makes the fixture with its ids and uuids (the applications and variables through their
models, so their hooks run; each server's default destination given the fixture's uuid), and sends every case through
`Illuminate\Contracts\Http\Kernel::handle()` with `Accept: application/json`, the request made as `Request::capture()`
makes it in production (`createFromBase()`: a JSON body is also the request bag `$request->get()` reads; a form body is
parsed as PHP parses `$_POST`), and Server's request-scoped identity map (a static array) flushed before each request: the global middleware
(`ThrottleFailedApiRequests` among them), the `api` group's `throttle:api`, then the route's
`auth:sanctum`, `api.token.team`, `ApiAllowed`, `api.sensitive` and `api.ability`. Each case is a database
transaction that is rolled back, with an empty cache. Fixed: the clock (2026-01-01T00:00:00Z), `APP_DEBUG`
off, the array cache, jobs and notifications faked. The committed file was emitted with PHP 8.3.6 and
PostgreSQL 16 (Coolify 4.7.6).

## Masking

Both sides go through the same masking before they are compared (`src/api-v1-goldens.ts`):

- dates: Laravel's (`2026-01-01T00:00:00.000000Z`) as `<date>`, a column without a cast
  (`2026-01-01 00:00:00`) as `<sql-date>`;
- a uuid the fixture did not give — made by the request — as `<new-uuid>`, also where a connection URL names it as its
  host (`internal_db_url`, DP-73);
- the team's id (`team_id`, `current_team_id`, a team's `id`): Coolify's integer, Freeploy's org id
  (`org_…`), as `<team>`; a member's `id` (Coolify's integer, Freeploy's `usr_…`) as `<user:EMAIL>`;
- the id of a server's settings row (an auto-increment neither side fixes) as `<settings-id>`;
- `sentinel_token` as `<secret>`: Coolify writes its encrypted text, which no other system can make, and
  Freeploy's server creation stores none;
- the `name` of a server's default destination (`destination.name`): Coolify's `coolify`, Freeploy's `freeploy` (a
  label in the console, `DEFAULT_STANDALONE_DESTINATION`; the network is `coolify` on both) as
  `<default-destination-name>` (DP-71);
- a uuid the request made where a generated domain names its container after it (`http://<name>-<uuid>.<host>` of a
  created service's `domains`) as `-<new-uuid>.` (DP-74);
- the `id` of a team nested in a project (a deployment's `application.environment.project.team`) as `<team>`, as a
  team's id is elsewhere (DP-78);
- the answer of a created shared variable, `{"id":N}` (a body that is only an integer `id`), as `{"id":"<new-id>"}`: the
  sequence's next id, which earlier cases moved (DP-81);
- the integer `id` of an object whose `uuid` the request made (a created storage, DP-84) as `<new-id>`, for the same
  reason.

Everything else — every other key, its position, its type, every message — is compared byte for byte, the
JSON written again by `phpJsonEncode` (PHP's `json_encode`, `\/` included); a test checks that it writes
every golden body back unchanged. The rate-limit headers and the 429 bodies are compared as they are.
