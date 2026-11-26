// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Notifications/{Email,Discord,Telegram,Slack,Pushover,Webhook}.php,
// app/Policies/NotificationPolicy.php and app/Models/Team.php::isAnyNotificationEnabled() (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/notifications — the Notifications pages.
//
//   GET    /notifications                    which channels are on (the layout's "No notifications enabled" reminder)
//   GET    /notifications/{channel}          the page: the component's properties (secrets only for who can update)
//   PATCH  /notifications/{channel}          { action, ...properties }: a component action (settings.ts) —
//                                            chat channels: submit, instantSave, instantSaveEnabled, toggleEnabled,
//                                            instantSavePingEnabled (Discord), toggleEvent { property };
//                                            email: submit, selectEmailProvider, instantSave { type },
//                                            instantSaveDeploymentCommitDetails, toggleEvent { property }
//   POST   /notifications/{channel}/test     sendTestNotification; email: sendTestEmail { testEmailAddress }
//
// {channel} is email, discord, telegram, slack, pushover or webhook. Coolify's policy: view is a team member,
// update and sendTest are a team admin. Here: deploy.resource.read for the reads and deploy.resource.write
// for the rest, asked of policy-worker after membership-worker's facts; a denial answers 404.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import {
  withOrg,
  loadKek,
  orgDek,
  encryptField,
  decryptField,
  isEncryptedColumn,
  ensureNotificationSettings,
  updateNotificationSettings,
  recordNotificationDeliveryFailure,
  recordNotificationDeliverySuccess,
  disableNotificationChannel,
  type OrgDek,
} from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse, validationError } from "../http.js";
import { authorizeDeploy, readJson } from "./cloud-tokens.js";
import type { PayloadContext } from "../notifications/messages.js";
import { isChannelEnabled, notify, type DeliveryOutcome, type DeliveryRecorder, type Fetch, type OrgChannelSettings } from "../notifications/delivery.js";
import type { Notification } from "../notifications/notification.js";
import {
  activeEmailProvider,
  channelView,
  emailView,
  isChannelAction,
  isEmailAction,
  NOTIFICATION_CHANNEL_LIST,
  runChannelAction,
  runEmailAction,
  SETTINGS_MESSAGES,
  SettingsError,
  ValidationFailed,
  type NotificationChannel,
  type SettingsRow,
  type SettingsStore,
} from "../notifications/settings.js";
import { sendTestEmail, sendTestNotification, TestEmailLimiter } from "../notifications/test-send.js";

/** The console's URL: base_url() of the links in notifications. */
export const DEFAULT_CONSOLE_URL = "https://app.freeploy.dev";

/** Freeploy's PayloadContext: its name where Coolify's messages say "Coolify". */
export function freeployContext(env: Env, now: () => number = () => Math.floor(Date.now() / 1000)): PayloadContext {
  const baseUrl = (env.DEPLOY_CONSOLE_URL || DEFAULT_CONSOLE_URL).replace(/\/+$/, "");
  return { baseUrl, appUrl: baseUrl, brand: "Freeploy", appName: "Freeploy", discordFooter: "Freeploy", subscriptionUrl: `${baseUrl}/subscription`, now };
}

export interface NotificationContext {
  store: SettingsStore;
  recorder: DeliveryRecorder;
}

/** Runs fn with one org's settings store, in one transaction confined to that org. */
export type NotificationRunner = <T>(env: Env, orgId: string, fn: (ctx: NotificationContext) => Promise<T>) => Promise<T>;

const table = (channel: NotificationChannel) => `${channel}_notification_settings`;

/** The store over deploy.*_notification_settings: encrypted columns encrypted with the org's data key. */
export function sqlNotificationStore(tx: SqlExecutor, orgId: string, secret: string | undefined): NotificationContext {
  let dek: Promise<OrgDek> | null = null;
  const key = () => (dek ??= loadKek(secret).then((kek) => orgDek(tx, orgId, kek)));
  const decrypt = async (channel: NotificationChannel, row: Record<string, unknown>): Promise<SettingsRow> => {
    const out: SettingsRow = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = isEncryptedColumn(table(channel), k) && typeof v === "string" && v !== "" ? await decryptField(await key(), `${table(channel)}.${k}`, v) : v;
    }
    return out;
  };
  return {
    store: {
      load: async (channel) => decrypt(channel, await ensureNotificationSettings(tx, channel, orgId)),
      save: async (channel, changes) => {
        const stored: SettingsRow = {};
        for (const [k, v] of Object.entries(changes)) {
          stored[k] = isEncryptedColumn(table(channel), k) && typeof v === "string" && v !== "" ? await encryptField(await key(), `${table(channel)}.${k}`, v) : v;
        }
        await ensureNotificationSettings(tx, channel, orgId);
        const row = await updateNotificationSettings(tx, channel, stored);
        return decrypt(channel, row ?? {});
      },
    },
    recorder: {
      recordFailure: async (channel) => (await recordNotificationDeliveryFailure(tx, channel)) ?? { failureCount: 0, enabled: false },
      disable: (channel) => disableNotificationChannel(tx, channel),
      recordSuccess: (channel) => recordNotificationDeliverySuccess(tx, channel),
    },
  };
}

export const runNotificationsInOrg: NotificationRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, (tx) => fn(sqlNotificationStore(tx, orgId, env.DEPLOY_ENCRYPTION_KEY)));
  } finally {
    await db.dispose();
  }
};

