// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/{ProjectController,SecurityController,
// ServersController}.php and bootstrap/helpers/api.php (getTeamIdFromToken, serializeApiResponse)
// (Apache-2.0), modified.
//
// Coolify's /api/v1 for projects, environments, private keys and servers, answered for api-edge once it has
// resolved the token (x-api-v1-* headers) — on the services the console's routes use, so the rules are the
// same. Bodies, messages, key order and status codes are Coolify's controllers'.
//
//   /v1/internal/api-v1/{org}/projects[/{uuid}[/environments[/{environment_name_or_uuid}]]]
//   /v1/internal/api-v1/{org}/security/keys[/{uuid}]
//   /v1/internal/api-v1/{org}/servers[/{uuid}[/validate]]
//   /v1/internal/api-v1/{org}/applications[/{uuid}[/envs[/bulk|/{env_uuid}]|/logs|/start|/restart|/stop]]   applications.ts (DP-71)
//   /v1/internal/api-v1/{org}/databases[/{engine}|/{uuid}[/backups[/{backup}[/executions[/{execution}]]]|/start|/restart|/stop]]
//                                                                                    databases.ts (DP-73)
//   /v1/internal/api-v1/{org}/services[/{uuid}[/envs[/bulk|/{env_uuid}]|/start|/restart|/stop]]   services.ts (DP-74)
//   /v1/internal/api-v1/{org}/deployments/{applications/{uuid}|{uuid}/cancel}, /deploy                       deployments.ts (DP-74)
//   /v1/internal/api-v1/{org}/deployments[/{uuid}]                                                           deployments.ts (DP-78)
//   /v1/internal/api-v1/{org}/resources, /projects/{uuid}/{environment_name_or_uuid}                          resources.ts (DP-78)
//   /v1/internal/api-v1/{org}/projects/{uuid}[/environments/{environment_name_or_uuid}]/envs[/{env_id}]       shared-variables.ts (DP-81)
//   /v1/internal/api-v1/{org}/tags[/{uuid}], /{applications,databases,services}/{uuid}/tags[/{tag_uuid}]    tags.ts (DP-81)
//   /v1/internal/api-v1/{org}/s3-storages[/{uuid}[/validate]]                                                 s3-storages.ts (DP-81)
//   /v1/internal/api-v1/{org}/{applications,databases,services}/{uuid}/storages[/{storage_uuid}]             storages.ts (DP-84)
//   /v1/internal/api-v1/{org}/{applications,services}/{uuid}/scheduled-tasks[/{task_uuid}[/executions]]     scheduled-tasks.ts (DP-84)
//   /v1/internal/api-v1/{org}/databases/{uuid}/envs[/bulk|/{env_uuid}]                                       database-envs.ts (DP-84)
//   /v1/internal/api-v1/{org}/team/envs[/{env_id}]                                                           shared-variables.ts (DP-84)
//
// $this->authorize(…) is policy-worker's deploy.resource.read (view) or deploy.resource.write (create,
// update, delete) for the token's user; a denial is Laravel's 403 "This action is unauthorized.".
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { apiRows, withOrg, type ApiRow, type ApiTable } from "@saas/db/deploy";
import {
  API_V1_HEADERS,
  COOLIFY_API,
  coolifyJson,
  obj,
  put,
  serializeApiCollection,
  serializeApiResponse,
  type CoolifyAnswer,
  type CoolifyTeamFacts,
  type PhpObject,
  type PhpValue,
} from "@saas/contracts/coolify-api";
import { fetchAuthorizationContext, fetchOrganizationFacts } from "../membership-client.js";
import { authorizeViaPolicy } from "../policy-client.js";
import { runInOrg as runProjects, type ProjectsRunner } from "../handlers/projects.js";
import { runInOrg as runKeys, type OrgRunner } from "../handlers/private-keys.js";
import { customizeEnvironmentName, ProjectError } from "../projects/service.js";
import { createAndStore, deletePrivateKey, PrivateKeyError, updatePrivateKey } from "../private-keys/service.js";
import { fingerprintSha256, formatPrivateKey, publicKeyOpenSSH, validationError as keyValidationError } from "../keys/ssh-keys.js";
import { generateRandomName, newPublicId } from "../helpers/names.js";
import { isTransferredAway, effectiveServerRole } from "../servers/service.js";
import { SERVER_SERVICE_MESSAGES } from "../servers/service.js";
import {
  booleanRule,
  descriptionRules,
  extraFields,
  nameRules,
  readApiBody,
  requestBoolean,
  stringRule,
  validationFailed,
  type Errors,
} from "./request.js";
import { applicationsApi } from "./applications.js";
import { databasesApi } from "./databases.js";
import { servicesApi } from "./services.js";
import { deployApi, deploymentsApi } from "./deployments.js";
import { environmentDetails, listResources } from "./resources.js";
import { serverResourcesPayload, serversApi } from "./servers.js";
import { resourceTagsApi, tagsApi, type TaggableKind } from "./tags.js";
import { sharedVariablesApi, teamSharedVariablesApi } from "./shared-variables.js";
import { s3StoragesApi } from "./s3-storages.js";
import { storagesApi, type StorageKind } from "./storages.js";
import { scheduledTasksApi } from "./scheduled-tasks.js";
import { databaseEnvsApi } from "./database-envs.js";
import { s3Fetch } from "../s3-storages/connection.js";
import { dohResolver } from "../s3-storages/safe-url.js";
import type { S3StorageNetwork } from "../s3-storages/service.js";
import type { ApiV1Context, SqlRunner } from "./context.js";
import { ENVIRONMENT, PRIVATE_KEY, PROJECT, SERVER, SERVER_SETTING, onlyColumns, rowValue, toModel, withoutColumns } from "./models.js";

