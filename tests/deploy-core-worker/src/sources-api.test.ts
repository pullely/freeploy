// Integrations → Git sources (DP-72) through /v1/organizations/{org}/deploy/sources: a GitHub App's creation,
// its page and actions, GitHub's two redirects (the manifest's code, the installation) against a fake GitHub that
// checks the App's JWT, the repositories and branches of the private repository flow, the authorization — and
// the two private repository creations (with a GitHub App, with a deploy key), field by field against
// GithubPrivateRepository::submit and GithubPrivateRepositoryDeployKey::submit. The SQL is tested in tests/db.
import type { Env } from "@deploy-core-worker/env";
import { handleSources, type SourceRunner } from "@deploy-core-worker/handlers/sources";
import type { SourceStore } from "@deploy-core-worker/sources/service";
import { readSetupState } from "@deploy-core-worker/sources/setup-state";
import type { SourceHttp } from "@deploy-core-worker/sources/github";
import { createDeployKeyApplication, createGithubAppApplication, deployKeyGitSource } from "@deploy-core-worker/sources/private-repository";
import type { BuildingContext } from "@deploy-core-worker/applications/create";
import type { DeployGithubAppRow, DeploySourceApplicationRow, NewBuiltApplication } from "@saas/db/deploy";
import { sourceCases } from "./source-goldens";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const SECRET = "the-deployment-encryption-key";
const actor = { subjectId: "usr_1", subjectType: "user" };
const APP_KEY = String(sourceCases.functions.find((f) => f.id === "jwt.pkcs1")!.args.privateKey);
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const fetcher = (handler: (req: Request) => Promise<Response> | Response): Fetcher => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) }) as unknown as Fetcher;

/** The org's GitHub Apps and private keys, in memory; "encryption" marks a value with its column. */
class Store implements SourceStore {
  apps: DeployGithubAppRow[] = [];
  keys: Array<{ id: number; uuid: string; name: string; private_key: string; fingerprint: string | null }> = [];
  private next = 1;
  async list() {
    return this.apps.filter((a) => !a.is_public).map((a) => ({ kind: "github" as const, uuid: a.uuid, name: a.name, account: a.installation_account ?? a.organization, connected: a.app_id !== null && a.installation_id !== null, html_url: a.html_url, registered: a.app_id !== null }));
  }
  async findByUuid(uuid: string) {
    return this.apps.find((a) => a.uuid === uuid) ?? null;
  }
  async findById(id: string | number) {
    return this.apps.find((a) => a.id === id) ?? null;
  }
  async insert(app: Parameters<SourceStore["insert"]>[0]) {
    const row = {
      id: this.next++, uuid: app.uuid, name: app.name, organization: app.organization, api_url: app.apiUrl, html_url: app.htmlUrl, custom_user: app.customUser, custom_port: app.customPort,
      app_id: null, installation_id: null, installation_account: null, client_id: null, client_secret: null, webhook_secret: null, is_system_wide: app.isSystemWide, is_public: false,
      private_key_id: null, contents: null, metadata: null, pull_requests: null, administration: null, deployments: null, organization_self_hosted_runners: null, actions: null,
      webhook_events: null, runner_group_id: null, created_at: null, updated_at: null,
    } as DeployGithubAppRow;
    this.apps.push(row);
    return row;
  }
  async replicate(id: string | number, uuid: string) {
    const from = this.apps.find((a) => a.id === id)!;
    const row = { ...from, id: this.next++, uuid, installation_id: null, installation_account: null, deployments: null, runner_group_id: null };
    this.apps.push(row);
    return row;
  }
  async update(id: string | number, changes: Record<string, unknown>) {
    const row = this.apps.find((a) => a.id === id);
    if (!row) return null;
    Object.assign(row, changes);
    return row;
  }
  async delete(id: string | number) {
    const before = this.apps.length;
    this.apps = this.apps.filter((a) => a.id !== id);
    return this.apps.length < before;
  }
  async findInstallation(apiUrl: string, appId: number | string, installationId: number | string) {
    return this.apps.find((a) => a.api_url === apiUrl && String(a.app_id) === String(appId) && String(a.installation_id) === String(installationId)) ?? null;
  }
  async findByInstallationId(installationId: number | string) {
    return this.apps.find((a) => String(a.installation_id) === String(installationId)) ?? null;
  }
  async privateKey(id: string | number | null) {
    return id === null ? null : (this.keys.find((k) => k.id === Number(id)) ?? null);
  }
  async privateKeys() {
    return this.keys.map((k) => ({ id: k.id, uuid: k.uuid, name: k.name }));
  }
  async insertPrivateKey(key: { uuid: string; name: string; privateKey: string; fingerprint: string | null }) {
    const row = { id: 100 + this.keys.length, uuid: key.uuid, name: key.name, private_key: key.privateKey, fingerprint: key.fingerprint };
    this.keys.push(row);
    return { id: row.id };
  }
  async fingerprintExists(fingerprint: string | null) {
    return this.keys.some((k) => k.fingerprint !== null && k.fingerprint === fingerprint);
  }
  async renamePrivateKey(id: string | number, name: string) {
    this.keys.find((k) => k.id === Number(id))!.name = name;
  }
  async privateKeyUsedElsewhere() {
    return false;
  }
  async deletePrivateKey(id: string | number) {
    this.keys = this.keys.filter((k) => k.id !== Number(id));
  }
  /** The applications whose source is this App. */
  using: DeploySourceApplicationRow[] = [];
  async applications() {
    return this.using;
  }
}

