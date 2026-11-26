// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/TagsController.php (serializeTag, normalizeTagName,
// validateTagWriteRequest, tags, create, update, delete), app/Http/Controllers/Api/Concerns/HandlesTagsApi.php
// (listTags, createTag, deleteTag, attachTagsToResource, normalizeTagNames), the findTaggableResource() and
// tagResourceNotFoundMessage() of app/Http/Controllers/Api/{Applications,Databases,Services}Controller.php and
// app/Models/Tag.php (Apache-2.0), modified.
//
// Coolify's /api/v1 for the team's tags and for the tags of an application, a standalone database and a service
// (DP-81), on the tag store the console's Tags pages use (packages/db's deploy/tags.ts). A tag belongs to the org;
// every query runs in withOrg(), so row-level security is Coolify's where('team_id', …).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  APPLICATION_MORPH_CLASS,
  DATABASE_TABLES,
  SERVICE_MORPH_CLASS,
  attachTag,
  deleteTag,
  detachTag,
  findDatabaseByUuid,
  findTagByName,
  findTagByUuid,
  insertTag,
  listResourceTagsInPivotOrder,
  listTagsWithDates,
  renameTag,
  resourceHasTag,
  type DeployTagApiRow,
  type Taggable,
} from "@saas/db/deploy";
import { COOLIFY_API, coolifyJson, laravelDate, obj, type CoolifyAnswer, type PhpObject } from "@saas/contracts/coolify-api";
import { stripTags, tagName } from "../applications/tags.js";
import { phpTrim } from "../applications/storage-paths.js";
import { newPublicId } from "../helpers/names.js";
import { message, rowsOf, UPDATE_DENIED, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import { addError, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rules } from "./rules.js";

/** A TIMESTAMP(0) column's text as the model's datetime cast writes it. */
const date = (text: string | null): string | null => (text === null ? null : laravelDate(new Date(`${text.replace(" ", "T")}Z`)));

/** TagsController::serializeTag() */
export const serializeTag = (t: DeployTagApiRow): PhpObject => obj({ uuid: t.uuid, name: t.name, created_at: date(t.created_at), updated_at: date(t.updated_at) });

/** strtolower(trim(strip_tags((string) $name))): PHP's strtolower() changes ASCII letters only. */
const normalizeTagName = (name: string): string => phpTrim(stripTags(name)).replace(/[A-Z]/g, (ch) => ch.toLowerCase());
/** PHP's (string) cast of a request value. */
const phpString = (v: unknown): string => (v === true ? "1" : v === false || v === null || v === undefined ? "" : typeof v === "number" ? String(v) : typeof v === "string" ? v : "Array");
const mbLength = (s: string): number => [...s].length;

const denied = async (c: ApiV1Context, write: boolean, policyMessage?: string): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized(policyMessage));
const inOrg = <T>(c: ApiV1Context, fn: (tx: SqlExecutor) => Promise<T>): Promise<T> => c.sql(c.env, c.orgId, fn);
const tagExists = () => message("Tag with this name already exists.", 409);

// ── /tags ───────────────────────────────────────────────────────────────────

/** routes/api.php's /tags routes; null for every other path (the caller answers the fallback 404). */
export async function tagsApi(c: ApiV1Context, segments: string[]): Promise<CoolifyAnswer | null> {
  const [uuid, extra] = segments;
  if (extra !== undefined) return null;
  if (uuid === undefined) return c.method === "GET" ? listTeamTags(c) : c.method === "POST" ? createTeamTag(c) : null;
  return c.method === "PATCH" ? updateTeamTag(c, uuid) : c.method === "DELETE" ? deleteTeamTag(c, uuid) : null;
}

async function listTeamTags(c: ApiV1Context): Promise<CoolifyAnswer> {
  return coolifyJson((await inOrg(c, listTagsWithDates)).map(serializeTag));
}

/** validateTagWriteRequest(): validateIncomingRequest(), name `required|string|min:2|max:255` and only `name`, then the name normalized. */
async function validateTagWrite(c: ApiV1Context): Promise<{ name: string } | CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const errors: Errors = [];
  await validateRules(errors, body.all, [["name", ["required", "string", "min:2", "max:255"]]], { laravelMessages: true });
  for (const k of Object.keys(body.all)) if (k !== "name") addError(errors, k, "This field is not allowed.");
  if (errors.length) return validationFailed(errors);
  const name = normalizeTagName(phpString(body.all.name));
  if (mbLength(name) < 2) return validationFailed([["name", ["The tag name must be at least 2 characters after sanitization."]]]);
  return { name };
}

async function createTeamTag(c: ApiV1Context): Promise<CoolifyAnswer> {
  const no = await denied(c, true);
  if (no) return no;
  const validated = await validateTagWrite(c);
  if (!("name" in validated)) return validated;
  return inOrg(c, async (tx) => {
    if (await findTagByName(tx, validated.name)) return tagExists();
    // Tag::create(): the model's mutator stores the name through strip_tags() and strtolower() again.
    const created = await insertTag(tx, { orgId: c.orgId, uuid: newPublicId(), name: tagName(validated.name) });
    return coolifyJson(serializeTag((await findTagByUuid(tx, created.uuid))!), 201);
  });
}

async function updateTeamTag(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  const validated = await validateTagWrite(c);
  if (!("name" in validated)) return validated;
  return inOrg(c, async (tx) => {
    const tag = await findTagByUuid(tx, uuid);
    if (!tag) return message("Tag not found.", 404);
    const no = await denied(c, true);
    if (no) return no;
    if (validated.name !== tag.name) {
      const other = await findTagByName(tx, validated.name);
      if (other && String(other.id) !== String(tag.id)) return tagExists();
    }
    await renameTag(tx, tag.id, tagName(validated.name));
    return coolifyJson(serializeTag((await findTagByUuid(tx, uuid))!));
  });
}

