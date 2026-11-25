// deploy.servers and deploy.server_settings (DP-37) against a real Postgres:
// the store functions of @saas/db/deploy inside withOrg(), and row-level
// security keeping each org's servers to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  insertPrivateKey,
  listServers,
  findServerByUuid,
  insertServer,
  updateServer,
  updateServerRole,
  setServerPrivateKey,
  deleteServer,
  serverSshEndpointInUse,
  otherBuildServerExists,
  listServerPrivateKeys,
  privateKeyIsInUse,
  findDestinationServer,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const PROXY = { redirect_enabled: true, status: "exited", type: "TRAEFIK" };

let db: PGlite;
let ex: TransactionalSqlExecutor;
const keyIds: Record<string, string | number> = {};
beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  for (const [org, uuid] of [
    [A, "keyaaaaaaaaaaaaaaaaaaaaa"],
    [A, "keyacccccccccccccccccccc"],
    [B, "keybbbbbbbbbbbbbbbbbbbbb"],
  ] as const) {
    const row = await withOrg(ex, org, (tx) => insertPrivateKey(tx, { orgId: org, uuid, name: uuid.slice(0, 6), description: null, privateKey: "fp1:fake", fingerprint: null }));
    keyIds[uuid] = row.id;
  }
}, 120_000);
afterAll(async () => db?.close());

function add(org: string, uuid: string, name: string, ip: string, key: string, role: "deployment" | "build" | "both" = "both") {
  return withOrg(ex, org, (tx) =>
    insertServer(tx, { orgId: org, uuid, name, description: null, ip, user: "root", port: 22, privateKeyId: keyIds[key]!, proxy: PROXY, serverRole: role, imageScanEnabled: false, defaultDestinationUuid: `dst${uuid.slice(3)}` }),
  );
}

