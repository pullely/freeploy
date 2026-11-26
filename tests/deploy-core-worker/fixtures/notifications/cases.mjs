// Writes cases.json (DP-67): node cases.mjs cases.json. See README.md.
//
// One case is one notification of Coolify's with fixed plain data: the data the TypeScript port
// (apps/deploy-core-worker/src/notifications/payloads.ts) takes, from which emit.php builds Coolify's models.
// Every class gets a plain case and the edge cases its code branches on: optional fields missing (no domain,
// no URL, no preview), long values (a 5000-character error, names past every channel's limit), text that
// needs escaping (Markdown, mrkdwn, HTML, control characters) and text outside ASCII (escaped as \uXXXX by
// PHP's json_encode).
import { writeFileSync } from "node:fs";

const project = { uuid: "prj0000000000000000000001", name: "Fixture Project" };
const environment = { uuid: "env0000000000000000000001", name: "production", project };
const server = { uuid: "srv0000000000000000000001", name: "fixture-server" };
const application = {
  uuid: "app0000000000000000000001",
  name: "fixture-app",
  fqdn: "https://app.example.com,https://www.example.com",
  git_branch: "main",
  environment,
};
const long = (n, unit = "error line ") => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
const LONG_ERROR = long(5000, "pg_dump: error: connection to server failed; ");
const TRICKY = "api*_~`|>[x](y)#<b>&\"'\u0007​ é 🚀";

const cases = [];
const add = (cls, id, input) => cases.push({ id: `${cls}.${id}`, class: cls, input });

// app/Notifications/Test.php
add("Test", "plain", { ping: false });
add("Test", "ping", { ping: true });

// app/Notifications/Application/DeploymentSuccess.php, DeploymentFailed.php
for (const cls of ["DeploymentSuccess", "DeploymentFailed"]) {
  add(cls, "plain", { application, deployment_uuid: "dpl0000000000000000000001", preview: null, deployment: null });
  add(cls, "no-fqdn", { application: { ...application, fqdn: null }, deployment_uuid: "dpl0000000000000000000002", preview: null, deployment: null });
  add(cls, "preview", {
    application,
    deployment_uuid: "dpl0000000000000000000003",
    preview: { pull_request_id: 42, fqdn: "https://pr-42.example.com" },
    deployment: null,
  });
  add(cls, "preview-no-fqdn", { application, deployment_uuid: "dpl0000000000000000000004", preview: { pull_request_id: 7, fqdn: null }, deployment: null });
}
add("DeploymentFailed", "scan-gate-blocked", {
  application,
  deployment_uuid: "dpl0000000000000000000005",
  preview: null,
  deployment: {
    scan_gate_result: {
      blocked: true,
      headline: "Deploy blocked: this image has 2 security problems that attackers are using.",
      headline_plain: "this image has security problems that attackers are using.",
    },
  },
});
add("DeploymentFailed", "scan-gate-legacy-counted", {
  application: { ...application, name: TRICKY },
  deployment_uuid: "dpl0000000000000000000006",
  preview: null,
  deployment: { scan_gate_result: { blocked: true, headline: "This image has 3 security problems." } },
});
add("DeploymentFailed", "scan-gate-preview", {
  application,
  deployment_uuid: "dpl0000000000000000000007",
  preview: { pull_request_id: 9, fqdn: "https://pr-9.example.com" },
  deployment: { scan_gate_result: { blocked: true, headline: "", headline_plain: "" } },
});

// app/Notifications/Application/RestartLimitReached.php, StatusChanged.php
const resources = {
  application: { type: "application", uuid: application.uuid, name: application.name, fqdn: application.fqdn, restart_count: 5, max_restart_count: 5, environment },
  database: { type: "database", uuid: "pg00000000000000000000001", name: "fixture-postgres", restart_count: 10, max_restart_count: 10, environment },
  preview: {
    type: "preview",
    uuid: "prv0000000000000000000001",
    pull_request_id: 12,
    fqdn: "https://pr-12.example.com",
    restart_count: 3,
    max_restart_count: 1,
    application: { uuid: application.uuid, name: application.name, max_restart_count: 3, environment },
  },
  "service-application": {
    type: "service_application",
    uuid: "sap0000000000000000000001",
    name: "fixture-service-app",
    fqdn: null,
    restart_count: 2,
    max_restart_count: 2,
    service: { uuid: "svc0000000000000000000001", environment },
  },
};
for (const cls of ["RestartLimitReached", "StatusChanged"]) {
  for (const [id, resource] of Object.entries(resources)) add(cls, id, { resource });
}

