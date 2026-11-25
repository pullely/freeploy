// A server's CA Certificate page (DP-48): Coolify's Show component as routes —
// who may see and who may change the certificate, its messages, the check
// against the stored CA key, the certificate and key stored encrypted and the
// key never returned, and what needs the SSH executor reported as not
// available yet. The SQL behind the store (and its row-level security) is
// tested in tests/db; the certificates themselves in ssl.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleServerCaCertificate, type CaCertificateRunner } from "@deploy-core-worker/handlers/ca-certificate";
import { CA_CERTIFICATE_MESSAGES, SSL_CERTIFICATE_COLUMN, SSL_PRIVATE_KEY_COLUMN, regenerateCaCertificate, type CaCertificateStore } from "@deploy-core-worker/ssl/ca-certificate";
import { certificateMatchesPrivateKey, parseCertificate, readCertificatePem } from "@deploy-core-worker/ssl/x509";
import type { FieldCipher } from "@deploy-core-worker/servers/settings";
import type { DeployServerRow, DeploySslCertificateWithSecretRow } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const SERVER = "srvaaaaaaaaaaaaaaaaaaaaa";
const BASE = `https://x/v1/organizations/${ORG}/deploy/servers/${SERVER}/ca-certificate`;
const actor = { subjectId: "usr_1", subjectType: "user" };

// Jest runs from tests/deploy-core-worker (its rootDir).
const fixture = (name: string): string => readFileSync(join(process.cwd(), "fixtures", "ssl", name), "utf8");
const PHP_CA = fixture("php-ca.crt");
const PHP_CA_KEY = fixture("php-ca.key.txt");
const PHP_LEAF = fixture("php-leaf.crt");
/** Another certificate for PHP_CA_KEY: what a user pastes as a custom CA. */
const CUSTOM_CA = fixture("custom-ca.crt");

const UNAVAILABLE = "Writing the CA certificate to the server needs the SSH executor, which is not available yet.";
const MISMATCH =
  "This certificate does not match the CA private key of this server. Freeploy signs database certificates with that key, so clients would fail with a certificate signature error.";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

function serverRow(over: Partial<DeployServerRow> = {}): DeployServerRow {
  return {
    id: 1, uuid: SERVER, name: "db-host-1", description: null, ip: "203.0.113.10", port: 22, user: "root", private_key_id: 100, private_key_uuid: null,
    proxy: {}, validation_logs: null, server_metadata: null, is_validating: false, hetzner_server_id: null, vultr_instance_id: null,
    hostinger_virtual_machine_id: null, created_at: null, updated_at: null, settings_id: 1, is_reachable: true, is_usable: true, force_disabled: false,
    is_swarm_manager: false, is_swarm_worker: false, is_build_server: false, server_role: "both", connection_timeout: 10, wildcard_domain: null,
    public_ipv4: null, public_ipv6: null, server_timezone: "UTC", is_metrics_enabled: false, is_sentinel_enabled: true, is_image_scan_enabled: false,
    ssh_host_key_pending: null, is_cloudflare_tunnel: false, org_uses_swarm: false,
    ...over,
  };
}

/** "Encryption" is a reversible marker that names the column, so a value opened as another column fails. */
const cipher: FieldCipher = {
  encrypt: async (column, plaintext) => `enc[${column}]:${plaintext}`,
  decrypt: async (column, stored) => {
    const prefix = `enc[${column}]:`;
    if (!stored.startsWith(prefix)) throw new Error("not this column's ciphertext");
    return stored.slice(prefix.length);
  },
};
const sealed = (column: string, plaintext: string) => `enc[${column}]:${plaintext}`;