/** The groups whose resources HandlesTagsApi tags (DP-81). */
const TAGGABLES: Record<string, TaggableKind> = { applications: "application", databases: "database", services: "service" };
/** The groups whose resources have storages (DP-84); an application's and a service's have scheduled tasks. */
const STORAGE_OWNERS: Record<string, StorageKind> = { applications: "application", databases: "database", services: "service" };

export const API_V1_INTERNAL_RE =/^\/v1\/internal\/api-v1\/(org_[0-9a-f]{32})(\/.*)$/;

/** Reads whole rows of one org (apiRows inside withOrg). */
export type RowsRunner = <T>(env: Env, orgId: string, fn: (rows: (table: ApiTable, where?: string, params?: unknown[]) => Promise<ApiRow[]>) => Promise<T>) => Promise<T>;

export const runRows: RowsRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn((table, where, params) => apiRows(tx, table, where ?? null, params ?? [])));
  } finally {
    await db.dispose();
  }
};

export interface ApiV1Runners {
  projects: ProjectsRunner;
  keys: OrgRunner;
  rows: RowsRunner;
  /** One org's transaction, for the groups that call the services with their SQL stores (DP-71). */
  sql?: SqlRunner;
  /** policy-worker's answer for the token's user; replaceable for tests. */
  allows?: (action: "deploy.resource.read" | "deploy.resource.write") => Promise<boolean>;
  /** The org as membership-worker shows it to the token's user (DP-78); replaceable for tests. */
  org?: () => Promise<CoolifyTeamFacts | null>;
  /** An S3 storage's connection test: the resolver and the HTTP exchange (DP-81); replaceable for tests. */
  s3?: S3StorageNetwork;
}

export const runSql: SqlRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, fn);
  } finally {
    await db.dispose();
  }
};

const DEFAULT_RUNNERS: ApiV1Runners = { projects: runProjects, keys: runKeys, rows: runRows, sql: runSql };

const send = (a: CoolifyAnswer): Response => new Response(a.body, { status: a.status, headers: a.headers });
const message = (text: string, status: number, extra: Record<string, PhpValue> = {}) => coolifyJson(obj({ message: text, ...extra }), status);

/** "Created by Coolify via API", the brand swapped. */
export const API_KEY_DESCRIPTION = "Created by Freeploy via API";

