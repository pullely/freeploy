// The role permission matrix (DP-69, freeploy-coolify-parity DP10: "role permission matrix tests match
// Coolify's policies, row for row"). fixtures/role-matrix/goldens.json is what coollabsio/coolify@91b7e3e's
// own policies answer (fixtures/role-matrix/emit.php asks Laravel's Gate, see its README.md) for each
// ability of the ten policies Freeploy has ported pages of, for a team's owner, admin and member (Coolify
// has no other role; its member has the default grants, team-wide Read).
//
// Each row names the action Freeploy's API asks policy-worker for that ability, and this test asks the
// policy-worker (its POST /v1/internal/policy/authorize, the deployed decision) for each role as
// Freeploy stores it: Coolify's owner, admin and member are Freeploy's owner, admin and builder. An
// ability that needs several actions (a member's role change and removal) passes when all agree. An
// ability whose route Freeploy does not have yet is SKIPPED with the reason, and counted as skipped,
// never as a pass.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { route } from "@policy-worker/router";
import type { Env } from "@policy-worker/env";

const dir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/role-matrix");
type Role = "owner" | "admin" | "member";
interface Goldens {
  coolify: string;
  roles: Role[];
  matrix: Record<string, Record<Role, boolean>>;
}
const goldens = JSON.parse(readFileSync(join(dir, "goldens.json"), "utf8")) as Goldens;

/** Coolify's role → the role Freeploy stores for it (packages/policy-engine, apps/membership-worker team.ts). */
export const FREEPLOY_ROLE: Record<Role, string> = { owner: "owner", admin: "admin", member: "builder" };

const READ = ["deploy.resource.read"];
const WRITE = ["deploy.resource.write"];
type Row = { actions: string[]; route: string } | { skipped: string };
const NO_ROUTE = (what: string): Row => ({ skipped: `no route yet: ${what}` });

