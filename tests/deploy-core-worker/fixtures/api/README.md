# Coolify's /api/v1 goldens (DP-70, DP-71, DP-73, DP-74, DP-78, DP-81, DP-84, DP-85, DP-86, DP-87, DP-88, DP-90, DP-93, DP-103, DP-104, DP-105, DP-106, DP-108)

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
its Docker cleanup — DP-85 — and an application's previews and additional destinations, and moving, migrating and cloning
applications, databases and services — DP-86 — and creating an application from a Docker image, a Dockerfile, a public
repository and a repository with a deploy key, and updating one — DP-87 — and a database's and a service's logs, an
application's rollback images and rollback, executing a scheduled task, a storage's backup schedule, a server's proxy,
Sentinel, log drains, image scanning, Cloudflare Tunnel, host key, registries and transfer, database imports and GitHub
Apps — DP-88 — and the cloud provider tokens, the Hetzner, DigitalOcean, Vultr and Hostinger catalogs and a server's proxy
configuration — DP-90 — and a policy's denial on a route of each group, a GitHub App's repositories and branches, an
application from a private repository through a GitHub App and a Hostinger server — DP-93 — and the integration tokens
and a Cloudflare token's zones — DP-104 — and the GitLab Apps, the Gitea Apps, an application from a private repository
through a Gitea App and an application's source changed to one — DP-103 — and the team's Cloudflare zones and the managed DNS
records of an application's and a service's domains — DP-105 — and a resource's secret manager source and the
instance's email settings — DP-106 — and cloning a service — DP-108) can be replayed against it byte for byte.

