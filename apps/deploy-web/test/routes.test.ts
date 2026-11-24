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
  assert.equal(pageFor("/verify"), "verify.email");
  assert.equal(pageFor("/profile/passkeys/confirm"), "profile.passkeys.confirm");
  assert.equal(pageFor("/email/verify/usr_1/abc"), "verify.verify");
  assert.equal(pageFor("/security/private-key"), "security.private-key.index");
  assert.equal(pageFor("/security/private-key/"), "security.private-key.index");
  assert.equal(pageFor("/security/private-key/abc123def456ghi789jkl012"), "security.private-key.show");
  assert.equal(pageFor("/security/private-key/abc/rotate"), "not-ported");
  assert.equal(pageFor("/security/cloud-tokens"), "security.cloud-tokens");
  assert.equal(pageFor("/security/cloud-tokens/"), "security.cloud-tokens");
  assert.equal(pageFor("/security/cloud-tokens/abc123def456ghi789jkl012"), "security.cloud-tokens.show");
  assert.equal(pageFor("/security/cloud-tokens/abc/validate"), "not-ported");
  assert.equal(pageFor("/security/cloud-init-scripts"), "security.cloud-init-scripts");
  assert.equal(pageFor("/security/cloud-init-scripts/abc123def456ghi789jkl012/"), "security.cloud-init-scripts.show");
  assert.equal(pageFor("/security/integration-tokens"), "not-ported");
  assert.equal(pageFor("/security/api-tokens"), "not-ported");
  assert.equal(pageFor("/servers"), "server.index");
  assert.equal(pageFor("/servers/"), "server.index");
  assert.equal(pageFor("/servers/new"), "server.create");
  assert.equal(pageFor("/servers/new/manual"), "server.create.manual");
  assert.equal(pageFor("/servers/new/hetzner"), "not-ported");
  assert.equal(pageFor("/servers/canvas"), "not-ported");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012"), "server.show");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/private-key"), "server.private-key");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/cloud-provider-token"), "server.cloud-provider-token");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/danger"), "server.delete");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/proxy"), "not-ported");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/advanced"), "server.advanced");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/docker-cleanup"), "server.docker-cleanup");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/log-drains/"), "server.log-drains");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/swarm"), "server.swarm");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/sentinel"), "server.sentinel");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/sentinel/logs"), "not-ported");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/destinations"), "server.destinations");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/destinations/new"), "not-ported");
  assert.equal(pageFor("/destinations"), "destination.index");
  assert.equal(pageFor("/destinations/"), "destination.index");
  assert.equal(pageFor("/destination"), "not-ported");
  assert.equal(pageFor("/destination/abc123def456ghi789jkl012"), "destination.show");
  assert.equal(pageFor("/destination/abc123def456ghi789jkl012/danger"), "destination.danger");
  assert.equal(pageFor("/destination/abc123def456ghi789jkl012/resources/"), "destination.resources");
  assert.equal(pageFor("/destination/abc123def456ghi789jkl012/resources/more"), "not-ported");
});

test("the project and environment routes map to their pages; canvas, clone and new are not ported", () => {
  const project = "/project/abc123def456ghi789jkl012";
  const environment = `${project}/environment/mno345pqr678stu901vwx234`;
  assert.equal(pageFor("/projects"), "project.index");
  assert.equal(pageFor("/projects/"), "project.index");
  assert.equal(pageFor("/projects/canvas"), "not-ported");
  assert.equal(pageFor(project), "project.show");
  assert.equal(pageFor(`${project}/`), "project.show");
  assert.equal(pageFor(`${project}/edit`), "project.edit");
  assert.equal(pageFor(`${project}/canvas`), "not-ported");
  assert.equal(pageFor(`${project}/icon`), "not-ported");
  assert.equal(pageFor(`${project}/environment`), "not-ported");
  assert.equal(pageFor(environment), "project.resource.index");
  assert.equal(pageFor(`${environment}/`), "project.resource.index");
  assert.equal(pageFor(`${environment}/edit`), "project.environment.edit");
  assert.equal(pageFor(`${environment}/new`), "not-ported");
  assert.equal(pageFor(`${environment}/clone`), "not-ported");
  assert.equal(pageFor(`${environment}/canvas`), "not-ported");
  assert.equal(pageFor(`${environment}/application/app1`), "not-ported");
  assert.equal(pageFor("/shared-variables/projects"), "not-ported");
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

import { hexToOklch, parseCustomTheme, serializeCustomTheme, readableTextOn, themeAccentForeground } from "../src/lib/custom-theme.ts";

test("the custom theme engine matches Coolify's numbers", () => {
  // Coolify's default accent, as base.blade.php hard-codes it.
  assert.equal(hexToOklch("#6b16ed"), "oklch(49.65% 0.2709 289.33)");
  assert.equal(themeAccentForeground("#6b16ed"), "oklch(100% 0 0)");
  assert.equal(readableTextOn("#ffffff"), "#18181b");
  assert.equal(readableTextOn("#0a0a0a"), "#f4f4f5");
  const nord = parseCustomTheme("#2e3440, #4c566a,#88c0d0 #3b4252")!;
  assert.equal(serializeCustomTheme(nord), "#2e3440,#4c566a,#88c0d0,#3b4252");
  assert.equal(parseCustomTheme("#fff,#000"), null);
  assert.equal(parseCustomTheme("#fff,#000,#abc,#123")!.selected, "#000000");
});

import { kebab } from "../src/lib/kebab.ts";

test("a new destination is named as Str::kebab names it", () => {
  assert.equal(kebab("prod-1-k3j2abc"), "prod-1-k3j2abc");
  assert.equal(kebab("My Server-k3j2abc"), "my-server-k3j2abc");
  assert.equal(kebab("buildBox-net"), "build-box-net");
});