// app/Notifications/Container/ContainerRestarted.php
add("ContainerRestarted", "with-url", { name: "coolify-proxy", server, url: "https://coolify.example.com/server/srv0000000000000000000001/proxy" });
add("ContainerRestarted", "no-url", { name: "fixture-app-abc", server, url: null });

// app/Notifications/Database/*.php
const database = { name: "fixture-postgres", uuid: "pg00000000000000000000001", environment };
add("BackupFailed", "plain", { backup: { frequency: "0 0 * * *" }, database, output: "pg_dump: error: connection refused", database_name: "postgres" });
add("BackupFailed", "long-output-no-link", { backup: { frequency: "daily" }, database: { ...database, environment: null }, output: LONG_ERROR, database_name: "app_db" });
add("BackupMissing", "with-database", {
  backup: { uuid: "bkp0000000000000000000001", description: "nightly", missing_backup_notification_days: 2, database: { name: "fixture-postgres" } },
  last_execution_at: "2025-12-29 03:00:00",
});
add("BackupMissing", "description-never-ran", {
  backup: { uuid: "bkp0000000000000000000002", description: "weekly", missing_backup_notification_days: 7, database: null },
  last_execution_at: null,
});
add("BackupMissing", "uuid-only", {
  backup: { uuid: "bkp0000000000000000000003", description: null, missing_backup_notification_days: 1, database: null },
  last_execution_at: null,
});
add("BackupSuccess", "plain", { backup: { frequency: "0 0 * * *" }, database, database_name: "postgres" });
add("BackupSuccess", "no-link", { backup: { frequency: "hourly" }, database: { ...database, environment: null }, database_name: "postgres" });
add("BackupSuccessWithS3Warning", "with-s3", {
  backup: { frequency: "0 0 * * *", s3: { uuid: "s3s0000000000000000000001" } },
  database,
  database_name: "postgres",
  s3_error: "The AWS Access Key Id you provided does not exist in our records.",
});
add("BackupSuccessWithS3Warning", "no-s3", { backup: { frequency: "daily", s3: null }, database, database_name: "mysql", s3_error: LONG_ERROR.slice(0, 1200) });

// app/Notifications/ScheduledTask/*.php
const task = { uuid: "tsk0000000000000000000001", name: "cleanup", consecutive_failures: 1, failing_since: null, disabled_reason: null };
add("TaskSuccess", "application", { task: { ...task, application: { uuid: application.uuid, environment } }, output: "done" });
add("TaskSuccess", "service", { task: { ...task, service: { uuid: "svc0000000000000000000001", environment } }, output: "" });
add("TaskSuccess", "no-resource", { task, output: "ok" });
add("TaskFailed", "first", { task: { ...task, application: { uuid: application.uuid, environment } }, output: "exit code 1", disabled: false });
add("TaskFailed", "streak", {
  task: { ...task, consecutive_failures: 4, failing_since: "2025-12-30 08:15:00", service: { uuid: "svc0000000000000000000001", environment } },
  output: LONG_ERROR,
  disabled: false,
});
add("TaskFailed", "disabled", {
  task: { ...task, consecutive_failures: 10, failing_since: "2025-12-30 08:15:00", disabled_reason: "Disabled automatically after 10 failed runs in a row since 2025-12-30 08:15:00 UTC." },
  output: "",
  disabled: true,
});
add("TaskFailed", "disabled-no-reason", { task: { ...task, consecutive_failures: 10, application: { uuid: application.uuid, environment } }, output: "boom", disabled: true });

// app/Notifications/Server/*.php
add("DockerCleanupFailed", "plain", { server, message: "Error response from daemon: conflict: unable to delete image" });
add("DockerCleanupSuccess", "plain", { server, message: "Removed 3 images, freed 1.2 GB." });
add("ForceDisabled", "plain", { server });
add("ForceEnabled", "plain", { server });
add("HetznerDeletionFailed", "plain", { hetznerServerId: 123456, teamId: 1, errorMessage: "server not found (not_found)" });
add("HighDiskUsage", "plain", { server, disk_usage: 91, server_disk_usage_notification_threshold: 80 });
add("HostKeyChanged", "plain", { server });
add("Reachable", "plain", { server });
add("Unreachable", "plain", { server });
const updates = (n, risky = []) =>
  Array.from({ length: n }, (_, i) => ({ package: `pkg-${i + 1}`, current_version: `1.${i}.0`, new_version: `1.${i}.1`, ...(risky.includes(i) ? { risk: "restart" } : {}) }));
