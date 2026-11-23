# cloudflare-domain

Manages the Cloudflare zone and attaches custom domains to environment-specific Worker services (web-console-next)

Manages DNS records and Worker routes/custom domains on the product zone for freeploy, per environment (`stage`, `prod`; `dev` is
verify-only and provisions nothing).

## Depends on

- **web-console-next** — Next.js 15 + opennextjs/cloudflare delivery of the Freeploy web console (per-environment, Workers + Static Assets)

## Depended on by

- (none)
