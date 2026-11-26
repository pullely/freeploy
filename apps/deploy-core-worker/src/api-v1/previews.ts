// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ApplicationPreviewsController.php (index, show,
// store, sourceGitType, formatPreview), app/Http/Controllers/Api/ApplicationsController.php (logs_by_uuid for a preview,
// update_preview_by_pull_request_id, delete_preview_by_pull_request_id), app/Models/ApplicationPreview.php (the saving
// hook, generate_preview_fqdn, generatedPreviewDomain), app/Models/Application.php (previews, git_based) and
// app/Actions/Application/CleanupPreviewDeployment.php (Apache-2.0), modified.
//
// Coolify's /api/v1 for an application's previews (DP-86), on DP-72's preview rows: listed and shown as formatPreview()
// writes them, opened or changed by store() (the rules, the git type from the request, the preview or the source, the
// write permission for a change, the domain generated from the preview URL template), their domains changed as
// update_preview_by_pull_request_id() changes them (DP-52's domain rules, the org's domains and the other previews'),
// and soft-deleted. What runs on the server answers 501 in Coolify's envelope after Coolify's own refusals and before
// anything is stored: deploying a preview (store() unless instant_deploy is false), its container logs, and deleting a
// preview of a functional server (CleanupPreviewDeployment stops its containers there). Opening a preview of a Docker
// Compose application also answers 501: its per-service domains need the application Compose parser
// (generate_preview_fqdn_compose() parses the file as a deployment would), which Freeploy does not have yet.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { insertApplicationPreview, softDeleteApplicationPreview, updateApplicationPreview, PUBLIC_GITHUB_SOURCE, type ApiRow, type ApplicationPreviewChanges } from "@saas/db/deploy";
import { COOLIFY_API, POLICY_DENIALS, coolifyJson, fromJs, laravelDate, obj, phpJsonEncode, sqlDate, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { applicationDomainList, domainWithoutPort, normalizeApplicationDomains, normalizeDomainPortOverrides, validateApplicationDomains } from "../applications/domains.js";
import { needsExecutor } from "../applications/resources.js";
import { parseDockerComposeYaml } from "../compose/yaml.js";
import { isPhpArray, phpString, type PhpValue as ComposeValue } from "../compose/php.js";
import { isDatabaseImage } from "../services/compose-helpers.js";
import type { ServiceStore } from "../services/store.js";
import { generatedPreviewDomain } from "../sources/github-webhook.js";
import { newPublicId } from "../helpers/names.js";
import { functional } from "./applications.js";
import { message, rowsOf, unavailable, type ApiV1Context, type Rows } from "./context.js";
import { cleanInput, readApiBody, requestBoolean, validationFailed, type Errors } from "./request.js";
import { rowValue } from "./models.js";
import { validateRules, type Rule, type Rules } from "./rules.js";
import { domainConflicts } from "./services.js";

export const PREVIEWS_API_MESSAGES = {
  applicationNotFound: "Application not found.",
  previewNotFound: "Preview not found.",
  invalidPullRequestId: "Invalid pull_request_id.",
  notPreviewable: "Preview deployments need a Git based or Docker Image application.",
  gitTypeRequired: "The git type field is required for applications without a GitHub, GitLab, or Gitea App source.",
  dockerTagRequired: "The docker tag field is required for a new Docker Image preview.",
  writeNeeded:
    "Missing required permissions: write. Opening a preview, changing its pull request URL, git type, or docker tag, or choosing a commit needs the write permission. The deploy permission only redeploys an existing preview.",
  deleted: "Preview deletion request queued.",
  composeUnparsable: "The Docker Compose configuration could not be parsed.",
  composeNoServices: "The Docker Compose configuration must define at least one service.",
  composeInvalidServices: "One or more Docker Compose services are invalid.",
  sameDomainTwice: "The same domain cannot be configured more than once.",
  /** Freeploy's: what runs on the server, and the application Compose parser. */
  deployUnavailable: needsExecutor("Deploying the preview"),
  logsUnavailable: needsExecutor("Reading the preview's container logs"),
  cleanupUnavailable: needsExecutor("Removing the preview's containers from the server"),
  composeUnavailable: "Opening a preview of a Docker Compose application is not available yet: its domains need the application Compose parser.",
} as const;

const GIT_TYPES = ["github", "gitlab", "gitea", "bitbucket"] as const;
const REDIRECTS = ["www", "non-www", "both"] as const;
const SERVER_ERROR: CoolifyAnswer = { status: 500, body: '{\n    "message": "Server Error"\n}', headers: { "content-type": "application/json" } };
const CONFLICT_WARNING = "Using the same domain for multiple resources can cause routing conflicts and unpredictable behavior.";

/** routes/api.php's /applications/{uuid}/previews routes; null for any other path. */
export async function previewsApi(c: ApiV1Context, appUuid: string, segments: string[]): Promise<CoolifyAnswer | null> {
  const [pr, sub, extra] = segments;
  const m = c.method;
  if (extra !== undefined) return null;
  if (pr === undefined) return m === "GET" ? listPreviews(c, appUuid) : m === "POST" ? storePreview(c, appUuid) : null;
  if (sub === undefined) return m === "GET" ? showPreview(c, appUuid, pr) : m === "PATCH" ? updatePreview(c, appUuid, pr) : m === "DELETE" ? deletePreview(c, appUuid, pr) : null;
  return sub === "logs" && m === "GET" ? previewLogs(c, appUuid, pr) : null;
}

// ── reading ─────────────────────────────────────────────────────────────────

/** Application::ownedByCurrentTeamAPI($teamId)->where('uuid', …)->first() */
async function applicationRow(rows: Rows, uuid: string): Promise<ApiRow | null> {
  return (await rows("applications", "t.deleted_at IS NULL AND t.uuid = $1", [uuid]))[0] ?? null;
}

/** $application->previews(): not soft-deleted, newest pull request first. */
async function previewRows(rows: Rows, applicationId: unknown, pullRequestId?: number): Promise<ApiRow[]> {
  const list = await rows("application_previews", `t.deleted_at IS NULL AND t.application_id = $1${pullRequestId === undefined ? "" : " AND t.pull_request_id = $2"}`, pullRequestId === undefined ? [applicationId] : [applicationId, pullRequestId]);
  return list.sort((a, b) => Number(rowValue(b, "pull_request_id")) - Number(rowValue(a, "pull_request_id")) || Number(rowValue(a, "id")) - Number(rowValue(b, "id")));
}

/** ctype_digit() and 1..2147483647, else null. */
function pullRequestIdOf(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 0 || n > 2147483647 ? null : n;
}

const asDate = (v: unknown): Date | null => (typeof v === "string" ? new Date(/[+-]\d\d:\d\d$|Z$/.test(v) ? v : `${v}Z`) : null);
const phpFalsy = (v: unknown): boolean => v === null || v === undefined || v === false || v === 0 || v === "" || v === "0";

/** json_decode($text, true) of a stored JSON text column (null when it is not JSON). */
function decodeJson(text: unknown): unknown {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The `array` cast of a JSON column as response()->json() writes it: an empty object is PHP's empty array. */
function arrayCast(v: unknown): PhpValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) return [];
  return fromJs(v);
}

