# freeploy-coolify-parity — implementation plan

Milestones land in order, one in flight at a time. Each is one or more tasks,
each task one pull request on an `orun/DP-<k>-<slug>` branch with an
`Orun-Task: DP-<k>` trailer on every commit and the manifest block in its
body, merged only when every check (including `orun/compliance` and the
parity jobs) is green. Large milestones (DP4, DP5, DP7, DP8, DP9, DP11) are
split into several tasks under the same Orunbase milestone, never into new
milestones. A milestone is marked ✅ here when its "done when" list is true,
in the PR that lands its last task, and recorded in `IMPLEMENTATION-STATUS.md`.

Every task's contract lists the inventory rows it ports (`parity/*.json` ids)
and the parity gates that must be green (`parity/visual`, `parity/dom`,
`parity/api`, `parity/commands`, `parity/behaviour`). Rows move
`planned → in_progress → ported → verified` in the PRs that touch them.

## DP0 — the spec ✅

The doc set, the task contracts and the generated parity inventory
(`tools/parity/inventory.ts` run against Coolify at `91b7e3e`) — task DP-1.
Then the repo made public and listing-ready (LICENSE, THIRD_PARTY_NOTICES,
SECURITY, CONTRIBUTING, README with the non-affiliation line, topics, secret
scanning, push protection, branch protection) — task DP-2.

- Coolify sources: the whole tree at `91b7e3e`, read by `tools/parity/inventory.ts`.
- Freeploy components: `specs/epics/freeploy-coolify-parity/**`, `tasks/**`, `tools/parity/**`, repo root docs.

**Done when**
- `task_get DP-1` and `task_get DP-2` read `done`
- the inventory counts are within ±5% of the brief (`node tools/parity/inventory.ts --check` exits 0)
- `gh repo view pullely/freeploy --json visibility` is `PUBLIC`

## DP1 — parity harness

`tools/parity` grows the harness: a script that brings up Coolify at
`91b7e3e` on a Docker runner with its own installer and seeds deterministic
fixtures through its API; the same fixtures applied to Freeploy stage through
`/api/v1`; Playwright visual capture with `pixelmatch`; DOM/copy extraction;
Schemathesis-style contract tests from `openapi.json`; the PHP-side golden
emitter for helpers (run inside the reference container); the behaviour
scenario runner; and the CI workflow that publishes `parity/visual-report.json`
and side-by-side images as artefacts and regenerates `parity/README.md`.

- Coolify sources: `scripts/install.sh`, `docker-compose*.yml`, `openapi.json`, `routes/web.php`, `bootstrap/helpers/*.php`, `database/seeders/**`.
- Freeploy components: `tools/parity/**`, `.github/workflows/parity.yml`, `package.json` scripts (`parity:*`).

**Done when**
- the parity workflow runs in CI against the reference and an empty Freeploy stage
- the parity report renders with per-route visual %, API %, command and behaviour results
- a deliberately broken fixture makes the relevant gate fail (the harness can say no)

## DP2 — data model

Migrations in `packages/db` create the `deploy` schema from the folded final
schema (`parity/migrations.json`, 88 tables), `team_id → org_id`, `org_id`
added to every table, `uuid` kept; envelope encryption for every Coolify
`encrypted` cast; `apps/deploy-core-worker` skeleton (Hono app, Hyperdrive
binding, health, org guard middleware); `api-edge` `deploy-facade.ts`; wire
types in `packages/contracts`; cross-org isolation tests.

- Coolify sources: `database/migrations/**`, `app/Models/**` (casts, relations), `config/database.php`.
- Freeploy components: `packages/db`, `packages/contracts`, `apps/deploy-core-worker`, `apps/api-edge`, `intent.yaml`.

**Done when**
- the migrations apply on stage and prod (db-migrate converged in `runs_list`)
- every table in `deploy` has a non-null `org_id`
- an isolation test per table proves a second org can neither read nor write the first org's rows through the facade

## DP3 — UI shell

`apps/deploy-web` on Coolify's CSS, fonts and theme; navbar, sidebar, team
switcher; all 145 Blade components ported with a component-gallery route;
auth pages (login, register, verify email, forgot/force reset, 2FA, passkeys)
backed by Freeploy identity extended with TOTP and WebAuthn; profile and
appearance; the brand swap.

