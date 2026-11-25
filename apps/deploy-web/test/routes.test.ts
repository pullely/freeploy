import { test } from "node:test";
import assert from "node:assert/strict";
import { pageFor } from "../src/routes.ts";
import { showMonthlyReminder } from "../src/lib/reminder.ts";
import { summarize } from "../src/lib/api.ts";
import { splitPastedImageName } from "../src/lib/docker-image.ts";

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
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/ca-certificate"), "server.ca-certificate");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/ca-certificate/"), "server.ca-certificate");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/ca-certificate/regenerate"), "not-ported");
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
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/registries"), "server.registries");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/registries/ghcr.io"), "not-ported");
  assert.equal(pageFor("/registries"), "registries.index");
  assert.equal(pageFor("/registries/"), "registries.index");
  assert.equal(pageFor("/registries/ghcr.io"), "not-ported");
  assert.equal(pageFor("/destinations"), "destination.index");
  assert.equal(pageFor("/destinations/"), "destination.index");
  assert.equal(pageFor("/destination"), "not-ported");
  assert.equal(pageFor("/destination/abc123def456ghi789jkl012"), "destination.show");
  assert.equal(pageFor("/destination/abc123def456ghi789jkl012/danger"), "destination.danger");
  assert.equal(pageFor("/destination/abc123def456ghi789jkl012/resources/"), "destination.resources");
  assert.equal(pageFor("/destination/abc123def456ghi789jkl012/resources/more"), "not-ported");
});

test("the project and environment routes map to their pages; canvas and clone are not ported", () => {
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
  assert.equal(pageFor(`${environment}/new`), "project.resource.create");
  assert.equal(pageFor(`${environment}/new/`), "project.resource.create");
  assert.equal(pageFor(`${environment}/new/more`), "not-ported");
  assert.equal(pageFor(`${environment}/clone`), "not-ported");
  assert.equal(pageFor(`${environment}/canvas`), "not-ported");
});

test("an application's configuration routes map to General, Domains, Advanced, Healthcheck, Resource Limits, Persistent Storage, Tags, Resource Operations, the Danger Zone, Git Source, Servers, Webhooks, Scheduled Tasks and Rollback; its other pages are not ported", () => {
  const application = "/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234/application/yza567bcd890efg123hij456";
  assert.equal(pageFor(application), "project.application.configuration");
  assert.equal(pageFor(`${application}/`), "project.application.configuration");
  for (const page of ["domains", "advanced", "healthcheck", "resource-limits", "persistent-storage", "tags", "resource-operations", "danger", "source", "servers", "webhooks", "scheduled-tasks", "rollback"]) {
    assert.equal(pageFor(`${application}/${page}`), `project.application.${page}`, page);
    assert.equal(pageFor(`${application}/${page}/`), `project.application.${page}`, page);
    assert.equal(pageFor(`${application}/${page}/more`), "not-ported", page);
  }
  // Every other entry of the configuration menu.
  for (const page of [
    "swarm", "logs", "terminal", "files", "metrics", "analytics",
    "vulnerabilities", "preview-deployments", "backups", "maintenance",
  ]) {
    assert.equal(pageFor(`${application}/${page}`), "not-ported", page);
  }
  // The deployment history and one deployment's logs.
  assert.equal(pageFor(`${application}/deployment`), "project.application.deployment.index");
  assert.equal(pageFor(`${application}/deployment/`), "project.application.deployment.index");
  assert.equal(pageFor(`${application}/deployment/klm789nop012qrs345tuv678`), "project.application.deployment.show");
  assert.equal(pageFor(`${application}/deployment/klm789nop012qrs345tuv678/`), "project.application.deployment.show");
  assert.equal(pageFor(`${application}/deployment/klm789nop012qrs345tuv678/more`), "not-ported");
  assert.equal(pageFor(`${application}/environment-variables`), "project.application.environment-variables");
  assert.equal(pageFor(`${application}/environment-variables/`), "project.application.environment-variables");
  assert.equal(pageFor(`${application}/environment-variables/more`), "not-ported");
  assert.equal(pageFor("/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234/application"), "not-ported");
  assert.equal(pageFor("/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234/database"), "not-ported");
  // A service has its first page (DP-59); the pages below it are not ported.
  assert.equal(pageFor("/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234/service/svc1"), "project.service.configuration");
  assert.equal(pageFor("/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234/service/svc1/environment-variables"), "not-ported");
  assert.equal(pageFor("/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234/service"), "not-ported");
});

test("a database's configuration route maps to General; every other entry of its menu is not ported", () => {
  const database = "/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234/database/yza567bcd890efg123hij456";
  assert.equal(pageFor(database), "project.database.configuration");
  assert.equal(pageFor(`${database}/`), "project.database.configuration");
  // routes/web.php's project.database.* routes, and the backups page.
  for (const page of [
    "environment-variables", "servers", "import-backup", "persistent-storage", "healthcheck", "webhooks", "resource-limits", "resource-operations",
    "metrics", "vulnerabilities", "tags", "danger", "logs", "terminal", "files", "backups",
  ]) {
    assert.equal(pageFor(`${database}/${page}`), "not-ported", page);
  }
  // A database is not an application, whatever its uuid.
  assert.equal(pageFor(database.replace("/database/", "/application/")), "project.application.configuration");
});