/** formatPreview() */
function formatPreview(row: ApiRow): PhpObject {
  const compose = decodeJson(rowValue(row, "docker_compose_domains") || "null");
  const entries = compose !== null && typeof compose === "object" ? (Array.isArray(compose) ? compose.map((x, i): [string, unknown] => [String(i), x]) : Object.entries(compose)) : null;
  const field = (entry: unknown, key: string): unknown => (entry !== null && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>)[key] : undefined);
  return obj({
    uuid: rowValue(row, "uuid") as PhpValue,
    pull_request_id: Number(rowValue(row, "pull_request_id")),
    pull_request_html_url: phpFalsy(rowValue(row, "pull_request_html_url")) ? null : (rowValue(row, "pull_request_html_url") as string),
    git_type: (rowValue(row, "git_type") ?? null) as PhpValue,
    status: rowValue(row, "status") as PhpValue,
    domains: (rowValue(row, "fqdn") ?? null) as PhpValue,
    docker_compose_domains: entries === null ? null : entries.map(([name, entry]) => obj({ name, domain: phpFalsy(field(entry, "domain")) ? null : fromJs(field(entry, "domain")), redirect: fromJs(field(entry, "redirect") ?? null) })),
    domain_port_overrides: arrayCast(rowValue(row, "domain_port_overrides")),
    docker_registry_image_tag: (rowValue(row, "docker_registry_image_tag") ?? null) as PhpValue,
    last_online_at: sqlDate(asDate(rowValue(row, "last_online_at"))),
    created_at: laravelDate(asDate(rowValue(row, "created_at"))),
    updated_at: laravelDate(asDate(rowValue(row, "updated_at"))),
  });
}

