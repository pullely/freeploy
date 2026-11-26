// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/Proxy/{Show,DynamicConfigurations,CertificatesShow,Logs}.php,
// app/Livewire/Server/Security/{Index,HostKey,TerminalAccess,Patches}.php, app/Livewire/Server/CloudflareTunnel.php,
// app/Livewire/Server/Sentinel/Logs.php, app/Livewire/Server/Transfer.php, app/Livewire/Server/Resources.php,
// app/Livewire/Server/DockerImages.php, app/Livewire/Project/Shared/GetLogs.php (canReadSingleContainer),
// app/Helpers/SshMultiplexingHelper.php (hostKeyCheckingMode), app/Models/Server.php (proxySet, definedResources,
// loadUnmanagedContainers, assertNotTransferredAway) and app/Policies/ServerPolicy.php (view, update, viewSentinel,
// viewSecurity, transfer) (Apache-2.0), modified.
//
// /v1/organizations/{org}/deploy/servers/{uuid}/… — the server pages DP-96 ports, routed here by handleServers
// (servers.ts). Each reads the server and server_settings rows the other server pages and /api/v1 (DP-88) write, and
// reuses DP-88's helpers for them (findServer, functional, setTunnel, saveSettings, the transfer checks,
// definedResources and the status accessors). Where Coolify runs a command on the server, the route answers 501
// "… needs the SSH executor, which is not available yet." after Coolify's own checks and before anything is stored;
// where Coolify runs it and carries on whatever it answers, the change is stored and the answer carries `unavailable`.
//
//   GET   /proxy                          Proxy/Show (and the proxy submenu): the proxy's type and status
//   POST  /proxy/dynamic                  DynamicConfigurations::loadDynamicConfigurations — reads over SSH (501)
//   POST  /proxy/certificates             Proxy/Certificates — reads acme.json over SSH (501)
//   POST  /proxy/logs                     GetLogs for coolify-proxy: nothing on a server that is not functional, else 501
//   GET   /security                       Security/Index with HostKey and TerminalAccess (update: writers)
//   POST  /security/terminal              TerminalAccess::toggleTerminal
//   POST  /security/host-key/{trust,reset,check}
//   PATCH /security/host-key/mode         HostKey's four changes: Coolify's checks, then ServerConnectionCheckJob (501)
//   GET   /security/patches               Security/Patches (viewSecurity: writers): the stored check
//   POST  /security/patches/check         Patches::checkForUpdates — runs the package manager over SSH (501)
//   GET   /cloudflare-tunnel              CloudflareTunnel
//   POST  /cloudflare-tunnel/manual       CloudflareTunnel::manualCloudflareConfig
//   POST  /cloudflare-tunnel/disable      CloudflareTunnel::toggleCloudflareTunnels
//   POST  /cloudflare-tunnel/update       CloudflareTunnel::updateCloudflareTunnel — UpdateCloudflared over SSH (501)
//   GET   /sentinel/logs                  Sentinel/Logs (viewSentinel: writers)
//   POST  /sentinel/logs                  GetLogs for coolify-sentinel: nothing on a server that is not functional, else 501
//   GET   /transfer                       Transfer (update: writers): the transfer's metadata
//   POST  /transfer/migrate               Transfer::migrateServer { targetUrl, targetToken }: the migrator's checks, then 501
//   GET   /resources                      Resources: definedResources() with their project, environment and status
//   POST  /resources/unmanaged            Resources::loadUnmanagedContainers: none on a server that is not functional, else 501
//   GET   /images                         DockerImages
//   POST  /images                         DockerImages::load: nothing on a server that is not functional, else 501
//
// Coolify's policy: view = team member; update, viewSentinel, viewSecurity and transfer = team admin (transfer the
// owner). Here deploy.resource.read and deploy.resource.write, as every server page; a denial answers 404.
import type { Env } from "../env.js";
import type { ActorContext } from "../router.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { findServerByUuid, withOrg, type ApiRow, type DeployServerRow } from "@saas/db/deploy";
import { errorResponse, methodNotAllowed, successResponse } from "../http.js";
import { serverShow, type ServerShow } from "../servers/service.js";
import { sentinelStatus, type SentinelStatus } from "../servers/settings.js";
import { dohResolver, type HostResolver } from "../s3-storages/safe-url.js";
import { DEFAULT_CONSOLE_URL } from "./notifications.js";
import { authorizeDeploy, readJson } from "./cloud-tokens.js";
import { rowsOf } from "../api-v1/context.js";
import { rowValue } from "../api-v1/models.js";
import { sshFingerprints } from "../api-v1/handler.js";
import { definedResources, resourceStatus } from "../api-v1/servers.js";
import { findServer, functional, isBuildServer, proxyOf, saveSettings, sentinelEnabled, setTunnel, transferredAway, type Found } from "../api-v1/server-settings.js";
import { metadataOf, transferStartError } from "../api-v1/server-registries-transfer.js";

