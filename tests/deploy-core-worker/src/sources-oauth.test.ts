// The two OAuth Git sources (DP-103) through /v1/organizations/{org}/deploy/sources/{gitlab|gitea}: Create's rules, the
// source's page (the secrets only for who may update), Change::submit's rules, messages and toasts, Test connection with
// the token's refresh, the OAuth redirect (the state, the code's exchange), delete, the repositories and branches of New
// Resource — against a fake GitLab / Gitea that records what it is asked — and the authorization: a denied read or write
// answers 404 and runs nothing. The SQL, with each org's rows kept to itself, is tested in tests/db.
import type { Env } from "@deploy-core-worker/env";
import { handleSources, type SourceRunner } from "@deploy-core-worker/handlers/sources";
import type { OauthSourceRunner } from "@deploy-core-worker/handlers/oauth-sources";
import { OAUTH_SOURCE_MESSAGES, type OauthSourceStore } from "@deploy-core-worker/sources/oauth-sources";
import { apiUrlBase, allowsRepositoryOwner, refreshOauthToken, OauthRefreshError } from "@deploy-core-worker/sources/oauth-git";
import { createSetupState, readSetupState } from "@deploy-core-worker/sources/setup-state";
import type { SourceHttp } from "@deploy-core-worker/sources/github";
import type { DeployOauthSourceRow, DeploySourceApplicationRow, OauthSourceKind } from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const OTHER_ORG = "org_" + "0".repeat(31) + "b";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const SECRET = "the-deployment-encryption-key";
const CONSOLE = "https://app.freeploy.test";
const actor = { subjectId: "usr_1", subjectType: "user" };
/** 2026-11-20T10:11:12Z, in seconds. */
const NOW = Math.floor(Date.parse("2026-11-20T10:11:12Z") / 1000);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetcher = (handler: (req: Request) => Promise<Response> | Response): Fetcher => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) }) as unknown as Fetcher;

/** The org's GitLab and Gitea Apps in memory; "encryption" marks a value with its column. */
class Store implements OauthSourceStore {
  rows: Record<OauthSourceKind, DeployOauthSourceRow[]> = { gitlab: [], gitea: [] };
  keys = [{ id: 7, uuid: "k7", name: "deploy-key" }];
  using: DeploySourceApplicationRow[] = [];
  private next = 1;
  async findByUuid(kind: OauthSourceKind, uuid: string) {
    return this.rows[kind].find((r) => r.uuid === uuid) ?? null;
  }
  async insert(kind: OauthSourceKind, s: Parameters<OauthSourceStore["insert"]>[1]) {
    const row: DeployOauthSourceRow = {
      id: this.next++, uuid: s.uuid, name: s.name, organization: kind === "gitea" ? s.filter : null, api_url: s.apiUrl, html_url: s.htmlUrl, custom_port: s.customPort, custom_user: s.customUser,
      is_system_wide: s.isSystemWide, is_public: false, client_id: null, client_secret: null, access_token: null, refresh_token: null, expires_at: null, redirect_uri: null, private_key_id: null,
      created_at: null, updated_at: null, group_name: kind === "gitlab" ? s.filter : null, webhook_token: kind === "gitlab" ? s.webhookSecret : null, webhook_secret: kind === "gitea" ? s.webhookSecret : null,
    };
    this.rows[kind].push(row);
    return row;
  }
  async update(kind: OauthSourceKind, id: string | number, changes: Record<string, unknown>) {
    const row = this.rows[kind].find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, changes);
    return row;
  }
  async delete(kind: OauthSourceKind, id: string | number) {
    const before = this.rows[kind].length;
    this.rows[kind] = this.rows[kind].filter((r) => r.id !== id);
    return this.rows[kind].length < before;
  }
  async privateKey(id: string | number | null) {
    return this.keys.find((k) => k.id === Number(id)) ?? null;
  }
  async privateKeys() {
    return this.keys;
  }
  async applications() {
    return this.using;
  }
}