/** deploy.ssl_certificates of one org with one server, in memory. */
class MemoryStore implements CaCertificateStore {
  server = serverRow();
  rows: DeploySslCertificateWithSecretRow[] = [];
  private next = 1;
  async findServer(uuid: string) {
    return uuid === this.server.uuid ? this.server : null;
  }
  async findCa(serverId: string | number) {
    return this.rows.find((r) => r.server_id === serverId && r.is_ca_certificate) ?? null;
  }
  async replaceCa(serverId: string | number, c: Parameters<CaCertificateStore["replaceCa"]>[1]) {
    // The server's own certificates (no resource) go; a database's stay.
    this.rows = this.rows.filter((r) => !(r.server_id === serverId && r.resource_type === null && r.resource_id === null));
    const row: DeploySslCertificateWithSecretRow = {
      id: this.next++, ssl_certificate: c.sslCertificate, ssl_private_key: c.sslPrivateKey, configuration_dir: null, mount_path: null, resource_type: null,
      resource_id: null, server_id: serverId, common_name: c.commonName, subject_alternative_names: c.subjectAlternativeNames,
      valid_until: c.validUntil.toISOString().slice(0, 19).replace("T", " "), is_ca_certificate: c.isCaCertificate, created_at: "2026-11-24 09:30:00", updated_at: "2026-11-24 09:30:00",
    };
    this.rows.push(row);
    return row;
  }
  async updateCertificate(id: string | number, sslCertificate: string) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return false;
    row.ssl_certificate = sslCertificate;
    return true;
  }
  /** A stored CA: PHP's certificate and key, valid until what its certificate says. */
  seedPhpCa() {
    this.rows.push({
      id: this.next++, ssl_certificate: sealed(SSL_CERTIFICATE_COLUMN, PHP_CA), ssl_private_key: sealed(SSL_PRIVATE_KEY_COLUMN, PHP_CA_KEY), configuration_dir: null,
      mount_path: null, resource_type: null, resource_id: null, server_id: this.server.id, common_name: "Coolify CA Certificate", subject_alternative_names: [],
      valid_until: "2036-11-21 21:52:24", is_ca_certificate: true, created_at: "2026-11-24 21:52:24", updated_at: "2026-11-24 21:52:24",
    });
  }
}

interface Page {
  server: { uuid: string; name: string };
  certificateContent: string;
  certificateValidUntil: string | null;
  canUpdate?: boolean;
  message?: string;
  unavailable?: string | null;
  stored?: boolean;
}
type Body = { data?: Page; error?: { code: string; message: string; details: { denied?: string } } };

function setup(opts: { write?: boolean; read?: boolean } = {}) {
  const store = new MemoryStore();
  const asked: string[] = [];
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : (opts.read ?? true);
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  };
  const orgs: string[] = [];
  const runner: CaCertificateRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    return fn({ store, cipher });
  };
  const call = async (method: string, path = "", body?: unknown, uuid = SERVER) => {
    const segments = path.split("/").filter(Boolean);
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleServerCaCertificate(env, "req_1", actor, ORG_UUID, uuid, segments, new Request(`${BASE}${path ? `/${path}` : ""}`, init), runner);
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Body, text };
  };
  return { store, asked, orgs, call };
}

describe("routing", () => {
  const env: Env = { ENVIRONMENT: "test" };
  const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
  const status = async (path: string, method = "GET", h: Record<string, string> = headers) => (await route(new Request(`${BASE}${path}`, { method, headers: h }), env)).status;

  it("routes a server's ca-certificate below /deploy/servers", async () => {
    // 503: the route is known and needs the bindings this env does not have.
    expect(await status("")).toBe(503);
    expect(await status("/")).toBe(503);
    expect(await status("", "PATCH")).toBe(503);
    expect(await status("/regenerate", "POST")).toBe(503);
  });

  it("401s without an actor and 404s an org id that does not parse", async () => {
    expect(await status("", "GET", {})).toBe(401);
    expect((await route(new Request(`https://x/v1/organizations/nope/deploy/servers/${SERVER}/ca-certificate`, { headers }), env)).status).toBe(404);
  });

  it("405s the methods the page does not have and 404s what is not a route", async () => {
    expect(await status("", "PUT")).toBe(405);
    expect(await status("", "POST")).toBe(405);
    expect(await status("", "DELETE")).toBe(405);
    expect(await status("/regenerate", "GET")).toBe(405);
    expect(await status("/regenerate", "PATCH")).toBe(405);
    expect(await status("/download")).toBe(404);
    expect(await status("/regenerate/now", "POST")).toBe(404);
  });
});

