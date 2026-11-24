// Container labels (DP-53). The generators are checked against Coolify's own PHP: fixtures/labels/goldens.json
// is what coollabsio/coolify@91b7e3e returns for fixtures/labels/cases.json (emit.php, see the README there),
// and every case must come out of the TypeScript ports byte for byte. Then the wiring: custom_labels on the
// General page's read and save, the reset, HTTP Basic Authentication and the two label settings, through the
// handler with an in-memory store.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleApplications, type ApplicationRunner } from "@deploy-core-worker/handlers/applications";
import type { ApplicationStore } from "@deploy-core-worker/applications/service";
import { resetDefaultLabels, type ApplicationLabelContext, type ApplicationLabelStore } from "@deploy-core-worker/applications/labels-service";
import { validateLabelFields } from "@deploy-core-worker/applications/labels-validation";
import type { ApplicationGeneralChanges, ApplicationLabelChanges, ApplicationLabelSettingChanges, DeployApplicationLabelRow, DeployApplicationRow } from "@saas/db/deploy";
import { bcryptHash, bcryptSaltOf } from "@deploy-core-worker/labels/bcrypt";
import { decodeBase64EncodedLabels, encodeLabels, isBase64Encoded, parseContainerLabels } from "@deploy-core-worker/labels/custom-labels";
import {
  caddyDockerProxyImageVersion,
  caddySiteAddress,
  defaultLabels,
  escapeDollarSign,
  fqdnLabelsForCaddy,
  fqdnLabelsForTraefik,
  generateLabelsApplication,
  isNoindexDomain,
  slug,
  traefikHostRulesWithoutIpv6Brackets,
  type CaddyLabelsInput,
  type LabelApplication,
  type LabelDependencies,
  type LabelPreview,
  type TraefikLabelsInput,
} from "@deploy-core-worker/labels/labels";

// Jest runs from tests/deploy-core-worker (its rootDir).
const dir = join(process.cwd(), "fixtures", "labels");
type Json = Record<string, unknown>;
interface Case {
  id: string;
  fn: string;
  args: unknown;
}
type Golden = { ok: true; value: unknown } | { ok: false; error: string };
const casesFile = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as { applicationDefaults: Json; cases: Case[] };
const goldens = JSON.parse(readFileSync(join(dir, "goldens.json"), "utf8")) as Record<string, Golden>;

/** array_replace_recursive(): maps merge key by key, anything else replaces. */
function merge(base: unknown, over: unknown): unknown {
  const isMap = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isMap(base) || !isMap(over)) return over;
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = key in base ? merge(base[key], value) : value;
  return out;
}

const camel = (key: string): string => key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const camelKeys = (args: Json): Json => Object.fromEntries(Object.entries(args).map(([k, v]) => [camel(k), v]));

/**
 * PHP's password_hash() draws a salt, so a golden's hash cannot be predicted — but it can be
 * reproduced: each bcrypt hash in the golden, in the order the generators ask for them, gives the salt
 * for the port's own bcrypt. A wrong bcrypt, cost or password then fails the comparison like any other
 * difference. Argon2id is not ported: the golden's hash is handed back, so those cases check the labels
 * around it only.
 */
function dependenciesFor(golden: Golden): LabelDependencies {
  const text = JSON.stringify(golden);
  const bcrypts = [...new Set(text.match(/\$2y\$\d\d\$[./A-Za-z0-9]{53}/g) ?? [])];
  const argon2id = /\$argon2id\$[^"\\]+/.exec(text)?.[0];
  return {
    bcrypt: (password, cost) => {
      const hash = bcrypts.shift();
      if (!hash) throw new Error("the golden has no bcrypt hash left");
      return bcryptHash(password, cost, bcryptSaltOf(hash));
    },
    ...(argon2id ? { argon2id: () => argon2id } : {}),
    newUuid: () => {
      throw new Error("no case asks for a uuid");
    },
  };
}

function labelApplication(overrides: unknown): LabelApplication {
  const a = merge(casesFile.applicationDefaults, overrides) as Json;
  const settings = a.settings as Json;
  const server = a.server as { proxy: Json; settings: Json };
  // Server::configuredCaddyProxyImage() reads services.caddy.image from the saved compose file; the cases write it on one line.
  const image = typeof server.proxy.last_saved_proxy_configuration === "string" ? (/image: '([^']+)'/.exec(server.proxy.last_saved_proxy_configuration)?.[1] ?? null) : null;
  return {
    uuid: a.uuid as string,
    fqdn: a.fqdn as string | null,
    portsExposes: a.ports_exposes as string | null,
    redirect: a.redirect as string,
    isHttpBasicAuthEnabled: a.is_http_basic_auth_enabled as boolean,
    httpBasicAuthUsername: a.http_basic_auth_username as string | null,
    httpBasicAuthPassword: a.http_basic_auth_password as string | null,
    httpBasicAuthHashAlgorithm: a.http_basic_auth_hash_algorithm as string,
    httpBasicAuthBcryptCost: a.http_basic_auth_bcrypt_cost as number,
    httpBasicAuthArgon2idMemoryCost: a.http_basic_auth_argon2id_memory_cost as number,
    httpBasicAuthArgon2idTimeCost: a.http_basic_auth_argon2id_time_cost as number,
    noindexDomains: a.noindex_domains,
    domainPortOverrides: a.domain_port_overrides as Record<string, number> | null,
    isStatic: settings.is_static as boolean,
    isForceHttpsEnabled: settings.is_force_https_enabled as boolean,
    isGzipEnabled: settings.is_gzip_enabled as boolean,
    isStripprefixEnabled: settings.is_stripprefix_enabled as boolean,
    isPermanentRedirectEnabled: settings.is_permanent_redirect_enabled as boolean,
    traefikCertificateResolver: settings.traefik_certificate_resolver as string | null,
    destinationNetwork: (a.destination as Json).network as string,
    server: {
      proxy: server.proxy,
      caddyProxyImage: image,
      generateExactLabels: server.settings.generate_exact_labels as boolean,
      traefikCertificateResolver: server.settings.traefik_certificate_resolver as string | null,
      isTrafficAnalyticsEnabled: server.settings.is_traffic_analytics_enabled as boolean,
    },
  };
}

