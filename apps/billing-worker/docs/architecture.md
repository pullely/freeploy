# billing-worker — architecture

A `cloudflare-worker-turbo` component: TypeScript Worker built by the turbo pipeline
from `apps/billing-worker`, deployed per environment by its CI lane.

## Bindings and wiring

- **Service bindings** → `policy-worker` —
  in-process RPC to sibling Workers; no public hops between contexts.
- **Wired configuration** (resolved at deploy time from job-output
  secrets published by the infrastructure terraform; names only):
  `WIRING_CLOUDFLARE_HYPERDRIVE_PROD`, `WIRING_CLOUDFLARE_HYPERDRIVE_STAGE`.

## Boundaries

This Worker owns its bounded context: its data, its invariants, its
API surface (exposed to the fleet through the edge). Cross-context calls
go over service bindings; nothing else may reach into its storage.

## The console's subscription pages (DP-82)

The deploy console's `/subscription` and `/subscription/new` (Coolify's
Subscription pages) read `GET …/billing/summary` and `GET …/billing/plans`, and
call `POST …/billing/checkout`, `…/billing/portal` and
`…/billing/subscription/cancel` through api-edge's billing facade. The summary
also answers `selfServe`: whether the environment's provider is configured
(`BILLING_PROVIDER` resolves to an adapter — Polar with its access token and
webhook secret set) and which plans it sells (the `POLAR_PRODUCT_MAP` codes of
priced, recurring catalog plans), read from env only (`src/self-serve.ts`), so
the pages say "not available yet" rather than offer a checkout that would 503.
No secret or provider product id is in it.