export const SERVER_PAGES = ["proxy", "security", "cloudflare-tunnel", "transfer", "resources", "images"] as const;

/**
 * Freeploy's convention (needsExecutor() of applications/resources.ts), written out: this module loads inside the
 * router's import cycle, so its constants use no imported value. The texts DP-88 also answers are the same.
 */
const needsExecutor = (what: string): string => `${what} needs the SSH executor, which is not available yet.`;

export const SERVER_PAGE_MESSAGES = {
  dynamicUnavailable: needsExecutor("Reading the dynamic configurations on the server"),
  certificatesUnavailable: needsExecutor("Reading the TLS certificates on the server"),
  proxyLogsUnavailable: needsExecutor("Reading the proxy logs on the server"),
  sentinelLogsUnavailable: needsExecutor("Reading the Sentinel logs on the server"),
  /** /api/v1's reset_host_key (DP-88). */
  hostKeyUnavailable: needsExecutor("Checking the server's connection with the new host key"),
  patchCheckUnavailable: needsExecutor("Checking the server for package updates"),
  cloudflaredRemoveUnavailable: needsExecutor("Removing cloudflared from the server"),
  tunnelTeardownUnavailable: needsExecutor("Deleting the Cloudflare tunnel and removing cloudflared from the server"),
  cloudflaredUpdateUnavailable: needsExecutor("Updating cloudflared on the server"),
  unmanagedUnavailable: needsExecutor("Listing the containers on the server"),
  imagesUnavailable: needsExecutor("Reading the Docker images on the server"),
  /** /api/v1's migrate (DP-88). */
  migrateUnavailable: needsExecutor("Running the transfer checks"),
  /** HostKey::changeHostKey(): canBeValidated(). */
  transferred: "This server was transferred to another Coolify instance.",
  /** Server::assertNotTransferredAway(). */
  managedElsewhere: "This server is managed by another Coolify instance.",
  noPendingKey: "There is no new host key to trust.",
  pendingKeyChanged: "The server sent another new host key. Reload the page and compare the key again.",
  checkDisabled: "The host key check is disabled for this server. Reload the page and enable the check first.",
  localhostTransfer: "The Coolify host (localhost) cannot be transferred.",
  tunnelEnabled: "Cloudflare Tunnel enabled.",
  tunnelDisabledRestored: "Cloudflare Tunnel disabled. Manually updated the server IP address to its previous IP address.",
  tunnelDisabledActionRequired: "Cloudflare Tunnel disabled. Action required: Update the server IP address to its real IP address in the Advanced settings.",
  terminal: (enabled: boolean) => `Terminal access has been ${enabled ? "enabled" : "disabled"}.`,
} as const;

/** Runs fn in one transaction confined to the org (withOrg); replaceable for tests. */
export type ServerPagesRunner = <T>(env: Env, orgId: string, fn: (tx: SqlExecutor) => Promise<T>) => Promise<T>;

export const runServerPagesInOrg: ServerPagesRunner = async (env, orgId, fn) => {
  const db = createSqlExecutor(env.PLATFORM_DB!);
  try {
    return await withOrg(db, orgId, fn);
  } finally {
    await db.dispose();
  }
};

/** Whether handleServers routes what follows /servers/{uuid} here. */
export function isServerPageRoute(rest: readonly string[]): boolean {
  return (SERVER_PAGES as readonly string[]).includes(rest[0] ?? "") || (rest[0] === "sentinel" && rest[1] === "logs" && rest.length === 2);
}

/** A refusal as handleError() shows it: the message as the error toast. */
class PageError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

interface Loaded {
  row: DeployServerRow;
  f: Found;
  server: ServerShow;
}

async function load(tx: SqlExecutor, uuid: string): Promise<Loaded | null> {
  const row = await findServerByUuid(tx, uuid);
  const f = row ? await findServer(tx, uuid) : null;
  return row && f ? { row, f, server: serverShow(row) } : null;
}

const setting = (f: Found, k: string): unknown => rowValue(f.settings, k);
const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === ""));

