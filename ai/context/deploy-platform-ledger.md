# Deploy-platform ledger — Freeploy (DP)

Read this first on every resume. Then the notes file
(`~/openproduct/freeploy-factory-notes.md` on the build machine), `task_get
freeploy-coolify-parity`, `specs/epics/freeploy-coolify-parity/IMPLEMENTATION-STATUS.md`,
the parity JSON and `gh pr list --state all`.

## Report (software-factory §8)

_Written when the epic closes; until then see "Where it stands"._

## Inputs actually used

| Input | Value |
|---|---|
| Account | openproduct — `openproduct-sms84q22`, `ws_SMS84Q22` |
| Workspace | Freeploy / `freeploy` / `ws_65T3WPCP` (`org_a7250d2aa373479f8adcfe77eb71f793`) |
| Cloudflare connection | `nexo` — `int_4612193bc8e24fda84fe076f518e8f89` ("Nexo@sourceplane.ai's Account"), inherited from the account |
| Supabase connection | `nexara-orun` — `int_8fdfe03cfe4348b5b65aefe535c4b80e`, inherited |
| GitHub connection | `int_790b2b93a1884aadbf11f46288648eb5` — `pullely` (a user account) |
| workers.dev subdomain | `nexo-7be` (see Decisions, 2026-11-23) |
| Repository | <https://github.com/pullely/freeploy> (public) |
| Baseline | `sourceplane/freeploy@baseline-v33` |
| `COOLIFY_REF` | `91b7e3e509dee1eb5cee7c41fe151be03b03092e` (2026-11-20) |
| Epic | `freeploy-coolify-parity`, cluster DP, milestones DP0–DP13 |

## Skill revisions run under

| Skill | rev |
|---|---|
| software-factory | `sha256:ac5be0858451337cddf64fe65be336be119dd17a5d11aff776c918b73af1dc35` |
| orunbase | `sha256:fe17c72a27677ad7935fb59f4e74076038d5bf6f95639eebcbaf175087f32404` |
| orun-cli | `sha256:8c475ab27e312b0f7bf78453bab1ee64d9c8f77d033a3c9986a654b85ec229d9` |
| planning | `sha256:6caf76f6fc7099f355761e45d23afcaf59ccc7b8458af81def0b4d95f49c0f63` |
| design-authoring | `sha256:e6ed5ba1b93ec7d9f2900fcae69b7e7b54db92094f4f1a60f746f38c1c3ed975` |
| initiative-lifecycle | `sha256:9ed675c8927140e4aee5f64cc21521cf1889af9d45b86b89dee68d92b3a13085` |
| milestone-loop | `sha256:8a814c285a9f30d0a4d2c91521ac513aed0f532ff18bdc3fb4e30ccf840c2293` |
| task-branch-pr | `sha256:83c7d906a21d7919290364e9e5fa429b84947cab4f70c7083f456c80f1f6ebfd` |
| pr-provenance | `sha256:ea0af746b15ef259878c1573ea57faf427f160a43f7cfcbf94516a434f682b43` |
| mcp-tools | `sha256:d070d616a00b1fe03e17062e1daf4c95d05509090b2b563f9a511f268938e73a` |

## Decisions

- **2026-11-23 — milestone table pre-approved** by the user in the prompt; the software-factory §2 stop was not taken.
- **2026-11-23 — subdomain `nexo-7be`.** The connection API carries no workersSubdomain for a hand-run build; taken from the 2026-09-22 Nexo build on the same Cloudflare account. Confirmed: `/health` answers 200 on stage and prod.
- **2026-11-23 — connections bound explicitly** with `ORUN_CONNECTIONS` because the workspace inherits three Cloudflare and two Supabase connections.
- **2026-11-23 — every `deploy` table gets `org_id`** (risks DP-I).
- **2026-11-23 — Supabase stays on the free plan for now**: the owner freed two slots instead of upgrading (risks DP-H).
- **2026-11-23 — reference Coolify runs on GitHub-hosted runners** (no Docker on the build machine; risks DP-K).

## Deviations from exact parity

None yet. Each deviation gets a screenshot and a line here.

## Open risks and deferred items

See `specs/epics/freeploy-coolify-parity/risks-and-open-questions.md` and `WAITING.md`.

## Live

| | URL |
|---|---|
| edge API, stage | https://freeploy-api-edge-stage.nexo-7be.workers.dev/health |
| edge API, prod | https://freeploy-api-edge-prod.nexo-7be.workers.dev/health |
| console, stage | https://freeploy-web-console-next-stage.nexo-7be.workers.dev |
| console, prod | https://freeploy-web-console-next-prod.nexo-7be.workers.dev |

Bootstrap: lumen baseline-v33, phases landed as #1–#3 and #8–#12; repo gate 44 components × 3 envs → 92 jobs. Generated manifest: `ai/context/deployment.md`.

## Landed (epic EP-6)

| Task | Milestone | PR |
|---|---|---|
| DP-1 the spec | DP0 | #4 |
| DP-2 public repo | DP0 | #5 |
| DP-3 parity harness: reference + visual/DOM | DP1 | #6 |
| DP-4 API contract | DP1 | #7 |

## Where it stands

- Status file: `specs/epics/freeploy-coolify-parity/IMPLEMENTATION-STATUS.md`
- Parity report: `specs/epics/freeploy-coolify-parity/parity/README.md`
