// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/{Advanced,DockerCleanup,LogDrains,Swarm,Sentinel}.php,
// app/Livewire/Server/Sentinel/Show.php and app/Policies/ServerPolicy.php (update, viewSentinel,
// manageSentinel) (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/servers/{uuid}/… — the server settings pages
// that only read and write deploy.server_settings. Routed and authorized by
// handleServers (servers.ts):
//
//   GET   /advanced                         Advanced
//   PATCH /advanced                         Advanced::submit, or instantSave with { instantSave: true }
//   GET   /docker-cleanup                   DockerCleanup
//   PATCH /docker-cleanup                   DockerCleanup::submit / instantSave
//   POST  /docker-cleanup/run               DockerCleanup::manualCleanup — needs SSH, not available yet (501)
//   GET   /log-drains                       LogDrains (keys and Fluent Bit config only for writers)
//   PATCH /log-drains                       LogDrains::submit, or instantSave (the Status listboxes): the fields
//                                           saved, the enabled flags rolled back, 501 (starting/stopping needs SSH)
//   GET   /swarm                            Swarm
//   PATCH /swarm                            Swarm::instantSave
//   GET   /sentinel                         Sentinel/Show + Sentinel (viewSentinel: writers only)
//   PATCH /sentinel                         Sentinel::submit / instantSave: saved; the restart is not available yet
//   POST  /sentinel/restart                 Sentinel::restartSentinel — not available yet (501)
//   POST  /sentinel/regenerate-token        Sentinel::regenerateSentinelToken: saved; restart not available yet
//   POST  /sentinel/restore-defaults        Sentinel::restoreDefaultConfiguration: saved; restart not available yet
import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { withOrg, loadKek, orgDek, decryptField, encryptField, findServerByUuid, findServerSettings, updateServerSettings, orgUsesSwarm, type OrgDek } from "@saas/db/deploy";
import { errorResponse, successResponse, validationError } from "../http.js";
import {
  logDrainFlags,
  regenerateSentinelToken,
  restartSentinel,
  restoreSentinelDefaults,
  runDockerCleanup,
  saveAdvanced,
  saveDockerCleanup,
  saveLogDrains,
  saveSentinel,
  saveSwarm,
  showAdvanced,
  showDockerCleanup,
  showLogDrains,
  showSentinel,
  showSwarm,
  type FieldCipher,
  type ServerSettingsContext,
  type ServerSettingsStore,
} from "../servers/settings.js";
import { validateAdvanced, validateDockerCleanup, validateLogDrains, validateSentinel, validateSwarm } from "../servers/settings-validation.js";

/** Runs fn with one org's server settings store, in one transaction confined to that org. */
export type ServerSettingsRunner = <T>(env: Env, orgId: string, fn: (ctx: ServerSettingsContext) => Promise<T>) => Promise<T>;

function sqlStore(tx: SqlExecutor): ServerSettingsStore {
  return {
    findServer: (uuid) => findServerByUuid(tx, uuid),
    settings: (id) => findServerSettings(tx, id),
    update: (id, changes) => updateServerSettings(tx, id, changes),
    usesSwarm: () => orgUsesSwarm(tx),
  };
}

/** The org's data key, looked up on first use; each value bound to its column. */
function sqlCipher(tx: SqlExecutor, orgId: string, secret: string | undefined): FieldCipher {
  let dek: Promise<OrgDek> | null = null;
  const key = () => (dek ??= loadKek(secret).then((kek) => orgDek(tx, orgId, kek)));
  return {
    encrypt: async (column, plaintext) => encryptField(await key(), column, plaintext),
    decrypt: async (column, stored) => decryptField(await key(), column, stored),
  };
}

export const runServerSettingsInOrg: ServerSettingsRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn({ store: sqlStore(tx), cipher: sqlCipher(tx, orgId, env.DEPLOY_ENCRYPTION_KEY) }));
  } finally {
    await db.dispose();
  }
};

