# Service catalogue and Compose parser goldens (DP-59)

What Coolify's own PHP does with its service templates, so that the TypeScript ports in
`apps/deploy-core-worker/src/services/` can be held to it: the catalogue (`service-catalogue.test.ts`),
the New Resource page's list (`services.test.ts`) and the Compose parser (`service-parser.test.ts`).
Nothing in the `emit*.php` files is a port: they call Coolify's code and print what it returns.

| File | Emitted by | What it is |
|---|---|---|
| `catalogue-golden.json` | `emit-catalogue.php` | `php artisan generate:services` (Coolify's generator): the 359 entries of `templates/service-templates-latest.json`, with `compose` replaced by its sha256 and without `template_last_updated_at` |
| `select-golden.json` | `emit-select.php` | `App\Livewire\Project\New\Select::loadServices()`: the services as the New Resource page lists them and the categories, without `compose` and the dates |
| `goldens.json.gz` | `emit.php` | every one of the 359 services created and parsed twice on Coolify's default server (11 MB of JSON, so gzipped) |
| `goldens-traefik-exact.json.gz`, `goldens-caddy-exact.json.gz` | `emit.php --variant=…` | 34 of them on a server with a proxy chosen, "generate exact labels" on and a wildcard domain |

## How a service is created and parsed (`emit.php`)

Database: Coolify's `testing` connection — SQLite in memory — with all of Coolify's migrations
(`artisan migrate`), the way its own test suite runs. Each template runs in a transaction that is rolled
back, so every service has id 1 and its parts ids from 1.

Per template, the code of `app/Livewire/Project/Resource/Create.php::createResource()`:
`new Service(payload)->save()`, the name, the template's `envs`, `$service->parse(isNew: true)`,
`applyServiceApplicationPrerequisites($service)` — emitted as `first`. Then `$service->fresh()->parse()`
once more — emitted as `second`, or `"same"` when nothing changed (it changes for 4 templates:
appwrite, beszel, logto, rybbit). Each state is the rows as they are in the database: the service (with
`docker_compose_raw` and `docker_compose`), its `service_applications`, `service_databases`,
`environment_variables` (values decrypted), `local_persistent_volumes` and `local_file_volumes`
(content decrypted), every column.

Fixed: one team, one server (`203.0.113.10`), its default destination (network `coolify`), the project
"Fixture Project" and its `production` environment; the service's uuid; the uuids of applications and
databases (`sub` + a counter, set by a model event after Coolify's own); the clock (2026-01-01T00:00:00Z,
which the Supabase JWTs carry). Jobs are faked (`Bus::fake()`, `Queue::fake()`): a new file storage would
otherwise dispatch a job that opens an SSH connection. The cache is the array store: with Coolify's
default (Redis, not running) `get_service_templates()` throws and `Service::getRequiredPort()` answers
null, which is not what an installed Coolify does.

### What is random, and what the test does about it

`Str::password()` and `random_bytes()` cannot be seeded, so the generated values of `SERVICE_PASSWORD_*`,
`SERVICE_USER_*`, `SERVICE_BASE64_*`, `SERVICE_HEX_*` and `SERVICE_REALBASE64_*` differ on every run, and
`goldens*.json.gz` change with them. The test replays them: the port's source of generated values answers
with the golden's value for that variable, after checking that both that value and the one the port
would have generated have the command's shape (length and alphabet). Everything derived from them is
then compared without a mask — the two Supabase keys are signed by the port, not replayed.

Left out of the rows, and so not compared: `created_at`, `updated_at`, `deleted_at`; `last_online_at`
(its column default is a date frozen into Coolify's SQLite schema); the random `uuid` of each
environment variable and volume, which nothing refers to.

### What the test compares

For every service and both parses: every remaining column of every row, in order — the columns the port
carries from its own rows, the others against the defaults of Coolify's schema — and `docker_compose`
and `docker_compose_raw` as text. 359 services, 573 applications, 219 databases, 5849 environment
variables, 791 volumes and 125 file storages on the default server; 34 services on each variant.

## Regenerating

With a checkout of coollabsio/coolify at commit `91b7e3e`, in a scratch copy you can write to (the
generator writes its catalogue files into it):

```sh
composer install --no-dev --no-scripts --ignore-platform-reqs --no-interaction
printf 'APP_ENV=testing\nAPP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nDB_CONNECTION=sqlite\nDB_DATABASE=:memory:\nCACHE_STORE=array\nSESSION_DRIVER=array\nQUEUE_CONNECTION=sync\n' > .env
bash /path/to/freeploy/tests/deploy-core-worker/fixtures/services/regenerate.sh "$PWD"
```

`regenerate.sh` runs `../compose-yaml/emit.php`, `emit-catalogue.php`, `emit-select.php` and `emit.php`
(default server, then the two variants) and takes about a minute. The emitters set the connection
(`testing`), the cache (`array`) and the queue (`sync`) themselves. PHP needs `pdo_sqlite`.

The committed files were emitted with PHP 8.3.6 (cli), Laravel 12.72.0, symfony/yaml v8.1.11 and
Coolify 4.7.6. The catalogue the Worker ships (`apps/deploy-core-worker/src/services/catalogue-data.ts`)
is built from the same checkout:

```sh
node apps/deploy-core-worker/scripts/build-service-catalogue.mjs /path/to/coolify \
  --fixture tests/deploy-core-worker/fixtures/compose-yaml/templates.json.gz
```

## Not covered

- Servers with a log drain (the `logging:` section Coolify generates for it), with traffic analytics,
  or with a Caddy that supports `log_append`.
- Services with saved state the parser reads back: domains edited by the user, converted
  (`is_migrated`) parts, saved file storages, `preserve_compose_null` variables, shared variable
  references (`{{team.X}}`), external volumes with a legacy storage. The port follows the PHP for these;
  no golden exercises them.
- Compose files outside the catalogue: comments in `environment:` blocks, `content:` volumes in a file
  with comments, parser versions below 5.