/** A GitHub that checks the App's JWT and answers what the test scripts. */
function fakeGithub(routes: Record<string, (req: { method: string; url: string; auth: string; body: unknown }) => Response>) {
  const requests: Array<{ method: string; url: string; auth: string }> = [];
  const http: SourceHttp = {
    now: () => new Date("2026-11-20T10:11:12Z"),
    sleep: async () => undefined,
    fetch: async (url, init) => {
      const auth = init.headers.Authorization ?? "";
      requests.push({ method: init.method, url, auth });
      for (const [pattern, answer] of Object.entries(routes)) {
        if (new RegExp(pattern).test(`${init.method} ${url}`)) return answer({ method: init.method, url, auth, body: init.body ? JSON.parse(init.body) : null });
      }
      return json({ message: "Not Found" }, 404);
    },
  };
  return { http, requests };
}

/** The claims of a JWT GitHub was sent. */
const claims = (auth: string): Record<string, unknown> => JSON.parse(Buffer.from(auth.replace(/^Bearer /, "").split(".")[1]!, "base64url").toString()) as Record<string, unknown>;

function setup(opts: { write?: boolean; github?: SourceHttp } = {}) {
  const store = new Store();
  const env: Env = {
    ENVIRONMENT: "test",
    DEPLOY_ENCRYPTION_KEY: SECRET,
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : true;
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  };
  const runner: SourceRunner = async (_env, _orgId, org, http, fn) =>
    fn({
      store: bind(store),
      cipher: (column) => ({ encrypt: async (plain) => `enc:${column}:${plain}`, decrypt: async (stored) => stored.replace(`enc:${column}:`, "") }),
      http,
      org,
      stateSecret: SECRET,
      resolve: async () => ["140.82.112.3"],
    });
  const http = opts.github ?? fakeGithub({}).http;
  const call = async (method: string, path = "", body?: unknown) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const segments = path.split("?")[0]!.split("/").filter(Boolean);
    const res = await handleSources(env, "req_1", actor, ORG_UUID, ORG, segments, new Request(`https://x/v1/organizations/${ORG}/deploy/sources${path ? `/${path}` : ""}`, init), { runner, http, resolve: async () => ["140.82.112.3"] });
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; error?: { message: string; details: { fields?: Record<string, string[]>; redirect?: string } } } };
  };
  return { store, call };
}

/** The store's methods bound to it (the runner hands a plain object). */
function bind(store: Store): SourceStore {
  const out: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(Store.prototype)) if (name !== "constructor") out[name] = (store as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!.bind(store);
  return out as unknown as SourceStore;
}

const createForm = (over: Record<string, unknown> = {}) => ({ name: "freeploy-app", organization: null, html_url: "https://github.com", api_url: "https://api.github.com", custom_user: "git", custom_port: 22, ...over });

