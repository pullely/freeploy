# policy-worker — runbook

## How it deploys

Merges to `main` converge automatically: CI plans changed components
(`orun plan --changed`) and runs this component's lane via
`orun run --remote-state` with credential-free OIDC auth. The convergence
run is the deployment; the DAG orders this component after everything it
depends on. Failed lanes resume with `gh run rerun --failed`.

## Rollback

Revert the offending commit on `main`; the next convergence applies the
previous desired state. There is no out-of-band mutation to undo — the
repo is the source of truth.

## Verify

The deploy lane's own verify/smoke is the gate. End-to-end behavior is
exercised through `api-edge` (this Worker has no public URL).

## Common failures

- **Missing `WIRING_*` / `SUPABASE_*` secret at deploy**: the
  infrastructure terraform upstream has not applied — check that lane
  first; within one convergence run the DAG guarantees order.
- **Service-binding target missing (Cloudflare 10143)**: the target
  Worker does not exist yet on this account. Every binding holder waits on
  `policy-worker`, whose pre-deploy uploads a placeholder for each missing
  target (`tooling/deploy/fleet-stubs.mjs`), so this should not happen — if
  it does, this component does not declare `dependsOn: policy-worker` with
  `mode: enforced`.
- **Smoke fails right after a first deploy**: a brand-new workers.dev
  route can 4xx for a few seconds; the lane already retries — persistent
  failure means a real regression.
- **A worker's authorized routes all answer 404 (deny) for an owner**: the
  deployed policy-worker predates the action it is asked about. `orun plan
  --changed` does not yet redeploy a dependent when only a `dependsOn`
  package changed, so a change to `packages/policy-engine` alone leaves this
  Worker on its old copy (Freeploy DP-38: `deploy.resource.*`, added in #18,
  was denied on stage and prod). Land any change under `apps/policy-worker`
  to redeploy it. Also check the action is in `ALL_KNOWN_ACTIONS` as well as
  in a role's grants: a missing one is denied as `unknown_action` before any
  role is consulted (DP-40).
