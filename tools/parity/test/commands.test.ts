import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPorts } from "../commands/check.ts";

const esc = (v: string) => "'" + v.replace(/'/g, "'\\''") + "'";
const cases = [
  { id: "esc.a", fn: "escapeShellValue", args: ["it's"] },
  { id: "esc.b", fn: "escapeShellValue", args: ["x"] },
  { id: "other", fn: "unported", args: [] },
];
const goldens = { "esc.a": { ok: true, value: "'it'\\''s'" }, "esc.b": { ok: true, value: "'x'" }, other: { ok: true, value: 1 } };

test("a correct port verifies, a wrong one fails, an unported helper is pending", () => {
  const ok = checkPorts(cases, goldens, { escapeShellValue: esc as never });
  assert.deepEqual(ok.map((r) => r.status), ["verified", "verified", "pending"]);
  const bad = checkPorts(cases, goldens, { escapeShellValue: ((v: string) => `'${v}'`) as never });
  assert.equal(bad[0].status, "fail");
});

test("one byte of difference fails", () => {
  const r = checkPorts([cases[1]], { "esc.b": { ok: true, value: "'x' " } }, { escapeShellValue: esc as never });
  assert.equal(r[0].status, "fail");
});