add("ServerPatchCheck", "updates", { server, patchData: { total_updates: 2, updates: updates(2), osId: "ubuntu", package_manager: "apt", security_updates: 1, reboot_required: false } });
add("ServerPatchCheck", "many-with-critical", { server, patchData: { total_updates: 8, updates: updates(8, [0, 2, 5, 7]), osId: "debian", package_manager: "apt" } });
add("ServerPatchCheck", "none", { server, patchData: { total_updates: 0, updates: [] } });
add("ServerPatchCheck", "error", { server, patchData: { error: "apt-get update failed: Could not resolve 'archive.ubuntu.com'", osId: "ubuntu", package_manager: "apt" } });
add("ServerPatchCheck", "error-unknown-os", { server, patchData: { error: "unsupported" } });
add("TraefikVersionOutdated", "mixed", {
  servers: [
    { name: "srv-a", uuid: "srva000000000000000000001", outdatedInfo: { current: "3.5.0", latest: "3.5.3", type: "patch_update" } },
    { name: "srv-b", uuid: "srvb000000000000000000001", outdatedInfo: { current: "v3.4.1", latest: "3.4.5", type: "minor_upgrade", upgrade_target: "3.6" } },
    { name: "srv-c", uuid: "srvc000000000000000000001", outdatedInfo: { current: "3.5.1", latest: "3.5.3", type: "patch_update", newer_branch_target: "v3.6", newer_branch_latest: "3.6.2" } },
  ],
});
add("TraefikVersionOutdated", "patch-only", { servers: [{ name: "srv-a", uuid: "srva000000000000000000001", outdatedInfo: { current: "3.5.0", latest: "3.5.3" } }] });
add("TraefikVersionOutdated", "no-info", { servers: [{ name: "srv-x", uuid: "srvx000000000000000000001", outdatedInfo: null }] });

// app/Notifications/SslExpirationNotification.php
add("SslExpirationNotification", "two", {
  resources: [
    { name: "fixture-postgres", uuid: "pg00000000000000000000001", environment },
    { name: "fixture-redis", uuid: "rd00000000000000000000001", environment },
  ],
});
add("SslExpirationNotification", "none", { resources: [] });

// app/Notifications/ApiToken*.php
add("ApiTokenExpiringNotification", "plain", { token: { name: "ci-deploy", expires_at: "2026-01-08 12:00:00" } });
add("ApiTokenExpiringNotification", "no-expiry", { token: { name: "legacy", expires_at: null } });
add("ApiTokenFailingNotification", "plain", { token: { name: "ci-deploy" }, failedRequests: 120, lastRequest: "POST /api/v1/deploy?uuid=<x>&force=true" });

// app/Notifications/ScheduledJobRecovered.php
add("ScheduledJobRecovered", "with-url", {
  failureEvent: "backup_failure",
  title: "Database backup of fixture-postgres works again",
  webhookEvent: "backup_recovered",
  url: "https://coolify.example.com/project/prj/environment/env/database/pg",
  webhookData: { database_uuid: "pg00000000000000000000001", success: "overridden", skipped: null },
});
add("ScheduledJobRecovered", "no-url", { failureEvent: "scheduled_task_failure", title: "Scheduled task (cleanup) works again", webhookEvent: "task_recovered", url: null, webhookData: {} });

// app/Notifications/Internal/GeneralNotification.php
add("GeneralNotification", "success", { message: "Coolify was updated to 4.7.6.", success: true });
add("GeneralNotification", "failure", { message: "Discord notifications were disabled after 3 failed deliveries in a row.\nReason: Discord returned HTTP 404 (Not Found).", success: false });