async function deleteTeamTag(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  return inOrg(c, async (tx) => {
    const tag = await findTagByUuid(tx, uuid);
    if (!tag) return message("Tag not found.", 404);
    const no = await denied(c, true);
    if (no) return no;
    // The pivot rows go with the tag (Coolify: the foreign key cascades).
    await deleteTag(tx, tag.id);
    return message("Tag deleted.", 200);
  });
}

// ── /{applications,databases,services}/{uuid}/tags ──────────────────────────

export type TaggableKind = "application" | "database" | "service";

const NOT_FOUND: Record<TaggableKind, string> = { application: "Application not found.", database: "Database not found.", service: "Service not found." };

/** findTaggableResource(): the org's resource that is not deleted, as the pivot names it. */
async function taggable(tx: SqlExecutor, kind: TaggableKind, uuid: string): Promise<Taggable | null> {
  if (kind === "database") {
    const db = await findDatabaseByUuid(tx, uuid);
    return db ? { type: DATABASE_TABLES[db.engine].morphClass, id: db.id } : null;
  }
  const table = kind === "application" ? "applications" : "services";
  const row = (await rowsOf(tx)(table, "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0];
  return row ? { type: kind === "application" ? APPLICATION_MORPH_CLASS : SERVICE_MORPH_CLASS, id: rowValue(row, "id") as string | number } : null;
}

const resourceTags = async (tx: SqlExecutor, resource: Taggable) => (await listResourceTagsInPivotOrder(tx, resource)).map(serializeTag);

/**
 * HandlesTagsApi's routes under a resource: `segments` follow /{applications,databases,services}/{uuid}/tags. Null for
 * a path or method that is not one of them.
 */
export async function resourceTagsApi(c: ApiV1Context, kind: TaggableKind, uuid: string, segments: string[]): Promise<CoolifyAnswer | null> {
  const [tagUuid, extra] = segments;
  if (extra !== undefined) return null;
  if (tagUuid === undefined) return c.method === "GET" ? listOf(c, kind, uuid) : c.method === "POST" ? addTo(c, kind, uuid) : null;
  return c.method === "DELETE" ? removeFrom(c, kind, uuid, tagUuid) : null;
}

async function listOf(c: ApiV1Context, kind: TaggableKind, uuid: string): Promise<CoolifyAnswer> {
  return inOrg(c, async (tx) => {
    const resource = await taggable(tx, kind, uuid);
    if (!resource) return message(NOT_FOUND[kind], 404);
    const no = await denied(c, false);
    if (no) return no;
    return coolifyJson(await resourceTags(tx, resource));
  });
}

const ADD_RULES: Rules = [
  ["tag_name", [{ requiredWithout: "tag_names" }, "string"]],
  ["tag_names", [{ requiredWithout: "tag_name" }, "array", "min:1"]],
  ["tag_names.*", ["string"]],
];

/** normalizeTagNames(): each name normalized, the duplicates dropped (the first kept). */
function normalizeTagNames(names: unknown[]): string[] {
  return [...new Set(names.map((n) => normalizeTagName(phpString(n))))];
}

async function addTo(c: ApiV1Context, kind: TaggableKind, uuid: string): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  return inOrg(c, async (tx) => {
    const resource = await taggable(tx, kind, uuid);
    if (!resource) return message(NOT_FOUND[kind], 404);
    const no = await denied(c, true, UPDATE_DENIED[kind]);
    if (no) return no;
    if ("tag_name" in all && "tag_names" in all) return validationFailed([["tag_name", ["Provide either tag_name or tag_names, not both."]]]);
    const errors: Errors = [];
    await validateRules(errors, all, ADD_RULES, { laravelMessages: true });
    for (const k of Object.keys(all)) if (k !== "tag_name" && k !== "tag_names") addError(errors, k, "This field is not allowed.");
    if (errors.length) return validationFailed(errors);
    const list = "tag_names" in all ? (Array.isArray(all.tag_names) ? all.tag_names : Object.values(all.tag_names as Record<string, unknown>)) : [all.tag_name];
    const names = normalizeTagNames(list);
    if (names.some((n) => mbLength(n) < 2)) return validationFailed([["tag_name", ["Each tag name must be at least 2 characters after sanitization."]]]);
    // attachTagsToResource(): Tag::createOrFirst(team, name), then syncWithoutDetaching().
    for (const name of names) {
      const stored = tagName(name);
      const tag = (await findTagByName(tx, stored)) ?? (await insertTag(tx, { orgId: c.orgId, uuid: newPublicId(), name: stored }));
      if (!(await resourceHasTag(tx, resource, tag.id))) await attachTag(tx, c.orgId, resource, tag.id);
    }
    return coolifyJson(await resourceTags(tx, resource), 201);
  });
}

async function removeFrom(c: ApiV1Context, kind: TaggableKind, uuid: string, tagUuid: string): Promise<CoolifyAnswer> {
  return inOrg(c, async (tx) => {
    const resource = await taggable(tx, kind, uuid);
    if (!resource) return message(NOT_FOUND[kind], 404);
    const no = await denied(c, true, UPDATE_DENIED[kind]);
    if (no) return no;
    const tag = await findTagByUuid(tx, tagUuid);
    if (!tag) return message("Tag not found.", 404);
    if (!(await resourceHasTag(tx, resource, tag.id))) return message("Tag not found on resource.", 404);
    // The tag stays, also without resources.
    await detachTag(tx, resource, tag.id);
    return message("Tag removed.", 200);
  });
}
