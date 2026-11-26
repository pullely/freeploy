// Derived from coollabsio/coolify@91b7e3e:app/Models/Tag.php, the `tags` morphToMany relation of
// app/Models/{Application,Service}.php and the standalone databases, and
// app/Livewire/Project/Shared/Tags.php (the queries) (Apache-2.0), modified.
//
// deploy.tags and the deploy.taggables pivot. A tag belongs to the org
// (Coolify: the team); what it is attached to is a morph (taggable_type,
// taggable_id), so every function that touches the pivot takes the resource's
// morph class and other resource kinds reuse them. Every function takes the
// transaction of withOrg(): row-level security confines each query to that
// org, which is what Coolify's where('team_id', …) does.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

export interface DeployTagRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
}

/** What a tag is attached to: the resource's morph class and id. */
export interface Taggable {
  type: string;
  id: string | number;
}

/** Tag::query()->where('team_id', …)->orderBy('name') */
export async function listTags(tx: SqlExecutor): Promise<DeployTagRow[]> {
  const r = await tx.execute<DeployTagRow>("SELECT id, uuid, name FROM deploy.tags ORDER BY name, id");
  return r.rows;
}

/** $resource->tags: the pivot has no order of its own, so the tags come oldest first. */
export async function listResourceTags(tx: SqlExecutor, resource: Taggable): Promise<DeployTagRow[]> {
  const r = await tx.execute<DeployTagRow>(
    `SELECT t.id, t.uuid, t.name FROM deploy.tags t
      WHERE EXISTS (SELECT 1 FROM deploy.taggables p WHERE p.tag_id = t.id AND p.taggable_type = $1 AND p.taggable_id = $2)
      ORDER BY t.id`,
    [resource.type, resource.id],
  );
  return r.rows;
}

/** resourceTags()->where('name', $name)->first() */
export async function findTagByName(tx: SqlExecutor, name: string): Promise<DeployTagRow | null> {
  const r = await tx.execute<DeployTagRow>("SELECT id, uuid, name FROM deploy.tags WHERE name = $1 ORDER BY id LIMIT 1", [name]);
  return r.rows[0] ?? null;
}

/** resourceTags()->find($id) */
export async function findTagById(tx: SqlExecutor, id: string | number): Promise<DeployTagRow | null> {
  const r = await tx.execute<DeployTagRow>("SELECT id, uuid, name FROM deploy.tags WHERE id = $1", [id]);
  return r.rows[0] ?? null;
}

/** Tag::create(['name' => …, 'team_id' => …]); the name as the model's mutator stores it. */
export async function insertTag(tx: SqlExecutor, tag: { orgId: string; uuid: string; name: string }): Promise<DeployTagRow> {
  const r = await tx.execute<DeployTagRow>(
    `INSERT INTO deploy.tags (uuid, name, org_id, created_at, updated_at) VALUES ($1, $2, $3, ${NOW}, ${NOW}) RETURNING id, uuid, name`,
    [tag.uuid, tag.name, tag.orgId],
  );
  return r.rows[0]!;
}

/** $resource->tags()->whereKey($id)->exists() */
export async function resourceHasTag(tx: SqlExecutor, resource: Taggable, tagId: string | number): Promise<boolean> {
  const r = await tx.execute("SELECT 1 FROM deploy.taggables WHERE tag_id = $1 AND taggable_type = $2 AND taggable_id = $3 LIMIT 1", [tagId, resource.type, resource.id]);
  return r.rows.length > 0;
}

/** $resource->tags()->attach($id) */
export async function attachTag(tx: SqlExecutor, orgId: string, resource: Taggable, tagId: string | number): Promise<void> {
  await tx.execute("INSERT INTO deploy.taggables (tag_id, taggable_type, taggable_id, org_id) VALUES ($1, $2, $3, $4)", [tagId, resource.type, resource.id, orgId]);
}