| File | What it is |
|---|---|
| `cases.mjs` | writes `cases.json` (`node cases.mjs > cases.json`): the fixture and every request |
| `cases.json` | the fixture (teams, users with their roles, projects and environments, private keys — the committed test keys of `../ssh-keys`, and DP-72's RSA GitHub App key read from `../sources/cases.json` (`json`, a path of keys into that file) — a server per team with its default destination, applications and their variables, an S3 storage per team, the eight standalone database engines — made by Coolify's `create_standalone_<engine>()` helpers, so the created hook's volumes and Redis's variables are made too — and another team's PostgreSQL, four backup schedules and two executions, a service per team with its parts and variables and five deployments (DP-74), API tokens with fixed plain text) and the requests: a method, a path, a token of the fixture (sent as `Bearer <id>\|<plain text>`) or a raw `Authorization` header, a JSON body or raw content, the client IP, the instance settings (`is_api_enabled`, `allowed_ips`) and the limits (`API_RATE_LIMIT`, `API_FAILED_REQUEST_RATE_LIMIT`); a `sequence` is several requests sharing one cache, with `advance` moving the clock |
| `emit.php` | sends each request through Coolify's HTTP kernel and prints the answers. Nothing in it is a port |
| `goldens.json` | its output: per request the status, the rate-limit headers (and Retry-After) and content type, and the body exactly as Coolify wrote it; for a write, the rows it left (`after`); for a case with `http`, the requests Coolify sent to the faked API (`requests`); and the column order of the tables whose rows the API writes unsorted (`columns`: a loaded relation such as an application's destination, its server and their settings). Never edited by hand |
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
DP-86's replay (`src/api-v1-previews-destinations-operations.test.ts`: an application's previews, its additional
destinations, move, migrate and clone) adds four previews at the end of both fixtures (two of the Git application, pull
requests 17 and 12 — not 7, which DP-74's deploy case names as a pull request without a preview — one of the image
application, one of the other team's; `last_online_at` is the clock's now, as the saving hook sets it with the status)
and a token with `read` and `deploy` (id 12: a preview's redeploy). A case may now carry `setupCoolify` and
`setupFreeploy`, SQL of one side's tables only, run after `setup`: a second server of team 1 with its destination (and
an attached additional destination) is a row with Coolify's `team_id` on one side and Freeploy's `org_id`
(`deploy.current_org()`) on the other. The `after` queries of a clone read the copy's random uuid as `<uuid>` inside its
name, domain and volume names. No masking is added.
DP-87's replay (`src/api-v1-application-create.test.ts`: the create types dockerimage, dockerfile, public and
private-deploy-key, and PATCH /applications/{uuid}) adds no fixture rows. A created application is the one whose uuid
is not the fixture's: the `after` queries read its random uuid as `<uuid>` inside its name, domain and labels, and the
random part of a generated name (`new_public_id()`) as `<random>`; an update's `after` reads the fixture's two
applications of team 1. A public github.com repository needs Coolify's public GitHub source (GithubApp id 0, which its
seeder makes and emit.php's fixture leaves out): those cases make it with `setupCoolify` (Freeploy's is the
`PUBLIC_GITHUB_SOURCE` constant). One masking is added: a uuid the request made where `generateUrl()` names a created
application after it (`http://<uuid>.<host>` of the answer's `domains`) as `://<new-uuid>.`.
DP-88's replay (`src/api-v1-logs-backups-servers.test.ts`) adds no fixture rows: what a case needs is made by its
`setup` (on both sides) or its `setupCoolify` and `setupFreeploy` (a row with the tenancy column of each side) — the
Git application's finished deployments (ids 6–9) and its registry image, a backup schedule of a storage (`v…parityschedule…`)
with its S3 storage and a running execution, the PostgreSQL's data volume given a fixed uuid, a proxy configuration, two
GitHub Apps of team 1. The `after` queries read a server's proxy as the model reads it (Server's retrieved hook gives
`redirect_enabled` true when it is missing, and Freeploy stores it), the log drain keys, the GeoIP key and a GitHub App's
secrets as whether they are set (`has_…`: Freeploy encrypts the log drain keys), a created schedule's or App's id or
uuid as null. The GitHub App cases run as Coolify Cloud (`config.self_hosted` false: no App is system-wide, a git
source may not point to a private network), as Freeploy does; `columns` gains `github_apps` (an updated App is answered
unsorted). Coolify's absolute links and its private-target message name its APP_URL (`http://localhost`), which the test
gives as Freeploy's console URL. No masking is added.
DP-90's replay (`src/api-v1-cloud-providers.test.ts`: the cloud provider tokens, the providers' catalogs, a server's proxy
configuration) adds five cloud provider tokens at the end of both fixtures (`cloudTokens`: one per provider of team 1, a
Hetzner token of team 2), made through Coolify's model (the `encrypted` cast) and stored encrypted with the org's key on
Freeploy's side. A case may carry `http`: the answers of the outside API (a cloud provider's), which emit.php gives
Laravel's `Http::fake()` for that case only — the first whose `match` (a regex on `METHOD URL`) fits answers with its
`body` (JSON) or `raw` text, `status` and `headers`; anything else is `{"message":"Not Found"}` with 404 — and every
request Coolify sends is recorded in the golden's `requests` (method, URL with its query, Authorization, the JSON body).
The test's fetch serves the same answers and records the same fields, so what Freeploy asks the provider (the pages,
the retries, the decrypted token) is compared too; the Retry-After header of a rate-limited answer is compared with the
golden's `headers`. The `after` queries read a token's ciphertext as whether it is set (`has_token`) and a created
token's id as null; the proxy configuration's read the server's proxy as DP-88's do. No masking is added.
DP-93's replays (`src/api-v1-denials.test.ts`, `src/api-v1-github-apps-hostinger.test.ts`) add one private key at the end
of team 1's (id 4, `k4parityg…`: DP-72's RSA GitHub App key, read from `../sources/cases.json` on both sides, never inlined)
and two member tokens (ids 13 and 14: read with deploy, read with delete). Freeploy's PGlite fixture now stores every
fixture key as its text, encrypted with the org's key, with its real fingerprint (until DP-93 it stored the key file's
path and `fp-<uuid>`; emit.php always stored the text), so a key's public key — a Hostinger purchase's setup, a GitHub
App's JWT — is the same on both sides. A `denied: <earlier case>, <who>` case is an earlier case sent with a member's
token; what lets Coolify's member hold a deploy, delete or write token is a level stored on its membership
(`team_user.access`, given by `setupCoolify`): Freeploy has no such grants, so the deploy-core-worker replay tells the
handler policy-worker's member answer (deploy.resource.read only) and tests/api-edge checks that the edge refuses that
member's token itself. A GitHub App case's `setupCoolify`/`setupFreeploy` make App 3 (installation 2003) with key 4; its
`requests` hold the JWT Coolify signed at the fixed clock, which Freeploy's request must equal. A Hostinger case's
`after` reads the servers made after the fixture's (`id > 2`), with a generated name as `<random-name>`. No masking is
added.