describe("the Sources page and Create", () => {
  it("lists the org's sources, and offers Create's default name", async () => {
    const t = setup();
    let r = await t.call("GET");
    expect(r.status).toBe(200);
    expect(r.body.data!.sources).toEqual([]);
    expect(String(r.body.data!.defaultName).length).toBeLessThanOrEqual(30);
    await t.call("POST", "", createForm());
    r = await t.call("GET");
    expect(r.body.data!.sources).toEqual([{ kind: "github", uuid: expect.any(String), name: "freeploy-app", provider: "GitHub", account: null, connected: false, htmlUrl: "https://github.com", registered: false }]);
  });

  it("creates a GitHub App with Create's rules, normalizing the organization", async () => {
    const t = setup();
    const r = await t.call("POST", "", createForm({ organization: " /acme/ " }));
    expect(r.status).toBe(201);
    expect(r.body.data).toEqual({ uuid: expect.stringMatching(/^[a-z0-9]{24}$/), previews: true });
    expect(t.store.apps[0]).toMatchObject({ name: "freeploy-app", organization: "acme", api_url: "https://api.github.com", html_url: "https://github.com", custom_user: "git", custom_port: 22, is_system_wide: false });
  });

  it("derives the API URL from the HTML URL when it is empty", async () => {
    const t = setup();
    await t.call("POST", "", createForm({ html_url: "https://acme.ghe.com", api_url: "" }));
    expect(t.store.apps[0]!.api_url).toBe("https://api.acme.ghe.com");
  });

  it("answers Laravel's messages", async () => {
    const t = setup();
    const r = await t.call("POST", "", createForm({ name: "", organization: "acme inc", api_url: "not a url", custom_port: "22a", custom_user: "" }));
    expect(r.status).toBe(422);
    expect(r.body.error!.details.fields).toEqual({
      name: ["The name field is required."],
      organization: ["The organization field format is invalid."],
      api_url: ["The api url field must be a valid URL.", "The api url must be a valid URL."],
      custom_user: ["The custom user field is required."],
      custom_port: ["The custom port field must be an integer."],
    });
  });

  it("refuses a private network address, as Coolify Cloud does", async () => {
    const t = setup();
    const r = await t.call("POST", "", createForm({ html_url: "https://10.0.0.5", api_url: "https://10.0.0.5/api/v3" }));
    expect(r.body.error!.details.fields!.html_url).toEqual(["The html_url points to a local or private address that is not allowed."]);
  });

  it("refuses a system-wide source: no org may share one", async () => {
    const t = setup();
    expect((await t.call("POST", "", createForm({ is_system_wide: true }))).status).toBe(403);
    expect(t.store.apps).toEqual([]);
  });

  it("is write-only for changes: a builder reads the list and the page, and gets 404 for the rest", async () => {
    const t = setup({ write: false });
    expect((await t.call("GET")).status).toBe(200);
    expect((await t.call("POST", "", createForm())).status).toBe(404);
  });
});

