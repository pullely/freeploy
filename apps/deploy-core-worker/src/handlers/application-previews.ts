// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Previews.php,
// app/Livewire/Project/Application/Preview/Form.php, app/Livewire/Project/Application/PreviewDomains.php (mount,
// generateDomain, removeDomain, refreshDomains, persistDomains, persistDnsStatuses, makeRow, effectiveDomainInternalPort,
// statusKey), app/Models/ApplicationPreview.php (generate_preview_fqdn, generatedPreviewDomain), app/Models/Application.php
// (git_based, isGithubAppSource, previews), app/Support/ValidationPatterns.php (dockerImageTagRules) and
// bootstrap/helpers/github.php (githubApi) (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/applications/{uuid}/previews — the console's Preview Deployments page (DP-99), on the
// preview rows of DP-72 and DP-86:
//
//   GET    /previews                          Previews::mount() + Preview\Form + each preview's PreviewDomains rows
//   PATCH  /previews/settings                 savePreviewSettings { isPrDeploymentsPublicEnabled } / togglePreviewDeployments { toggle: true }
//   PATCH  /previews/template                 Preview\Form::submit { previewUrlTemplate } / resetToDefault { reset: true }
//   POST   /previews/pull-requests            load_prs: GitHub's open pull requests of the repository, asked as Coolify asks
//   POST   /previews                          add { pullRequestId, pullRequestHtmlUrl?, dockerTag? }, add_and_deploy (deploy: true),
//                                             addDockerImagePreview (manual: true, with manualPullRequestId and manualDockerTag)
//   PATCH  /previews/{id}/docker-tag          save_preview { dockerTag }
//   POST   /previews/{pull_request_id}/deploy { force? }   deploy / force_deploy_without_cache: 501 after Coolify's checks
//   POST   /previews/{pull_request_id}/stop   stop: on the server, 501
//   DELETE /previews/{pull_request_id}        delete (a functional server's cleanup is 501, as /api/v1's, DP-86)
//   POST   /previews/{id}/domains/generate    PreviewDomains::generateDomain
//   DELETE /previews/{id}/domains/{index}     PreviewDomains::removeDomain
//
// Coolify's policies: view to read; update, deploy and delete to write. Here: deploy.resource.read and
// deploy.resource.write; a denial answers 404. A Docker Compose application's previews (their per-service domains
// need the application Compose parser, as DP-86's API says) and adding or editing a preview's domain by hand are not
// ported.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findApplicationByUuid,
  findApplicationConfiguration,
  listWebhookApplications,
  listAdditionalDestinations,
  listPreviewPageRows,
  updatePreviewDeploymentSettings,
  updateApplicationPreviewUrlTemplate,
  updatePreviewDnsStatuses,
  insertApplicationPreview,
  updateApplicationPreview,
  softDeleteApplicationPreview,
  findGithubAppById,
  findGithubAppPrivateKey,
  PUBLIC_GITHUB_SOURCE,
  type DeployPreviewPageRow,
  type DeployWebhookApplicationRow,
  type DeployApplicationConfigurationRow,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { applicationShow } from "../applications/service.js";
import { domainWithoutPort, generateUrl, normalizeDomainPortOverrides, parseUrl } from "../applications/domains.js";
import { DOCKER_IMAGE_TAG_PATTERN } from "../applications/validation.js";
import { generatedPreviewDomain, serverIsFunctional } from "../sources/github-webhook.js";
import { gitRepositorySlug } from "../sources/pr-updates.js";
import { githubApi, InstallationTokens, type GithubAppCredentials, type SourceHttp } from "../sources/github.js";
import { credentialsOf, type SourceStore } from "../sources/service.js";
import { isLaravelUrl } from "../api-v1/laravel-url.js";
import { newPublicId } from "../helpers/names.js";

/** Freeploy's convention, written out: this module loads inside the router's import cycle. The deploy text is /api/v1's (DP-86). */
const needsExecutor = (what: string): string => `${what} needs the SSH executor, which is not available yet.`;

