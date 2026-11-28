# cloudflare-domain

Adopts the freeploy.io Cloudflare zone and attaches the Freeploy console (deploy-web) and API (api-edge) custom domains to each environment's Workers: prod `app.freeploy.io` / `api.freeploy.io`, stage `stage.freeploy.io` / `api-stage.freeploy.io`.

Manages DNS records and Worker routes/custom domains on the product zone for freeploy, per environment (`stage`, `prod`; `dev` is
verify-only and provisions nothing).

## Depends on

- **deploy-web** — the Freeploy console (`freeploy-deploy-web-<env>`), attached as `CONSOLE_CUSTOM_DOMAIN`
- **api-edge** — the public API (`freeploy-api-edge-<env>`), attached as `API_CUSTOM_DOMAIN`

## Depended on by

- (none)