function bind(store: Store): OauthSourceStore {
  const out: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(Store.prototype)) if (name !== "constructor") out[name] = (store as unknown as Record<string, (...a: unknown[]) => unknown>)[name]!.bind(store);
  return out as unknown as OauthSourceStore;
}

/** A GitLab / Gitea that answers what the test scripts and records every request (a form body as its pairs). */
function fakeInstance(routes: Record<string, (req: { method: string; url: string; auth: string; form: Record<string, string> | null }) => Response>) {
  const requests: Array<{ method: string; url: string; auth: string; form: Record<string, string> | null }> = [];
  const http: SourceHttp = {
    now: () => new Date(NOW * 1000),
    sleep: async () => undefined,
    fetch: async (url, init) => {
      const auth = init.headers.Authorization ?? "";
      const form = init.headers["Content-Type"] === "application/x-www-form-urlencoded" ? Object.fromEntries(new URLSearchParams(init.body ?? "")) : null;
      const req = { method: init.method, url, auth, form };
      requests.push(req);
      for (const [pattern, answer] of Object.entries(routes)) if (new RegExp(pattern).test(`${init.method} ${url}`)) return answer(req);
      return json({ message: "Not Found" }, 404);
    },
  };
  return { http, requests };
}

function setup(opts: { read?: boolean; write?: boolean; instance?: SourceHttp; org?: string } = {}) {
  const store = new Store();
  const env: Env = {
    ENVIRONMENT: "test",
    DEPLOY_ENCRYPTION_KEY: SECRET,
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : (opts.read ?? true);
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  };
  const org = opts.org ?? ORG;
  let ran = 0;
  const oauthRunner: OauthSourceRunner = async (_env, _orgId, runOrg, http, fn) => {
    ran++;
    return fn({
      store: bind(store),
      cipher: (column) => ({ encrypt: async (plain) => `enc:${column}:${plain}`, decrypt: async (stored) => stored.replace(`enc:${column}:`, "") }),
      http,
      org: runOrg,
      stateSecret: SECRET,
      resolve: async (host) => (host === "private.example" ? ["10.0.0.5"] : ["93.184.216.34"]),
      consoleUrl: CONSOLE,
    });
  };
  const runner: SourceRunner = async () => {
    throw new Error("the GitHub runner is not used");
  };
  const http = opts.instance ?? fakeInstance({}).http;
  const call = async (method: string, path: string, body?: unknown) => {
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const segments = path.split("?")[0]!.split("/").filter(Boolean);
    const res = await handleSources(env, "req_1", actor, ORG_UUID, org, segments, new Request(`https://x/v1/organizations/${org}/deploy/sources/${path}`, init), { runner, http, oauthRunner, resolve: async (host) => (host === "private.example" ? ["10.0.0.5"] : ["93.184.216.34"]) });
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; error?: { message: string; details: { fields?: Record<string, string[]> } } } };
  };
  return { store, call, ran: () => ran };
}

/** A connected source: its tokens good for `expiresIn` seconds. */
async function connected(t: ReturnType<typeof setup>, kind: OauthSourceKind, expiresIn = 3600): Promise<DeployOauthSourceRow> {
  const html = kind === "gitlab" ? "https://gitlab.acme.test" : "https://git.acme.test";
  const created = await t.call("POST", kind, { name: `${kind}-source`, html_url: html, api_url: "" });
  const row = t.store.rows[kind].find((r) => r.uuid === created.body.data!.uuid)!;
  Object.assign(row, {
    client_id: "client-1",
    client_secret: `enc:${kind}_apps.client_secret:secret-1`,
    access_token: `enc:${kind}_apps.access_token:access-1`,
    refresh_token: `enc:${kind}_apps.refresh_token:refresh-1`,
    expires_at: NOW + expiresIn,
    redirect_uri: `${CONSOLE}/webhooks/source/${kind}/redirect`,
  });
  return row;
}

