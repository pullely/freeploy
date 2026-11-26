// DP-99: the model of the storage backup lists (the Alpine list of Backup\Index and VolumeBackup\Index), and the
// backup pages' routes and redirects.
import { test } from "node:test";
import assert from "node:assert/strict";
import { backupFilterOptions, filterBackups, scheduleStatus, type BackupListItem } from "../src/lib/volume-backups.ts";
import { pageFor, backupLinkRedirect } from "../src/routes.ts";

const item = (targetName: string, targetType: string, extra: Partial<BackupListItem> = {}): BackupListItem => ({
  uuid: targetName,
  targetName,
  targetType,
  frequency: "daily",
  enabled: true,
  saveS3: false,
  storages: [],
  latestStatus: null,
  latestFinishedAt: null,
  executionsCount: 0,
  ...extra,
});

test("a schedule's status is its latest execution's, else Waiting or Disabled", () => {
  assert.deepEqual(scheduleStatus({ latestStatus: "running", enabled: false }), ["In progress", "warning"]);
  assert.deepEqual(scheduleStatus({ latestStatus: "success", enabled: true }), ["Success", "success"]);
  assert.deepEqual(scheduleStatus({ latestStatus: "failed", enabled: true }), ["Failed", "error"]);
  assert.deepEqual(scheduleStatus({ latestStatus: null, enabled: true }), ["Waiting", "neutral"]);
  assert.deepEqual(scheduleStatus({ latestStatus: null, enabled: false }), ["Disabled", "neutral"]);
});

test("the list's search, type filter and sorts, with the target's name as the tie-breaker", () => {
  const all = [
    item("web-data", "Volume", { frequency: "hourly", executionsCount: 3, saveS3: true, storages: [{ name: "A", label: "A" }] }),
    item("/srv/shared", "Directory", { latestStatus: "success", latestFinishedAt: "2026-01-02T00:00:00Z", executionsCount: 1 }),
    item("db", "Database", { enabled: false, latestFinishedAt: "2026-01-01T00:00:00Z" }),
  ];
  assert.deepEqual(filterBackups(all, "", "all", "target_asc").map((b) => b.targetName), ["/srv/shared", "db", "web-data"]);
  assert.deepEqual(filterBackups(all, "", "all", "target_desc").map((b) => b.targetName), ["web-data", "db", "/srv/shared"]);
  assert.deepEqual(filterBackups(all, "HOUR", "all", "target_asc").map((b) => b.targetName), ["web-data"]);
  assert.deepEqual(filterBackups(all, "", "directory", "target_asc").map((b) => b.targetName), ["/srv/shared"]);
  assert.deepEqual(filterBackups(all, "", "all", "executions_desc").map((b) => b.targetName), ["web-data", "/srv/shared", "db"]);
  assert.deepEqual(filterBackups(all, "", "all", "lastrun_desc").map((b) => b.targetName), ["/srv/shared", "db", "web-data"]);
  assert.deepEqual(filterBackups(all, "", "all", "s3_desc").map((b) => b.targetName), ["web-data", "/srv/shared", "db"]);
  assert.deepEqual(filterBackups(all, "", "all", "status_asc").map((b) => b.targetName), ["db", "/srv/shared", "web-data"]);
  // An unknown column sorts by the target.
  assert.deepEqual(filterBackups(all, "", "all", "nope_asc").map((b) => b.targetName), ["/srv/shared", "db", "web-data"]);
});

test("the filter's options: All targets, the schedules' types, and Database on a service's list", () => {
  const backups = [item("a", "Volume"), item("b", "Directory"), item("c", "Volume")];
  assert.deepEqual(backupFilterOptions(backups, false), [{ value: "all", label: "All targets" }, { value: "volume", label: "Volume" }, { value: "directory", label: "Directory" }]);
  assert.deepEqual(backupFilterOptions([], true), [{ value: "all", label: "All targets" }, { value: "database", label: "Database" }]);
});

test("the storage backups of an application and a service, a database's backup links, the old import links and Preview Deployments", () => {
  const environment = "/project/abc123def456ghi789jkl012/environment/mno345pqr678stu901vwx234";
  const application = `${environment}/application/yza567bcd890efg123hij456`;
  assert.equal(pageFor(`${application}/backups`), "project.application.backup.index");
  assert.equal(pageFor(`${application}/backups/`), "project.application.backup.index");
  for (const section of ["", "/executions", "/danger"]) assert.equal(pageFor(`${application}/backups/bkp1${section}`), "project.application.backup.show", section);
  for (const section of ["s3", "retention"]) assert.equal(pageFor(`${application}/backups/bkp1/${section}`), "project.application.backup.redirect", section);
  assert.equal(pageFor(`${application}/backups/bkp1/other`), "not-ported");
  assert.equal(pageFor(`${application}/preview-deployments`), "project.application.preview-deployments");
  assert.equal(pageFor(`${application}/preview-deployments/x`), "not-ported");

  const service = `${environment}/service/svc1`;
  assert.equal(pageFor(`${service}/storage-backups`), "project.service.volume-backups.index");
  for (const section of ["", "/executions", "/danger", "/s3", "/retention"]) assert.equal(pageFor(`${service}/storage-backups/bkp1${section}`), "project.service.volume-backups.show", section);
  assert.equal(pageFor(`${service}/import-backup`), "project.service.import-backup.redirect");
  assert.equal(pageFor(`${service}/import-backup/db1`), "project.service.import-backup.redirect");
  assert.equal(pageFor(`${service}/db1/import`), "project.service.import-backup.redirect");
  for (const rest of ["backups", "backups/bkp1", "backups/bkp1/executions", "backups/bkp1/danger", "backups/bkp1/s3", "backups/bkp1/retention"]) assert.equal(pageFor(`${service}/db1/${rest}`), "project.service.database.backups", rest);
  assert.equal(pageFor(`${service}/db1/backups/bkp1/more`), "not-ported");

  // routes/web.php's Route::redirect()s.
  assert.equal(backupLinkRedirect(`${application}/backups/bkp1/s3`), `${application}/backups/bkp1`);
  assert.equal(backupLinkRedirect(`${application}/backups/bkp1/retention/`), `${application}/backups/bkp1`);
  assert.equal(backupLinkRedirect(`${service}/import-backup`), `${service}/storage-backups`);
  assert.equal(backupLinkRedirect(`${service}/import-backup/db1`), `${service}/db1/backups`);
  assert.equal(backupLinkRedirect(`${service}/db1/import`), `${service}/db1/backups`);
});
