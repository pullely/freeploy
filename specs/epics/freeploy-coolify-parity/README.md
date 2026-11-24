# Epic: freeploy-coolify-parity (DP)

**Coolify is the best self-hosted way to deploy to your own servers, but every
customer runs, patches and backs up their own copy of the control plane.
Freeploy makes that control plane a hosted, multi-tenant product: many
independent teams on one deployment, each reaching their own servers over SSH
exactly as Coolify does, with Coolify's features, defaults, validations,
copy and screens reproduced exactly. The idea that makes it possible is to
keep everything that touches the customer's server byte-for-byte identical
(the generated shell commands, the helper image, the proxy labels, the
networks) and to replace only what sits above it — Laravel, Livewire,
Horizon and Soketi — with Freeploy's Workers, Workflows, Queues, Durable Objects
and Postgres via Hyperdrive, measured route by route against a running
reference Coolify.**

Freeploy is for developers and small teams who want Coolify's "push to deploy
on my own VPS" without operating Coolify itself. When this epic ships, a team
signs up, adds a server by IP and private key, and deploys applications (every
build pack), databases (eight engines) and 390 one-click services to it, with
previews, backups, scheduled tasks, notifications, a web terminal and the
`/api/v1` API — on screens a Coolify user already knows. Each team is a Freeploy
org; nothing is shared between orgs, and the instance-admin powers Coolify
gives its root team belong to the Freeploy operator alone.

Freeploy is a port of [Coolify](https://github.com/coollabsio/coolify)
(Apache-2.0) at `91b7e3e`. It is not affiliated with coollabs.io; brand marks
are replaced and attribution is kept in `THIRD_PARTY_NOTICES.md`.

## Status

| Field | Value |
|-------|-------|
| Status | In progress |
| Cluster | **DP** (DP0–DP13) |
| Owner(s) | `apps/deploy-core-worker` (the `deploy` resource) · `apps/ssh-executor` + `SshSession` DO (server access) · `packages/contracts` + `packages/sdk` (the wire) · `apps/deploy-web` (the exact UI port) · `tools/parity` (the measure) |
| Builds on | `freeploy baseline-v33` — extends identity (2FA, passkeys), membership + policy (Coolify roles), config, notifications, webhooks, billing (Polar), metering, events/audit, integrations, api-edge |
| Changes | Adds the `deploy` schema and worker, the SSH executor, the Workflows/Queues/Cron that replace Laravel jobs, the `OrgRealtime` DO, and the `deploy-web` SPA; Freeploy's own workers are extended, never rebuilt |
| Decisions locked | (1) Coolify's final schema is ported with the same table and column names, `team_id` → `org_id`, `uuid` kept as the public id, and `org_id` on every table. (2) Customer servers are reached over SSH from a Go `ssh-executor` (Cloudflare Container) behind one `SshSession` Durable Object per server; command strings are byte-identical to Coolify's. (3) Long or multi-step Laravel jobs become Workflows; the scheduler becomes Cron Triggers enqueuing org-scoped work. (4) The UI is a Vite + React SPA on Coolify's own Tailwind v4 CSS, same URLs as `routes/web.php`, Svelte canvases reused. (5) "Exact" is measured: ≤ 0.5% pixel diff per screenshot, 100% DOM/copy, 100% `/api/v1` contract, byte-equal command goldens. (6) Instance-admin features are platform-admin only. |
| Gate | DP1 (the harness) lands before any feature, so every feature PR is measured from day one. DP2 is invisible (the schema). DP3 is the first user-visible change. |
| Shipped as | |

## Read order

1. `design.md` — the resource model, the API, the console, SSH/events/secrets, what is out of scope
2. `implementation-plan.md` — DP0–DP13 and what "done" means for each
3. `risks-and-open-questions.md` — what could go wrong and what was decided
4. `IMPLEMENTATION-STATUS.md` — what actually shipped (kept distinct from intent)
5. `parity/README.md` — the generated inventory: every route, component, job, helper, template and string, with its milestone and status

## Milestones at a glance

| Milestone | What it lands | Done when |
|---|---|---|
| DP0 — the spec | this doc set + the generated parity inventory (DP-1); the public, listing-ready repo (DP-2) | `task_get DP-1` and `DP-2` read `done`; inventory counts within ±5% of the brief; repo is `PUBLIC` |
| DP1 — parity harness | reference Coolify at `91b7e3e`, fixtures, screenshot/DOM/API/command diff tooling, CI artefacts, parity report | the harness runs in CI against the reference and an empty stage; the report renders |
| DP2 — data model | the `deploy` schema, secret encryption, `deploy-core-worker` skeleton + `api-edge` facade, cross-org isolation tests | migrations run on stage; every table has `org_id`; isolation tests cover every table |
| DP3 — UI shell | `deploy-web` on Coolify's CSS and theme, all 145 Blade components, auth pages, profile, appearance, brand swap | visual gate (≤ 0.5%) on auth and profile routes; DOM/copy 100% (component gallery deferred, risks DP-M) |
| DP4 — servers over SSH | `ssh-executor` + `SshSession`, keys, validate/install, proxy, destinations, Sentinel, cleanup, terminal | command goldens pass; a test VM is validated, proxied and reachable by terminal; visual gate on `/server/*` |
| DP5 — applications | every build pack, `ApplicationDeploymentJob` as a Workflow, queue, logs, domains, env, storage, health, limits, rollback | each build pack deploys to the same container state as the reference; visual + API gates for applications |
| DP6 — sources and previews | GitHub App manifest flow, GitLab/Gitea/Bitbucket, deploy keys, webhooks, previews, commit statuses | PR → preview → cleanup end to end; visual gate |
| DP7 — databases | all 8 engines, public ports, SSL, backups to S3 with retention, restore, S3 storages | backup → wipe → restore per engine; visual gate |
| DP8 — services | 390 templates, compose parser, magic variables, service settings | every template renders byte-equal to Coolify's parser; 10 representative templates deploy |
| DP9 — platform features | scheduled tasks, shared variables, tags, notifications (6 channels × all events), API tokens, full `/api/v1` | API contract 100%; notification payloads byte-equal |
| DP10 — teams and governance | members, roles, invitations, audit log, Boarding, subscription pages on Freeploy billing | visual gate; role matrix tests match Coolify's policies |
| DP11 — advanced | canvases, image scanning/SBOM, Swarm, transfer, volume backup, runners, DNS, log drains, traffic, Sysbox, registries, maintenance, Tunnel, Hetzner | each feature end to end against the reference; visual gate |
| DP12 — platform admin | instance settings, updates, admin view, operator backups | visual gate; unreachable by customer orgs |
| DP13 — prod, docs, certification | the parity report at 100%, docs, prod smoke | 100% routes, 100% API, 100% jobs/actions/helpers (or deferred with reason); prod smoke passes |
