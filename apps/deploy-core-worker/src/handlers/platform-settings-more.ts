// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Settings/Updates.php, app/Livewire/SettingsBackup.php,
// app/Livewire/SettingsEmail.php and app/Livewire/SettingsOauth.php (Apache-2.0), modified.
//
// The platform operator's Updates, Backup, Email and Authentication settings (freeploy-coolify-parity DP12,
// DP-101), under DP-79's /v1/platform (handlers/platform.ts routes them here, after the same gate):
//
//   GET   /v1/platform/settings/updates              Settings\Updates: the update settings
//   PATCH /v1/platform/settings/updates              { action: instantSave|submit|checkManually|upgrade, ...properties }
//   GET   /v1/platform/settings/backup               SettingsBackup: no instance database is configured
//   PATCH /v1/platform/settings/backup               { action: addCoolifyDatabase }: 501 (docker inspect on server 0)
//   GET   /v1/platform/settings/email                SettingsEmail: the instance's email provider
//   PATCH /v1/platform/settings/email                { action: submit|selectEmailProvider|sendTestEmail, ...properties }
//   GET   /v1/platform/settings/oauth[/{provider}]   SettingsOauth: the providers and the registration policy
//   PATCH /v1/platform/settings/oauth[/{provider}]   { action: submit|toggleProvider|saveRegistrationPolicy, ... }
//
// api-edge's platform facade forwards GET and PATCH only, so every action is a PATCH with its name. A read asks
// policy-worker for platform.settings.read, an action for platform.settings.update first ($this->authorize()
// before validate()); only PLATFORM_OPERATORS pass, and a denial is DP-79's 404, with no store opened. The
// settings are row 0 of deploy.instance_settings and the platform's deploy.oauth_settings rows, read and written
// in asPlatformAdmin(); the secrets (the SMTP password, the Resend API key, the senders, the OAuth client
// secrets) are stored as fp1 ciphertexts under the platform row's data key, and shown only to who can update
// them, as Coolify shows them to its instance admin.
//
// An action runs in one transaction and its failure is answered after it commits: what Coolify saves before it
// fails (a provider it disables) is kept, and a 501 has stored nothing.
import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  asPlatformAdmin,
  decryptField,
  encryptField,
  isEncrypted,
  isEncryptedColumn,
  listPlatformOauthSettings,
  loadKek,
  orgDek,
  readPlatformSettingsMore,
  updatePlatformOauthSetting,
  updatePlatformSettingsMore,
  PLATFORM_SETTINGS_ORG_ID,
  type OrgDek,
  type PlatformOauthChanges,
  type PlatformSettingsMoreSection,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, notFound, successResponse, validationError } from "../http.js";
import { readJson } from "./cloud-tokens.js";
import { SettingsError, ValidationFailed, type Props, type SettingsRow } from "../notifications/settings.js";
import { isUpdatesAction, runUpdatesAction, updatesView, type UpdatesStore } from "../platform/updates.js";
import { emailSettingsView, isPlatformEmailAction, runPlatformEmailAction, type EmailStore } from "../platform/email.js";
import { isOauthAction, oauthView, runOauthAction, type OauthRow, type OauthStore } from "../platform/oauth.js";

export const BACKUP_MESSAGES = {
  /** addCoolifyDatabase(): `docker inspect coolify-db` on server 0 reads the instance database's credentials. */
  configureNeedsExecutor: "Configuring the instance backup needs the SSH executor, which is not available yet.",
};

export interface PlatformMoreStore {
  updates: UpdatesStore;
  email: EmailStore;
  oauth: OauthStore;
}

/** Runs fn with the platform's stores, in one transaction as the platform operator. */
export type PlatformMoreRunner = <T>(env: Env, fn: (store: PlatformMoreStore) => Promise<T>) => Promise<T>;

const OAUTH_SECRET = "oauth_settings.client_secret";

/** The stores over row 0 and deploy.oauth_settings: the encrypted columns encrypted with the platform row's data key. */
export function sqlPlatformMoreStore(tx: SqlExecutor, secret: string | undefined): PlatformMoreStore {
  let dek: Promise<OrgDek> | null = null;
  const key = () => (dek ??= loadKek(secret).then((kek) => orgDek(tx, PLATFORM_SETTINGS_ORG_ID, kek)));
  const open = async (column: string, v: unknown) => (typeof v === "string" && isEncrypted(v) ? decryptField(await key(), column, v) : v);
  const seal = async (column: string, v: unknown) => (typeof v === "string" && v !== "" ? encryptField(await key(), column, v) : v);
  const decryptRow = async (row: Record<string, unknown>): Promise<SettingsRow> => {
    const out: SettingsRow = {};
    for (const [k, v] of Object.entries(row)) out[k] = isEncryptedColumn("instance_settings", k) ? await open(`instance_settings.${k}`, v) : v;
    return out;
  };
  const section = (s: PlatformSettingsMoreSection) => ({
    load: async () => decryptRow(await readPlatformSettingsMore(tx, s)),
    save: async (changes: Props) => {
      const stored: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(changes)) stored[k] = isEncryptedColumn("instance_settings", k) ? await seal(`instance_settings.${k}`, v) : v;
      return decryptRow(await updatePlatformSettingsMore(tx, s, stored));
    },
  });
  const oauthRow = async (row: Record<string, unknown>): Promise<OauthRow> => ({ ...(row as unknown as OauthRow), client_secret: ((await open(OAUTH_SECRET, row.client_secret)) as string | null) ?? null });
  const oauthSettings = section("oauth");
  return {
    updates: section("updates"),
    email: section("email"),
    oauth: {
      list: async () => Promise.all((await listPlatformOauthSettings(tx)).map(oauthRow)),
      save: async (provider, changes) => {
        const stored: Record<string, unknown> = { ...changes };
        if ("client_secret" in stored) stored.client_secret = await seal(OAUTH_SECRET, stored.client_secret);
        const row = await updatePlatformOauthSetting(tx, provider, stored as PlatformOauthChanges);
        return row ? oauthRow(row) : null;
      },
      loadRegistrationPolicy: async () => Boolean((await oauthSettings.load()).disable_registration_when_oauth_enabled),
      saveRegistrationPolicy: async (value) => {
        await oauthSettings.save({ disable_registration_when_oauth_enabled: value });
      },
    },
  };
}