describe("Create (createGitLabApp, createGiteaApp)", () => {
  it("creates a GitLab App with its defaults, the URLs trimmed, a random webhook token stored encrypted", async () => {
    const t = setup();
    const r = await t.call("POST", "gitlab", { name: "my-gitlab", html_url: "https://gitlab.acme.test/", api_url: "", group_name: "acme,acme/platform" });
    expect(r.status).toBe(201);
    expect(r.body.data).toEqual({ uuid: expect.stringMatching(/^[a-z0-9]{24}$/) });
    expect(t.store.rows.gitlab[0]).toMatchObject({ name: "my-gitlab", html_url: "https://gitlab.acme.test", api_url: "https://gitlab.acme.test/api/v4", custom_user: "git", custom_port: 22, group_name: "acme,acme/platform", is_system_wide: false });
    expect(t.store.rows.gitlab[0]!.webhook_token).toMatch(/^enc:gitlab_apps\.webhook_token:[A-Za-z0-9]{32}$/);
  });

  it("creates a Gitea App on Gitea.com by default, with the organization filter and an encrypted webhook secret", async () => {
    const t = setup();
    const r = await t.call("POST", "gitea", { name: "my-gitea", organization: "acme" });
    expect(r.status).toBe(201);
    expect(t.store.rows.gitea[0]).toMatchObject({ html_url: "https://gitea.com", api_url: "https://gitea.com/api/v1", organization: "acme", group_name: null });
    expect(t.store.rows.gitea[0]!.webhook_secret).toMatch(/^enc:gitea_apps\.webhook_secret:[A-Za-z0-9]{32}$/);
  });

  it("answers Create's rules in Laravel's words, a private network refused (SafeExternalUrl::forGitSource on Coolify Cloud)", async () => {
    const t = setup();
    const r = await t.call("POST", "gitlab", { name: "", html_url: "ftp://gitlab", api_url: "https://private.example/api/v4", custom_user: "", custom_port: "22a", is_system_wide: "maybe", group_name: 5 });
    expect(r.status).toBe(422);
    expect(r.body.error!.details.fields).toEqual({
      name: ["The name field is required."],
      html_url: ["The html url must use the http or https scheme."],
      api_url: ["The api_url points to a local or private address that is not allowed."],
      custom_user: ["The custom user field is required."],
      custom_port: ["The custom port field must be an integer."],
      is_system_wide: ["The is system wide field must be true or false."],
      group_name: ["The group name field must be a string."],
    });
    expect(t.store.rows.gitlab).toEqual([]);
  });

  it("refuses a system-wide source after the rules: no one in Freeploy may make one", async () => {
    const t = setup();
    const r = await t.call("POST", "gitea", { name: "x", is_system_wide: true });
    expect(r.status).toBe(403);
    expect(r.body.error!.message).toBe(OAUTH_SOURCE_MESSAGES.systemWide);
    expect(t.store.rows.gitea).toEqual([]);
  });
});