const denied = async (c: ApiV1Context, write: boolean, policyMessage?: string): Promise<CoolifyAnswer | null> => ((await c.allows(write)) ? null : COOLIFY_API.unauthorized(policyMessage));

/** $request->all(): the JSON body (as the middleware cleaned it), then the query string's keys the body does not have. */
async function requestAll(c: ApiV1Context): Promise<Record<string, unknown>> {
  const body = await readApiBody(c.request);
  const all: Record<string, unknown> = { ...body.all };
  const query: Record<string, string> = {};
  c.url.searchParams.forEach((v, k) => (query[k] = v));
  for (const [k, v] of Object.entries(cleanInput(query) as Record<string, unknown>)) if (!(k in all)) all[k] = v;
  return all;
}

/** $request->boolean($key, $default): filter_var(FILTER_VALIDATE_BOOLEAN), the default when absent. */
const inputBoolean = (all: Record<string, unknown>, key: string, fallback: boolean): boolean => (key in all ? requestBoolean(all, key) : fallback);
/** $request->filled($key) */
const filled = (v: unknown): boolean => !(v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));

async function listPreviews(c: ApiV1Context, appUuid: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const app = await applicationRow(rows, appUuid);
    if (!app) return message(PREVIEWS_API_MESSAGES.applicationNotFound, 404);
    return (await denied(c, false)) ?? coolifyJson((await previewRows(rows, rowValue(app, "id"))).map(formatPreview));
  });
}

/** The application (its 404), the policy, the pull request id (its 422) and the preview (its 404). */
async function lookup(tx: SqlExecutor, c: ApiV1Context, appUuid: string, raw: string, write: boolean, policyMessage?: string): Promise<{ app: ApiRow; preview: ApiRow } | CoolifyAnswer> {
  const rows = rowsOf(tx);
  const app = await applicationRow(rows, appUuid);
  if (!app) return message(PREVIEWS_API_MESSAGES.applicationNotFound, 404);
  const no = await denied(c, write, policyMessage);
  if (no) return no;
  const pullRequestId = pullRequestIdOf(raw);
  if (pullRequestId === null) return message(PREVIEWS_API_MESSAGES.invalidPullRequestId, 422);
  const preview = (await previewRows(rows, rowValue(app, "id"), pullRequestId))[0];
  return preview ? { app, preview } : message(PREVIEWS_API_MESSAGES.previewNotFound, 404);
}
const isAnswer = (v: unknown): v is CoolifyAnswer => typeof v === "object" && v !== null && "status" in v && "body" in v;

async function showPreview(c: ApiV1Context, appUuid: string, raw: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await lookup(tx, c, appUuid, raw, false);
    return isAnswer(found) ? found : coolifyJson(formatPreview(found.preview));
  });
}

/** logs_by_uuid() with a pull request: the checks, then getContainerLogs() on the server (501). */
async function previewLogs(c: ApiV1Context, appUuid: string, raw: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await lookup(tx, c, appUuid, raw, false);
    return isAnswer(found) ? found : unavailable(PREVIEWS_API_MESSAGES.logsUnavailable);
  });
}

/** $application->destination->server is functional. */
async function serverFunctional(rows: Rows, app: ApiRow): Promise<boolean> {
  const destination = (await rows("standalone_dockers", "t.id = $1", [rowValue(app, "destination_id")]))[0];
  const server = destination ? ((await rows("servers", "t.deleted_at IS NULL AND t.id = $1", [rowValue(destination, "server_id")]))[0] ?? null) : null;
  const settings = server ? (await rows("server_settings", "t.server_id = $1", [rowValue(server, "id")]))[0] : undefined;
  return functional(server, settings);
}

/**
 * delete_preview_by_pull_request_id(): the preview soft-deleted, then CleanupPreviewDeployment, which does nothing on a
 * server that is not functional; on a functional one it cancels the deployments and stops the containers there (501).
 */
