// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Database/Heading.php (start, restart, stop) and
// app/Jobs/ServerStorageSaveJob.php (Apache-2.0), modified.
//
// The heading's Start, Restart and Stop, as what a route answers: the engine of start-engine.ts with the server
// and the rows of one database, and Freeploy's side of what Coolify queues beside a start.
//
// Coolify answers the click at once and runs the start in a queued job whose log the page follows. Here the
// start runs before the answer, and the answer carries its log: there is no queue and no activity table yet.
// What Coolify queues beside it is done in place where it can be:
//   - ServerStorageSaveJob (the file of a new certificate): written at once, before the start checks which
//     files are missing — so a regenerated certificate replaces the file an earlier one left on the server.
//   - StartDatabaseProxy (a public database): run after the start.
//   - RegenerateSslCertJob (every certificate of the server, after its CA was made): not done; it is named in
//     the answer's `deferred`.
// The broadcasts and the notification have no receiver yet.
import type { DeploymentExecutor } from "../deployments/engine.js";
import type { GenerateSslCertificateOptions, GeneratedSslCertificate } from "../ssl/ssl-helper.js";
import { saveContentFileOnServer } from "./content-files.js";
import {
  DATABASE_OPERATION_MESSAGES,
  regenerateDatabaseCertificate,
  runDatabaseProxyStart,
  runDatabaseProxyStop,
  runDatabaseRestart,
  runDatabaseStart,
  runDatabaseStop,
  type DatabaseEffect,
  type DatabaseEngineDeps,
  type DatabaseOperationContext,
  type DatabaseOperationStore,
  type DatabaseStartState,
} from "./start-engine.js";
import { databaseWorkdir } from "./start-plan.js";

/** One database's rows and server, as an operation on it needs them. */
export interface DatabaseServerAccess {
  /** The database as it is now. */
  context(): Promise<DatabaseOperationContext>;
  store: DatabaseOperationStore;
  /** The SSH executor of the database's server; null when there is none (no binding, no server, no key). */
  executor: DeploymentExecutor | null;
  /** Replaceable in tests. */
  now?: () => Date;
  sleep?: (seconds: number) => Promise<void>;
  generateCertificate?: (options: GenerateSslCertificateOptions) => Promise<GeneratedSslCertificate>;
}

export const OPERATION_MESSAGES = {
  /** Heading::restart() */
  restarting: "Restarting database.",
  /** HasDatabaseStatusInfo::regenerateSslCertificate() */
  certificateRegenerated: "SSL certificates regenerated. Restart database to apply changes.",
  /** Freeploy's */
  noExecutor: "The database's server cannot be reached: it has no private key.",
  regenerateServerCertificates: "Regenerating the other certificates of the server after its CA certificate was created",
} as const;

const noExecutor: DeploymentExecutor = {
  run: () => Promise.reject(new Error(OPERATION_MESSAGES.noExecutor)),
};

/** What ran beside an operation, and what was left. */
interface Beside {
  proxyQueued: boolean;
  deferred: string[];
  /** Why a certificate file could not be written. */
  fileErrors: string[];
}

const beside0 = (): Beside => ({ proxyQueued: false, deferred: [], fileErrors: [] });

function depsOf(access: DatabaseServerAccess, uuid: string, beside: Beside): DatabaseEngineDeps {
  const executor = access.executor ?? noExecutor;
  const effect = async (effect: DatabaseEffect): Promise<void> => {
    if (effect.type !== "job") return;
    if (effect.job === "StartDatabaseProxy") beside.proxyQueued = true;
    else if (effect.job === "RegenerateSslCertJob") beside.deferred.push(OPERATION_MESSAGES.regenerateServerCertificates);
    else if (effect.job === "ServerStorageSaveJob" && access.executor !== null) {
      // ServerStorageSaveJob: $fileVolume->saveStorageOnServer(). A failed job fails nothing else.
      try {
        await saveContentFileOnServer(executor, effect.file, databaseWorkdir(uuid));
      } catch (e) {
        // The start writes the file when it is missing.
        beside.fileErrors.push(e instanceof Error ? e.message : String(e));
      }
    }
  };
  return {
    executor,
    store: access.store,
    now: access.now ?? (() => new Date()),
    sleep: access.sleep ?? ((seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000))),
    effect,
    ...(access.generateCertificate ? { generateCertificate: access.generateCertificate } : {}),
  };
}

