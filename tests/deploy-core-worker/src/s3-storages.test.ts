// Integrations → Storage (DP-65): the Signature Version 4 signer against AWS's
// published test suite (fixtures/s3/aws4-testsuite.json) and against the
// requests aws-sdk-php signs for Coolify's connection test; the test itself
// (ListObjectsV2, the URL styles and the path-style fallback, the error
// messages word for word) and the forms' validation, against what Coolify's
// own PHP does (fixtures/s3/goldens.json, emitted by fixtures/s3/emit.php);
// and the handlers' routing, authorization and storage. Every HTTP exchange
// and host lookup goes through a fake: no test touches the network. The SQL
// is tested in tests/db.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleS3Storages, type S3StorageRunner } from "@deploy-core-worker/handlers/s3-storages";
import { canonicalRequest, sign, stringToSign, credentialScope, uriEncode, type SignableRequest } from "@deploy-core-worker/s3-storages/sigv4";
import { detectPathStyleEndpoint, listFiles, listObjectsRequest, testS3Connection, xmlElements, type S3Http } from "@deploy-core-worker/s3-storages/connection";
import { classifyIp, filterValidateUrl, type HostResolver } from "@deploy-core-worker/s3-storages/safe-url";
import { normalizeEndpoint, validateCreateStorage, validateUpdateStorage, validS3BucketName } from "@deploy-core-worker/s3-storages/validation";
import type { S3StorageStore } from "@deploy-core-worker/s3-storages/service";
import type { KeyCipher } from "@deploy-core-worker/private-keys/service";
import type { DeployS3StorageRow, DeployS3StorageWithSecretRow, DeployStorageBackupRow, S3StorageFields } from "@saas/db/deploy";

const dir = join(process.cwd(), "fixtures", "s3");
const suite = JSON.parse(readFileSync(join(dir, "aws4-testsuite.json"), "utf8")) as Record<string, { req: string; creq: string; sts: string; authz: string }>;
type Answer = { status: number; contentType: string; body: string };
interface Cases {
  server: Record<string, { path?: Answer; virtual?: Answer }>;
  requests: Array<{ name: string; region: string; key: string; secret: string; bucket: string; endpoint: string; pathStyle: boolean }>;
  testConnection: Array<{ name: string; storage: { region: string; key: string; secret: string; bucket: string; endpoint: string; use_path_style_endpoint: boolean } }>;
}
interface Goldens {
  requests: Array<{ name: string; requests: Array<{ method: string; host: string; uri: string; headers: Record<string, string> }>; error: string | null }>;
  testConnection: Array<{ name: string; requests: Array<{ host: string; uri: string }>; error: string | null; isUsable: boolean; usesPathStyleEndpoint: boolean }>;
  validation: Array<{ form: "create" | "update"; input: Record<string, unknown>; endpoint: string; errors: Record<string, string[]> | [] }>;
}
const cases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as Cases & { validationBase: Record<string, Record<string, unknown>> };
const goldens = JSON.parse(readFileSync(join(dir, "goldens.json"), "utf8")) as Goldens;

/** What Coolify's private-target message says after its first sentence (Freeploy has no settings to link to). */
const SETTINGS_SUFFIX = " Configure allowed internal targets: http://localhost/settings/advanced#endpoint-section";
const freeploy = (m: string) => m.replace(SETTINGS_SUFFIX, "");

const AWS_CREDENTIALS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };

/** A .req file of the suite: request line, headers (a line starting with whitespace continues the previous one), blank line, body. */
function parseReq(text: string): SignableRequest & { body: string } {
  const [head, ...bodyParts] = text.split("\n\n");
  const lines = head!.split("\n");
  const [method, target] = lines[0]!.split(" ") as [string, string];
  const headers: Array<[string, string]> = [];
  for (const line of lines.slice(1)) {
    if (/^\s/.test(line) && headers.length) headers[headers.length - 1]![1] += "\n" + line;
    else {
      const i = line.indexOf(":");
      headers.push([line.slice(0, i), line.slice(i + 1)]);
    }
  }
  const q = target.indexOf("?");
  const path = q >= 0 ? target.slice(0, q) : target;
  const query: Array<[string, string]> = q >= 0 ? target.slice(q + 1).split("&").map((p) => { const e = p.indexOf("="); return e >= 0 ? [p.slice(0, e), p.slice(e + 1)] : [p, ""]; }) : [];
  return { method, path, query, headers, payloadHash: "", body: bodyParts.join("\n\n") };
}

async function sha256(body: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("Signature Version 4: AWS's test suite", () => {
  const names = Object.keys(suite);
  it("has the vectors it was given", () => {
    expect(names.length).toBe(21);
    expect(names).toContain("get-vanilla");
    expect(names).toContain("post-x-www-form-urlencoded-parameters");
  });
  it.each(names)("%s: canonical request, string to sign, Authorization", async (name) => {
    const v = suite[name]!;
    const req = parseReq(v.req);
    req.payloadHash = await sha256(req.body);
    const date = req.headers.find(([h]) => h.toLowerCase() === "x-amz-date")![1];
    expect(canonicalRequest(req).canonicalRequest).toBe(v.creq);
    expect(await stringToSign(date, credentialScope(date, "us-east-1", "service"), v.creq)).toBe(v.sts);
    const s = await sign(req, AWS_CREDENTIALS, "us-east-1", "service", date);
    expect(s.stringToSign).toBe(v.sts);
    expect(s.authorization).toBe(v.authz);
  });
  it("UriEncode keeps only the unreserved characters", () => {
    expect(uriEncode("a b/c~d*é")).toBe("a%20b%2Fc~d%2A%C3%A9");
    expect(uriEncode("/a b/", true)).toBe("/a%20b/");
  });
});

describe("the connection test's request, as aws-sdk-php sends it for Coolify", () => {
  const signed = goldens.requests.filter((g) => g.requests.length > 0);
  it.each(signed.map((g) => g.name))("%s", async (name) => {
    const c = cases.requests.find((x) => x.name === name)!;
    const g = signed.find((x) => x.name === name)!;
    const sent = g.requests[0]!;
    // The URL: path-style or virtual-hosted, the endpoint's path, the query.
    const req = listObjectsRequest({ endpoint: c.endpoint, bucket: c.bucket, region: c.region, key: c.key, secret: c.secret, usePathStyleEndpoint: c.pathStyle }, c.pathStyle);
    expect([req.host, new URL(req.url).pathname + new URL(req.url).search]).toEqual([sent.host, sent.uri]);
    // The signature over the headers the SDK signed (it also signs an empty X-Amz-User-Agent).
    const h = sent.headers;
    const s = await sign(
      { method: "GET", path: req.path, query: req.query, headers: [["host", h.host!], ["x-amz-content-sha256", h["x-amz-content-sha256"]!], ["x-amz-date", h["x-amz-date"]!], ["x-amz-user-agent", h["x-amz-user-agent"]!]], payloadHash: h["x-amz-content-sha256"]! },
      { accessKeyId: c.key, secretAccessKey: c.secret },
      c.region,
      "s3",
      h["x-amz-date"]!,
    );
    expect(s.authorization).toBe(h.authorization);
  });
});

/** A fake S3 endpoint that answers as fake-s3.php does for the bucket of a URL. */
function fakeS3(seen: string[] = []): S3Http {
  return async (url) => {
    seen.push(url);
    const u = new URL(url);
    const label = u.hostname.split(".")[0]!;
    const segments = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    let answer: Answer | undefined;
    for (const [bucket, styles] of Object.entries(cases.server)) {
      if (label === bucket && styles.virtual) answer = styles.virtual;
      else if (segments.includes(bucket) && styles.path) answer = styles.path;
    }
    answer ??= { status: 200, contentType: "application/xml", body: "<?xml version=\"1.0\"?><ListBucketResult/>" };
    return { status: answer.status, headers: new Headers({ "content-type": answer.contentType }), body: answer.body };
  };
}
const noSleep = async () => undefined;

describe("the error Coolify shows for each answer", () => {
  const failing = goldens.requests.filter((g) => g.error !== null);
  it("covers the answers fixtures/s3 lists", () => expect(failing.map((g) => g.name)).toEqual(["InvalidAccessKeyId", "NoSuchBucket", "SignatureDoesNotMatch", "SecondLevelDomainForbidden", "plain-text-500", "xml-503", "empty-403", "html-404", "endpoint-with-query"]));
  it.each(failing.map((g) => g.name))("%s", async (name) => {
    const c = cases.requests.find((x) => x.name === name)!;
    const g = failing.find((x) => x.name === name)!;
    const seen: string[] = [];
    const conn = { endpoint: c.endpoint, bucket: c.bucket, region: c.region, key: c.key, secret: c.secret, usePathStyleEndpoint: c.pathStyle };
    await expect(listFiles(conn, c.pathStyle, { http: fakeS3(seen), sleep: noSleep })).rejects.toThrow(g.error!);
    const err = await listFiles(conn, c.pathStyle, { http: fakeS3(), sleep: noSleep }).catch((e: Error) => e.message);
    expect(err).toBe(g.error);
    // The SDK retries a server error: as many attempts as the endpoint saw.
    expect(seen.length).toBe(g.requests.length);
  });
  it("a failed exchange carries the runtime's error, after the retries", async () => {
    let n = 0;
    const http: S3Http = async () => {
      n++;
      throw new Error("Network connection lost.");
    };
    const err = await listFiles({ endpoint: "https://s3.example.com", bucket: "b1x", region: "us-east-1", key: "k", secret: "s", usePathStyleEndpoint: true }, true, { http, sleep: noSleep }).catch((e: Error) => e.message);
    expect(err).toBe(`Unable to list contents for '', shallow listing\n\nReason: Error executing "ListObjectsV2" on "https://s3.example.com/b1x/?list-type=2&prefix=&delimiter=%2F"; AWS HTTP error:\nNetwork connection lost.`);
    expect(n).toBe(3);
  });
  it("reads XML as SimpleXML would", () => {
    expect(xmlElements("<a><b>x &amp; y</b></a>")).toEqual([{ name: "a", text: "" }, { name: "b", text: "x & y" }]);
    expect(xmlElements("internal")).toBeNull();
    expect(xmlElements("<a><b></a>")).toBeNull();
    expect(xmlElements("<a/><b/>")).toBeNull();
  });
});

/** The goldens' endpoint host is the fake server on localhost, which Freeploy never allows; the port's runs use a public name. */
const PUBLIC_HOST = "s3.test.example";
const resolver: HostResolver = async (host) =>
  ({ "unresolvable.example": [], "private.example": ["10.0.0.5"], "linklocal.example": ["169.254.169.254"], "mixed.example": ["93.184.216.34", "10.0.0.9"], localhost: ["127.0.0.1"] })[host] ?? ["93.184.216.34"];

describe("S3Storage::testConnection()", () => {
  it.each(cases.testConnection.map((c) => c.name))("%s", async (name) => {
    const c = cases.testConnection.find((x) => x.name === name)!;
    const g = goldens.testConnection.find((x) => x.name === name)!;
    const s = c.storage;
    // The model's mutators: endpoint, bucket and region trimmed; key and secret as given.
    const endpoint = s.endpoint.trim() === "" ? null : s.endpoint.trim().replace("localhost", PUBLIC_HOST);
    const seen: string[] = [];
    let error: string | null = null;
    let usePath = s.use_path_style_endpoint;
    try {
      usePath = (await testS3Connection({ endpoint, bucket: s.bucket.trim(), region: s.region.trim(), key: s.key, secret: s.secret, usePathStyleEndpoint: s.use_path_style_endpoint }, resolver, { http: fakeS3(seen), sleep: noSleep })).usePathStyleEndpoint;
    } catch (e) {
      error = (e as Error).message;
    }
    expect(error).toBe(g.error === null ? null : freeploy(g.error).replaceAll("localhost", PUBLIC_HOST));
    expect(error === null).toBe(g.isUsable);
    expect(usePath).toBe(g.usesPathStyleEndpoint);
    expect(seen.map((u) => { const x = new URL(u); return [x.host, x.pathname + x.search]; })).toEqual(g.requests.map((r) => [r.host.replace("localhost", PUBLIC_HOST), r.uri]));
  });
  it("a timeout reads as Coolify's 15 seconds message", async () => {
    const http: S3Http = async (url) => {
      throw new Error(`Request timed out after 15 seconds for ${url}`);
    };
    await expect(testS3Connection({ endpoint: "https://s3.example.com", bucket: "bkt", region: "us-east-1", key: "k", secret: "s", usePathStyleEndpoint: true }, resolver, { http, sleep: noSleep })).rejects.toThrow(
      "Could not connect to the S3 endpoint within 15 seconds. Please verify the endpoint, bucket, credentials, region, and network/firewall settings.",
    );
  });
  it("detectPathStyleEndpoint(): virtual-hosted style for the providers that reject path-style URLs", () => {
    expect(["https://oss-cn-hangzhou.aliyuncs.com", "https://cos.ap-guangzhou.myqcloud.com", "https://tos-cn-beijing.volces.com", "https://x.bytepluses.com", "https://s3.amazonaws.com", "https://myqcloud.com.evil.com", null].map(detectPathStyleEndpoint)).toEqual([
      false, false, false, false, true, true, true,
    ]);
  });
});

describe("the forms' validation (Create and Form)", () => {
  it.each(goldens.validation.map((g, i) => [i, g.form, JSON.stringify(g.input).slice(0, 60)] as const))("#%i %s %s", async (i) => {
    const g = goldens.validation[i]!;
    const input = { ...cases.validationBase[g.form], ...g.input };
    const expected = Array.isArray(g.errors) ? {} : Object.fromEntries(Object.entries(g.errors).map(([f, ms]) => [f, ms.map(freeploy)]));
    if (g.form === "create") {
      expect(normalizeEndpoint(String(input.endpoint ?? ""))).toBe(g.endpoint);
      const r = await validateCreateStorage(input, resolver);
      expect(r.ok ? {} : r.errors).toEqual(expected);
    } else {
      const r = await validateUpdateStorage(input, { endpoint: input.savedEndpoint as string, hasSavedSecret: input.hasSavedSecret as boolean }, resolver);
      expect(r.ok ? {} : r.errors).toEqual(expected);
    }
  });
  it("FILTER_VALIDATE_URL, the address classes and the bucket rule on their own", () => {
    expect(["https://a.b", "https://[::1]:9000/x", "http://a-b.c/x?y#z", "https://a_b.c", "https://-a.c", "https://", "s3.example.com", "https://a b"].map(filterValidateUrl)).toEqual([true, true, true, false, false, false, false, false]);
    expect(["8.8.8.8", "10.1.2.3", "172.31.0.1", "172.32.0.1", "169.254.1.1", "::ffff:169.254.1.1", "2001:db8::1", "2606:4700::1111", "fe80::1", "01.2.3.4"].map(classifyIp)).toEqual([
      "public", "private", "private", "public", "link-local", "link-local", "private", "public", "link-local", null,
    ]);
    expect(["abc", "Backups", "a.b.c", "1.2.3.4", "999.1.1.1", "a..b", "ab"].map(validS3BucketName)).toEqual([true, true, true, false, true, false, false]);
  });
});

// ------------------------------------------------------------ the handlers

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy/storages`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

class MemoryStore implements S3StorageStore {
  rows: DeployS3StorageWithSecretRow[] = [];
  backups: Array<DeployStorageBackupRow & { storageIds: string[] }> = [];
  private next = 1;
  private strip(r: DeployS3StorageWithSecretRow): DeployS3StorageRow {
    const rest: Partial<DeployS3StorageWithSecretRow> = { ...r };
    delete rest.key;
    delete rest.secret;
    return rest as DeployS3StorageRow;
  }
  async list() {
    return [...this.rows].sort((a, b) => a.name.localeCompare(b.name)).map((r) => this.strip(r));
  }
  async findByUuid(uuid: string) {
    return this.rows.find((r) => r.uuid === uuid) ?? null;
  }
  async insert(s: Parameters<S3StorageStore["insert"]>[0]) {
    const row: DeployS3StorageWithSecretRow = {
      id: this.next++, uuid: s.uuid, type: s.type, name: s.name ?? "", description: s.description, region: s.region, bucket: s.bucket, endpoint: s.endpoint,
      is_usable: s.isUsable, unusable_email_sent: s.unusableEmailSent, use_path_style_endpoint: s.usePathStyleEndpoint, skip_tls_verification: s.skipTlsVerification,
      created_at: null, updated_at: null, key: s.key, secret: s.secret,
    };
    this.rows.push(row);
    return this.strip(row);
  }
  async update(id: string | number, f: S3StorageFields) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, { name: f.name, description: f.description, region: f.region, key: f.key, secret: f.secret, bucket: f.bucket, endpoint: f.endpoint, use_path_style_endpoint: f.usePathStyleEndpoint, skip_tls_verification: f.skipTlsVerification, is_usable: f.isUsable, unusable_email_sent: f.unusableEmailSent });
    return this.strip(row);
  }
  async setUsable(id: string | number, isUsable: boolean, sent: boolean) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return false;
    Object.assign(row, { is_usable: isUsable, unusable_email_sent: sent });
    return true;
  }
  async backupCount(id: string | number) {
    return this.backups.filter((b) => b.storageIds.includes(String(id))).length;
  }
  async delete(id: string | number) {
    for (const b of this.backups) {
      b.storageIds = b.storageIds.filter((s) => s !== String(id));
      if (!b.storageIds.length) b.save_s3 = false;
    }
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    return this.rows.length < before;
  }
  async listBackups(id: string | number) {
    return this.backups.filter((b) => b.save_s3 && b.storageIds.includes(String(id)));
  }
  async backupStorageIds(backupId: string | number) {
    return this.backups.find((b) => b.id === backupId)!.storageIds;
  }
  async syncBackupStorages(backupId: string | number, ids: string[]) {
    const b = this.backups.find((x) => x.id === backupId)!;
    b.storageIds = ids;
    return ids[0] ?? null;
  }
  async disableBackupS3(backupId: string | number) {
    this.backups.find((b) => b.id === backupId)!.save_s3 = false;
  }
}

const cipher: KeyCipher = {
  encrypt: async (p) => `enc:${p}`,
  decrypt: async (s) => {
    if (!s.startsWith("enc:")) throw new Error("not encrypted");
    return s.slice(4);
  },
};

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details: { fields?: Record<string, string[]>; title?: string } } };

function setup(opts: { write?: boolean; read?: boolean } = {}) {
  const store = new MemoryStore();
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : (opts.read ?? true);
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  };
  const columns: string[] = [];
  const runner: S3StorageRunner = async (_env, _orgId, fn) => fn({ store, cipher: (column) => (columns.push(column), cipher) });
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const s3 = { answer: fakeS3() };
  const http: S3Http = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return s3.answer(url, init);
  };
  const call = async (method: string, path = "", body?: unknown) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleS3Storages(env, "req_1", actor, ORG_UUID, path.split("/").filter(Boolean), new Request(`${BASE}${path ? `/${path}` : ""}`, init), runner, http, resolver);
    return { status: res.status, body: (await res.json()) as Body };
  };
  return { store, env, call, seen, s3, columns };
}

const NEW = { type: "s3", name: "Backups", description: "", endpoint: "s3.test.example", bucket: "ok-bucket", region: "us-east-1", key: " AKIDEXAMPLE ", secret: "secret", usePathStyleEndpoint: true, skipTlsVerification: false };

describe("POST /storages", () => {
  it("tests the connection with the form's values, then stores the storage usable, its key and secret encrypted and trimmed", async () => {
    const t = setup();
    const r = await t.call("POST", "", NEW);
    expect(r.status).toBe(201);
    const row = t.store.rows[0]!;
    expect(r.body.data).toEqual({ uuid: row.uuid });
    expect(row).toMatchObject({ name: "Backups", endpoint: "https://s3.test.example", bucket: "ok-bucket", region: "us-east-1", key: "enc:AKIDEXAMPLE", secret: "enc:secret", is_usable: true, use_path_style_endpoint: true, type: "s3" });
    expect(t.seen.map((s) => s.url)).toEqual(["https://s3.test.example/ok-bucket/?list-type=2&prefix=&delimiter=%2F"]);
    // Signed for the region with the key as typed (Coolify trims it when it saves).
    expect(t.seen[0]!.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential= AKIDEXAMPLE \/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(t.columns).toEqual(expect.arrayContaining(["s3_storages.key", "s3_storages.secret"]));
  });
  it("keeps the URL style that worked", async () => {
    const t = setup();
    expect((await t.call("POST", "", { ...NEW, bucket: "fallback-ok" })).status).toBe(201);
    expect(t.store.rows[0]!.use_path_style_endpoint).toBe(false);
  });
  it("stores nothing when the connection fails, and answers Coolify's toast", async () => {
    const t = setup();
    const r = await t.call("POST", "", { ...NEW, bucket: "denied" });
    expect(r.status).toBe(422);
    expect(r.body.error!.details.title).toBe("Failed to create storage.");
    expect(r.body.error!.message).toContain("InvalidAccessKeyId (client): The AWS Access Key Id you provided does not exist in our records.");
    expect(t.store.rows).toEqual([]);
  });
  it("validates before anything is asked", async () => {
    const t = setup();
    const r = await t.call("POST", "", { ...NEW, name: "", endpoint: "https://10.0.0.1", bucket: "" });
    expect(r.status).toBe(422);
    expect(r.body.error!.details.fields).toEqual({ name: ["The Name field is required."], endpoint: ["The endpoint points to a local or private address that is not allowed."], bucket: ["The Bucket field is required."] });
    expect(t.seen).toEqual([]);
  });
  it("SFTP, FTPS and WebDAV storages are not available yet", async () => {
    const t = setup();
    const r = await t.call("POST", "", { ...NEW, type: "sftp" });
    expect([r.status, r.body.error!.message]).toEqual([501, "SFTP storages are not available yet."]);
  });
  it("needs deploy.resource.write; a denial answers 404", async () => {
    const t = setup({ write: false });
    expect((await t.call("POST", "", NEW)).status).toBe(404);
    expect(t.store.rows).toEqual([]);
  });
});

async function withStorage(opts: { write?: boolean; read?: boolean } = {}) {
  const t = setup(opts);
  await t.store.insert({
    uuid: "stor1", type: "s3", name: "Main", description: null, region: "us-east-1", key: "enc:AKID", secret: "enc:shh", bucket: "ok-bucket", endpoint: "https://s3.test.example",
    usePathStyleEndpoint: true, skipTlsVerification: false, isUsable: false, unusableEmailSent: false,
  });
  t.seen.length = 0;
  return t;
}

describe("GET /storages and /storages/{uuid}", () => {
  it("lists by name; shows the key only to who may update, never the secret", async () => {
    const t = await withStorage();
    const list = await t.call("GET");
    expect(list.body.data).toEqual({ storages: [{ uuid: "stor1", name: "Main", description: null, type: "s3", typeLabel: "S3", isUsable: false }], canCreate: true });
    const show = await t.call("GET", "stor1");
    expect(show.body.data!.storage).toMatchObject({ key: "AKID", hasSavedSecret: true, isPasswordHiddenForMember: false, backupCount: 0, usePathStyleEndpointChosen: false });
    expect(JSON.stringify(show.body)).not.toContain("shh");
    const reader = await withStorage({ write: false });
    const shown = await reader.call("GET", "stor1");
    expect(shown.body.data).toMatchObject({ canUpdate: false, storage: { key: "", hasSavedSecret: false, isPasswordHiddenForMember: true } });
    expect((await t.call("GET", "nope")).status).toBe(404);
    expect((await setup({ read: false }).call("GET")).status).toBe(404);
  });
});

describe("PATCH /storages/{uuid}", () => {
  const form = { name: "Main 2", description: "eu", endpoint: "https://s3.test.example", bucket: "ok-bucket", region: "eu-west-1", key: "AKID2", secret: "", usePathStyleEndpoint: true, skipTlsVerification: false, isUsable: false };
  it("keeps the saved secret when the form leaves it empty, tests, then stores usable", async () => {
    const t = await withStorage();
    const r = await t.call("PATCH", "stor1", form);
    expect(r.status).toBe(200);
    expect(r.body.data!.message).toBe("Storage settings updated and connection verified.");
    expect(t.store.rows[0]).toMatchObject({ name: "Main 2", region: "eu-west-1", key: "enc:AKID2", secret: "enc:shh", is_usable: true });
    expect(t.seen[0]!.headers.authorization).toContain("Credential=AKID2/");
    expect(t.seen[0]!.headers.authorization).toContain("/eu-west-1/s3/aws4_request");
  });
  it("stores nothing when the test fails", async () => {
    const t = await withStorage();
    const r = await t.call("PATCH", "stor1", { ...form, bucket: "nobucket" });
    expect([r.status, r.body.error!.message.endsWith("NoSuchBucket (client): The specified bucket does not exist")]).toEqual([422, true]);
    expect(t.store.rows[0]).toMatchObject({ name: "Main", region: "us-east-1", is_usable: false });
  });
  it("answers the form's errors", async () => {
    const t = await withStorage();
    const r = await t.call("PATCH", "stor1", { ...form, key: "", region: "" });
    expect(r.body.error!.details.fields).toEqual({ region: ["The Region field is required."], key: ["The Access Key field is required."] });
  });
});

describe("POST /storages/{uuid}/validate", () => {
  it("tests the form's values and stores only the status", async () => {
    const t = await withStorage();
    const ok = await t.call("POST", "stor1/validate", { bucket: "fallback-ok", usePathStyleEndpoint: true });
    expect(ok.body.data).toEqual({ valid: true, title: "Connection is working.", message: 'The provider rejects path-style URLs, so "Use path-style URLs" is now off. Save to keep it.', usePathStyleEndpoint: false, isUsable: true });
    expect(t.store.rows[0]).toMatchObject({ bucket: "ok-bucket", use_path_style_endpoint: true, is_usable: true });
    const plain = await t.call("POST", "stor1/validate", {});
    expect(plain.body.data).toMatchObject({ valid: true, message: 'Tested with "ListObjectsV2" action.' });
    const bad = await t.call("POST", "stor1/validate", { bucket: "denied" });
    expect(bad.body.data).toMatchObject({ valid: false, title: "Failed to test connection.", isUsable: false });
    expect(t.store.rows[0]!.is_usable).toBe(false);
    expect((await (await withStorage({ write: false })).call("POST", "stor1/validate", {})).status).toBe(404);
  });
});

describe("DELETE /storages/{uuid} and the Resources tab", () => {
  function backup(id: number, uuid: string, storageIds: string[]): DeployStorageBackupRow & { storageIds: string[] } {
    return { id, uuid, frequency: "daily", enabled: true, save_s3: true, s3_storage_id: storageIds[0] ?? null, database_type: "App\\Models\\StandalonePostgresql", database_id: 1, database_uuid: "pg1", database_name: "postgresql-database-pg1", environment_uuid: "env1", project_uuid: "prj1", storageIds };
  }
  it("lists, moves and removes the schedules that use the storage", async () => {
    const t = await withStorage();
    await t.store.insert({ uuid: "stor2", type: "s3", name: "Other", description: null, region: "us-east-1", key: "enc:k", secret: "enc:s", bucket: "b", endpoint: "https://e.example", usePathStyleEndpoint: true, skipTlsVerification: false, isUsable: true, unusableEmailSent: false });
    t.store.backups.push(backup(10, "bk-a", ["1"]), backup(11, "bk-b", ["1", "2"]));
    const res = await t.call("GET", "stor1/resources");
    expect(res.body.data).toMatchObject({ backups: [{ uuid: "bk-a", frequency: "daily", enabled: true, database: { uuid: "pg1", projectUuid: "prj1", environmentUuid: "env1" } }, { uuid: "bk-b" }], storages: [{ uuid: "stor1" }, { uuid: "stor2" }] });
    expect((await t.call("POST", "stor1/resources/bk-a/move", { storage_uuid: "stor1" })).body.error).toMatchObject({ message: "The backup is already using this storage.", details: { title: "No change." } });
    expect((await t.call("POST", "stor1/resources/bk-a/move", { storage_uuid: "zzz" })).body.error!.message).toBe("Storage not found.");
    expect((await t.call("POST", "stor1/resources/bk-a/move", { storage_uuid: "stor2" })).body.data).toEqual({ title: "Backup moved.", message: "Moved to Other." });
    expect(t.store.backups[0]!.storageIds).toEqual(["2"]);
    expect((await t.call("DELETE", "stor1/resources/bk-b")).body.data).toEqual({ title: "Storage removed.", message: "This storage was removed from the schedule destinations." });
    t.store.backups.push(backup(12, "bk-c", ["1"]));
    expect((await t.call("DELETE", "stor1/resources/bk-c")).body.data).toEqual({ title: "Storage removed.", message: "S3 backup has been disabled for this schedule." });
    expect(t.store.backups[2]!.save_s3).toBe(false);
    expect((await t.call("DELETE", "stor1/resources/bk-c")).status).toBe(404);
  });
  it("deletes the storage; its schedules let it go", async () => {
    const t = await withStorage();
    t.store.backups.push(backup(10, "bk-a", ["1"]));
    expect((await t.call("GET", "stor1")).body.data!.storage).toMatchObject({ backupCount: 1 });
    expect((await t.call("DELETE", "stor1")).body.data).toEqual({ deleted: true });
    expect(t.store.rows).toEqual([]);
    expect(t.store.backups[0]).toMatchObject({ save_s3: false, storageIds: [] });
    expect((await t.call("DELETE", "stor1")).status).toBe(404);
  });
});

describe("routing", () => {
  it("reaches the storages through the router, and refuses unknown paths and methods", async () => {
    const t = setup({ read: false });
    const res = await route(new Request(`${BASE}`, { headers: { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" } }), t.env);
    expect(res.status).toBe(404);
    expect(((await res.json()) as Body).error!.code).toBe("not_found");
    expect((await route(new Request(BASE), t.env)).status).toBe(401);
    expect((await t.call("PUT", "stor1")).status).toBe(405);
    expect((await t.call("GET", "stor1/nothing")).status).toBe(404);
  });
});