async function deletePreview(c: ApiV1Context, appUuid: string, raw: string): Promise<CoolifyAnswer> {
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await lookup(tx, c, appUuid, raw, true);
    if (isAnswer(found)) return found;
    if (await serverFunctional(rowsOf(tx), found.app)) return unavailable(PREVIEWS_API_MESSAGES.cleanupUnavailable);
    await softDeleteApplicationPreview(tx, rowValue(found.preview, "id") as number);
    return message(PREVIEWS_API_MESSAGES.deleted, 200);
  });
}

// ── store ───────────────────────────────────────────────────────────────────

const MORPH = { github: "App\\Models\\GithubApp", gitlab: "App\\Models\\GitlabApp", gitea: "App\\Models\\GiteaApp" } as const;

/** sourceGitType(): the application's source (a GitHub App — the public GitHub source is id 0 —, a GitLab or Gitea App). */
async function sourceGitType(tx: SqlExecutor, app: ApiRow): Promise<string | null> {
  const type = rowValue(app, "source_type");
  const id = rowValue(app, "source_id");
  if (id === null || id === undefined) return null;
  if (type === PUBLIC_GITHUB_SOURCE.type && Number(id) === PUBLIC_GITHUB_SOURCE.id) return "github";
  const table = type === MORPH.github ? "github_apps" : type === MORPH.gitlab ? "gitlab_apps" : type === MORPH.gitea ? "gitea_apps" : null;
  if (table === null) return null;
  const r = await tx.execute(`SELECT 1 FROM deploy.${table} WHERE id = $1`, [id]);
  if (r.rows.length === 0) return null;
  return type === MORPH.github ? "github" : type === MORPH.gitlab ? "gitlab" : "gitea";
}

const DOCKER_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const COMMIT = /^[0-9a-fA-F]{7,40}$/;