describe("Change: the page, submit and delete", () => {
  it("shows the form with the secrets decrypted, the console's redirect URI and an OAuth state naming this org and source", async () => {
    const t = setup();
    const row = await connected(t, "gitlab");
    const r = await t.call("GET", `gitlab/${row.uuid}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ kind: "gitlab", clientId: "client-1", clientSecretInput: "secret-1", webhookToken: expect.stringMatching(/^[A-Za-z0-9]{32}$/), webhookSecret: null, isConnected: true, redirectUri: `${CONSOLE}/webhooks/source/gitlab/redirect`, canUpdate: true, privateKeys: [{ id: 7, name: "deploy-key" }] });
    expect(await readSetupState(SECRET, r.body.data!.oauthState, "gitlab")).toMatchObject({ app: row.uuid, org: ORG });
    // A GitLab state is not a Gitea one.
    expect(await readSetupState(SECRET, r.body.data!.oauthState, "gitea")).toBeNull();
  });

  it("shows no secret and no state to who may only read (syncData's Gate::allows('update'))", async () => {
    const row = await connected(setup(), "gitea");
    const t = setup({ write: false });
    t.store.rows.gitea.push(row);
    const r = await t.call("GET", `gitea/${row.uuid}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ clientSecretInput: null, webhookSecret: null, oauthState: null, canUpdate: false, canDelete: false, hasClientSecret: true });
  });

  it("saves the form: GitLab App updated., the secrets kept when left empty, the HTML URL trimmed, the redirect URI the console's", async () => {
    const t = setup();
    const row = await connected(t, "gitlab");
    const token = row.webhook_token;
    const r = await t.call("PATCH", `gitlab/${row.uuid}`, { name: "renamed", clientId: "client-2", clientSecretInput: null, webhookToken: "", groupName: "acme", htmlUrl: "https://gitlab.example.com/", apiUrl: "https://gitlab.example.com/api/v4", customUser: "git", customPort: "2222", privateKeyId: "7" });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ uuid: row.uuid, name: "renamed", message: "GitLab App updated." });
    expect(row).toMatchObject({ name: "renamed", client_id: "client-2", client_secret: "enc:gitlab_apps.client_secret:secret-1", webhook_token: token, group_name: "acme", html_url: "https://gitlab.example.com", custom_port: 2222, private_key_id: 7, redirect_uri: `${CONSOLE}/webhooks/source/gitlab/redirect` });
    const gitea = await connected(t, "gitea");
    const g = await t.call("PATCH", `gitea/${gitea.uuid}`, { clientSecretInput: "secret-2", webhookSecret: "hook-2", organization: "" });
    expect(g.body.data!.message).toBe("Gitea / Forgejo App updated.");
    expect(gitea).toMatchObject({ client_secret: "enc:gitea_apps.client_secret:secret-2", webhook_secret: "enc:gitea_apps.webhook_secret:hook-2", organization: null });
  });

  it("answers Change's rules with the properties' names", async () => {
    const t = setup();
    const row = await connected(t, "gitea");
    const r = await t.call("PATCH", `gitea/${row.uuid}`, { name: "", apiUrl: "nope", htmlUrl: "https://private.example", customUser: 5, customPort: "x", clientId: 5, clientSecretInput: [1], webhookSecret: 7, organization: 1, privateKeyId: 99 });
    expect(r.status).toBe(422);
    expect(r.body.error!.details.fields).toEqual({
      name: ["The name field is required."],
      apiUrl: ["The api url field must be a valid URL.", "The api url must be a valid URL."],
      htmlUrl: ["The htmlUrl points to a local or private address that is not allowed."],
      customUser: ["The custom user field must be a string."],
      customPort: ["The custom port field must be an integer."],
      clientId: ["The client id field must be a string."],
      clientSecretInput: ["The client secret input field must be a string."],
      webhookSecret: ["The webhook secret field must be a string."],
      organization: ["The organization field must be a string."],
      privateKeyId: ["The selected private key id is invalid."],
    });
    expect(row.name).toBe("gitea-source");
  });

  it("refuses to make a source system-wide (authorizeSystemWideChange)", async () => {
    const t = setup();
    const row = await connected(t, "gitlab");
    const r = await t.call("PATCH", `gitlab/${row.uuid}`, { isSystemWide: true });
    expect(r.status).toBe(403);
    expect(row.is_system_wide).toBe(false);
  });

  it("deletes a source no application uses, and refuses one that is used", async () => {
    const t = setup();
    const row = await connected(t, "gitlab");
    t.store.using = [{ id: 1, uuid: "a1", name: "web", project_uuid: "p", project_name: "P", environment_uuid: "e", environment_name: "E", fqdn: null, status: "exited", git_repository: "acme/web", git_branch: "main" }];
    let r = await t.call("DELETE", `gitlab/${row.uuid}`);
    expect(r.status).toBe(422);
    expect(r.body.error!.message).toBe("This source is being used by an application. Please delete all applications first.");
    t.store.using = [];
    r = await t.call("DELETE", `gitlab/${row.uuid}`);
    expect(r.body.data).toEqual({ deleted: true, redirect: "/sources" });
    expect(t.store.rows.gitlab).toEqual([]);
    expect((await t.call("GET", `gitlab/${row.uuid}`)).status).toBe(404);
  });
});

