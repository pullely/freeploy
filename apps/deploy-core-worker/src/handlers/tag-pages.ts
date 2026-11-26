// Derived from coollabsio/coolify@91b7e3e:routes/web.php (tags.show), app/Livewire/Tags/Show.php,
// app/Livewire/Concerns/CreatesTags.php and app/Policies/TagPolicy.php (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/tags — the team's Tags page (DP-97):
//
//   GET    /tags                    Show::mount() without a tag: the org's tags with their counts
//   POST   /tags                    CreatesTags::createTag { newTagName }
//   GET    /tags/{name}             Show::mount() with a tag: its webhook, applications, services, active deployments
//   DELETE /tags/{name}             Show::deleteTag
//   POST   /tags/{name}/redeploy    Show::redeployAll (needs SSH when the tag has resources: 501)
//
// Coolify's policy: tags.show is team-wide (access.team-wide); create and delete are TagPolicy's. Here:
// deploy.resource.read and deploy.resource.write; a denial answers 404 (never leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { withOrg, listTagsWithCounts, listTagApplications, listTagServices, listActiveDeployments, findTagByName, insertTag, deleteTag } from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import { authorizeDeploy, readJson } from "./cloud-tokens.js";
import { createTagFromPage, deleteTagFromPage, listTagSummaries, redeployTag, showTagPage, TagPageError, type TagPagesStore } from "../tags/page.js";

export const ORG_DEPLOY_TAGS_RE = /^\/v1\/organizations\/([^/]+)\/deploy\/tags((?:\/[^/]+){0,2})\/?$/;

export type TagPagesRunner = <T>(env: Env, orgId: string, fn: (store: TagPagesStore) => Promise<T>) => Promise<T>;

export function tagPagesSqlStore(tx: SqlExecutor, orgId: string): TagPagesStore {
  return {
    tags: () => listTagsWithCounts(tx),
    applications: (tagId) => listTagApplications(tx, tagId),
    services: (tagId) => listTagServices(tx, tagId),
    deployments: (ids) => listActiveDeployments(tx, ids),
    findByName: (name) => findTagByName(tx, name),
    insert: (tag) => insertTag(tx, { orgId, ...tag }),
    delete: (id) => deleteTag(tx, id),
  };
}

export const runTagPagesInOrg: TagPagesRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn(tagPagesSqlStore(tx, orgId)));
  } finally {
    await db.dispose();
  }
};

interface Op {
  write: boolean;
  status?: number;
  run: (store: TagPagesStore, body: Record<string, unknown>) => Promise<object | null>;
}

/** segments: what follows /tags, split on "/" and decoded ([] for the list). `runner` is replaceable for tests. */
export async function handleTagPages(env: Env, requestId: string, actor: ActorContext, orgId: string, segments: string[], request: Request, runner: TagPagesRunner = runTagPagesInOrg): Promise<Response> {
  const method = request.method;
  const [name, action] = segments;
  const on = (methods: Record<string, Op>): Op | null => methods[method] ?? null;
  let op: Op | null | undefined;
  if (segments.length === 0) {
    op = on({
      GET: { write: false, run: async (s) => ({ tags: await listTagSummaries(s) }) },
      POST: { write: true, status: 201, run: (s, body) => createTagFromPage(s, body) },
    });
  } else if (segments.length === 1 && name) {
    op = on({ GET: { write: false, run: (s) => showTagPage(s, name) }, DELETE: { write: true, run: (s) => deleteTagFromPage(s, name) } });
  } else if (segments.length === 2 && name && action === "redeploy") {
    op = on({ POST: { write: true, run: (s) => redeployTag(s, name) } });
  }
  if (op === undefined) return errorResponse("not_found", "Not found", 404, requestId);
  if (op === null) return methodNotAllowed(requestId);

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  const run = op.run;
  try {
    const body = method === "POST" ? await readJson(request) : {};
    const data = await runner(env, orgId, (s) => run(s, body));
    if (!data) return errorResponse("not_found", "Not found", 404, requestId);
    // @can('create', Tag::class) and @can('delete', $tag)
    return successResponse(op.write ? data : { ...data, canCreate: auth.canWrite, canDelete: auth.canWrite }, requestId, op.status ?? 200);
  } catch (e) {
    if (e instanceof TagPageError) return errorResponse(e.status === 501 ? "unsupported" : "validation_failed", e.message, e.status, requestId, e.fields ? { fields: e.fields } : undefined);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
