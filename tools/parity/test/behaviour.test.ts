import { test } from "node:test";
import assert from "node:assert/strict";
import { normalise } from "../behaviour/scenarios.ts";

test("normalise replaces fixture ids, digests, short ids and times, and sorts keys", () => {
  const ids = { application_uuid: "abc123def456ghi789jkl012" };
  const a = normalise({ z: 1, name: "/abc123def456ghi789jkl012-140000", image: "sha256:" + "a".repeat(64), at: "2026-11-23T03:00:00Z", id: "0123456789ab" }, ids) as Record<string, string>;
  assert.equal(a.name, "/<application_uuid>-140000");
  assert.equal(a.image, "sha256:<sha256>");
  assert.equal(a.at, "<time>");
  assert.equal(a.id, "<shortid>");
  assert.deepEqual(Object.keys(a), ["at", "id", "image", "name", "z"]);
});

test("two runs that differ only in generated values normalise to the same state", () => {
  const s1 = normalise({ label: "coolify.applicationUuid=u1aaaaaaaaaaaaaaaaaaaaaa" }, { application_uuid: "u1aaaaaaaaaaaaaaaaaaaaaa" });
  const s2 = normalise({ label: "coolify.applicationUuid=u2bbbbbbbbbbbbbbbbbbbbbb" }, { application_uuid: "u2bbbbbbbbbbbbbbbbbbbbbb" });
  assert.deepEqual(s1, s2);
});
