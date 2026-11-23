# freeploy-coolify-parity (DP) — Implementation status

As-built ≠ intent. This file records what actually shipped, and every place
the code departed from `design.md`.

| Milestone | State | PR |
|---|---|---|
| DP0 — the spec | ✅ Done 2026-11-23 | DP-1 [#4](https://github.com/pullely/freeploy/pull/4) (merge `48fa9ca`) · DP-2 (this PR) |
| DP1 — parity harness | In progress | DP-3 [#6](https://github.com/pullely/freeploy/pull/6) · DP-4 [#7](https://github.com/pullely/freeploy/pull/7) · DP-6 [#14](https://github.com/pullely/freeploy/pull/14) · DP-7 [#15](https://github.com/pullely/freeploy/pull/15) |
| DP2 — data model | | |
| DP3 — UI shell | | |
| DP4 — servers over SSH | | |
| DP5 — applications | | |
| DP6 — sources and previews | | |
| DP7 — databases | | |
| DP8 — services | | |
| DP9 — platform features | | |
| DP10 — teams and governance | | |
| DP11 — advanced | | |
| DP12 — platform admin | | |
| DP13 — prod, docs, certification | | |

## Notes on DP0

- The epic (EP-6, `epc_78NC4FJK`), its 14 milestones and tasks DP-1/DP-2 were minted with `orun task epic|milestone|task create` because the Orunbase MCP connector in the build session was read-only; the result is the same records `epic_create`/`milestone_create`/`task_create` make.
- No `orun/compliance` check reported on #4 (only `plan`); the lineage (branch, trailer, manifest) was written regardless and `task_get DP-1` folded to `done` from the merge.
- The Lumen bootstrap was parked at `03-infrastructure` by the Supabase free-plan project limit (WAITING.md W4). It resumed on 2026-11-23 after the owner freed two slots and finished: phases 03-database → 08-docs landed as #8–#12. Stage and prod are live on `*.nexo-7be.workers.dev` (`/health` 200, database reachable; see `ai/context/deployment.md`). The org is still on the free plan (risks DP-H).

## Notes on DP1

- **Reference build environment (DP-3).** nginx.org's apk signing-key URL, which Coolify's `docker/production/Dockerfile` fetches at build time, answered 404 on 2026-11-23 (upstream `main` has the same line). `tools/parity/reference/up.sh` uses upstream's URL when it answers and otherwise a vendored copy of the same key, checked by sha256 (`ff7cf138…`, byte-identical across archived copies 2019 → 2026-10), with a warning in the run. The Coolify application code and image contents are otherwise exactly `91b7e3e`.
- **Visual job runner** is pinned to `ubuntu-24.04`: `ubuntu-latest` is 26.04, for which Playwright 1.56 ships no Chromium.
- **Reference runs.** The first runs looked green but 96 of 100 "captures" were `/onboarding`: a fresh root team has `show_boarding` on and every page redirects there. The seed now skips onboarding (as "Skip setup" does), and capture records any route that lands somewhere else as `redirected`, never as captured. With that: 7/7 fixtures seeded through `/api/v1`; 91 of 188 visual routes captured at desktop and mobile × light and dark; 88 wait for fixtures (applications, services, databases, backups, sources …) that later DP1 tasks and the feature milestones add; 9 redirect by design (e.g. `/subscription` on a self-hosted instance, `/tags` → `/canvas/tags`). At the time, stage was not deployed; it now is (Lumen console only — the `deploy-web` surface lands in DP3), so no route can pass until DP3.
- **Reference API limits (DP-4).** The contract run sets two operator settings on the reference: `API_RATE_LIMIT=100000` and `API_FAILED_REQUEST_RATE_LIMIT=0`. With the defaults, 299 of 330 unauthenticated checks came back 429: the run was measuring Coolify's rate limiter, not its API. Both limiters are Coolify behaviour that Freeploy must reproduce. They get their own parity scenarios in DP9 (`api.rate-limit`, `api.failed-request-throttle`), measured with the limits on. The runner also retries a 429 honouring `Retry-After`, and fails the run if any answer is still 429.
- **Command goldens (DP-6).** 43 cases over pure `bootstrap/helpers` functions, emitted by Coolify itself in the reference container (run 45107418510) and committed as `tools/parity/commands/goldens.json`. Every run re-emits them and fails on any difference. No helper is ported yet, so all 43 are `pending`.
- **Fixtures (DP-7).** The application, scheduled task, PostgreSQL, Redis, backup schedule, S3 storage, one-click service, cloud-init script, GitHub App and GitLab App fixtures are now created through `/api/v1`, with nothing deployed. Visual routes captured: 169 of 188 (was 91). API reads needing a fixture: 19 (was 52). The 19 routes still waiting need a deployment (DP5), a cloud-provider token (DP11), a Gitea app (no create endpoint), or redirect by design. The id mask now requires letters and digits, after a long word of copy (`excludedcontenttypes`) was found masked; IPv4 addresses are masked as they change per runner. Known limitation: ids embedded inside longer text (Traefik label lines, sslip domains) still differ per run. DP5 makes fixture ids deterministic where the API allows, or masks those spans explicitly.
- The parity report is published as a workflow artefact and job summary on every run rather than committed back to `main` by CI (branch protection requires a PR for every change). `parity/README.md` is regenerated by `inventory.ts` in the PRs that change rows.

## Departures from the design

- **No sponsorship popup.** Coolify shows a monthly "Love Coolify? Support our work" popup (`livewire/layout-popups`, instance setting `is_sponsorship_popup_enabled`). Freeploy does not: it asks users to sponsor coollabs.io, which would imply affiliation. The setting exists as a platform-admin setting defaulting to off, and the reference turns it off before capture so screens compare like with like.
