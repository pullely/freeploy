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

## W3 — Containers scope on the `nexo` Cloudflare connection (BLOCKS DP4's executor)

- **Tested 2026-11-24 (DP-31, #39):** the first Container deploy (`deploy-core-worker` on stage, the `SshSession` Durable Object with `apps/ssh-executor`'s image) failed: Wrangler's request to the Cloudflare API `/accounts/{id}/containers/me` was refused on all three attempts. The image built; the account or token cannot use Containers.
- **Need:** Cloudflare Containers on the account behind `nexo`: the **Workers Paid** plan (Containers are not on the free plan), and the account API token with **"Workers Containers: Edit"** (plus "Workers Scripts: Edit" it already has).
- **Steps:** in the Cloudflare dashboard, confirm the account is on Workers Paid; widen the account API token with "Workers Containers: Edit"; in Orunbase re-save it on the **existing** `nexo` connection. Do not create a new connection.
- **Meanwhile:** the stage `containers` entry and `SSH_SESSION` binding are held back (DP-31 follow-up), so deploys are green; the executor, its client and the Durable Object class are in place and tested.
- **Unblocked when:** the agent restores the two entries and the stage deploy of `deploy-core-worker` succeeds.

## W4 — ✅ Supabase project slots for `nexara-orun` (resolved 2026-11-23; a risk remains)

- **Was:** bootstrap phase `03-infrastructure` could not create `freeploy-stage`: the org was at its free-plan limit of 2 active projects.
- **Resolved by:** the owner paused stale projects in the org, which freed two slots. The failed `supabase · stage` job of run 45062761473 was re-run and created the project; the bootstrap then finished (PRs #8–#12).
- **Still open:** the org remains on the **free plan**. Free projects pause after inactivity and can become unreachable (risks DP-H). Upgrading the org to Pro removes that risk; until then a paused stage or prod database blocks deploy verification only, never code.

## W5 — Domain (`freeploy.io`) and email

- **Domain — resolved (DP-120):** the owner added `freeploy.io` to the Cloudflare account (delegated to `curt`/`jule.ns.cloudflare.com`). `infra/terraform/cloudflare-domain` adopts the zone and attaches the Freeploy console (deploy-web) and the API (api-edge): prod `app.freeploy.io` and `api.freeploy.io`, stage `stage.freeploy.io` and `api-stage.freeploy.io`. The `*.nexo-7be.workers.dev` hostnames keep serving alongside.
- **Still open — email:** the notifications worker sends from `no-reply@mail.freeploy.io`, and Cloudflare Email Service needs that sending domain verified (DKIM/SPF on `mail.freeploy.io`). Until it is, stage and prod deliver no email: no password-reset links, no verification links, no email-change codes. Account verification is therefore not enforced yet (`REQUIRE_EMAIL_VERIFICATION=false` on identity-worker); once mail is delivered, the agent sets it to `true` for Coolify Cloud's behaviour.
- **Needs from a person:** verify `mail.freeploy.io` in Cloudflare Email Service.

## W6 — Reference host

- **Need:** none from a person for now: the reference Coolify runs on GitHub-hosted Ubuntu runners in the parity workflow, because this build machine has no Docker. If runner limits make it impractical, a small VM with Docker is needed (`REFERENCE_HOST`).