describe("a GitHub App's page", () => {
  async function created(t: ReturnType<typeof setup>) {
    const r = await t.call("POST", "", createForm({ name: "My App" }));
    return String(r.body.data!.uuid);
  }

  it("shows the form, the kebab name, the manifest state and the URLs of its buttons", async () => {
    const t = setup();
    const uuid = await created(t);
    const r = await t.call("GET", `github/${uuid}`);
    expect(r.body.data).toMatchObject({ uuid, name: "my-app", storedName: "My App", isConnected: false, appId: null, installationUrl: null, settingsUrl: "https://github.com/settings/apps/My%20App", permissionsUrl: "https://github.com/settings/apps/my-app/permissions", canUpdate: true });
    const state = await readSetupState(SECRET, r.body.data!.manifestState, "manifest");
    expect(state).toMatchObject({ action: "manifest", app: uuid, org: ORG });
    expect(await readSetupState(SECRET, r.body.data!.manifestState, "install")).toBeNull();
    expect(await readSetupState("another-key", r.body.data!.manifestState, "manifest")).toBeNull();
  });

  it("shows no secret and no state to who may not update", async () => {
    const t = setup();
    const uuid = await created(t);
    t.store.apps[0]!.client_secret = "enc:github_apps.client_secret:s3cret";
    const reader = setup({ write: false });
    reader.store.apps.push(...t.store.apps);
    const r = await reader.call("GET", `github/${uuid}`);
    expect(r.body.data).toMatchObject({ clientSecret: null, webhookSecret: null, manifestState: null, canUpdate: false });
  });

  it("continues manually with placeholder ids, then saves the form with Change's rules", async () => {
    const t = setup();
    const uuid = await created(t);
    expect((await t.call("POST", `github/${uuid}/manual`)).body.data).toEqual({ message: "Github App updated. You can now configure the details." });
    expect(t.store.apps[0]).toMatchObject({ app_id: 1234567890, installation_id: 1234567890 });
    let r = await t.call("PATCH", `github/${uuid}`, { appId: "abc", customPort: "", privateKeyId: 999 });
    expect(r.body.error!.details.fields).toEqual({ customPort: ["The custom port field is required."], appId: ["The app id field must be an integer."], privateKeyId: ["The selected private key id is invalid."] });
    r = await t.call("PATCH", `github/${uuid}`, { appId: 4242, installationId: 777, clientId: "Iv1.x", clientSecret: "s3cret", webhookSecret: "hook-secret", organization: "/acme/" });
    expect(r.body.data).toMatchObject({ message: "Github App updated." });
    expect(t.store.apps[0]).toMatchObject({ app_id: 4242, installation_id: 777, client_id: "Iv1.x", client_secret: "enc:github_apps.client_secret:s3cret", webhook_secret: "enc:github_apps.webhook_secret:hook-secret", organization: "acme", name: "my-app" });
  });

  it("refuses to delete a source an application uses, and deletes its key with it otherwise", async () => {
    const t = setup();
    const uuid = await created(t);
    t.store.keys.push({ id: 100, uuid: "k1", name: "github-app-x", private_key: "enc", fingerprint: null });
    t.store.apps[0]!.private_key_id = 100;
    t.store.using = [{ id: 1, uuid: "app1", name: "web", project_uuid: "p", project_name: "P", environment_uuid: "e", environment_name: "E", fqdn: null, status: "exited", git_repository: "acme/web", git_branch: "main" }];
    expect((await t.call("DELETE", `github/${uuid}`)).body.error!.message).toBe("This source is being used by an application. Please delete all applications first.");
    expect(t.store.apps).toHaveLength(1);
    t.store.using = [];
    expect((await t.call("DELETE", `github/${uuid}`)).body.data).toEqual({ deleted: true, redirect: "/sources" });
    expect(t.store.apps).toEqual([]);
    expect(t.store.keys).toEqual([]);
  });
});

