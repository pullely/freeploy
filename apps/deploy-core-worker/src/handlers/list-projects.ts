// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ProjectController.php (Apache-2.0), modified.
// The org's Coolify projects (deploy.projects), read inside withOrg() so row-level
// security confines the read to the org, after membership + policy allow it.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { withOrg, listProjects, type DeployProjectRow } from "@saas/db/deploy";
import { fetchAuthorizationContext } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { deniedResponse, errorResponse, successResponse } from "../http.js";

export function toPublicDeployProject(row: DeployProjectRow) {
  return { uuid: row.uuid, name: row.name, description: row.description ?? null };
}

export async function handleListProjects(env: Env, requestId: string, actor: ActorContext, orgId: string): Promise<Response> {
  if (!env.PLATFORM_DB || !env.MEMBERSHIP_WORKER || !env.POLICY_WORKER) {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
  const ctx = await fetchAuthorizationContext(env.MEMBERSHIP_WORKER, actor.subjectId, actor.subjectType, orgId as never, requestId);
  if (!ctx.ok) return deniedResponse(env.ENVIRONMENT, requestId, ctx.reason);
  const policy = await authorizeViaPolicy(env.POLICY_WORKER, actor.subjectId, actor.subjectType, "deploy.resource.read", { kind: "organization", orgId: orgId as never }, ctx.memberships, requestId);
  if (!policy.allow) return deniedResponse(env.ENVIRONMENT, requestId, policy.reason ?? "denied", { memberships: ctx.memberships.length });
  const db = createSqlExecutor(env.PLATFORM_DB);
  try {
    const rows = await withOrg(db, orgId, (tx) => listProjects(tx));
    return successResponse(rows.map(toPublicDeployProject), requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  } finally {
    await db.dispose();
  }
}
