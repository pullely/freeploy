# Third-party notices

## Coolify

Freeploy is a multi-tenant port of **Coolify**
(<https://github.com/coollabsio/coolify>), pinned at commit
`91b7e3e509dee1eb5cee7c41fe151be03b03092e` (2026-11-20).

Portions Copyright (c) Coolify contributors / coollabs.io
(Copyright 2025 Andras Bacsai), licensed under the Apache License,
Version 2.0. A copy of the licence is in [`LICENSE`](LICENSE).

Freeploy is not affiliated with, endorsed by or sponsored by coollabs.io or
the Coolify project. "Coolify" and the Coolify logo are trademarks of their
owners and are not used as Freeploy's brand.

### What was derived, and how it was modified

Every file derived from Coolify starts with a header of the form

```
// Derived from coollabsio/coolify@91b7e3e:<path> (Apache-2.0), modified.
```

naming the Coolify source it came from. The derived areas are:

| Area in Freeploy | Derived from (Coolify) | Modification |
|---|---|---|
| `packages/db` — `deploy` schema migrations | `database/migrations/**` (final schema) | rewritten as Postgres SQL; `team_id` renamed `org_id`; `org_id` added to every table; encrypted casts stored as per-org envelopes |
| `apps/deploy-core-worker` — domain logic, Workflows, Queues | `app/Models/**`, `app/Actions/**`, `app/Jobs/**`, `app/Livewire/**` (logic) | translated from PHP/Laravel to TypeScript on Cloudflare Workers; jobs became Workflows and Queue consumers; scheduler became Cron Triggers; scoped to one org |
| `apps/deploy-core-worker` — server command generation | `bootstrap/helpers/*.php` | translated to TypeScript; generated shell commands kept byte-for-byte identical |
| `apps/deploy-web` — UI | `resources/views/**` (Blade), `resources/css/**`, `resources/js/**` (Svelte canvases), `lang/**` | Blade/Livewire/Alpine re-implemented in React with the same DOM and classes; CSS, fonts, Svelte components and strings reused; brand marks replaced |
| `apps/deploy-core-worker` — service catalog (`src/services/catalogue-data.ts`) | `templates/compose/*.yaml` | reused as Coolify's own generator writes them (`app/Console/Commands/Generate/Services.php`, ported in `catalogue-build.ts`); parsed by a TypeScript port of `parsers.php` / `services.php` |
| `apps/deploy-core-worker` — Compose YAML (`src/compose/yaml.ts`) | `symfony/yaml` v8.1.11 (`Inline.php`, `Dumper.php`, `Escaper.php`, `Parser.php`), MIT, Copyright (c) Fabien Potencier | the scalar typing, merge key rules and dumper re-implemented in TypeScript so that a file reads and prints as Coolify's does |
| `apps/api-edge` — `/api/v1` | `routes/api.php`, `app/Http/Controllers/Api/**`, `openapi.json` | re-implemented on Workers; bearer tokens scoped to one org |
| `specs/epics/freeploy-coolify-parity/parity/openapi.json` | `openapi.json` | verbatim copy, used as the API contract |

Files under `specs/epics/freeploy-coolify-parity/parity/*.json` are generated
inventories that quote Coolify paths, identifiers and UI strings for the
purpose of measuring parity.

### Fonts

`apps/deploy-web/public/fonts/` carries the font files Coolify ships
(`resources/fonts/`): **Inter** (Copyright 2016 The Inter Project Authors) and
**Geist Sans / Geist Mono** (Copyright 2024 Vercel, in collaboration with
basement.studio), both under the SIL Open Font License 1.1
(<https://openfontlicense.org>).

### Vendored views

`apps/deploy-web/public/svgs/` carries Coolify's `public/svgs/` icons for the
notification channels (Discord, Telegram, Slack, Pushover), unmodified; those
marks belong to their respective owners and only identify the channel. It
also carries `default.webp`, Coolify's placeholder image for a service without
a logo, unmodified.

`apps/deploy-web/coolify/views/` is a verbatim copy of Coolify's
`resources/views/**`, used only as a Tailwind class source; it is not served.

### Third-party service logos

Logos under `public/svgs` (or the equivalent in `apps/deploy-web`) belong to
their respective projects and are shown only where Coolify shows them, to
identify a one-click service.

## yaml

`apps/deploy-core-worker` reads Compose files with **yaml** 2.x
(<https://github.com/eemeli/yaml>), Copyright Eemeli Aro, under the ISC
License. It is bundled into the Worker unmodified.

## Freeploy baseline

The platform scaffolding (Workers, packages, CI) comes from the Sourceplane
Freeploy baseline (`sourceplane/freeploy@baseline-v33`).
