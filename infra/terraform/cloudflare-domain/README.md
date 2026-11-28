# cloudflare-domain

Adopts the `freeploy.io` Cloudflare zone and attaches Workers Custom Domains
to each environment's Freeploy console (deploy-web) and API (api-edge) — the
same shape as orun-cloud's `infra/terraform/cloudflare-domain`.

| Environment | Console (deploy-web) | API (api-edge) |
|---|---|---|
| prod | `app.freeploy.io` → `freeploy-deploy-web-prod` | `api.freeploy.io` → `freeploy-api-edge-prod` |
| stage | `stage.freeploy.io` → `freeploy-deploy-web-stage` | `api-stage.freeploy.io` → `freeploy-api-edge-stage` |
| dev | — (verify-only) | — |

The `*.nexo-7be.workers.dev` hostnames keep serving alongside the custom
domains. The console finds the API from its own host
(`apps/deploy-web/src/lib/api.ts` `edgeBase()`: `app.` → `api.`,
`stage.` → `api-stage.`).

## Parameters

| Parameter | Where | Description |
|---|---|---|
| `baseDomain` | `component.yaml` | The zone, `freeploy.io` |
| `zoneMode` | `component.yaml` | `existing` adopts the zone (the default; it is in the account) or `managed` creates it |
| `workerNamePrefix` | `component.yaml` | `freeploy-deploy-web`; the Worker is `{prefix}-{environment}` |
| `apiWorkerNamePrefix` | `component.yaml` | `freeploy-api-edge`; the Worker is `{prefix}-{environment}` |
| `CONSOLE_CUSTOM_DOMAIN` | `intent.yaml` `environments.<env>.parameterDefaults.terraform` | The console hostname; empty attaches nothing |
| `API_CUSTOM_DOMAIN` | `intent.yaml` `environments.<env>.parameterDefaults.terraform` | The API hostname; empty attaches nothing |

`CONSOLE_CUSTOM_DOMAIN` and `API_CUSTOM_DOMAIN` are deliberately not declared
in `component.yaml`: a component default would shadow the per-environment
value and render an empty `TF_VAR_*` everywhere.

The Cloudflare provider authenticates with the brokered
`CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`) from `secretEnv`, as
`cloudflare-kv` and `cloudflare-hyperdrive` do. State lives on the platform
(`backend "http"`).

## Resources

| Resource | Description |
|---|---|
| `data.cloudflare_zone.existing` | Looks up the zone (`zoneMode: existing`) |
| `cloudflare_zone.managed` | Creates the zone (`zoneMode: managed`) |
| `cloudflare_workers_domain.console` | Attaches `CONSOLE_CUSTOM_DOMAIN` to `freeploy-deploy-web-<env>` |
| `cloudflare_workers_domain.api` | Attaches `API_CUSTOM_DOMAIN` to `freeploy-api-edge-<env>` |

A Workers custom domain provisions its own DNS record and certificate. The
provider is pinned at `cloudflare ~> 4.52`; when it moves to v5, rename the
resources to `cloudflare_workers_custom_domain` with a state move.

## Lifecycle

Pull requests plan (`plan-only`); a merge to `main` applies, after deploy-web
and api-edge have deployed in the environment.

## Post-merge verification

1. The `cloudflare-domain · stage` and `· prod` apply jobs succeed.
2. `https://stage.freeploy.io/` and `https://app.freeploy.io/` serve the
   Freeploy console; `https://api-stage.freeploy.io/health` and
   `https://api.freeploy.io/health` answer api-edge.
3. Certificates are issued (automatic for Workers custom domains).

## Outputs

`zone_id`, `zone_name`, `zone_status`, `console_custom_domain`,
`worker_name`, `worker_custom_domain_id`, `api_custom_domain`,
`api_worker_name`, `api_worker_custom_domain_id`.