describe("deploy.servers", () => {
  it("creates a server with its settings row (ServerSetting::create in the created hook)", async () => {
    const row = await add(A, "srvaaaaaaaaaaaaaaaaaaaaa", "zeta", "203.0.113.10", "keyaaaaaaaaaaaaaaaaaaaaa", "build");
    expect(row).toMatchObject({
      uuid: "srvaaaaaaaaaaaaaaaaaaaaa",
      name: "zeta",
      ip: "203.0.113.10",
      user: "root",
      port: 22,
      private_key_uuid: "keyaaaaaaaaaaaaaaaaaaaaa",
      proxy: PROXY,
      server_role: "build",
      is_build_server: true,
      is_reachable: false,
      is_usable: false,
      force_disabled: false,
      connection_timeout: 10,
      server_timezone: "UTC",
      is_sentinel_enabled: true,
    });
    expect(row.settings_id).not.toBeNull();
    expect(row.created_at).not.toBeNull();
    expect(await withOrg(ex, A, (tx) => privateKeyIsInUse(tx, keyIds.keyaaaaaaaaaaaaaaaaaaaaa!))).toBe(true);
  });

  it("lists by name and keeps each org's servers to itself (row-level security)", async () => {
    await add(A, "srvbbbbbbbbbbbbbbbbbbbbb", "alpha", "203.0.113.11", "keyaaaaaaaaaaaaaaaaaaaaa");
    await add(B, "srvccccccccccccccccccccc", "beta", "203.0.113.10", "keybbbbbbbbbbbbbbbbbbbbb");
    expect((await withOrg(ex, A, listServers)).map((s) => s.name)).toEqual(["alpha", "zeta"]);
    expect((await withOrg(ex, B, listServers)).map((s) => s.name)).toEqual(["beta"]);
    expect(await withOrg(ex, B, (tx) => findServerByUuid(tx, "srvaaaaaaaaaaaaaaaaaaaaa"))).toBeNull();
    const a = (await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvaaaaaaaaaaaaaaaaaaaaa")))!;
    expect(await withOrg(ex, B, (tx) => deleteServer(tx, a.id))).toBe(false);
    expect(await withOrg(ex, B, (tx) => setServerPrivateKey(tx, a.id, keyIds.keybbbbbbbbbbbbbbbbbbbbb!))).toBe(false);
    await expect(
      withOrg(ex, B, (tx) =>
        insertServer(tx, { orgId: A, uuid: "srvxxxxxxxxxxxxxxxxxxxxx", name: "x", description: null, ip: "10.0.0.1", user: "root", port: 22, privateKeyId: 1, proxy: {}, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: "dstxxxxxxxxxxxxxxxxxxxxx" }),
      ),
    ).rejects.toThrow(/row-level security/);
    expect((await withOrg(ex, B, listServerPrivateKeys)).map((k) => k.uuid)).toEqual(["keybbbbbbbbbbbbbbbbbbbbb"]);
  });

  it("checks SSH endpoints within the org (sshEndpointInUse)", async () => {
    const a = (await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvaaaaaaaaaaaaaaaaaaaaa")))!;
    expect(await withOrg(ex, A, (tx) => serverSshEndpointInUse(tx, "203.0.113.10", 22))).toBe(true);
    expect(await withOrg(ex, A, (tx) => serverSshEndpointInUse(tx, "203.0.113.10", 22, a.id))).toBe(false);
    expect(await withOrg(ex, A, (tx) => serverSshEndpointInUse(tx, "203.0.113.10", 2222))).toBe(false);
    // A has a server at .11, B has none there: the check sees its own org only.
    expect(await withOrg(ex, A, (tx) => serverSshEndpointInUse(tx, "203.0.113.11", 22))).toBe(true);
    expect(await withOrg(ex, B, (tx) => serverSshEndpointInUse(tx, "203.0.113.11", 22))).toBe(false);
  });

  it("updates the server and its settings; a new address keeps the old one and forgets the host key", async () => {
    const a = (await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvaaaaaaaaaaaaaaaaaaaaa")))!;
    await withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.server_settings SET ssh_host_key = 'ssh-ed25519 AAAA', ssh_host_key_pending = 'x' WHERE server_id = $1`, [a.id]));
    const ok = await withOrg(ex, A, (tx) =>
      updateServer(
        tx,
        a.id,
        { name: "zeta 2", description: "d", ip: "198.51.100.5", user: "admin", port: 2222 },
        { connectionTimeout: 30, wildcardDomain: "https://example.com", publicIpv4: "198.51.100.7", publicIpv6: null, serverTimezone: "Europe/Berlin" },
      ),
    );
    expect(ok).toBe(true);
    const after = (await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvaaaaaaaaaaaaaaaaaaaaa")))!;
    expect(after).toMatchObject({ name: "zeta 2", description: "d", ip: "198.51.100.5", user: "admin", port: 2222, connection_timeout: 30, wildcard_domain: "https://example.com", public_ipv4: "198.51.100.7", server_timezone: "Europe/Berlin", ssh_host_key_pending: null });
    const raw = await withOrg(ex, A, (tx) => tx.execute<{ ip_previous: string; ssh_host_key: string | null }>(`SELECT s.ip_previous, ss.ssh_host_key FROM deploy.servers s JOIN deploy.server_settings ss ON ss.server_id = s.id WHERE s.id = $1`, [a.id]));
    expect(raw.rows[0]).toEqual({ ip_previous: "203.0.113.10", ssh_host_key: null });
    // Without public IPs the stored ones stay (the localhost server).
    await withOrg(ex, A, (tx) => updateServer(tx, a.id, { name: "zeta 2", description: "d", ip: "198.51.100.5", user: "admin", port: 2222 }, { connectionTimeout: 30, wildcardDomain: null, serverTimezone: "UTC" }));
    expect((await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvaaaaaaaaaaaaaaaaaaaaa")))!.public_ipv4).toBe("198.51.100.7");
  });

  it("changes the role, and finds another usable build server", async () => {
    const a = (await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvaaaaaaaaaaaaaaaaaaaaa")))!;
    const b = (await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvbbbbbbbbbbbbbbbbbbbbb")))!;
    expect(await withOrg(ex, A, (tx) => otherBuildServerExists(tx, b.id))).toBe(false); // a is a build server, but not reachable yet
    await withOrg(ex, A, (tx) => tx.execute(`UPDATE deploy.server_settings SET is_reachable = true, is_usable = true WHERE server_id = $1`, [a.id]));
    expect(await withOrg(ex, A, (tx) => otherBuildServerExists(tx, b.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => otherBuildServerExists(tx, a.id))).toBe(false);
    await withOrg(ex, A, (tx) => updateServerRole(tx, b.id, "build", true));
    expect(await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvbbbbbbbbbbbbbbbbbbbbb"))).toMatchObject({ server_role: "build", is_build_server: true, is_sentinel_enabled: false, is_metrics_enabled: false });
  });

  it("switches the private key, and deletes the server with its settings", async () => {
    const b = (await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvbbbbbbbbbbbbbbbbbbbbb")))!;
    expect(await withOrg(ex, A, (tx) => setServerPrivateKey(tx, b.id, keyIds.keyacccccccccccccccccccc!))).toBe(true);
    expect((await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvbbbbbbbbbbbbbbbbbbbbb")))!.private_key_uuid).toBe("keyacccccccccccccccccccc");
    expect(await withOrg(ex, A, (tx) => deleteServer(tx, b.id))).toBe(true);
    expect(await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvbbbbbbbbbbbbbbbbbbbbb"))).toBeNull();
    const settings = await withOrg(ex, A, (tx) => tx.execute(`SELECT 1 FROM deploy.server_settings WHERE server_id = $1`, [b.id]));
    expect(settings.rows).toHaveLength(0);
  });
});

describe("servers.proxy is nullable (660_deploy_schema_catch_up, as Coolify's column)", () => {
  it("a server without a proxy is listed and found, with proxy null, like any other", async () => {
    const zeta = (await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvaaaaaaaaaaaaaaaaaaaaa")))!;
    await withOrg(ex, A, (tx) => tx.execute("UPDATE deploy.servers SET proxy = NULL WHERE id = $1", [zeta.id]));
    try {
      expect((await withOrg(ex, A, (tx) => findServerByUuid(tx, "srvaaaaaaaaaaaaaaaaaaaaa")))!.proxy).toBeNull();
      expect((await withOrg(ex, A, listServers)).map((s) => s.uuid)).toContain("srvaaaaaaaaaaaaaaaaaaaaa");
      // What the application pages read of it (additional servers, labels): null, not an error.
      expect((await withOrg(ex, A, (tx) => findDestinationServer(tx, zeta.id)))!.proxy).toBeNull();
    } finally {
      await withOrg(ex, A, (tx) => tx.execute("UPDATE deploy.servers SET proxy = $2::json WHERE id = $1", [zeta.id, JSON.stringify(PROXY)]));
    }
  });
});
