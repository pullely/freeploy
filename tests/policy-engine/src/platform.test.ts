// The platform operator (freeploy-coolify-parity DP12, DP-79): Coolify's instance-level pages (/settings/*,
// /admin, Team → Admin View) are the platform operator's alone. No org role — owner, admin, builder, viewer,
// billing_admin, nor any project role — grants a platform action, whatever org or facts a request names;
// so neither does a Coolify API token with the `root` ability, which acts as its user's owner role. Only a
// user subject that the deployment names in PLATFORM_OPERATORS passes, and never an API key's service
// principal, a workflow or the system, even with an operator's id.
import { authorize, authorizePlatform, parsePlatformOperators, PLATFORM_ACTIONS, PLATFORM_RESOURCE, listEffectivePermissions } from "@saas/policy-engine";
import type { AuthorizationRequest, PolicyMembershipFact, PolicySubject } from "@saas/contracts/policy";

const OPERATOR = "usr_" + "a".repeat(32);
const CUSTOMER = "usr_" + "b".repeat(32);
const ORG = "org_" + "c".repeat(32);
const operators = parsePlatformOperators(` ${OPERATOR}, usr_not-an-id ,`);
const ACTIONS = ["platform.settings.read", "platform.settings.update", "platform.admin.read"];
const ORG_ROLES = ["owner", "admin", "builder", "viewer", "billing_admin"];

const fact = (role: string, orgId: string): PolicyMembershipFact => ({ kind: "role_assignment", role, scope: { kind: "organization", orgId } });

describe("platform actions", () => {
  test("are exactly the three DP12 pages ask", () => {
    expect([...PLATFORM_ACTIONS].sort()).toEqual([...ACTIONS].sort());
  });

  test("PLATFORM_OPERATORS keeps only well-formed user ids", () => {
    expect([...operators]).toEqual([OPERATOR]);
    expect(parsePlatformOperators(undefined).size).toBe(0);
    expect(parsePlatformOperators("").size).toBe(0);
  });

  test.each(ACTIONS)("%s: the operator passes", (action) => {
    expect(authorizePlatform({ subject: { type: "user", id: OPERATOR }, action, resource: PLATFORM_RESOURCE }, operators)).toMatchObject({ allow: true, reason: "platform_operator" });
  });

  test.each(ACTIONS)("%s: nobody passes while PLATFORM_OPERATORS is unset", (action) => {
    expect(authorizePlatform({ subject: { type: "user", id: OPERATOR }, action, resource: PLATFORM_RESOURCE }, parsePlatformOperators(undefined)).allow).toBe(false);
  });

  test.each(ACTIONS.flatMap((a) => (["service_principal", "workflow", "system"] as const).map((t) => [a, t] as const)))(
    "%s: a %s with the operator's id is no operator (an API key is a service principal)",
    (action, type) => {
      const subject: PolicySubject = { type, id: OPERATOR };
      expect(authorizePlatform({ subject, action, resource: PLATFORM_RESOURCE }, operators)).toMatchObject({ allow: false, reason: "platform_operator_required" });
    },
  );

  test.each(ACTIONS)("%s: a customer who is not an operator is denied", (action) => {
    expect(authorizePlatform({ subject: { type: "user", id: CUSTOMER }, action, resource: PLATFORM_RESOURCE }, operators).allow).toBe(false);
  });

  test("an operator still needs the platform as the resource, and a known platform action", () => {
    expect(authorizePlatform({ subject: { type: "user", id: OPERATOR }, action: "platform.settings.read", resource: { kind: "organization", orgId: ORG } }, operators).reason).toBe("invalid_scope");
    expect(authorizePlatform({ subject: { type: "user", id: OPERATOR }, action: "deploy.resource.read", resource: PLATFORM_RESOURCE }, operators).reason).toBe("unknown_action");
  });

  // authorize() is the org-role decision every other action takes: a platform action is never granted there,
  // whatever role, org, scope or forged fact the request carries.
  test.each(ACTIONS.flatMap((a) => ORG_ROLES.map((r) => [a, r] as const)))("%s: org role %s of any org never grants it", (action, role) => {
    for (const orgId of [ORG, PLATFORM_RESOURCE.orgId]) {
      for (const kind of ["organization", PLATFORM_RESOURCE.kind]) {
        const req: AuthorizationRequest = {
          subject: { type: "user", id: OPERATOR },
          action,
          resource: { kind, orgId },
          context: { memberships: [fact(role, orgId), { kind: "platform_role", role: "platform_operator", scope: { kind: "platform", orgId } }] },
        };
        expect(authorize(req)).toMatchObject({ allow: false, reason: "platform_operator_required" });
      }
    }
  });

  test("no org role lists a platform action among its effective permissions", () => {
    for (const role of ORG_ROLES) {
      const res = listEffectivePermissions({ subject: { type: "user", id: CUSTOMER }, resource: { kind: "organization", orgId: ORG }, context: { memberships: [fact(role, ORG)] } });
      expect(res.permissions.filter((p) => p.action.startsWith("platform.") && p.allow)).toEqual([]);
    }
  });
});