describe("GitHub's redirects: the manifest's code and the installation", () => {
  const conversion = { id: 4242, slug: "freeploy-acme", client_id: "Iv1.abc", client_secret: "cs", pem: APP_KEY, webhook_secret: "whs", owner: { login: "someone", type: "User" } };

  async function registered(github: ReturnType<typeof fakeGithub>) {
    const t = setup({ github: github.http });
    const uuid = String((await t.call("POST", "", createForm({ organization: "acme" }))).body.data!.uuid);
    const page = await t.call("GET", `github/${uuid}`);
    return { t, uuid, state: String(page.body.data!.manifestState) };
  }

  it("exchanges the code, stores the key as a PrivateKey and the credentials, and warns when GitHub chose another owner", async () => {
    const github = fakeGithub({ "^POST https://api\\.github\\.com/app-manifests/code-123/conversions$": () => json(conversion, 201) });
    const { t, uuid, state } = await registered(github);
    const r = await t.call("POST", "github/redirect", { code: "code-123", state });
    expect(r.status).toBe(200);
    expect(r.body.data!.redirect).toBe(`/source/github/${uuid}`);
    expect(r.body.data!.error).toBe(
      "GitHub registered this GitHub App on your personal account someone, not on the organization acme. It can only be installed on someone. Make sure that your GitHub user is an owner or a GitHub App manager of acme, then delete this GitHub App on GitHub and in Freeploy, and create it again.",
    );
    expect(t.store.keys).toEqual([expect.objectContaining({ name: "github-app-freeploy-acme", private_key: `enc:private_keys.private_key:${APP_KEY.trim()}\n` })]);
    expect(t.store.apps[0]).toMatchObject({ name: "freeploy-acme", app_id: 4242, client_id: "Iv1.abc", client_secret: "enc:github_apps.client_secret:cs", webhook_secret: "enc:github_apps.webhook_secret:whs", private_key_id: 100, organization: null });
    // A second redirect with the same state finds the credentials set.
    expect((await t.call("POST", "github/redirect", { code: "code-123", state })).status).toBe(403);
  });

  it("refuses a missing code, a state that is not valid or names another org, and an incomplete answer", async () => {
    const github = fakeGithub({ "conversions$": () => json({ id: 1, slug: "x" }, 201) });
    const { t, state } = await registered(github);
    expect((await t.call("POST", "github/redirect", { state })).body.error!.message).toBe("Missing GitHub App manifest code.");
    const bad = await t.call("POST", "github/redirect", { code: "c", state: state.slice(0, -2) + "xx" });
    expect([bad.status, bad.body.error!.details.redirect]).toEqual([404, "/sources"]);
    const incomplete = await t.call("POST", "github/redirect", { code: "c", state });
    expect([incomplete.status, incomplete.body.error!.message]).toEqual([422, "GitHub App manifest conversion response is incomplete."]);
  });

  it("verifies an installation with the App's JWT before it stores it", async () => {
    const github = fakeGithub({
      "^POST .*/conversions$": () => json({ ...conversion, owner: { login: "acme", type: "Organization" } }, 201),
      "^GET https://api\\.github\\.com/app/installations/555$": () => json({ id: 555, app_id: 4242, account: { login: "acme", id: 9 }, permissions: { deployments: "write" } }),
      "^GET https://api\\.github\\.com/app/installations/556$": () => json({ id: 556, app_id: 1, account: { login: "evil" } }),
    });
    const { t, uuid, state } = await registered(github);
    await t.call("POST", "github/redirect", { code: "c", state });
    const page = await t.call("GET", `github/${uuid}`);
    const installState = new URL(String(page.body.data!.installationUrl)).searchParams.get("state");
    expect(String(page.body.data!.installationUrl)).toMatch(/^https:\/\/github\.com\/apps\/freeploy-acme\/installations\/new\?state=/);
    let r = await t.call("POST", "github/install", { installation_id: "556", setup_action: "install", state: installState });
    expect(r.body.data!.error).toBe("GitHub App installation could not be verified: The installation belongs to a different GitHub App.");
    expect(t.store.apps[0]!.installation_id).toBeNull();
    r = await t.call("POST", "github/install", { installation_id: "555", setup_action: "install", state: installState });
    expect(r.body.data).toEqual({ redirect: `/source/github/${uuid}`, error: null, success: null });
    expect(t.store.apps[0]).toMatchObject({ installation_id: 555, installation_account: "acme", deployments: "write" });
    const jwt = github.requests.find((q) => q.url.endsWith("/app/installations/555"))!.auth;
    expect(claims(jwt)).toEqual({ iss: "4242", iat: 1795169412, exp: 1795169952 });
  });

  it("an installation on another account becomes a new source, when the first one still exists", async () => {
    const github = fakeGithub({
      "conversions$": () => json({ ...conversion, owner: { login: "acme", type: "Organization" } }, 201),
      "/app/installations/555$": () => json({ id: 555, app_id: 4242, account: { login: "acme", id: 9 } }),
      "/app/installations/777$": () => json({ id: 777, app_id: 4242, account: { login: "other", id: 10 } }),
    });
    const { t, uuid, state } = await registered(github);
    await t.call("POST", "github/redirect", { code: "c", state });
    t.store.apps[0]!.installation_id = 555;
    const install = String((await t.call("GET", `github/${uuid}`)).body.data!.installationUrl);
    const r = await t.call("POST", "github/install", { installation_id: "777", setup_action: "install", state: new URL(install).searchParams.get("state") });
    expect(r.body.data!.success).toBe("Added a new source for this installation. Each account that installs the GitHub App has its own source.");
    expect(t.store.apps.map((a) => a.installation_id)).toEqual([555, 777]);
    expect(t.store.apps[1]!.installation_account).toBe("other");
  });

  it("checks the setup action and the installation id first; an update goes to the source of that installation", async () => {
    const t = setup();
    expect((await t.call("POST", "github/install", { installation_id: "1", setup_action: "remove" })).body.error!.message).toBe("Invalid GitHub App setup action.");
    expect((await t.call("POST", "github/install", { installation_id: "1a", setup_action: "install" })).body.error!.message).toBe("Missing GitHub App installation id.");
    expect((await t.call("POST", "github/install", { installation_id: "1", setup_action: "update" })).body.data!.redirect).toBe("/sources");
  });
});

