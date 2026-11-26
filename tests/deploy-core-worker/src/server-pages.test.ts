// A server's proxy, security, Cloudflare Tunnel, Sentinel logs, transfer, resources and images pages (DP-96):
// Coolify's components as console routes over the API fixture's rows in Freeploy's database (PGlite with every
// deploy migration, row-level security on) — who may open and change each page, Coolify's messages, what is stored,
// what needs the SSH executor answered as not available yet with nothing stored, and one org never reaching
// another's server.
// The Worker's own module order (the router first), as its import cycle needs.
import "@deploy-core-worker/router";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { withOrg } from "@saas/db/deploy";
import type { Env } from "@deploy-core-worker/env";
import { handleServerPages, isServerPageRoute, SERVER_PAGE_MESSAGES, type ServerPagesRunner } from "@deploy-core-worker/handlers/server-pages";
import type { HostResolver } from "@deploy-core-worker/s3-storages/safe-url";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG1 = ORG_UUID[1]!;
const ORG2 = ORG_UUID[2]!;
const SERVER1 = "s1parityserveruuid000001";
const SERVER2 = "s2otherteamserver0000002";
const actor = { subjectId: "usr_1", subjectType: "user" };
const UNAVAILABLE = (what: string) => `${what} needs the SSH executor, which is not available yet.`;
const ED25519 = "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const ED25519_FINGERPRINT = "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU (ssh-ed25519)";

let fixture: FixtureDatabase;
beforeAll(async () => {
  fixture = await fixtureDatabase();
}, 120_000);
afterAll(async () => fixture?.pg.close());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

/** Host names as a test resolves them: no DNS is asked. */
const resolve: HostResolver = async (host) => (host === "private.example" ? ["10.0.0.5"] : ["93.184.216.34"]);

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string } };

/** The handler over the case's database: policy-worker allows read and write as given. */
function client(db: TransactionalSqlExecutor, allow: { read?: boolean; write?: boolean } = {}) {
  const asked: string[] = [];
  const env: Env = {
    ENVIRONMENT: "test",
    DEPLOY_ENCRYPTION_KEY: TEST_KEK,
    DEPLOY_CONSOLE_URL: "https://console.example",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const ok = body.action === "deploy.resource.write" ? (allow.write ?? true) : (allow.read ?? true);
      return json({ data: { decision: ok ? "allow" : "deny", allow: ok } });
    }),
  };
  const orgs: string[] = [];
  const runner: ServerPagesRunner = (_env, orgId, fn) => {
    orgs.push(orgId);
    return withOrg(db, orgId, fn);
  };
  const call = async (method: string, path: string, body?: unknown, opts: { org?: string; server?: string } = {}) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleServerPages(env, "req_1", actor, opts.org ?? ORG1, opts.server ?? SERVER1, path.split("/"), new Request(`https://x/${path}`, init), runner, resolve);
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { asked, orgs, call };
}

/** Team 1's server and its settings, read as the test's superuser (no org confinement needed for a check). */
async function settings(db: TransactionalSqlExecutor, column: string): Promise<unknown> {
  const r = await withOrg(db, ORG1, (tx) => tx.execute<{ v: unknown }>(`SELECT ss."${column}" AS v FROM deploy.server_settings ss JOIN deploy.servers s ON s.id = ss.server_id WHERE s.uuid = $1`, [SERVER1]));
  return r.rows[0]?.v;
}
async function server(db: TransactionalSqlExecutor, column: string): Promise<unknown> {
  const r = await withOrg(db, ORG1, (tx) => tx.execute<{ v: unknown }>(`SELECT s."${column}" AS v FROM deploy.servers s WHERE s.uuid = $1`, [SERVER1]));
  return r.rows[0]?.v;
}
const setSettings = (db: TransactionalSqlExecutor, sql: string, params: unknown[] = []) =>
  withOrg(db, ORG1, (tx) => tx.execute(`UPDATE deploy.server_settings SET ${sql} WHERE server_id = (SELECT id FROM deploy.servers WHERE uuid = '${SERVER1}')`, params));
const setServer = (db: TransactionalSqlExecutor, sql: string, params: unknown[] = []) => withOrg(db, ORG1, (tx) => tx.execute(`UPDATE deploy.servers SET ${sql} WHERE uuid = '${SERVER1}'`, params));
const makeFunctional = (db: TransactionalSqlExecutor) => setSettings(db, "is_reachable = true, is_usable = true");