describe("GET /ca-certificate (Show::mount + loadCaCertificate)", () => {
  it("shows an empty certificate for a server that has none yet", async () => {
    const t = setup();
    const r = await t.call("GET");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ server: { uuid: SERVER, name: "db-host-1" }, certificateContent: "", certificateValidUntil: null, canUpdate: true });
    expect(t.orgs).toEqual([ORG_UUID]);
    expect(t.asked.sort()).toEqual(["deploy.resource.read", "deploy.resource.write"]);
  });

  it("shows the certificate and when it ends, never the private key", async () => {
    const t = setup();
    t.store.seedPhpCa();
    const r = await t.call("GET");
    expect(r.body.data).toMatchObject({ certificateContent: PHP_CA, certificateValidUntil: "2036-11-21T21:52:24.000Z", canUpdate: true });
    expect(r.text).not.toContain("PRIVATE KEY");
    expect(r.text).not.toContain("enc[");
    expect(Object.keys(r.body.data!).sort()).toEqual(["canUpdate", "certificateContent", "certificateValidUntil", "server"]);
  });

  it("shows it to a member who may only read (view), who may not update", async () => {
    const t = setup({ write: false });
    t.store.seedPhpCa();
    const r = await t.call("GET");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ certificateContent: PHP_CA, canUpdate: false });
  });

  it("404s without read access, for another org's server and for an unknown one", async () => {
    const denied = await setup({ read: false, write: false }).call("GET");
    expect(denied.status).toBe(404);
    expect(denied.body.error?.details.denied).toBeDefined();
    const t = setup();
    expect((await t.call("GET", "", undefined, "srvzzzzzzzzzzzzzzzzzzzzz")).status).toBe(404);
  });
});