describe("Check permissions, Test connection, Sync name", () => {
  async function connected(routes: Record<string, (req: { method: string; url: string; auth: string; body: unknown }) => Response>) {
    const github = fakeGithub(routes);
    const t = setup({ github: github.http });
    const uuid = String((await t.call("POST", "", createForm())).body.data!.uuid);
    t.store.keys.push({ id: 100, uuid: "k1", name: "github-app-old", private_key: `enc:private_keys.private_key:${APP_KEY}`, fingerprint: null });
    Object.assign(t.store.apps[0]!, { app_id: 4242, installation_id: 777, private_key_id: 100 });
    return { t, uuid, github };
  }

  it("Check permissions asks what the App requests and what the installation granted", async () => {
    const { t, uuid } = await connected({
      "GET https://api.github.com/app$": () => json({ slug: "renamed-app", permissions: { contents: "read", metadata: "read", pull_requests: "write" }, events: ["push", "pull_request"] }),
      "/app/installations/777$": () => json({ account: { login: "acme" }, permissions: { deployments: "write" } }),
    });
    expect((await t.call("POST", `github/${uuid}/permissions`)).body.data).toEqual({ message: "Github App permissions updated." });
    expect(t.store.apps[0]).toMatchObject({ name: "renamed-app", contents: "read", metadata: "read", pull_requests: "write", deployments: "write", installation_account: "acme", webhook_events: '["push","pull_request"]' });
    expect(t.store.keys[0]!.name).toBe("github-app-renamed-app");
  });

  it("Check permissions names what is missing", async () => {
    const t = setup();
    const uuid = String((await t.call("POST", "", createForm())).body.data!.uuid);
    expect((await t.call("POST", `github/${uuid}/permissions`)).body.error!.message).toBe("Cannot fetch permissions. Please set the following required fields first: App ID, Private Key");
  });

  it("Test connection authenticates as the App and asks for an installation token", async () => {
    const { t, uuid, github } = await connected({
      "GET https://api.github.com/app$": () => json({ name: "Freeploy Acme", slug: "freeploy-acme" }),
      "POST .*/app/installations/777/access_tokens$": () => json({ token: "ghs_x" }, 201),
    });
    expect((await t.call("POST", `github/${uuid}/test`)).body.data).toEqual({ message: "Connection successful! Authenticated as GitHub App: Freeploy Acme" });
    expect(github.requests.map((q) => `${q.method} ${q.url}`)).toEqual(["GET https://api.github.com/app", "POST https://api.github.com/app/installations/777/access_tokens"]);
  });

  it("Test connection says why GitHub refused", async () => {
    const { t, uuid } = await connected({ "GET https://api.github.com/app$": () => json({ message: "Bad credentials" }, 401) });
    expect((await t.call("POST", `github/${uuid}/test`)).body.error!.message).toBe("Connection failed: Bad credentials");
  });

  it("Sync name needs the App id and a key of the org", async () => {
    const { t, uuid } = await connected({ "GET https://api.github.com/app$": () => json({ slug: "synced" }) });
    expect((await t.call("POST", `github/${uuid}/sync-name`, { appId: null })).body.error!.message).toBe("App ID is required before synchronizing the GitHub App name.");
    expect((await t.call("POST", `github/${uuid}/sync-name`, { privateKeyId: 999 })).body.error!.message).toBe("No private key found for this GitHub App.");
    expect((await t.call("POST", `github/${uuid}/sync-name`, {})).body.data).toEqual({ message: "GitHub App name and private key name synchronized successfully.", kind: "success", name: "synced" });
  });

  it("an OpenSSH key is refused with Coolify's explanation", async () => {
    const { t, uuid } = await connected({});
    t.store.keys[0]!.private_key = "enc:private_keys.private_key:-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n";
    expect((await t.call("POST", `github/${uuid}/test`)).body.error!.message).toMatch(/^The selected private key format is not supported for GitHub Apps\./);
  });

  it("lists the installation's repositories by name, page after page, and a repository's branches, main first", async () => {
    const repos = Array.from({ length: 150 }, (_, i) => ({ id: i + 1, name: `repo-${String(149 - i).padStart(3, "0")}`, owner: { login: "acme" }, default_branch: "main" }));
    const { t, uuid } = await connected({
      "access_tokens$": () => json({ token: "ghs_x" }, 201),
      "/installation/repositories\\?per_page=100&page=1$": () => json({ total_count: 150, repositories: repos.slice(0, 100) }),
      "/installation/repositories\\?per_page=100&page=2$": () => json({ total_count: 150, repositories: repos.slice(100) }),
      "/repos/acme/repo-001/branches\\?per_page=100&page=1$": () => json([{ name: "dev" }, { name: "zeta" }, { name: "main" }, { name: "master" }]),
    });
    const r = await t.call("GET", `github/${uuid}/repositories`);
    expect(r.body.data!.total_count).toBe(150);
    expect((r.body.data!.repositories as Array<{ name: string }>).slice(0, 2).map((x) => x.name)).toEqual(["repo-000", "repo-001"]);
    const b = await t.call("GET", `github/${uuid}/repositories/acme/repo-001/branches?default_branch=dev`);
    expect(b.body.data).toEqual({ branches: ["main", "master", "dev", "zeta"], selected: "dev" });
  });

  it("a refusal to list the repositories is GitHub's message", async () => {
    const { t, uuid } = await connected({ "access_tokens$": () => json({ message: "Not Found" }, 404) });
    expect((await t.call("GET", `github/${uuid}/repositories`)).body.error!.message).toBe(
      "Failed to get installation token for freeploy-app with error: GitHub App installation 777 was not found. Install the GitHub App again or update its installation ID.",
    );
  });
});