/** $resource->tags()->detach($id): the tag itself stays. True when it was attached. */
export async function detachTag(tx: SqlExecutor, resource: Taggable, tagId: string | number): Promise<boolean> {
  const r = await tx.execute("DELETE FROM deploy.taggables WHERE tag_id = $1 AND taggable_type = $2 AND taggable_id = $3 RETURNING tag_id", [tagId, resource.type, resource.id]);
  return r.rows.length > 0;
}

/** $resource->tags()->detach(): every tag of the resource. */
export async function detachAllTags(tx: SqlExecutor, resource: Taggable): Promise<void> {
  await tx.execute("DELETE FROM deploy.taggables WHERE taggable_type = $1 AND taggable_id = $2", [resource.type, resource.id]);
}

// ── DP-81: what Coolify's /api/v1 reads and writes of tags (TagsController, HandlesTagsApi) ──

/** A tag with its timestamps (TIMESTAMP(0) as text, "YYYY-MM-DD HH:MM:SS"), as TagsController::serializeTag() writes it. */
export interface DeployTagApiRow extends DeployTagRow {
  created_at: string | null;
  updated_at: string | null;
}

const API_COLUMNS = "t.id, t.uuid, t.name, t.created_at::text AS created_at, t.updated_at::text AS updated_at";

/** Tag::where('team_id', …)->orderBy('name')->get() */
export async function listTagsWithDates(tx: SqlExecutor): Promise<DeployTagApiRow[]> {
  const r = await tx.execute<DeployTagApiRow>(`SELECT ${API_COLUMNS} FROM deploy.tags t ORDER BY t.name, t.id`);
  return r.rows;
}

/** Tag::where('team_id', …)->where('uuid', $uuid)->first() */
export async function findTagByUuid(tx: SqlExecutor, uuid: string): Promise<DeployTagApiRow | null> {
  const r = await tx.execute<DeployTagApiRow>(`SELECT ${API_COLUMNS} FROM deploy.tags t WHERE t.uuid = $1 ORDER BY t.id LIMIT 1`, [uuid]);
  return r.rows[0] ?? null;
}

/**
 * $resource->tags as Coolify's API reads it: the morphToMany query has no ORDER BY, and PostgreSQL gives the rows in the
 * order it scans the pivot — the order the tags were attached in — so this orders by the pivot rows' place (ctid).
 */
export async function listResourceTagsInPivotOrder(tx: SqlExecutor, resource: Taggable): Promise<DeployTagApiRow[]> {
  const r = await tx.execute<DeployTagApiRow>(
    `SELECT ${API_COLUMNS} FROM deploy.taggables p JOIN deploy.tags t ON t.id = p.tag_id
      WHERE p.taggable_type = $1 AND p.taggable_id = $2
      ORDER BY p.ctid`,
    [resource.type, resource.id],
  );
  return r.rows;
}

/** $tag->update(['name' => …]): updated_at is touched only when the name changes (Eloquent saves nothing otherwise). */
export async function renameTag(tx: SqlExecutor, id: string | number, name: string): Promise<void> {
  await tx.execute(`UPDATE deploy.tags SET name = $2, updated_at = ${NOW} WHERE id = $1 AND name IS DISTINCT FROM $2`, [id, name]);
}

/** $tag->delete(): Coolify's foreign key cascades to the pivot; deploy.taggables has none, so its rows go first. */
export async function deleteTag(tx: SqlExecutor, id: string | number): Promise<void> {
  await tx.execute("DELETE FROM deploy.taggables WHERE tag_id = $1", [id]);
  await tx.execute("DELETE FROM deploy.tags WHERE id = $1", [id]);
}

/** clone_application(): `foreach ($source->tags as $tag) $new->tags()->attach($tag->id)`. */
export async function copyResourceTags(tx: SqlExecutor, from: Taggable, to: Taggable): Promise<void> {
  await tx.execute(
    `INSERT INTO deploy.taggables (tag_id, taggable_type, taggable_id, org_id)
     SELECT p.tag_id, $3::varchar, $4::bigint, p.org_id FROM deploy.taggables p WHERE p.taggable_type = $1 AND p.taggable_id = $2`,
    [from.type, from.id, to.type, to.id],
  );
}
