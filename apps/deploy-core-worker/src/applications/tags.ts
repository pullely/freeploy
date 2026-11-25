// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Shared/Tags.php, app/Models/Tag.php and
// app/Traits/HasSafeStringAttribute.php (Apache-2.0), modified.
//
// A resource's Tags page, for an application: the org's tags are reusable
// labels, attached to and removed from the application. Rows only.
import { DEPLOY_UNIQUE_INDEXES, refusingDuplicates, type DeployTagRow } from "@saas/db/deploy";
import { blank, length, type FieldErrors } from "../private-keys/validation.js";
import { newPublicId } from "../helpers/names.js";
import type { ApplicationShow } from "./service.js";
import { SettingsError, SettingsFieldErrors } from "./settings.js";
import { loadApplication, text, type ApplicationResourcesContext, type LoadedApplication } from "./resources.js";
import { phpTrim } from "./storage-paths.js";

type Body = Record<string, unknown>;

export const TAG_MESSAGES = {
  /** #[Validate('required|string|min:2')] on newTags */
  newTagsRequired: "The new tags field is required.",
  newTagsString: "The new tags field must be a string.",
  newTagsMin: "The new tags field must be at least 2 characters.",
  /** Tags::submit() and addTag(): dispatch('error', title, description) */
  invalidTag: "Invalid tag.",
  invalidTagDescription: (tag: string) => `Tag ${tag} is invalid. Min length is 2.`,
  duplicateTags: "Duplicate tags.",
  duplicateTagsDescription: (tag: string) => `Tag ${tag} already added.`,
  tagAdded: "Tag added.",
  tagRemoved: "Tag removed.",
} as const;

export interface TagItem {
  id: string;
  name: string;
}

export interface TagsPage {
  application: ApplicationShow;
  /** $resource->tags */
  tags: TagItem[];
  /** $filteredTags: the org's tags the application does not have (empty for who may not update). */
  availableTags: TagItem[];
}

export interface TagsSaved extends TagsPage {
  /** The success toast (null when Coolify shows none). */
  message: string | null;
  /** submit(): one error toast per name that was not added; the other names are. */
  errors: Array<{ title: string; description: string }>;
}

const item = (t: DeployTagRow): TagItem => ({ id: String(t.id), name: t.name });

/** PHP's strip_tags(): what looks like a tag is dropped; an unclosed "<…" drops the rest. */
export function stripTags(value: string): string {
  return value.replace(/<[^>]*(>|$)/g, "");
}

/** Tag::setNameAttribute(): strip_tags(), then strtolower() (ASCII letters only, as PHP 8 does). */
export function tagName(value: string): string {
  return stripTags(value).replace(/[A-Z]/g, (c) => c.toLowerCase());
}

async function page(ctx: ApplicationResourcesContext, l: LoadedApplication, canUpdate: boolean): Promise<TagsPage> {
  const attached = await ctx.store.applicationTags(l.row.id);
  const ids = new Set(attached.map((t) => String(t.id)));
  const available = canUpdate ? (await ctx.store.tags()).filter((t) => !ids.has(String(t.id))) : [];
  return { application: l.application, tags: attached.map(item), availableTags: available.map(item) };
}

/** Tags::mount() / loadTags() */
export async function showTags(ctx: ApplicationResourcesContext, uuid: string, canUpdate: boolean): Promise<TagsPage | null> {
  const l = await loadApplication(ctx, uuid, canUpdate);
  return l ? page(ctx, l, canUpdate) : null;
}

/**
 * Tags::submit(): the names, separated by single spaces. Each is added on its
 * own: an existing tag of the org is attached, a new name creates the tag; a
 * name that is too short or already attached is reported and skipped.
 *
 * The name is compared as the model stores it (lower case). Coolify compares
 * what was typed, so "Prod" misses the stored "prod" and the insert then
 * fails on the unique index; here "Prod" is "prod".
 */
export async function addTags(ctx: ApplicationResourcesContext, uuid: string, body: Body): Promise<TagsSaved | null> {
  const l = await loadApplication(ctx, uuid, true);
  if (!l) return null;
  const raw = text(body.newTags);
  const fields: FieldErrors = {};
  if (blank(raw)) fields.newTags = [TAG_MESSAGES.newTagsRequired];
  else if (typeof raw !== "string") fields.newTags = [TAG_MESSAGES.newTagsString];
  else if (length(raw) < 2) fields.newTags = [TAG_MESSAGES.newTagsMin];
  if (fields.newTags) throw new SettingsFieldErrors(fields);

  const errors: TagsSaved["errors"] = [];
  for (const typed of phpTrim(raw as string).split(" ")) {
    const stripped = stripTags(typed);
    // strlen(): bytes.
    if (new TextEncoder().encode(stripped).length < 2) {
      errors.push({ title: TAG_MESSAGES.invalidTag, description: TAG_MESSAGES.invalidTagDescription(stripped) });
      continue;
    }
    const name = tagName(stripped);
    const found = await ctx.store.findTagByName(name);
    if (found && (await ctx.store.hasTag(l.row.id, found.id))) {
      errors.push({ title: TAG_MESSAGES.duplicateTags, description: TAG_MESSAGES.duplicateTagsDescription(stripped) });
      continue;
    }
    const tag = found ?? (await ctx.store.insertTag({ uuid: newPublicId(), name }));
    await attachOnce(ctx, l.row.id, tag.id, stripped);
  }
  return { ...(await page(ctx, l, true)), message: null, errors };
}

/** taggable_unique (tag_id, taggable_id, taggable_type): a tag another request attached since this one asked. */
const attachOnce = (ctx: ApplicationResourcesContext, applicationId: string | number, tagId: string | number, typed: string): Promise<void> =>
  refusingDuplicates(
    [DEPLOY_UNIQUE_INDEXES.taggable],
    () => ctx.store.attachTag(applicationId, tagId),
    () => new SettingsError(TAG_MESSAGES.duplicateTags, 422, { description: TAG_MESSAGES.duplicateTagsDescription(typed) }),
  );

/** Tags::addTag(): one of the org's tags, by id. Null when the application or the tag is not the org's. */
export async function addTag(ctx: ApplicationResourcesContext, uuid: string, id: string): Promise<TagsSaved | null> {
  const l = await loadApplication(ctx, uuid, true);
  const tag = l ? await ctx.store.findTagById(id) : null;
  if (!l || !tag) return null;
  if (await ctx.store.hasTag(l.row.id, tag.id)) throw new SettingsError(TAG_MESSAGES.duplicateTags, 422, { description: TAG_MESSAGES.duplicateTagsDescription(tag.name) });
  await attachOnce(ctx, l.row.id, tag.id, tag.name);
  return { ...(await page(ctx, l, true)), message: TAG_MESSAGES.tagAdded, errors: [] };
}

/** Tags::deleteTag(): the tag is detached; it stays, also without resources. */
export async function removeTag(ctx: ApplicationResourcesContext, uuid: string, id: string): Promise<TagsSaved | null> {
  const l = await loadApplication(ctx, uuid, true);
  if (!l) return null;
  await ctx.store.detachTag(l.row.id, id);
  return { ...(await page(ctx, l, true)), message: TAG_MESSAGES.tagRemoved, errors: [] };
}