// ── The private repositories of New Resource ────────────────────────────────────────────────────────────

function buildingContext() {
  const inserted: Array<Omit<NewBuiltApplication, "orgId">> = [];
  const ctx = {
    store: {
      findDestination: async (uuid: string) => (uuid === "dst1" ? { id: 200, uuid: "dst1", name: "coolify", network: "coolify", type: "standalone", server_id: 100, server_uuid: "srv1", server_name: "main", server_ip: "203.0.113.10" } : null),
      findServer: async () => ({ id: 100, uuid: "srv1", ip: "203.0.113.10", wildcard_domain: null, server_role: "both" }),
      findProject: async (uuid: string) => (uuid === "prj1" ? { id: 1, uuid: "prj1", name: "Shop" } : null),
      findEnvironment: async (_p: unknown, uuid: string) => (uuid === "env1" ? { id: 10, uuid: "env1", name: "production" } : null),
    },
    encrypt: async (column: string) => `fp1:${column}`,
    build: {
      store: {
        insert: async (a: Omit<NewBuiltApplication, "orgId">) => {
          inserted.push(a);
          return 1;
        },
        findGithubApp: async (uuid: string) => (uuid === "gha1" ? { id: 7, uuid: "gha1" } : null),
        findPrivateKey: async (uuid: string) => (uuid === "key1" ? { id: 42 } : null),
      },
      encryptVariable: async (plain: string) => `fp1:variable:${plain}`,
    },
  } as unknown as BuildingContext;
  return { ctx, inserted };
}

const where = { project_uuid: "prj1", environment_uuid: "env1", destination_uuid: "dst1" };