DP-104's replay (`src/api-v1-integration-tokens.test.ts`: /security/integration-tokens) adds six integration tokens at the
end of both fixtures (`integrationTokens`: two Cloudflare tokens, a Doppler, an Infisical and a Vault token of team 1, a
Cloudflare token of team 2, with fixed `created_at` so that `latest()` orders them) and four DNS zones of the Cloudflare
tokens (`dnsZones`), made through Coolify's models (the `encrypted` and JSON casts) and stored with the org's key on
Freeploy's side. An `http` answer may carry `failedConnection: true`: emit.php answers it with `Http::failedConnection()`
(Laravel's ConnectionException), the test's fetch throws. `requests` also records a Vault request's `x-vault-token` and
`x-vault-namespace` (absent from every earlier request, so no earlier golden changes). A secret manager link or a managed
DNS record of a case is a row of `setupCoolify` (Coolify's secret_manager_links has no team) and `setupFreeploy` (org_id).
The `after` queries read the JSON columns as `::jsonb::text`, `zones_synced_at` as whether it is set (Freeploy's clock is the
test's), a created row's id as null and a zone's token as whether it is the fixture's. The goldens of the earlier cases
are those already committed: emitted again, they differ only in random values. No masking is added.

DP-103's replay (`src/api-v1-gitlab-gitea.test.ts`: GET/POST /gitlab-apps, PATCH/DELETE /gitlab-apps/{id}, GET /gitea-apps,
POST /applications/private-gitea-app and PATCH /applications/{uuid} with `gitea_app_uuid`) adds three GitLab Apps and three
Gitea Apps at the end of both fixtures (`gitlabApps`, `giteaApps`: two of team 1 — the first of each connected — and one of
team 2), made through Coolify's models (the `encrypted` casts and GitlabApp's webhookToken() mutator) and stored encrypted with
the org's key on Freeploy's side; no source uses a private key, so the earlier goldens change only in their random values: the whole file was emitted, and only the new cases' entries were inserted after DP-104's, the committed ones kept byte for byte. The connected sources' tokens
expire in 2038: refreshGiteaToken() compares `expires_at` with PHP's `time()`, the real clock, which `Carbon::setTestNow()`
does not fix, so a case that lets a token expire (`setup`) reads the refreshed expiry as later than the clock (`expires_later`).
The Gitea instance is faked through `http` (DP-90's); the token refresh is a form, which emit.php records without a body
(`json_decode()` of it is null) and the replay's fetch the same. The cases run as Coolify Cloud (`config.self_hosted` false),
and three `denied:` cases are added (39 in all). The `after` queries read a source's secrets as whether they are set (`has_…`)
and a created source's id as null. No masking is added.

DP-106's replay (`src/api-v1-secret-manager-email.test.ts`: `/{applications,services,databases}/{uuid}/secret-manager[/keys|
/references|/import]` and `/settings/email`) adds no fixture rows. A secret manager link is a row of `setupCoolify` and
`setupFreeploy` (DP-104's), and a case may carry `tokenSecrets` (`[{id, token}]`): emit.php replaces that integration token's
secret through the model after `setupCoolify` (the `encrypted` cast), the test encrypts it with the org's key — a Doppler
service account (`dp.sa.`), which the fixture has none of. Doppler, Infisical and Vault are faked through `http` (DP-90's).
The email settings need Coolify's root team, which the fixture leaves out: `setupCoolify` makes team 0, user 1's owner
membership and five root-team tokens (ids 51–55, `sha256()` of their plain text), and the case names its token in
`rootTeamToken` (`{key, id, user, abilities, secret}`, sent as `authorization`); Freeploy has no root team, so
tests/api-edge resolves that token as user 1's token of the org and the deploy-core-worker replay answers the platform
operator's gate for it (every other token's user is not the operator). The `after` queries read a link's settings as
`::jsonb::text`, whether it is the fixture's (`uuid like 'u_parity%'`) and untouched (its fixed `updated_at`), a created
variable's value as whether it is set, and row 0's encrypted email columns as whether they are set (`has_…`); Freeploy's
row 0 is read as the platform operator. The new cases' goldens were emitted alone and inserted after DP-103's, the committed
ones kept byte for byte. No masking is added.

DP-105's replay (`src/api-v1-dns.test.ts`: GET /dns/zones, GET/POST /{applications,services}/{uuid}/dns, POST …/dns/replace,
DELETE …/dns/{hostname}) adds no fixture rows: the zones are DP-104's, a managed record and its references are rows of
`setupCoolify` (team_id; Coolify's references have no team) and `setupFreeploy` (org_id), a second zone of the same name or
a longer one is a case's too, and `after` reads the records by uuid (`m<n>paritydns…` are the setup's, a created one is null)
with their token and zone, and the references by the record's name. Cloudflare is faked through `http` (DP-90's); a string
`{{ownership:<uuid>}}` of a fake answer is the ownership comment each side writes for that record (emit.php:
`ManagedDnsRecord::ownershipCommentFor()`, the test: Freeploy's), so a record read back is owned on both sides. emit.php
also makes DnsController again for each request: a route keeps the controller it made, and its CloudflareDnsProvider caches the
team's zones, which a case's own zone would not reach. Three `denied:` cases are added (45 in all). Only the new entries were
inserted into goldens.json, after DP-106's; the committed ones are kept byte for byte. One masking is added, of the requests.

DP-108's replay (`src/api-v1-service-clone.test.ts`: POST /services/{uuid}/clone, clone_service()) adds no fixture rows: a
case's `setup` gives the fixture's service another Compose file (named volumes, a bind mount inside the service's directory,
a host path, magic variables), a database backup schedule of its database, or DP-106's secret manager link (`setupCoolify`,
`setupFreeploy`). The `after` queries read the clone as the service whose uuid is not the fixture's: its random uuid as
`<uuid>` inside its name, generated Compose file, domains and volume and file paths, its parts' random uuids in the Compose
file's labels as `<part-uuid>` (regexp_replace), the encrypted values as whether they are set, and the services of team 1
counted (`uuid <> …other team's`). Only the new entries were inserted into goldens.json, after DP-105's; the committed ones
are kept byte for byte. No masking is added.

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
  reason;
- a uuid the request made where a generated domain starts with it (`http://<uuid>.<host>` of a created application's
  `domains`) as `://<new-uuid>.` (DP-87);
- in the requests sent to an outside API (`maskRequests()`), a managed DNS record's ownership comment — Coolify's
  `managed-by: coolify <app.id>/<uuid>`, Freeploy's `managed-by: freeploy <environment>/<uuid>` — as
  `managed-by: <instance>/<uuid>`, the uuid as `<new-uuid>` when the request made it (DP-105).

Everything else — every other key, its position, its type, every message — is compared byte for byte, the
JSON written again by `phpJsonEncode` (PHP's `json_encode`, `\/` included); a test checks that it writes
every golden body back unchanged. The rate-limit headers and the 429 bodies are compared as they are.