describe("routing", () => {
  it("takes the DP-96 pages below a server and leaves the others to handleServers", () => {
    for (const rest of [["proxy"], ["proxy", "logs"], ["security", "host-key", "trust"], ["cloudflare-tunnel"], ["sentinel", "logs"], ["transfer", "migrate"], ["resources"], ["images"]]) expect([rest, isServerPageRoute(rest)]).toEqual([rest, true]);
    for (const rest of [["sentinel"], ["sentinel", "restart"], ["sentinel", "logs", "x"], ["registries"], ["advanced"], ["github-runners"]]) expect([rest, isServerPageRoute(rest)]).toEqual([rest, false]);
  });

  it("answers 404 for an unknown page and 405 for a method a page does not take", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect((await c.call("GET", "proxy/nope")).status).toBe(404);
      expect((await c.call("DELETE", "proxy")).status).toBe(405);
      expect((await c.call("GET", "transfer/migrate")).status).toBe(405);
      expect(c.asked).toEqual([]);
    });
  });
});

describe("authorization", () => {
  const readPages = ["proxy", "cloudflare-tunnel", "resources", "images"];
  const writePages = ["security", "security/patches", "sentinel/logs", "transfer"];

  it("gives the proxy, Cloudflare Tunnel, resources and images pages to a member, the others to who may update", async () => {
    await fixture.inCase(async (db) => {
      const member = client(db, { write: false });
      for (const page of readPages) {
        const r = await member.call("GET", page);
        expect([page, r.status, r.body.data?.canUpdate]).toEqual([page, 200, false]);
      }
      // Security (can.update.resource), Patching (viewSecurity), Sentinel logs (viewSentinel), Transfer (update): 404.
      for (const page of writePages) expect([page, (await member.call("GET", page)).status]).toEqual([page, 404]);
      const admin = client(db);
      for (const page of [...readPages, ...writePages]) {
        const r = await admin.call("GET", page);
        expect([page, r.status, r.body.data?.canUpdate]).toEqual([page, 200, true]);
      }
    });
  });

  it("refuses every change to a member, and everything to who may not read", async () => {
    await fixture.inCase(async (db) => {
      const member = client(db, { write: false });
      for (const [method, path] of [["POST", "security/terminal"], ["POST", "security/host-key/reset"], ["PATCH", "security/host-key/mode"], ["POST", "cloudflare-tunnel/manual"], ["POST", "cloudflare-tunnel/disable"], ["POST", "transfer/migrate"], ["POST", "security/patches/check"]] as const) {
        expect([path, (await member.call(method, path, {})).status]).toEqual([path, 404]);
      }
      expect(await settings(db, "is_terminal_enabled")).toBe(true);
      expect(await settings(db, "is_cloudflare_tunnel")).toBe(false);
      const stranger = client(db, { read: false, write: false });
      for (const page of readPages) expect([page, (await stranger.call("GET", page)).status]).toEqual([page, 404]);
    });
  });

  it("never reaches another org's server: its uuid is not found", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      for (const page of ["proxy", "security", "cloudflare-tunnel", "resources", "transfer"]) {
        expect([page, (await c.call("GET", page, undefined, { org: ORG2 })).status]).toEqual([page, 404]);
      }
      expect((await c.call("POST", "security/terminal", {}, { org: ORG2 })).status).toBe(404);
      expect((await c.call("POST", "cloudflare-tunnel/manual", {}, { org: ORG2 })).status).toBe(404);
      expect(await settings(db, "is_terminal_enabled")).toBe(true);
      expect(await settings(db, "is_cloudflare_tunnel")).toBe(false);
      // Team 2 reaches its own.
      expect((await c.call("GET", "proxy", undefined, { org: ORG2, server: SERVER2 })).status).toBe(200);
      expect(c.orgs.every((o) => o === ORG1 || o === ORG2)).toBe(true);
    });
  });
});