async function storePreview(c: ApiV1Context, appUuid: string): Promise<CoolifyAnswer> {
  const all = await requestAll(c);
  return c.sql(c.env, c.orgId, async (tx) => {
    const rows = rowsOf(tx);
    const app = await applicationRow(rows, appUuid);
    if (!app) return message(PREVIEWS_API_MESSAGES.applicationNotFound, 404);
    // authorize('deploy'): policy-worker's write.
    const no = await denied(c, true);
    if (no) return no;
    const buildPack = rowValue(app, "build_pack");
    const isDockerImage = buildPack === "dockerimage";
    const gitBased = phpFalsy(rowValue(app, "dockerfile")) && !isDockerImage;
    if (!isDockerImage && !gitBased) return message(PREVIEWS_API_MESSAGES.notPreviewable, 400);
    const rules: Rules = [
      ["pull_request_id", ["required", "integer", "min:1", "max:2147483647"]],
      ["pull_request_html_url", ["nullable", "url", "max:2048"]],
      ["force", ["boolean"]],
      ["instant_deploy", ["boolean"]],
      ...(isDockerImage
        ? ([
            ["git_type", ["missing"]],
            ["commit", ["missing"]],
            ["docker_tag", ["nullable", "string", { regex: DOCKER_TAG }]],
          ] as Rules)
        : ([
            ["git_type", ["nullable", "string", { in: GIT_TYPES }]],
            ["commit", ["nullable", "string", { regex: COMMIT }, { requiredIf: ["git_type", "bitbucket"] }]],
            ["docker_tag", ["missing"]],
          ] as Rules)),
    ];
    const errors: Errors = [];
    await validateRules(errors, all, rules, { laravelMessages: true });
    if (errors.length) return validationFailed(errors);

    const pullRequestId = Math.trunc(Number(all.pull_request_id));
    const tagInput = all.docker_tag;
    const dockerTag = tagInput === null || tagInput === undefined ? null : String(tagInput).trim() || null;
    const preview = (await previewRows(rows, rowValue(app, "id"), pullRequestId))[0] ?? null;
    const inputGitType = (all.git_type ?? null) as string | null;
    const gitType = inputGitType ?? ((preview ? rowValue(preview, "git_type") : null) as string | null) ?? (await sourceGitType(tx, app));
    if (!isDockerImage && gitType === null) return coolifyJson(obj({ message: "Validation failed.", errors: obj({ git_type: [PREVIEWS_API_MESSAGES.gitTypeRequired] }) }), 422);
    if (isDockerImage && dockerTag === null && phpBlank(preview ? rowValue(preview, "docker_registry_image_tag") : null)) {
      return coolifyJson(obj({ message: "Validation failed.", errors: obj({ docker_tag: [PREVIEWS_API_MESSAGES.dockerTagRequired] }) }), 422);
    }
    const htmlUrl = (all.pull_request_html_url ?? null) as string | null;
    const changesPreview =
      !preview ||
      (htmlUrl !== null && htmlUrl !== rowValue(preview, "pull_request_html_url")) ||
      (inputGitType !== null && inputGitType !== rowValue(preview, "git_type")) ||
      (dockerTag !== null && dockerTag !== rowValue(preview, "docker_registry_image_tag")) ||
      filled(all.commit);
    if (changesPreview) {
      if (!c.abilities.includes("write") && !c.abilities.includes("root")) return message(PREVIEWS_API_MESSAGES.writeNeeded, 403);
      const again = await denied(c, true, POLICY_DENIALS.applicationUpdate);
      if (again) return again;
    }
    // Freeploy's: refused before anything is stored.
    if (!preview && buildPack === "dockercompose") return unavailable(PREVIEWS_API_MESSAGES.composeUnavailable);
    if (inputBoolean(all, "instant_deploy", true)) return unavailable(PREVIEWS_API_MESSAGES.deployUnavailable);

    let id: number;
    if (!preview) {
      const created = await insertApplicationPreview(tx, {
        orgId: c.orgId,
        uuid: newPublicId(),
        applicationId: rowValue(app, "id") as number,
        pullRequestId,
        pullRequestHtmlUrl: htmlUrl ?? "",
        gitType: isDockerImage ? null : gitType,
        dockerComposeDomains: null,
        dockerRegistryImageTag: dockerTag,
      });
      id = Number(created.id);
      await generatePreviewFqdn(tx, app, id, pullRequestId);
    } else {
      // fill(array_filter([...], not null)) and save(): only what changed is written.
      id = Number(rowValue(preview, "id"));
      const changes: ApplicationPreviewChanges = {};
      if (htmlUrl !== null && htmlUrl !== rowValue(preview, "pull_request_html_url")) changes.pull_request_html_url = htmlUrl;
      if (!isDockerImage && gitType !== rowValue(preview, "git_type")) changes.git_type = gitType;
      if (dockerTag !== null && dockerTag !== rowValue(preview, "docker_registry_image_tag")) changes.docker_registry_image_tag = dockerTag;
      await updateApplicationPreview(tx, id, changes);
    }
    const refreshed = (await rows("application_previews", "t.id = $1", [id]))[0]!;
    return coolifyJson(obj({ message: preview ? "Preview updated." : "Preview created.", deployment_uuid: null, preview: formatPreview(refreshed) }), preview ? 200 : 201);
  });
}

const phpBlank = (v: unknown): boolean => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

const overridesOf = (v: unknown): Record<string, number | string> | null => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number | string>) : null);

/** generate_preview_fqdn(): the first of the application's domains through the preview URL template, then the saving hook. */
async function generatePreviewFqdn(tx: SqlExecutor, app: ApiRow, id: number, pullRequestId: number): Promise<void> {
  const fqdn = rowValue(app, "fqdn");
  if (phpFalsy(fqdn)) return;
  const text = String(fqdn);
  const source = text.includes(",") ? text.split(",")[0]! : text;
  const appOverrides = overridesOf(rowValue(app, "domain_port_overrides"));
  const generated = generatedPreviewDomain(source, (rowValue(app, "preview_url_template") ?? null) as string | null, pullRequestId, appOverrides as Record<string, number> | null, newPublicId());
  const normalized = normalizeDomainPortOverrides(generated.url, generated.port !== null ? { [generated.url]: generated.port } : null);
  await updateApplicationPreview(tx, id, { fqdn: normalized.fqdn, domain_port_overrides: normalized.overrides });
}

// ── update ──────────────────────────────────────────────────────────────────

/** ValidationPatterns::applicationDomainRules() */
const DOMAIN_RULES: Rule[] = ["nullable", "string", "max:2048", { closure: (v) => validateApplicationDomains(v) }];

/** MessageBag::add() keeps a message once per key. */
const unique = (errors: Errors): Errors => errors.map(([k, list]) => [k, [...new Set(list)]]);