export async function handleApiV1(request: Request, env: Env, requestId: string, actor: ActorContext, orgId: string, orgPublicId: string, path: string, runners: Partial<ApiV1Runners> = {}): Promise<Response> {
  const r = { ...DEFAULT_RUNNERS, ...runners };
  const canReadSensitive = request.headers.get(API_V1_HEADERS.canReadSensitive) === "1";
  const abilities = (request.headers.get(API_V1_HEADERS.abilities) ?? "").split(",").filter(Boolean);
  const method = request.method.toUpperCase();
  const segments = path.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  const url = new URL(request.url);

  // getTeamIdFromToken(): the token's user must still be in the team (api-edge checked; a race ends here).
  let membershipFacts: Awaited<ReturnType<typeof fetchAuthorizationContext>> | null = null;
  const allows =
    r.allows ??
    (async (action: "deploy.resource.read" | "deploy.resource.write") => {
      membershipFacts ??= await fetchAuthorizationContext(env.MEMBERSHIP_WORKER!, actor.subjectId, actor.subjectType, orgId, requestId);
      if (!membershipFacts.ok) return false;
      const res = await authorizeViaPolicy(env.POLICY_WORKER!, actor.subjectId, actor.subjectType, action, { kind: "organization", orgId: orgId as never }, membershipFacts.memberships, requestId);
      return res.allow;
    });
  const authorize = async (write: boolean): Promise<CoolifyAnswer | null> => ((await allows(write ? "deploy.resource.write" : "deploy.resource.read")) ? null : COOLIFY_API.unauthorized());

  try {
    const [first, second, third, fourth, fifth] = segments;
    const org = r.org ?? (() => fetchOrganizationFacts(env.MEMBERSHIP_WORKER!, orgPublicId, actor.subjectId, actor.subjectType, requestId));
    const context: ApiV1Context = { env, orgId, orgPublicId, request, method, url, canReadSensitive, abilities, allows: (write) => allows(write ? "deploy.resource.write" : "deploy.resource.read"), sql: r.sql ?? runSql, org, s3: r.s3 ?? { http: s3Fetch, resolve: dohResolver } };
    // DP-81: the shared variables of a project (/projects/{uuid}/envs) and of an environment (…/environments/{env}/envs).
    if (first === "projects" && second !== undefined && third === "envs") return send((await sharedVariablesApi(context, second, undefined, segments.slice(3))) ?? COOLIFY_API.notFound());
    if (first === "projects" && second !== undefined && third === "environments" && fourth !== undefined && fifth === "envs") return send((await sharedVariablesApi(context, second, fourth, segments.slice(5))) ?? COOLIFY_API.notFound());
    // GET /projects/{uuid}/{environment_name_or_uuid} (DP-78): after /projects/{uuid}/environments and /projects/{uuid}/envs.
    if (first === "projects" && second !== undefined && third !== undefined && third !== "environments" && third !== "envs" && fourth === undefined && method === "GET") {
      return send(await environmentDetails(context, second, third, () => authorize(false)));
    }
    if (first === "projects") return send(await projects(second, third, fourth, fifth));
    if (first === "security" && second === "keys") return send(await keys(third, fourth));
    if (first === "servers" && fourth === undefined) {
      const answer = await serversApi(context, second, third);
      if (answer) return send(answer);
    }
    if (first === "servers") return send(await servers(second, third, fourth));
    if (first === "resources" && second === undefined) return send(method === "GET" ? await listResources(context) : COOLIFY_API.notFound());
    // DP-81: the team's tags, and the tags of an application, a database and a service (HandlesTagsApi).
    if (first === "tags") return send((await tagsApi(context, segments.slice(1))) ?? COOLIFY_API.notFound());
    const taggable = TAGGABLES[first ?? ""];
    if (taggable && second !== undefined && third === "tags") return send((await resourceTagsApi(context, taggable, second, segments.slice(3))) ?? COOLIFY_API.notFound());
    // DP-81: S3 storages
    if (first === "s3-storages") return send((await s3StoragesApi(context, segments.slice(1))) ?? COOLIFY_API.notFound());
    // DP-84: a resource's storages, an application's and a service's scheduled tasks, a database's variables, the team's shared variables.
    const storageOwner = STORAGE_OWNERS[first ?? ""];
    if (storageOwner && second !== undefined && third === "storages") return send((await storagesApi(context, storageOwner, second, segments.slice(3))) ?? COOLIFY_API.notFound());
    if ((first === "applications" || first === "services") && second !== undefined && third === "scheduled-tasks") {
      return send((await scheduledTasksApi(context, first === "applications" ? "application" : "service", second, segments.slice(3))) ?? COOLIFY_API.notFound());
    }
    if (first === "databases" && second !== undefined && third === "envs") return send((await databaseEnvsApi(context, second, segments.slice(3))) ?? COOLIFY_API.notFound());
    if (first === "team" && second === "envs") return send((await teamSharedVariablesApi(context, segments.slice(2))) ?? COOLIFY_API.notFound());
    if (first === "applications") return send((await applicationsApi(context, segments.slice(1))) ?? COOLIFY_API.notFound());
    if (first === "databases") return send((await databasesApi(context, segments.slice(1))) ?? COOLIFY_API.notFound());
    if (first === "services") return send((await servicesApi(context, segments.slice(1))) ?? COOLIFY_API.notFound());
    if (first === "deployments") return send((await deploymentsApi(context, segments.slice(1))) ?? COOLIFY_API.notFound());
    if (first === "deploy") return send((await deployApi(context, segments.slice(1))) ?? COOLIFY_API.notFound());
    return send(COOLIFY_API.notFound());
  } catch (e) {
    if (e instanceof PrivateKeyError && e.field) return send(message(e.message, 422, { errors: obj({ [e.field]: [e.message] }) }));
    return send({ status: 500, body: '{"message":"Server Error"}', headers: { "content-type": "application/json" } });
  }

  // ── projects and environments ─────────────────────────────────────────────

  async function projects(uuid?: string, sub?: string, env2?: string, extra?: string): Promise<CoolifyAnswer> {
    if (extra !== undefined) return COOLIFY_API.notFound();
    if (uuid === undefined) return method === "GET" ? listProjects() : method === "POST" ? createProject() : COOLIFY_API.notFound();
    if (sub === undefined) return method === "GET" ? showProject(uuid) : method === "PATCH" ? updateProject(uuid) : method === "DELETE" ? deleteProject(uuid) : COOLIFY_API.notFound();
    if (sub !== "environments") return COOLIFY_API.notFound();
    if (env2 === undefined) return method === "GET" ? listEnvironments(uuid) : method === "POST" ? createEnvironment(uuid) : COOLIFY_API.notFound();
    return method === "PATCH" ? updateEnvironment(uuid, env2) : method === "DELETE" ? deleteEnvironment(uuid, env2) : COOLIFY_API.notFound();
  }

  /** Project::whereTeamId()->select('id', 'name', 'description', 'uuid')->get() */
  async function listProjects(): Promise<CoolifyAnswer> {
    const rows = await r.rows(env, orgId, (rows) => rows("projects"));
    return coolifyJson(serializeApiCollection(rows.map((row) => toModel(onlyColumns(row, ["id", "name", "description", "uuid"]), PROJECT))));
  }

  async function projectRow(uuid: string): Promise<ApiRow | null> {
    return (await r.rows(env, orgId, (rows) => rows("projects", "t.uuid = $1", [uuid])))[0] ?? null;
  }

  async function showProject(uuid: string): Promise<CoolifyAnswer> {
    const row = await projectRow(uuid);
    if (!row) return message("Project not found.", 404);
    const denied = await authorize(false);
    if (denied) return denied;
    const envs = await r.rows(env, orgId, (rows) => rows("environments", "t.project_id = $1", [rowValue(row, "id")]));
    const model = toModel(row, PROJECT, { teamId: orgPublicId, extra: [["environments", envs.map((e) => toModel(e, ENVIRONMENT))]] });
    return coolifyJson(serializeApiResponse(model));
  }

  async function createProject(): Promise<CoolifyAnswer> {
    const denied = await authorize(true);
    if (denied) return denied;
    const body = await readApiBody(request);
    if (body.incomingError) return body.incomingError;
    const errors: Errors = [];
    nameRules(errors, body.all, "name");
    descriptionRules(errors, body.all);
    extraFields(errors, body.all, ["name", "description"]);
    if (errors.length) return validationFailed(errors);
    const description = (body.all.description as string | null | undefined) ?? null;
    const created = await r.projects(env, orgId, (store) => store.insert({ uuid: newPublicId(), name: body.all.name as string, description, productionEnvironmentUuid: newPublicId() }));
    return coolifyJson(obj({ uuid: created.project.uuid }), 201);
  }

  async function updateProject(uuid: string): Promise<CoolifyAnswer> {
    const body = await readApiBody(request);
    if (body.incomingError) return body.incomingError;
    const errors: Errors = [];
    nameRules(errors, body.all, "name", { required: false });
    descriptionRules(errors, body.all);
    extraFields(errors, body.all, ["name", "description"]);
    if (errors.length) return validationFailed(errors);
    const result = await r.projects(env, orgId, async (store) => {
      const project = await store.findByUuid(uuid);
      if (!project) return null;
      if (!(await allows("deploy.resource.write"))) return "denied" as const;
      // $project->update($request->only(['name', 'description']))
      const name = "name" in body.all ? (body.all.name as string | null) ?? project.name : project.name;
      const description = "description" in body.all ? ((body.all.description as string | null) ?? null) : project.description ?? null;
      return store.update(project.id, { name, description });
    });
    if (result === "denied") return COOLIFY_API.unauthorized();
    if (!result) return message("Project not found.", 404);
    return coolifyJson(obj({ uuid: result.uuid, name: result.name, description: result.description ?? null }), 201);
  }

  async function deleteProject(uuid: string): Promise<CoolifyAnswer> {
    const result = await r.projects(env, orgId, async (store) => {
      const project = await store.findByUuid(uuid);
      if (!project) return "missing" as const;
      if (!(await allows("deploy.resource.write"))) return "denied" as const;
      if (await store.projectHasResources(project.id)) return "busy" as const;
      await store.delete(project.id);
      return "deleted" as const;
    });
    if (result === "missing") return message("Project not found.", 404);
    if (result === "denied") return COOLIFY_API.unauthorized();
    if (result === "busy") return message("Project has resources, so it cannot be deleted.", 400);
    return message("Project deleted.", 200);
  }

  /** $project->environments()->select('id', 'name', 'uuid')->get() */
  async function listEnvironments(uuid: string): Promise<CoolifyAnswer> {
    const row = await projectRow(uuid);
    if (!row) return message("Project not found.", 404);
    const envs = await r.rows(env, orgId, (rows) => rows("environments", "t.project_id = $1", [rowValue(row, "id")]));
    return coolifyJson(serializeApiCollection(envs.map((e) => toModel(onlyColumns(e, ["id", "name", "uuid"]), ENVIRONMENT))));
  }

  async function createEnvironment(uuid: string): Promise<CoolifyAnswer> {
    const body = await readApiBody(request);
    if (body.incomingError) return body.incomingError;
    const errors: Errors = [];
    nameRules(errors, body.all, "name");
    extraFields(errors, body.all, ["name"]);
    if (errors.length) return validationFailed(errors);
    const requested = body.all.name as string;
    // Environment's name mutator (HasSafeStringAttribute with customizeName): lower case, trimmed, "/" as "-".
    const name = customizeEnvironmentName(requested);
    const result = await r.projects(env, orgId, async (store) => {
      const project = await store.findByUuid(uuid);
      if (!project) return "missing" as const;
      if (!(await allows("deploy.resource.write"))) return "denied" as const;
      if ((await store.environmentNameExists(project.id, requested)) || (await store.environmentNameExists(project.id, name))) return "exists" as const;
      return store.insertEnvironment({ projectId: project.id, uuid: newPublicId(), name });
    }).catch((e: unknown) => {
      // The unique (name, project_id) index refusing a concurrent twin.
      if (e instanceof ProjectError) return "exists" as const;
      throw e;
    });
    if (result === "missing") return message("Project not found.", 404);
    if (result === "denied") return COOLIFY_API.unauthorized();
    if (result === "exists") return message("Environment with this name already exists.", 409);
    return coolifyJson(obj({ uuid: result.uuid }), 201);
  }

  /** whereName(…)->first() ?? whereUuid(…)->first() */
  async function findEnvironment(store: Parameters<Parameters<ProjectsRunner>[2]>[0], projectId: string | number, nameOrUuid: string) {
    const all = await store.environments(projectId);
    return all.find((e) => e.name === nameOrUuid) ?? all.find((e) => e.uuid === nameOrUuid) ?? null;
  }

  async function updateEnvironment(uuid: string, nameOrUuid: string): Promise<CoolifyAnswer> {
    const body = await readApiBody(request);
    if (body.incomingError) return body.incomingError;
    const errors: Errors = [];
    nameRules(errors, body.all, "name", { required: false });
    descriptionRules(errors, body.all);
    extraFields(errors, body.all, ["name", "description"]);
    if (errors.length) return validationFailed(errors);
    const result = await r.projects(env, orgId, async (store) => {
      const project = await store.findByUuid(uuid);
      if (!project) return "missing-project" as const;
      const environment = await findEnvironment(store, project.id, nameOrUuid);
      if (!environment) return "missing" as const;
      if (!(await allows("deploy.resource.write"))) return "denied" as const;
      const name = "name" in body.all && body.all.name !== null ? customizeEnvironmentName(body.all.name as string) : environment.name;
      // $request->filled('name') && $request->name !== $environment->name: another environment of that name.
      if (name !== environment.name && (await store.environmentNameExists(project.id, name, environment.id))) return "exists" as const;
      const description = "description" in body.all ? ((body.all.description as string | null) ?? null) : environment.description ?? null;
      return store.updateEnvironment(environment.id, { name, description });
    });
    if (result === "missing-project") return message("Project not found.", 404);
    if (result === "missing" || result === null) return message("Environment not found.", 404);
    if (result === "denied") return COOLIFY_API.unauthorized();
    if (result === "exists") return message("Environment with this name already exists.", 409);
    return coolifyJson(obj({ uuid: result.uuid, name: result.name, description: result.description ?? null }));
  }

  async function deleteEnvironment(uuid: string, nameOrUuid: string): Promise<CoolifyAnswer> {
    const result = await r.projects(env, orgId, async (store) => {
      const project = await store.findByUuid(uuid);
      if (!project) return "missing-project" as const;
      const environment = await findEnvironment(store, project.id, nameOrUuid);
      if (!environment) return "missing" as const;
      if (!(await allows("deploy.resource.write"))) return "denied" as const;
      if (await store.environmentHasResources(environment.id)) return "busy" as const;
      await store.deleteEnvironment(environment.id);
      return "deleted" as const;
    });
    if (result === "missing-project") return message("Project not found.", 404);
    if (result === "missing") return message("Environment not found.", 404);
    if (result === "denied") return COOLIFY_API.unauthorized();
    if (result === "busy") return message("Environment has resources, so it cannot be deleted.", 400);
    return message("Environment deleted.", 200);
  }

  // ── private keys ──────────────────────────────────────────────────────────

  async function keys(uuid?: string, extra?: string): Promise<CoolifyAnswer> {
    if (extra !== undefined) return COOLIFY_API.notFound();
    if (uuid === undefined) return method === "GET" ? listKeys() : method === "POST" ? createKey() : COOLIFY_API.notFound();
    return method === "GET" ? showKey(uuid) : method === "PATCH" ? updateKey(uuid) : method === "DELETE" ? deleteKey(uuid) : COOLIFY_API.notFound();
  }

  /** removeSensitiveData(): private_key visible (decrypted) only when the token can read sensitive data; public_key appended. */
  async function keyModel(row: ApiRow, decrypt: (stored: string) => Promise<string>): Promise<PhpObject> {
    let plain: string | null = null;
    try {
      plain = await decrypt(String(rowValue(row, "private_key") ?? ""));
    } catch {
      plain = null;
    }
    let publicKey = "Error loading private key";
    try {
      // PrivateKey::getPublicKey(): phpseclib's OpenSSH line with an empty comment, so it ends with a space.
      if (plain !== null) publicKey = `${await publicKeyOpenSSH(plain)} `;
    } catch {
      publicKey = "Error loading private key";
    }
    const extra: Array<[string, PhpValue]> = [["public_key", publicKey]];
    if (canReadSensitive) extra.unshift(["private_key", plain]);
    return toModel(withoutColumns(row, ["private_key"]), PRIVATE_KEY, { teamId: orgPublicId, extra });
  }

  async function listKeys(): Promise<CoolifyAnswer> {
    const models = await r.keys(env, orgId, async (ctx) => {
      const rows = await r.rows(env, orgId, (rows) => rows("private_keys"));
      return Promise.all(rows.map((row) => keyModel(row, (s) => ctx.cipher.decrypt(s))));
    });
    return coolifyJson(serializeApiCollection(models));
  }

  async function keyRow(uuid: string): Promise<ApiRow | null> {
    return (await r.rows(env, orgId, (rows) => rows("private_keys", "t.uuid = $1", [uuid])))[0] ?? null;
  }

  async function showKey(uuid: string): Promise<CoolifyAnswer> {
    const row = await keyRow(uuid);
    if (!row) return message("Private Key not found.", 404);
    const denied = await authorize(false);
    if (denied) return denied;
    const model = await r.keys(env, orgId, (ctx) => keyModel(row, (s) => ctx.cipher.decrypt(s)));
    return coolifyJson(serializeApiResponse(model));
  }

  /** A key's base64 text, when it is not PEM: base64_decode($key, true). */
  function base64Key(value: string): string | null {
    if (value.startsWith("-----BEGIN")) return null;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) return null;
    try {
      const bin = atob(value);
      return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } catch {
      return null;
    }
  }

  async function createKey(): Promise<CoolifyAnswer> {
    const denied = await authorize(true);
    if (denied) return denied;
    const body = await readApiBody(request);
    if (body.incomingError) return body.incomingError;
    const errors: Errors = [];
    nameRules(errors, body.all, "name", { required: false, nullable: false });
    descriptionRules(errors, body.all);
    stringRule(errors, body.all, "private_key", true);
    if (errors.length) return validationFailed(errors);
    const name = (body.all.name as string | null | undefined) || generateRandomName();
    const description = (body.all.description as string | null | undefined) || API_KEY_DESCRIPTION;
    let key = body.all.private_key as string;
    key = base64Key(key) ?? key;
    const invalid = keyValidationError(key, true);
    if (invalid) return message(invalid, 422);
    return r.keys(env, orgId, async (ctx) => {
      const fingerprint = await fingerprintSha256(formatPrivateKey(key));
      if (fingerprint !== null && (await ctx.store.fingerprintExists(fingerprint, null))) return message("Private key already exists.", 422);
      const created = await createAndStore(ctx, { name, description, privateKey: key });
      return coolifyJson(serializeApiResponse(obj({ uuid: created.uuid })), 201);
    });
  }

  async function updateKey(uuid: string): Promise<CoolifyAnswer> {
    const body = await readApiBody(request);
    if (body.incomingError) return body.incomingError;
    const errors: Errors = [];
    nameRules(errors, body.all, "name", { required: false, nullable: false });
    descriptionRules(errors, body.all);
    stringRule(errors, body.all, "private_key", false);
    extraFields(errors, body.all, ["name", "description", "private_key"]);
    if (errors.length) return validationFailed(errors);
    return r.keys(env, orgId, async (ctx) => {
      const found = await ctx.store.findByUuid(uuid);
      if (!found) return message("Private Key not found.", 404);
      if (!(await allows("deploy.resource.write"))) return COOLIFY_API.unauthorized();
      const name = "name" in body.all ? (body.all.name as string) : found.name;
      const description = "description" in body.all ? ((body.all.description as string | null) ?? null) : found.description ?? null;
      const newKey = typeof body.all.private_key === "string" ? body.all.private_key : null;
      // The saving hook's ValidationException: {"message": …, "errors": {"private_key": […]}}.
      if (newKey !== null) {
        const invalid = keyValidationError(formatPrivateKey(newKey), true);
        if (invalid) return message(invalid, 422, { errors: obj({ private_key: [invalid] }) });
      }
      await updatePrivateKey(ctx, uuid, { name, description, newPrivateKey: newKey });
      return coolifyJson(serializeApiResponse(obj({ uuid: found.uuid })), 201);
    });
  }

  async function deleteKey(uuid: string): Promise<CoolifyAnswer> {
    return r.keys(env, orgId, async (ctx) => {
      const found = await ctx.store.findByUuid(uuid);
      if (!found) return message("Private Key not found.", 404);
      if (!(await allows("deploy.resource.write"))) return COOLIFY_API.unauthorized();
      if (await ctx.store.isInUse(found.id)) {
        return message("Private Key is in use and cannot be deleted.", 422, { details: "This private key is currently being used by servers, applications, or Git integrations." });
      }
      await deletePrivateKey(ctx, uuid);
      return message("Private Key deleted.", 200);
    });
  }

  // ── servers ───────────────────────────────────────────────────────────────

  async function servers(uuid?: string, sub?: string, extra?: string): Promise<CoolifyAnswer> {
    if (extra !== undefined) return COOLIFY_API.notFound();
    if (uuid === undefined) return method === "GET" ? listServers() : COOLIFY_API.notFound();
    if (sub === undefined) return method === "GET" ? showServer(uuid) : COOLIFY_API.notFound();
    if (sub === "validate" && method === "POST") return validateServer(uuid);
    return COOLIFY_API.notFound();
  }

  /** removeSensitiveDataFromSettings(): the settings, the secrets only for a token that may read them, and three computed values. */
  async function settingsModel(row: ApiRow): Promise<PhpObject> {
    const visible = canReadSensitive ? ["sentinel_token", "sentinel_custom_url", "logdrain_newrelic_license_key", "logdrain_axiom_api_key", "logdrain_custom_config", "logdrain_custom_config_parser"] : [];
    const out = serializeApiResponse(toModel(row, SERVER_SETTING, { visible }), canReadSensitive);
    const role = effectiveServerRole({ server_role: rowValue(row, "server_role") as never, is_build_server: rowValue(row, "is_build_server") as never });
    put(out, "is_build_server", role === "build");
    put(out, "ssh_host_key_fingerprints", await sshFingerprints(rowValue(row, "ssh_host_key")));
    put(out, "ssh_host_key_pending_fingerprints", await sshFingerprints(rowValue(row, "ssh_host_key_pending")));
    return out;
  }

  /** removeSensitiveData($server): without id; the log drain keys only for a token that may read them. */
  async function serverModel(row: ApiRow, settings: ApiRow | undefined, list: boolean): Promise<PhpObject> {
    const visible = canReadSensitive ? ["logdrain_axiom_api_key", "logdrain_newrelic_license_key"] : [];
    const base = list ? onlyColumns(row, ["id", "name", "uuid", "ip", "user", "port", "description", "proxy"]) : row;
    // The loaded settings relation: a key of the model, replaced in place by data_set() afterwards.
    const extra: Array<[string, PhpValue]> = [["is_coolify_host", rowValue(row, "id") === 0], ["settings", null]];
    if (list) extra.unshift(["is_reachable", (settings && (rowValue(settings, "is_reachable") as boolean)) ?? false], ["is_usable", (settings && (rowValue(settings, "is_usable") as boolean)) ?? false]);
    else extra.push(["unreachable_notification_sent", Boolean(rowValue(row, "unreachable_notification_sent"))]);
    const model = toModel(withoutColumns(base, ["id"]), SERVER, { visible, teamId: list ? undefined : orgPublicId, extra });
    const serialized = serializeApiResponse(model, canReadSensitive);
    put(serialized, "settings", settings ? await settingsModel(settings) : null);
    return serialized;
  }

  async function serverRows(where?: string, params?: unknown[]): Promise<Array<{ row: ApiRow; settings: ApiRow | undefined }>> {
    return r.rows(env, orgId, async (rows) => {
      const list = (await rows("servers", `t.deleted_at IS NULL${where ? ` AND ${where}` : ""}`, params)) as ApiRow[];
      const settings = list.length ? await rows("server_settings", "t.server_id = ANY($1)", [list.map((s) => rowValue(s, "id"))]) : [];
      return list.map((row) => ({ row, settings: settings.find((s) => rowValue(s, "server_id") === rowValue(row, "id")) }));
    });
  }

  async function listServers(): Promise<CoolifyAnswer> {
    const list = await serverRows();
    return coolifyJson(await Promise.all(list.map(({ row, settings }) => serverModel(row, settings, true))));
  }

  async function showServer(uuid: string): Promise<CoolifyAnswer> {
    const [found] = await serverRows("t.uuid = $1", [uuid]);
    if (!found) return message("Server not found.", 404);
    const denied = await authorize(false);
    if (denied) return denied;
    const model = await serverModel(found.row, found.settings, false);
    // ?resources (DP-78): $server['resources'], the server's resources as resources_by_server() gives them.
    if (url.searchParams.get("resources")) put(model, "resources", await (r.sql ?? runSql)(env, orgId, (tx) => serverResourcesPayload(tx, found.row)));
    return coolifyJson(serializeApiResponse(model, canReadSensitive));
  }

  async function validateServer(uuid: string): Promise<CoolifyAnswer> {
    const [found] = await serverRows("t.uuid = $1", [uuid]);
    if (!found) return message("Server not found.", 404);
    const denied = await authorize(true);
    if (denied) return denied;
    if (isTransferredAway({ server_metadata: rowValue(found.row, "server_metadata") })) {
      return message("This server was transferred to another Freeploy instance and cannot be revalidated here.", 422);
    }
    const body = await readApiBody(request);
    const errors: Errors = [];
    booleanRule(errors, body.all, "install");
    if (errors.length) return validationFailed(errors);
    if (requestBoolean(body.all, "install") && !abilities.includes("root") && !abilities.includes("deploy")) {
      return message("Missing required permissions: deploy. Installing the server runs commands on it and starts the proxy, so it needs a token with the deploy permission.", 403);
    }
    // ValidateServer / ValidateAndInstallServerJob run over SSH: Freeploy's convention, 501 until the executor exists.
    return message(SERVER_SERVICE_MESSAGES.validateUnavailable, 501);
  }
}

/** ServerSetting::sshHostKeyFingerprints(): "SHA256:<base64 of the blob's SHA-256, unpadded> (<type>)" per key line. */
async function sshFingerprints(keys: unknown): Promise<PhpValue> {
  const out: string[] = [];
  for (const line of String(keys ?? "").split("\n").filter(Boolean)) {
    const sp = line.indexOf(" ");
    const type = sp === -1 ? line : line.slice(0, sp);
    const blob = sp === -1 ? "" : line.slice(sp + 1);
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
    } catch {
      bytes = new Uint8Array();
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
    out.push(`SHA256:${btoa(String.fromCharCode(...digest)).replace(/=+$/, "")} (${type})`);
  }
  return out;
}