describe("Test connection", () => {
  it("is refused before the OAuth flow", async () => {
    const t = setup();
    const created = await t.call("POST", "gitea", { name: "x" });
    const r = await t.call("POST", `gitea/${created.body.data!.uuid}/test`);
    expect(r.body.error!.message).toBe("Gitea / Forgejo App is not connected. Please complete the OAuth flow first.");
  });

  it("asks GET /user with the token and names the user (GitLab's username, Gitea's login)", async () => {
    const fake = fakeInstance({ "^GET https://gitlab\\.acme\\.test/api/v4/user$": () => json({ id: 1, username: "octo" }), "^GET https://git\\.acme\\.test/api/v1/user$": () => json({ id: 2, login: "forge" }) });
    const t = setup({ instance: fake.http });
    const gl = await connected(t, "gitlab");
    expect((await t.call("POST", `gitlab/${gl.uuid}/test`)).body.data).toEqual({ message: "Connection successful! Authenticated as: octo" });
    const gt = await connected(t, "gitea");
    expect((await t.call("POST", `gitea/${gt.uuid}/test`)).body.data).toEqual({ message: "Connection successful! Authenticated as: forge" });
    expect(fake.requests.map((q) => [q.method, q.url, q.auth])).toEqual([
      ["GET", "https://gitlab.acme.test/api/v4/user", "Bearer access-1"],
      ["GET", "https://git.acme.test/api/v1/user", "Bearer access-1"],
    ]);
  });

  it("refreshes a token that expires within a minute first, and stores the new tokens", async () => {
    const fake = fakeInstance({
      "^POST https://gitlab\\.acme\\.test/oauth/token$": () => json({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 7200 }),
      "^GET https://gitlab\\.acme\\.test/api/v4/user$": () => json({ message: "401 Unauthorized" }, 401),
    });
    const t = setup({ instance: fake.http });
    const row = await connected(t, "gitlab", 30);
    const r = await t.call("POST", `gitlab/${row.uuid}/test`);
    expect(r.body.error!.message).toBe("Connection failed: 401 Unauthorized");
    expect(fake.requests[0]).toEqual({ method: "POST", url: "https://gitlab.acme.test/oauth/token", auth: "", form: { client_id: "client-1", client_secret: "secret-1", refresh_token: "refresh-1", grant_type: "refresh_token", redirect_uri: `${CONSOLE}/webhooks/source/gitlab/redirect` } });
    expect(fake.requests[1]!.auth).toBe("Bearer access-2");
    expect(row).toMatchObject({ access_token: "enc:gitlab_apps.access_token:access-2", refresh_token: "enc:gitlab_apps.refresh_token:refresh-2", expires_at: NOW + 7200 });
  });

  it("answers the refresh's failure as Coolify's RuntimeException", async () => {
    const fake = fakeInstance({ "^POST https://git\\.acme\\.test/login/oauth/access_token$": () => json({ error: "invalid_grant", error_description: "The refresh token is invalid." }, 400) });
    const t = setup({ instance: fake.http });
    const row = await connected(t, "gitea", 0);
    expect((await t.call("POST", `gitea/${row.uuid}/test`)).body.error!.message).toBe("Failed to refresh Gitea token: The refresh token is invalid.");
    // Gitea's refresh has no redirect URI.
    expect(fake.requests[0]!.form).toEqual({ client_id: "client-1", client_secret: "secret-1", refresh_token: "refresh-1", grant_type: "refresh_token" });
  });

  it("is a read: a member that may not write can test, one that may not read gets 404", async () => {
    const fake = fakeInstance({ "^GET https://gitlab\\.acme\\.test/api/v4/user$": () => json({ username: "octo" }) });
    const writer = setup({ instance: fake.http });
    const row = await connected(writer, "gitlab");
    const reader = setup({ write: false, instance: fake.http });
    reader.store.rows.gitlab.push(row);
    expect((await reader.call("POST", `gitlab/${row.uuid}/test`)).status).toBe(200);
    const stranger = setup({ read: false, write: false, instance: fake.http });
    stranger.store.rows.gitlab.push(row);
    expect((await stranger.call("POST", `gitlab/${row.uuid}/test`)).status).toBe(404);
    expect(stranger.ran()).toBe(0);
  });
});

