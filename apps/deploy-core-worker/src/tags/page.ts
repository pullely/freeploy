// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Tags/Show.php (mount, getDeployments, redeployAll,
// deleteTag), app/Livewire/Concerns/CreatesTags.php (createTag), bootstrap/helpers/shared.php
// (generateTagDeployWebhook) and app/Models/{Application,Service}.php (link) (Apache-2.0), modified.
//
// The team's Tags page (/tags/{tagName?}, tags.show; DP-97): the org's tags with their resource counts, one tag's
// deploy webhook, applications, services and active deployments, "New tag", "Delete" and "Redeploy all".
// Redeploying runs on the servers: with resources to deploy it answers 501; with none, Coolify's success.
import type { DeployActiveDeploymentRow, DeployTagCountRow, DeployTagRow, DeployTaggedResourceRow } from "@saas/db/deploy";
import { newPublicId } from "../helpers/names.js";
import { needsExecutor } from "../applications/resources.js";
import { stripTags, tagName } from "../applications/tags.js";
import type { FieldErrors } from "../private-keys/validation.js";

type Body = Record<string, unknown>;
type Id = string | number;

export interface TagPagesStore {
  tags(): Promise<DeployTagCountRow[]>;
  applications(tagId: Id): Promise<DeployTaggedResourceRow[]>;
  services(tagId: Id): Promise<DeployTaggedResourceRow[]>;
  deployments(applicationIds: Id[]): Promise<DeployActiveDeploymentRow[]>;
  findByName(name: string): Promise<DeployTagRow | null>;
  insert(tag: { uuid: string; name: string }): Promise<DeployTagRow>;
  delete(id: Id): Promise<void>;
}

export const TAG_PAGE_MESSAGES = {
  /** CreatesTags::createTag() */
  required: "The new tag name field is required.",
  string: "The new tag name field must be a string.",
  min: "The new tag name field must be at least 2 characters.",
  max: "The new tag name field must not be greater than 255 characters.",
  regex: "A tag name cannot contain spaces.",
  sanitizedTooShort: "The tag name must be at least 2 characters after sanitization.",
  exists: "A tag with this name already exists.",
  /** redeployAll() */
  massDeployment: "Mass deployment started.",
  /** Freeploy's: DeployController::deploy_resource() queues each deployment on its server. */
  redeployUnavailable: needsExecutor("Deploying the resources with this tag"),
} as const;

export class TagPageError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fields: FieldErrors | null = null,
  ) {
    super(message);
  }
}

export interface TagSummary {
  id: string;
  name: string;
  applicationsCount: number;
  servicesCount: number;
  resourceCount: number;
}

/** PHP's sort of strings (Collection::sortBy('name')): byte order. */
const byName = (a: { name: string }, b: { name: string }) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** $this->tags: ->get()->unique('name')->sortBy('name')->values(), each as tagsJs maps it. */
export async function listTagSummaries(store: TagPagesStore): Promise<TagSummary[]> {
  const seen = new Set<string>();
  const unique = (await store.tags()).filter((t) => (seen.has(t.name) ? false : (seen.add(t.name), true)));
  return unique
    .map((t) => ({ id: String(t.id), name: t.name, applicationsCount: Number(t.applications_count), servicesCount: Number(t.services_count), resourceCount: Number(t.applications_count) + Number(t.services_count) }))
    .sort(byName);
}

export interface TaggedResource {
  uuid: string;
  name: string;
  description: string | null;
  projectName: string;
  environmentName: string;
  /** $resource->link() */
  link: string;
}

export interface ActiveDeployment {
  id: string;
  applicationName: string | null;
  deploymentUrl: string | null;
  pullRequestId: number;
  serverName: string | null;
  status: string;
}

export interface TagPage {
  tags: TagSummary[];
  tag: { id: string; name: string };
  /** generateTagDeployWebhook(): the path below the API origin. */
  webhookPath: string;
  applications: TaggedResource[];
  services: TaggedResource[];
  /** getDeployments(), flattened in id order (the page sorts it). */
  deployments: ActiveDeployment[];
}

