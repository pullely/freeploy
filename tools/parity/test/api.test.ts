import { test } from "node:test";
import assert from "node:assert/strict";
import { validate } from "../api/schema.ts";
import { fillPath, shape } from "../api/contract.ts";

const doc = { components: { schemas: { Project: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" }, name: { type: "string" }, description: { type: ["string", "null"] } } } } } };

test("schema: a valid list of projects passes; a wrong type and a missing field fail", () => {
  const s = { type: "array", items: { $ref: "#/components/schemas/Project" } };
  assert.deepEqual(validate([{ uuid: "a", name: "x", description: null }], s, doc), []);
  assert.ok(validate([{ uuid: 1 }], s, doc).length);
  assert.ok(validate([{ name: "x" }], s, doc).some((e) => e.endsWith("uuid: required")));
});

test("fillPath maps a bare {uuid} by its resource segment", () => {
  assert.deepEqual(fillPath("/projects/{uuid}", { project_uuid: "p" }), { url: "/projects/p", missing: [] });
  assert.deepEqual(fillPath("/security/keys/{uuid}", { private_key_uuid: "k" }), { url: "/security/keys/k", missing: [] });
  assert.deepEqual(fillPath("/projects/{uuid}/{environment_name_or_uuid}", { project_uuid: "p", environment_uuid: "e" }), { url: "/projects/p/e", missing: [] });
  assert.equal(fillPath("/servers/{uuid}", {}).url, null);
});

test("shape ignores values but not keys or types", () => {
  assert.deepEqual(shape({ b: 1, a: "x" }), shape({ a: "y", b: 2 }));
  assert.notDeepEqual(shape({ a: "x" }), shape({ a: 1 }));
  assert.notDeepEqual(shape({ a: "x" }), shape({ a: "x", c: true }));
});
