# Label goldens (DP-53)

What Coolify's own PHP returns for the container label code, so that the TypeScript ports in
`apps/deploy-core-worker/src/labels/` and `src/applications/labels-validation.ts` can be held to it
byte for byte (`src/labels.test.ts`).

- `cases.json` — the cases: a function of Coolify's and its arguments. A
  `generateLabelsApplication` or `parseContainerLabels` case gives only the fields that differ from
  `applicationDefaults` (merged recursively, as `array_replace_recursive` does).
- `emit.php` — runs every case through Coolify's real code and prints the results. It boots the
  Laravel application and calls `fqdnLabelsForTraefik`, `fqdnLabelsForCaddy`,
  `generateLabelsApplication`, `defaultLabels`, `Application::parseContainerLabels`,
  `decodeBase64EncodedLabels`, `isBase64Encoded`, `escapeDollarSign`,
  `traefikHostRulesWithoutIpv6Brackets`, `caddySiteAddress`, `isNoindexDomain`,
  `Server::caddyDockerProxyImageVersion`, and — for the `validate.*` cases — Laravel's validator
  with `General::rules()`, `messages()` and `$validationAttributes`. Nothing in it is a port. No
  database is used: the models are built in memory with their relations set.
- `goldens.json` — its output. Never edited by hand.

## Regenerating

With a checkout of coollabsio/coolify at commit `91b7e3e`, in a copy you can write to:

```sh
composer install --no-dev --no-scripts --ignore-platform-reqs --no-interaction
printf 'APP_ENV=testing\nAPP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nDB_CONNECTION=sqlite\nDB_DATABASE=:memory:\nCACHE_STORE=array\nSESSION_DRIVER=array\nQUEUE_CONNECTION=sync\n' > .env
php /path/to/freeploy/tests/deploy-core-worker/fixtures/labels/emit.php "$PWD" \
  /path/to/freeploy/tests/deploy-core-worker/fixtures/labels/cases.json \
  > /path/to/freeploy/tests/deploy-core-worker/fixtures/labels/goldens.json
```

The committed file was emitted with PHP 8.3.6 (cli) and Laravel 12.72.0, Coolify 4.7.6 (the
`coolify.version` label). The `APP_KEY` only serves the model's `encrypted` cast in memory.

## What changes between two runs

`password_hash()` draws a new salt each time, so every bcrypt and Argon2id hash in `goldens.json`
differs after a regeneration; nothing else does. The test does not compare against a fixed hash:
it takes the salt out of each golden hash and has the port's own bcrypt hash the case's password
with it, which must give the golden's hash. Argon2id is not ported; for those cases the golden's
hash is handed to the port and only the labels around it are compared.

## Not covered

- A domain written as `scheme:rest` without `//` (for example `mailto:…`): PHP's `parse_url()`
  has rules of its own for it that the port does not reproduce. Coolify's validation stores
  `http://` and `https://` URLs only.
- `generate_unique_uuid` (a random uuid per domain): checked in the test with an injected uuid,
  not against PHP.
- `Str::slug` for scripts other than Latin: Coolify transliterates through
  voku/portable-ascii's tables; the port keeps ASCII, strips diacritics and maps a few Latin
  letters (`ß`, `æ`, `ø`, `ł`, …), and drops everything else.