/** Every ability of goldens.json: what Freeploy asks for it, and where. */
export const ROWS: Record<string, Row> = {
  "servers.viewAny": { actions: READ, route: "GET /deploy/servers" },
  "servers.view": { actions: READ, route: "GET /deploy/servers/{uuid}" },
  "servers.viewSharedVariables": { actions: READ, route: "GET /deploy/shared-variables/server/{uuid}" },
  "servers.create": { actions: WRITE, route: "POST /deploy/servers" },
  "servers.placeResource": { actions: WRITE, route: "POST /deploy/applications, /databases, /services (a destination on the server)" },
  "servers.update": { actions: WRITE, route: "PATCH /deploy/servers/{uuid}" },
  "servers.transfer": NO_ROUTE("server transfer (DP11)"),
  "servers.delete": { actions: WRITE, route: "DELETE /deploy/servers/{uuid}" },
  "servers.manageProxy": NO_ROUTE("the proxy pages (start, stop, restart)"),
  "servers.manageSentinel": { actions: WRITE, route: "POST /deploy/servers/{uuid}/sentinel/*" },
  "servers.viewSentinel": { actions: WRITE, route: "GET /deploy/servers/{uuid}/sentinel" },
  "servers.manageCaCertificate": { actions: WRITE, route: "PATCH /deploy/servers/{uuid}/ca-certificate, POST …/regenerate" },
  "servers.viewSecurity": NO_ROUTE("the server security pages (patches, terminal access)"),
  "private-keys.viewAny": { actions: READ, route: "GET /deploy/private-keys" },
  "private-keys.view": { actions: READ, route: "GET /deploy/private-keys/{uuid}" },
  "private-keys.create": { actions: WRITE, route: "POST /deploy/private-keys" },
  "private-keys.update": { actions: WRITE, route: "PATCH /deploy/private-keys/{uuid}" },
  "private-keys.delete": { actions: WRITE, route: "DELETE /deploy/private-keys/{uuid}" },
  "projects.viewAny": { actions: READ, route: "GET /deploy/projects" },
  "projects.view": { actions: READ, route: "GET /deploy/projects/{uuid}" },
  "projects.viewSharedVariables": { actions: READ, route: "GET /deploy/shared-variables/project/{uuid}" },
  "projects.create": { actions: WRITE, route: "POST /deploy/projects" },
  "projects.update": { actions: WRITE, route: "PATCH /deploy/projects/{uuid}" },
  "projects.delete": { actions: WRITE, route: "DELETE /deploy/projects/{uuid}" },
  "environments.viewAny": { actions: READ, route: "GET /deploy/projects/{uuid}/environments" },
  "environments.view": { actions: READ, route: "GET /deploy/projects/{uuid}/environments/{uuid}" },
  "environments.viewSharedVariables": { actions: READ, route: "GET /deploy/shared-variables/environment/{project}/{environment}" },
  "environments.create": { actions: WRITE, route: "POST /deploy/projects/{uuid}/environments" },
  "environments.update": { actions: WRITE, route: "PATCH /deploy/projects/{uuid}/environments/{uuid}" },
  "environments.delete": { actions: WRITE, route: "DELETE /deploy/projects/{uuid}/environments/{uuid}" },
  "applications.viewAny": { actions: READ, route: "GET /deploy/projects/{uuid}/environments/{uuid} (its resources)" },
  "applications.view": { actions: READ, route: "GET /deploy/applications/{uuid}" },
  "applications.create": { actions: WRITE, route: "POST /deploy/applications" },
  "applications.update": { actions: WRITE, route: "PATCH /deploy/applications/{uuid}[/…]" },
  "applications.delete": { actions: WRITE, route: "DELETE /deploy/applications/{uuid}" },
  "applications.uploadBackup": NO_ROUTE("backup uploads"),
  "applications.deploy": { actions: WRITE, route: "POST /deploy/applications/{uuid}/deployments" },
  "applications.viewSensitive": { actions: WRITE, route: "GET /deploy/applications/{uuid}/environment-variables (values shown to writers)" },
  "applications.manageEnvironment": { actions: WRITE, route: "POST|PATCH|DELETE /deploy/applications/{uuid}/environment-variables" },
  "databases.viewAny": { actions: READ, route: "GET /deploy/projects/{uuid}/environments/{uuid} (its resources)" },
  "databases.view": { actions: READ, route: "GET /deploy/databases/{uuid}" },
  "databases.create": { actions: WRITE, route: "POST /deploy/databases" },
  "databases.update": { actions: WRITE, route: "PATCH /deploy/databases/{uuid}" },
  "databases.delete": { actions: WRITE, route: "DELETE /deploy/databases/{uuid}" },
  "databases.manage": { actions: WRITE, route: "POST /deploy/databases/{uuid}/{start,stop,restart}" },
  "databases.uploadBackup": NO_ROUTE("backup uploads"),
  "databases.manageBackups": { actions: WRITE, route: "POST|PATCH|DELETE /deploy/databases/{uuid}/backups" },
  "databases.viewSensitive": { actions: WRITE, route: "GET /deploy/databases/{uuid} (credentials shown to writers)" },
  "databases.manageEnvironment": { actions: WRITE, route: "POST|PATCH|DELETE /deploy/databases/{uuid}/environment-variables" },
  "services.viewAny": { actions: READ, route: "GET /deploy/projects/{uuid}/environments/{uuid} (its resources)" },
  "services.view": { actions: READ, route: "GET /deploy/services/{uuid}" },
  "services.create": { actions: WRITE, route: "POST /deploy/services" },
  "services.update": NO_ROUTE("a service's configuration pages (DP-66)"),
  "services.delete": NO_ROUTE("a service's danger zone"),
  "services.stop": NO_ROUTE("a service's start and stop"),
  "services.viewSensitive": NO_ROUTE("a service's environment variables"),
  "services.manageEnvironment": NO_ROUTE("a service's environment variables"),
  "services.uploadBackup": NO_ROUTE("backup uploads"),
  "services.deploy": NO_ROUTE("a service's deployment"),
  "storages.viewAny": { actions: READ, route: "GET /deploy/storages" },
  "storages.view": { actions: READ, route: "GET /deploy/storages/{uuid}" },
  "storages.create": { actions: WRITE, route: "POST /deploy/storages" },
  "storages.update": { actions: WRITE, route: "PATCH /deploy/storages/{uuid}" },
  "storages.delete": { actions: WRITE, route: "DELETE /deploy/storages/{uuid}" },
  "storages.validateConnection": { actions: WRITE, route: "POST /deploy/storages/{uuid}/validate" },
  "notifications.view": { actions: READ, route: "GET /deploy/notifications/{channel}" },
  "notifications.update": { actions: WRITE, route: "PATCH /deploy/notifications/{channel}" },
  "notifications.manage": { actions: WRITE, route: "PATCH /deploy/notifications/{channel}" },
  "notifications.sendTest": { actions: WRITE, route: "POST /deploy/notifications/{channel}/test" },
  "team.viewAny": NO_ROUTE("the team list (Freeploy lists the user's organizations without a policy check)"),
  "team.view": { actions: ["deploy.team.read"], route: "GET /team, GET /team/members (membership-worker)" },
  "team.viewSharedVariables": { actions: READ, route: "GET /deploy/shared-variables/team" },
  "team.create": NO_ROUTE("a new team from the console (Team\\Create)"),
  "team.update": { actions: ["organization.settings.update"], route: "PATCH /team (membership-worker)" },
  "team.delete": NO_ROUTE("the team's danger zone (an org cannot be deleted yet)"),
  "team.manageMembers": {
    actions: ["organization.member.update_role", "organization.member.remove"],
    route: "PATCH|DELETE /team/members/{member} (membership-worker)",
  },
  "team.viewAdmin": NO_ROUTE("Team → Admin View (an instance admin's page, DP12)"),
  "team.manageInvitations": {
    actions: ["organization.invitation.create", "organization.invitation.list", "organization.invitation.revoke"],
    route: "GET|POST /team/invitations, DELETE /team/invitations/{invitation} (membership-worker)",
  },
};