describe("the proxy pages", () => {
  it("reads the proxy from the row: no type yet, so the submenu shows only Configuration", async () => {
    await fixture.inCase(async (db) => {
      const r = await client(db).call("GET", "proxy");
      expect(r.body.data).toMatchObject({ server: { uuid: SERVER1, name: "parity-server", isFunctional: false }, proxy: { type: null, status: null }, proxySet: false });
    });
  });

  it("proxySet(): a type on a functional server that can host resources", async () => {
    await fixture.inCase(async (db) => {
      await setServer(db, `proxy = '{"type":"TRAEFIK","status":"exited","redirect_enabled":true}'::json`);
      const c = client(db);
      expect((await c.call("GET", "proxy")).body.data).toMatchObject({ proxy: { type: "TRAEFIK", status: "exited" }, proxySet: false });
      await makeFunctional(db);
      expect((await c.call("GET", "proxy")).body.data).toMatchObject({ proxySet: true });
      await setSettings(db, "server_role = 'build'");
      expect((await c.call("GET", "proxy")).body.data).toMatchObject({ proxySet: false });
    });
  });

  it("answers that reading the dynamic configurations and TLS certificates needs the SSH executor", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db, { write: false });
      expect(await c.call("POST", "proxy/dynamic")).toEqual({ status: 501, body: expect.objectContaining({ error: expect.objectContaining({ code: "unsupported", message: UNAVAILABLE("Reading the dynamic configurations on the server") }) }) });
      expect((await c.call("POST", "proxy/certificates")).body.error?.message).toBe(UNAVAILABLE("Reading the TLS certificates on the server"));
    });
  });

  it("GetLogs: no logs from a server that is not functional; reading a functional one's needs the executor", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db, { write: false });
      expect(await c.call("POST", "proxy/logs")).toEqual({ status: 200, body: expect.objectContaining({ data: { logs: "" } }) });
      await makeFunctional(db);
      const r = await c.call("POST", "proxy/logs");
      expect([r.status, r.body.error?.message]).toEqual([501, UNAVAILABLE("Reading the proxy logs on the server")]);
    });
  });
});