export const PREVIEW_PAGE_MESSAGES = {
  settingsSaved: "Settings saved.",
  templateUpdated: "Preview url template updated.",
  templateRequired: "The preview url template field is required.",
  githubOnly: "Loading pull requests is only supported for GitHub App sources.",
  previewSaved: "Preview saved.\n\nDo not forget to redeploy the preview to apply the changes.",
  previewNotFound: "Preview not found",
  added: "Preview added.",
  manualOnlyImage: "Manual Docker Image previews are only available for Docker Image applications.",
  manualBoth: "Both pull request id and docker tag are required.",
  deleteNotFound: "Preview not found.",
  deleteStarted: "Preview deletion started. It may take a few moments to complete.",
  domainGenerated: "Domain generated.",
  domainRemoved: "Domain removed.",
  /** add() of a preview that is neither found nor created: PHP's Error on $found->generate_preview_fqdn(). */
  nullPreview: "Call to a member function generate_preview_fqdn() on null",
  deployUnavailable: needsExecutor("Deploying the preview"),
  stopUnavailable: needsExecutor("Stopping the preview"),
  cleanupUnavailable: needsExecutor("Removing the preview's containers from the server"),
  composeUnavailable: "A Docker Compose application's previews are not available yet: their domains need the application Compose parser.",
};

const DEFAULT_TEMPLATE = "{{pr_id}}.{{domain}}";
const GITHUB_APP_MORPH = "App\\Models\\GithubApp";

export type PreviewPagesRunner = <T>(env: Env, orgId: string, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

export const runPreviewPagesInOrg: PreviewPagesRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, fn);
  } finally {
    await db.dispose();
  }
};

/** Whether handleApplications routes …/previews[/…] here. segments: what follows /applications. */
export const isApplicationPreviewRoute = (segments: readonly string[]): boolean => segments.length >= 2 && segments[1] === "previews";

type Body = Record<string, unknown>;

class PageError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly fields?: Record<string, string[]>,
  ) {
    super(message);
  }
}
const fieldErrors = (fields: Record<string, string[]>) => new PageError(Object.values(fields).flat()[0]!, 422, fields);

interface Loaded {
  config: DeployApplicationConfigurationRow;
  app: DeployWebhookApplicationRow;
  frame: Record<string, unknown>;
  additionalServers: number;
}

async function load(tx: SqlExecutor, uuid: string, canWrite: boolean): Promise<Loaded | null> {
  const config = await findApplicationConfiguration(tx, uuid);
  const frame = config ? await findApplicationByUuid(tx, uuid) : null;
  const app = config ? (await listWebhookApplications(tx, [config.id]))[0] : undefined;
  if (!config || !frame || !app) return null;
  return { config, app, frame: { application: applicationShow(frame, canWrite), canDeploy: canWrite }, additionalServers: (await listAdditionalDestinations(tx, config.id)).length };
}

/** Application::git_based(): no inline Dockerfile, not a Docker image. */
const gitBased = (l: Loaded): boolean => !l.config.has_dockerfile && l.config.build_pack !== "dockerimage";
/** isGithubAppSource(): the source is a GitHub App (the public GitHub source is one, id 0). */
const isGithubAppSource = (l: Loaded): boolean => l.app.source_type === GITHUB_APP_MORPH && l.app.source_id !== null;
const isCompose = (l: Loaded): boolean => l.config.build_pack === "dockercompose";

const splitDomains = (v: string | null | undefined): string[] => (v ?? "").split(",").map((d) => d.trim()).filter(Boolean);
const overridesOf = (v: unknown): Record<string, number> => {
  const parsed = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {};
};
const statusesOf = (v: unknown): Record<string, { status?: string; message?: string; check_id?: string | null }> => {
  const parsed = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, { status?: string; message?: string }>) : {};
};

