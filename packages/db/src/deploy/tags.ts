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

/** clone_application(): `foreach ($source->tags as $tag) $new->tags()->attach($tag->id)`. */
export async function copyResourceTags(tx: SqlExecutor, from: Taggable, to: Taggable): Promise<void> {
  await tx.execute(
    `INSERT INTO deploy.taggables (tag_id, taggable_type, taggable_id, org_id)
     SELECT p.tag_id, $3::varchar, $4::bigint, p.org_id FROM deploy.taggables p WHERE p.taggable_type = $1 AND p.taggable_id = $2`,
    [from.type, from.id, to.type, to.id],
  );
}