describe("POST /ca-certificate/regenerate (Show::regenerateCaCertificate)", () => {
  it("is for who may manage the CA certificate only", async () => {
    const t = setup({ write: false });
    const r = await t.call("POST", "regenerate");
    expect(r.status).toBe(404);
    expect(t.store.rows).toEqual([]);
    expect(t.orgs).toEqual([]);
    expect(t.asked).toEqual(["deploy.resource.write"]);
  });

  it("gives a server its first CA certificate: stored encrypted, valid ten years, the on-server step not available yet", async () => {
    const t = setup();
    const before = Math.floor(Date.now() / 1000) * 1000;
    const r = await t.call("POST", "regenerate");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ message: "CA Certificate regenerated successfully.", unavailable: UNAVAILABLE, stored: true, server: { uuid: SERVER } });
    expect(r.text).not.toContain("PRIVATE KEY");
    expect(r.text).not.toContain("enc[");

    expect(t.store.rows).toHaveLength(1);
    const row = t.store.rows[0]!;
    expect(row).toMatchObject({ server_id: 1, common_name: "Coolify CA Certificate", is_ca_certificate: true, resource_type: null, resource_id: null, subject_alternative_names: [] });
    expect(row.ssl_certificate.startsWith(`enc[${SSL_CERTIFICATE_COLUMN}]:-----BEGIN CERTIFICATE-----\n`)).toBe(true);
    expect(row.ssl_private_key.startsWith(`enc[${SSL_PRIVATE_KEY_COLUMN}]:-----BEGIN PRIVATE KEY-----\n`)).toBe(true);

    const certificate = await cipher.decrypt(SSL_CERTIFICATE_COLUMN, row.ssl_certificate);
    expect(r.body.data!.certificateContent).toBe(certificate);
    expect(await certificateMatchesPrivateKey(certificate, await cipher.decrypt(SSL_PRIVATE_KEY_COLUMN, row.ssl_private_key))).toBe(true);
    const parsed = parseCertificate(readCertificatePem(certificate)!);
    expect(parsed.subject.map((a) => a.value)).toEqual(["Coolify CA Certificate", "Coolify", "XX", "Default"]);
    expect(parsed.notAfter!.getTime() - parsed.notBefore!.getTime()).toBe(3650 * 86_400_000);
    // valid_until is the certificate's end, and what the page shows.
    expect(r.body.data!.certificateValidUntil).toBe(parsed.notAfter!.toISOString());
    expect(parsed.notBefore!.getTime()).toBeGreaterThanOrEqual(before);
    expect(parsed.notBefore!.getTime()).toBeLessThanOrEqual(Date.now());

    // And the page then shows it.
    expect((await t.call("GET")).body.data).toMatchObject({ certificateContent: certificate, certificateValidUntil: parsed.notAfter!.toISOString() });
  });

  it("replaces the CA and its key, and leaves a database's certificate", async () => {
    const t = setup();
    t.store.seedPhpCa();
    t.store.rows.push({ ...t.store.rows[0]!, id: 50, is_ca_certificate: false, resource_type: "App\\Models\\StandalonePostgresql", resource_id: 7, common_name: "postgres-abc" });
    const r = await t.call("POST", "regenerate");
    expect(r.status).toBe(200);
    expect(t.store.rows.map((x) => x.common_name).sort()).toEqual(["Coolify CA Certificate", "postgres-abc"]);
    const ca = (await t.store.findCa(1))!;
    const certificate = await cipher.decrypt(SSL_CERTIFICATE_COLUMN, ca.ssl_certificate);
    expect(certificate).not.toBe(PHP_CA);
    expect(await certificateMatchesPrivateKey(certificate, PHP_CA_KEY)).toBe(false);
    expect(r.body.data!.certificateContent).toBe(certificate);
  });

  it("uses the given time (the service), and 404s an unknown server", async () => {
    const t = setup();
    const saved = await regenerateCaCertificate({ store: t.store, cipher }, SERVER, new Date("2026-11-24T21:52:24.731Z"));
    expect(saved).toMatchObject({ certificateValidUntil: "2036-11-21T21:52:24.000Z", unavailable: CA_CERTIFICATE_MESSAGES.writeUnavailable });
    expect(t.store.rows[0]!.valid_until).toBe("2036-11-21 21:52:24");
    expect((await t.call("POST", "regenerate", undefined, "srvzzzzzzzzzzzzzzzzzzzzz")).status).toBe(404);
  });
});