export const SETTINGS_SECTIONS = ["advanced", "docker-cleanup", "log-drains", "swarm", "sentinel"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The POST actions below a section. */
export const SETTINGS_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  "docker-cleanup": ["run"],
  sentinel: ["restart", "regenerate-token", "restore-defaults"],
};

/** Which policy action a settings route needs: Sentinel is viewSentinel / manageSentinel (team admin). */
export function settingsNeedsWrite(section: SettingsSection, method: string): boolean {
  return method !== "GET" || section === "sentinel";
}

export interface SettingsCall {
  env: Env;
  orgId: string;
  requestId: string;
  uuid: string;
  section: SettingsSection;
  action: string | null;
  body: Record<string, unknown>;
  method: string;
  canWrite: boolean;
  notFound: () => Response;
}

/** One settings route, once handleServers has authorized it. */
export async function serverSettingsRoute(c: SettingsCall, runner: ServerSettingsRunner): Promise<Response> {
  const { env, orgId, requestId, uuid, body } = c;
  const run = <T>(fn: (ctx: ServerSettingsContext) => Promise<T>) => runner(env, orgId, fn);
  const ok = <T>(data: T | null | false, extra: Record<string, unknown> = {}) => (data ? successResponse({ ...(data as object), ...extra }, requestId) : c.notFound());
  const instant = body.instantSave === true;

  if (c.action === "run") return ok(await run((ctx) => runDockerCleanup(ctx, uuid)));
  if (c.action === "restart") return ok(await run((ctx) => restartSentinel(ctx, uuid)));
  if (c.action === "regenerate-token") return ok(await run((ctx) => regenerateSentinelToken(ctx, uuid)));
  if (c.action === "restore-defaults") return ok(await run((ctx) => restoreSentinelDefaults(ctx, uuid)));

  const read = c.method === "GET";
  switch (c.section) {
    case "advanced": {
      if (read) return ok(await run((ctx) => showAdvanced(ctx, uuid)), { canUpdate: c.canWrite });
      const v = validateAdvanced(body);
      if (!v.ok) return validationError(requestId, v.errors);
      return ok(await run((ctx) => saveAdvanced(ctx, uuid, v.input, instant)));
    }
    case "docker-cleanup": {
      if (read) return ok(await run((ctx) => showDockerCleanup(ctx, uuid)), { canUpdate: c.canWrite });
      const v = validateDockerCleanup(body);
      if (!v.ok) return validationError(requestId, v.errors);
      return ok(await run((ctx) => saveDockerCleanup(ctx, uuid, v.input, instant)));
    }
    case "log-drains": {
      if (read) return ok(await run((ctx) => showLogDrains(ctx, uuid, c.canWrite)), { canUpdate: c.canWrite });
      // customValidation() reads the stored enabled flags for those the body leaves out.
      const r = await run(async (ctx) => {
        const flags = await logDrainFlags(ctx, uuid);
        if (!flags) return null;
        const v = validateLogDrains(body, flags);
        return v.ok ? { saved: await saveLogDrains(ctx, uuid, v.input, instant) } : { invalid: v.errors };
      });
      if (r && "invalid" in r) return validationError(requestId, r.invalid);
      // Starting or stopping the drain failed (needs SSH): Coolify's error toast, the flags as they were.
      if (r?.saved?.failed) return errorResponse("unsupported", r.saved.unavailable ?? "", 501, requestId);
      return ok(r?.saved ?? null);
    }
    case "swarm": {
      if (read) return ok(await run((ctx) => showSwarm(ctx, uuid)), { canUpdate: c.canWrite });
      const v = validateSwarm(body);
      if (!v.ok) return validationError(requestId, v.errors);
      return ok(await run((ctx) => saveSwarm(ctx, uuid, v.input)));
    }
    case "sentinel": {
      if (read) return ok(await run((ctx) => showSentinel(ctx, uuid)), { canUpdate: c.canWrite });
      const v = validateSentinel(body);
      if (!v.ok) return validationError(requestId, v.errors);
      return ok(await run((ctx) => saveSentinel(ctx, uuid, v.input, instant)));
    }
  }
}