test("a pasted image reference is split into its name and its tag or digest (DockerImage::updatedImageName)", () => {
  const sha = "59e02939b1bf39f16c93138a28727aec520bb916da021180ae502c61626b3cf0";
  const split = (imageName: string, imageTag = "", imageSha256 = "") => splitPastedImageName({ imageName, imageTag, imageSha256 });
  assert.deepEqual(split("ghcr.io/user/app:v1.2.3"), { imageName: "ghcr.io/user/app", imageTag: "v1.2.3", imageSha256: "" });
  assert.deepEqual(split(`nginx@sha256:${sha}`), { imageName: "nginx", imageTag: "", imageSha256: sha });
  assert.deepEqual(split(`nginx:stable@sha256:${sha}`), { imageName: "nginx:stable", imageTag: "", imageSha256: sha });
  assert.deepEqual(split(`nginx:${sha}`), { imageName: "nginx", imageTag: "", imageSha256: sha });
  assert.deepEqual(split("nginx:latest"), { imageName: "nginx", imageTag: "latest", imageSha256: "" });
  // Nothing to split: no tag, a registry port only, or a tag or digest already filled in.
  assert.deepEqual(split("nginx"), { imageName: "nginx", imageTag: "", imageSha256: "" });
  assert.deepEqual(split("localhost:5000/app"), { imageName: "localhost:5000/app", imageTag: "", imageSha256: "" });
  assert.deepEqual(split("localhost:5000/app:2"), { imageName: "localhost:5000/app", imageTag: "2", imageSha256: "" });
  assert.deepEqual(split("nginx:1.27", "1.26"), { imageName: "nginx:1.27", imageTag: "1.26", imageSha256: "" });
  assert.deepEqual(split("nginx:1.27", "", sha), { imageName: "nginx:1.27", imageTag: "", imageSha256: sha });
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

test("the shared variable routes map to their pages; each scope's canvas is not ported", () => {
  const project = "abc123def456ghi789jkl012";
  const environment = "mno345pqr678stu901vwx234";
  assert.equal(pageFor("/shared-variables"), "shared-variables.index");
  assert.equal(pageFor("/shared-variables/"), "shared-variables.index");
  assert.equal(pageFor("/shared-variables/team"), "shared-variables.team.index");
  assert.equal(pageFor("/shared-variables/team/canvas"), "not-ported");
  assert.equal(pageFor("/shared-variables/projects"), "shared-variables.project.index");
  assert.equal(pageFor("/shared-variables/projects/"), "shared-variables.project.index");
  assert.equal(pageFor("/shared-variables/project"), "not-ported");
  assert.equal(pageFor(`/shared-variables/project/${project}`), "shared-variables.project.show");
  assert.equal(pageFor(`/shared-variables/project/${project}/canvas`), "not-ported");
  assert.equal(pageFor("/shared-variables/environments"), "shared-variables.environment.index");
  assert.equal(pageFor(`/shared-variables/environments/project/${project}/environment/${environment}`), "shared-variables.environment.show");
  assert.equal(pageFor(`/shared-variables/environments/project/${project}/environment/${environment}/`), "shared-variables.environment.show");
  assert.equal(pageFor(`/shared-variables/environments/project/${project}/environment/${environment}/canvas`), "not-ported");
  assert.equal(pageFor(`/shared-variables/environments/project/${project}`), "not-ported");
  assert.equal(pageFor(`/shared-variables/environment/${environment}`), "not-ported");
  assert.equal(pageFor("/shared-variables/servers"), "shared-variables.server.index");
  assert.equal(pageFor(`/shared-variables/server/${project}`), "shared-variables.server.show");
  assert.equal(pageFor(`/shared-variables/server/${project}/canvas`), "not-ported");
  assert.equal(pageFor("/shared-variables/nope"), "not-ported");
});

import { agoShort } from "../src/lib/ago.ts";

test("Carbon's short diffForHumans for past times", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  assert.equal(agoShort("2026-11-24T11:59:30Z", now), "30s ago");
  assert.equal(agoShort("2026-11-24T11:59:00Z", now), "1m ago");
  assert.equal(agoShort("2026-11-24T09:00:00Z", now), "3h ago");
  assert.equal(agoShort("2026-11-22T12:00:00Z", now), "2d ago");
  assert.equal(agoShort("2026-11-17T12:00:00Z", now), "1w ago");
  assert.equal(agoShort("2026-10-20T12:00:00Z", now), "1mo ago");
  assert.equal(agoShort("2026-08-24T12:00:00Z", now), "3mos ago");
  assert.equal(agoShort("2025-11-24T12:00:00Z", now), "1yr ago");
  assert.equal(agoShort("2023-11-24T12:00:00Z", now), "3yrs ago");
});
