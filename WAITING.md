# WAITING — things only a person can unblock

Each entry: what is needed, the exact steps, and the signal that it is done.
The agent re-checks every entry at the start of each loop iteration.

## W1 — Throwaway test servers for end-to-end parity (blocks DP4 onward behaviour gates)

- **Need:** one or two Ubuntu 24.04 VMs (smallest Hetzner type, e.g. CX22) in a throwaway project, each with an SSH key, labelled `e2e=true`.
- **Steps:** create the VMs; add workspace secrets in Orunbase → freeploy → Settings → Secrets (or `orun secrets set` from stdin): `TEST_SERVER_1_HOST`, `TEST_SERVER_1_USER`, `TEST_SERVER_1_SSH_KEY` (and `_2_` for a second). Never paste them in chat or a file in the repo.
- **Unblocked when:** `secrets_list` on workspace `ws_65T3WPCP` shows `TEST_SERVER_1_*`.

## W2 — Hetzner token (optional; blocks the DP11 cloud-provider feature)

- **Need:** a Read & Write API token for a dedicated throwaway Hetzner project.
- **Steps:** add it as workspace secret `TEST_HETZNER_TOKEN`.
- **Unblocked when:** `secrets_list` shows `TEST_HETZNER_TOKEN`.

## W3 — Containers + Hyperdrive scope on the `nexo` Cloudflare connection (confirm before DP4)

- **Need:** the `nexo` connection's token (Cloudflare account "Nexo@sourceplane.ai") must allow Workers, KV, D1, Hyperdrive and **Containers**. The baseline's Hyperdrive mint succeeded if phase 03 passed; Containers is first needed by DP4's `ssh-executor`.
- **Steps (only if a mint is refused with `parent_grant_insufficient`):** in the Cloudflare dashboard widen the account API token with "Workers Containers: Edit" (and "Hyperdrive: Edit"), then in Orunbase re-save it on the existing `nexo` connection. Do not create a new connection.
- **Unblocked when:** the DP4 deploy of `ssh-executor` succeeds.

## W4 — ⛔ Paid Supabase plan for the org behind `nexara-orun` (BLOCKS the bootstrap from phase 03 on)

- **Seen:** 2026-11-23, bootstrap phase `03-infrastructure`, run 45062761473 (`supabase · stage · Terraform`): `organization members have reached their maximum limits for the number of active free projects … nexara-orun (2 project limit)` — `entitlement_required`, `free_project_limit`. The `freeploy-stage` project could not be created; `freeploy-prod` would hit the same limit. Phases 04-workers, 05-edge, 06-console and 08-docs cannot land until it is created (Hyperdrive and db-migrate need it), so stage and prod are not live.
- **Need:** the Supabase organisation behind `nexara-orun` on a paid plan (Pro). A free plan is also unsuitable for this product (paused databases broke openproduct-crm's M1). Pausing or deleting the org's two existing free projects would also lift the limit, but that is the owner's call; the agent will not touch them.
- **Steps:** Supabase dashboard → organisation `nexara-orun` → Billing → upgrade to Pro. Do not reconnect or rotate the `nexara-orun` connection.
- **Unblocked when:** the person says so here (or the next resume of `orun baseline new freeploy … --resume` gets past `03-infrastructure`). The agent then re-runs the same bootstrap command, which resumes at phase 03.

## W5 — Domain `freeploy.dev`

- **Need:** the `freeploy.dev` zone on the `nexo` Cloudflare account, if the domain is to be used.
- **Steps:** register `freeploy.dev` (or move it) and add the zone to the Nexo Cloudflare account. Then the agent routes prod to `freeploy.dev` and `app.freeploy.dev`, and stage to `stage.freeploy.dev`.
- **Unblocked when:** the zone appears on the Nexo account. Until then the product uses `*.nexo-7be.workers.dev`.

## W6 — Reference host

- **Need:** none from a person for now: the reference Coolify runs on GitHub-hosted Ubuntu runners in the parity workflow, because this build machine has no Docker. If runner limits make it impractical, a small VM with Docker is needed (`REFERENCE_HOST`).