function labelPreview(preview: unknown): LabelPreview | null {
  if (!preview) return null;
  const p = preview as Json;
  return { pullRequestId: p.pull_request_id as number, fqdn: (p.fqdn as string | null) ?? null, domainPortOverrides: (p.domain_port_overrides as Record<string, number> | undefined) ?? null };
}

/** The TypeScript port of a case's function, called as emit.php calls Coolify's. */
function run(c: Case, deps: LabelDependencies): unknown {
  const list = c.args as unknown[];
  const named = c.args as Json;
  switch (c.fn) {
    case "fqdnLabelsForTraefik":
      return fqdnLabelsForTraefik(camelKeys(named) as unknown as TraefikLabelsInput, deps);
    case "fqdnLabelsForCaddy":
      return fqdnLabelsForCaddy(camelKeys(named) as unknown as CaddyLabelsInput, deps);
    case "generateLabelsApplication":
      return generateLabelsApplication(labelApplication(named.application), labelPreview(named.preview), deps);
    case "parseContainerLabels": {
      const application = labelApplication(named.application);
      const stored = (merge(casesFile.applicationDefaults, named.application) as Json).custom_labels as string | null;
      const parsed = parseContainerLabels(stored, () => generateLabelsApplication(application, null, deps));
      return { returned: parsed.labels, stored: parsed.store };
    }
    case "defaultLabels": {
      const [uuid, name, projectName, resourceName, environment, pullRequestId, type, subType, subUuid, subName] = list as [string, string, string, string, string, number?, string?, string?, string?, string?];
      return defaultLabels({ uuid, name, projectName, resourceName, environment, pullRequestId, type, subType, subUuid, subName });
    }
    case "traefikHostRulesWithoutIpv6Brackets":
      return traefikHostRulesWithoutIpv6Brackets(list[0] as string[]);
    case "isNoindexDomain":
      return isNoindexDomain(list[0] as string, list[1] as string[] | null);
    case "caddyDockerProxyImageVersion":
      return caddyDockerProxyImageVersion(list[0] as string | null);
    case "decodeBase64EncodedLabels":
      return decodeBase64EncodedLabels(list[0] as string);
    case "isBase64Encoded":
      return isBase64Encoded(list[0] as string);
    case "escapeDollarSign":
      return escapeDollarSign(list[0] as string);
    case "caddySiteAddress":
      return caddySiteAddress(list[0] as string, list[1] as string, list[2] as boolean);
    default:
      throw new Error(`no port registered for ${c.fn}`);
  }
}

describe("label goldens: Coolify's own PHP output", () => {
  it("has a golden for every case, and enough of them", () => {
    expect(Object.keys(goldens).sort()).toEqual(casesFile.cases.map((c) => c.id).sort());
    expect(casesFile.cases.length).toBeGreaterThanOrEqual(150);
    // Every function the cases name is one run() knows.
    expect([...new Set(casesFile.cases.map((c) => c.fn))].sort()).toEqual(
      ["caddyDockerProxyImageVersion", "caddySiteAddress", "decodeBase64EncodedLabels", "defaultLabels", "escapeDollarSign", "fqdnLabelsForCaddy", "fqdnLabelsForTraefik", "generateLabelsApplication", "isBase64Encoded", "isNoindexDomain", "parseContainerLabels", "traefikHostRulesWithoutIpv6Brackets", "validateGeneralLabelFields"],
    );
  });

  // The `validate.*` cases have their own suite below.
  it.each(casesFile.cases.filter((c) => c.fn !== "validateGeneralLabelFields").map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const golden = goldens[c.id]!;
    const deps = dependenciesFor(golden);
    if (golden.ok) {
      expect(run(c, deps)).toEqual(golden.value);
    } else {
      // Coolify threw (fqdnLabelsForCaddy does not catch an invalid URL): so does the port, with Spatie's message.
      expect(() => run(c, deps)).toThrow(golden.error.replace(/^[^:]+: /, ""));
    }
  });

  it("covers both proxies, previews, basic auth with both hashes and the failures", () => {
    const text = JSON.stringify(goldens);
    for (const needle of ["traefik.http.routers.", "caddy_0.basic_auth.admin=", "caddy_0.basicauth.admin=", "caddy_0.basic_auth=argon2id", "app1uuid-pr-7", "$2y$04$", "$2y$12$", "X-Robots-Tag", "redirect-to-https-permanent", "log_append=coolify_app_id"]) {
      expect(text).toContain(needle);
    }
    expect(Object.values(goldens).filter((g) => !g.ok)).toHaveLength(2);
  });
});