describe("the OAuth redirect (Webhook\\Gitlab::redirect, Webhook\\Gitea::redirect)", () => {
  it("answers Coolify's messages for a missing code or state, and for a state that is invalid or another org's", async () => {
    const t = setup();
    const row = await connected(t, "gitlab");
    expect((await t.call("POST", "gitlab/redirect", { code: "", state: "x" })).body.data).toEqual({ redirect: "/sources", error: "Invalid GitLab OAuth callback. Missing code or state." });
    expect((await t.call("POST", "gitea/redirect", { code: "c" })).body.data).toEqual({ redirect: "/sources", error: "Invalid Gitea OAuth callback. Missing code or state." });
    expect((await t.call("POST", "gitlab/redirect", { code: "c", state: "forged" })).body.data).toEqual({ redirect: "/sources", error: "Invalid or expired GitLab OAuth state. Please start the authorization again." });
    const otherOrg = await createSetupState(SECRET, "gitlab", row.uuid, OTHER_ORG);
    expect((await t.call("POST", "gitlab/redirect", { code: "c", state: otherOrg })).body.data!.error).toBe("Invalid or expired GitLab OAuth state. Please start the authorization again.");
    const giteaState = await createSetupState(SECRET, "gitea", row.uuid, ORG);
    expect((await t.call("POST", "gitlab/redirect", { code: "c", state: giteaState })).body.data!.error).toBe("Invalid or expired GitLab OAuth state. Please start the authorization again.");
  });

  it("exchanges the code with the source's credentials and redirect URI, and stores the tokens", async () => {
    const fake = fakeInstance({ "^POST https://git\\.acme\\.test/login/oauth/access_token$": () => json({ access_token: "new-access", refresh_token: "new-refresh" }) });
    const t = setup({ instance: fake.http });
    const row = await connected(t, "gitea");
    Object.assign(row, { access_token: null, refresh_token: null, expires_at: null });
    const state = await createSetupState(SECRET, "gitea", row.uuid, ORG);
    const r = await t.call("POST", "gitea/redirect", { code: "the-code", state });
    expect(r.body.data).toEqual({ redirect: `/source/gitea/${row.uuid}`, error: null });
    expect(fake.requests[0]!.form).toEqual({ client_id: "client-1", client_secret: "secret-1", code: "the-code", grant_type: "authorization_code", redirect_uri: `${CONSOLE}/webhooks/source/gitea/redirect` });
    // expires_in absent: Gitea's default hour.
    expect(row).toMatchObject({ access_token: "enc:gitea_apps.access_token:new-access", refresh_token: "enc:gitea_apps.refresh_token:new-refresh", expires_at: NOW + 3600 });
  });

  it("goes back to the source's page with the instance's refusal, or to the Sources page on an error", async () => {
    const fake = fakeInstance({ "^POST https://gitlab\\.acme\\.test/oauth/token$": (q) => (q.form?.code === "bad" ? json({ error: "invalid_grant" }, 400) : json({ access_token: "a" })) });
    const t = setup({ instance: fake.http });
    const row = await connected(t, "gitlab");
    const state = await createSetupState(SECRET, "gitlab", row.uuid, ORG);
    expect((await t.call("POST", "gitlab/redirect", { code: "bad", state })).body.data).toEqual({ redirect: `/source/gitlab/${row.uuid}`, error: "GitLab OAuth failed: Token exchange failed" });
    // $data['refresh_token'] of an answer without one: PHP's warning, caught by the controller.
    expect((await t.call("POST", "gitlab/redirect", { code: "good", state })).body.data).toEqual({ redirect: "/sources", error: 'Undefined array key "refresh_token"' });
  });

  it("needs write: a member that may only read gets 404 and nothing is exchanged", async () => {
    const fake = fakeInstance({});
    const t = setup({ write: false, instance: fake.http });
    const state = await createSetupState(SECRET, "gitlab", "y1", ORG);
    expect((await t.call("POST", "gitlab/redirect", { code: "c", state })).status).toBe(404);
    expect(fake.requests).toEqual([]);
    expect(t.ran()).toBe(0);
  });
});

