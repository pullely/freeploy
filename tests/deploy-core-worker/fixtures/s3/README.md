# S3 storage and backup schedule goldens (DP-65)

What Coolify's own PHP does for an S3 storage and a database backup schedule, so that the
TypeScript ports in `apps/deploy-core-worker/src/s3-storages/` and `src/databases/backups.ts` can be
held to it (`src/s3-storages.test.ts`, `src/database-backups.test.ts`).

- `aws4-testsuite.json` — AWS's Signature Version 4 test suite (the `aws4_testsuite` AWS
  published with its SigV4 documentation, as botocore vendors it at
  `tests/unit/auth/aws4_testsuite/`): 21 cases, each with the request (`req`), the canonical request
  (`creq`), the string to sign (`sts`) and the Authorization header (`authz`), signed with the
  suite's credentials (`AKIDEXAMPLE`, region `us-east-1`, service `service`, 2015-08-30T12:36:00Z).
  `fetch-aws4-testsuite.py` downloads them (`python3 fetch-aws4-testsuite.py aws4-testsuite.json`).
  Left out: the suite's path-normalization cases (S3 neither normalizes nor double-encodes a path)
  and the session-token and `get-space` cases.
- `cases.json` — the cases: `requests` (a storage's settings for the disk Coolify builds),
  `testConnection` (a storage model), `validation` (the New Storage and General forms; each case
  gives what differs from `validationBase`), `backupValidation` (BackupEdit's properties; what differs
  from `backupValidationBase`), `databasesToBackup`, `cron`, and `server`: how the fake endpoint
  answers each bucket.
- `fake-s3.php` — that endpoint, served with `php -S 127.0.0.1:9765 fake-s3.php`. It records every
  request in `requests.jsonl` next to it.
- `emit.php` — runs every case through Coolify's real code and prints the results. It boots the
  Laravel application. Nothing in it is a port.
  - `requests`: the disk of `S3Storage::s3Filesystem()` (`Storage::build` with Coolify's config),
    `files()` on it — Flysystem's `listContents('', false)`, the AWS SDK's `ListObjectsV2` —
    against the fake endpoint: what was sent (host, path, query, the signed headers and the
    Authorization header the SDK computed) and the exception's message. The config leaves out
    `SafeWebhookUrl::httpClientOptions()`'s DNS pin, which would send the request elsewhere.
  - `testConnection`: `S3Storage::testConnection()` itself on a model built as
    `Form::testConnection()` builds it, with an instance setting that lets the endpoint be the fake
    server on localhost (an `instance_settings` table with only the columns `SafeWebhookUrl` reads):
    the requests, the message, `is_usable` and the URL style after the path-style fallback.
  - `validation`: Laravel's validator with `Create`'s rules (built from
    `S3Storage::connectionRules()` as `Create::rules()` builds them) and `Form::rules()`, each with the
    component's own `messages()` and `validationAttributes()`; `Create`'s `normalizeEndpoint()` first.
    Host names resolve through `SafeWebhookUrl::resolveHostsUsing()` (no DNS is asked): see
    emit.php for the table, which the tests' resolver repeats.
  - `backupRules` / `backupValidation`: `BackupEdit`'s `#[Validate]` rules, read from the component by
    reflection, through Laravel's validator (the component has no messages or attribute names).
  - `databasesToBackup`: `validateDatabasesBackupInput()`. `cron`: `validate_cron_expression()`.
- `goldens.json` — its output. Never edited by hand.

## Regenerating

With a checkout of coollabsio/coolify at commit `91b7e3e`, in a copy you can write to (the same
setup as `../labels/README.md`), and the three files of this directory copied somewhere writable:

```sh
composer install --no-dev --no-scripts --ignore-platform-reqs --no-interaction
printf 'APP_ENV=testing\nAPP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nDB_CONNECTION=sqlite\nDB_DATABASE=:memory:\nCACHE_STORE=array\nSESSION_DRIVER=array\nQUEUE_CONNECTION=sync\n' > .env
php -S 127.0.0.1:9765 /path/to/copy/fake-s3.php &
php /path/to/copy/emit.php "$PWD" /path/to/copy/cases.json > /path/to/freeploy/tests/deploy-core-worker/fixtures/s3/goldens.json
```

The committed file was emitted with PHP 8.3.6 (cli) and the versions of Coolify's lock file:
aws/aws-sdk-php 3.403.6, league/flysystem-aws-s3-v3 3.35.3, poliander/cron 3.3.1.

## What changes between two runs

`X-Amz-Date` (and so each Authorization header) is the time of the run; the test signs with the
recorded date, so it holds for any run. The SDK's `amz-sdk-invocation-id` and User-Agent are not
recorded.

## What the goldens show that the port does differently

- The private-target message ends, in Coolify, with "Configure allowed internal targets:" and a link
  to the instance's Advanced settings; Freeploy has no such settings and stops after the first
  sentence. The tests strip that suffix from the goldens.
- `testConnection` runs against `localhost`, which Coolify allows here only through the instance
  setting; Freeploy never allows it, so the tests run those cases against a public name and compare
  the messages with that host in place of `localhost`.
- The SDK signs an empty `X-Amz-User-Agent` header. The port does not send that header; the test
  signs the SDK's own header set to show the signatures agree.