/** The org's six rows (for notify() and the summary). */
export async function loadOrgChannelSettings(store: SettingsStore): Promise<OrgChannelSettings> {
  const entries = await Promise.all(NOTIFICATION_CHANNEL_LIST.map(async (c) => [c, await store.load(c)] as const));
  return Object.fromEntries(entries) as OrgChannelSettings;
}

const defaultFetch: Fetch = (url, init) => fetch(url, init);
const limiter = new TestEmailLimiter();

/**
 * notify(org, notification): Team::notify() for an org — its enabled channels and event toggles, the
 * ported payloads, the jobs' retries and failure counting. Each database step is its own short
 * transaction, so no transaction is held while a channel answers. Nothing calls it yet: deployments,
 * backups and server checks will once the executor runs them (WAITING W3); only "Send test" sends today.
 */
export async function notifyOrg(
  env: Env,
  orgId: string,
  notification: Notification,
  runner: NotificationRunner = runNotificationsInOrg,
  fetcher: Fetch = defaultFetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<DeliveryOutcome[]> {
  const recorder: DeliveryRecorder = {
    recordFailure: (channel, reason) => runner(env, orgId, (c) => c.recorder.recordFailure(channel, reason)),
    disable: (channel) => runner(env, orgId, (c) => c.recorder.disable(channel)),
    recordSuccess: (channel) => runner(env, orgId, (c) => c.recorder.recordSuccess(channel)),
  };
  return notify({ ctx: freeployContext(env), fetch: fetcher, sleep, recorder, loadSettings: () => runner(env, orgId, ({ store }) => loadOrgChannelSettings(store)) }, notification);
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

/**
 * segments: what follows /notifications, split on "/". `runner`, `fetcher` and `ctxFor` are replaceable for
 * tests.
 */
export async function handleNotifications(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  segments: string[],
  request: Request,
  runner: NotificationRunner = runNotificationsInOrg,
  fetcher: Fetch = defaultFetch,
  ctxFor: (env: Env) => PayloadContext = freeployContext,
  testLimiter: TestEmailLimiter = limiter,
): Promise<Response> {
  const method = request.method;
  const [first, second] = segments;
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  const channel = first as NotificationChannel | undefined;
  if (segments.length > 2 || (channel !== undefined && !NOTIFICATION_CHANNEL_LIST.includes(channel)) || (second !== undefined && second !== "test")) return notFound();

  let write: boolean;
  if (segments.length === 0) {
    if (method !== "GET") return methodNotAllowed(requestId);
    write = false;
  } else if (segments.length === 1) {
    if (method !== "GET" && method !== "PATCH") return methodNotAllowed(requestId);
    write = method === "PATCH";
  } else {
    if (method !== "POST") return methodNotAllowed(requestId);
    write = true;
  }
  const auth = await authorizeDeploy(env, requestId, actor, orgId, write);
  if (!auth.ok) return auth.response;
  const canUpdate = auth.canWrite;
  const ctx = ctxFor(env);
  const settingsUrl = `${ctx.baseUrl}/settings/advanced#endpoint-section`;

  try {
    if (!channel) {
      const settings = await runner(env, orgId, ({ store }) => loadOrgChannelSettings(store));
      const channels = Object.fromEntries(NOTIFICATION_CHANNEL_LIST.map((c) => [c, isChannelEnabled(c, settings[c])]));
      return successResponse({ channels, anyEnabled: Object.values(channels).some(Boolean), canUpdate }, requestId);
    }

    const view = (row: SettingsRow) => {
      if (channel === "email") {
        const emailEnabled = isChannelEnabled("email", row);
        return {
          channel,
          settings: emailView(row, canUpdate),
          activeEmailProvider: activeEmailProvider(row),
          failureCount: Number(row.failure_count ?? 0),
          canUpdate,
          // The disabled "Send test" button's title.
          sendTestReason: !canUpdate ? SETTINGS_MESSAGES.onlyAdminsTest : !emailEnabled ? SETTINGS_MESSAGES.saveProviderFirst : null,
          testEmailAddress: request.headers.get("x-actor-email"),
        };
      }
      return { channel, settings: channelView(channel, row, canUpdate), failureCount: Number(row.failure_count ?? 0), canUpdate };
    };

    if (segments.length === 1 && method === "GET") {
      const row = await runner(env, orgId, ({ store }) => store.load(channel));
      return successResponse(view(row), requestId);
    }

    const body = await readJson(request);
    if (segments.length === 1) {
      if (channel === "email") {
        if (!isEmailAction(body.action)) return validationError(requestId, { action: ["The selected action is invalid."] });
        const action = body.action;
        const result = await runner(env, orgId, ({ store }) => runEmailAction(store, action, body));
        return successResponse({ ...view(result.row), message: result.message, saved: result.saved }, requestId);
      }
      if (!isChannelAction(body.action)) return validationError(requestId, { action: ["The selected action is invalid."] });
      const action = body.action;
      const result = await runner(env, orgId, ({ store }) => runChannelAction(store, channel, action, body, settingsUrl));
      return successResponse({ ...view(result.row), message: result.message }, requestId);
    }

    // POST /notifications/{channel}/test
    const row = await runner(env, orgId, ({ store }) => store.load(channel));
    if (channel === "email") {
      const sent = await sendTestEmail(ctx, fetcher, orgId, row, body.testEmailAddress, testLimiter);
      return successResponse(sent, requestId);
    }
    const sent = await sendTestNotification(ctx, fetcher, channel, row);
    return successResponse(sent, requestId);
  } catch (e) {
    return failure(e, requestId);
  }
}
