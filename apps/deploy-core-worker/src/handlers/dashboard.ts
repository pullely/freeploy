// Derived from coollabsio/coolify@91b7e3e:routes/web.php (dashboard), app/Livewire/Dashboard.php and
// app/Livewire/Dashboard/ActiveDeployments.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/dashboard — the dashboard at / (DP-100):
//
//   GET    /dashboard               Dashboard::mount(): the projects, the servers with their status, whether a private key exists
//   GET    /dashboard/deployments   ActiveDeployments: the queued and running deployments and the latest others (polled)
//
// Coolify's route is any signed-in member's; the view's @can('createAnyResource' | 'update' | 'create', …) decide
// the actions. Here: deploy.resource.read to read and deploy.resource.write for the actions (canCreate, canUpdate);
// a denial answers 404 (never leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { withOrg, listProjectsWithCounts, listDashboardServers, orgHasPrivateKeys, listDashboardDeployments } from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import { authorizeDeploy } from "./cloud-tokens.js";
import { dashboardDeployments, showDashboard, type DashboardStore } from "../dashboard/service.js";

export const ORG_DEPLOY_DASHBOARD_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/dashboard((?:\/[^/]+){0,1})\/?$/;

export type DashboardRunner = <T>(env: Env, orgId: string, fn: (store: DashboardStore) => Promise<T>) => Promise<T>;

export function dashboardSqlStore(tx: SqlExecutor): DashboardStore {
  return {
    projects: () => listProjectsWithCounts(tx),
    servers: () => listDashboardServers(tx),
    hasPrivateKeys: () => orgHasPrivateKeys(tx),
    deployments: (active) => listDashboardDeployments(tx, active),
  };
}

export const runDashboardInOrg: DashboardRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn(dashboardSqlStore(tx)));
  } finally {
    await db.dispose();
  }
};

/** segments: what follows /dashboard, split on "/". `runner` is replaceable for tests. */
export async function handleDashboard(env: Env, requestId: string, actor: ActorContext, orgId: string, segments: string[], request: Request, runner: DashboardRunner = runDashboardInOrg): Promise<Response> {
  let run: ((store: DashboardStore) => Promise<object>) | undefined;
  if (segments.length === 0) run = (s) => showDashboard(s);
  else if (segments.length === 1 && segments[0] === "deployments") run = (s) => dashboardDeployments(s);
  if (!run) return errorResponse("not_found", "Not found", 404, requestId);
  if (request.method !== "GET") return methodNotAllowed(requestId);

  const auth = await authorizeDeploy(env, requestId, actor, orgId, false);
  if (!auth.ok) return auth.response;
  try {
    const data = await runner(env, orgId, run);
    // @can('createAnyResource'), @can('update', $project) and @can('create', PrivateKey::class): the org-wide write.
    return successResponse({ ...data, canCreate: auth.canWrite, canUpdate: auth.canWrite }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