describe("Security", () => {
  it("shows the host key's fingerprints, its source and mode, and terminal access", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect((await c.call("GET", "security")).body.data).toMatchObject({
        hostKey: { mode: "warn", instanceMode: "warn", fingerprints: [], pendingFingerprints: [], pendingKeyHash: null, source: null, trustedAt: null, checkDisabled: false, checkEnforced: false },
        terminal: { isTerminalEnabled: true },
      });
      await setSettings(db, "ssh_host_key = $1, ssh_host_key_source = 'tofu', ssh_host_key_trusted_at = '2026-11-20 08:30:00', ssh_host_key_pending = $1, is_ssh_host_key_check_enforced = true", [`ssh-ed25519 ${ED25519}`]);
      const data = (await c.call("GET", "security")).body.data as { hostKey: Record<string, unknown> };
      expect(data.hostKey).toMatchObject({ mode: "enforce", fingerprints: [ED25519_FINGERPRINT], pendingFingerprints: [ED25519_FINGERPRINT], source: "tofu", trustedAt: "2026-11-20 08:30:00", checkEnforced: true });
      expect(data.hostKey.pendingKeyHash).toMatch(/^[0-9a-f]{64}$/);
      await setSettings(db, "is_ssh_host_key_check_disabled = true");
      expect(((await c.call("GET", "security")).body.data as { hostKey: { mode: string } }).hostKey.mode).toBe("off");
    });
  });

  it("toggleTerminal(): the setting flipped and saved, with Coolify's message", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect((await c.call("POST", "security/terminal", {})).body.data).toEqual({ terminal: { isTerminalEnabled: false }, message: "Terminal access has been disabled." });
      expect(await settings(db, "is_terminal_enabled")).toBe(false);
      expect((await c.call("POST", "security/terminal", {})).body.data).toEqual({ terminal: { isTerminalEnabled: true }, message: "Terminal access has been enabled." });
      expect(await settings(db, "is_terminal_enabled")).toBe(true);
    });
  });

  it("a host key change runs Coolify's checks, then answers that the connection check needs the executor, storing nothing", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const refused = async (method: string, path: string, body: unknown) => {
        const r = await c.call(method, path, body);
        return [r.status, r.body.error?.message];
      };
      const hostKeyUnavailable = UNAVAILABLE("Checking the server's connection with the new host key");
      expect(await refused("POST", "security/host-key/trust", { pendingKeyHash: "x" })).toEqual([422, SERVER_PAGE_MESSAGES.noPendingKey]);
      await setSettings(db, "ssh_host_key = $1, ssh_host_key_pending = $1", [`ssh-ed25519 ${ED25519}`]);
      expect(await refused("POST", "security/host-key/trust", { pendingKeyHash: "0".repeat(64) })).toEqual([422, "The server sent another new host key. Reload the page and compare the key again."]);
      const hash = ((await c.call("GET", "security")).body.data as { hostKey: { pendingKeyHash: string } }).hostKey.pendingKeyHash;
      expect(await refused("POST", "security/host-key/trust", { pendingKeyHash: hash })).toEqual([501, hostKeyUnavailable]);
      expect(await refused("POST", "security/host-key/reset", {})).toEqual([501, hostKeyUnavailable]);
      expect(await refused("POST", "security/host-key/check", { disabled: true })).toEqual([501, hostKeyUnavailable]);
      expect(await refused("PATCH", "security/host-key/mode", { mode: "enforce" })).toEqual([501, hostKeyUnavailable]);
      // Nothing changed.
      expect(await settings(db, "ssh_host_key_pending")).toBe(`ssh-ed25519 ${ED25519}`);
      expect(await settings(db, "ssh_host_key")).toBe(`ssh-ed25519 ${ED25519}`);
      expect(await settings(db, "is_ssh_host_key_check_disabled")).toBe(false);
      expect(await settings(db, "is_ssh_host_key_check_enforced")).toBe(false);
      // setHostKeyCheckMode(): anything but warn or enforce changes nothing; a disabled check is refused first.
      expect((await c.call("PATCH", "security/host-key/mode", { mode: "off" })).body.data).toEqual({ changed: false });
      await setSettings(db, "is_ssh_host_key_check_disabled = true");
      expect(await refused("PATCH", "security/host-key/mode", { mode: "warn" })).toEqual([422, "The host key check is disabled for this server. Reload the page and enable the check first."]);
      // canBeValidated(): a server transferred away.
      await setServer(db, `server_metadata = '{"transfer":{"status":"transferred"}}'::json`);
      expect(await refused("POST", "security/host-key/reset", {})).toEqual([422, "This server was transferred to another Coolify instance."]);
    });
  });

  it("Patching: the stored check, and Check for updates needs the executor", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect((await c.call("GET", "security/patches")).body.data).toMatchObject({ patches: { checkedAt: null, error: null, totalUpdates: 0, securityUpdates: null, rebootRequired: false, packageManager: null, frequency: "" } });
      await setSettings(db, `patch_checked_at = '2026-11-25 03:00:00', patch_check_result = '{"updates":[{"package":"curl"},{"package":"openssl"}],"security_updates":1,"reboot_required":true,"package_manager":"apt"}'::json`);
      expect((await c.call("GET", "security/patches")).body.data).toMatchObject({ patches: { checkedAt: "2026-11-25 03:00:00", totalUpdates: 2, securityUpdates: 1, rebootRequired: true, packageManager: "apt" } });
      const r = await c.call("POST", "security/patches/check");
      expect([r.status, r.body.error?.message]).toEqual([501, UNAVAILABLE("Checking the server for package updates")]);
      await setServer(db, `server_metadata = '{"transfer":{"status":"transferred"}}'::json`);
      const away = await c.call("POST", "security/patches/check");
      expect([away.status, away.body.error?.message]).toEqual([422, "This server is managed by another Coolify instance."]);
    });
  });
});

