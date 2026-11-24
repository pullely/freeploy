import { test } from "node:test";
import assert from "node:assert/strict";
import { pageFor } from "../src/routes.ts";
import { showMonthlyReminder } from "../src/lib/reminder.ts";
import { summarize } from "../src/lib/api.ts";

test("Laravel's validation summary: the first error and how many more", () => {
  assert.equal(summarize(["a"]), "a");
  assert.equal(summarize(["a", "b"]), "a (and 1 more error)");
  assert.equal(summarize(["a", "b", "c"]), "a (and 2 more errors)");
});

test("routes/web.php paths map to ported pages; the rest are not ported", () => {
  assert.equal(pageFor("/login"), "login");
  assert.equal(pageFor("/reset-password/abc"), "reset-password");
  assert.equal(pageFor("/profile/appearance"), "profile.appearance");
  assert.equal(pageFor("/profile/appearance/"), "profile.appearance");
  assert.equal(pageFor("/profile"), "profile");
  assert.equal(pageFor("/profile/nope"), "not-ported");
  assert.equal(pageFor("/user/confirm-password"), "password.confirm");
  assert.equal(pageFor("/two-factor-challenge"), "two-factor.login");
});

test("a dismissed reminder stays hidden for the rest of the calendar month", () => {
  const now = new Date(2026, 10, 24);
  assert.equal(showMonthlyReminder(null, now), true);
  assert.equal(showMonthlyReminder("false", now), true);
  assert.equal(showMonthlyReminder("nope", now), true);
  assert.equal(showMonthlyReminder(String(new Date(2026, 10, 1).getTime()), now), false);
  assert.equal(showMonthlyReminder(String(new Date(2026, 9, 30).getTime()), now), true);
  assert.equal(showMonthlyReminder(String(new Date(2025, 10, 24).getTime()), now), true);
});

import { ago } from "../src/lib/ago.ts";

test("Carbon's diffForHumans for past times", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  assert.equal(ago("2026-11-24T11:59:30Z", now), "30 seconds ago");
  assert.equal(ago("2026-11-24T11:59:00Z", now), "1 minute ago");
  assert.equal(ago("2026-11-24T09:00:00Z", now), "3 hours ago");
  assert.equal(ago("2026-11-17T12:00:00Z", now), "1 week ago");
});
