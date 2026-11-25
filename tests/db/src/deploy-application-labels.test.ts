// The container label queries (DP-53) against a real Postgres: what Coolify's
// generateLabelsApplication() reads of an application — its own columns, its
// settings row, the destination's network, the server's proxy and settings —
// with the schema's defaults, the two updates the General page's Labels and
// Authentication sections make, and row-level security keeping each org's
// applications to itself.
import type { PGlite } from "@electric-sql/pglite";
import {
  withOrg,
  asPlatformAdmin,
  insertPrivateKey,
  insertServer,
  insertProject,
  insertDestination,
  insertDockerImageApplication,
  listServerDestinations,
  findApplicationLabelSource,
  updateApplicationLabels,
  updateApplicationLabelSettings,
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  isEncryptedColumn,
  type NewDockerImageApplication,
} from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { deployDatabase, executor } from "./deploy-schema.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

let db: PGlite;
let ex: TransactionalSqlExecutor;
const ids: Record<string, string | number> = {};

/** An org's server (with the proxy Freeploy gives a new server), its destinations, a project, and one Docker image application. */
async function fixture(org: string, tag: string, destination: "standalone" | "swarm" = "standalone"): Promise<void> {
  await withOrg(ex, org, async (tx) => {
    const key = await insertPrivateKey(tx, { orgId: org, uuid: `key${tag}`, name: "key", description: null, privateKey: "fp1:fake", fingerprint: null });
    const server = await insertServer(tx, {
      orgId: org, uuid: `srv${tag}`, name: `server-${tag}`, description: null, ip: "203.0.113.10", user: "root", port: 22, privateKeyId: key.id,
      proxy: { redirect_enabled: true, status: "exited", type: "TRAEFIK" }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: `dst${tag}`,
    });
    const standalone = (await listServerDestinations(tx, server.id))[0]!;
    const swarm = await insertDestination(tx, { orgId: org, type: "swarm", uuid: `swm${tag}`, name: "overlay", network: "coolify-overlay", serverId: server.id });
    const { environment } = await insertProject(tx, { orgId: org, uuid: `prj${tag}`, name: `project-${tag}`, description: null, productionEnvironmentUuid: `env${tag}` });
    const application: NewDockerImageApplication = {
      orgId: org,
      uuid: `app${tag}`,
      name: `docker-image-app${tag}`,
      fqdn: "https://app.example.com",
      domainPortOverrides: { "https://app.example.com": 4000 },
      dockerRegistryImageName: "nginx",
      dockerRegistryImageTag: "latest",
      environmentId: environment.id,
      destinationId: destination === "swarm" ? swarm.id : standalone.id,
      destinationType: destination,
      webhookSecrets: Object.fromEntries(APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => [c, `fp1:${c}`])) as NewDockerImageApplication["webhookSecrets"],
    };
    ids[tag] = (await insertDockerImageApplication(tx, application)).id;
  });
}

beforeAll(async () => {
  db = await deployDatabase();
  ex = executor(db);
  await fixture(A, "a");
  await fixture(B, "b", "swarm");
}, 120_000);
afterAll(async () => db?.close());

const raw = async (table: string, where: string, params: unknown[]) =>
  (await asPlatformAdmin(ex, (tx) => tx.execute<Record<string, unknown>>(`SELECT * FROM deploy.${table} WHERE ${where}`, params))).rows;
const parsed = (value: unknown): unknown => (typeof value === "string" ? JSON.parse(value) : value);