async function updatePreview(c: ApiV1Context, appUuid: string, raw: string): Promise<CoolifyAnswer> {
  const all = await requestAll(c);
  return c.sql(c.env, c.orgId, async (tx) => {
    const found = await lookup(tx, c, appUuid, raw, true, POLICY_DENIALS.applicationUpdate);
    if (isAnswer(found)) return found;
    const { app, preview } = found;
    const isCompose = rowValue(app, "build_pack") === "dockercompose";
    const rules: Rules = [["force_domain_override", ["boolean"]]];
    if (isCompose) {
      rules.push(
        ["domains", ["missing"]],
        ["docker_compose_domains", ["present", "array"]],
        ["docker_compose_domains.*", [{ arrayKeys: ["name", "domain", "redirect"], message: "The :attribute field must be an array." }]],
        ["docker_compose_domains.*.name", ["required", "string", "distinct"]],
        ["docker_compose_domains.*.domain", DOMAIN_RULES],
        ["docker_compose_domains.*.redirect", ["nullable", "string", { in: REDIRECTS }]],
      );
    } else {
      rules.push(["domains", ["present", ...DOMAIN_RULES]], ["docker_compose_domains", ["missing"]]);
    }
    const errors: Errors = [];
    await validateRules(errors, all, rules, { laravelMessages: true, laravelWildcards: true });
    if (errors.length) return validationFailed(unique(errors));
    const errorKey = isCompose ? "docker_compose_domains" : "domains";
    const failedWith = (text: string) => coolifyJson(obj({ message: "Validation failed.", errors: obj({ [errorKey]: text }) }), 422);

    let domains: string | null;
    let composeDomains: Array<[string, Record<string, string>]> | null = null;
    if (isCompose) {
      let compose: ComposeValue;
      try {
        compose = parseDockerComposeYaml(String(rowValue(app, "docker_compose_raw") ?? ""));
      } catch {
        return failedWith(PREVIEWS_API_MESSAGES.composeUnparsable);
      }
      const services = isPhpArray(compose) ? compose.get("services") : undefined;
      if (!isPhpArray(services) || services.size === 0) return failedWith(PREVIEWS_API_MESSAGES.composeNoServices);
      const imageOf = (service: ComposeValue): string | null => {
        const image = isPhpArray(service) ? service.get("image") : undefined;
        return image === undefined || image === null ? null : phpString(image);
      };
      const composeServices = services
        .entries()
        .filter(([, service]) => !isDatabaseImage(imageOf(service)))
        .map(([name]) => String(name));
      const items = (Array.isArray(all.docker_compose_domains) ? all.docker_compose_domains : Object.values(all.docker_compose_domains as Record<string, unknown>)) as Array<Record<string, unknown>>;
      if (items.some((item) => !composeServices.includes(String(item.name)))) return failedWith(PREVIEWS_API_MESSAGES.composeInvalidServices);
      const existing = decodeJson(rowValue(preview, "docker_compose_domains") ?? "[]");
      const existingRedirect = (name: string): unknown => {
        const entry = existing !== null && typeof existing === "object" ? (existing as Record<string, unknown>)[name] : undefined;
        return entry !== null && typeof entry === "object" ? (entry as Record<string, unknown>).redirect : undefined;
      };
      const map = new Map<string, Record<string, string>>();
      for (const service of composeServices) {
        const entry: Record<string, string> = { domain: "" };
        const redirect = existingRedirect(service);
        if (typeof redirect === "string" && (REDIRECTS as readonly string[]).includes(redirect)) entry.redirect = redirect;
        map.set(service, entry);
      }
      for (const item of items) {
        const name = String(item.name);
        const entry: Record<string, string> = { domain: normalizeApplicationDomains(typeof item.domain === "string" ? item.domain : null) ?? "" };
        const redirect = "redirect" in item ? item.redirect : existingRedirect(name);
        if (typeof redirect === "string" && (REDIRECTS as readonly string[]).includes(redirect)) entry.redirect = redirect;
        map.set(name, entry);
      }
      composeDomains = [...map];
      domains =
        composeDomains
          .map(([, e]) => e.domain)
          .filter((d) => !phpFalsy(d))
          .join(",") || null;
    } else {
      domains = normalizeApplicationDomains(typeof all.domains === "string" ? all.domains : null);
    }
    const submitted = applicationDomainList(domains).map(domainWithoutPort);
    if (new Set(submitted).size !== submitted.length) return failedWith(PREVIEWS_API_MESSAGES.sameDomainTwice);
    const normalized = normalizeDomainPortOverrides(domains, null);
    const portless = normalized.fqdn;
    let composeResponse: PhpValue = null;
    if (composeDomains) {
      for (const [, entry] of composeDomains) entry.domain = applicationDomainList(entry.domain).map(domainWithoutPort).join(",");
      composeResponse = composeDomains.map(([name, entry]) => obj({ name, ...entry }));
    }
    const urls = applicationDomainList(portless);
    const force = inputBoolean(all, "force_domain_override", false);
    const noMemory = { service: { uuid: "", name: "" }, applications: () => [] } as unknown as ServiceStore;
    const conflicts = await domainConflicts(tx, noMemory, urls, "");
    if (conflicts.length && !force) return coolifyJson(obj({ message: "Domain conflicts detected. Use force_domain_override=true to proceed.", conflicts, warning: CONFLICT_WARNING }), 409);

    // Another preview of the org's applications that has one of the domains.
    const rows = rowsOf(tx);
    const previewId = Number(rowValue(preview, "id"));
    const hosts = urls.map((u) => hostOf(u)).filter((h) => h !== "");
    let conflicting: { row: ApiRow; domain: string } | null = null;
    if (hosts.length) {
      const appIds = (await rows("applications", "t.deleted_at IS NULL")).map((a) => rowValue(a, "id"));
      const others = (await rows("application_previews", "t.deleted_at IS NULL AND t.fqdn IS NOT NULL AND t.id <> $1 AND t.application_id = ANY($2)", [previewId, appIds])).filter((p) =>
        hosts.some((h) => String(rowValue(p, "fqdn")).includes(h)),
      );
      for (const other of others) {
        const domain = applicationDomainList(String(rowValue(other, "fqdn"))).map(domainWithoutPort).find((d) => urls.includes(d));
        if (domain !== undefined) {
          conflicting = { row: other, domain };
          break;
        }
      }
    }
    if (conflicting && !force) {
      const conflict = obj({
        domain: conflicting.domain,
        resource_name: `Preview deployment #${String(rowValue(conflicting.row, "pull_request_id"))}`,
        resource_uuid: rowValue(conflicting.row, "uuid") as PhpValue,
        resource_type: "application",
        message: "Domain is already in use by another preview deployment.",
      });
      return coolifyJson(obj({ message: "Domain conflicts detected. Use force_domain_override=true to proceed.", conflicts: [conflict], warning: CONFLICT_WARNING }), 409);
    }
    // application_previews' unique fqdn: Coolify's UniqueConstraintViolationException, its error page.
    if (portless !== null && portless !== rowValue(preview, "fqdn")) {
      const taken = await tx.execute("SELECT 1 FROM deploy.application_previews WHERE fqdn = $1 AND id <> $2", [portless, previewId]);
      if (taken.rows.length) return SERVER_ERROR;
    }
    // save(): what changed; the saving hook normalizes a changed fqdn again (the same result).
    const changes: ApplicationPreviewChanges = {};
    const storedOverrides = rowValue(preview, "domain_port_overrides") ?? null;
    if (portless !== (rowValue(preview, "fqdn") ?? null)) changes.fqdn = portless;
    if (JSON.stringify(normalized.overrides) !== JSON.stringify(storedOverrides)) changes.domain_port_overrides = normalized.overrides;
    if (composeDomains) {
      // json_encode() of the map (an empty one is PHP's empty array).
      const text = composeDomains.length === 0 ? "[]" : phpJsonEncode(obj(composeDomains.map(([name, entry]): [string, PhpValue] => [name, obj(entry)])));
      if (text !== rowValue(preview, "docker_compose_domains")) changes.docker_compose_domains = text;
    }
    await updateApplicationPreview(tx, previewId, changes);
    return coolifyJson(
      obj({
        uuid: rowValue(preview, "uuid") as PhpValue,
        pull_request_id: Number(rowValue(preview, "pull_request_id")),
        domains: portless,
        docker_compose_domains: composeResponse,
        domain_port_overrides: normalized.overrides === null ? null : fromJs(normalized.overrides),
      }),
    );
  });
}

/** parse_url($url, PHP_URL_HOST) of a domain the rules accepted. */
function hostOf(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(url);
  return m ? m[1]! : "";
}
