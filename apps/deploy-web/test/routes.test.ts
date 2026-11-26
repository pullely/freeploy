import { test } from "node:test";
import assert from "node:assert/strict";
import { pageFor, backupScheduleRedirect, scheduledTaskRedirect } from "../src/routes.ts";
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
  assert.equal(pageFor("/security/integration-tokens"), "security.integration-tokens");
  assert.equal(pageFor("/security/integration-tokens/"), "security.integration-tokens");
  assert.equal(pageFor("/security/integration-tokens/abc123def456ghi789jkl012"), "not-ported");
  assert.equal(pageFor("/security/api-tokens"), "security.api-tokens");
  assert.equal(pageFor("/security/api-tokens/"), "security.api-tokens");
  assert.equal(pageFor("/servers"), "server.index");
  assert.equal(pageFor("/servers/"), "server.index");
  assert.equal(pageFor("/servers/new"), "server.create");
  assert.equal(pageFor("/servers/new/manual"), "server.create.manual");
  assert.equal(pageFor("/servers/new/hetzner"), "not-ported");
  assert.equal(pageFor("/servers/canvas"), "server.canvas.index");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012"), "server.show");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/private-key"), "server.private-key");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/cloud-provider-token"), "server.cloud-provider-token");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/ca-certificate"), "server.ca-certificate");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/ca-certificate/"), "server.ca-certificate");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/ca-certificate/regenerate"), "not-ported");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/danger"), "server.delete");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/proxy"), "server.proxy");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/advanced"), "server.advanced");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/docker-cleanup"), "server.docker-cleanup");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/log-drains/"), "server.log-drains");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/swarm"), "server.swarm");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/sentinel"), "server.sentinel");
  assert.equal(pageFor("/server/abc123def456ghi789jkl012/sentinel/logs"), "server.sentinel.logs");
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

test("the project and environment routes map to their pages; the environment canvas is ported, and (DP-98) the projects' and a project's canvas; clone is not", () => {
  const project = "/project/abc123def456ghi789jkl012";
  const environment = `${project}/environment/mno345pqr678stu901vwx234`;
  assert.equal(pageFor("/projects"), "project.index");
  assert.equal(pageFor("/projects/"), "project.index");
  assert.equal(pageFor("/projects/canvas"), "project.canvas.index");
  assert.equal(pageFor(project), "project.show");
  assert.equal(pageFor(`${project}/`), "project.show");
  assert.equal(pageFor(`${project}/edit`), "project.edit");
  assert.equal(pageFor(`${project}/canvas`), "project.canvas");
  assert.equal(pageFor(`${project}/icon`), "not-ported");
  assert.equal(pageFor(`${project}/environment`), "not-ported");
  assert.equal(pageFor(environment), "project.resource.index");
  assert.equal(pageFor(`${environment}/`), "project.resource.index");
  assert.equal(pageFor(`${environment}/edit`), "project.environment.edit");
  assert.equal(pageFor(`${environment}/new`), "project.resource.create");
  assert.equal(pageFor(`${environment}/new/`), "project.resource.create");
  assert.equal(pageFor(`${environment}/new/more`), "not-ported");
  // DP-100: the Clone page is ported (its assertions are below).
  assert.equal(pageFor(`${environment}/clone`), "project.clone-me");
  assert.equal(pageFor(`${environment}/canvas`), "project.environment.canvas");
  assert.equal(pageFor(`${environment}/canvas/`), "project.environment.canvas");
  assert.equal(pageFor(`${environment}/canvas/more`), "not-ported");
});

test("/canvas is the deploy canvas (DP-94), with or without its ?project=…&environment=…; /canvas/tags is the tags canvas (DP-98)", () => {
  assert.equal(pageFor("/canvas"), "deploy-canvas");
  assert.equal(pageFor("/canvas/"), "deploy-canvas");
  // The query string is not part of the path the router sees.
  assert.equal(pageFor(new URL("https://x/canvas?project=abc&environment=def").pathname), "deploy-canvas");
  assert.equal(pageFor("/canvas/tags"), "tags.canvas");
  assert.equal(pageFor("/canvas/api/projects"), "not-ported");
  assert.equal(pageFor("/canvasx"), "not-ported");
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
    "logs", "terminal", "files", "metrics", "analytics",
    "vulnerabilities", // (Preview Deployments and Backups are ported by DP-99, Maintenance Mode and Swarm by DP-102.)
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
  // A service has its General page (DP-59, DP-66); its shared pages and its parts' settings are below (DP-66).
  assert.equal(pageFor("/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234/service/svc1"), "project.service.configuration");
  assert.equal(pageFor("/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234/service"), "not-ported");
});