const resource = (kind: "application" | "service", r: DeployTaggedResourceRow): TaggedResource => ({
  uuid: r.uuid,
  name: r.name,
  description: r.description,
  projectName: r.project_name,
  environmentName: r.environment_name,
  link: `/project/${r.project_uuid}/environment/${r.environment_uuid}/${kind}/${r.uuid}`,
});

/** /api/v1/deploy?tag=… — the name as it is (Coolify does not encode it). */
export const tagDeployWebhookPath = (name: string): string => `/api/v1/deploy?tag=${name}`;

/** Show::mount() with a tag name: null when the org has no tag of that name (Coolify redirects to the list). */
export async function showTagPage(store: TagPagesStore, name: string): Promise<TagPage | null> {
  const tags = await listTagSummaries(store);
  const tag = tags.find((t) => t.name === name);
  if (!tag) return null;
  const applications = await store.applications(tag.id);
  const services = await store.services(tag.id);
  const deployments = (await store.deployments(applications.map((a) => a.id))).map((d) => ({
    id: String(d.id),
    applicationName: d.application_name,
    deploymentUrl: d.deployment_url,
    pullRequestId: Number(d.pull_request_id),
    serverName: d.server_name,
    status: d.status,
  }));
  return {
    tags,
    tag: { id: tag.id, name: tag.name },
    webhookPath: tagDeployWebhookPath(tag.name),
    applications: applications.map((a) => resource("application", a)),
    services: services.map((s) => resource("service", s)),
    deployments,
  };
}

/** Laravel's mb_strlen() */
const length = (value: string): number => [...value].length;

/**
 * CreatesTags::createTag(): the rules ['required', 'string', 'min:2', 'max:255', 'regex:/^\S+$/'] with its own
 * regex message (an empty name fails `required` alone, as Laravel skips the other rules), then the name as
 * strtolower(trim(strip_tags())), its length again, and the org's tags. Answers the new tag's name.
 */
export async function createTagFromPage(store: TagPagesStore, body: Body): Promise<{ name: string }> {
  const raw = body.newTagName;
  const errors: string[] = [];
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) errors.push(TAG_PAGE_MESSAGES.required);
  else if (typeof raw !== "string") errors.push(TAG_PAGE_MESSAGES.string);
  else {
    if (length(raw) < 2) errors.push(TAG_PAGE_MESSAGES.min);
    if (length(raw) > 255) errors.push(TAG_PAGE_MESSAGES.max);
    if (!/^\S+$/u.test(raw)) errors.push(TAG_PAGE_MESSAGES.regex);
  }
  if (errors.length) throw new TagPageError(errors[0]!, 422, { newTagName: errors });
  const name = tagName(stripTags(String(raw)).trim().replace(/[A-Z]/g, (c) => c.toLowerCase()));
  if (length(name) < 2) throw new TagPageError(TAG_PAGE_MESSAGES.sanitizedTooShort, 422, { newTagName: [TAG_PAGE_MESSAGES.sanitizedTooShort] });
  if (await store.findByName(name)) throw new TagPageError(TAG_PAGE_MESSAGES.exists, 422, { newTagName: [TAG_PAGE_MESSAGES.exists] });
  const created = await store.insert({ uuid: newPublicId(), name });
  return { name: created.name };
}

/** Show::deleteTag(): the tag and every resource's link to it. Null when the org has no tag of that name. */
export async function deleteTagFromPage(store: TagPagesStore, name: string): Promise<{ deleted: true } | null> {
  const tag = (await listTagSummaries(store)).find((t) => t.name === name);
  if (!tag) return null;
  await store.delete(tag.id);
  return { deleted: true };
}

/**
 * Show::redeployAll(): DeployController::deploy_resource() for each application and service of the tag. With
 * none it deploys nothing and toasts Coolify's success; otherwise 501. Null when the org has no tag of that name.
 */
export async function redeployTag(store: TagPagesStore, name: string): Promise<{ message: string } | null> {
  const page = await showTagPage(store, name);
  if (!page) return null;
  if (page.applications.length + page.services.length > 0) throw new TagPageError(TAG_PAGE_MESSAGES.redeployUnavailable, 501);
  return { message: TAG_PAGE_MESSAGES.massDeployment };
}
