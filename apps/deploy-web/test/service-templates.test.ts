// The New Resource page's service list (DP-59): Select's search, sort and category filter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { filterCategories, filterServices, isOneClickType, oneClickType, servicePath, serviceUuidFromPath, templateDescription, templateStatus, type ServiceTemplate } from "../src/lib/service-templates.ts";
import { pageFor } from "../src/routes.ts";

const service = (over: Partial<ServiceTemplate>): ServiceTemplate => ({
  id: "x",
  name: "X",
  docsSlug: "x",
  templateLastUpdated: null,
  website: null,
  logo: "/svgs/x.svg",
  logo_default_url: "/svgs/default.webp",
  documentation: "https://example.com",
  slogan: "",
  category: null,
  ...over,
});

const services = [
  service({ id: "umami", name: "Umami", slogan: "Privacy-focused analytics.", category: "analytics" }),
  service({ id: "n8n", name: "N8N", slogan: "Workflow automation.", category: "automation, AI" }),
  service({ id: "appwrite", name: "Appwrite", slogan: "A backend platform.", category: "backend" }),
  service({ id: "plain", name: "plain", slogan: "", description: "Analytics for the terminal.", category: null }),
];

test("without a search or a category every service shows, sorted by name", () => {
  assert.deepEqual(filterServices(services, "", "").map((s) => s.id), [...services].sort((a, b) => a.name.localeCompare(b.name)).map((s) => s.id));
  assert.equal(filterServices(services, "   ", "").length, 4);
});

test("the search looks in the name, the description and the slogan, ignoring case", () => {
  assert.deepEqual(filterServices(services, "ANALYTICS", "").map((s) => s.id), ["plain", "umami"]);
  assert.deepEqual(filterServices(services, "n8", "").map((s) => s.id), ["n8n"]);
  assert.deepEqual(filterServices(services, "nothing like it", ""), []);
});

test("the category matches one of a service's comma-separated categories, ignoring case", () => {
  assert.deepEqual(filterServices(services, "", "AI").map((s) => s.id), ["n8n"]);
  assert.deepEqual(filterServices(services, "", "automation").map((s) => s.id), ["n8n"]);
  assert.deepEqual(filterServices(services, "", "auto"), []);
  assert.deepEqual(filterServices(services, "workflow", "backend"), []);
});

test("the category options are searched without case", () => {
  assert.deepEqual(filterCategories(["AI", "analytics", "backend"], ""), ["AI", "analytics", "backend"]);
  assert.deepEqual(filterCategories(["AI", "analytics", "backend"], "a"), ["AI", "analytics", "backend"]);
  assert.deepEqual(filterCategories(["AI", "analytics", "backend"], "AN"), ["analytics"]);
});

test("a card says when its template was updated, and what it deploys", () => {
  assert.equal(templateStatus({ templateLastUpdated: "Nov 16, 2026 07:50" }), "Updated Nov 16, 2026 07:50");
  assert.equal(templateStatus({ templateLastUpdated: null }), "Template ready");
  assert.equal(templateDescription({ slogan: "S", description: "D" }), "S");
  assert.equal(templateDescription({ slogan: "", description: "D" }), "D");
  assert.equal(templateDescription({ slogan: "" }), "Deploy this service with a ready-to-use template.");
});

test("a service is created by its type and opened by its path", () => {
  assert.equal(oneClickType("umami"), "one-click-service-umami");
  assert.equal(isOneClickType("one-click-service-umami"), true);
  assert.equal(isOneClickType("docker-image"), false);
  assert.equal(isOneClickType(null), false);
  const path = servicePath("prj", "env", "svc");
  assert.equal(path, "/project/prj/environment/env/service/svc");
  assert.equal(serviceUuidFromPath(path), "svc");
  assert.equal(pageFor(path), "project.service.configuration");
  assert.equal(pageFor(`${path}/`), "project.service.configuration");
});
