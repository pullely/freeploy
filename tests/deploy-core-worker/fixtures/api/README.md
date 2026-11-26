# Coolify's /api/v1 goldens (DP-70)

What Coolify's real API answers, so that Freeploy's `/api/v1` (api-edge's middleware and limiters,
identity-worker's teams and tokens, deploy-core-worker's projects, environments, private keys and servers)
can be replayed against it byte for byte.

| File | What it is |
|---|---|
| `cases.mjs` | writes `cases.json` (`node cases.mjs > cases.json`): the fixture and every request |
| `cases.json` | the fixture (teams, users with their roles, projects and environments, private keys from `../ssh-keys`, a server, API tokens with fixed plain text) and the requests: a method, a path, a token of the fixture (sent as `Bearer <id>\|<plain text>`) or a raw `Authorization` header, a JSON body or raw content, the client IP, the instance settings (`is_api_enabled`, `allowed_ips`) and the limits (`API_RATE_LIMIT`, `API_FAILED_REQUEST_RATE_LIMIT`); a `sequence` is several requests sharing one cache, with `advance` moving the clock |
| `emit.php` | sends each request through Coolify's HTTP kernel and prints the answers. Nothing in it is a port |
| `goldens.json` | its output: per request the status, the rate-limit headers and content type, and the body exactly as Coolify wrote it; for a write, the rows it left (`after`). Never edited by hand |
| `freeploy-rows.json` | not Coolify's: the rows Freeploy's own database gives for the fixture (every column, type and default), written and checked by `tests/db/src/deploy-api-v1.test.ts`; the replay's memory stores are made from them |

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

`emit.php` runs `migrate:fresh`, makes the fixture with its ids and uuids, and sends every case through
`Illuminate\Contracts\Http\Kernel::handle()` with `Accept: application/json`: the global middleware
(`ThrottleFailedApiRequests` among them), the `api` group's `throttle:api`, then the route's
`auth:sanctum`, `api.token.team`, `ApiAllowed`, `api.sensitive` and `api.ability`. Each case is a database
transaction that is rolled back, with an empty cache. Fixed: the clock (2026-01-01T00:00:00Z), `APP_DEBUG`
off, the array cache, jobs and notifications faked. The committed file was emitted with PHP 8.3.6 and
PostgreSQL 16 (Coolify 4.7.6).

## Masking

Both sides go through the same masking before they are compared (`src/api-v1-goldens.ts`):

- dates: Laravel's (`2026-01-01T00:00:00.000000Z`) as `<date>`, a column without a cast
  (`2026-01-01 00:00:00`) as `<sql-date>`;
- a uuid the fixture did not give — made by the request — as `<new-uuid>`;
- the team's id (`team_id`, `current_team_id`, a team's `id`): Coolify's integer, Freeploy's org id
  (`org_…`), as `<team>`; a member's `id` (Coolify's integer, Freeploy's `usr_…`) as `<user:EMAIL>`;
- the id of a server's settings row (an auto-increment neither side fixes) as `<settings-id>`;
- `sentinel_token` as `<secret>`: Coolify writes its encrypted text, which no other system can make, and
  Freeploy's server creation stores none.

Everything else — every other key, its position, its type, every message — is compared byte for byte, the
JSON written again by `phpJsonEncode` (PHP's `json_encode`, `\/` included); a test checks that it writes
every golden body back unchanged. The rate-limit headers and the 429 bodies are compared as they are.
