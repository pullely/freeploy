# deploy-web — architecture

Static SPA (`dist/`) served by a minimal Worker (`worker/index.ts`) with SPA fallback. API calls go to api-edge (`/v1/organizations/{org}/deploy/*`, `/api/v1/*`).
