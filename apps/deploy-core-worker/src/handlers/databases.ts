// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Resource/Create.php (createResource),
// app/Livewire/Project/Database/{Configuration,Heading}.php, app/Livewire/Project/Database/*/General.php,
// app/Traits/HasDatabaseStatusInfo.php, app/Livewire/Project/Shared/Danger.php, app/Policies/DatabasePolicy.php and
// app/Http/Controllers/Api/DatabasesController.php (delete_by_uuid: the query fields) (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/databases — the standalone databases:
// PostgreSQL, Redis / Valkey, MongoDB, MySQL, MariaDB, KeyDB, Dragonfly and
// ClickHouse.
//
//   POST   /databases                     Create::createResource { type, project_uuid, environment_uuid, destination,
//                                         server_id, database_image }: the database's row, its data volumes and — for
//                                         Redis — its two credential variables; nothing is started
//   GET    /databases/{uuid}              Configuration + General + StatusInfo: the database with its project,
//                                         environment, destination and server, its connection URLs and SSL state
//   PATCH  /databases/{uuid}              General::submit, or — named by `action` — "instantSave" (the Access
//                                         listbox), "instantSaveAdvanced" (the Log drain listbox), "instantSaveSSL"
//   DELETE /databases/{uuid}              Danger::delete: a database that was never started; else 501
//   POST   /databases/{uuid}/start        Heading::start     501 without the SSH executor (env.SSH_SESSION);
//   POST   /databases/{uuid}/restart      Heading::restart   with it, the engine of databases/start-engine.ts
//   POST   /databases/{uuid}/stop         Heading::stop      runs and the answer carries what it did; stop takes
//                                         { dockerCleanup } (the page's checkbox, checked unless false), which
//                                         resets the restart counters
//   POST   /databases/{uuid}/init-scripts     Postgresql\General::save_new_init_script { new_filename, new_content }
//   PATCH  /databases/{uuid}/init-scripts     save_init_script { originalFilename, filename, content }
//   DELETE /databases/{uuid}/init-scripts?filename=…   delete_init_script   501
//   POST   /databases/{uuid}/ssl/regenerate            regenerateSslCertificate
//   POST   /databases/{uuid}/keep-current-data-volume  Clickhouse\General::keepCurrentDataVolume   501
//
// Coolify's policy: view = who can open the database, update and manage =
// write, manageEnvironment = write. Here: deploy.resource.read and
// deploy.resource.write, asked of policy-worker after membership-worker's
// facts; a denial answers 404 (never leaks).
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  findProjectByUuid,
  findEnvironmentByUuid,
  findDestinationByUuid,
  findServerByUuid,
  findDatabaseByUuid,
  insertDatabase,
  updateDatabase,
  findDatabaseVariable,
  insertDatabaseVariable,
  updateDatabaseVariableValue,
  findDatabaseCertificateValidUntil,
  deleteDatabase,
  databaseOwner,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import { sessionExecutor, sessionFetch } from "../deployments/session-executor.js";
import { loadServerConnection } from "../deployments/sql.js";
import type { DeploymentExecutor } from "../deployments/engine.js";
import { performDatabaseAction, type DatabaseServerAccess } from "../databases/operations.js";
import { loadDatabaseOperationContext, sqlDatabaseOperationStore, type DatabaseOperationTarget, type OrgRun } from "../databases/start-sql.js";
import type { KeyCipher } from "../private-keys/service.js";
import { authorizeDeploy, columnCipher, readJson } from "./cloud-tokens.js";
import { deleteOptions } from "../applications/danger.js";
import { validateCreateDatabase } from "../databases/validation.js";
import {
  DatabaseError,
  DatabaseFieldErrors,
  addInitScript,
  createDatabase,
  deleteDatabaseNow,
  deleteInitScript,
  instantSaveAdvanced,
  instantSavePublic,
  instantSaveSsl,
  keepCurrentDataVolume,
  regenerateSslCertificate,
  saveInitScript,
  showDatabase,
  unavailableAction,
  updateGeneral,
  type DatabaseAction,
  type DatabaseContext,
  type DatabaseStore,
} from "../databases/service.js";

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;
const ACTIONS: readonly string[] = ["start", "restart", "stop"];