describe("findApplicationLabelSource", () => {
  it("reads what the label generator needs, with the defaults Coolify's schema gives a new application", async () => {
    const row = (await withOrg(ex, A, (tx) => findApplicationLabelSource(tx, "appa")))!;
    expect(row).toMatchObject({
      uuid: "appa",
      fqdn: "https://app.example.com",
      build_pack: "dockerimage",
      ports_exposes: "80",
      redirect: "both",
      custom_labels: null,
      is_http_basic_auth_enabled: false,
      http_basic_auth_username: null,
      http_basic_auth_password: null,
      http_basic_auth_hash_algorithm: "bcrypt",
      http_basic_auth_bcrypt_cost: 10,
      http_basic_auth_argon2id_memory_cost: 65536,
      http_basic_auth_argon2id_time_cost: 4,
      noindex_domains: null,
      // application_settings
      is_static: false,
      is_force_https_enabled: true,
      is_gzip_enabled: true,
      is_stripprefix_enabled: true,
      is_permanent_redirect_enabled: false,
      is_container_label_readonly_enabled: true,
      is_container_label_escape_enabled: true,
      application_traefik_certificate_resolver: null,
      // destination and server
      destination_network: "coolify",
      server_uuid: "srva",
      server_generate_exact_labels: false,
      server_traefik_certificate_resolver: "letsencrypt",
      server_is_traffic_analytics_enabled: false,
    });
    expect(parsed(row.domain_port_overrides)).toEqual({ "https://app.example.com": 4000 });
    expect(parsed(row.server_proxy)).toEqual({ redirect_enabled: true, status: "exited", type: "TRAEFIK" });
    expect(String(row.id)).toBe(String(ids.a));
  });

  it("follows the destination's type to its network", async () => {
    const row = (await withOrg(ex, B, (tx) => findApplicationLabelSource(tx, "appb")))!;
    expect(row).toMatchObject({ destination_network: "coolify-overlay", server_uuid: "srvb" });
  });

  it("is null for another org's application, an unknown one and a deleted one", async () => {
    expect(await withOrg(ex, A, (tx) => findApplicationLabelSource(tx, "appb"))).toBeNull();
    expect(await withOrg(ex, A, (tx) => findApplicationLabelSource(tx, "nosuch"))).toBeNull();
    await asPlatformAdmin(ex, (tx) => tx.execute("UPDATE deploy.applications SET deleted_at = now() WHERE uuid = 'appb'"));
    expect(await withOrg(ex, B, (tx) => findApplicationLabelSource(tx, "appb"))).toBeNull();
    await asPlatformAdmin(ex, (tx) => tx.execute("UPDATE deploy.applications SET deleted_at = NULL WHERE uuid = 'appb'"));
  });
});

describe("updateApplicationLabels and updateApplicationLabelSettings", () => {
  it("write only the columns given", async () => {
    const labels = Buffer.from("traefik.enable=true\ncustom=1", "utf8").toString("base64");
    expect(await withOrg(ex, A, (tx) => updateApplicationLabels(tx, ids.a!, { custom_labels: labels, is_http_basic_auth_enabled: true, http_basic_auth_username: "admin", http_basic_auth_password: "fp1:ciphertext", http_basic_auth_bcrypt_cost: 12 }))).toBe(true);
    expect(await withOrg(ex, A, (tx) => updateApplicationLabelSettings(tx, ids.a!, { is_container_label_readonly_enabled: false }))).toBe(true);
    const row = (await withOrg(ex, A, (tx) => findApplicationLabelSource(tx, "appa")))!;
    expect(row).toMatchObject({
      custom_labels: labels,
      is_http_basic_auth_enabled: true,
      http_basic_auth_username: "admin",
      http_basic_auth_password: "fp1:ciphertext",
      http_basic_auth_bcrypt_cost: 12,
      http_basic_auth_hash_algorithm: "bcrypt",
      http_basic_auth_argon2id_memory_cost: 65536,
      is_container_label_readonly_enabled: false,
      is_container_label_escape_enabled: true,
      // Untouched by either update.
      fqdn: "https://app.example.com",
      ports_exposes: "80",
    });
    // A null clears; nothing given writes nothing.
    await withOrg(ex, A, (tx) => updateApplicationLabels(tx, ids.a!, { http_basic_auth_password: null, custom_labels: "" }));
    expect(await withOrg(ex, A, (tx) => updateApplicationLabels(tx, ids.a!, {}))).toBe(true);
    expect(await withOrg(ex, A, (tx) => updateApplicationLabelSettings(tx, ids.a!, {}))).toBe(true);
    const [stored] = await raw("applications", "uuid = $1", ["appa"]);
    expect(stored).toMatchObject({ http_basic_auth_password: null, custom_labels: "", http_basic_auth_username: "admin", name: "docker-image-appa" });
    const [settings] = await raw("application_settings", "application_id = $1", [ids.a]);
    expect(settings).toMatchObject({ is_container_label_readonly_enabled: false, is_container_label_escape_enabled: true, is_gzip_enabled: true });
  });

  it("cannot reach another org's application", async () => {
    expect(await withOrg(ex, A, (tx) => updateApplicationLabels(tx, ids.b!, { custom_labels: "x" }))).toBe(false);
    expect(await withOrg(ex, A, (tx) => updateApplicationLabelSettings(tx, ids.b!, { is_container_label_escape_enabled: false }))).toBe(false);
    const [other] = await raw("applications", "uuid = $1", ["appb"]);
    expect(other).toMatchObject({ custom_labels: null });
    const [settings] = await raw("application_settings", "application_id = $1", [ids.b]);
    expect(settings).toMatchObject({ is_container_label_escape_enabled: true });
  });

  it("the password column is one of Coolify's encrypted casts", () => {
    expect(isEncryptedColumn("applications", "http_basic_auth_password")).toBe(true);
  });
});
