# Coolify's security status copy (DP-113)

What Coolify's own `SecuritySentences`, `TeamVulnerabilities` (statusLabel, action, imagesLine) and `VulnerabilityMarkers`
say about stored security statuses, so that the port (`apps/deploy-core-worker/src/image-scan/`) can be compared with
them by `src/image-scan-sentences.test.ts`.

| File | What it is |
|---|---|
| `emit.php` | reads the stored statuses of DP-113's API goldens (`../api/goldens.json`, the `after` rows of the vulnerabilities cases) and the scans of their cases (`../api/cases.json`), and prints what each function says. Nothing in it is a port |
| `sentences.json` | its output: per stored status (once per distinct summary) the headline, lines, badge, image sentence, version-check sentence, attack note, no-fix advice, why-more line, provenance (with the primary action and with none), registry name, status label, action and marker; and a few fixed inputs (`extra`). Never edited by hand |

The statuses are the ones Coolify's `SecurityStatus::store()` wrote in the API goldens, read back with
`ResourceSecurity::fromArray()`; each scan is an unsaved `ImageScan` with its case's columns and no resource (so no image
counts as one Coolify builds). No database is used. The clock is the goldens' (2026-01-01T00:00:00Z), which fixes every
"… ago". Emitted with PHP 8.3.6 in the scratch copy of coollabsio/coolify@91b7e3e that emits `../api/goldens.json`:

```sh
php emit.php <scratch copy> ../api/cases.json ../api/goldens.json > sentences.json
```