describe("PATCH /ca-certificate (Show::saveCaCertificate)", () => {
  it("is for who may manage the CA certificate only", async () => {
    const t = setup({ write: false });
    t.store.seedPhpCa();
    const r = await t.call("PATCH", "", { certificateContent: CUSTOM_CA });
    expect(r.status).toBe(404);
    expect(t.store.rows[0]!.ssl_certificate).toBe(sealed(SSL_CERTIFICATE_COLUMN, PHP_CA));
  });

  it("refuses empty content with Coolify's message", async () => {
    const t = setup();
    t.store.seedPhpCa();
    for (const body of [{}, { certificateContent: "" }, { certificateContent: "0" }, { certificateContent: null }, { certificateContent: 12 }]) {
      const r = await t.call("PATCH", "", body);
      expect(r.status).toBe(422);
      expect(r.body.error).toMatchObject({ code: "validation_failed", message: "Certificate content cannot be empty." });
    }
  });

  it("refuses what is not a certificate with Coolify's message", async () => {
    const t = setup();
    t.store.seedPhpCa();
    for (const content of ["hello", PHP_CA_KEY, PHP_CA.replace(/\n/g, ""), `  ${PHP_CA}`, PHP_CA.slice(0, 300), "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"]) {
      const r = await t.call("PATCH", "", { certificateContent: content });
      expect(r.status).toBe(422);
      expect(r.body.error?.message).toBe("Invalid certificate format.");
    }
    expect(t.store.rows[0]!.ssl_certificate).toBe(sealed(SSL_CERTIFICATE_COLUMN, PHP_CA));
  });

  it("refuses a certificate that is not for the server's CA key, in Coolify's words with Freeploy's name", async () => {
    const t = setup();
    t.store.seedPhpCa();
    const r = await t.call("PATCH", "", { certificateContent: PHP_LEAF });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: "validation_failed", message: MISMATCH });
    expect(CA_CERTIFICATE_MESSAGES.mismatch).toBe(MISMATCH);
    expect(t.store.rows[0]!.ssl_certificate).toBe(sealed(SSL_CERTIFICATE_COLUMN, PHP_CA));

    // A certificate from another server's CA does not match either.
    const other = setup();
    await other.call("POST", "regenerate");
    const foreign = await cipher.decrypt(SSL_CERTIFICATE_COLUMN, other.store.rows[0]!.ssl_certificate);
    expect((await t.call("PATCH", "", { certificateContent: foreign })).body.error?.message).toBe(MISMATCH);
  });

  it("stores a custom certificate for the CA key, normalized; the key and valid_until stay", async () => {
    const t = setup();
    t.store.seedPhpCa();
    const pasted = `my certificate:\r\n${CUSTOM_CA.replace(/\n/g, "\r\n")}\r\n\r\n`;
    const r = await t.call("PATCH", "", { certificateContent: pasted });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      message: "CA Certificate saved successfully.",
      unavailable: UNAVAILABLE,
      stored: true,
      certificateContent: CUSTOM_CA,
      certificateValidUntil: "2036-11-21T21:52:24.000Z",
    });
    expect(r.text).not.toContain("PRIVATE KEY");
    const row = t.store.rows[0]!;
    expect(row.ssl_certificate).toBe(sealed(SSL_CERTIFICATE_COLUMN, CUSTOM_CA));
    expect(row.ssl_private_key).toBe(sealed(SSL_PRIVATE_KEY_COLUMN, PHP_CA_KEY));
    expect(row.valid_until).toBe("2036-11-21 21:52:24");
    expect((await t.call("GET")).body.data).toMatchObject({ certificateContent: CUSTOM_CA });
  });

  it("stores the same certificate again", async () => {
    const t = setup();
    t.store.seedPhpCa();
    const r = await t.call("PATCH", "", { certificateContent: PHP_CA });
    expect(r.body.data).toMatchObject({ message: "CA Certificate saved successfully.", stored: true, certificateContent: PHP_CA });
  });

  it("answers Coolify's success for a server without a CA certificate, and stores nothing", async () => {
    const t = setup();
    const r = await t.call("PATCH", "", { certificateContent: `${CUSTOM_CA}\n\n` });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ message: "CA Certificate saved successfully.", stored: false, unavailable: null, certificateContent: CUSTOM_CA, certificateValidUntil: null });
    expect(t.store.rows).toEqual([]);
    // The checks before the lookup still apply.
    expect((await t.call("PATCH", "", { certificateContent: "" })).body.error?.message).toBe("Certificate content cannot be empty.");
    expect((await t.call("PATCH", "", { certificateContent: "x" })).body.error?.message).toBe("Invalid certificate format.");
  });

  it("404s an unknown server", async () => {
    const t = setup();
    expect((await t.call("PATCH", "", { certificateContent: PHP_CA }, "srvzzzzzzzzzzzzzzzzzzzzz")).status).toBe(404);
  });
});

describe("messages", () => {
  it("are Coolify's, word for word", () => {
    expect(CA_CERTIFICATE_MESSAGES).toEqual({
      empty: "Certificate content cannot be empty.",
      invalid: "Invalid certificate format.",
      unprocessable: "Failed to process certificate.",
      mismatch: MISMATCH,
      saved: "CA Certificate saved successfully.",
      regenerated: "CA Certificate regenerated successfully.",
      writeUnavailable: UNAVAILABLE,
    });
  });
});