describe("bcrypt: PHP's password_hash", () => {
  it("returns PHP's hash for PHP's salt, at every cost and length the goldens hold", () => {
    // From goldens.json: traefik.basic_auth.cost4 and traefik.basic_auth.long (a password beyond 72 bytes).
    const labels = (id: string): string => ((goldens[id] as { value: string[] }).value.find((l) => l.includes(".basicauth.users=")) ?? "").split(":").slice(1).join(":");
    const cost4 = labels("traefik.basic_auth.cost4");
    expect(bcryptHash("pässword with spaces & $ymbols", 4, bcryptSaltOf(cost4))).toBe(cost4);
    const long = labels("traefik.basic_auth.long");
    const password = "x".repeat(71) + "éz-beyond-72-bytes";
    expect(bcryptHash(password, 5, bcryptSaltOf(long))).toBe(long);
    // bcrypt reads 72 bytes: "é" is two, so the key ends inside it and the rest does not matter.
    expect(bcryptHash("x".repeat(71) + "é", 5, bcryptSaltOf(long))).toBe(long);
    expect(bcryptHash("x".repeat(71), 5, bcryptSaltOf(long))).not.toBe(long);
  });

  it("draws a new salt for each hash and refuses what PHP refuses", () => {
    const a = bcryptHash("secret", 4);
    const b = bcryptHash("secret", 4);
    expect(a).toMatch(/^\$2y\$04\$[./A-Za-z0-9]{53}$/);
    expect(a).not.toBe(b);
    expect(bcryptHash("secret", 4, bcryptSaltOf(a))).toBe(a);
    expect(() => bcryptHash("secret", 3)).toThrow("Invalid bcrypt cost parameter specified: 3");
    expect(() => bcryptHash("a\0b", 4)).toThrow("Bcrypt password must not contain null character");
    expect(() => bcryptSaltOf("not a hash")).toThrow();
  });
});

describe("label helpers beyond the goldens", () => {
  it("gives each domain its own uuid when asked, and one basic auth middleware", () => {
    const uuids = ["u1", "u2"];
    const labels = fqdnLabelsForTraefik(
      { uuid: "base", domains: ["http://a.example.com", "http://b.example.com"], generateUniqueUuid: true, isGzipEnabled: false, isHttpBasicAuthEnabled: true, httpBasicAuthUsername: "u", httpBasicAuthPassword: "p" },
      { bcrypt: () => "HASH", newUuid: () => uuids.shift()! },
    );
    expect(labels).toEqual([
      "traefik.enable=true",
      "traefik.http.middlewares.http-basic-auth-base.basicauth.users=u:HASH",
      "traefik.http.middlewares.redirect-to-https.redirectscheme.scheme=https",
      "traefik.http.routers.http-0-u1.entryPoints=http",
      "traefik.http.routers.http-0-u1.middlewares=http-basic-auth-base",
      "traefik.http.routers.http-0-u1.rule=Host(`a.example.com`) && PathPrefix(`/`)",
      "traefik.http.routers.http-1-u2.entryPoints=http",
      "traefik.http.routers.http-1-u2.middlewares=http-basic-auth-base",
      "traefik.http.routers.http-1-u2.rule=Host(`b.example.com`) && PathPrefix(`/`)",
    ]);
  });

  it("cannot hash with Argon2id unless a hasher is given", () => {
    const input: CaddyLabelsInput = { network: "n", uuid: "u", domains: ["https://a.example.com"], isHttpBasicAuthEnabled: true, httpBasicAuthUsername: "u", httpBasicAuthPassword: "p", httpBasicAuthArgon2idOptions: { memory_cost: 8192, time_cost: 1 } };
    expect(() => fqdnLabelsForCaddy(input)).toThrow("Argon2id password hashing is not available.");
  });

  it("sorts as PHP does, by bytes", () => {
    // "caddy_10" sorts before "caddy_1=" ("0" < "="), and an astral character after a BMP one.
    const labels = fqdnLabelsForCaddy({ network: "n", uuid: "u", domains: Array.from({ length: 11 }, (_, i) => `http://d${i}.example.com`), isGzipEnabled: false });
    expect(labels.indexOf("caddy_10=http://d10.example.com")).toBeLessThan(labels.indexOf("caddy_1=http://d1.example.com"));
  });

  it("slugs names as Str::slug does for Latin text and drops other scripts", () => {
    expect(slug("My App_v2")).toBe("my-app-v2");
    expect(slug("docker-image-abc")).toBe("docker-image-abc");
    expect(slug("Привет app")).toBe("app");
  });

  it("stores labels as base64 of their text", () => {
    expect(encodeLabels("a=ü\nb=1")).toBe(Buffer.from("a=ü\nb=1", "utf8").toString("base64"));
    expect(decodeBase64EncodedLabels(encodeLabels("a=ü\nb=1"))).toBe("a=ü\nb=1");
  });
});

// ---------------------------------------------------------------------------
// General::rules() for the label fields
// ---------------------------------------------------------------------------