const env: Env = { ENVIRONMENT: "test" };

async function decide(action: string, role: string): Promise<boolean> {
  const body = {
    subject: { type: "user", id: "usr_matrix" },
    action,
    resource: { kind: "organization", orgId: "org_matrix" },
    context: { memberships: [{ kind: "role_assignment", role, scope: { kind: "organization", orgId: "org_matrix" } }] },
  };
  const res = await route(new Request("http://localhost/v1/internal/policy/authorize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env);
  expect(res.status).toBe(200);
  const json = (await res.json()) as { data: { allow: boolean; reason: string } };
  expect(json.data.reason).not.toBe("unknown_action");
  return json.data.allow;
}

const abilities = Object.keys(goldens.matrix);
const compared = abilities.filter((a) => ROWS[a] && "actions" in ROWS[a]!);
const skipped = abilities.filter((a) => ROWS[a] && "skipped" in ROWS[a]!);

describe("the role permission matrix: Freeploy against Coolify's policies", () => {
  test("the goldens are Coolify 91b7e3e's, for its three roles", () => {
    expect(goldens.coolify).toBe("91b7e3e");
    expect(goldens.roles).toEqual(["owner", "admin", "member"]);
  });

  test("every ability of the goldens has a row, and every row an ability", () => {
    expect(abilities.filter((a) => !ROWS[a])).toEqual([]);
    expect(Object.keys(ROWS).filter((a) => !goldens.matrix[a])).toEqual([]);
  });

  test.each(compared.flatMap((ability) => goldens.roles.map((role) => [ability, role] as const)))("%s, %s", async (ability, role) => {
    const row = ROWS[ability] as { actions: string[] };
    const coolify = goldens.matrix[ability]![role];
    for (const action of row.actions) expect([action, await decide(action, FREEPLOY_ROLE[role])]).toEqual([action, coolify]);
  });

  // The count is part of the result: a row moves from skipped to compared when its route lands.
  test("the comparison covers 62 abilities × 3 roles, and 16 abilities are skipped for want of a route", () => {
    expect(abilities.length).toBe(78);
    expect(compared.length).toBe(62);
    expect(skipped).toEqual([
      "servers.transfer",
      "servers.manageProxy",
      "servers.viewSecurity",
      "applications.uploadBackup",
      "databases.uploadBackup",
      "services.update",
      "services.delete",
      "services.stop",
      "services.viewSensitive",
      "services.manageEnvironment",
      "services.uploadBackup",
      "services.deploy",
      "team.viewAny",
      "team.create",
      "team.delete",
      "team.viewAdmin",
    ]);
  });

  // Freeploy has two org roles Coolify does not: viewer reads as a member does, billing_admin sees
  // nothing of the deploy console. They are not in Coolify's matrix; their decisions are pinned here.
  test.each([
    ["viewer", true, false],
    ["billing_admin", false, false],
  ])("%s (Freeploy only): reads %s, changes %s", async (role, reads, changes) => {
    for (const a of compared) {
      const row = ROWS[a] as { actions: string[] };
      const isRead = row.actions.every((x) => x === "deploy.resource.read" || x === "deploy.team.read");
      for (const action of row.actions) expect([a, await decide(action, role)]).toEqual([a, isRead ? reads : changes]);
    }
  });
});