describe("Git Repository (with GitHub App)", () => {
  const form = (over: Record<string, unknown> = {}) => ({ ...where, github_app_uuid: "gha1", repository_id: 987654, repository_owner: "acme", repository_repo: "private-app", git_branch: "main", build_pack: "nixpacks", port: 3000, is_static: false, base_directory: "/", ...over });

  it("stores the application with the App as its source and the repository's id", async () => {
    const { ctx, inserted } = buildingContext();
    const created = await createGithubAppApplication(ctx, form());
    expect(created).toEqual({ uuid: expect.stringMatching(/^[a-z0-9]{24}$/), projectUuid: "prj1", environmentUuid: "env1" });
    expect(inserted[0]).toMatchObject({
      repositoryProjectId: 987654,
      gitRepository: "acme/private-app",
      gitBranch: "main",
      buildPack: "nixpacks",
      portsExposes: "3000",
      sourceId: 7,
      sourceType: "App\\Models\\GithubApp",
      isStatic: false,
      fqdn: expect.stringMatching(/^http:\/\/[a-z0-9]{24}\.203\.0\.113\.10\.sslip\.io$/),
    });
    expect(inserted[0]!.name).toBe(`private-app:main-${(created as { uuid: string }).uuid}`);
    expect(inserted[0]!.variables.map((v) => v.key)).toEqual(["NIXPACKS_NODE_VERSION", "NIXPACKS_NODE_VERSION"]);
  });

  it("refuses invalid repository data with Coolify's message, and an App that is not the org's", async () => {
    const { ctx } = buildingContext();
    await expect(createGithubAppApplication(ctx, form({ repository_owner: "acme inc" }))).rejects.toThrow("Invalid repository data: The selected repository owner field format is invalid.");
    await expect(createGithubAppApplication(ctx, form({ git_branch: "a..b" }))).rejects.toThrow("Invalid repository data: The selected branch name contains invalid patterns.");
    expect(await createGithubAppApplication(ctx, form({ github_app_uuid: "other" }))).toBeNull();
  });
});

describe("Private Git Repository (with Deploy Key)", () => {
  const form = (over: Record<string, unknown> = {}) => ({ ...where, private_key_uuid: "key1", repository_url: "git@github.com:acme/private-app.git", git_branch: "main", build_pack: "dockerfile", port: 3000, is_static: false, base_directory: "/", ...over });

  it("reads the repository as get_git_source() does", () => {
    expect(deployKeyGitSource("git@github.com:acme/app.git")).toEqual({ gitRepository: "git@github.com:acme/app.git", publicGithub: false });
    expect(deployKeyGitSource("ssh://git@git.example.com:2222/acme/app.git")).toEqual({ gitRepository: "ssh://git@git.example.com:2222/acme/app.git", publicGithub: false });
    expect(deployKeyGitSource("https://github.com/acme/app")).toEqual({ gitRepository: "acme/app", publicGithub: true });
    expect(deployKeyGitSource("https://gitlab.com/acme/app")).toEqual({ gitRepository: "git@gitlab.com:acme/app.git", publicGithub: false });
    expect(deployKeyGitSource("https://gitlab.com/acme/app.git")).toEqual({ gitRepository: "git@gitlab.com:acme/app.git", publicGithub: false });
  });

  it("stores the application with the deploy key, a random name and no repository id", async () => {
    const { ctx, inserted } = buildingContext();
    await createDeployKeyApplication(ctx, form());
    expect(inserted[0]).toMatchObject({ privateKeyId: 42, gitRepository: "git@github.com:acme/private-app.git", repositoryProjectId: null, sourceId: null, sourceType: null, healthCheckEnabled: false, buildPack: "dockerfile" });
    expect(inserted[0]!.name).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]{24}$/);
    await createDeployKeyApplication(ctx, form({ repository_url: "https://github.com/acme/private-app" }));
    expect(inserted[1]).toMatchObject({ gitRepository: "acme/private-app", sourceId: 0, sourceType: "App\\Models\\GithubApp" });
  });

  it("answers rules() with its attribute names, and 404 for a key that is not the org's", async () => {
    const { ctx } = buildingContext();
    expect(await createDeployKeyApplication(ctx, form({ repository_url: "", git_branch: "", port: "x", is_static: "maybe" }))).toEqual({
      errors: {
        repository_url: ["The Repository field is required."],
        git_branch: ["The Branch field is required."],
        port: ["The Port field must be a number."],
        is_static: ["The Is static field must be true or false."],
      },
    });
    expect(await createDeployKeyApplication(ctx, form({ private_key_uuid: "theirs" }))).toBeNull();
  });
});