describe("label field validation: Laravel's own messages", () => {
  /** The component's defaults, which a `validate.*` case's data replaces field by field. */
  const DEFAULTS: Json = {
    customLabels: null, isContainerLabelEscapeEnabled: true, isContainerLabelReadonlyEnabled: false, isHttpBasicAuthEnabled: false, httpBasicAuthUsername: null,
    httpBasicAuthPassword: null, httpBasicAuthHashAlgorithm: "bcrypt", httpBasicAuthBcryptCost: 10, httpBasicAuthArgon2idMemoryCost: 65536, httpBasicAuthArgon2idTimeCost: 4,
  };
  const validations = casesFile.cases.filter((c) => c.fn === "validateGeneralLabelFields");

  it.each(validations.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const golden = goldens[c.id] as { ok: true; value: Record<string, string[]> | [] };
    const expected: Record<string, string[]> = Array.isArray(golden.value) ? {} : { ...golden.value };
    // The one rule of Freeploy's own: Coolify's `nullable` lets a list through to base64_encode(), which then fails.
    if (c.id === "validate.wrong_types") expected.customLabels = ["The Custom labels field must be a string."];
    const v = validateLabelFields({ ...DEFAULTS, ...(c.args as Json) });
    expect(v.ok ? {} : v.errors).toEqual(expected);
  });

  it("reads what passed, and leaves alone what the body does not have", () => {
    expect(validations.length).toBeGreaterThanOrEqual(14);
    expect(validateLabelFields({})).toEqual({ ok: true, input: { instantSave: false } });
    expect(validateLabelFields({ instantSave: true, isContainerLabelEscapeEnabled: "0", isHttpBasicAuthEnabled: 1, httpBasicAuthBcryptCost: "12", httpBasicAuthPassword: "", customLabels: "a=b" })).toEqual({
      ok: true,
      input: { instantSave: true, isContainerLabelEscapeEnabled: false, isHttpBasicAuthEnabled: true, httpBasicAuthBcryptCost: 12, httpBasicAuthPassword: "", customLabels: "a=b" },
    });
  });
});

// ---------------------------------------------------------------------------
// The wiring: General's read, save, instant save and reset
// ---------------------------------------------------------------------------

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}
const golden = (id: string): string[] => (goldens[id] as { value: string[] }).value;
const decoded = (stored: unknown): string => Buffer.from(stored as string, "base64").toString("utf8");

/** One application with its settings, destination and server, in memory: the applications store and the label store over the same rows. */
class Memory {
  // The application of the goldens' applicationDefaults: its generated labels are the `application.default` golden.
  app: Record<string, unknown> & { id: number; uuid: string } = {
    id: 7, uuid: "app1uuid", name: "docker-image-app1uuid", description: null, fqdn: "https://app.example.com", build_pack: "dockerimage", status: "exited",
    git_repository: "coollabsio/coolify", git_branch: "main", docker_registry_image_name: "nginx", docker_registry_image_tag: "latest", ports_exposes: "3000", ports_mappings: null,
    custom_network_aliases: null, custom_labels: null, custom_docker_run_options: null, pre_deployment_command: null, pre_deployment_command_container: null,
    post_deployment_command: null, post_deployment_command_container: null, domain_port_overrides: null, noindex_domains: null, health_check_enabled: false, restart_count: 0,
    max_restart_count: 0, restart_limit_reached: false, container_present: null, environment_id: 10, destination_id: 20, destination_type: "App\\Models\\StandaloneDocker",
    redirect: "both", is_http_basic_auth_enabled: false, http_basic_auth_username: null, http_basic_auth_password: null, http_basic_auth_hash_algorithm: "bcrypt",
    http_basic_auth_bcrypt_cost: 10, http_basic_auth_argon2id_memory_cost: 65536, http_basic_auth_argon2id_time_cost: 4,
  };
  settings: Record<string, unknown> = {
    is_static: false, is_force_https_enabled: true, is_gzip_enabled: true, is_stripprefix_enabled: true, is_permanent_redirect_enabled: false,
    is_container_label_readonly_enabled: true, is_container_label_escape_enabled: true, traefik_certificate_resolver: null,
  };
  server = { uuid: "srv1", proxy: { type: "TRAEFIK", status: "exited", redirect_enabled: true } as Record<string, unknown>, generate_exact_labels: false, traefik_certificate_resolver: "letsencrypt" as string | null, is_traffic_analytics_enabled: false };
  others: Array<{ uuid: string; name: string; fqdn: string }> = [];
  labelWrites: ApplicationLabelChanges[] = [];
  settingWrites: ApplicationLabelSettingChanges[] = [];
  hashes = 0;

  private row(): DeployApplicationRow {
    return {
      ...this.app,
      is_container_label_readonly_enabled: this.settings.is_container_label_readonly_enabled,
      is_container_label_escape_enabled: this.settings.is_container_label_escape_enabled,
      environment_uuid: "env1", environment_name: "production", project_uuid: "prj1", project_name: "Shop",
      destination_uuid: "dst1", destination_name: "freeploy", destination_network: "coolify",
      server_uuid: "srv1", server_name: "main", server_ip: "203.0.113.10", server_is_swarm_manager: false, server_is_swarm_worker: false,
      server_is_reachable: true, server_is_usable: true, server_force_disabled: false,
    } as unknown as DeployApplicationRow;
  }

  applications: ApplicationStore = {
    findByUuid: async (uuid) => (uuid === this.app.uuid ? this.row() : null),
    updateGeneral: async (id, changes: ApplicationGeneralChanges) => {
      if (id !== this.app.id) return null;
      Object.assign(this.app, changes);
      return this.row();
    },
    domains: async () => [{ uuid: this.app.uuid, name: this.app.name as string, fqdn: (this.app.fqdn as string | null) ?? "" }, ...this.others].filter((a) => a.fqdn !== "").map((a) => ({ ...a, environment_uuid: "env1", project_uuid: "prj1" })),
    // The label routes read and write one application: nothing else is asked of the store.
    ...(Object.fromEntries(
      ["findProject", "findEnvironment", "environments", "resourceServers", "usableDestinations", "findDestination", "findServer", "insertDockerImage", "listForEnvironment"].map((name) => [
        name,
        () => {
          throw new Error(`${name} is not expected here`);
        },
      ]),
    ) as unknown as Omit<ApplicationStore, "findByUuid" | "updateGeneral" | "domains">),
  };