/** Server::proxySet(): a proxy type but NONE, on a functional server that is not a Swarm worker and can host resources. */
function proxySet(f: Found): boolean {
  const type = proxyOf(f).type;
  return filled(type) && type !== "NONE" && functional(f) && setting(f, "is_swarm_worker") !== true && !isBuildServer(f);
}

/** Freeploy reads no SSH_HOST_KEY_CHECKING: the instance mode is Coolify's default, warn. */
const INSTANCE_HOST_KEY_MODE = "warn";

/** SshMultiplexingHelper::hostKeyCheckingMode() */
function hostKeyMode(f: Found): "warn" | "enforce" | "off" {
  if (setting(f, "is_ssh_host_key_check_disabled") === true) return "off";
  return setting(f, "is_ssh_host_key_check_enforced") === true ? "enforce" : "warn";
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Carbon's toDateTimeString() of a UTC timestamp column. */
function dateTime(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const s = v instanceof Date ? v.toISOString() : String(v);
  return s.replace("T", " ").replace(/(\.\d+)?(Z|[+-]\d\d:?\d\d)?$/, "").slice(0, 19);
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * segments: what follows /servers/{uuid} (["proxy"], ["security", "host-key", "trust"], …).
 * `runner` and `resolve` are replaceable for tests.
 */
export async function handleServerPages(
  env: Env,
  requestId: string,
  actor: ActorContext,
  orgId: string,
  uuid: string,
  segments: string[],
  request: Request,
  runner: ServerPagesRunner = runServerPagesInOrg,
  resolve: HostResolver = dohResolver,
): Promise<Response> {
  const method = request.method;
  const path = segments.join("/");
  const notFound = () => errorResponse("not_found", "Not found", 404, requestId);
  type Op = { write: boolean; run: (canWrite: boolean) => Promise<Response> };
  const routes: Record<string, Partial<Record<string, Op>>> = {
    proxy: { GET: { write: false, run: proxyPage } },
    "proxy/dynamic": { POST: { write: false, run: () => onServer(SERVER_PAGE_MESSAGES.dynamicUnavailable) } },
    "proxy/certificates": { POST: { write: false, run: () => onServer(SERVER_PAGE_MESSAGES.certificatesUnavailable) } },
    "proxy/logs": { POST: { write: false, run: () => logs(SERVER_PAGE_MESSAGES.proxyLogsUnavailable) } },
    security: { GET: { write: true, run: securityPage } },
    "security/terminal": { POST: { write: true, run: toggleTerminal } },
    "security/host-key/trust": { POST: { write: true, run: () => hostKey("trust") } },
    "security/host-key/reset": { POST: { write: true, run: () => hostKey("reset") } },
    "security/host-key/check": { POST: { write: true, run: () => hostKey("check") } },
    "security/host-key/mode": { PATCH: { write: true, run: () => hostKey("mode") } },
    "security/patches": { GET: { write: true, run: patchesPage } },
    "security/patches/check": { POST: { write: true, run: () => onServer(SERVER_PAGE_MESSAGES.patchCheckUnavailable, true) } },
    "cloudflare-tunnel": { GET: { write: false, run: tunnelPage } },
    "cloudflare-tunnel/manual": { POST: { write: true, run: enableTunnel } },
    "cloudflare-tunnel/disable": { POST: { write: true, run: disableTunnel } },
    "cloudflare-tunnel/update": { POST: { write: true, run: () => onServer(SERVER_PAGE_MESSAGES.cloudflaredUpdateUnavailable) } },
    "sentinel/logs": { GET: { write: true, run: sentinelLogsPage }, POST: { write: true, run: () => logs(SERVER_PAGE_MESSAGES.sentinelLogsUnavailable) } },
    transfer: { GET: { write: true, run: transferPage } },
    "transfer/migrate": { POST: { write: true, run: migrate } },
    resources: { GET: { write: false, run: resourcesPage } },
    "resources/unmanaged": { POST: { write: false, run: () => fromServer(SERVER_PAGE_MESSAGES.unmanagedUnavailable, { containers: [] }) } },
    images: { GET: { write: false, run: imagesPage }, POST: { write: false, run: () => fromServer(SERVER_PAGE_MESSAGES.imagesUnavailable, { images: [], usage: null }) } },
  };
  const route = routes[path];
  if (!route) return notFound();
  const op = route[method];
  if (!op) return methodNotAllowed(requestId);

  const page = <T>(fn: (l: Loaded, tx: SqlExecutor) => Promise<T>) =>
    runner(env, orgId, async (tx) => {
      const l = await load(tx, uuid);
      return l ? fn(l, tx) : null;
    });
  const ok = (data: unknown) => (data === null ? notFound() : successResponse(data, requestId));

  /** A route whose whole work runs on the server: the server, then 501 (functional or not, Coolify would try). */
  async function onServer(text: string, managedHere = false): Promise<Response> {
    const found = await page(async (l) => {
      // Patches::checkForUpdates(): ensureManagedHere().
      if (managedHere && transferredAway(l.f)) throw new PageError(SERVER_PAGE_MESSAGES.managedElsewhere);
      return true;
    });
    return found ? errorResponse("unsupported", text, 501, requestId) : notFound();
  }

  /** What Coolify reads from a functional server only: the empty answer it gives otherwise, else 501. */
  async function fromServer(text: string, empty: Record<string, unknown>): Promise<Response> {
    const isFunctional = await page(async (l) => functional(l.f));
    if (isFunctional === null) return notFound();
    return isFunctional ? errorResponse("unsupported", text, 501, requestId) : successResponse(empty, requestId);
  }

  /** GetLogs: a server that is not functional has no logs to read (canReadSingleContainer() is false). */
  const logs = (text: string) => fromServer(text, { logs: "" });

  async function proxyPage(canWrite: boolean): Promise<Response> {
    return ok(
      await page(async (l) => {
        const proxy = proxyOf(l.f);
        return { server: l.server, proxy: { type: (proxy.type as string | undefined) ?? null, status: (proxy.status as string | undefined) ?? null }, proxySet: proxySet(l.f), canUpdate: canWrite };
      }),
    );
  }

  async function securityPage(canWrite: boolean): Promise<Response> {
    return ok(
      await page(async (l) => {
        const pending = setting(l.f, "ssh_host_key_pending");
        return {
          server: l.server,
          hostKey: {
            mode: hostKeyMode(l.f),
            instanceMode: INSTANCE_HOST_KEY_MODE,
            fingerprints: (await sshFingerprints(setting(l.f, "ssh_host_key"))) as string[],
            pendingFingerprints: (await sshFingerprints(pending)) as string[],
            pendingKeyHash: filled(pending) ? await sha256Hex(String(pending)) : null,
            source: (setting(l.f, "ssh_host_key_source") as string | null) ?? null,
            trustedAt: dateTime(setting(l.f, "ssh_host_key_trusted_at")),
            checkDisabled: setting(l.f, "is_ssh_host_key_check_disabled") === true,
            checkEnforced: setting(l.f, "is_ssh_host_key_check_enforced") === true,
          },
          terminal: { isTerminalEnabled: setting(l.f, "is_terminal_enabled") === true },
          canUpdate: canWrite,
        };
      }),
    );
  }

  /** toggleTerminal(): the setting flipped and saved (the password confirmation is not ported). */
  async function toggleTerminal(): Promise<Response> {
    return ok(
      await page(async (l, tx) => {
        const enabled = setting(l.f, "is_terminal_enabled") !== true;
        await saveSettings(tx, l.f, { is_terminal_enabled: enabled });
        return { terminal: { isTerminalEnabled: enabled }, message: SERVER_PAGE_MESSAGES.terminal(enabled) };
      }),
    );
  }

  /**
   * HostKey::changeHostKey(): the server not transferred away, then the change's own checks; Coolify saves the change
   * and queues ServerConnectionCheckJob, which connects over SSH: 501 before anything is stored (as /api/v1's
   * reset_host_key, DP-88).
   */
  async function hostKey(action: "trust" | "reset" | "check" | "mode"): Promise<Response> {
    const body = await readJson(request);
    // setHostKeyCheckMode(): anything but warn or enforce changes nothing.
    if (action === "mode" && body.mode !== "warn" && body.mode !== "enforce") return (await page(async () => true)) ? successResponse({ changed: false }, requestId) : notFound();
    const found = await page(async (l) => {
      if (transferredAway(l.f)) throw new PageError(SERVER_PAGE_MESSAGES.transferred);
      const pending = setting(l.f, "ssh_host_key_pending");
      if (action === "trust") {
        if (!filled(pending)) throw new PageError(SERVER_PAGE_MESSAGES.noPendingKey);
        if (typeof body.pendingKeyHash !== "string" || (await sha256Hex(String(pending))) !== body.pendingKeyHash) throw new PageError(SERVER_PAGE_MESSAGES.pendingKeyChanged);
      }
      if (action === "mode" && setting(l.f, "is_ssh_host_key_check_disabled") === true) throw new PageError(SERVER_PAGE_MESSAGES.checkDisabled);
      return true;
    });
    return found ? errorResponse("unsupported", SERVER_PAGE_MESSAGES.hostKeyUnavailable, 501, requestId) : notFound();
  }

  async function patchesPage(canWrite: boolean): Promise<Response> {
    return ok(
      await page(async (l) => {
        const result = asObject(setting(l.f, "patch_check_result"));
        const updates = Array.isArray(result.updates) ? result.updates : [];
        return {
          server: l.server,
          patches: {
            checkedAt: dateTime(setting(l.f, "patch_checked_at")),
            error: (setting(l.f, "patch_check_error") as string | null) ?? null,
            totalUpdates: updates.length,
            securityUpdates: typeof result.security_updates === "number" ? result.security_updates : null,
            rebootRequired: result.reboot_required === true,
            packageManager: typeof result.package_manager === "string" ? result.package_manager : null,
            frequency: (setting(l.f, "patch_check_frequency") as string | null) ?? "",
          },
          canUpdate: canWrite,
        };
      }),
    );
  }

  async function tunnelPage(canWrite: boolean): Promise<Response> {
    return ok(
      await page(async (l) => ({
        server: l.server,
        tunnel: {
          enabled: setting(l.f, "is_cloudflare_tunnel") === true,
          // CloudflareTunnelService::tunnelName() of a tunnel Coolify manages through the Cloudflare API.
          managedTunnelName: filled(setting(l.f, "cloudflare_tunnel_id")) ? `coolify-${l.row.uuid}` : null,
          ipPrevious: (rowValue(l.f.server, "ip_previous") as string | null) ?? null,
        },
        canUpdate: canWrite,
      })),
    );
  }

  /** manualCloudflareConfig(): not transferred away, then the setting saved (its updated hook forgets the host key). */
  async function enableTunnel(): Promise<Response> {
    return ok(
      await page(async (l, tx) => {
        if (transferredAway(l.f)) throw new PageError(SERVER_PAGE_MESSAGES.managedElsewhere);
        await setTunnel(tx, l.f, true);
        return { enabled: true, message: SERVER_PAGE_MESSAGES.tunnelEnabled, level: "success", unavailable: null };
      }),
    );
  }

  /**
   * toggleCloudflareTunnels(): a tunnel Coolify manages is torn down through the Cloudflare API and over SSH first
   * (501); otherwise Coolify runs `docker rm -f coolify-cloudflared` without waiting for it (remote_process with
   * throwError false), saves the setting and restores the previous IP: the rows are changed and the answer says the
   * command needs the SSH executor.
   */
  async function disableTunnel(): Promise<Response> {
    const r = await page(async (l, tx) => {
      if (transferredAway(l.f)) throw new PageError(SERVER_PAGE_MESSAGES.managedElsewhere);
      if (filled(setting(l.f, "cloudflare_tunnel_id"))) throw new PageError(SERVER_PAGE_MESSAGES.tunnelTeardownUnavailable, 501);
      const restored = filled(rowValue(l.f.server, "ip_previous"));
      await setTunnel(tx, l.f, false);
      return {
        enabled: false,
        message: restored ? SERVER_PAGE_MESSAGES.tunnelDisabledRestored : SERVER_PAGE_MESSAGES.tunnelDisabledActionRequired,
        level: restored ? "success" : "warning",
        unavailable: SERVER_PAGE_MESSAGES.cloudflaredRemoveUnavailable,
      };
    });
    return ok(r);
  }

  async function sentinelLogsPage(canWrite: boolean): Promise<Response> {
    return ok(
      await page(async (l) => {
        const status: SentinelStatus = sentinelStatus({
          sentinel_waiting_since: rowValue(l.f.server, "sentinel_waiting_since") as string | null,
          sentinel_updated_at: rowValue(l.f.server, "sentinel_updated_at") as string | null,
          sentinel_push_interval_seconds: setting(l.f, "sentinel_push_interval_seconds") as number,
        } as never);
        return { server: l.server, sentinel: { enabled: sentinelEnabled(l.f), status }, canUpdate: canWrite };
      }),
    );
  }

  async function transferPage(canWrite: boolean): Promise<Response> {
    return ok(
      await page(async (l) => {
        const metadata = metadataOf(l.f.server);
        const transfer = asObject(metadata.transfer);
        const migration = metadata.migration && typeof metadata.migration === "object" ? asObject(metadata.migration) : null;
        const consoleUrl = (env.DEPLOY_CONSOLE_URL || DEFAULT_CONSOLE_URL).replace(/\/+$/, "");
        const conflict = asObject(transfer.owner_marker_conflict);
        return {
          server: l.server,
          transfer: {
            // getIsLocalhostProperty(): the Coolify host (id 0), which Freeploy does not have.
            isCoolifyHost: Number(l.row.id) === 0,
            exportId: typeof transfer.export_id === "string" ? transfer.export_id : null,
            transferredAway: transferredAway(l.f),
            markerConflict: transfer.owner_marker_conflict ? { instanceUrl: typeof conflict.instance_url === "string" ? conflict.instance_url : null } : null,
            migration: migration
              ? {
                  status: typeof migration.status === "string" ? migration.status : null,
                  phase: typeof migration.phase === "string" ? migration.phase : null,
                  error: typeof migration.error === "string" ? migration.error : null,
                  targetUrl: typeof migration.target_url === "string" ? migration.target_url : null,
                  log: (Array.isArray(migration.log) ? migration.log : []).map((e) => {
                    const entry = asObject(e);
                    return { at: String(entry.at ?? ""), level: String(entry.level ?? "info"), message: String(entry.message ?? "") };
                  }),
                  checklist: (Array.isArray(migration.checklist) ? migration.checklist : []).filter((s): s is string => typeof s === "string"),
                  warnings: (Array.isArray(migration.warnings) ? migration.warnings : []).filter((s): s is string => typeof s === "string"),
                }
              : null,
            thisInstanceUrl: consoleUrl,
          },
          canUpdate: canWrite,
        };
      }),
    );
  }

  /** migrateServer(): the transfer policy, not the Coolify host, then ServerTransferMigrator::start()'s checks; its SSH and target checks need the executor (501). */
  async function migrate(): Promise<Response> {
    const body = await readJson(request);
    const found = await page(async (l) => {
      if (Number(l.row.id) === 0) throw new PageError(SERVER_PAGE_MESSAGES.localhostTransfer);
      const refused = await transferStartError({ env }, body.targetUrl, body.targetToken, l.f.server, resolve);
      if (refused) throw new PageError(refused);
      return true;
    });
    return found ? errorResponse("unsupported", SERVER_PAGE_MESSAGES.migrateUnavailable, 501, requestId) : notFound();
  }

  /** Resources::render() for the managed tab: definedResources() with what each row shows. */
  async function resourcesPage(canWrite: boolean): Promise<Response> {
    return ok(
      await page(async (l, tx) => {
        const rows = rowsOf(tx);
        const environments = new Map<string, ApiRow>((await rows("environments")).map((e) => [String(rowValue(e, "id")), e]));
        const projects = new Map<string, ApiRow>((await rows("projects")).map((p) => [String(rowValue(p, "id")), p]));
        const resources = [];
        for (const r of await definedResources(rows, l.f.server)) {
          const environment = environments.get(String(rowValue(r.row, "environment_id")));
          const project = environment ? projects.get(String(rowValue(environment, "project_id"))) : undefined;
          const resourceUuid = String(rowValue(r.row, "uuid"));
          const link = environment && project ? `/project/${String(rowValue(project, "uuid"))}/environment/${String(rowValue(environment, "uuid"))}/${r.kind}/${resourceUuid}` : null;
          resources.push({
            uuid: resourceUuid,
            name: String(rowValue(r.row, "name") ?? ""),
            type: r.type,
            status: await resourceStatus(rows, r),
            project: project ? String(rowValue(project, "name") ?? "") : null,
            environment: environment ? String(rowValue(environment, "name") ?? "") : null,
            link,
          });
        }
        return { server: l.server, resources, canUpdate: canWrite };
      }),
    );
  }

  async function imagesPage(canWrite: boolean): Promise<Response> {
    return ok(await page(async (l) => ({ server: l.server, canUpdate: canWrite })));
  }

  const auth = await authorizeDeploy(env, requestId, actor, orgId, op.write);
  if (!auth.ok) return auth.response;
  try {
    return await op.run(auth.canWrite);
  } catch (e) {
    if (e instanceof PageError) return errorResponse(e.status === 501 ? "unsupported" : "validation_failed", e.message, e.status, requestId);
    return errorResponse("internal_error", "Service unavailable", 503, requestId);
  }
}
