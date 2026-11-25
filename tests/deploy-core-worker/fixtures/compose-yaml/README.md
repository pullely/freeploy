# Compose YAML goldens (DP-59)

What Symfony YAML returns as Coolify calls it — `Yaml::parse($compose)` and `Yaml::dump($compose, 10, 2)` —
so that `apps/deploy-core-worker/src/compose/yaml.ts` can be held to it byte for byte
(`src/compose-yaml.test.ts`).

- `cases.json` — the cases. `dump`: a value to dump. `parse`: a YAML text to parse and dump again; a case
  with `"compose": true` goes through Coolify's `parseDockerComposeYaml` (the BOM and the
  anchor-on-its-own-line repair). The `line-NN` cases are about where a block scalar ends (see below).
  Values are typed, because JSON has neither PHP's floats nor its ordered arrays:
  `{ "$float": "1.5" }`, `{ "$map": [[key, value], …] }`; a JSON array is a PHP list.
- `templates.json.gz` — every file of Coolify's `templates/compose` (390), gzipped JSON `{ file: text }`,
  written by `apps/deploy-core-worker/scripts/build-service-catalogue.mjs --fixture`. Input, not output.
- `emit.php` — runs Symfony over the cases and over the 390 template files and prints the goldens.
  Nothing in it is a port.
- `goldens.json` — its output: the dumps, the parsed values (typed) with their dumps or the parse error,
  and for each template file the sha256 of `Yaml::dump(Yaml::parse($raw), 10, 2)`. Never edited by hand.

The test requires: every dump byte-equal, every parsed value equal in type and key order, a
`YamlParseError` for every document Symfony refuses (the message is not compared), and the same sha256
for all 390 template files.

## Regenerating

`bash ../services/regenerate.sh <scratch copy of Coolify>` regenerates this directory's `goldens.json`
with the others; the scratch copy is prepared as `../services/README.md` says. Alone:

```sh
php emit.php "$COOLIFY" cases.json > goldens.json
```

The committed file was emitted with PHP 8.3.6 (cli), symfony/yaml v8.1.11 and Laravel 12.72.0 (Coolify
4.7.6).

## What the port reproduces that is not YAML

Symfony's reader is not the YAML specification, and Coolify's files are what Symfony makes of them:

- A plain scalar is typed by `Inline::evaluateScalar`: `0755` and `1.10.0` stay strings, `yes` and `on`
  are strings, `0o755` and `0x1F` are integers, `1_000` is 1000, `2024-01-01` is a Unix timestamp.
- `<<` merges keep the position of the merge; a key written after a merge overwrites in place; a
  duplicate key without a merge is an error, as is a key that evaluates to a boolean, null or a float.
- A plain scalar that continues after an empty line is an error.
- A block scalar (`|`, `>`) that is the last entry of its collection loses its final line break when
  Symfony's line bookkeeping takes its last line for the last line of the document. It compares line
  numbers of the whole file with a line count taken after the leading comment and empty lines were
  removed, so this happens to a `content: |` or `- |` near the end of a template that starts with a
  comment header — 8 of Coolify's 390 templates. The `line-NN` cases pin the rule from both sides.

## Not covered

- Tags other than `!!str` and `!!float` (Symfony's `!php/…`, `!!binary`, custom tags): refused.
- Flow collections spanning several lines with comments inside, multi-document streams, and YAML 1.1
  forms Symfony does not read either.
- Symfony's alias limit is approximated: every alias to a collection counts once, up to Coolify's 256.
- Error messages: Symfony's carry a line number and a snippet; only the refusal is reproduced.