describe("Cloudflare Tunnel", () => {
  it("marks a manual configuration as complete: the setting saved, the host key forgotten", async () => {
    await fixture.inCase(async (db) => {
      await setSettings(db, "ssh_host_key = $1", [`ssh-ed25519 ${ED25519}`]);
      const c = client(db);
      expect((await c.call("GET", "cloudflare-tunnel")).body.data).toMatchObject({ tunnel: { enabled: false, managedTunnelName: null, ipPrevious: null } });
      expect((await c.call("POST", "cloudflare-tunnel/manual")).body.data).toEqual({ enabled: true, message: "Cloudflare Tunnel enabled.", level: "success", unavailable: null });
      expect(await settings(db, "is_cloudflare_tunnel")).toBe(true);
      expect(await settings(db, "ssh_host_key")).toBeNull();
    });
  });

  it("disables it: the previous IP restored and Coolify's success, or its warning; removing cloudflared needs the executor", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      await setSettings(db, "is_cloudflare_tunnel = true");
      expect((await c.call("POST", "cloudflare-tunnel/disable")).body.data).toEqual({
        enabled: false,
        message: "Cloudflare Tunnel disabled. Action required: Update the server IP address to its real IP address in the Advanced settings.",
        level: "warning",
        unavailable: UNAVAILABLE("Removing cloudflared from the server"),
      });
      expect(await settings(db, "is_cloudflare_tunnel")).toBe(false);
      expect(await server(db, "ip")).toBe("203.0.113.10");
      await setSettings(db, "is_cloudflare_tunnel = true");
      await setServer(db, "ip = 'ssh.example.com', ip_previous = '203.0.113.10'");
      expect((await c.call("POST", "cloudflare-tunnel/disable")).body.data).toMatchObject({ message: "Cloudflare Tunnel disabled. Manually updated the server IP address to its previous IP address.", level: "success" });
      expect(await server(db, "ip")).toBe("203.0.113.10");
      expect(await server(db, "ip_previous")).toBe("ssh.example.com");
    });
  });

  it("refuses a tunnel Coolify manages (its teardown needs the executor) and a server transferred away, storing nothing", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      await setSettings(db, "is_cloudflare_tunnel = true, cloudflare_tunnel_id = 'tunnel-1'");
      expect((await c.call("GET", "cloudflare-tunnel")).body.data).toMatchObject({ tunnel: { enabled: true, managedTunnelName: `coolify-${SERVER1}` } });
      const managed = await c.call("POST", "cloudflare-tunnel/disable");
      expect([managed.status, managed.body.error?.message]).toEqual([501, UNAVAILABLE("Deleting the Cloudflare tunnel and removing cloudflared from the server")]);
      expect(await settings(db, "is_cloudflare_tunnel")).toBe(true);
      await setServer(db, `server_metadata = '{"transfer":{"status":"transferred"}}'::json`);
      for (const action of ["manual", "disable"]) {
        const r = await c.call("POST", `cloudflare-tunnel/${action}`);
        expect([action, r.status, r.body.error?.message]).toEqual([action, 422, "This server is managed by another Coolify instance."]);
      }
      const update = await c.call("POST", "cloudflare-tunnel/update");
      expect([update.status, update.body.error?.message]).toEqual([501, UNAVAILABLE("Updating cloudflared on the server")]);
    });
  });
});

describe("Sentinel logs", () => {
  it("shows whether Sentinel runs and its status, and reads no logs from a server that is not functional", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      await setServer(db, "sentinel_updated_at = timezone('UTC', now())");
      expect((await c.call("GET", "sentinel/logs")).body.data).toMatchObject({ sentinel: { enabled: true, status: "in_sync" } });
      await setServer(db, "sentinel_updated_at = '2026-01-01 00:00:00'");
      expect((await c.call("GET", "sentinel/logs")).body.data).toMatchObject({ sentinel: { enabled: true, status: "out_of_sync" } });
      await setServer(db, "sentinel_waiting_since = timezone('UTC', now())");
      expect((await c.call("GET", "sentinel/logs")).body.data).toMatchObject({ sentinel: { status: "waiting" } });
      await setSettings(db, "server_role = 'build'");
      expect((await c.call("GET", "sentinel/logs")).body.data).toMatchObject({ sentinel: { enabled: false } });
      expect((await c.call("POST", "sentinel/logs")).body.data).toEqual({ logs: "" });
      await makeFunctional(db);
      expect((await c.call("POST", "sentinel/logs")).body.error?.message).toBe(UNAVAILABLE("Reading the Sentinel logs on the server"));
    });
  });
});

