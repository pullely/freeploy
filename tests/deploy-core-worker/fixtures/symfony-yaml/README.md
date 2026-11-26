# symfony/yaml goldens (DP-110)

What `Yaml::parse()` of symfony/yaml v8.1.11 — the version in coollabsio/coolify@91b7e3e's `composer.lock` — and Coolify's
`ValidCloudInitYaml` (app/Rules/ValidCloudInitYaml.php) return, so that `apps/deploy-core-worker/src/yaml/symfony` (the port
of Symfony's Parser, Inline and Unescaper) can be held to them byte for byte (`src/symfony-yaml.test.ts`).

| File | What it is |
|---|---|
| `cases.mjs` | writes `cases.json` (`node cases.mjs > cases.json`): the hand-written `cases` (valid documents — cloud-config, block scalars, flows, anchors and merge keys, the scalar types, quoting, document markers, a BOM, CRLF — and every error the rule can report: duplicate keys, unclosed flows and quotes, tabs, colons in values, sequences and mappings mixed, missing and circular references, indentation, multiple documents, tags, reserved indicators, escapes, dates, base64, keys) and 3000 `fuzz` documents put together from YAML fragments by a seeded generator, the same every run |
| `cases.json` | its output. Input, not output of PHP |
| `emit.php` | runs `Yaml::parse()` and `ValidCloudInitYaml::validate()` on every document and prints `goldens.json`. Nothing in it is a port |
| `goldens.json` | per case id: `parse` — `{ok: true, value}` (typed: `{"$float": …}`, `{"$map": [[key, value], …]}` for every array, `{"$tagged": [tag, value]}`) or `{ok: false, error, line, snippet}`, the ParseException's message, line and snippet — and `rule`, the message ValidCloudInitYaml fails with (`:attribute` left in) or null. Never edited by hand |

The test requires every parsed value equal in type and key order (a float by its value), every ParseException message and
line equal, and every rule message equal; it also parses the 390 Compose templates of `../compose-yaml` with the port and
dumps them with `compose/yaml.ts`, which must give the sha256 PHP got for `Yaml::dump(Yaml::parse($raw), 10, 2)`.

## Regenerating

In a scratch copy of coollabsio/coolify@91b7e3e with `vendor/` (`composer install` as `../services/README.md` says; only the
autoloader is used, no database and no `.env`):

```sh
node cases.mjs > cases.json
php emit.php <scratch copy> cases.json > goldens.json
```

The committed file was emitted with PHP 8.3.6 (cli) and symfony/yaml v8.1.11 (Coolify 4.7.6).