/** statusKey(): hash('sha256', $url.'|'.($service ?? '')). */
async function statusKey(url: string, service: string | null = null): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${url}|${service ?? ""}`));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface DomainRowOut {
  url: string;
  internalPort: number | null;
  hasPortOverride: boolean;
  dnsStatus: string;
  dnsMessage: string;
  checkId: string | null;
}

/** makeRow() of a domain that is not a Compose service's. */
async function makeRow(l: Loaded, preview: DeployPreviewPageRow, url: string): Promise<DomainRowOut> {
  const status = statusesOf(preview.domain_dns_statuses)[await statusKey(url)] ?? {};
  // effectiveDomainInternalPort()
  const overrides = overridesOf(preview.domain_port_overrides);
  const canonical = domainWithoutPort(url);
  const legacy = parseUrl(url)?.port;
  let internalPort: number | null;
  let hasPortOverride = true;
  if (canonical in overrides) internalPort = Math.trunc(Number(overrides[canonical]));
  else if (legacy !== undefined && legacy !== null && String(legacy) !== "") internalPort = Number(legacy);
  else {
    hasPortOverride = false;
    const first = (l.config.ports_exposes ?? "").split(",")[0]?.trim() ?? "";
    internalPort = l.config.is_static ? 80 : /^\d+(\.\d+)?$/.test(first) && Number(first) > 0 ? Math.trunc(Number(first)) : null;
  }
  return { url, internalPort, hasPortOverride, dnsStatus: status.status ?? "pending", dnsMessage: status.message ?? "DNS has not been checked yet.", checkId: status.check_id ?? null };
}

async function previewOf(l: Loaded, p: DeployPreviewPageRow) {
  return {
    id: String(p.id),
    uuid: p.uuid,
    pullRequestId: p.pull_request_id,
    pullRequestHtmlUrl: p.pull_request_html_url,
    fqdn: p.fqdn,
    status: p.status,
    dockerRegistryImageTag: p.docker_registry_image_tag,
    restartLimitReached: p.restart_limit_reached,
    // refreshDomains(): a Compose preview's domains are per service (not ported here).
    domains: isCompose(l) ? [] : await Promise.all(splitDomains(p.fqdn).map((url) => makeRow(l, p, url))),
  };
}

/** Preview\Form::generateRealUrl(): {{domain}} as the host of the application's first domain. */
function generatedPattern(l: Loaded): string {
  const template = l.app.preview_url_template ?? DEFAULT_TEMPLATE;
  if (!l.app.fqdn) return template;
  const host = parseUrl(l.app.fqdn.split(",")[0]!)?.host ?? "";
  return template.split("{{domain}}").join(host);
}

async function page(tx: SqlExecutor, l: Loaded) {
  const previews = await listPreviewPageRows(tx, l.config.id);
  return {
    ...l.frame,
    gitBased: gitBased(l),
    isGithubAppSource: isGithubAppSource(l),
    buildPack: l.config.build_pack,
    isPreviewDeploymentsEnabled: l.app.is_preview_deployments_enabled,
    isPrDeploymentsPublicEnabled: l.app.is_pr_deployments_public_enabled,
    previewUrlTemplate: l.app.preview_url_template ?? DEFAULT_TEMPLATE,
    generatedPattern: generatedPattern(l),
    previewServerName: l.additionalServers > 0 ? l.app.server_name : null,
    previews: await Promise.all(previews.map((p) => previewOf(l, p))),
  };
}

const bool = (v: unknown): boolean | undefined => (v === true || v === 1 || v === "1" ? true : v === false || v === 0 || v === "0" ? false : undefined);

async function saveSettings(tx: SqlExecutor, l: Loaded, body: Body) {
  let enabled = l.app.is_preview_deployments_enabled;
  if (body.toggle === true) enabled = !enabled;
  const isPublic = "isPrDeploymentsPublicEnabled" in body ? bool(body.isPrDeploymentsPublicEnabled) : l.app.is_pr_deployments_public_enabled;
  if (isPublic === undefined) throw fieldErrors({ isPrDeploymentsPublicEnabled: ["The is pr deployments public enabled field must be true or false."] });
  await updatePreviewDeploymentSettings(tx, l.config.id, { isPreviewDeploymentsEnabled: enabled, isPrDeploymentsPublicEnabled: isPublic });
  return { message: PREVIEW_PAGE_MESSAGES.settingsSaved, isPreviewDeploymentsEnabled: enabled, isPrDeploymentsPublicEnabled: isPublic };
}

async function saveTemplate(tx: SqlExecutor, l: Loaded, body: Body) {
  let template: string;
  if (body.reset === true) template = DEFAULT_TEMPLATE;
  else {
    const value = body.previewUrlTemplate;
    if (typeof value !== "string" || value.trim() === "") throw fieldErrors({ previewUrlTemplate: [PREVIEW_PAGE_MESSAGES.templateRequired] });
    template = value.split(" ").join("");
  }
  await updateApplicationPreviewUrlTemplate(tx, l.config.id, template);
  return { message: PREVIEW_PAGE_MESSAGES.templateUpdated, previewUrlTemplate: template, generatedPattern: generatedPattern({ ...l, app: { ...l.app, preview_url_template: template } }) };
}

/** load_prs(): githubApi($source, '/repos/{slug}/pulls'), sorted by number. */
async function loadPullRequests(tx: SqlExecutor, env: Env, orgId: string, l: Loaded, http: SourceHttp) {
  if (!isGithubAppSource(l)) throw new PageError(PREVIEW_PAGE_MESSAGES.githubOnly);
  let credentials: GithubAppCredentials;
  if (Number(l.app.source_id) === PUBLIC_GITHUB_SOURCE.id) {
    credentials = { name: PUBLIC_GITHUB_SOURCE.name, organization: null, api_url: PUBLIC_GITHUB_SOURCE.apiUrl, html_url: PUBLIC_GITHUB_SOURCE.htmlUrl, app_id: null, installation_id: null, is_public: true, privateKey: null };
  } else {
    const app = await findGithubAppById(tx, l.app.source_id!);
    if (!app) throw new PageError(PREVIEW_PAGE_MESSAGES.githubOnly);
    credentials = await credentialsOf({ store: { privateKey: (id: string | number | null) => findGithubAppPrivateKey(tx, id) } as SourceStore, cipher: (column) => columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, column) }, app);
  }
  try {
    const answer = await githubApi(http, new InstallationTokens(http), credentials, `/repos/${gitRepositorySlug(l.app.git_repository)}/pulls`);
    const list = Array.isArray(answer.data) ? (answer.data as Array<Record<string, unknown>>) : [];
    const pullRequests = [...list]
      .sort((a, b) => Number(a.number) - Number(b.number))
      .map((pr) => ({ number: Math.trunc(Number(pr.number)), title: typeof pr.title === "string" ? pr.title : "", htmlUrl: typeof pr.html_url === "string" ? pr.html_url : "" }));
    return { rateLimitRemaining: answer.rateLimitRemaining === null ? null : Number.parseInt(answer.rateLimitRemaining, 10), pullRequests };
  } catch (e) {
    // handleError(): the exception's message as the toast; rate_limit_remaining = 0.
    throw new PageError(e instanceof Error ? e.message : String(e), 422);
  }
}

/** validatePreviewInput(): Validator::make() with Laravel's messages. */
function validatePreviewInput(url: unknown, tag: unknown): void {
  const fields: Record<string, string[]> = {};
  if (url !== null && url !== undefined) {
    const list: string[] = [];
    if (typeof url !== "string" || !isLaravelUrl(url) || !/^https?:/i.test(url)) list.push("The pull request html url field must be a valid URL.");
    if (typeof url === "string" && [...url].length > 2048) list.push("The pull request html url field must not be greater than 2048 characters.");
    if (list.length) fields.pull_request_html_url = list;
  }
  const tagErrors = dockerTagErrors(tag, "docker registry image tag");
  if (tagErrors.length) fields.docker_registry_image_tag = tagErrors;
  if (Object.keys(fields).length) throw fieldErrors(fields);
}

/** ValidationPatterns::dockerImageTagRules(): nullable|string|max:128|regex, with the attribute's name. */
function dockerTagErrors(tag: unknown, attribute: string): string[] {
  if (tag === null || tag === undefined || tag === "") return [];
  if (typeof tag !== "string") return [`The ${attribute} field must be a string.`];
  const errors: string[] = [];
  if ([...tag].length > 128) errors.push(`The ${attribute} field must not be greater than 128 characters.`);
  if (!DOCKER_IMAGE_TAG_PATTERN.test(tag)) errors.push(`The ${attribute} field format is invalid.`);
  return errors;
}

const filledText = (v: unknown): v is string => typeof v === "string" && v !== "";

/** generate_preview_fqdn($generateWithoutApplicationDomain, $keepExistingDomains) of a preview that is not a Compose one. */
async function generatePreviewFqdn(tx: SqlExecutor, l: Loaded, preview: { id: string | number; pull_request_id: number; fqdn: string | null; domain_port_overrides: unknown }, withoutApplicationDomain: boolean, keepExisting: boolean): Promise<void> {
  if (keepExisting && preview.fqdn) {
    const normalized = normalizeDomainPortOverrides(preview.fqdn, overridesOf(preview.domain_port_overrides));
    await updateApplicationPreview(tx, preview.id, { fqdn: normalized.fqdn, domain_port_overrides: normalized.overrides });
    return;
  }
  let applicationFqdn = l.app.fqdn;
  if (!applicationFqdn && withoutApplicationDomain && l.app.server_ip) applicationFqdn = generateUrl({ ip: l.app.server_ip, wildcardDomain: l.app.server_wildcard_domain }, l.app.uuid);
  if (!applicationFqdn) return;
  const source = applicationFqdn.includes(",") ? applicationFqdn.split(",")[0]! : applicationFqdn;
  const generated = generatedPreviewDomain(source, l.app.preview_url_template, preview.pull_request_id, overridesOf(l.app.domain_port_overrides), newPublicId());
  await updateApplicationPreview(tx, preview.id, { fqdn: generated.url, domain_port_overrides: generated.port !== null ? { [generated.url]: generated.port } : null });
}

/**
 * add() — and add_and_deploy() and addDockerImagePreview(), which deploy after it: Coolify's checks, then either the row
 * (created or its tag saved, its domain generated) or, when the preview would be deployed, 501 before anything is stored.
 */
async function addPreview(tx: SqlExecutor, orgId: string, l: Loaded, body: Body) {
  let pullRequestId: number;
  let url: string | null;
  let tag: string | null;
  if (body.manual === true) {
    // addDockerImagePreview(): the manual tag trimmed, validateOnly() of both, then add_and_deploy().
    const rawId = body.manualPullRequestId;
    tag = typeof body.manualDockerTag === "string" && body.manualDockerTag.trim() !== "" ? body.manualDockerTag.trim() : null;
    const fields: Record<string, string[]> = {};
    const idText = rawId === null || rawId === undefined || rawId === "" ? null : String(rawId);
    if (idText !== null && !/^\s*[+-]?\d+\s*$/.test(idText)) fields.manualPullRequestId = ["The manual pull request id field must be an integer."];
    else if (idText !== null && Number(idText) < 1) fields.manualPullRequestId = ["The manual pull request id field must be at least 1."];
    if (Object.keys(fields).length) throw fieldErrors(fields);
    const tagErrors = dockerTagErrors(tag, "manual docker tag");
    if (tagErrors.length) throw fieldErrors({ manualDockerTag: tagErrors });
    if (l.config.build_pack !== "dockerimage") throw new PageError(PREVIEW_PAGE_MESSAGES.manualOnlyImage);
    if (idText === null || tag === null) throw new PageError(PREVIEW_PAGE_MESSAGES.manualBoth);
    pullRequestId = Number(idText);
    url = null;
    body.deploy = true;
  } else {
    pullRequestId = Math.trunc(Number(body.pullRequestId));
    if (!Number.isInteger(pullRequestId)) throw new PageError("The pull request id must be an integer.", 400);
    url = typeof body.pullRequestHtmlUrl === "string" ? body.pullRequestHtmlUrl : null;
    tag = typeof body.dockerTag === "string" ? body.dockerTag : null;
  }
  validatePreviewInput(url, tag);
  if (isCompose(l)) throw new PageError(PREVIEW_PAGE_MESSAGES.composeUnavailable, 501);
  const isImage = l.config.build_pack === "dockerimage";
  const found = (await listPreviewPageRows(tx, l.config.id)).find((p) => p.pull_request_id === pullRequestId) ?? null;
  const creates = !found && (url !== null || (isImage && filledText(tag)));
  if (!found && !creates) throw new PageError(PREVIEW_PAGE_MESSAGES.nullPreview, 500);
  // add_and_deploy(): deploy() queues the deployment on the server.
  if (body.deploy === true) throw new PageError(PREVIEW_PAGE_MESSAGES.deployUnavailable, 501);
  let target: { id: string | number; pull_request_id: number; fqdn: string | null; domain_port_overrides: unknown };
  if (found) {
    target = found;
    if (isImage && filledText(tag) && tag !== found.docker_registry_image_tag) await updateApplicationPreview(tx, found.id, { docker_registry_image_tag: tag });
  } else {
    const created = await insertApplicationPreview(tx, { orgId, uuid: newPublicId(), applicationId: l.config.id, pullRequestId, pullRequestHtmlUrl: url ?? "", gitType: null, dockerComposeDomains: null, dockerRegistryImageTag: tag });
    target = created;
  }
  await generatePreviewFqdn(tx, l, target, true, true);
  return { message: PREVIEW_PAGE_MESSAGES.added, ...(await page(tx, l)) };
}

async function saveDockerTag(tx: SqlExecutor, l: Loaded, id: string, body: Body) {
  const preview = (await listPreviewPageRows(tx, l.config.id)).find((p) => String(p.id) === id);
  if (!preview) throw new PageError(PREVIEW_PAGE_MESSAGES.previewNotFound);
  const tag = typeof body.dockerTag === "string" && body.dockerTag !== "" ? body.dockerTag : null;
  const errors = dockerTagErrors(tag, "docker tag");
  if (errors.length) throw fieldErrors({ [`previewDockerTags.${id}`]: errors });
  if (tag !== preview.docker_registry_image_tag) await updateApplicationPreview(tx, preview.id, { docker_registry_image_tag: tag });
  return { message: PREVIEW_PAGE_MESSAGES.previewSaved, dockerRegistryImageTag: tag };
}

/** deploy() / force_deploy_without_cache(): validatePreviewInput() passes for the list's buttons; the queue is on the server. */
async function deployPreview(): Promise<null> {
  throw new PageError(PREVIEW_PAGE_MESSAGES.deployUnavailable, 501);
}

async function deletePreview(tx: SqlExecutor, l: Loaded, pullRequestId: number) {
  const preview = (await listPreviewPageRows(tx, l.config.id)).find((p) => p.pull_request_id === pullRequestId);
  if (!preview) throw new PageError(PREVIEW_PAGE_MESSAGES.deleteNotFound);
  // DeleteResourceJob → CleanupPreviewDeployment: nothing to do on a server that is not functional (DP-86).
  if (serverIsFunctional(l.app)) throw new PageError(PREVIEW_PAGE_MESSAGES.cleanupUnavailable, 501);
  await softDeleteApplicationPreview(tx, preview.id);
  return { message: PREVIEW_PAGE_MESSAGES.deleteStarted, ...(await page(tx, l)) };
}

async function onDomains(tx: SqlExecutor, l: Loaded, id: string, action: "generate" | number) {
  if (isCompose(l)) throw new PageError(PREVIEW_PAGE_MESSAGES.composeUnavailable, 501);
  const preview = (await listPreviewPageRows(tx, l.config.id)).find((p) => String(p.id) === id);
  if (!preview) return null;
  if (action === "generate") {
    await generatePreviewFqdn(tx, l, preview, true, false);
    return { message: PREVIEW_PAGE_MESSAGES.domainGenerated, ...(await page(tx, l)) };
  }
  const rows = await Promise.all(splitDomains(preview.fqdn).map((url) => makeRow(l, preview, url)));
  if (action < 0 || action >= rows.length) return { ...(await page(tx, l)), message: null };
  rows.splice(action, 1);
  // persistDomains(): the fqdn and overrides normalized, then persistDnsStatuses() of the rows left.
  const normalized = normalizeDomainPortOverrides(rows.map((r) => r.url).join(",") || null, overridesOf(preview.domain_port_overrides));
  await updateApplicationPreview(tx, preview.id, { fqdn: normalized.fqdn, domain_port_overrides: normalized.overrides });
  const statuses: Record<string, unknown> = {};
  for (const r of rows) statuses[await statusKey(r.url)] = { status: r.dnsStatus, message: r.dnsMessage, check_id: r.checkId };
  await updatePreviewDnsStatuses(tx, preview.id, Object.keys(statuses).length ? statuses : null);
  return { message: PREVIEW_PAGE_MESSAGES.domainRemoved, ...(await page(tx, l)) };
}

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;
const ID_RE = /^[1-9]\d{0,17}$/;

/** segments: what follows /applications — [uuid, "previews", …]. `runner` and `github` are replaceable for tests. */
export async function handleApplicationPreviews(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: PreviewPagesRunner = runPreviewPagesInOrg,
  github: SourceHttp = { fetch: (url, init) => fetch(url, init) },
): Promise<Response> {
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const [uuid, , third, fourth, fifth] = segments;
  if (!uuid || !UUID_RE.test(uuid) || !isApplicationPreviewRoute(segments)) return notFound();
  const method = request.method;
  const depth = segments.length;
  type Op = { write: boolean; status?: number; run: (tx: SqlExecutor, l: Loaded, body: Body) => Promise<object | null> };
  const on = (m: string, write: boolean, run: Op["run"], status?: number): Op | null => (method === m ? { write, run, ...(status ? { status } : {}) } : null);
  let op: Op | null | undefined;
  if (depth === 2) op = on("GET", false, (tx, l) => page(tx, l)) ?? on("POST", true, (tx, l, body) => addPreview(tx, orgId, l, body), 201);
  else if (depth === 3 && third === "settings") op = on("PATCH", true, (tx, l, body) => saveSettings(tx, l, body));
  else if (depth === 3 && third === "template") op = on("PATCH", true, (tx, l, body) => saveTemplate(tx, l, body));
  else if (depth === 3 && third === "pull-requests") op = on("POST", true, (tx, l) => loadPullRequests(tx, env, orgId, l, github));
  else if (depth === 3 && third && ID_RE.test(third)) op = on("DELETE", true, (tx, l) => deletePreview(tx, l, Number(third)));
  else if (depth === 4 && third && ID_RE.test(third) && fourth === "docker-tag") op = on("PATCH", true, (tx, l, body) => saveDockerTag(tx, l, third, body));
  else if (depth === 4 && third && ID_RE.test(third) && (fourth === "deploy" || fourth === "stop")) {
    op = on("POST", true, async () => (fourth === "deploy" ? deployPreview() : Promise.reject(new PageError(PREVIEW_PAGE_MESSAGES.stopUnavailable, 501))));
  } else if (depth === 5 && third && ID_RE.test(third) && fourth === "domains" && fifth === "generate") op = on("POST", true, (tx, l) => onDomains(tx, l, third, "generate"));
  else if (depth === 5 && third && ID_RE.test(third) && fourth === "domains" && fifth && /^\d{1,4}$/.test(fifth)) op = on("DELETE", true, (tx, l) => onDomains(tx, l, third, Number(fifth)));
  if (op === undefined) return notFound();
  if (op === null) return methodNotAllowed(requestId);

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  const body = method === "POST" || method === "PATCH" ? await readJson(request) : {};
  try {
    const data = await runner(env, orgId, async (tx) => {
      const l = await load(tx, uuid, auth.canWrite);
      return l ? op.run(tx, l, body) : null;
    });
    if (!data) return notFound();
    return successResponse(op.write ? data : { ...data, canUpdate: auth.canWrite }, requestId, op.status ?? 200);
  } catch (e) {
    if (e instanceof PageError) {
      const code = e.status === 501 ? "unsupported" : e.status === 400 ? "bad_request" : e.status === 500 ? "internal_error" : "validation_failed";
      return errorResponse(code, e.message, e.status, requestId, e.fields ? { fields: e.fields } : undefined);
    }
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
