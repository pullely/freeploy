// DP-118: the console's create-a-cloud-server flow through its handler (handlers/cloud-server-create.ts), over the API
// goldens' fixture in Freeploy's database (PGlite with every deploy migration, row-level security on): team 1's Hetzner,
// DigitalOcean, Vultr and Hostinger tokens, its private keys (the committed test keys) and team 2's rows. The provider is
// a fake fetch that records every request and answers from a table, so no test reaches the network. Checked: mount()
// (step 1 or 2 by the route's token), load{Provider}Data() (the requests, the component's sorting and filtering, the
// provider_data_error), submit()'s rules and messages, its own checks, the requests that make the server, the stored row,
// the saved cloud-init script and SetsImageScanning's choice, the 501 after the row, the toasts of a failure, the
// authorization 404 that runs nothing and org isolation. Each case is rolled back.
import "@deploy-core-worker/router";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { withOrg } from "@saas/db/deploy";
import type { Env } from "@deploy-core-worker/env";
import { handleCloudServerCreate, type CloudServerCreateDeps } from "@deploy-core-worker/handlers/cloud-server-create";
import { columnCipher } from "@deploy-core-worker/handlers/cloud-tokens";
import { CLOUD_NEW_MESSAGES, phpCompare, sortBy } from "@deploy-core-worker/servers/cloud-new";
import { fingerprintMd5, formatPrivateKey, publicKeyOpenSSH } from "@deploy-core-worker/keys/ssh-keys";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";
import { CASES, fixtureKeyText } from "./api-v1-goldens.js";

const ORG1 = ORG_UUID[1]!;
const ORG2 = ORG_UUID[2]!;
const HETZNER = "c1paritycloudhetzner0001";
const OCEAN = "c2paritycloudocean000002";
const VULTR = "c3paritycloudvultr000003";
const HOSTINGER = "c4paritycloudhostinger04";
const OTHER_HETZNER = "c5paritycloudother000005";
const KEY = "k1parityprivatekey000001";
const OTHER_KEY = "k3otherteamkey0000000003";
const actor = { subjectId: "usr_1", subjectType: "user" };

let fixture: FixtureDatabase;
let publicKey = "";
let md5 = "";
beforeAll(async () => {
  fixture = await fixtureDatabase();
  const k = CASES.fixture.privateKeys.find((x: { uuid: string }) => x.uuid === KEY)!;
  const text = formatPrivateKey(fixtureKeyText(k));
  publicKey = `${await publicKeyOpenSSH(text)} `;
  md5 = (await fingerprintMd5(text))!;
}, 120_000);
afterAll(async () => fixture?.pg.close());

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

interface Sent {
  method: string;
  url: string;
  authorization: string | null;
  body?: unknown;
}
type Route = [method: string, url: RegExp, answer: unknown | ((sent: Sent) => Response)];

/** The provider: the first route whose method and URL match answers (a 404 otherwise); every request recorded. */
function provider(routes: Route[]) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" && init.body !== "" ? (JSON.parse(init.body) as unknown) : undefined;
    const s: Sent = { method, url, authorization: headers.get("authorization"), ...(body !== undefined ? { body } : {}) };
    sent.push(s);
    for (const [m, re, answer] of routes) if (m === method && re.test(url)) return typeof answer === "function" ? (answer as (x: Sent) => Response)(s) : json(answer);
    return json({ message: "Not Found" }, 404);
  };
  return { fetch, sent, paths: () => sent.map((x) => `${x.method} ${x.url.replace(/^https:\/\/[^/]+/, "")}`) };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the answers are read deep, as the console reads them.
type Body = { data?: Record<string, any>; error?: { code: string; message: string; details?: Record<string, any> } };