/** Runs fn with one org's database store and ciphers, in one transaction confined to that org. */
export type DatabaseRunner = <T>(env: Env, orgId: string, fn: (ctx: DatabaseContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor, orgId: string): DatabaseStore {
  return {
    findProject: (uuid) => findProjectByUuid(tx, uuid),
    findEnvironment: (projectId, uuid) => findEnvironmentByUuid(tx, projectId, uuid),
    findDestination: (uuid) => findDestinationByUuid(tx, uuid),
    findServer: (uuid) => findServerByUuid(tx, uuid),
    insert: (engine, database) => insertDatabase(tx, engine, { ...database, orgId }),
    findByUuid: (uuid) => findDatabaseByUuid(tx, uuid),
    update: (engine, id, changes) => updateDatabase(tx, engine, id, changes),
    findVariable: (engine, id, key) => findDatabaseVariable(tx, databaseOwner(engine, id), key),
    insertVariable: (engine, id, variable) => insertDatabaseVariable(tx, databaseOwner(engine, id), { ...variable, orgId }),
    updateVariableValue: (engine, id, variableId, value, isShared) => updateDatabaseVariableValue(tx, databaseOwner(engine, id), variableId, value, isShared),
    certificateValidUntil: (engine, id) => findDatabaseCertificateValidUntil(tx, databaseOwner(engine, id)),
    delete: (engine, id) => deleteDatabase(tx, engine, id),
  };
}

/** Coolify's constants.ssh.command_timeout: seconds a command batch on a server may run. */
const SSH_COMMAND_TIMEOUT = 3600;

/** The SSH executor of a database's server; null without the binding, without a server, or without its key. */
async function serverExecutor(env: Env, tx: SqlExecutor, orgId: string, target: DatabaseOperationTarget): Promise<DeploymentExecutor | null> {
  if (!env.SSH_SESSION || target.serverId === null) return null;
  const connection = await loadServerConnection(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, target.serverId);
  return connection ? sessionExecutor(sessionFetch(env.SSH_SESSION, connection.serverUuid), connection.conn, SSH_COMMAND_TIMEOUT) : null;
}

/** One database's rows and server. `run` decides the transactions of the reads after the first and of every write. */
async function serverAccess(env: Env, orgId: string, uuid: string, tx: SqlExecutor, run: OrgRun): Promise<DatabaseServerAccess | null> {
  const secret = env.DEPLOY_ENCRYPTION_KEY;
  const loaded = await loadDatabaseOperationContext(tx, orgId, secret, uuid);
  if (!loaded) return null;
  return {
    context: () => run(async (t) => (await loadDatabaseOperationContext(t, orgId, secret, uuid))?.ctx ?? loaded.ctx),
    store: sqlDatabaseOperationStore(run, orgId, secret, loaded.target),
    executor: await serverExecutor(env, tx, orgId, loaded.target),
  };
}

export const runDatabasesInOrg: DatabaseRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => {
      // One cipher per encrypted column: the value is bound to "<table>.<column>".
      const ciphers = new Map<string, KeyCipher>();
      const cipher = (column: string): KeyCipher => {
        let found = ciphers.get(column);
        if (!found) ciphers.set(column, (found = columnCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY, column)));
        return found;
      };
      // What runs on the server within a request (the TCP proxy, a certificate's files) shares the request's transaction.
      return fn({ store: sqlStore(tx, orgId), cipher, server: (uuid) => serverAccess(env, orgId, uuid, tx, (work) => work(tx)) });
    });
  } finally {
    await db.dispose();
  }
};

/**
 * Runs fn with one database's rows and server for Start, Restart or Stop; null when the database is not the
 * org's. Every write is its own transaction, as each of Coolify's queries is: what a start has stored — that the
 * database was handed to a server, above all — stays when a later step fails.
 */
export type DatabaseActionRunner = <T>(env: Env, orgId: string, uuid: string, fn: (access: DatabaseServerAccess) => Promise<T>) => Promise<T | null>;

export const runDatabaseActionInOrg: DatabaseActionRunner = async (env, orgId, uuid, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    const run: OrgRun = (work) => withOrg(db, orgId, work);
    const access = await run((tx) => serverAccess(env, orgId, uuid, tx, run));
    return access ? await fn(access) : null;
  } finally {
    await db.dispose();
  }
};

