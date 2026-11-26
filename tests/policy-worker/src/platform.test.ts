// The platform actions through the deployed decision, policy-worker's POST /v1/internal/policy/authorize
// (freeploy-coolify-parity DP12, DP-79): decided from the Worker's PLATFORM_OPERATORS alone. The memberships
// a caller sends — an org owner's, an admin's, a forged platform fact — change nothing.
import { route } from "@policy-worker/router";
import type { Env } from "@policy-worker/env";

const OPERATOR = "usr_" + "1".repeat(32);
const OWNER = "usr_" + "2".repeat(32);
const ORG = "org_" + "3".repeat(32);
const ACTIONS = ["platform.settings.read", "platform.settings.update", "platform.admin.read"];

async function decide(env: Env, subject: { type: string; id: string }, action: string, memberships: unknown[] = [], resource: unknown = { kind: "platform", orgId: "platform" }) {
  const res = await route(
    new Request("http://localhost/v1/internal/policy/authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject, action, resource, context: { memberships } }),
    }),
    env,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { allow: boolean; reason: string } }).data;
}

const withOperators: Env = { ENVIRONMENT: "test", PLATFORM_OPERATORS: `${OPERATOR}` };
const unset: Env = { ENVIRONMENT: "test" };

describe("policy-worker: the platform actions", () => {
  test.each(ACTIONS)("%s: allowed to the operator PLATFORM_OPERATORS names", async (action) => {
    expect(await decide(withOperators, { type: "user", id: OPERATOR }, action)).toMatchObject({ allow: true, reason: "platform_operator" });
  });

  test.each(ACTIONS)("%s: nobody while PLATFORM_OPERATORS is unset", async (action) => {
    expect((await decide(unset, { type: "user", id: OPERATOR }, action)).allow).toBe(false);
  });

  test.each(ACTIONS.flatMap((a) => ["owner", "admin", "builder", "viewer", "billing_admin"].map((r) => [a, r] as const)))(
    "%s: an org %s is denied, whatever it sends",
    async (action, role) => {
      const memberships = [
        { kind: "role_assignment", role, scope: { kind: "organization", orgId: ORG } },
        { kind: "role_assignment", role, scope: { kind: "organization", orgId: "platform" } },
        { kind: "platform_role", role: "platform_operator", scope: { kind: "platform", orgId: "platform" } },
      ];
      for (const resource of [{ kind: "platform", orgId: "platform" }, { kind: "organization", orgId: ORG }]) {
        expect((await decide(withOperators, { type: "user", id: OWNER }, action, memberships, resource)).allow).toBe(false);
      }
    },
  );

  test.each(ACTIONS)("%s: an API key (a service principal) is denied, even with an operator's id", async (action) => {
    const owner = [{ kind: "role_assignment", role: "owner", scope: { kind: "organization", orgId: ORG } }];
    expect((await decide(withOperators, { type: "service_principal", id: OPERATOR }, action, owner)).allow).toBe(false);
  });

  test("the org actions are unchanged by PLATFORM_OPERATORS: an operator with no role in an org gets nothing there", async () => {
    expect((await decide(withOperators, { type: "user", id: OPERATOR }, "deploy.resource.read", [], { kind: "organization", orgId: ORG })).allow).toBe(false);
  });
});