describe("New Resource's repositories and branches", () => {
  it("lists every page of a GitLab source's projects, its group filter applied, by name", async () => {
    const project = (id: number, name: string, ns: string) => ({ id, name, path_with_namespace: `${ns}/${name}`, default_branch: "main", web_url: `https://gitlab.acme.test/${ns}/${name}`, namespace: { full_path: ns, kind: "group" }, extra: true });
    const page1 = Array.from({ length: 100 }, (_, i) => project(i + 1, `p${String(i).padStart(3, "0")}`, i % 2 ? "other" : "acme/platform"));
    const fake = fakeInstance({
      "page=1&": () => json(page1),
      "page=2&": () => json([project(500, "alpha", "acme"), project(501, "beta", "acmeish")]),
    });
    const t = setup({ instance: fake.http });
    const row = await connected(t, "gitlab");
    row.group_name = "ACME";
    const r = await t.call("GET", `gitlab/${row.uuid}/repositories`);
    const repos = r.body.data!.repositories as Array<{ id: number; name: string; namespace: { full_path: string } }>;
    expect(r.body.data!.total_count).toBe(51);
    expect(repos[0]).toEqual({ id: 500, name: "alpha", path_with_namespace: "acme/alpha", default_branch: "main", web_url: "https://gitlab.acme.test/acme/alpha", namespace: { full_path: "acme", kind: "group" } });
    expect(repos.every((p) => p.namespace.full_path === "acme" || p.namespace.full_path.startsWith("acme/"))).toBe(true);
    expect(fake.requests.map((q) => q.url)).toEqual([
      "https://gitlab.acme.test/api/v4/projects?membership=true&per_page=100&page=1&order_by=name&sort=asc",
      "https://gitlab.acme.test/api/v4/projects?membership=true&per_page=100&page=2&order_by=name&sort=asc",
    ]);
  });

  it("lists a Gitea source's repositories of the allowed owners, and a repository's branches, main first", async () => {
    const repo = (id: number, owner: string, name: string) => ({ id, name, full_name: `${owner}/${name}`, owner: { login: owner }, html_url: `https://git.acme.test/${owner}/${name}`, default_branch: "develop" });
    const fake = fakeInstance({
      "/user/repos\\?limit=50&page=1$": () => json([repo(1, "Acme", "web"), repo(2, "someone", "x")]),
      "/repos/Acme/web/branches\\?limit=50&page=1$": () => json([{ name: "feature" }, { name: "develop" }, { name: "main" }]),
    });
    const t = setup({ instance: fake.http });
    const row = await connected(t, "gitea");
    row.organization = "acme";
    const r = await t.call("GET", `gitea/${row.uuid}/repositories`);
    expect(r.body.data).toEqual({ repositories: [{ id: 1, name: "web", full_name: "Acme/web", default_branch: "develop", html_url: "https://git.acme.test/Acme/web", owner: "Acme" }], total_count: 1 });
    const b = await t.call("GET", `gitea/${row.uuid}/repositories/Acme/web/branches?default_branch=develop`);
    expect(b.body.data).toEqual({ branches: ["main", "develop", "feature"], selected: "develop" });
    const missing = await t.call("GET", `gitea/${row.uuid}/repositories/Acme/web/branches?default_branch=release`);
    expect(missing.body.data!.selected).toBe("main");
  });

  it("needs a connected source and write (useTeamCredentials)", async () => {
    const t = setup();
    const created = await t.call("POST", "gitlab", { name: "x" });
    expect((await t.call("GET", `gitlab/${created.body.data!.uuid}/repositories`)).status).toBe(404);
    const reader = setup({ write: false });
    expect((await reader.call("GET", `gitlab/${created.body.data!.uuid}/repositories`)).status).toBe(404);
    expect(reader.ran()).toBe(0);
  });
});