  labels: ApplicationLabelStore = {
    findSource: async (uuid) => {
      if (uuid !== this.app.uuid) return null;
      const s = this.settings;
      return {
        ...this.app,
        ...s,
        application_traefik_certificate_resolver: s.traefik_certificate_resolver,
        destination_network: "coolify",
        server_uuid: this.server.uuid,
        // The driver may hand JSON back as text.
        server_proxy: JSON.stringify(this.server.proxy),
        server_generate_exact_labels: this.server.generate_exact_labels,
        server_traefik_certificate_resolver: this.server.traefik_certificate_resolver,
        server_is_traffic_analytics_enabled: this.server.is_traffic_analytics_enabled,
      } as unknown as DeployApplicationLabelRow;
    },
    updateLabels: async (id, changes) => {
      if (id !== this.app.id) return false;
      this.labelWrites.push(changes);
      Object.assign(this.app, changes);
      return true;
    },
    updateSettings: async (applicationId, changes) => {
      if (applicationId !== this.app.id) return false;
      this.settingWrites.push(changes);
      Object.assign(this.settings, changes);
      return true;
    },
  };

  /** The stored labels text. */
  get stored(): string | null {
    return typeof this.app.custom_labels === "string" ? decoded(this.app.custom_labels) : null;
  }
}

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details: { fields?: Record<string, string[]>; conflicts?: unknown[] } } };
type Application = Record<string, unknown>;

