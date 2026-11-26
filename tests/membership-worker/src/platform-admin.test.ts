// The platform operator's Admin View data (freeploy-coolify-parity DP12, DP-79): membership-worker's internal,
// read-only routes for deploy-core-worker. The body becomes AdminView's query (perPage clamped to 1–100 as
// updatedPerPage() does, the current team and the operator by their public ids), users answer with public
// ids, and the subscriber counts are read as they are. The SQL is tested in tests/db (platform-admin.test.ts).
import { handlePlatformAdmin, PLATFORM_SUBSCRIBERS_PATH, PLATFORM_USERS_PATH } from "@membership-worker/handlers/platform-admin";
import { route } from "@membership-worker/router";
import type { Env } from "@membership-worker/env";
import type { SqlExecutor } from "@saas/db/hyperdrive";

const env = { ENVIRONMENT: "test" } as Env;
const USER_UUID = "00000000-0000-4000-8000-0000000000b1";
const ORG_UUID = "00000000-0000-4000-8000-0000000000a1";
const OPERATOR_UUID = "00000000-0000-4000-8000-0000000000f1";
const hex = (u: string) => u.replace(/-/g, "");

function fakeDb() {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  const db: SqlExecutor = {
    async execute(text: string, params: unknown[] = []) {
      queries.push({ text, params });
      if (text.includes("FROM billing.subscriptions") && !text.includes("identity.users")) return { rows: [{ active: "3", inactive: "1" }], rowCount: 1 } as never;
      return { rows: [{ id: USER_UUID, display_name: "Bob", email: "bob@example.com", has_active_subscription: true, total: "41" }], rowCount: 1 } as never;
    },
  };
  return { db, queries };
}

const post = (body: unknown) => new Request(`https://m${PLATFORM_USERS_PATH}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("membership-worker: the platform's users and subscribers", () => {
  test("users: AdminView's query from the body, and public ids in the answer", async () => {
    const { db, queries } = fakeDb();
    const res = await handlePlatformAdmin(
      post({ search: " bob ", teamFilter: "current", orgId: `org_${hex(ORG_UUID)}`, sort: "email_desc", perPage: 500, page: 3, excludeUserId: `usr_${hex(OPERATOR_UUID)}` }),
      env,
      "req_1",
      PLATFORM_USERS_PATH,
      { db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown };
    expect(body.data).toEqual({ users: [{ id: `usr_${hex(USER_UUID)}`, name: "Bob", email: "bob@example.com", hasActiveSubscription: true }], total: 41, page: 3, perPage: 100 });
    const q = queries[0]!;
    // The search, the operator left out, the current team, a page of 100 (clamped) from row 200.
    expect(q.params).toEqual([OPERATOR_UUID, "bob", ORG_UUID, 100, 200]);
    expect(q.text).toContain("ORDER BY u.email DESC");
  });

  test("users: defaults, and nonsense falls back to them", async () => {
    const { db, queries } = fakeDb();
    await handlePlatformAdmin(post({ teamFilter: "everyone", sort: "random", perPage: -4, page: 0, orgId: "not-an-id" }), env, "req_1", PLATFORM_USERS_PATH, { db });
    expect(queries[0]!.params).toEqual([1, 0]);
    expect(queries[0]!.text).toContain("ORDER BY u.display_name ASC");
  });

  test("subscribers: the counts", async () => {
    const { db } = fakeDb();
    const res = await handlePlatformAdmin(new Request(`https://m${PLATFORM_SUBSCRIBERS_PATH}`), env, "req_1", PLATFORM_SUBSCRIBERS_PATH, { db });
    expect(((await res.json()) as { data: unknown }).data).toEqual({ active: 3, inactive: 1 });
  });

  test("read only: any other method is refused", async () => {
    const { db, queries } = fakeDb();
    expect((await handlePlatformAdmin(new Request(`https://m${PLATFORM_USERS_PATH}`, { method: "DELETE" }), env, "req_1", PLATFORM_USERS_PATH, { db })).status).toBe(405);
    expect((await handlePlatformAdmin(new Request(`https://m${PLATFORM_SUBSCRIBERS_PATH}`, { method: "POST" }), env, "req_1", PLATFORM_SUBSCRIBERS_PATH, { db })).status).toBe(405);
    expect(queries).toEqual([]);
  });

  test("the router reaches it (and without a database answers 503)", async () => {
    for (const path of [PLATFORM_USERS_PATH, PLATFORM_SUBSCRIBERS_PATH]) {
      const res = await route(new Request(`https://m${path}`, { method: path === PLATFORM_USERS_PATH ? "POST" : "GET", body: path === PLATFORM_USERS_PATH ? "{}" : null }), env);
      expect([path, res.status]).toEqual([path, 503]);
    }
  });
});