export interface DatabaseActionAnswer {
  action: "start" | "restart" | "stop";
  /** Why Coolify refused before anything ran (its error toast); null when it ran. */
  refused: string | null;
  /** Coolify's words for what happened, where it has any. */
  message: string | null;
  /** A start's log and how it ended. */
  activity: { status: string; exitCode: number | null; error: string | null; log: Array<{ type: string; output: string }> } | null;
  /** The database's status afterwards. */
  status: string;
  /** The TCP proxy of a public database, when the start asked for it. */
  proxy: { started: boolean; disabled: string | null; error: string | null } | null;
  /** What Coolify queues beside this and nothing does yet. */
  deferred: string[];
}

const activityOf = (state: DatabaseStartState): DatabaseActionAnswer["activity"] =>
  state.activity === null ? null : { status: state.activity.status, exitCode: state.activity.exitCode, error: state.activity.error, log: state.activity.log.map((entry) => ({ type: entry.type, output: entry.output })) };

/** Heading::start(), restart() and stop(), run to their end. `dockerCleanup` is the stop's checkbox. */
export async function performDatabaseAction(access: DatabaseServerAccess, action: "start" | "restart" | "stop", dockerCleanup = true): Promise<DatabaseActionAnswer> {
  const ctx = await access.context();
  const beside = beside0();
  const deps = depsOf(access, ctx.database.uuid, beside);
  const answer: DatabaseActionAnswer = { action, refused: null, message: null, activity: null, status: ctx.database.status, proxy: null, deferred: beside.deferred };
  // A server Coolify would use, which the executor cannot reach: nothing runs and nothing is stored.
  if (access.executor === null && ctx.server.functional) return { ...answer, refused: OPERATION_MESSAGES.noExecutor };

  if (action === "stop") {
    // StopDatabase answers with a sentence; anything but its success is why the database was not stopped.
    const result = await runDatabaseStop(deps, ctx, dockerCleanup);
    if (result === DATABASE_OPERATION_MESSAGES.stopped) answer.message = result;
    else answer.refused = result;
  } else {
    const state = action === "start" ? await runDatabaseStart(deps, ctx, access.context) : await runDatabaseRestart(deps, ctx, access.context);
    answer.refused = state.refused;
    answer.activity = activityOf(state);
    if (action === "restart" && state.refused === null) answer.message = OPERATION_MESSAGES.restarting;
    if (beside.proxyQueued) {
      // StartDatabaseProxy::dispatch($database)
      try {
        const proxy = await runDatabaseProxyStart(deps, await access.context());
        answer.proxy = { started: proxy.disabled === null, disabled: proxy.disabled, error: null };
      } catch (e) {
        answer.proxy = { started: false, disabled: null, error: e instanceof Error ? e.message : String(e) };
      }
    }
  }
  answer.status = (await access.context()).database.status;
  return answer;
}

/** General::instantSave()'s StartDatabaseProxy::run(): the proxy of the database as it is stored now. */
export async function startDatabaseProxy(access: DatabaseServerAccess): Promise<{ disabled: string | null }> {
  const ctx = await access.context();
  return runDatabaseProxyStart(depsOf(access, ctx.database.uuid, beside0()), ctx);
}

/** General::instantSave()'s StopDatabaseProxy::run() */
export async function stopDatabaseProxy(access: DatabaseServerAccess): Promise<void> {
  const ctx = await access.context();
  await runDatabaseProxyStop(depsOf(access, ctx.database.uuid, beside0()), ctx);
}

/**
 * regenerateSslCertificate(): the rows of a new certificate, and — with a server to reach — its files. Answers
 * what was done, and whether the files were written.
 */
export async function regenerateCertificate(access: DatabaseServerAccess): Promise<{ outcome: "regenerated" | "no-certificate" | "no-ca"; filesWritten: boolean; deferred: string[] }> {
  const ctx = await access.context();
  const beside = beside0();
  const outcome = await regenerateDatabaseCertificate(depsOf(access, ctx.database.uuid, beside), ctx);
  return { outcome, filesWritten: access.executor !== null && beside.fileErrors.length === 0, deferred: beside.deferred };
}
