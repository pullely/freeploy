// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Tags/Show.php (mount, getDeployments) and app/Models/Tag.php
// (applications, services: morphedByMany 'taggable') (Apache-2.0), modified.
//
// The queries of the team's Tags page (/tags/{tagName?}, DP-97): the org's tags with how many applications and
// services carry each, a tag's applications and services with where they live, and the queued and running
// deployments of those applications. Every function takes the transaction of withOrg(): row-level security
// confines each query to that org, which is what Coolify's ownedByCurrentTeam() does.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { APPLICATION_MORPH_CLASS } from "./application-create.js";
import { SERVICE_MORPH_CLASS } from "./services.js";

export interface DeployTagCountRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  applications_count: number;
  services_count: number;
}

/**
 * Tag::ownedByCurrentTeam()->withCount(['applications', 'services'])->get(): each tag with the applications and
 * services (soft-deleted ones left out, as their SoftDeletes scope does) that carry it. Oldest first; the page sorts.
 */
export async function listTagsWithCounts(tx: SqlExecutor): Promise<DeployTagCountRow[]> {
  const r = await tx.execute<DeployTagCountRow>(
    `SELECT t.id, t.uuid, t.name,
            (SELECT count(*)::int FROM deploy.taggables p JOIN deploy.applications a ON a.id = p.taggable_id
              WHERE p.tag_id = t.id AND p.taggable_type = $1 AND a.deleted_at IS NULL) AS applications_count,
            (SELECT count(*)::int FROM deploy.taggables p JOIN deploy.services s ON s.id = p.taggable_id
              WHERE p.tag_id = t.id AND p.taggable_type = $2 AND s.deleted_at IS NULL) AS services_count
       FROM deploy.tags t ORDER BY t.id`,
    [APPLICATION_MORPH_CLASS, SERVICE_MORPH_CLASS],
  );
  return r.rows;
}

/** One resource that carries a tag, with what its card shows and links to. */
export interface DeployTaggedResourceRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  environment_uuid: string;
  environment_name: string;
  project_uuid: string;
  project_name: string;
}

const TAGGED = (table: "applications" | "services") => `SELECT r.id, r.uuid, r.name, r.description, e.uuid AS environment_uuid, e.name AS environment_name,
        p.uuid AS project_uuid, p.name AS project_name
   FROM deploy.${table} r
   JOIN deploy.environments e ON e.id = r.environment_id
   JOIN deploy.projects p ON p.id = e.project_id
  WHERE r.deleted_at IS NULL
    AND EXISTS (SELECT 1 FROM deploy.taggables x WHERE x.tag_id = $1 AND x.taggable_type = $2 AND x.taggable_id = r.id)
  ORDER BY r.id`;

/** $tag->applications()->get() */
export async function listTagApplications(tx: SqlExecutor, tagId: string | number): Promise<DeployTaggedResourceRow[]> {
  return (await tx.execute<DeployTaggedResourceRow>(TAGGED("applications"), [tagId, APPLICATION_MORPH_CLASS])).rows;
}

/** $tag->services()->get() */
export async function listTagServices(tx: SqlExecutor, tagId: string | number): Promise<DeployTaggedResourceRow[]> {
  return (await tx.execute<DeployTaggedResourceRow>(TAGGED("services"), [tagId, SERVICE_MORPH_CLASS])).rows;
}

export interface DeployActiveDeploymentRow extends SqlRow {
  id: string | number;
  application_id: string;
  application_name: string | null;
  deployment_url: string | null;
  pull_request_id: number;
  server_name: string | null;
  server_id: number | null;
  status: string;
}

/**
 * getDeployments(): ApplicationDeploymentQueue::whereIn('status', ['in_progress', 'queued'])->whereIn('application_id',
 * $ids)->get([…])->sortBy('id'). application_id is text in the queue, so the ids are compared as text.
 */
export async function listActiveDeployments(tx: SqlExecutor, applicationIds: ReadonlyArray<string | number>): Promise<DeployActiveDeploymentRow[]> {
  if (!applicationIds.length) return [];
  const r = await tx.execute<DeployActiveDeploymentRow>(
    `SELECT id, application_id, application_name, deployment_url, pull_request_id, server_name, server_id, status
       FROM deploy.application_deployment_queues
      WHERE status IN ('in_progress', 'queued') AND application_id = ANY($1::varchar[])
      ORDER BY id`,
    [applicationIds.map(String)],
  );
  return r.rows;
}
