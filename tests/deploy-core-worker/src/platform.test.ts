// The platform operator's routes (freeploy-coolify-parity DP12, DP-79): Coolify's /settings, /settings/advanced,
// /admin and Team → Admin View, as /v1/platform/* in deploy-core-worker. The decisions are the real ones:
// POLICY_WORKER here is policy-worker's own router with a PLATFORM_OPERATORS, and MEMBERSHIP_WORKER answers
// every org an actor asks about with the role under test — so a customer has every org role there is, in
// every org, and still reaches nothing. Every denial is the platform's 404, and nothing is read or written:
// the settings store is never opened and membership's platform data is never asked for.
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handlePlatform, validatePlatformSettings, type PlatformRunner, type PlatformSettingsStore } from "@deploy-core-worker/handlers/platform";
import { route as policyRoute } from "@policy-worker/router";
import type { PlatformSettingsChanges, PlatformSettingsRow } from "@saas/db/deploy";

const OPERATOR = "usr_" + "a".repeat(32);
const CUSTOMER = "usr_" + "b".repeat(32);
const ORG = "org_" + "c".repeat(32);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

class MemorySettings implements PlatformSettingsStore {
  row: PlatformSettingsRow = {
    instance_name: null,
    is_registration_enabled: true,
    disable_two_step_confirmation: false,
    is_passkey_enabled: true,
    is_dns_validation_enabled: true,
    is_sponsorship_popup_enabled: false,
    updated_at: null,
  };
  async read() {
    return this.row;
  }
  async update(changes: PlatformSettingsChanges) {
    this.row = { ...this.row, ...changes };
    return this.row;
  }
}

function setup(role = "owner") {
  const store = new MemorySettings();
  const opened: string[] = [];
  const platformAsked: string[] = [];
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    // The deployed decision, with one operator.
    POLICY_WORKER: fetcher((req) => policyRoute(req, { ENVIRONMENT: "test", PLATFORM_OPERATORS: OPERATOR })),
    MEMBERSHIP_WORKER: fetcher(async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/v1/internal/membership/authorization-context") {
        const body = (await req.json()) as { orgId: string };
        return json({ data: { memberships: [{ kind: "role_assignment", role, scope: { kind: "organization", orgId: body.orgId } }] } });
      }
      platformAsked.push(path);
      if (path.endsWith("/subscribers")) return json({ data: { active: 2, inactive: 1 } });
      const body = (await req.json()) as Record<string, unknown>;
      return json({ data: { users: [{ id: CUSTOMER, name: "Bob", email: "bob@example.com", hasActiveSubscription: true }], total: 1, page: 1, perPage: Number(body.perPage ?? 10), asked: body } });
    }),
  };
  const runner: PlatformRunner = async (_env, fn) => {
    opened.push("settings");
    return fn(store);
  };
  const call = async (actor: { subjectId: string; subjectType: string } | null, method: string, path: string, body?: unknown) => {
    const url = `https://deploy-core.internal/v1/platform${path}`;
    const req = new Request(url, { method, ...(body === undefined || body === null ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) });
    const res = await handlePlatform(env, "req_1", actor, new URL(url).pathname.slice("/v1/platform".length), req, runner);
    return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; error?: { code: string; message: string; details: { fields?: Record<string, string[]> } } } };
  };
  return { env, store, opened, platformAsked, call };
}

/** Every platform route, as the pages call them. */
const ROUTES: Array<[string, string, unknown?]> = [
  ["GET", "/operator"],
  ["GET", "/settings"],
  ["PATCH", "/settings", { section: "general", action: "submit", values: { instance_name: "Mine" } }],
  ["PATCH", "/settings", { section: "advanced", action: "instantSave", values: { is_registration_enabled: false } }],
  ["GET", "/admin"],
  ["GET", "/admin?search=bob"],
  ["GET", `/admin/users?teamFilter=current&orgId=${ORG}`],
  ["GET", "/updates"],
];

const user = (id: string) => ({ subjectId: id, subjectType: "user" });

describe("no customer reaches a platform route", () => {
  const ROLES = ["owner", "admin", "builder", "viewer", "billing_admin"];
  test.each(ROLES.flatMap((role) => ROUTES.map(([m, p, b]) => [role, m, p, b] as const)))("a user who is %s of every org: %s %s → 404", async (role, method, path, body) => {
    const t = setup(role);
    const r = await t.call(user(CUSTOMER), method, path, body);
    expect(r.status).toBe(404);
    expect(r.body.error?.code).toBe("not_found");
    expect(t.opened).toEqual([]);
    expect(t.platformAsked).toEqual([]);
  });

  // A Coolify API token is its user with abilities; `root` is the user's owner role (DP-70). Through the console's
  // routes a token is an API key's service principal: with an owner role — and even with the operator's id.
  test.each(ROUTES.flatMap(([m, p, b]) => [CUSTOMER, OPERATOR].map((id) => [id, m, p, b] as const)))("an API key (service principal %s, owner role, Coolify's root): %s %s → 404", async (id, method, path, body) => {
    const t = setup("owner");
    const r = await t.call({ subjectId: id, subjectType: "service_principal" }, method, path, body);
    expect(r.status).toBe(404);
    expect(t.opened).toEqual([]);
    expect(t.platformAsked).toEqual([]);
  });

  test.each(ROUTES.map(([m, p, b]) => [m, p, b ?? null] as const))("no actor: %s %s → 404", async (method, path, body) => {
    const t = setup();
    expect((await t.call(null, method, path, body)).status).toBe(404);
    expect(t.opened).toEqual([]);
  });

  test("through route(): an org owner's /v1/platform/settings is the same 404, and so is a path no page has", async () => {
    const t = setup("owner");
    for (const path of ["/v1/platform/settings", "/v1/platform", "/v1/platform/settings/backup"]) {
      const res = await route(new Request(`https://deploy-core.internal${path}`, { headers: { "x-actor-subject-id": CUSTOMER, "x-actor-subject-type": "user" } }), t.env);
      expect([path, res.status]).toEqual([path, 404]);
    }
  });
});

