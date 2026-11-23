// deploy-core-worker: the deploy bounded context (freeploy-coolify-parity DP2).
// Never public: api-edge forwards /v1/organizations/{org}/deploy/* here after
// resolving the actor. Every database access goes through withOrg()
// (@saas/db/deploy), which confines the transaction to one org with
// Postgres row-level security.
import type { Env } from "./env.js";
import { route } from "./router.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },
} satisfies ExportedHandler<Env>;
