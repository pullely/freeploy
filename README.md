# Freeploy

**Freeploy**: free hosted deploys to your own servers.

Add a server by IP and SSH key, then deploy applications (Nixpacks, static,
Dockerfile, Docker image, Docker Compose), databases (PostgreSQL, MySQL,
MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse) and hundreds of
one-click services to it, with preview deployments, backups to S3, scheduled
tasks, notifications, a web terminal and a REST API. Many independent teams
share one hosted control plane; each team's servers, keys and resources
belong to that team alone.

Freeploy is a multi-tenant port of [Coolify](https://github.com/coollabsio/coolify)
(Apache-2.0), not affiliated with coollabs.io. It reproduces its
features and screens at a pinned commit on a different architecture:
Cloudflare Workers, Workflows, Queues and Durable Objects for the control
plane, Supabase Postgres through Hyperdrive for data, and a small SSH executor
that reaches your servers exactly the way the original does. See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attribution and
[the epic](specs/epics/freeploy-coolify-parity/README.md) for the design and
the parity plan.

Status: **in development.** Progress, milestone by milestone, is in
[IMPLEMENTATION-STATUS.md](specs/epics/freeploy-coolify-parity/IMPLEMENTATION-STATUS.md)
and the [parity report](specs/epics/freeploy-coolify-parity/parity/README.md).

## Platform

`pullely/freeploy` runs on the Freeploy baseline: a multi-tenant SaaS on
Cloudflare Workers and Supabase Postgres, run as an [Orun](https://github.com/sourceplane/orun)
component-native desired-state repo. Identity, organizations, projects, RBAC,
audit, metering, billing, webhooks and notifications are separate
bounded-context Workers behind one public edge API.

## Licence and security

Apache License 2.0 — see [LICENSE](LICENSE). Report vulnerabilities privately
as described in [SECURITY.md](SECURITY.md). Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).

## Live deployment

<!-- 08-docs:begin -->
Not recorded yet. The build's last phase writes the live URLs, the workspace
and the secrets inventory into
[ai/context/deployment.md](ai/context/deployment.md); how the product deploys
and how to operate it is in
[ai/context/operations.md](ai/context/operations.md).
<!-- 08-docs:end -->

## Working on it

Start at [AGENTS.md](AGENTS.md). It is written for a coding agent and is the
shortest way in for a person too: what to read first, how a change lands, and
what not to touch.

## What is here

| Path | What it is |
|---|---|
| `apps/api-edge` | The one public HTTP entry point; reaches the workers over service bindings |
| `apps/*-worker` | Twelve bounded-context Workers — identity, membership, projects, policy, events, config, metering, billing, notifications, webhooks, integrations, admin. Never public |
| `apps/web-console-next` | The console: Next.js on Workers + Static Assets, configured against the edge |
| `packages/*` | Shared libraries: contracts, SDK, CLI, the database harness, the policy engine, the notifications client, the webhook verifier |
| `infra/terraform/*` | The data plane: Supabase projects, Hyperdrive, the edge's idempotency KV, and the custom-domain component (parked until a domain is set) |
| `infra/db-migrate` | Database migrations — planned on pull requests, applied on merge |
| `tests/*` | Per-component contract and verifier suites |
| `intent.yaml` | The environments, the pinned composition catalog, and the Orun workspace this repository deploys into |

`stage` and `prod` are provisioned and deployed; `dev` is verify-only.

## Getting started

Node.js 20 or later and pnpm 10.

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

## How it deploys

Merges to `main` converge through Orun: `.github/workflows/ci.yml` runs
`orun plan --changed`, then one `orun run` lane per planned component. A pull
request plans and verifies; a push to `main` deploys `stage`, then `prod` once
`stage` has converged on the same commit. No pnpm, Wrangler or Terraform
command runs directly in CI.

The pipeline holds one credential, GitHub's own `GITHUB_TOKEN`. Cloudflare and
Supabase credentials are brokered per run from the workspace's connections;
nothing provider-shaped is stored in the repository or in GitHub.

## Custom domain

The product answers on workers.dev from its first deploy. Setting a domain is
one pull request, later:
[Setting the domain later](ai/context/operations.md#setting-the-domain-later).
