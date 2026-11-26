// The server pages' models (DP-96, src/lib/server-pages.ts): Str::headline() as the views call it, the resource
// list of Server\Resources (its sorts, search and pages) and the status badges.
import { test } from "node:test";
import assert from "node:assert/strict";
import { headline, resourceStatusType, sentinelBadge, shownResources, type ServerResourceRow } from "../src/lib/server-pages.ts";

test("Str::headline() of a resource type and of a status", () => {
  assert.equal(headline("application"), "Application");
  assert.equal(headline("standalone-postgresql"), "Standalone Postgresql");
  assert.equal(headline("service"), "Service");
  // MB_CASE_TITLE starts a word after the colon.
  assert.equal(headline("running:healthy"), "Running:Healthy");
  assert.equal(headline("exited"), "Exited");
  assert.equal(headline("degraded:unhealthy"), "Degraded:Unhealthy");
  assert.equal(headline("in_sync"), "In Sync");
  assert.equal(headline(""), "");
});

const row = (name: string, over: Partial<ServerResourceRow> = {}): ServerResourceRow => ({ uuid: name, name, type: "application", status: "exited", project: "P", environment: "production", link: null, ...over });
const names = (rows: ServerResourceRow[]) => rows.map((r) => r.name);

test("Resources::render(): by name, naturally and without case", () => {
  const rows = [row("web10"), row("Web2"), row("api")];
  assert.deepEqual(names(shownResources(rows, "name_asc", "", 1, 10).rows), ["api", "Web2", "web10"]);
  assert.deepEqual(names(shownResources(rows, "name_desc", "", 1, 10).rows), ["web10", "Web2", "api"]);
});

test("Resources::render(): another column keeps the name order within equal values", () => {
  const rows = [row("b", { type: "service" }), row("c", { type: "application" }), row("a", { type: "service" })];
  assert.deepEqual(names(shownResources(rows, "type_asc", "", 1, 10).rows), ["c", "a", "b"]);
  assert.deepEqual(names(shownResources(rows, "type_desc", "", 1, 10).rows), ["a", "b", "c"]);
  // An unknown column sorts by name.
  assert.deepEqual(names(shownResources(rows, "bogus_asc", "", 1, 10).rows), ["a", "b", "c"]);
});

test("Resources::render(): the search matches the name only, without case", () => {
  const rows = [row("Frontend", { project: "api" }), row("api-server"), row("db")];
  const shown = shownResources(rows, "name_asc", "  API ", 1, 10);
  assert.deepEqual(names(shown.rows), ["api-server"]);
  assert.equal(shown.total, 1);
});

test("Resources::render(): pages of the size asked, clamped to 1–100 and to the pages there are", () => {
  const rows = Array.from({ length: 23 }, (_, i) => row(`r${String(i + 1).padStart(2, "0")}`));
  const second = shownResources(rows, "name_asc", "", 2, 10);
  assert.deepEqual([second.from, second.to, second.total, second.lastPage, second.rows.length], [11, 20, 23, 3, 10]);
  const beyond = shownResources(rows, "name_asc", "", 9, 10);
  assert.deepEqual([beyond.page, beyond.from, beyond.to], [3, 21, 23]);
  assert.equal(shownResources(rows, "name_asc", "", 1, 0).rows.length, 1);
  assert.equal(shownResources(rows, "name_asc", "", 1, 500).rows.length, 23);
  const none = shownResources([], "name_asc", "", 1, 10);
  assert.deepEqual([none.total, none.page, none.from, none.to], [0, 1, 0, 0]);
});

test("the status badges: a resource's, and Sentinel's", () => {
  assert.equal(resourceStatusType("running:healthy"), "success");
  assert.equal(resourceStatusType("exited"), "error");
  assert.equal(resourceStatusType("failed"), "error");
  assert.equal(resourceStatusType("starting:unknown"), "neutral");
  assert.deepEqual(sentinelBadge("waiting"), { label: "Waiting for first report", type: "neutral" });
  assert.deepEqual(sentinelBadge("in_sync"), { label: "In sync", type: "success" });
  assert.deepEqual(sentinelBadge("out_of_sync"), { label: "Out of sync", type: "warning" });
  assert.deepEqual(sentinelBadge("restarting"), { label: "Out of sync", type: "warning" });
});