describe("the authorization", () => {
  it("answers 404 and runs nothing for a write a member may not make, or a read one may not", async () => {
    const t = setup({ write: false });
    for (const [method, path, body] of [["POST", "gitlab", { name: "x" }], ["PATCH", "gitlab/y1paritygitlabapp0000001", { name: "x" }], ["DELETE", "gitea/z1"], ["GET", "gitea/z1/repositories"]] as const) {
      const r = await t.call(method, path, body);
      expect(r.status).toBe(404);
    }
    expect(t.ran()).toBe(0);
    const s = setup({ read: false, write: false });
    expect((await s.call("GET", "gitlab/y1")).status).toBe(404);
    expect(s.ran()).toBe(0);
  });

  it("knows only the routes Coolify has", async () => {
    const t = setup();
    expect((await t.call("GET", "gitlab/y1/permissions")).status).toBe(404);
    expect((await t.call("PUT", "gitlab/y1")).status).toBe(405);
    expect((await t.call("GET", "bitbucket/y1")).status).toBe(404);
  });
});

describe("the helpers", () => {
  it("apiUrlBase(), allowsRepositoryOwner() and refreshOauthToken()'s guard", async () => {
    expect(apiUrlBase("gitlab", "https://gitlab.com/")).toBe("https://gitlab.com/api/v4");
    expect(apiUrlBase("gitlab", "https://gitlab.com/api/v4/")).toBe("https://gitlab.com/api/v4");
    expect(apiUrlBase("gitea", "https://git.acme.test/gitea")).toBe("https://git.acme.test/gitea/api/v1");
    expect(allowsRepositoryOwner(null, "anyone")).toBe(true);
    expect(allowsRepositoryOwner(" , ", "anyone")).toBe(true);
    expect(allowsRepositoryOwner("acme, Parity", "PARITY")).toBe(true);
    expect(allowsRepositoryOwner("acme", "other")).toBe(false);
    const net = { fetch: (async () => json({})) as unknown as typeof fetch, sleep: async () => undefined, now: () => new Date(NOW * 1000) };
    await expect(refreshOauthToken(net, "gitlab", { html_url: "https://gitlab.com", api_url: "https://gitlab.com/api/v4", client_id: null, client_secret: null, access_token: "a", refresh_token: null, expires_at: null, redirect_uri: null })).rejects.toThrow(new OauthRefreshError("GitLab source has no refresh token. Please reconnect the GitLab app."));
    expect(await refreshOauthToken(net, "gitea", { html_url: "https://gitea.com", api_url: "https://gitea.com/api/v1", client_id: null, client_secret: null, access_token: "a", refresh_token: "r", expires_at: NOW + 61, redirect_uri: null })).toBeNull();
  });
});