// app/Notifications/VolumeBackup/*.php
const volumeBackup = {
  uuid: "vbk0000000000000000000001",
  frequency: "0 3 * * *",
  missing_backup_notification_days: 3,
  resourceName: "fixture-app",
  targetType: "Volume",
  targetName: "fixture-app-data",
  resourceUrl: "https://coolify.example.com/project/prj0000000000000000000001/environment/env0000000000000000000001/application/app0000000000000000000001",
};
const orphanBackup = { ...volumeBackup, resourceName: null, targetType: "Directory", targetName: "/data/coolify/applications/x/config", resourceUrl: null };
add("VolumeBackupSuccess", "success", { backup: volumeBackup, warning: null, uploadFailed: false });
add("VolumeBackupSuccess", "warning", { backup: volumeBackup, warning: "2 files changed while reading.", uploadFailed: false });
add("VolumeBackupSuccess", "upload-failed", { backup: orphanBackup, warning: "S3 rejected the upload.", uploadFailed: true });
add("VolumeBackupFailed", "plain", { backup: volumeBackup, output: "tar: Exiting with failure status" });
add("VolumeBackupFailed", "orphan-long", { backup: orphanBackup, output: LONG_ERROR });
add("VolumeBackupMissing", "plain", { backup: volumeBackup, last_execution_at: "2025-12-28 03:00:00" });
add("VolumeBackupMissing", "orphan-never", { backup: orphanBackup, last_execution_at: null });
for (const [id, recovery_error, stop_recovery_pending] of [
  ["s3-auth-stopped", "s3_auth", true],
  ["s3-bucket", "s3_bucket", false],
  ["remote-command", "remote_command", true],
  ["server-unreachable", "server_unreachable", false],
]) {
  add("VolumeBackupRecoveryFailed", id, { execution: { uuid: "vbx0000000000000000000001", recovery_error, stop_recovery_pending, backup: volumeBackup } });
}
add("VolumeBackupRecoveryFailed", "no-backup", { execution: { uuid: "vbx0000000000000000000002", recovery_error: null, stop_recovery_pending: false, backup: null } });

// app/Notifications/ImageScan/*.php — built from the notification's public properties (see emit.php).
add("ExploitedProblemFound", "update-now", {
  resourceName: "api",
  resourceUuid: application.uuid,
  url: "https://coolify.example.com/project/prj/environment/env/application/app/security",
  count: 2,
  exploited: true,
  action: "Update to 1.28.",
  checkIncomplete: false,
});
add("ExploitedProblemFound", "no-fix-one-likely", { resourceName: "worker", resourceUuid: "app0000000000000000000002", url: null, count: 1, exploited: false, action: null, checkIncomplete: false });
add("ExploitedProblemFound", "check-needed-long", {
  resourceName: long(400, TRICKY),
  resourceUuid: "app0000000000000000000003",
  url: "https://coolify.example.com/x",
  count: 5,
  exploited: true,
  action: null,
  checkIncomplete: true,
});
const digestResource = (i, extra = {}) => ({
  name: `service-${i}`,
  uuid: `res${String(i).padStart(22, "0")}`,
  url: `https://coolify.example.com/project/prj/environment/env/application/res${i}`,
  status: "update_available",
  badge: "Security update",
  action: `Update to 1.${i}.`,
  why: [],
  ...extra,
});
add("VulnerabilityDigest", "small", {
  digest: {
    resources: [digestResource(1), digestResource(2, { url: null, status: "check_needed", badge: "Check needed", action: null })],
    ignores: [{ resource: "service-1", id: "CVE-2025-1094", package: "libpq", expires_at: "2026-01-05" }],
    servers: [{ name: "fixture-server", url: "https://coolify.example.com/server/srv0000000000000000000001" }],
  },
});
add("VulnerabilityDigest", "empty", { digest: { resources: [], ignores: [], servers: [] } });
add("VulnerabilityDigest", "over-every-limit", {
  digest: {
    resources: Array.from({ length: 80 }, (_, i) => digestResource(i + 1, { name: `${TRICKY} ${i + 1} ${long(150, "n")}`, action: long(600, "Update the base image then redeploy. ") })),
    ignores: [
      { resource: null, id: null, package: "openssl", expires_at: "2026-01-02" },
      { resource: "a", id: "GHSA-xxxx-yyyy-zzzz", package: null, expires_at: "2026-01-03" },
    ],
    servers: [{ name: long(300, "server-name-"), url: "https://coolify.example.com/server/s" }],
  },
});

writeFileSync(process.argv[2] ?? "cases.json", JSON.stringify({ cases }, null, 1) + "\n");