function setup(opts: { write?: boolean } = {}) {
  const memory = new Memory();
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => respond({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : true;
      return respond({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  };
  const runner: ApplicationRunner = async (_env, _orgId, fn) =>
    fn({
      store: memory.applications,
      encrypt: async (column) => `fp1:${column}`,
      labels: {
        store: memory.labels,
        cipher: { encrypt: async (plaintext) => `fp1:${plaintext}`, decrypt: async (stored) => stored.slice(4) },
        // A hash that names its inputs and counts the calls: a regeneration is visible.
        dependencies: { bcrypt: (password, cost) => `bcrypt(${password},${cost})#${++memory.hashes}`, newUuid: () => "unused" },
      },
    });
  const call = async (method: string, path = "", body?: unknown) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleApplications(env, "req_1", actor, ORG_UUID, path.split("/").filter(Boolean), new Request(`${BASE}/applications/${path}`, init), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  const application = async (): Promise<Application> => (await call("GET", "app1uuid")).body.data!.application as Application;
  const patch = async (body: unknown) => call("PATCH", "app1uuid", body);
  return { memory, call, application, patch };
}

describe("General: the labels on load (mount)", () => {
  it("fills custom_labels with the generated labels on the first load, as base64 of the text, and leaves them alone afterwards", async () => {
    const t = setup();
    const first = await t.application();
    // Byte for byte what Coolify's generateLabelsApplication() returns for this application.
    expect(first.customLabels).toBe(golden("application.default").join("\n"));
    expect(t.memory.app.custom_labels).toBe(Buffer.from(golden("application.default").join("\n"), "utf8").toString("base64"));
    expect(first).toMatchObject({
      isContainerLabelReadonlyEnabled: true, isContainerLabelEscapeEnabled: true, isHttpBasicAuthEnabled: false, httpBasicAuthUsername: null, httpBasicAuthPassword: null,
      httpBasicAuthHashAlgorithm: "bcrypt", httpBasicAuthBcryptCost: 10, httpBasicAuthArgon2idMemoryCost: 65536, httpBasicAuthArgon2idTimeCost: 4, supportsArgon2id: false, proxyType: "TRAEFIK",
    });
    // The label keys are Coolify's, unchanged.
    expect(first.customLabels).toContain("caddy_ingress_network=coolify");
    expect(t.memory.labelWrites).toHaveLength(1);
    expect((await t.application()).customLabels).toBe(first.customLabels);
    expect(t.memory.labelWrites).toHaveLength(1);
  });

  it("does not generate for a reader, for a server without a proxy, or while labels are edited by hand", async () => {
    const reader = setup({ write: false });
    const seen = await reader.application();
    expect(seen.customLabels).toBeNull();
    expect(reader.memory.app.custom_labels).toBeNull();
    // A reader gets neither the labels nor the password, also when they exist.
    Object.assign(reader.memory.app, { custom_labels: encodeLabels("a=b"), is_http_basic_auth_enabled: true, http_basic_auth_username: "admin", http_basic_auth_password: "fp1:secret" });
    expect(await reader.application()).toMatchObject({ customLabels: null, httpBasicAuthPassword: null, httpBasicAuthUsername: "admin", isHttpBasicAuthEnabled: true });
    expect(reader.memory.labelWrites).toHaveLength(0);

    const none = setup();
    none.memory.server.proxy = { type: "NONE" };
    expect(await none.application()).toMatchObject({ customLabels: null, proxyType: "NONE" });
    expect(none.memory.app.custom_labels).toBeNull();

    const manual = setup();
    manual.memory.settings.is_container_label_readonly_enabled = false;
    expect(await manual.application()).toMatchObject({ customLabels: null, isContainerLabelReadonlyEnabled: false });
    expect(manual.memory.app.custom_labels).toBeNull();
  });

  it("generates for a server whose proxy has no type, and stores an empty text for an application without domains", async () => {
    const t = setup();
    t.memory.server.proxy = {};
    t.memory.app.fqdn = null;
    expect(await t.application()).toMatchObject({ customLabels: "", proxyType: null });
    expect(t.memory.app.custom_labels).toBe("");
  });

  it("reads the older formats and rewrites them as base64 of the text (parseContainerLabels)", async () => {
    const plain = setup();
    plain.memory.app.custom_labels = "traefik.enable=true\ncustom=1";
    expect((await plain.application()).customLabels).toBe("traefik.enable=true\ncustom=1");
    expect(plain.memory.app.custom_labels).toBe((goldens["parse.plain"] as unknown as { value: { stored: string } }).value.stored);

    const twice = setup();
    twice.memory.app.custom_labels = encodeLabels(encodeLabels("traefik.enable=true\ncustom=1"));
    expect((await twice.application()).customLabels).toBe("traefik.enable=true\ncustom=1");
    expect(twice.memory.stored).toBe("traefik.enable=true\ncustom=1");
  });
});

describe("General: saving the labels (submit)", () => {
  it("regenerates managed labels of an application with domains on every save, and takes no text from the client", async () => {
    const t = setup();
    const before = (await t.application()).customLabels as string;
    const r = await t.patch({ name: "Web shop", customLabels: "tampered=1" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ message: "Application settings updated!", warning: false });
    const saved = r.body.data!.application as Application;
    expect(saved.name).toBe("Web shop");
    expect(saved.customLabels).toBe(before);
    expect(t.memory.stored).toBe(before);

    // The first exposed port is the port of every router.
    const ports = (await t.patch({ portsExposes: "8080,9090" })).body.data!.application as Application;
    expect(ports.customLabels).toContain("traefik.http.services.https-0-app1uuid.loadbalancer.server.port=8080");
    expect(ports.customLabels).toContain("caddy_0.handle_path.0_reverse_proxy={{upstreams 8080}}");
    expect(ports.customLabels).not.toContain("3000");
    expect(t.memory.stored).toBe(ports.customLabels);

    // A changed domain: the saving hook keeps its port apart, and the labels route to it.
    const domain = (await t.patch({ fqdn: "https://shop.example.com:4000/api" })).body.data!.application as Application;
    expect(domain.fqdn).toBe("https://shop.example.com/api");
    expect(domain.customLabels).toContain("traefik.http.routers.https-0-app1uuid.rule=Host(`shop.example.com`) && PathPrefix(`/api`)");
    expect(domain.customLabels).toContain("traefik.http.services.https-0-app1uuid.loadbalancer.server.port=4000");
    expect(domain.customLabels).toContain("traefik.http.middlewares.https-0-app1uuid-stripprefix.stripprefix.prefixes=/api");
  });

  it("keeps the stored labels of an application without domains unless the ports or the escape setting change", async () => {
    const t = setup();
    await t.application();
    const generated = t.memory.stored;
    // Coolify regenerates in checkFqdns() only for an application that has domains.
    t.memory.app.fqdn = null;
    await t.patch({ name: "Worker" });
    expect(t.memory.stored).toBe(generated);
    // … and in submit() when the ports change: no domains, no proxy labels.
    await t.patch({ portsExposes: "8080" });
    expect(t.memory.stored).toBe("");

    const escape = setup();
    await escape.application();
    escape.memory.app.fqdn = null;
    const r = await escape.patch({ isContainerLabelEscapeEnabled: false });
    expect((r.body.data!.application as Application).isContainerLabelEscapeEnabled).toBe(false);
    expect(escape.memory.settingWrites).toEqual([{ is_container_label_escape_enabled: false }]);
    expect(escape.memory.stored).toBe("");
  });

  it("stores the text given while labels are edited by hand, and starts from the generated labels when there is none", async () => {
    const t = setup();
    const generated = (await t.application()).customLabels as string;
    const off = await t.patch({ isContainerLabelReadonlyEnabled: false, customLabels: "traefik.enable=false\nmy.label=ü $1" });
    expect(off.status).toBe(200);
    const saved = off.body.data!.application as Application;
    expect(saved).toMatchObject({ isContainerLabelReadonlyEnabled: false, customLabels: "traefik.enable=false\nmy.label=ü $1" });
    expect(t.memory.settings.is_container_label_readonly_enabled).toBe(false);
    expect(t.memory.app.custom_labels).toBe(Buffer.from("traefik.enable=false\nmy.label=ü $1", "utf8").toString("base64"));
    expect((await t.application()).customLabels).toBe("traefik.enable=false\nmy.label=ü $1");

    // Ports and domains no longer touch them: "Readonly labels are disabled. You can set the ports manually in the labels section."
    await t.patch({ portsExposes: "8080", fqdn: "https://other.example.com", name: "Renamed" });
    expect(t.memory.stored).toBe("traefik.enable=false\nmy.label=ü $1");
    // A body without the text keeps it.
    await t.patch({ description: "x" });
    expect(t.memory.stored).toBe("traefik.enable=false\nmy.label=ü $1");

    // An empty text on a server with a proxy: the generated labels again, for the application as it is now.
    for (const empty of ["", null]) {
      const cleared = (await t.patch({ customLabels: empty })).body.data!.application as Application;
      expect(cleared.customLabels).toContain("Host(`other.example.com`)");
      expect(cleared.customLabels).toContain("loadbalancer.server.port=8080");
      expect(cleared.customLabels).not.toBe(generated);
      await t.patch({ customLabels: "x=y" });
    }
    // … and on a server without one, nothing: base64_encode(null) is "".
    t.memory.server.proxy = { type: "NONE" };
    expect(((await t.patch({ customLabels: null })).body.data!.application as Application).customLabels).toBeNull();
    expect(t.memory.app.custom_labels).toBe("");

    // Switching management back on regenerates, whatever text comes with it.
    t.memory.server.proxy = { type: "TRAEFIK" };
    const on = (await t.patch({ isContainerLabelReadonlyEnabled: true, customLabels: "mine=1" })).body.data!.application as Application;
    expect(on.customLabels).toContain("traefik.enable=true");
    expect(on.customLabels).not.toContain("mine=1");
  });

  it("stores nothing when a field is refused, with Coolify's rules and messages", async () => {
    const t = setup();
    await t.application();
    const before = JSON.stringify([t.memory.app, t.memory.settings]);
    const r = await t.patch({ name: "", customLabels: 5, isContainerLabelEscapeEnabled: null, isContainerLabelReadonlyEnabled: "yes", isHttpBasicAuthEnabled: "", httpBasicAuthUsername: 5, httpBasicAuthPassword: "x".repeat(73), httpBasicAuthHashAlgorithm: "md5", httpBasicAuthBcryptCost: 3 });
    expect(r.status).toBe(422);
    expect(r.body.error!.details.fields).toEqual({
      name: ["The Name field is required."],
      customLabels: ["The Custom labels field must be a string."],
      isContainerLabelEscapeEnabled: ["The Container Label Escape setting must be true or false.", "The Container Label Escape setting is required."],
      isContainerLabelReadonlyEnabled: ["The Container Label Readonly setting must be true or false."],
      isHttpBasicAuthEnabled: ["The HTTP Basic Auth setting is required."],
      httpBasicAuthUsername: ["The http basic auth username field must be a string."],
      httpBasicAuthPassword: ["The http basic auth password field must not be greater than 72 characters."],
      httpBasicAuthHashAlgorithm: ["The selected http basic auth hash algorithm is invalid."],
      httpBasicAuthBcryptCost: ["The http basic auth bcrypt cost field must be at least 4."],
    });
    expect(JSON.stringify([t.memory.app, t.memory.settings])).toBe(before);
  });

  it("answers a domain conflict before the labels are touched", async () => {
    const t = setup();
    await t.application();
    const before = t.memory.app.custom_labels;
    t.memory.others.push({ uuid: "other", name: "other", fqdn: "https://taken.example.com" });
    const r = await t.patch({ fqdn: "https://taken.example.com", isContainerLabelReadonlyEnabled: false, customLabels: "a=b" });
    expect(r.status).toBe(409);
    expect(t.memory.app.custom_labels).toBe(before);
    expect(t.memory.settingWrites).toHaveLength(0);
  });
});

describe("General: HTTP Basic Authentication", () => {
  it("stores the method, the username and the encrypted password, and the labels carry the middleware for both proxies", async () => {
    const t = setup();
    await t.application();
    const r = await t.patch({ isHttpBasicAuthEnabled: true, httpBasicAuthUsername: "admin", httpBasicAuthPassword: "s3cret", httpBasicAuthBcryptCost: 12 });
    expect(r.status).toBe(200);
    const saved = r.body.data!.application as Application;
    expect(saved).toMatchObject({ isHttpBasicAuthEnabled: true, httpBasicAuthUsername: "admin", httpBasicAuthPassword: "s3cret", httpBasicAuthBcryptCost: 12, httpBasicAuthHashAlgorithm: "bcrypt" });
    // The column is an `encrypted` cast: only the ciphertext is stored.
    expect(t.memory.app).toMatchObject({ is_http_basic_auth_enabled: true, http_basic_auth_username: "admin", http_basic_auth_password: "fp1:s3cret", http_basic_auth_bcrypt_cost: 12 });
    const labels = (saved.customLabels as string).split("\n");
    // Traefik's and Caddy's labels each hash the password once, with the cost given.
    const traefik = labels.find((l) => l.startsWith("traefik.http.middlewares.http-basic-auth-app1uuid.basicauth.users="))!;
    const caddy = labels.find((l) => l.startsWith("caddy_0.basicauth.admin="))!;
    expect(traefik).toMatch(/=admin:bcrypt\(s3cret,12\)#\d+$/);
    expect(caddy).toMatch(/="bcrypt\(s3cret,12\)#\d+"$/);
    expect(labels).toContain("traefik.http.routers.https-0-app1uuid.middlewares=gzip-no-media,http-basic-auth-app1uuid");
    // The page's next read: the password, for someone who may update.
    expect(await t.application()).toMatchObject({ httpBasicAuthPassword: "s3cret", customLabels: saved.customLabels });

    // An unchanged password is not encrypted again; a cleared one is null.
    const writes = t.memory.labelWrites.length;
    await t.patch({ httpBasicAuthPassword: "s3cret", httpBasicAuthUsername: "admin" });
    expect(t.memory.labelWrites.slice(writes).some((w) => "http_basic_auth_password" in w || "http_basic_auth_username" in w)).toBe(false);
    const cleared = (await t.patch({ httpBasicAuthPassword: null })).body.data!.application as Application;
    expect(t.memory.app.http_basic_auth_password).toBeNull();
    // Without a password there is no middleware, as in Coolify.
    expect(cleared.customLabels).not.toContain("basicauth");
  });

  it("hashes with PHP's bcrypt when nothing is injected: the label verifies the password", async () => {
    const memory = new Memory();
    Object.assign(memory.app, { is_http_basic_auth_enabled: true, http_basic_auth_username: "admin", http_basic_auth_password: "fp1:s3cret", http_basic_auth_bcrypt_cost: 4 });
    const context: ApplicationLabelContext = { store: memory.labels, cipher: { encrypt: async (p) => `fp1:${p}`, decrypt: async (s) => s.slice(4) } };
    const fields = await resetDefaultLabels(context, "app1uuid");
    const hash = /basicauth\.users=admin:(\$2y\$04\$[./A-Za-z0-9]{53})/.exec(fields!.customLabels!)![1]!;
    expect(bcryptHash("s3cret", 4, bcryptSaltOf(hash))).toBe(hash);
    expect(bcryptHash("wrong", 4, bcryptSaltOf(hash))).not.toBe(hash);
  });

  it("refuses Argon2id on a server that cannot check it, with Coolify's message", async () => {
    const t = setup();
    await t.application();
    for (const body of [{ httpBasicAuthHashAlgorithm: "argon2id" }, { instantSave: true, httpBasicAuthHashAlgorithm: "argon2id" }]) {
      const r = await t.patch({ ...body, name: "Changed" });
      expect(r.status).toBe(422);
      expect(r.body.error).toMatchObject({ code: "validation_failed", message: "Argon2id needs a server that runs the Caddy proxy, version 2.11 or newer." });
    }
    expect(t.memory.app.http_basic_auth_hash_algorithm).toBe("bcrypt");
    expect(t.memory.app.name).toBe("docker-image-app1uuid");
    // A stored Argon2id reads as bcrypt on such a server (usesArgon2idBasicAuth).
    t.memory.app.http_basic_auth_hash_algorithm = "argon2id";
    expect(await t.application()).toMatchObject({ httpBasicAuthHashAlgorithm: "bcrypt", supportsArgon2id: false });
  });
});

describe("General: instantSave and resetDefaultLabels", () => {
  it("saves a listbox at once, answers 'Settings saved.' and regenerates managed labels", async () => {
    const t = setup();
    await t.application();
    const r = await t.patch({ instantSave: true, isHttpBasicAuthEnabled: true, name: "ignored", httpBasicAuthUsername: "ignored", customLabels: "ignored=1" });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ message: "Settings saved.", warning: false });
    expect(r.body.data!.application).toMatchObject({ isHttpBasicAuthEnabled: true, httpBasicAuthUsername: null, name: "docker-image-app1uuid" });
    expect(t.memory.app).toMatchObject({ is_http_basic_auth_enabled: true, http_basic_auth_username: null, name: "docker-image-app1uuid" });

    // Labels handed over to the user stay as they are …
    const off = await t.patch({ instantSave: true, isContainerLabelReadonlyEnabled: false });
    const kept = (off.body.data!.application as Application).customLabels;
    expect(off.body.data!.application).toMatchObject({ isContainerLabelReadonlyEnabled: false });
    await t.patch({ customLabels: "mine=1" });
    await t.patch({ instantSave: true, isContainerLabelEscapeEnabled: false });
    expect(t.memory.stored).toBe("mine=1");
    expect(t.memory.settings).toMatchObject({ is_container_label_readonly_enabled: false, is_container_label_escape_enabled: false });
    // … and taking them back regenerates them.
    const on = await t.patch({ instantSave: true, isContainerLabelReadonlyEnabled: true });
    expect((on.body.data!.application as Application).customLabels).toBe(kept);

    const bad = await t.patch({ instantSave: true, isContainerLabelReadonlyEnabled: "maybe", httpBasicAuthBcryptCost: 15 });
    expect(bad.status).toBe(422);
    expect(bad.body.error!.details.fields).toEqual({
      isContainerLabelReadonlyEnabled: ["The Container Label Readonly setting must be true or false."],
      httpBasicAuthBcryptCost: ["The http basic auth bcrypt cost field must not be greater than 14."],
    });
    expect((await t.call("PATCH", "nosuchapplication", { instantSave: true, isContainerLabelReadonlyEnabled: false })).status).toBe(404);
  });

  it("POST …/labels/reset replaces hand-written labels by the generated ones, for someone who may update", async () => {
    const t = setup();
    const generated = (await t.application()).customLabels;
    await t.patch({ isContainerLabelReadonlyEnabled: false, customLabels: "mine=1" });
    const r = await t.call("POST", "app1uuid/labels/reset");
    expect(r.status).toBe(200);
    expect(r.body.data!.application).toMatchObject({ uuid: "app1uuid", customLabels: generated, isContainerLabelReadonlyEnabled: false });
    expect(t.memory.stored).toBe(generated);

    expect((await t.call("POST", "nosuchapplication/labels/reset")).status).toBe(404);
    expect((await t.call("GET", "app1uuid/labels/reset")).status).toBe(405);
    expect((await t.call("POST", "app1uuid/labels/other")).status).toBe(404);
    expect((await t.call("POST", "app1uuid/labels")).status).toBe(404);

    const reader = setup({ write: false });
    reader.memory.app.custom_labels = encodeLabels("mine=1");
    expect((await reader.call("POST", "app1uuid/labels/reset")).status).toBe(404);
    expect((await reader.patch({ instantSave: true, isContainerLabelReadonlyEnabled: false })).status).toBe(404);
    expect(reader.memory.stored).toBe("mine=1");
  });

  it("route() sends the reset to the applications handler behind the same checks", async () => {
    const bare: Env = { ENVIRONMENT: "test" };
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    const path = `${BASE}/applications/app1uuid/labels/reset`;
    expect((await route(new Request(path, { method: "POST" }), bare)).status).toBe(401);
    expect((await route(new Request(path.replace(ORG, "not-an-org"), { method: "POST", headers }), bare)).status).toBe(404);
    // Routed to the handler: without bindings it answers 503.
    expect((await route(new Request(path, { method: "POST", headers }), bare)).status).toBe(503);
    expect((await route(new Request(path, { headers }), bare)).status).toBe(405);
    expect((await route(new Request(`${path}/more`, { method: "POST", headers }), bare)).status).toBe(404);
  });
});