export const runPlatformMoreAsAdmin: PlatformMoreRunner = async (env, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await asPlatformAdmin(db, (tx) => fn(sqlPlatformMoreStore(tx, env.DEPLOY_ENCRYPTION_KEY)));
  } finally {
    await db.dispose();
  }
};

/** The pages this handler answers: settings/{updates,backup,email,oauth}, settings/oauth/{provider}. */
export function isPlatformMorePage(page: string): boolean {
  return /^settings\/(updates|backup|email|oauth(\/[A-Za-z0-9_-]+)?)$/.test(page);
}

function failure(e: unknown, requestId: string): Response {
  if (e instanceof ValidationFailed) return validationError(requestId, e.fields);
  if (e instanceof SettingsError) {
    if (e.status === 404) return errorResponse("not_found", "Not found", 404, requestId);
    if (e.status === 501) return errorResponse("not_implemented", e.message, 501, requestId);
    return errorResponse("validation_failed", e.message, e.status, requestId, e.description ? { description: e.description } : undefined);
  }
  return errorResponse("internal_error", "Service unavailable", 503, requestId);
}

/** Runs an action in the transaction; a failure is answered once the transaction has committed what came before it. */
async function act<T>(env: Env, runner: PlatformMoreRunner, fn: (store: PlatformMoreStore) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return runner(env, async (store) => {
    try {
      return { ok: true as const, value: await fn(store) };
    } catch (error) {
      if (error instanceof ValidationFailed || error instanceof SettingsError) return { ok: false as const, error };
      throw error;
    }
  });
}

/**
 * `page` is settings/… (isPlatformMorePage); `allowed` is DP-79's gate (null when the actor may, else the
 * denial's 404). `runner` is replaceable for tests.
 */
export async function handlePlatformMore(
  env: Env,
  requestId: string,
  page: string,
  request: Request,
  allowed: (action: string) => Promise<Response | null>,
  runner: PlatformMoreRunner = runPlatformMoreAsAdmin,
): Promise<Response> {
  const method = request.method;
  // The gate first: a customer's other methods are the same 404, not a 405 that says the page exists.
  const denied = await allowed(method === "PATCH" ? "platform.settings.update" : "platform.settings.read");
  if (denied) return denied;
  if (method !== "GET" && method !== "PATCH") return methodNotAllowed(requestId);
  const canUpdate = method === "PATCH" || (await allowed("platform.settings.update")) === null;
  const [, name, provider = null] = page.split("/") as [string, string, string?];
  const body: Props = method === "PATCH" ? await readJson(request) : {};
  const action = body.action;

  try {
    if (name === "updates") {
      if (method === "GET") return successResponse({ settings: updatesView(await runner(env, (s) => s.updates.load())), canUpdate }, requestId);
      if (!isUpdatesAction(action)) return validationError(requestId, { action: ["The selected action is invalid."] });
      const r = await act(env, runner, (s) => runUpdatesAction(s.updates, action, body));
      if (!r.ok) return failure(r.error, requestId);
      return successResponse({ settings: updatesView(r.value.row), message: r.value.message }, requestId);
    }

    if (name === "backup") {
      // Freeploy has no instance database resource (StandalonePostgresql 0): the page shows "Backup is not configured".
      if (method === "GET") return successResponse({ configured: false, canUpdate }, requestId);
      if (action !== "addCoolifyDatabase") return validationError(requestId, { action: ["The selected action is invalid."] });
      return failure(new SettingsError(BACKUP_MESSAGES.configureNeedsExecutor, 501), requestId);
    }

    if (name === "email") {
      const testEmailAddress = request.headers.get("x-actor-email");
      if (method === "GET") return successResponse({ settings: emailSettingsView(await runner(env, (s) => s.email.load()), canUpdate, testEmailAddress), canUpdate }, requestId);
      if (!isPlatformEmailAction(action)) return validationError(requestId, { action: ["The selected action is invalid."] });
      const r = await act(env, runner, (s) => runPlatformEmailAction(s.email, action, body));
      if (!r.ok) return failure(r.error, requestId);
      return successResponse({ settings: emailSettingsView(r.value.row, canUpdate, testEmailAddress), canUpdate, message: r.value.message, saved: r.value.saved }, requestId);
    }

    // oauth
    if (method === "GET") {
      const page = await runner(env, async (s) => ({ rows: await s.oauth.list(), policy: await s.oauth.loadRegistrationPolicy() }));
      // mount(): abort(404) for a provider the instance does not have.
      if (provider !== null && !page.rows.some((r) => r.provider === provider)) return notFound(requestId, new URL(request.url).pathname);
      return successResponse({ ...oauthView(page.rows, page.policy, canUpdate), selectedProvider: provider, canUpdate }, requestId);
    }
    if (!isOauthAction(action)) return validationError(requestId, { action: ["The selected action is invalid."] });
    const r = await act(env, runner, (s) => runOauthAction(s.oauth, action, provider, body));
    if (!r.ok) return failure(r.error, requestId);
    return successResponse({ ...oauthView(r.value.rows, r.value.registrationPolicy, canUpdate), selectedProvider: provider, canUpdate, message: r.value.message, error: r.value.error }, requestId);
  } catch {
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