- Coolify sources: `resources/css/**`, `resources/views/components/**`, `resources/views/layouts/**`, `resources/views/auth/**`, `app/Livewire/Profile/**`, `app/Actions/Fortify/**`, `lang/**`.
- Freeploy components: `apps/deploy-web`, `apps/identity-worker`, `apps/api-edge`.

**Done when**
- visual gate (≤ 0.5%, desktop/mobile, light/dark) passes on auth, profile and component-gallery routes
- DOM/copy parity is 100% on those routes
- a new user can register, verify, enable 2FA and add a passkey on stage

## DP4 — servers over SSH

`apps/ssh-executor` (Go, Cloudflare Container) and the `SshSession` DO; private
keys (generate, import, rotate); add server, `ValidateAndInstallServerJob` as a
Workflow; proxy (Traefik/Caddy) start, stop, configuration and dynamic config;
destinations; resources; Sentinel push and metrics; Docker cleanup; server and
container terminal over PTY.

- Coolify sources: `bootstrap/helpers/remoteProcess.php`, `docker.php`, `proxy.php`, `app/Actions/Server/**`, `app/Actions/Proxy/**`, `app/Jobs/*Server*`, `app/Livewire/Server/**`, `app/Livewire/Security/PrivateKey/**`, `app/Livewire/Terminal/**`.
- Freeploy components: `apps/ssh-executor`, `apps/deploy-core-worker`, `apps/api-edge`, `apps/deploy-web`.

**Done when**
- command golden tests pass for every DP4 helper and action
- end to end on a test VM: the server is validated, Docker installed, the proxy running, and the terminal opens
- visual gate passes on every `/server/*` route

## DP5 — applications

Every build pack (Nixpacks, static, Dockerfile, Docker image, Docker Compose)
and source type; `ApplicationDeploymentJob` as `application-deployment.workflow.ts`;
the deployment queue and cancel-superseded; logs (live via `OrgRealtime`,
archived to R2); domains and SSL; environment variables (build-time, preview,
shared); persistent storage and file mounts; health check; resource limits;
rollback; resource operations (clone, move); projects and environments.

- Coolify sources: `app/Jobs/ApplicationDeploymentJob.php`, `app/Actions/Application/**`, `app/Livewire/Project/**`, `bootstrap/helpers/applications.php`, `shared.php`, `docker.php`.
- Freeploy components: `apps/deploy-core-worker`, `apps/ssh-executor`, `apps/api-edge`, `apps/deploy-web`.

**Done when**
- each build pack deploys on a test VM and the final container state matches the reference's (`docker ps`, labels, networks, volumes)
- visual gate passes on every application, project and environment route
- the API contract passes for every application endpoint

## DP6 — sources and previews

GitHub App create/connect via the manifest flow, repositories and branches;
GitLab, Gitea, Bitbucket; deploy keys; push and PR webhooks; preview
deployments and their cleanup; commit statuses
(`ApplicationPullRequestUpdateJob`, `SyncGithubDeploymentJob`).

- Coolify sources: `app/Livewire/Source/**`, `app/Http/Controllers/Webhook/**`, `app/Jobs/*PullRequest*`, `app/Jobs/SyncGithub*`, `bootstrap/helpers/github.php`.
- Freeploy components: `apps/deploy-core-worker`, `apps/webhooks-worker` (verifier), `apps/integrations-worker`, `apps/deploy-web`.

**Done when**
- opening a PR on a test repository creates a preview, updates the commit status, and closing it cleans the preview up
- visual gate passes on every source and preview route

## DP7 — databases

PostgreSQL, MySQL, MariaDB, MongoDB, Redis, KeyDB, Dragonfly, ClickHouse:
create, start/stop, public ports, SSL, custom config; backups to S3 with
retention and executions; restore; S3 storages with validation.

- Coolify sources: `app/Actions/Database/**`, `bootstrap/helpers/databases.php`, `app/Jobs/DatabaseBackupJob.php`, `app/Livewire/Project/Database/**`, `app/Livewire/Storage/**`.
- Freeploy components: `apps/deploy-core-worker`, `apps/ssh-executor`, `apps/deploy-web`.

**Done when**
- per engine on a test VM: backup to S3 → wipe → restore round-trips the data
- visual gate passes on every database and storage route

## DP8 — services

The 390 compose templates, the compose parser and magic variables
(`parsers.php`, `services.php`), service settings, per-service backups, logs
and terminal.