function client(db: TransactionalSqlExecutor, net: ReturnType<typeof provider>, allow: { write?: boolean } = {}, scan = false) {
  let ran = 0;
  const env: Env = {
    ENVIRONMENT: "test",
    DEPLOY_ENCRYPTION_KEY: TEST_KEK,
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      const ok = body.action === "deploy.resource.write" ? (allow.write ?? true) : true;
      return json({ data: { decision: ok ? "allow" : "deny", allow: ok } });
    }),
  } as Env;
  const deps: CloudServerCreateDeps = {
    runner: (_env, orgId, fn) => ((ran += 1), withOrg(db, orgId, fn)),
    providers: { fetch: net.fetch, sleep: async () => undefined },
    scanImagesOnNewServers: async () => scan,
    randomName: () => "fixture-random-name",
  };
  const call = async (method: string, segments: string[], body?: unknown, org = ORG1) => {
    const res = await handleCloudServerCreate(env, "req_1", actor, org, "org_x", segments, new Request("https://x/servers/new", { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), deps);
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { call, ran: () => ran };
}

const rows = (db: TransactionalSqlExecutor, sql: string, org = ORG1) =>
  withOrg(db, org, async (tx) => {
    await tx.execute("SET LOCAL search_path TO deploy");
    return (await tx.execute<Record<string, unknown>>(sql)).rows;
  });
const SERVER_ROW =
  "SELECT s.name, s.ip, s.user, s.port, s.private_key_id::int AS private_key_id, s.cloud_provider_token_id::int AS token_id, s.hetzner_server_id::text AS hetzner_server_id, s.hetzner_server_status, s.vultr_instance_id, s.vultr_instance_status, s.digitalocean_droplet_id::text AS digitalocean_droplet_id, s.digitalocean_droplet_status, s.hostinger_virtual_machine_id::text AS hostinger_virtual_machine_id, s.hostinger_virtual_machine_status, s.proxy->>'type' AS proxy_type, s.proxy->>'status' AS proxy_status, ss.is_image_scan_enabled FROM servers s JOIN server_settings ss ON ss.server_id = s.id WHERE s.uuid = ";

// ── Hetzner's answers ─────────────────────────────────────────────────────────

const page = (key: string, items: unknown[]) => ({ [key]: items, meta: { pagination: { next_page: null } } });
const HETZNER_CATALOG: Route[] = [
  ["GET", /\/v1\/locations\?/, page("locations", [{ id: 1, name: "fsn1", city: "Falkenstein", country: "DE", network_zone: "eu-central" }])],
  [
    "GET",
    /\/v1\/server_types\?/,
    page("server_types", [
      { name: "cx22", architecture: "x86", locations: [{ name: "fsn1", available: true, deprecation: null }, { name: "nbg1", available: false, deprecation: null }] },
      { name: "cx11", deprecated: true, locations: [{ name: "fsn1" }] },
      { name: "cax11", architecture: "arm", locations: [{ name: "fsn1", available: false, deprecation: null }] },
    ]),
  ],
  [
    "GET",
    /\/v1\/images\?/,
    page("images", [
      { id: 3, name: "ubuntu-24.04", type: "system", architecture: "x86" },
      { id: 2, name: "debian-12", type: "system", architecture: "x86" },
      { id: 9, name: "old", type: "system", deprecated: true },
      { id: 8, name: "snap", type: "snapshot" },
    ]),
  ],
  ["GET", /\/v1\/firewalls\?/, page("firewalls", [{ id: 5, name: "web" }, { id: 4, name: "db" }])],
  ["GET", /\/v1\/networks\?/, page("networks", [{ id: 7, name: "private", ip_range: "10.0.0.0/16", subnets: [{ type: "cloud", network_zone: "eu-central" }] }])],
];

const HETZNER_BODY = {
  server_name: "Parity-Cloud",
  selected_location: "fsn1",
  selected_server_type: "cx22",
  selected_image: "3",
  private_key_id: KEY,
  selectedHetznerSshKeyIds: ["11"],
  selectedHetznerFirewallIds: ["5", "5"],
  selectedHetznerNetworkIds: [],
  enable_ipv4: true,
  enable_ipv6: true,
  enable_backups: true,
  show_cloud_init_script: true,
  cloud_init_script: "#cloud-config\npackages:\n  - curl\n",
  save_cloud_init_script: true,
  cloud_init_script_name: "Curl",
  selected_cloud_init_script_id: null,
  scan_images: "on",
};

describe("PHP's sortBy()", () => {
  it("compares as PHP 8 does: numbers and numeric strings numerically, strings by bytes, stable", () => {
    expect([phpCompare("10", "9"), phpCompare("b", "a"), phpCompare(null, "a"), phpCompare(2, 2)]).toEqual([1, 1, -1, 0]);
    const items = [{ n: "b", i: 1 }, { n: "a", i: 2 }, { n: "b", i: 3 }];
    expect(sortBy(items as never[], (x) => (x as unknown as { n: string }).n).map((x) => (x as unknown as { i: number }).i)).toEqual([2, 1, 3]);
  });
});

describe("mount()", () => {
  it("is step 1 without a token of the provider, step 2 with one; the SSH keys, the scripts and the team's scan default", async () => {
    await fixture.inCase(async (db) => {
      const net = provider([]);
      const c = client(db, net, {}, true);
      const one = await c.call("GET", ["hetzner"]);
      expect(one.status).toBe(200);
      expect(one.body.data).toMatchObject({
        type: "hetzner",
        provider: "hetzner",
        providerName: "Hetzner",
        title: "Hetzner",
        tokens: [{ uuid: HETZNER, name: "Parity Hetzner", description: "The main Hetzner project" }],
        selectedTokenUuid: null,
        currentStep: 1,
        serverName: "fixture-random-name",
        privateKeyId: KEY,
        scanImages: "on",
        canCreatePrivateKey: true,
      });
      expect(one.body.data!.privateKeys.map((k: { uuid: string }) => k.uuid)).toContain(KEY);
      expect(one.body.data!.privateKeys.map((k: { uuid: string }) => k.uuid)).not.toContain(OTHER_KEY);
      expect((await c.call("GET", ["hetzner", HETZNER])).body.data).toMatchObject({ selectedTokenUuid: HETZNER, currentStep: 2 });
      // Another provider's token, or another org's, is not one of the available tokens: step 1.
      expect((await c.call("GET", ["hetzner", OCEAN])).body.data).toMatchObject({ selectedTokenUuid: null, currentStep: 1 });
      expect((await c.call("GET", ["hetzner", OTHER_HETZNER])).body.data).toMatchObject({ selectedTokenUuid: null, currentStep: 1 });
      expect((await c.call("GET", ["digital-ocean", OCEAN])).body.data).toMatchObject({ provider: "digitalocean", providerName: "DigitalOcean", currentStep: 2 });
      expect((await c.call("GET", ["hostinger"])).body.data!.cloudInitScripts).toEqual([]);
      // No provider was asked.
      expect(net.sent).toEqual([]);
    });
  });

  it("answers 404 for a type that is not a cloud provider's", async () => {
    await fixture.inCase(async (db) => {
      const c = client(db, provider([]));
      for (const segments of [["manual"], ["aws"], ["hetzner", HETZNER, "other"]]) expect((await c.call("GET", segments)).status).toBe(404);
      expect(c.ran()).toBe(0);
    });
  });
});

describe("load{Provider}Data()", () => {
  it("Hetzner: the catalogue with the token, the system images by name, out of stock types kept, firewalls and networks by name", async () => {
    await fixture.inCase(async (db) => {
      const net = provider([...HETZNER_CATALOG, ["GET", /\/v1\/ssh_keys\?/, page("ssh_keys", [{ id: 11, name: "laptop", fingerprint: "aa" }])]]);
      const r = await client(db, net).call("GET", ["hetzner", HETZNER, "catalog"]);
      expect(r.status).toBe(200);
      expect(net.paths()).toEqual([
        "GET /v1/locations?page=1&per_page=50",
        "GET /v1/server_types?page=1&per_page=50",
        "GET /v1/images?type=system&page=1&per_page=50",
        "GET /v1/ssh_keys?page=1&per_page=50",
        "GET /v1/firewalls?page=1&per_page=50",
        "GET /v1/networks?page=1&per_page=50",
      ]);
      expect(new Set(net.sent.map((s) => s.authorization))).toEqual(new Set(["Bearer hz-team1-token"]));
      const catalog = r.body.data!.catalog;
      expect(catalog.images.map((i: { id: number }) => i.id)).toEqual([2, 3]);
      expect(catalog.serverTypes.map((t: { name: string }) => t.name)).toEqual(["cx22", "cax11"]);
      // includeOutOfStock: nbg1, where cx22 is out of stock, is kept.
      expect(catalog.serverTypes[0].locations.map((l: { name: string }) => l.name)).toEqual(["fsn1", "nbg1"]);
      expect(catalog.hetznerFirewalls.map((f: { name: string }) => f.name)).toEqual(["db", "web"]);
      expect(catalog.hetznerSshKeys).toEqual([{ id: 11, name: "laptop", fingerprint: "aa" }]);
      expect(JSON.stringify(r.body)).not.toContain("hz-team1-token");
    });
  });

  it("shows the provider's error in the page and as a toast; a token that is not the provider's is 'Please select a valid … token.'", async () => {
    await fixture.inCase(async (db) => {
      const net = provider([["GET", /\/v1\/locations/, () => json({ error: { code: "unauthorized", message: "unable to authenticate" } }, 401)]]);
      const c = client(db, net);
      const r = await c.call("GET", ["hetzner", HETZNER, "catalog"]);
      expect(r.body.data).toEqual({ providerDataError: "Hetzner API error: unable to authenticate", toasts: [{ type: "error", message: "Hetzner API error: unable to authenticate" }] });
      expect((await c.call("GET", ["hetzner", OCEAN, "catalog"])).body.data).toEqual({ toasts: [{ type: "error", message: "Please select a valid Hetzner token." }] });
      const vultrNet = provider([["GET", /\/v2\/regions/, () => json({ error: "Invalid API token." }, 401)]]);
      expect((await client(db, vultrNet).call("GET", ["vultr", VULTR, "catalog"])).body.data!.providerDataError).toBe("Vultr API error: Invalid API token.");
      // Hostinger's message is the exception's as it is.
      const hostingerNet = provider([["GET", /data-centers/, () => json({ message: "Unauthenticated." }, 401)]]);
      expect((await client(db, hostingerNet).call("GET", ["hostinger", HOSTINGER, "catalog"])).body.data!.providerDataError).toBe("Hostinger API error: Unauthenticated.");
    });
  });

  it("Vultr, DigitalOcean and Hostinger: each component's sorting, and Hostinger's optional lists and default template", async () => {
    await fixture.inCase(async (db) => {
      const vultrNet = provider([
        ["GET", /\/v2\/regions/, { regions: [{ id: "lhr" }, { id: "ewr" }], meta: { links: { next: "" } } }],
        ["GET", /\/v2\/plans/, { plans: [{ id: "b", monthly_cost: 10 }, { id: "a", monthly_cost: 5 }], meta: { links: { next: "" } } }],
        ["GET", /\/v2\/os/, { os: [{ id: 2, name: "Ubuntu" }, { id: 1, name: "Debian" }], meta: { links: { next: "" } } }],
        ["GET", /\/v2\/ssh-keys/, { ssh_keys: [], meta: { links: { next: "" } } }],
      ]);
      const v = (await client(db, vultrNet).call("GET", ["vultr", VULTR, "catalog"])).body.data!.catalog;
      expect([v.regions.map((x: { id: string }) => x.id), v.plans.map((x: { id: string }) => x.id), v.operatingSystems.map((x: { id: number }) => x.id)]).toEqual([["ewr", "lhr"], ["a", "b"], [1, 2]]);
      expect(new Set(vultrNet.sent.map((s) => s.authorization))).toEqual(new Set(["Bearer vu-team1-token"]));
      const oceanNet = provider([
        ["GET", /\/v2\/regions/, { regions: [{ slug: "nyc1", available: true }, { slug: "old", available: false }] }],
        ["GET", /\/v2\/sizes/, { sizes: [{ slug: "s-1" }] }],
        ["GET", /\/v2\/images/, { images: [{ id: 2, distribution: "Ubuntu", name: "24.04" }, { id: 1, distribution: "Debian", name: "12" }] }],
        ["GET", /\/v2\/account\/keys/, { ssh_keys: [] }],
      ]);
      const d = (await client(db, oceanNet).call("GET", ["digital-ocean", OCEAN, "catalog"])).body.data!.catalog;
      expect([d.regions.map((x: { slug: string }) => x.slug), d.images.map((x: { id: number }) => x.id)]).toEqual([["nyc1"], [1, 2]]);
      const hostingerNet = provider([
        ["GET", /data-centers/, [{ id: 9, city: "Vilnius" }]],
        ["GET", /templates/, [{ id: 1, name: "Ubuntu 24.04 with Coolify" }, { id: 2, name: "Ubuntu 24.04 LTS" }, { id: 3, name: "AlmaLinux 9" }]],
        ["GET", /catalog/, [{ id: "hostingercom-vps-kvm2", prices: [{ id: "p2" }] }, { id: "hostingercom-game-panel" }]],
        ["GET", /public-keys/, () => json({ message: "Forbidden" }, 403)],
        ["GET", /post-install-scripts/, { data: [{ id: 5, name: "hello" }] }],
      ]);
      const h = (await client(db, hostingerNet).call("GET", ["hostinger", HOSTINGER, "catalog"])).body.data!.catalog;
      expect(h.templates.map((t: { id: number }) => t.id)).toEqual([3, 2, 1]);
      expect(h.catalog_items.map((t: { id: string }) => t.id)).toEqual(["hostingercom-vps-kvm2"]);
      expect([h.hostinger_public_keys, h.post_install_scripts, h.selected_os_template_id, h.selected_template_id]).toEqual([[], [{ id: 5, name: "hello" }], 2, 2]);
      expect(hostingerNet.paths()).toEqual(["GET /api/vps/v1/data-centers", "GET /api/vps/v1/templates", "GET /api/billing/v1/catalog?category=VPS", "GET /api/vps/v1/public-keys", "GET /api/vps/v1/post-install-scripts"]);
    });
  });
});

describe("submit(): rules and messages", () => {
  it("validates the component's rules with its messages; nothing is asked or stored", async () => {
    await fixture.inCase(async (db) => {
      const net = provider([]);
      const c = client(db, net);
      const empty = await c.call("POST", ["hetzner", HETZNER], { server_name: "", private_key_id: null });
      expect(empty.status).toBe(422);
      expect(empty.body.error!.details!.fields).toEqual({
        server_name: ["The server name field is required."],
        selected_location: ["The selected location field is required."],
        selected_image: ["The selected image field is required."],
        selected_server_type: ["The selected server type field is required."],
        private_key_id: ["The private key id field is required."],
        enable_ipv4: ["The enable ipv4 field is required."],
        enable_ipv6: ["The enable ipv6 field is required."],
        enable_backups: ["The enable backups field is required."],
      });
      // No token of the provider in the route: 'Please select a Hetzner token.'
      for (const segments of [["hetzner"], ["hetzner", OCEAN], ["hetzner", OTHER_HETZNER]]) {
        expect((await c.call("POST", segments, HETZNER_BODY)).body.error!.details!.fields).toEqual({ selected_token_id: ["Please select a Hetzner token."] });
      }
      const bad = await c.call("POST", ["hetzner", HETZNER], {
        ...HETZNER_BODY,
        server_name: "bad name!",
        selected_image: "ubuntu",
        private_key_id: OTHER_KEY,
        selectedHetznerSshKeyIds: ["x"],
        cloud_init_script: "packages: [curl",
        cloud_init_script_name: "x".repeat(256),
        selected_cloud_init_script_id: "nope",
      });
      const fields = bad.body.error!.details!.fields;
      expect(fields.server_name).toEqual(["The server name contains invalid characters. Only letters (a-z, A-Z), numbers (0-9), hyphens (-), and dots (.) are allowed."]);
      expect(fields.selected_image).toEqual(["The selected image field must be an integer."]);
      expect(fields.private_key_id).toEqual(["The selected private key id is invalid."]);
      expect(fields["selectedHetznerSshKeyIds.0"]).toEqual(["The selectedHetznerSshKeyIds.0 field must be an integer."]);
      expect(fields.cloud_init_script[0]).toMatch(/^The cloud init script /);
      expect(fields.cloud_init_script_name).toEqual(["The cloud init script name field must not be greater than 255 characters."]);
      expect(fields.selected_cloud_init_script_id).toEqual(["The selected selected cloud init script id is invalid."]);
      expect((await c.call("POST", ["vultr", VULTR], { server_name: "a", selected_os_id: "x" })).body.error!.details!.fields).toMatchObject({ selected_region: ["The selected region field is required."], selected_os_id: ["The selected os id field must be an integer."], disable_public_ipv4: ["The disable public ipv4 field is required."] });
      expect((await c.call("POST", ["digital-ocean", OCEAN], { server_name: "a" })).body.error!.details!.fields).toMatchObject({ selected_size: ["The selected size field is required."], monitoring: ["The monitoring field is required."] });
      expect((await c.call("POST", ["hostinger", HOSTINGER], { server_name: "a", selected_public_key_ids: "1" })).body.error!.details!.fields).toMatchObject({
        selected_data_center_id: ["The selected data center id field is required."],
        selected_price_id: ["The selected price id field is required."],
        selected_public_key_ids: ["The selected public key ids field must be an array."],
      });
      expect(net.sent).toEqual([]);
      expect(await rows(db, "SELECT name FROM servers WHERE name <> 'parity-server'")).toEqual([]);
    });
  });

  it("Hetzner's own checks: a type out of stock in the location, and at least one public IP protocol", async () => {
    await fixture.inCase(async (db) => {
      const net = provider(HETZNER_CATALOG);
      const c = client(db, net);
      const out = await c.call("POST", ["hetzner", HETZNER], { ...HETZNER_BODY, selected_server_type: "cax11" });
      expect([out.status, out.body.error!.details!.fields]).toEqual([422, { selected_server_type: [CLOUD_NEW_MESSAGES.outOfStock] }]);
      const none = await c.call("POST", ["hetzner", HETZNER], { ...HETZNER_BODY, enable_ipv4: false, enable_ipv6: false });
      expect(none.body.error!.details!.fields).toEqual({ enable_ipv4: ["Enable at least one public IP protocol."], enable_ipv6: ["Enable at least one public IP protocol."] });
      // Only the server types were asked again; no script saved, no server.
      expect(net.paths()).toEqual(["GET /v1/server_types?page=1&per_page=50", "GET /v1/server_types?page=1&per_page=50"]);
      expect(await rows(db, "SELECT name FROM cloud_init_scripts WHERE name = 'Curl'")).toEqual([]);
      const vultr = await c.call("POST", ["vultr", VULTR], { server_name: "v", selected_region: "ewr", selected_plan: "p", selected_os_id: 1, private_key_id: KEY, enable_ipv6: false, disable_public_ipv4: true });
      expect(vultr.body.error!.details!.fields).toEqual({ enable_ipv6: ["Enable IPv6 when disabling public IPv4."] });
    });
  });
});

describe("submit(): the server at the provider, the stored row, then the 501", () => {
  it("Hetzner: uploads the key, creates the server with the component's params, stores it, enables backups, answers 501", async () => {
    await fixture.inCase(async (db) => {
      const net = provider([
        ...HETZNER_CATALOG,
        ["GET", /\/v1\/ssh_keys\?/, page("ssh_keys", [{ id: 11, name: "laptop", fingerprint: "00:11" }])],
        ["POST", /\/v1\/ssh_keys$/, { ssh_key: { id: 77 } }],
        ["POST", /\/v1\/servers$/, { server: { id: 4242, status: "initializing", public_net: { ipv4: { ip: "203.0.113.7" }, ipv6: { ip: "2001:db8::/64" } } } }],
        ["POST", /\/v1\/servers\/4242\/actions\/enable_backup$/, { action: { id: 1 } }],
      ]);
      const r = await client(db, net).call("POST", ["hetzner", HETZNER], HETZNER_BODY);
      expect(r.status).toBe(501);
      expect(r.body.error!.message).toBe("Validating the new server needs the SSH executor, which is not available yet.");
      const uuid = r.body.error!.details!.uuid as string;
      expect(net.paths()).toEqual(["GET /v1/server_types?page=1&per_page=50", "GET /v1/ssh_keys?page=1&per_page=50", "POST /v1/ssh_keys", "POST /v1/servers", "POST /v1/servers/4242/actions/enable_backup"]);
      expect(net.sent[2]!.body).toEqual({ name: "Parity Key", public_key: publicKey });
      expect(net.sent[3]!.body).toEqual({
        name: "parity-cloud",
        server_type: "cx22",
        image: 3,
        location: "fsn1",
        start_after_create: true,
        ssh_keys: [77, 11],
        public_net: { enable_ipv4: true, enable_ipv6: true },
        firewalls: [{ firewall: 5 }],
        user_data: "#cloud-config\npackages:\n  - curl\n",
      });
      // The name as typed (ByHetzner stores $this->server_name), SetsImageScanning's choice.
      expect(await rows(db, `${SERVER_ROW}'${uuid}'`)).toEqual([
        {
          name: "Parity-Cloud",
          ip: "203.0.113.7",
          user: "root",
          port: 22,
          private_key_id: 1,
          token_id: 1,
          hetzner_server_id: "4242",
          hetzner_server_status: "initializing",
          vultr_instance_id: null,
          vultr_instance_status: null,
          digitalocean_droplet_id: null,
          digitalocean_droplet_status: null,
          hostinger_virtual_machine_id: null,
          hostinger_virtual_machine_status: null,
          proxy_type: "TRAEFIK",
          proxy_status: "exited",
          is_image_scan_enabled: true,
        },
      ]);
      // The script saved for later, encrypted with the org's key.
      const [script] = await rows(db, "SELECT script FROM cloud_init_scripts WHERE name = 'Curl'");
      const plain = await withOrg(db, ORG1, (tx) => columnCipher(tx, ORG1, TEST_KEK, "cloud_init_scripts.script").decrypt(String(script!.script)));
      expect(plain).toBe(HETZNER_BODY.cloud_init_script);
      // The created hook's predefined variables.
      expect((await rows(db, `SELECT key FROM shared_environment_variables WHERE server_id = (SELECT id FROM servers WHERE uuid = '${uuid}') ORDER BY key`)).map((x) => x.key)).toEqual(["COOLIFY_SERVER_NAME", "COOLIFY_SERVER_UUID"]);
    });
  });

  it("Hetzner: a key Hetzner has by its MD5 fingerprint is used; IPv6 only stores the network's first address", async () => {
    await fixture.inCase(async (db) => {
      const net = provider([
        ...HETZNER_CATALOG,
        ["GET", /\/v1\/ssh_keys\?/, page("ssh_keys", [{ id: 31, name: "known", fingerprint: md5 }])],
        ["POST", /\/v1\/servers$/, { server: { id: 5, public_net: { ipv4: null, ipv6: { ip: "2001:db8:1::/64" } } } }],
      ]);
      const r = await client(db, net).call("POST", ["hetzner", HETZNER], { ...HETZNER_BODY, enable_ipv4: false, enable_backups: false, save_cloud_init_script: false, cloud_init_script: null, selectedHetznerSshKeyIds: [], selectedHetznerFirewallIds: [], scan_images: "off" });
      expect(r.status).toBe(501);
      expect(net.paths()).toEqual(["GET /v1/server_types?page=1&per_page=50", "GET /v1/ssh_keys?page=1&per_page=50", "POST /v1/servers"]);
      expect(net.sent[2]!.body).toMatchObject({ ssh_keys: [31], public_net: { enable_ipv4: false, enable_ipv6: true } });
      expect(net.sent[2]!.body).not.toHaveProperty("user_data");
      expect(await rows(db, `SELECT ip, ss.is_image_scan_enabled FROM servers s JOIN server_settings ss ON ss.server_id = s.id WHERE s.uuid = '${r.body.error!.details!.uuid}'`)).toEqual([{ ip: "2001:db8:1::1", is_image_scan_enabled: false }]);
    });
  });

  it("Hetzner: a provider failure is handleError()'s toast; nothing is stored but the script asked for", async () => {
    await fixture.inCase(async (db) => {
      const net = provider([
        ...HETZNER_CATALOG,
        ["GET", /\/v1\/ssh_keys\?/, page("ssh_keys", [])],
        ["POST", /\/v1\/ssh_keys$/, { ssh_key: { id: 77 } }],
        ["POST", /\/v1\/servers$/, () => json({ error: { code: "resource_limit_exceeded", message: "server limit reached" } }, 403)],
      ]);
      const r = await client(db, net).call("POST", ["hetzner", HETZNER], HETZNER_BODY);
      expect([r.status, r.body.data]).toEqual([200, { toasts: [{ type: "error", message: "Hetzner API error: server limit reached" }] }]);
      expect(await rows(db, "SELECT name FROM servers WHERE hetzner_server_id IS NOT NULL")).toEqual([]);
      // CloudInitScript::create() runs before the provider is asked, as in Coolify.
      expect((await rows(db, "SELECT name FROM cloud_init_scripts WHERE name = 'Curl'")).length).toBe(1);
    });
  });

  it("Vultr: the key by its text, the script base64-encoded, the IP waited for, the normalized name stored", async () => {
    await fixture.inCase(async (db) => {
      let looks = 0;
      const net = provider([
        ["GET", /\/v2\/ssh-keys/, { ssh_keys: [{ id: "key-1", ssh_key: `${publicKey.trim()} other-comment` }], meta: { links: { next: "" } } }],
        ["POST", /\/v2\/instances$/, { instance: { id: "inst-1", status: "pending", main_ip: "0.0.0.0" } }],
        ["GET", /\/v2\/instances\/inst-1$/, () => json({ instance: { id: "inst-1", status: "active", main_ip: (looks += 1) < 2 ? "0.0.0.0" : "198.51.100.4" } })],
      ]);
      const r = await client(db, net).call("POST", ["vultr", VULTR], {
        server_name: " Vultr-Box ",
        selected_region: "ewr",
        selected_plan: "vc2-1c-1gb",
        selected_os_id: "2284",
        private_key_id: KEY,
        selectedVultrSshKeyIds: ["key-2"],
        enable_ipv6: true,
        disable_public_ipv4: false,
        cloud_init_script: "#cloud-config\n",
        save_cloud_init_script: false,
        scan_images: "off",
      });
      expect(r.status).toBe(501);
      expect(net.paths()).toEqual(["GET /v2/ssh-keys?per_page=100", "POST /v2/instances", "GET /v2/instances/inst-1", "GET /v2/instances/inst-1"]);
      expect(net.sent[1]!.body).toEqual({ region: "ewr", plan: "vc2-1c-1gb", os_id: 2284, label: "vultr-box", hostname: "vultr-box", sshkey_id: ["key-1", "key-2"], enable_ipv6: true, disable_public_ipv4: false, user_data: Buffer.from("#cloud-config\n").toString("base64") });
      expect(await rows(db, `SELECT name, ip, vultr_instance_id, vultr_instance_status, cloud_provider_token_id::int AS token FROM servers WHERE uuid = '${r.body.error!.details!.uuid}'`)).toEqual([{ name: "vultr-box", ip: "198.51.100.4", vultr_instance_id: "inst-1", vultr_instance_status: "active", token: 3 }]);
    });
  });

  it("DigitalOcean: the key uploaded, the droplet stored with the placeholder IP, then its public IP", async () => {
    await fixture.inCase(async (db) => {
      const net = provider([
        ["GET", /\/v2\/account\/keys/, { ssh_keys: [{ id: 1, fingerprint: "other" }] }],
        ["POST", /\/v2\/account\/keys$/, { ssh_key: { id: 88 } }],
        ["POST", /\/v2\/droplets$/, { droplet: { id: 900, status: "new", networks: { v4: [] } } }],
        ["GET", /\/v2\/droplets\/900$/, { droplet: { id: 900, status: "active", networks: { v4: [{ type: "private", ip_address: "10.0.0.2" }, { type: "public", ip_address: "192.0.2.9" }] } } }],
      ]);
      const r = await client(db, net).call("POST", ["digital-ocean", OCEAN], {
        server_name: "Drop",
        selected_region: "nyc1",
        selected_size: "s-1vcpu-1gb",
        selected_image: "ubuntu-24-04-x64",
        private_key_id: KEY,
        selectedDigitalOceanSshKeyIds: ["1"],
        enable_ipv6: false,
        monitoring: true,
        show_cloud_init_script: false,
        scan_images: "on",
      });
      expect(r.status).toBe(501);
      expect(net.paths()).toEqual(["GET /v2/account/keys?page=1&per_page=50", "POST /v2/account/keys", "POST /v2/droplets", "GET /v2/droplets/900"]);
      expect(net.sent[1]!.body).toEqual({ name: "Parity Key", public_key: publicKey });
      expect(net.sent[2]!.body).toEqual({ name: "drop", region: "nyc1", size: "s-1vcpu-1gb", image: "ubuntu-24-04-x64", ssh_keys: [88, 1], ipv6: false, monitoring: true });
      expect(await rows(db, `${SERVER_ROW}'${r.body.error!.details!.uuid}'`)).toEqual([expect.objectContaining({ name: "drop", ip: "192.0.2.9", digitalocean_droplet_id: "900", digitalocean_droplet_status: "active", token_id: 2, is_image_scan_enabled: true })]);
    });
  });

  const HOSTINGER_LISTS: Route[] = [
    ["GET", /\/api\/billing\/v1\/catalog/, [{ id: "hostingercom-vps-kvm2", prices: [{ id: "hostingercom-vps-kvm2-usd-1m" }] }]],
    ["GET", /\/api\/vps\/v1\/data-centers$/, [{ id: 9 }]],
    ["GET", /\/api\/vps\/v1\/templates$/, [{ id: 1001, name: "Ubuntu 24.04 LTS" }]],
    ["GET", /\/api\/vps\/v1\/public-keys$/, { data: [{ id: 41, name: "laptop" }] }],
  ];
  const HOSTINGER_BODY = { server_name: "Host", selected_data_center_id: "9", selected_template_id: "1001", selected_price_id: "hostingercom-vps-kvm2-usd-1m", private_key_id: KEY, enable_backups: false, selected_public_key_ids: ["41"], selected_post_install_script_id: null, scan_images: "off" };

  it("Hostinger: the choices asked again, the VPS bought with the public key, stored, the keys attached, the IP waited for", async () => {
    await fixture.inCase(async (db) => {
      let listed = 0;
      const net = provider([
        ...HOSTINGER_LISTS,
        ["GET", /\/api\/vps\/v1\/virtual-machines$/, () => json((listed += 1) === 1 ? [] : [])],
        ["POST", /\/api\/vps\/v1\/virtual-machines$/, { id: "order-1", virtual_machine: { id: 555, state: "initial", ipv4: [] } }],
        ["POST", /\/api\/vps\/v1\/public-keys\/attach\/555$/, { data: [] }],
        ["GET", /\/api\/vps\/v1\/virtual-machines\/555$/, { id: 555, state: "running", ipv4: [{ address: "203.0.113.55" }] }],
      ]);
      const r = await client(db, net).call("POST", ["hostinger", HOSTINGER], HOSTINGER_BODY);
      expect(r.status).toBe(501);
      expect(net.paths()).toEqual([
        "GET /api/billing/v1/catalog?category=VPS",
        "GET /api/vps/v1/data-centers",
        "GET /api/vps/v1/templates",
        "GET /api/vps/v1/public-keys",
        "GET /api/vps/v1/virtual-machines",
        "POST /api/vps/v1/virtual-machines",
        "POST /api/vps/v1/public-keys/attach/555",
        "GET /api/vps/v1/virtual-machines/555",
      ]);
      expect(new Set(net.sent.map((s) => s.authorization))).toEqual(new Set(["Bearer ho-team1-token"]));
      // A hostname without a dot is left out: Hostinger accepts only a fully qualified one.
      expect(net.sent[5]!.body).toEqual({ item_id: "hostingercom-vps-kvm2-usd-1m", setup: { data_center_id: 9, template_id: 1001, enable_backups: false, public_key: { name: "Parity Key", key: publicKey } } });
      expect(net.sent[6]!.body).toEqual({ ids: [41] });
      expect(await rows(db, `${SERVER_ROW}'${r.body.error!.details!.uuid}'`)).toEqual([expect.objectContaining({ name: "host", ip: "203.0.113.55", hostinger_virtual_machine_id: "555", hostinger_virtual_machine_status: "running", token_id: 4 })]);
    });
  });

  it("Hostinger: a choice no longer offered is its field's message; an order waiting for payment is a toast", async () => {
    await fixture.inCase(async (db) => {
      const net = provider([...HOSTINGER_LISTS, ["GET", /\/api\/vps\/v1\/post-install-scripts$/, { data: [{ id: 5, name: "hello" }] }]]);
      const gone = await client(db, net).call("POST", ["hostinger", HOSTINGER], { ...HOSTINGER_BODY, selected_price_id: "gone", selected_data_center_id: 1, selected_public_key_ids: [41, 42], selected_post_install_script_id: 3 });
      expect(gone.body.error!.details!.fields).toEqual({
        selected_price_id: [CLOUD_NEW_MESSAGES.hostingerPrice],
        selected_data_center_id: [CLOUD_NEW_MESSAGES.hostingerDataCenter],
        selected_public_key_ids: [CLOUD_NEW_MESSAGES.hostingerPublicKeys],
        selected_post_install_script_id: [CLOUD_NEW_MESSAGES.hostingerPostInstallScript],
      });
      const pending = provider([...HOSTINGER_LISTS, ["GET", /\/api\/vps\/v1\/virtual-machines$/, []], ["POST", /\/api\/vps\/v1\/virtual-machines$/, { id: "order-9", virtual_machine: null }]]);
      const r = await client(db, pending).call("POST", ["hostinger", HOSTINGER], HOSTINGER_BODY);
      expect(r.body.data).toEqual({ toasts: [{ type: "error", message: "Hostinger order order-9 is waiting for payment. Finish the VPS setup in hPanel." }] });
      expect(await rows(db, "SELECT name FROM servers WHERE hostinger_virtual_machine_id IS NOT NULL")).toEqual([]);
    });
  });
});

describe("authorization and org isolation", () => {
  it("a denial of deploy.resource.write is a 404 that runs nothing and asks no provider", async () => {
    await fixture.inCase(async (db) => {
      const net = provider(HETZNER_CATALOG);
      const c = client(db, net, { write: false });
      for (const [method, segments, body] of [
        ["GET", ["hetzner"], undefined],
        ["GET", ["hetzner", HETZNER, "catalog"], undefined],
        ["POST", ["hetzner", HETZNER], HETZNER_BODY],
      ] as const) {
        const r = await c.call(method, [...segments], body);
        expect([method, r.status, r.body.error!.code]).toEqual([method, 404, "not_found"]);
      }
      expect(c.ran()).toBe(0);
      expect(net.sent).toEqual([]);
    });
  });

  it("an org sees only its own tokens, keys and scripts", async () => {
    await fixture.inCase(async (db) => {
      const net = provider([]);
      const c = client(db, net);
      const other = await c.call("GET", ["hetzner"], undefined, ORG2);
      expect(other.body.data!.tokens.map((t: { uuid: string }) => t.uuid)).toEqual([OTHER_HETZNER]);
      expect(other.body.data!.privateKeys.map((k: { uuid: string }) => k.uuid)).toEqual([OTHER_KEY]);
      // Team 1's token is no token of team 2's: step 1, its catalogue the valid token toast, its submit the token message.
      expect((await c.call("GET", ["hetzner", HETZNER], undefined, ORG2)).body.data).toMatchObject({ currentStep: 1, selectedTokenUuid: null });
      expect((await c.call("GET", ["hetzner", HETZNER, "catalog"], undefined, ORG2)).body.data).toEqual({ toasts: [{ type: "error", message: "Please select a valid Hetzner token." }] });
      expect((await c.call("POST", ["hetzner", HETZNER], HETZNER_BODY, ORG2)).body.error!.details!.fields).toMatchObject({ selected_token_id: ["Please select a Hetzner token."], private_key_id: ["The selected private key id is invalid."] });
      expect(net.sent).toEqual([]);
    });
  });
});
