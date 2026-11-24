import { test } from "node:test";
import assert from "node:assert/strict";
import { certificateStatus } from "../src/lib/certificate.ts";

const NOW = Date.parse("2026-11-24T12:00:00Z");

test("the CA certificate badge follows Coolify's view: Expired, Expiring soon within 30 days, else Valid", () => {
  assert.deepEqual(certificateStatus("2036-11-21T21:52:24.000Z", NOW), { label: "Valid", type: "success" });
  assert.deepEqual(certificateStatus("2026-12-24T12:00:00.000Z", NOW), { label: "Valid", type: "success" });
  assert.deepEqual(certificateStatus("2026-12-24T11:59:59.000Z", NOW), { label: "Expiring soon", type: "error" });
  assert.deepEqual(certificateStatus("2026-11-24T12:00:00.000Z", NOW), { label: "Expiring soon", type: "error" });
  assert.deepEqual(certificateStatus("2026-11-24T11:59:59.000Z", NOW), { label: "Expired", type: "error" });
});