function failure(e: unknown, requestId: string): Response {
  if (e instanceof DatabaseFieldErrors) return validationError(requestId, e.fields);
  if (e instanceof DatabaseError) {
    const code = e.status === 501 ? "unsupported" : e.status === 409 ? "conflict" : e.status === 404 ? "not_found" : "validation_failed";
    return errorResponse(code, e.message, e.status, requestId);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

type Body = Record<string, unknown>;
/** What a route does once authorized: the answer's data, or null when the database is not the org's. */
interface Op {
  write: boolean;
  status?: number;
  run: (ctx: DatabaseContext, canWrite: boolean, body: Body) => Promise<object | null>;
}

/**
 * segments: what follows /databases, split on "/" ([] for the collection).
 * `runner` is replaceable for tests.
 */
export async function handleDatabases(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: DatabaseRunner = runDatabasesInOrg,
  actionRunner: DatabaseActionRunner = runDatabaseActionInOrg,
): Promise<Response> {
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const method = request.method;
  const [uuid, second, third] = segments;
  const query = new URL(request.url).searchParams;
  const on = (methods: Record<string, Op>): Op | null => methods[method] ?? null;
  /** The route's operation; null for a method it does not have; undefined for a path that does not exist. */
  let op: Op | null | undefined;

  if (segments.length === 0) {
    op = on({
      POST: {
        write: true,
        status: 201,
        run: async (c, _w, body) => {
          const v = validateCreateDatabase(body);
          if (!v.ok) throw new DatabaseFieldErrors(v.errors);
          return createDatabase(c, v.input);
        },
      },
    });
  } else if (!uuid || !UUID_RE.test(uuid)) {
    op = undefined;
  } else if (segments.length === 1) {
    op = on({
      // The views' @can('update', $database) and @can('manage', $database) ride on the read.
      GET: { write: false, run: async (c, canWrite) => ((database) => database && { database, canUpdate: canWrite, canManage: canWrite, canDelete: canWrite })(await showDatabase(c, uuid, canWrite)) },
      PATCH: {
        write: true,
        run: (c, _w, body) => {
          const { action, ...fields } = body;
          if (action === undefined || action === null || action === "submit") return updateGeneral(c, uuid, fields);
          if (action === "instantSave") return instantSavePublic(c, uuid, fields);
          if (action === "instantSaveAdvanced") return instantSaveAdvanced(c, uuid, fields);
          if (action === "instantSaveSSL") return instantSaveSsl(c, uuid, fields);
          throw new DatabaseFieldErrors({ action: ["The selected action is invalid."] });
        },
      },
      DELETE: { write: true, run: (c) => deleteDatabaseNow(c, uuid, deleteOptions(query)) },
    });
  } else if (segments.length === 2 && ACTIONS.includes(second!)) {
    // @can('manage', $database)
    op = on({ POST: { write: true, run: (c) => unavailableAction(c, uuid, second as DatabaseAction) } });
  } else if (segments.length === 2 && second === "init-scripts") {
    op = on({
      POST: { write: true, status: 201, run: (c, _w, body) => addInitScript(c, uuid, body) },
      PATCH: { write: true, run: (c, _w, body) => saveInitScript(c, uuid, body) },
      DELETE: { write: true, run: (c) => deleteInitScript(c, uuid, query.get("filename") ?? "") },
    });
  } else if (segments.length === 2 && second === "keep-current-data-volume") {
    op = on({ POST: { write: true, run: (c) => keepCurrentDataVolume(c, uuid) } });
  } else if (segments.length === 3 && second === "ssl" && third === "regenerate") {
    op = on({ POST: { write: true, run: (c) => regenerateSslCertificate(c, uuid) } });
  }
  if (op === undefined) return notFound();
  if (op === null) return methodNotAllowed(requestId);

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  // Start, Restart and Stop with the SSH executor: the engine runs, each of its writes in a transaction of its own.
  if (env.SSH_SESSION && segments.length === 2 && ACTIONS.includes(second!)) {
    try {
      // Heading's $docker_cleanup: checked unless the body says false.
      const dockerCleanup = second === "stop" ? (await readJson(request)).dockerCleanup !== false : true;
      const answer = await actionRunner(env, orgId, uuid!, (access) => performDatabaseAction(access, second as DatabaseAction, dockerCleanup));
      if (!answer) return notFound();
      // Coolify's dispatch('error', …): the reason nothing ran.
      if (answer.refused !== null) return errorResponse("validation_failed", answer.refused, 422, requestId);
      return successResponse(answer, requestId);
    } catch {
      return errorResponse("internal_error", "Service unavailable", 503, requestId);
    }
  }
  const run = op.run;
  try {
    const body = method === "POST" || method === "PATCH" ? await readJson(request) : {};
    const data = await runner(env, orgId, (c) => run(c, auth.canWrite, body));
    return data ? successResponse(data, requestId, op.status ?? 200) : notFound();
  } catch (e) {
    return failure(e, requestId);
  }
}