- Coolify sources: `templates/compose/*.yaml`, `bootstrap/helpers/parsers.php`, `services.php`, `app/Actions/Service/**`, `app/Livewire/Project/Service/**`.
- Freeploy components: `apps/deploy-core-worker` (catalog), `apps/ssh-executor`, `apps/deploy-web`.

**Done when**
- every template's rendered compose is byte-equal to Coolify's parser output (golden per template)
- 10 representative templates deploy end to end on a test VM

## DP9 — platform features

Scheduled tasks; shared variables (team, project, environment, server);
tags and deploy-by-tag; notifications (email, Discord, Telegram, Slack,
Pushover, webhook × every event); API tokens with expiry warnings; the rest of
`/api/v1`.

- Coolify sources: `app/Notifications/**`, `app/Livewire/Notifications/**`, `app/Livewire/SharedVariables/**`, `app/Livewire/Tags/**`, `app/Http/Controllers/Api/**`, `openapi.json`.
- Freeploy components: `apps/deploy-core-worker`, `apps/notifications-worker`, `apps/identity-worker` (API keys), `apps/api-edge`, `apps/deploy-web`.

**Done when**
- the API contract passes for 100% of `openapi.json` operations
- every notification payload (event × channel) is byte-equal to the reference's

## DP10 — teams and governance

Members, roles (owner, admin, member, viewer per Coolify's permission matrix),
invitations and invite links, danger zone, audit log, onboarding (Boarding),
subscription pages on Freeploy billing (Polar).

- Coolify sources: `app/Livewire/Team/**`, `app/Policies/**`, `app/Livewire/Boarding/**`, `app/Livewire/Subscription/**`.
- Freeploy components: `apps/membership-worker`, `apps/policy-worker`, `apps/billing-worker`, `apps/events-worker`, `apps/deploy-web`.

**Done when**
- visual gate passes on every team, Boarding and subscription route
- role permission matrix tests match Coolify's policies, row for row

## DP11 — advanced

Canvas views (Svelte), image scanning and SBOM, Swarm, server transfer and
migration, volume backup/clone/recovery, GitHub runners, managed DNS, log
drains, traffic analytics, Sysbox, registries, maintenance mode, Cloudflare
Tunnel, the Hetzner cloud provider.

- Coolify sources: `resources/js/**/*.svelte`, `app/Livewire/**` for each feature, the matching Actions and Jobs.
- Freeploy components: `apps/deploy-core-worker`, `apps/ssh-executor`, `apps/deploy-web`.

**Done when**
- each feature runs end to end against the reference with the same outcome
- visual gate passes on every DP11 route

## DP12 — platform admin

Instance-level settings, updates, admin view and operator backups as
platform-admin features with Coolify's UI.

- Coolify sources: `app/Livewire/Settings/**`, `app/Livewire/Admin/**`, `app/Jobs/UpdateCoolifyJob.php`, instance backup actions.
- Freeploy components: `apps/policy-worker`, `apps/admin-worker`, `apps/deploy-core-worker`, `apps/deploy-web`.

**Done when**
- visual gate passes on every settings and admin route
- tests prove no customer org (any role, including Coolify's `root` ability) can reach them

## DP13 — prod, docs, certification

Prod convergence, operator and user docs, and parity certification.

**Done when**
- the parity report shows 100% web routes visually and DOM matched, 100% API contract, 100% jobs/actions/helpers/notifications verified, or deferred with a written reason also listed in the README
- the prod smoke test passes: two independent orgs each add a server, deploy, back up and restore, with isolation tests green

## Sequencing note

DP1 comes before any feature so every later PR is measured. DP2 is the
schema everything reads; DP3 the shell every screen renders in. DP4 must land
before DP5–DP8 because every deploy, backup and service runs over
`SshSession`; it is also the first point the SSH-from-Cloudflare risk (DP-B) is
measured. DP6 needs DP5's deployment Workflow; DP7 and DP8 reuse DP5's
storage and env machinery. DP9 collects cross-cutting features once their
resources exist. DP10–DP12 depend on the role matrix and the operator
role. Gated on people: test VMs and the Hetzner token (DP4 onward,
`WAITING.md`), the Containers scope on `nexo` (DP4), a paid Supabase plan
(any stage verification), the reference host (DP1).
