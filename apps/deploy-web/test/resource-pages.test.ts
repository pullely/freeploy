// DP-97: the models of the remaining resource pages and of the team's Tags page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { primaryStatus } from "../src/lib/primary-status.ts";
import { deploymentStatusLabel, filterTags, pageOfTags, plural, sortDeployments, TAG_SORT_OPTIONS } from "../src/lib/tags.ts";
import { pageFor } from "../src/routes.ts";

test("a database's or a service's primary server status, as destination.blade.php reads realStatus()", () => {
  assert.deepEqual(primaryStatus("running:healthy"), { label: "Running", type: "success" });
  assert.deepEqual(primaryStatus("exited:unhealthy"), { label: "Exited", type: "error" });
  assert.deepEqual(primaryStatus("exited"), { label: "Exited", type: "error" });
  assert.deepEqual(primaryStatus("starting:unknown"), { label: "Starting", type: "warning" });
  assert.deepEqual(primaryStatus("restarting"), { label: "Restarting", type: "warning" });
  assert.deepEqual(primaryStatus("degraded:unhealthy"), { label: "Degraded", type: "neutral" });
  assert.deepEqual(primaryStatus("removing_container"), { label: "Removing Container", type: "neutral" });
  assert.deepEqual(primaryStatus(""), { label: "Unknown", type: "neutral" });
  assert.deepEqual(primaryStatus(":x"), { label: "Unknown", type: "neutral" });
});

test("the Tags list: a case-insensitive search, its sorts with the name as the tie-breaker, and its pages", () => {
  const tag = (name: string, applicationsCount: number, servicesCount: number) => ({ id: name, name, applicationsCount, servicesCount, resourceCount: applicationsCount + servicesCount });
  const tags = [tag("prod", 2, 1), tag("api", 0, 0), tag("Beta", 1, 0), tag("web", 1, 2)];
  assert.deepEqual(filterTags(tags, "", "name-asc").map((t) => t.name), ["api", "Beta", "prod", "web"]);
  assert.deepEqual(filterTags(tags, "", "name-desc").map((t) => t.name), ["web", "prod", "Beta", "api"]);
  assert.deepEqual(filterTags(tags, "", "resources-desc").map((t) => t.name), ["prod", "web", "Beta", "api"]);
  assert.deepEqual(filterTags(tags, "", "services-desc").map((t) => t.name), ["web", "prod", "api", "Beta"]);
  assert.deepEqual(filterTags(tags, " BE ", "name-asc").map((t) => t.name), ["Beta"]);
  assert.deepEqual(TAG_SORT_OPTIONS.map((o) => o.label), ["Name A–Z", "Name Z–A", "Most resources"]);
  const many = Array.from({ length: 25 }, (_, i) => tag(`t${String(i).padStart(2, "0")}`, 0, 0));
  const last = pageOfTags(many, 3, 12);
  assert.deepEqual({ ...last, items: last.items.map((t) => t.name) }, { page: 3, totalPages: 3, items: ["t24"], rangeStart: 25, rangeEnd: 25 });
  assert.equal(pageOfTags(many, 9, 12).page, 3);
  assert.deepEqual(pageOfTags([], 1, 12), { page: 1, totalPages: 1, items: [], rangeStart: 0, rangeEnd: 0 });
});

test("a tag's active deployments: in id order, or by a column as strcasecmp() then id", () => {
  const d = (id: string, applicationName: string, serverName: string, status: string) => ({ id, applicationName, deploymentUrl: null, pullRequestId: 0, serverName, status });
  const all = [d("3", "beta", "srv-b", "queued"), d("1", "Alpha", "srv-a", "in_progress"), d("2", "alpha", "srv-c", "queued")];
  assert.deepEqual(sortDeployments(all, null).map((x) => x.id), ["3", "1", "2"]);
  assert.deepEqual(sortDeployments(all, "resource-asc").map((x) => x.id), ["1", "2", "3"]);
  assert.deepEqual(sortDeployments(all, "resource-desc").map((x) => x.id), ["3", "1", "2"]);
  assert.deepEqual(sortDeployments(all, "server-desc").map((x) => x.id), ["2", "3", "1"]);
  assert.deepEqual(sortDeployments(all, "status-asc").map((x) => x.id), ["1", "2", "3"]);
  assert.equal(deploymentStatusLabel("in_progress"), "In Progress");
  assert.equal(plural("tag", 1), "tag");
  assert.equal(plural("tag", 2), "tags");
});

test("DP-97: /tags/{tagName?} is tags.show; the tags canvas is not ported", () => {
  assert.equal(pageFor("/tags"), "tags.show");
  assert.equal(pageFor("/tags/"), "tags.show");
  assert.equal(pageFor("/tags/production"), "tags.show");
  assert.equal(pageFor("/tags/a%20b/"), "tags.show");
  assert.equal(pageFor("/tags/production/more"), "not-ported");
  assert.equal(pageFor("/canvas/tags"), "not-ported");
});
