// DP-100: the models of the dashboard at / and of an environment's Clone page.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DASHBOARD_ITEM_LIMIT,
  countWord,
  dashboardProjects,
  dashboardServers,
  deploymentStatusMeta,
  deploymentsTitle,
  isValidSort,
  PROJECT_SORT_COLUMNS,
  projectHref,
  SERVER_SORT_COLUMNS,
  sortItems,
  strnatcasecmp,
  type DashboardProject,
  type DashboardServer,
} from "../src/lib/dashboard.ts";
import { CLONE_TYPES, cloneBody, destinationCount, plural, resourceCount, selectServer } from "../src/lib/clone-me.ts";

const project = (name: string, resourceCount = 0, description: string | null = null): DashboardProject => ({
  uuid: `u-${name}`, name, description, environmentCount: 1, resourceCount, onlyEnvironmentUuid: null, firstEnvironmentUuid: null,
});
const server = (name: string, status: string, description: string | null = null): DashboardServer => ({
  uuid: `s-${name}`, name, description, status, statusType: "success", isMetricsEnabled: false,
});

test("SORT_NATURAL | SORT_FLAG_CASE: numbers as numbers, letters case-folded", () => {
  assert.ok(strnatcasecmp("app2", "app10") < 0);
  assert.ok(strnatcasecmp("Beta", "alpha") > 0);
  assert.equal(strnatcasecmp("Shop", "shop"), 0);
  assert.ok(strnatcasecmp("", "a") < 0);
});

test("Dashboard::sortItems(): by name, then by the column (ties keep the name order), descending when asked", () => {
  const items = [project("web", 2), project("Api", 2), project("db10", 1), project("db9", 5)];
  assert.deepEqual(sortItems(items, "name-asc", (p, c) => (c === "resources" ? p.resourceCount : p.name)).map((p) => p.name), ["Api", "db9", "db10", "web"]);
  assert.deepEqual(sortItems(items, "name-desc", (p) => p.name).map((p) => p.name), ["web", "db10", "db9", "Api"]);
  // Equal counts keep the name order, also when descending (a stable sort).
  assert.deepEqual(dashboardProjects(items, "resources-desc").map((p) => p.name), ["db9", "Api", "web", "db10"]);
  assert.deepEqual(dashboardProjects(items, "resources-asc").map((p) => p.name), ["db10", "Api", "web"].concat(["db9"]));
  // A blank description sorts first.
  assert.deepEqual(dashboardProjects([project("b", 0, "zeta"), project("a", 0, null), project("c", 0, "alpha")], "description-asc").map((p) => p.name), ["a", "c", "b"]);
});

test("only the first eight projects and servers are shown, sorted", () => {
  const many = Array.from({ length: 11 }, (_, i) => project(`p${11 - i}`));
  assert.equal(DASHBOARD_ITEM_LIMIT, 8);
  assert.deepEqual(dashboardProjects(many, "name-asc").map((p) => p.name), ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
  const servers = [server("b", "Unreachable"), server("a", "Ready"), server("c", "Attention required")];
  assert.deepEqual(dashboardServers(servers, "status-asc").map((s) => s.name), ["c", "a", "b"]);
  assert.deepEqual(dashboardServers(servers, "status-desc").map((s) => s.name), ["b", "a", "c"]);
});

test("isValidSort(): a known column and asc or desc; the dashboard keeps its sort otherwise", () => {
  assert.equal(isValidSort("resources-desc", PROJECT_SORT_COLUMNS), true);
  assert.equal(isValidSort("status-asc", SERVER_SORT_COLUMNS), true);
  assert.equal(isValidSort("status-asc", PROJECT_SORT_COLUMNS), false);
  assert.equal(isValidSort("name", PROJECT_SORT_COLUMNS), false);
  assert.equal(isValidSort("name-up", PROJECT_SORT_COLUMNS), false);
});

test("a project opens its only environment, else the project; the cards' words", () => {
  assert.equal(projectHref({ uuid: "p", onlyEnvironmentUuid: "e" }), "/project/p/environment/e");
  assert.equal(projectHref({ uuid: "p", onlyEnvironmentUuid: null }), "/project/p");
  assert.equal(countWord(1, "environment", "environments"), "environment");
  assert.equal(countWord(0, "resource", "resources"), "resources");
});

test("$deploymentStatusMeta: Coolify's labels and badge types, headline() for the rest, Blocked for an image scan", () => {
  assert.deepEqual(deploymentStatusMeta({ status: "finished", imageScanBlocked: false }), ["Success", "success"]);
  assert.deepEqual(deploymentStatusMeta({ status: "in_progress", imageScanBlocked: false }), ["In progress", "warning"]);
  assert.deepEqual(deploymentStatusMeta({ status: "queued", imageScanBlocked: false }), ["Queued", "warning"]);
  assert.deepEqual(deploymentStatusMeta({ status: "failed", imageScanBlocked: false }), ["Failed", "error"]);
  assert.deepEqual(deploymentStatusMeta({ status: "cancelled-by-user", imageScanBlocked: false }), ["Cancelled", "neutral"]);
  assert.deepEqual(deploymentStatusMeta({ status: "skipped_by_rule", imageScanBlocked: false }), ["Skipped By Rule", "neutral"]);
  assert.deepEqual(deploymentStatusMeta({ status: "finished", imageScanBlocked: true }), ["Blocked", "error"]);
  assert.equal(deploymentsTitle(0), "Deployments");
  assert.equal(deploymentsTitle(2), "Recent deployments");
});

test("CloneMe::selectServer(): a choice, another one, and the same one again clears it", () => {
  const none = { server: null, destination: null };
  const first = selectServer(none, "s1", "d1");
  assert.deepEqual(first, { server: "s1", destination: "d1" });
  assert.deepEqual(selectServer(first, "s1", "d2"), { server: "s1", destination: "d2" });
  assert.deepEqual(selectServer(first, "s1", "d1"), none);
});

test("the Clone page's counts, words, buttons and payload", () => {
  const servers = [
    { uuid: "s1", name: "a", destinations: [{ uuid: "d1", name: "coolify" }, { uuid: "d2", name: "swarm" }] },
    { uuid: "s2", name: "b", destinations: [] },
  ];
  assert.equal(destinationCount(servers), 2);
  assert.equal(`${destinationCount(servers.slice(1))} ${plural("destination", 0)}`, "0 destinations");
  assert.equal(plural("resource", 1), "resource");
  const r = { uuid: "x", name: "x", description: null };
  assert.equal(resourceCount({ applications: [r], databases: [r, r], services: [] }), 3);
  assert.deepEqual(CLONE_TYPES.map(([, label]) => label), ["Clone to environment", "Clone to project"]);
  assert.deepEqual(cloneBody("project", "shop-clone", { server: "s1", destination: "d1" }, true), { type: "project", newName: "shop-clone", selectedDestination: "d1", cloneVolumeData: true });
  assert.deepEqual(cloneBody("environment", "x", { server: null, destination: null }, false).selectedDestination, null);
});