describe("the platform operator", () => {
  const op = user(OPERATOR);

  test("is told so (the sidebar's Settings submenu)", async () => {
    const r = await setup().call(op, "GET", "/operator");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ operator: true });
  });

  test("reads the settings and may change them", async () => {
    const t = setup();
    const r = await t.call(op, "GET", "/settings");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      settings: {
        instance_name: null,
        is_registration_enabled: true,
        disable_two_step_confirmation: false,
        is_passkey_enabled: true,
        is_dns_validation_enabled: true,
        is_sponsorship_popup_enabled: false,
      },
      canUpdate: true,
    });
  });

  test("General: submit() saves the Name with 'Instance settings updated successfully!'", async () => {
    const t = setup();
    const r = await t.call(op, "PATCH", "/settings", { section: "general", action: "submit", values: { instance_name: "Freeploy stage" } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ message: "Instance settings updated successfully!", settings: { instance_name: "Freeploy stage" } });
    // An empty Name is null (nullable), as Livewire sends it.
    await t.call(op, "PATCH", "/settings", { section: "general", action: "submit", values: { instance_name: "" } });
    expect(t.store.row.instance_name).toBeNull();
  });

  test("Advanced: instantSave() saves the flags with 'Settings updated!', and only the page's own", async () => {
    const t = setup();
    const r = await t.call(op, "PATCH", "/settings", {
      section: "advanced",
      action: "instantSave",
      values: { is_registration_enabled: false, disable_two_step_confirmation: "1", is_passkey_enabled: 0, is_dns_validation_enabled: true, is_sponsorship_popup_enabled: true, instance_name: "ignored" },
    });
    expect(r.status).toBe(200);
    expect(r.body.data?.message).toBe("Settings updated!");
    expect(t.store.row).toMatchObject({ is_registration_enabled: false, disable_two_step_confirmation: true, is_passkey_enabled: false, is_sponsorship_popup_enabled: true, instance_name: null });
  });

  test("the rules and Laravel's messages; nothing is saved on an error", async () => {
    const t = setup();
    const long = await t.call(op, "PATCH", "/settings", { section: "general", action: "submit", values: { instance_name: "x".repeat(256) } });
    expect(long.status).toBe(422);
    expect(long.body.error?.details.fields).toEqual({ instance_name: ["The instance name field must not be greater than 255 characters."] });
    const notString = await t.call(op, "PATCH", "/settings", { section: "general", values: { instance_name: 5 } });
    expect(notString.body.error?.details.fields).toEqual({ instance_name: ["The instance name field must be a string."] });
    const notBoolean = await t.call(op, "PATCH", "/settings", { section: "advanced", values: { is_passkey_enabled: "yes" } });
    expect(notBoolean.body.error?.details.fields).toEqual({ is_passkey_enabled: ["The is passkey enabled field must be true or false."] });
    expect(t.store.row.instance_name).toBeNull();
    expect((await t.call(op, "PATCH", "/settings", { section: "updates", values: {} })).status).toBe(422);
    expect(validatePlatformSettings("general", { instance_name: "x".repeat(255) }).errors).toEqual({});
  });

  test("Admin: the subscriber counts, and the user lookup with a search", async () => {
    const t = setup();
    const empty = await t.call(op, "GET", "/admin");
    expect(empty.body.data).toEqual({ activeSubscribers: 2, inactiveSubscribers: 1, search: "", users: [], total: 0 });
    const found = await t.call(op, "GET", "/admin?search=bob");
    expect(found.body.data).toMatchObject({ search: "bob", total: 1, users: [{ email: "bob@example.com", hasActiveSubscription: true }] });
  });

  test("Team → Admin View: the users, without the operator, with the page's filter, sort and page", async () => {
    const t = setup();
    const r = await t.call(op, "GET", `/admin/users?search=b&teamFilter=outside&orgId=${ORG}&sort=email_desc&perPage=25&page=2`);
    expect(r.status).toBe(200);
    expect((r.body.data as { asked: unknown }).asked).toEqual({ search: "b", teamFilter: "outside", orgId: ORG, sort: "email_desc", perPage: "25", page: "2", excludeUserId: OPERATOR });
  });

  test("nothing changes a user: there is no impersonation and no deletion route", async () => {
    const t = setup();
    for (const [method, path] of [
      ["POST", "/admin/switch"],
      ["PATCH", "/admin/users"],
      ["DELETE", "/admin/users"],
    ] as const) {
      expect((await t.call(op, method, path)).status).toBeGreaterThanOrEqual(404);
    }
  });
});