test("a database's configuration route maps to General, its shared pages to theirs; every other entry of its menu is not ported", () => {
  const database = "/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234/database/yza567bcd890efg123hij456";
  assert.equal(pageFor(database), "project.database.configuration");
  assert.equal(pageFor(`${database}/`), "project.database.configuration");
  // DP-64: the pages that are Coolify's shared components with the database as their resource.
  for (const page of ["environment-variables", "persistent-storage", "tags", "resource-operations", "resource-limits", "webhooks", "danger"]) {
    assert.equal(pageFor(`${database}/${page}`), `project.database.${page}`, page);
    assert.equal(pageFor(`${database}/${page}/`), `project.database.${page}`, page);
    assert.equal(pageFor(`${database}/${page}/more`), "not-ported", page);
  }
  // routes/web.php's other project.database.* routes (the backups page is ported: see below).
  // (Healthcheck and Servers are ported by DP-97: see below.)
  for (const page of ["import-backup", "metrics", "vulnerabilities", "logs", "terminal", "files"]) {
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

test("the shared variable routes map to their pages, each scope's canvas too (DP-98)", () => {
  const project = "abc123def456ghi789jkl012";
  const environment = "mno345pqr678stu901vwx234";
  assert.equal(pageFor("/shared-variables"), "shared-variables.index");
  assert.equal(pageFor("/shared-variables/"), "shared-variables.index");
  assert.equal(pageFor("/shared-variables/team"), "shared-variables.team.index");
  assert.equal(pageFor("/shared-variables/team/canvas"), "shared-variables.team.canvas");
  assert.equal(pageFor("/shared-variables/projects"), "shared-variables.project.index");
  assert.equal(pageFor("/shared-variables/projects/"), "shared-variables.project.index");
  assert.equal(pageFor("/shared-variables/project"), "not-ported");
  assert.equal(pageFor(`/shared-variables/project/${project}`), "shared-variables.project.show");
  assert.equal(pageFor(`/shared-variables/project/${project}/canvas`), "shared-variables.project.canvas");
  assert.equal(pageFor("/shared-variables/environments"), "shared-variables.environment.index");
  assert.equal(pageFor(`/shared-variables/environments/project/${project}/environment/${environment}`), "shared-variables.environment.show");
  assert.equal(pageFor(`/shared-variables/environments/project/${project}/environment/${environment}/`), "shared-variables.environment.show");
  assert.equal(pageFor(`/shared-variables/environments/project/${project}/environment/${environment}/canvas`), "shared-variables.environment.canvas");
  assert.equal(pageFor(`/shared-variables/environments/project/${project}`), "not-ported");
  assert.equal(pageFor(`/shared-variables/environment/${environment}`), "not-ported");
  assert.equal(pageFor("/shared-variables/servers"), "shared-variables.server.index");
  assert.equal(pageFor(`/shared-variables/server/${project}`), "shared-variables.server.show");
  assert.equal(pageFor(`/shared-variables/server/${project}/canvas`), "shared-variables.server.canvas");
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

test("Integrations → Storage (DP-65): the list, a storage and its tabs; New storage is a dialog, not a page", () => {
  assert.equal(pageFor("/storages"), "storage.index");
  assert.equal(pageFor("/storages/"), "storage.index");
  assert.equal(pageFor("/storages/abc123def456ghi789jkl012"), "storage.show");
  assert.equal(pageFor("/storages/abc123def456ghi789jkl012/resources"), "storage.resources");
  assert.equal(pageFor("/storages/abc123def456ghi789jkl012/danger/"), "storage.danger");
  assert.equal(pageFor("/storages/abc123def456ghi789jkl012/other"), "not-ported");
  // "new" is a storage uuid like any other (Coolify has no /storages/new route; the show page goes back to the list).
  assert.equal(pageFor("/storages/new"), "storage.show");
});

test("a database's backup schedules (DP-65); a schedule's links redirect to the page with ?schedule=", () => {
  const database = "/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234/database/yza567bcd890efg123hij456";
  assert.equal(pageFor(`${database}/backups`), "project.database.backup.index");
  assert.equal(pageFor(`${database}/backups/`), "project.database.backup.index");
  for (const section of ["", "/executions", "/danger", "/s3", "/retention"]) {
    assert.equal(pageFor(`${database}/backups/bkp123${section}`), "project.database.backup.show", section);
    assert.equal(backupScheduleRedirect(`${database}/backups/bkp123${section}`), `${database}/backups?schedule=bkp123`);
  }
  assert.equal(pageFor(`${database}/backups/bkp123/other`), "not-ported");
  assert.equal(backupScheduleRedirect(`${database}/backups/bkp123/`), `${database}/backups?schedule=bkp123`);
});

test("the notifications.* routes: each channel's settings page (DP-67)", () => {
  for (const channel of ["email", "discord", "telegram", "slack", "pushover", "webhook"]) {
    assert.equal(pageFor(`/notifications/${channel}`), `notifications.${channel}`);
    assert.equal(pageFor(`/notifications/${channel}/`), `notifications.${channel}`);
  }
  assert.equal(pageFor("/notifications"), "not-ported");
  assert.equal(pageFor("/notifications/teams"), "not-ported");
  assert.equal(pageFor("/notifications/discord/test"), "not-ported");
});

test("a service's configuration route maps to General, its shared pages to theirs, a part to its settings; every other entry of its menu is not ported (DP-66)", () => {
  const service = "/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234/service/svc1";
  assert.equal(pageFor(service), "project.service.configuration");
  assert.equal(pageFor(`${service}/`), "project.service.configuration");
  assert.equal(pageFor(`${service}/environment-variables`), "project.service.environment-variables");
  assert.equal(pageFor(`${service}/storages`), "project.service.storages");
  assert.equal(pageFor(`${service}/tags/`), "project.service.tags");
  assert.equal(pageFor(`${service}/danger`), "project.service.danger");
  assert.equal(pageFor(`${service}/sub000000000000000000001`), "project.service.index");
  assert.equal(pageFor(`${service}/sub000000000000000000001/`), "project.service.index");
  // (Scheduled Tasks, Webhooks and Resource Operations are ported by DP-97: see below.)
  // (Domains and Maintenance Mode are ported by DP-102: see below.)
  for (const notPorted of ["logs", "analytics", "vulnerabilities", "terminal", "files"]) {
    assert.equal(pageFor(`${service}/${notPorted}`), "not-ported", notPorted);
  }
  // (Storage backups, the import links and a database's …/backups are ported by DP-99.)
  assert.equal(pageFor(`${service}/sub000000000000000000001/backups`), "project.service.database.backups");
  assert.equal(pageFor(`${service}/environment-variables/more`), "not-ported");
});

test("the team pages and the invitation page (DP-69); the team's other pages are not ported", () => {
  assert.equal(pageFor("/team"), "team.index");
  assert.equal(pageFor("/team/"), "team.index");
  assert.equal(pageFor("/team/members"), "team.member.index");
  assert.equal(pageFor("/team/members/"), "team.member.index");
  assert.equal(pageFor("/invitations/inv_0123456789abcdef0123456789abcdef"), "team.invitation.show");
  for (const other of ["/team/image-scanning", "/team/members/7/avatar", "/invitations", "/invitations/a/b"]) {
    assert.equal(pageFor(other), "not-ported", other);
  }
});

test("the team's audit log and Danger Zone, and Boarding (DP-75)", () => {
  assert.equal(pageFor("/team/audit-log"), "team.audit-log");
  assert.equal(pageFor("/team/audit-log/"), "team.audit-log");
  assert.equal(pageFor("/team/danger"), "team.danger-zone");
  assert.equal(pageFor("/team/danger/"), "team.danger-zone");
  assert.equal(pageFor("/onboarding"), "onboarding");
  assert.equal(pageFor("/onboarding/"), "onboarding");
  for (const other of ["/team/audit-log/x", "/team/danger/x", "/onboarding/x"]) {
    assert.equal(pageFor(other), "not-ported", other);
  }
});

test("the subscription pages (DP-82): subscription.show and subscription.index", () => {
  assert.equal(pageFor("/subscription"), "subscription.show");
  assert.equal(pageFor("/subscription/"), "subscription.show");
  assert.equal(pageFor("/subscription/new"), "subscription.index");
  assert.equal(pageFor("/subscription/new/"), "subscription.index");
  for (const other of ["/subscription/x", "/subscription/new/x", "/subscriptions"]) {
    assert.equal(pageFor(other), "not-ported", other);
  }
});

test("the Sources pages, a GitHub App's tabs and the pages GitHub sends the browser back to (DP-72); GitLab's and Gitea's are not ported", () => {
  assert.equal(pageFor("/sources"), "source.all");
  assert.equal(pageFor("/sources/"), "source.all");
  const app = "/source/github/abc123def456ghi789jkl012";
  assert.equal(pageFor(app), "source.github.show");
  assert.equal(pageFor(`${app}/`), "source.github.show");
  assert.equal(pageFor(`${app}/permissions`), "source.github.permissions");
  assert.equal(pageFor(`${app}/resources/`), "source.github.resources");
  assert.equal(pageFor(`${app}/danger`), "source.github.danger");
  assert.equal(pageFor("/webhooks/source/github/redirect"), "source.github.redirect");
  assert.equal(pageFor("/webhooks/source/github/install/"), "source.github.install");
  for (const other of [`${app}/more`, "/source/gitlab/abc", "/source/gitea/abc", "/source/github", "/webhooks/source/github/events", "/sources/new"]) {
    assert.equal(pageFor(other), "not-ported", other);
  }
});

test("the platform operator's pages (DP-79): General and Advanced settings, Admin, Team → Admin View; Image Scanning is not ported", () => {
  assert.equal(pageFor("/settings"), "settings.index");
  assert.equal(pageFor("/settings/"), "settings.index");
  assert.equal(pageFor("/settings/advanced"), "settings.advanced");
  assert.equal(pageFor("/settings/advanced/"), "settings.advanced");
  assert.equal(pageFor("/admin"), "admin.index");
  assert.equal(pageFor("/team/admin"), "team.admin-view");
  for (const other of ["/settings/image-scanning", "/settings/x/y", "/admin/x"]) {
    assert.equal(pageFor(other), "not-ported", other);
  }
});

test("a server's proxy, security, Cloudflare Tunnel, Sentinel logs, transfer, resources and images pages (DP-96)", () => {
  const server = "/server/abc123def456ghi789jkl012";
  const pages: Array<[string, string]> = [
    ["/proxy", "server.proxy"],
    ["/proxy/dynamic", "server.proxy.dynamic-confs"],
    ["/proxy/certificates", "server.proxy.certificates"],
    ["/proxy/logs", "server.proxy.logs"],
    ["/security", "server.security"],
    ["/security/patches", "server.security.patches"],
    ["/cloudflare-tunnel", "server.cloudflare-tunnel"],
    ["/sentinel/logs", "server.sentinel.logs"],
    ["/transfer", "server.transfer"],
    ["/resources", "server.resources"],
    ["/images", "server.docker-images"],
  ];
  for (const [path, key] of pages) {
    assert.equal(pageFor(server + path), key);
    assert.equal(pageFor(`${server + path}/`), key);
  }
  // Not ported: the image scan page, its old redirect and the other old security sub pages, GitHub runners. The canvas is DP-98's.
  for (const path of ["/security/vulnerabilities", "/security/image-scanning", "/security/terminal-access", "/security/host-key", "/github-runners", "/proxy/dynamic/new", "/sentinel/logs/x"]) {
    assert.equal(pageFor(server + path), "not-ported", path);
  }
  assert.equal(pageFor(`${server}/canvas`), "server.canvas");
  assert.equal(pageFor(`${server}/canvas/more`), "not-ported");
  // The pages before DP-96 keep their keys.
  assert.equal(pageFor(`${server}/sentinel`), "server.sentinel");
  assert.equal(pageFor(`${server}/registries`), "server.registries");
});

test("DP-97: a service's Scheduled Tasks, Webhooks, Resource Operations and a part's Advanced; the task links of a service and an application redirect to the list", () => {
  const environment = "/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234";
  const service = `${environment}/service/svc1`;
  assert.equal(pageFor(`${service}/scheduled-tasks`), "project.service.scheduled-tasks.show");
  assert.equal(pageFor(`${service}/scheduled-tasks/`), "project.service.scheduled-tasks.show");
  assert.equal(pageFor(`${service}/webhooks`), "project.service.webhooks");
  assert.equal(pageFor(`${service}/resource-operations/`), "project.service.resource-operations");
  assert.equal(pageFor(`${service}/tasks/tsk000000000000000000001`), "project.service.scheduled-tasks");
  assert.equal(pageFor(`${service}/sub000000000000000000001/advanced`), "project.service.index.advanced");
  assert.equal(pageFor(`${service}/sub000000000000000000001/advanced/`), "project.service.index.advanced");
  // A route of the service is no part.
  // (DP-99: routes/web.php registers …/storage-backups/{backup_uuid} first, so "advanced" is a schedule's uuid there.)
  assert.equal(pageFor(`${service}/storage-backups/advanced`), "project.service.volume-backups.show");
  assert.equal(pageFor(`${service}/tasks/advanced`), "project.service.scheduled-tasks");
  for (const page of ["scheduled-tasks/x", "webhooks/x", "resource-operations/clone", "tasks", "sub000000000000000000001/advanced/more"]) assert.equal(pageFor(`${service}/${page}`), "not-ported", page);

  const application = `${environment}/application/yza567bcd890efg123hij456`;
  assert.equal(pageFor(`${application}/tasks/tsk000000000000000000001`), "project.application.scheduled-tasks.task");
  assert.equal(pageFor(`${application}/tasks/tsk000000000000000000001/`), "project.application.scheduled-tasks.task");
  assert.equal(pageFor(`${application}/tasks`), "not-ported");
  // redirect()->route('….scheduled-tasks.show', get_route_parameters()): the task's uuid goes to the query.
  assert.equal(scheduledTaskRedirect(`${application}/tasks/tsk1`), `${application}/scheduled-tasks?task_uuid=tsk1`);
  assert.equal(scheduledTaskRedirect(`${service}/tasks/tsk1/`), `${service}/scheduled-tasks?task_uuid=tsk1`);
  assert.equal(scheduledTaskRedirect(`${service}/tasks/a%20b`), `${service}/scheduled-tasks?task_uuid=a%20b`);
});

test("DP-97: a database's Healthcheck and Servers", () => {
  const database = "/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234/database/yza567bcd890efg123hij456";
  for (const page of ["healthcheck", "servers"]) {
    assert.equal(pageFor(`${database}/${page}`), `project.database.${page}`, page);
    assert.equal(pageFor(`${database}/${page}/`), `project.database.${page}`, page);
    assert.equal(pageFor(`${database}/${page}/more`), "not-ported", page);
  }
});

test("DP-98: the canvases that reuse the environment canvas's view map to their pages", () => {
  const pages: Array<[string, string]> = [
    ["/projects/canvas", "project.canvas.index"],
    ["/project/abc/canvas/", "project.canvas"],
    ["/servers/canvas/", "server.canvas.index"],
    ["/server/abc/canvas", "server.canvas"],
    ["/dashboard/canvas", "dashboard.canvas"],
    ["/dashboard/canvas/", "dashboard.canvas"],
    ["/shared-variables/team/canvas", "shared-variables.team.canvas"],
    ["/shared-variables/project/abc/canvas", "shared-variables.project.canvas"],
    ["/shared-variables/environments/project/abc/environment/def/canvas", "shared-variables.environment.canvas"],
    ["/shared-variables/server/abc/canvas", "shared-variables.server.canvas"],
    ["/canvas/tags/", "tags.canvas"],
  ];
  for (const [path, key] of pages) assert.equal(pageFor(path), key, path);
  for (const path of ["/dashboard/canvas/x", "/shared-variables/canvas", "/shared-variables/environment/abc/canvas", "/tags/canvas/x", "/canvas/tags/x"]) assert.equal(pageFor(path), "not-ported", path);
  // A tag named "canvas" is still its page, as in Coolify (routes/web.php has no /tags/canvas).
  assert.equal(pageFor("/tags/canvas"), "tags.show");
});

test("DP-100: / is the dashboard, /dashboard is Coolify's catch-all (sent home), and …/clone is an environment's Clone page", () => {
  assert.equal(pageFor("/"), "dashboard");
  assert.equal(pageFor("/dashboard"), "dashboard.fallback");
  assert.equal(pageFor("/dashboard/"), "dashboard.fallback");
  assert.equal(pageFor("/dashboard/canvas"), "dashboard.canvas");
  assert.equal(pageFor("/dashboard/other"), "not-ported");
  const environment = "/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234";
  assert.equal(pageFor(`${environment}/clone`), "project.clone-me");
  assert.equal(pageFor(`${environment}/clone/`), "project.clone-me");
  for (const path of [`${environment}/clone/more`, "/project/abc/clone"]) assert.equal(pageFor(path), "not-ported", path);
});

test("the platform's Updates, Backup, Email and Authentication (DP-101): settings.updates, .backup, .email, .oauth and .oauth.provider", () => {
  const pages: Array<[string, string]> = [
    ["/settings/updates", "settings.updates"],
    ["/settings/updates/", "settings.updates"],
    ["/settings/backup", "settings.backup"],
    ["/settings/email", "settings.email"],
    ["/settings/email/", "settings.email"],
    ["/settings/oauth", "settings.oauth"],
    ["/settings/oauth/", "settings.oauth"],
    ["/settings/oauth/github", "settings.oauth.provider"],
    ["/settings/oauth/azure_ad-2/", "settings.oauth.provider"],
  ];
  for (const [path, key] of pages) assert.equal(pageFor(path), key, path);
  // {provider} is [A-Za-z0-9_-]+, one segment.
  for (const other of ["/settings/oauth/git.hub", "/settings/oauth/github/x", "/settings/updates/check", "/settings/email/test", "/settings/backup/now"]) {
    assert.equal(pageFor(other), "not-ported", other);
  }
});

test("DP-102: an application's Maintenance Mode and Swarm, a service's Domains and Maintenance Mode, and /select-team", () => {
  const environment = "/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234";
  const application = `${environment}/application/yza567bcd890efg123hij456`;
  const service = `${environment}/service/svc1`;
  const pages: Array<[string, string]> = [
    [`${application}/maintenance`, "project.application.maintenance"],
    [`${application}/maintenance/`, "project.application.maintenance"],
    [`${application}/swarm`, "project.application.swarm"],
    [`${application}/swarm/`, "project.application.swarm"],
    [`${service}/domains`, "project.service.domains"],
    [`${service}/domains/`, "project.service.domains"],
    [`${service}/maintenance`, "project.service.maintenance"],
    [`${service}/maintenance/`, "project.service.maintenance"],
    ["/select-team", "team.select"],
    ["/select-team/", "team.select"],
  ];
  for (const [path, key] of pages) assert.equal(pageFor(path), key, path);
  for (const path of [`${application}/maintenance/more`, `${application}/swarm/x`, `${service}/domains/x`, `${service}/maintenance/x`, "/select-team/x", `${environment}/database/db1/maintenance`, `${environment}/database/db1/swarm`]) {
    assert.equal(pageFor(path), "not-ported", path);
  }
  // A route of the service is no part of it (project.service.index).
  assert.notEqual(pageFor(`${service}/domains`), "project.service.index");
  // A part's own settings are still a part's.
  assert.equal(pageFor(`${service}/sub000000000000000000001`), "project.service.index");
});