describe("Transfer", () => {
  it("shows the transfer's metadata and this instance's URL", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      expect((await c.call("GET", "transfer")).body.data).toMatchObject({ transfer: { isCoolifyHost: false, exportId: null, transferredAway: false, markerConflict: null, migration: null, thisInstanceUrl: "https://console.example" } });
      await setServer(db, `server_metadata = $1::json`, [
        JSON.stringify({ transfer: { export_id: "exp-1", owner_marker_conflict: { instance_url: "https://other.example" } }, migration: { status: "failed", phase: "checks", error: "1 of 4 checks failed", target_url: "https://target.example", log: [{ at: "2026-11-25T10:00:00+00:00", level: "error", message: "FAILED: SSH." }], warnings: ["w"] } }),
      ]);
      expect((await c.call("GET", "transfer")).body.data).toMatchObject({
        transfer: {
          exportId: "exp-1",
          markerConflict: { instanceUrl: "https://other.example" },
          migration: { status: "failed", phase: "checks", error: "1 of 4 checks failed", targetUrl: "https://target.example", log: [{ at: "2026-11-25T10:00:00+00:00", level: "error", message: "FAILED: SSH." }], checklist: [], warnings: ["w"] },
        },
      });
    });
  });

  it("migrateServer(): ServerTransferMigrator's own checks with Coolify's messages, then the checks over SSH need the executor", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db);
      const refused = async (body: unknown) => {
        const r = await c.call("POST", "transfer/migrate", body);
        return [r.status, r.body.error?.message];
      };
      expect(await refused({})).toEqual([422, "A valid target instance URL is required (e.g. https://coolify.example.com)."]);
      expect(await refused({ targetUrl: "http://target.example", targetToken: "t" })).toEqual([422, "The target instance URL must use https, because the transfer sends credentials."]);
      expect((await refused({ targetUrl: "https://private.example", targetToken: "t" }))[1]).toMatch(/points to a local or private address that is not allowed\. Configure allowed internal targets: https:\/\/console\.example\/settings\/advanced#endpoint-section$/);
      expect(await refused({ targetUrl: "https://target.example/", targetToken: "   " })).toEqual([422, "A target instance API token is required (root or write + deploy)."]);
      await setServer(db, `server_metadata = $1::json`, [JSON.stringify({ migration: { status: "running", started_at: new Date().toISOString() } })]);
      expect(await refused({ targetUrl: "https://target.example", targetToken: "t" })).toEqual([422, "A transfer of this server is already running."]);
      await setServer(db, `server_metadata = $1::json`, [JSON.stringify({ migration: { status: "running", started_at: new Date(Date.now() - 3600_000).toISOString() } })]);
      expect(await refused({ targetUrl: "https://target.example", targetToken: "Bearer t" })).toEqual([501, UNAVAILABLE("Running the transfer checks")]);
      // Nothing was written to the transfer's state.
      expect(((await server(db, "server_metadata")) as { migration: { status: string } }).migration.status).toBe("running");
    });
  });
});

describe("Resources", () => {
  it("lists definedResources() with their type, status, project, environment and link, and only the org's own", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db, { write: false });
      const rows = ((await c.call("GET", "resources")).body.data as { resources: Array<Record<string, unknown>> }).resources;
      expect(rows.map((r) => [r.name, r.type])).toEqual(
        expect.arrayContaining([
          ["parity-image", "application"],
          ["parity-git", "application"],
        ]),
      );
      const image = rows.find((r) => r.name === "parity-image")!;
      expect(image).toMatchObject({ project: "Alpha", environment: "production", link: expect.stringMatching(/^\/project\/p1alphaprojectuuid000001\/environment\/e1alphaproduction0000001\/application\/[^/]+$/), status: expect.any(String) });
      const postgres = rows.find((r) => r.uuid === "b1paritypostgres00000001");
      expect(postgres).toMatchObject({ type: "standalone-postgresql", link: expect.stringContaining("/database/b1paritypostgres00000001") });
      // Team 2's resources are never listed for team 1, and team 2 sees only its own.
      expect(rows.find((r) => r.name === "other-image" || r.uuid === "b9otherpostgres000000009")).toBeUndefined();
      const other = ((await c.call("GET", "resources", undefined, { org: ORG2, server: SERVER2 })).body.data as { resources: Array<Record<string, unknown>> }).resources;
      expect(other.map((r) => r.name)).toContain("other-image");
      expect(other.find((r) => r.name === "parity-image")).toBeUndefined();
    });
  });

  it("loadUnmanagedContainers() and DockerImages::load(): nothing from a server that is not functional, else the executor", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db, { write: false });
      expect((await c.call("POST", "resources/unmanaged")).body.data).toEqual({ containers: [] });
      expect((await c.call("POST", "images")).body.data).toEqual({ images: [], usage: null });
      await makeFunctional(db);
      expect((await c.call("POST", "resources/unmanaged")).body.error?.message).toBe(UNAVAILABLE("Listing the containers on the server"));
      expect((await c.call("POST", "images")).body.error?.message).toBe(UNAVAILABLE("Reading the Docker images on the server"));
    });
  });
});
