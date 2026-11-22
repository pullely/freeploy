# freeploy-coolify-parity — risks and open questions

Each entry is a letter, a title, and a state: **RISK** (open, with a
mitigation), **RESOLVED** (decided; say what and why), **ACCEPTED** (a cost we
carry knowingly), **SETTLED** (decided for now; revisit on a stated cadence).

## DP-A — Scale of the port (RISK, mitigated)

Coolify at `91b7e3e` has 291 Livewire classes, 84 jobs, 110 actions, 531
migration files (88 final tables), 290 web routes, 349 API routes, 390
service templates and ~9,300 UI strings (`parity/README.md`). A port this size
can drift into unverified breadth. Mitigation: milestones split into many
small tasks, one PR each; the inventory is generated and every row has a
parity test; the report is regenerated on every merge and counts only
`verified` rows; we prefer verified depth over unverified breadth.

## DP-B — SSH from Cloudflare (RISK)

Cloudflare Containers may impose cold starts, outbound TCP limits and session
lifetimes that hurt long deployments and terminals. Measured early in DP4
(connect latency, a 30-minute build stream, an idle terminal). If Containers
cannot sustain it, `ssh-executor` runs on a small always-on VM pool behind the
same `SshSession` interface; the decision is recorded here and in
`IMPLEMENTATION-STATUS.md`. The `nexo` token needs the Containers scope
(`WAITING.md` if it lacks it).

## DP-C — Concentrated SSH-key risk (RISK, mitigated)

Holding many orgs' private keys concentrates risk. Mitigations: per-org
envelope encryption; decryption only inside the executor, per request; keys
never logged; per-server rate limits; every command audited; rotation tooling
ported from `RotatePrivateKeyJob`; a written incident plan in `SECURITY.md`.

## DP-D — "Exact UI" in React (RISK)

Livewire morphing, `wire:poll`, `wire:confirm` and Alpine behaviours must be
reproduced deliberately. Where an interaction cannot be pixel-identical (for
example browser-native widgets), it is documented as a deviation with a
screenshot in `IMPLEMENTATION-STATUS.md`, never hidden with a mask.

## DP-E — Licence and provenance of runtime images (RISK)

`coolify-helper`, Sentinel and the realtime image must be confirmed for
licence and provenance before reuse. If any cannot be reused, it is built from
the same Dockerfiles and source with attribution.

## DP-F — Brand (RESOLVED)

No "Coolify" in the product name, logo, domain, page titles, repository name
or description. "Coolify" appears only in descriptive sentences ("a
multi-tenant port of Coolify (Apache-2.0), not affiliated with coollabs.io"),
the attribution and the notices. Brand strings in `parity/strings.json` are
flagged (`brand: true`) and replaced with Freeploy; the DOM/copy check
normalises them. The `/data/coolify` server paths and the `coolify-helper`
image name are not user-visible brand and stay, because renaming them would
change every generated command.

## DP-G — Hosted competition with Coolify Cloud (ACCEPTED)

Freeploy competes with Coolify Cloud. We carry that knowingly under the
Apache-2.0 licence and keep attribution exemplary; fixes found during the port
are offered upstream.

## DP-H — Free-plan databases (RISK)

A free Supabase plan can pause or become unreachable (it broke
openproduct-crm's M1). The org behind `nexara-orun` must be on a paid plan;
until confirmed, code is tested against local Postgres and only stage
verification is parked.

## DP-I — Every table gets `org_id` (RESOLVED)

Coolify scopes only 28 of 88 tables by `team_id`; the rest inherit scope
through a parent. Decision: every `deploy` table gets a non-null `org_id`,
denormalised and maintained by the ported write paths, so isolation can be
enforced and tested per table without trusting a join. Cost: a column and an
index per table; worth it because tenancy is the security boundary.

## DP-J — Tables Lumen already owns (RESOLVED)

`teams`, `users`, `team_user`, `team_invitations`, `sessions`,
`password_reset_tokens`, `personal_access_tokens`, `subscriptions`,
`audit_events`, `passkeys` and `oauth_identities` map onto Lumen's identity,
membership, billing and events instead of being duplicated. A `deploy.teams`
view keeps Coolify's team shape for ported queries.

## DP-K — Reference host without Docker locally (SETTLED)

The build machine has no Docker. The reference Coolify runs on GitHub-hosted
Ubuntu runners (Docker preinstalled) in the parity workflow. Revisit if
runner minutes or flakiness make it impractical.

## DP-L — Upstream drift (SETTLED)

`COOLIFY_REF` is pinned at `91b7e3e` and moves only in its own task and PR,
which regenerates the inventory, lists new or changed rows and mints a new
milestone for them. Revisit after DP13.
