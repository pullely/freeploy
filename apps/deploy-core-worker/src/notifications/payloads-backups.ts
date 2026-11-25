// Derived from coollabsio/coolify@91b7e3e:app/Notifications/Database/{BackupFailed,BackupMissing,BackupSuccess,
// BackupSuccessWithS3Warning}.php, app/Notifications/ScheduledTask/{TaskSuccess,TaskFailed}.php,
// app/Notifications/VolumeBackup/{BackupSuccess,BackupFailed,BackupMissing,RecoveryFailed}.php,
// app/Models/ScheduledTask.php (url(), the auto-disable limits), app/Models/NotificationThrottle.php (the
// reminder text) and app/Models/Standalone*.php (link()) (Apache-2.0), modified.
//
// The backup and scheduled task notifications, from plain data (see payloads.ts). A volume backup's
// target and link are inputs: what ScheduledVolumeBackup::targetResource()->name, targetType(),
// targetName() and resourceUrl() answer.
import { DiscordMessage, PushoverMessage, SlackMessage, type PayloadContext, type TelegramMessage } from "./messages.js";
import { filled, type PhpValue } from "./php.js";
import { base, type EnvironmentData, type Notification, type WebhookPayload } from "./notification.js";

export interface DatabaseData {
  name: string;
  uuid: string;
  environment: EnvironmentData | null;
}

export interface TaskData {
  uuid: string;
  name: string;
  consecutive_failures: number | null;
  /** toDateTimeString() of failing_since: "Y-m-d H:i:s". */
  failing_since: string | null;
  disabled_reason: string | null;
  application?: { uuid: string; environment: EnvironmentData | null } | null;
  service?: { uuid: string; environment: EnvironmentData | null } | null;
}

export interface VolumeBackupData {
  uuid: string;
  frequency: string;
  missing_backup_notification_days: number;
  /** targetResource()?->name: null when the volume's resource is gone. */
  resourceName: string | null;
  targetType: string;
  targetName: string;
  resourceUrl: string | null;
}

export type BackupNotificationInput =
  | { class: "BackupFailed"; input: { backup: { frequency: string }; database: DatabaseData; output: string; database_name: string } }
  | {
      class: "BackupMissing";
      input: {
        backup: { uuid: string; description: string | null; missing_backup_notification_days: number; database: { name: string } | null };
        last_execution_at: string | null;
      };
    }
  | { class: "BackupSuccess"; input: { backup: { frequency: string }; database: DatabaseData; database_name: string } }
  | { class: "BackupSuccessWithS3Warning"; input: { backup: { frequency: string; s3: { uuid: string } | null }; database: DatabaseData; database_name: string; s3_error: string } }
  | { class: "TaskSuccess"; input: { task: TaskData; output: string } }
  | { class: "TaskFailed"; input: { task: TaskData; output: string; disabled: boolean } }
  | { class: "VolumeBackupSuccess"; input: { backup: VolumeBackupData; warning: string | null; uploadFailed: boolean } }
  | { class: "VolumeBackupFailed"; input: { backup: VolumeBackupData; output: string } }
  | { class: "VolumeBackupMissing"; input: { backup: VolumeBackupData; last_execution_at: string | null } }
  | {
      class: "VolumeBackupRecoveryFailed";
      input: { execution: { uuid: string; recovery_error: string | null; stop_recovery_pending: boolean; backup: VolumeBackupData | null } };
    };

/** NotificationThrottle::FAILURE_REMINDER_TEXT. */
export const FAILURE_REMINDER_TEXT = "While it keeps failing, you get at most one notification each day.";
/** ScheduledTask::AUTO_DISABLE_AFTER_FAILURES and AUTO_DISABLE_AFTER_HOURS. */
export const AUTO_DISABLE_AFTER_FAILURES = 10;
export const AUTO_DISABLE_AFTER_HOURS = 24;

/** PHP's truthiness of a string: "" and "0" are false. */
const truthy = (s: string | null | undefined): s is string => s !== null && s !== undefined && s !== "" && s !== "0";

/** Standalone*::link(): route('project.database.configuration') when the database has a project. */
function databaseLink(ctx: PayloadContext, d: DatabaseData): string | null {
  const project = d.environment?.project?.uuid;
  if (!project) return null;
  return `${ctx.appUrl}/project/${project}/environment/${d.environment!.uuid}/database/${d.uuid}`;
}

function backupFailed(ctx: PayloadContext, input: { backup: { frequency: string }; database: DatabaseData; output: string; database_name: string }): Notification {
  const B = ctx.brand;
  const { name } = input.database;
  const { frequency } = input.backup;
  const { output, database_name: db } = input;
  return base({
    kind: "BackupFailed",
    event: "backup_failure",
    telegramThread: "backup_failure",
    toMail: () => ({ subject: `${B}: [ACTION REQUIRED] Database Backup FAILED for ${name}`, view: "emails.backup-failed" }),
    toDiscord: () =>
      new DiscordMessage(":cross_mark: Database backup failed", `Database backup for ${name} (db:${db}) has FAILED.`, DiscordMessage.errorColor(), true)
        .addField("Frequency", frequency, true)
        .addField("Output", output),
    toTelegram: () => ({ message: `${B}: Database backup for ${name} (db:${db}) with frequency of ${frequency} was FAILED.\n\nReason:\n${output}` }),
    toPushover: () =>
      new PushoverMessage("Database backup failed", `Database backup for ${name} (db:${db}) was FAILED<br/><br/><b>Frequency:</b> ${frequency} .<br/><b>Reason:</b> ${output}`, [], "error"),
    toSlack: () =>
      new SlackMessage(
        "Database backup failed",
        `Database backup for ${name} (db:${db}) has FAILED.` + `\n\n*Frequency:* ${frequency}` + `\n\n*Error Output:* ${output}`,
        SlackMessage.errorColor(),
      ),
    toWebhook: () => ({
      success: false,
      message: "Database backup failed",
      event: "backup_failed",
      database_name: name,
      database_uuid: input.database.uuid,
      database_type: db,
      frequency,
      error_output: output,
      url: databaseLink(ctx, input.database) ?? ctx.baseUrl,
    }),
  });
}

function backupMissing(
  ctx: PayloadContext,
  input: { backup: { uuid: string; description: string | null; missing_backup_notification_days: number; database: { name: string } | null }; last_execution_at: string | null },
): Notification {
  const B = ctx.brand;
  const backup = input.backup;
  const databaseName = backup.database?.name ?? backup.description ?? backup.uuid;
  const description = `The enabled backup schedule for ${databaseName} has produced no executions in the last ${backup.missing_backup_notification_days} day(s).`;
  const messageData = (): WebhookPayload => ({ database_name: databaseName, days: backup.missing_backup_notification_days, last_execution_at: input.last_execution_at });
  return base({
    kind: "BackupMissing",
    event: "backup_failure",
    telegramThread: "backup_failure",
    toMail: () => ({ subject: `${B}: [ACTION REQUIRED] No recent backup for ${databaseName}`, view: "emails.backup-missing" }),
    toDiscord: () => new DiscordMessage(":warning: Scheduled database backup missing", description, DiscordMessage.errorColor(), true),
    toTelegram: () => ({ message: `${B}: ` + description }),
    toPushover: () => new PushoverMessage("Scheduled database backup missing", description, [], "error"),
    toSlack: () => new SlackMessage("Scheduled database backup missing", description, SlackMessage.errorColor()),
    toWebhook: () => ({ ...messageData(), success: false, message: "Scheduled database backup missing", event: "backup_missing", backup_uuid: backup.uuid }),
  });
}

function backupSuccess(ctx: PayloadContext, input: { backup: { frequency: string }; database: DatabaseData; database_name: string }): Notification {
  const B = ctx.brand;
  const { name } = input.database;
  const { frequency } = input.backup;
  const db = input.database_name;
  return base({
    kind: "BackupSuccess",
    event: "backup_success",
    telegramThread: "backup_success",
    toMail: () => ({ subject: `${B}: Backup successfully done for ${name}`, view: "emails.backup-success" }),
    toDiscord: () =>
      new DiscordMessage(":white_check_mark: Database backup successful", `Database backup for ${name} (db:${db}) was successful.`, DiscordMessage.successColor()).addField("Frequency", frequency, true),
    toTelegram: () => ({ message: `${B}: Database backup for ${name} (db:${db}) with frequency of ${frequency} was successful.` }),
    toPushover: () => new PushoverMessage("Database backup successful", `Database backup for ${name} (db:${db}) was successful.<br/><br/><b>Frequency:</b> ${frequency}.`, [], "success"),
    toSlack: () => new SlackMessage("Database backup successful", `Database backup for ${name} (db:${db}) was successful.` + `\n\n*Frequency:* ${frequency}`, SlackMessage.successColor()),
    toWebhook: () => ({
      success: true,
      message: "Database backup successful",
      event: "backup_success",
      database_name: name,
      database_uuid: input.database.uuid,
      database_type: db,
      frequency,
      url: databaseLink(ctx, input.database) ?? ctx.baseUrl,
    }),
  });
}

function backupSuccessWithS3Warning(
  ctx: PayloadContext,
  input: { backup: { frequency: string; s3: { uuid: string } | null }; database: DatabaseData; database_name: string; s3_error: string },
): Notification {
  const B = ctx.brand;
  const { name } = input.database;
  const { frequency } = input.backup;
  const db = input.database_name;
  const error = input.s3_error;
  const storageUrl = input.backup.s3 ? ctx.baseUrl + "/storages/" + input.backup.s3.uuid : null;
  const created = `Database backup for ${name} (db:${db}) was created successfully on local storage, but failed to upload to the backup storage.`;
  return base({
    kind: "BackupSuccessWithS3Warning",
    event: "backup_failure",
    telegramThread: "backup_failure",
    toMail: () => ({ subject: `${B}: Backup succeeded locally but the storage upload failed for ${name}`, view: "emails.backup-success-with-s3-warning" }),
    toDiscord: () => {
      const message = new DiscordMessage(":warning: Database backup succeeded locally, storage upload failed", created, DiscordMessage.warningColor());
      message.addField("Frequency", frequency, true);
      message.addField("Storage Error", error);
      if (storageUrl) message.addField("Storage", "[Check Configuration](" + storageUrl + ")");
      return message;
    },
    toTelegram: () => {
      let message = `${B}: Database backup for ${name} (db:${db}) with frequency of ${frequency} succeeded locally but failed to upload to the backup storage.\n\nStorage Error:\n${error}`;
      if (storageUrl) message += `\n\nCheck Storage Configuration: ${storageUrl}`;
      return { message };
    },
    toPushover: () => {
      let message = `${created}<br/><br/><b>Frequency:</b> ${frequency}.<br/><b>Storage Error:</b> ${error}`;
      if (storageUrl) message += `<br/><br/><a href="${storageUrl}">Check Storage Configuration</a>`;
      return new PushoverMessage("Database backup succeeded locally, storage upload failed", message, [], "warning");
    },
    toSlack: () => {
      let description = created;
      description += `\n\n*Frequency:* ${frequency}`;
      description += `\n\n*Storage Error:* ${error}`;
      if (storageUrl) description += `\n\n*Storage:* <${storageUrl}|Check Configuration>`;
      return new SlackMessage("Database backup succeeded locally, storage upload failed", description, SlackMessage.warningColor());
    },
    toWebhook: () => {
      const data: WebhookPayload = {
        success: true,
        message: "Database backup succeeded locally, S3 upload failed",
        event: "backup_success_with_s3_warning",
        database_name: name,
        database_uuid: input.database.uuid,
        database_type: db,
        frequency,
        s3_error: error,
        url: databaseLink(ctx, input.database) ?? ctx.baseUrl,
      };
      if (storageUrl) data.s3_storage_url = storageUrl;
      return data;
    },
  });
}

/** ScheduledTask::url(). */
function taskUrl(ctx: PayloadContext, task: TaskData): string | null {
  const resource = task.application ?? task.service ?? null;
  if (!resource) return null;
  const type = task.application ? "application" : "service";
  return `${ctx.baseUrl}/project/${resource.environment?.project?.uuid ?? ""}/environment/${resource.environment?.uuid ?? ""}/${type}/${resource.uuid}/tasks/${task.uuid}`;
}

function taskWebhookOwner(task: TaskData, data: WebhookPayload, url: string | null): WebhookPayload {
  if (task.application) data.application_uuid = task.application.uuid;
  else if (task.service) data.service_uuid = task.service.uuid;
  if (url) data.url = url;
  return data;
}

function taskSuccess(ctx: PayloadContext, input: { task: TaskData; output: string }): Notification {
  const B = ctx.brand;
  const { task, output } = input;
  const url = taskUrl(ctx, task);
  return base({
    kind: "TaskSuccess",
    event: "scheduled_task_success",
    telegramThread: "scheduled_task_success",
    toMail: () => ({ subject: `${B}: Scheduled task (${task.name}) succeeded.`, view: "emails.scheduled-task-success" }),
    toDiscord: () => {
      const message = new DiscordMessage(":white_check_mark: Scheduled task succeeded", `Scheduled task (${task.name}) succeeded.`, DiscordMessage.successColor());
      if (url) message.addField("Scheduled task", "[Link](" + url + ")");
      return message;
    },
    // The class builds an "Open task" button but does not return it.
    toTelegram: () => ({ message: `${B}: Scheduled task (${task.name}) succeeded.` }),
    toPushover: () => new PushoverMessage("Scheduled task succeeded", `${B}: Scheduled task (${task.name}) succeeded.`, url ? [{ text: `Open task in ${B}`, url }] : [], "success"),
    toSlack: () => new SlackMessage("Scheduled task succeeded", `Scheduled task (${task.name}) succeeded.` + (url ? `\n\n*Task URL:* ${url}` : ""), SlackMessage.successColor()),
    toWebhook: () =>
      taskWebhookOwner(task, { success: true, message: "Scheduled task succeeded", event: "task_success", task_name: task.name, task_uuid: task.uuid, output }, url),
  });
}

function taskFailed(ctx: PayloadContext, input: { task: TaskData; output: string; disabled: boolean }): Notification {
  const B = ctx.brand;
  const { task, output, disabled } = input;
  const url = taskUrl(ctx, task);
  const title = disabled ? `Scheduled task (${task.name}) was disabled because it keeps failing.` : `Scheduled task (${task.name}) failed.`;
  const streakSummary = (): string => {
    if (disabled) return (task.disabled_reason ?? "Disabled automatically.") + " Fix the task, then enable it again.";
    const failures = task.consecutive_failures ?? 0;
    const summary = failures > 1 && task.failing_since ? `It failed ${failures} times in a row since ${task.failing_since} UTC. ` : "";
    return (
      summary +
      "While it keeps failing, you get at most one notification each day. After " +
      AUTO_DISABLE_AFTER_FAILURES +
      " failures in a row over more than " +
      AUTO_DISABLE_AFTER_HOURS +
      ` hours, ${B} disables the task.`
    );
  };
  return base({
    kind: "TaskFailed",
    event: "scheduled_task_failure",
    telegramThread: "scheduled_task_failure",
    toMail: () => ({ subject: `${B}: [ACTION REQUIRED] ${title}`, view: "emails.scheduled-task-failed" }),
    toDiscord: () => {
      const message = new DiscordMessage(disabled ? ":cross_mark: Scheduled task disabled" : ":cross_mark: Scheduled task failed", title + "\n\n" + streakSummary(), DiscordMessage.errorColor());
      if (url) message.addField("Scheduled task", "[Link](" + url + ")");
      return message;
    },
    // As in TaskSuccess, the button is built and not returned.
    toTelegram: (): TelegramMessage => ({ message: `${B}: ${title}\n\n${streakSummary()}\n\nOutput: ${output}` }),
    toPushover: () => {
      let message = `${title}<br/>${streakSummary()}<br/>`;
      if (truthy(output)) message += `<br/><b>Error Output:</b>${output}`;
      return new PushoverMessage(disabled ? "Scheduled task disabled" : "Scheduled task failed", message, url ? [{ text: `Open task in ${B}`, url }] : [], "error");
    },
    toSlack: () => {
      let description = title + "\n\n" + streakSummary();
      if (truthy(output)) description += `\n\n*Error Output:* ${output}`;
      if (url) description += `\n\n*Task URL:* ${url}`;
      return new SlackMessage(disabled ? "Scheduled task disabled" : "Scheduled task failed", description, SlackMessage.errorColor());
    },
    toWebhook: () =>
      taskWebhookOwner(
        task,
        {
          success: false,
          message: disabled ? "Scheduled task disabled" : "Scheduled task failed",
          event: disabled ? "task_disabled" : "task_failed",
          task_name: task.name,
          task_uuid: task.uuid,
          output,
          consecutive_failures: task.consecutive_failures ?? 0,
        },
        url,
      ),
  });
}

function volumeFields(b: VolumeBackupData) {
  return { resourceName: b.resourceName ?? "Unknown resource", target: b.targetType + " " + b.targetName, url: b.resourceUrl };
}

const openResource = (ctx: PayloadContext, url: string | null): PhpValue[] => (url ? [{ text: `Open resource in ${ctx.brand}`, url }] : []);

function volumeBackupSuccess(ctx: PayloadContext, input: { backup: VolumeBackupData; warning: string | null; uploadFailed: boolean }): Notification {
  const B = ctx.brand;
  const { resourceName, target, url } = volumeFields(input.backup);
  const { warning, uploadFailed } = input;
  const frequency = input.backup.frequency;
  const level: "error" | "warning" | "success" = uploadFailed ? "error" : filled(warning) ? "warning" : "success";
  const title = { error: "Storage backup upload failed", warning: "Storage backup succeeded with a warning", success: "Storage backup successful" }[level];
  const summary = uploadFailed
    ? `Storage backup of ${target} (${resourceName}) was created on the server, but the upload to the backup storage failed. The local archive is kept. ${warning ?? ""}`
    : `Storage backup of ${target} (${resourceName}) was successful.` + (truthy(warning) ? ` Warning: ${warning}` : "");
  return base({
    kind: "VolumeBackupSuccess",
    event: truthy(warning) ? "backup_failure" : "backup_success",
    telegramThread: truthy(warning) ? "backup_failure" : "backup_success",
    toMail: () => ({
      subject: {
        error: `${B}: Storage backup upload failed for ${resourceName}`,
        warning: `${B}: Storage backup succeeded with a warning for ${resourceName}`,
        success: `${B}: Storage backup successfully done for ${resourceName}`,
      }[level],
      view: "emails.volume-backup-result",
    }),
    toDiscord: () => {
      const message = new DiscordMessage(
        { error: ":cross_mark: ", warning: ":warning: ", success: ":white_check_mark: " }[level] + title,
        summary,
        { error: DiscordMessage.errorColor(), warning: DiscordMessage.warningColor(), success: DiscordMessage.successColor() }[level],
      );
      message.addField("Frequency", frequency, true);
      if (url) message.addField("Resource", "[Link](" + url + ")");
      return message;
    },
    toTelegram: () => {
      const data: TelegramMessage = { message: `${B}: ${summary}\n\nFrequency: ${frequency}` };
      if (url) data.buttons = openResource(ctx, url);
      return data;
    },
    toPushover: () => new PushoverMessage(title, `${summary}<br/><br/><b>Frequency:</b> ${frequency}.`, openResource(ctx, url), level),
    toSlack: () =>
      new SlackMessage(
        title,
        summary + `\n\n*Frequency:* ${frequency}` + (url ? `\n\n<${url}|Open resource in ${B}>` : ""),
        { error: SlackMessage.errorColor(), warning: SlackMessage.warningColor(), success: SlackMessage.successColor() }[level],
      ),
    toWebhook: () => ({
      success: true,
      message: title,
      event: "volume_backup_success",
      resource_name: resourceName,
      storage: target,
      frequency,
      warning,
      upload_failed: uploadFailed,
      url,
    }),
  });
}

function volumeBackupFailed(ctx: PayloadContext, input: { backup: VolumeBackupData; output: string }): Notification {
  const B = ctx.brand;
  const { resourceName, target, url } = volumeFields(input.backup);
  const frequency = input.backup.frequency;
  const output = input.output;
  const summary = `Storage backup of ${target} (${resourceName}) has FAILED.`;
  return base({
    kind: "VolumeBackupFailed",
    event: "backup_failure",
    telegramThread: "backup_failure",
    toMail: () => ({ subject: `${B}: [ACTION REQUIRED] Storage backup FAILED for ${resourceName}`, view: "emails.volume-backup-result" }),
    toDiscord: () => {
      const message = new DiscordMessage(":cross_mark: Storage backup failed", summary, DiscordMessage.errorColor(), true);
      message.addField("Frequency", frequency, true);
      message.addField("Output", output);
      if (url) message.addField("Resource", "[Link](" + url + ")");
      return message;
    },
    toTelegram: () => {
      const data: TelegramMessage = { message: `${B}: ${summary}\n\nFrequency: ${frequency}\n\nReason:\n${output}` };
      if (url) data.buttons = openResource(ctx, url);
      return data;
    },
    toPushover: () => new PushoverMessage("Storage backup failed", `${summary}<br/><br/><b>Frequency:</b> ${frequency}.<br/><b>Reason:</b> ${output}`, openResource(ctx, url), "error"),
    toSlack: () =>
      new SlackMessage("Storage backup failed", summary + `\n\n*Frequency:* ${frequency}\n\n*Error Output:* ${output}` + (url ? `\n\n<${url}|Open resource in ${B}>` : ""), SlackMessage.errorColor()),
    toWebhook: () => ({
      success: false,
      message: "Storage backup failed",
      event: "volume_backup_failed",
      resource_name: resourceName,
      storage: target,
      frequency,
      error_output: output,
      url,
    }),
  });
}

function volumeBackupMissing(ctx: PayloadContext, input: { backup: VolumeBackupData; last_execution_at: string | null }): Notification {
  const B = ctx.brand;
  const { resourceName, target, url } = volumeFields(input.backup);
  const summary = `The enabled storage backup schedule for ${target} (${resourceName}) has produced no executions in the last ${input.backup.missing_backup_notification_days} day(s).`;
  return base({
    kind: "VolumeBackupMissing",
    event: "backup_failure",
    telegramThread: "backup_failure",
    toMail: () => ({ subject: `${B}: [ACTION REQUIRED] No recent storage backup for ${resourceName}`, view: "emails.volume-backup-missing" }),
    toDiscord: () => {
      const message = new DiscordMessage(":warning: Scheduled storage backup missing", summary, DiscordMessage.errorColor(), true);
      if (url) message.addField("Resource", "[Link](" + url + ")");
      return message;
    },
    toTelegram: () => {
      const data: TelegramMessage = { message: `${B}: ${summary}` };
      if (url) data.buttons = openResource(ctx, url);
      return data;
    },
    toPushover: () => new PushoverMessage("Scheduled storage backup missing", summary, openResource(ctx, url), "error"),
    toSlack: () => new SlackMessage("Scheduled storage backup missing", summary + (url ? `\n\n<${url}|Open resource in ${B}>` : ""), SlackMessage.errorColor()),
    toWebhook: () => ({
      success: false,
      message: "Scheduled storage backup missing",
      event: "volume_backup_missing",
      resource_name: resourceName,
      storage: target,
      backup_uuid: input.backup.uuid,
      days: input.backup.missing_backup_notification_days,
      last_execution_at: input.last_execution_at,
      url,
    }),
  });
}

const RECOVERY_REASONS: Record<string, string> = {
  s3_auth: "S3 credentials were rejected",
  s3_bucket: "S3 bucket is missing",
  remote_command: "A command on the server failed",
};

function volumeBackupRecoveryFailed(
  ctx: PayloadContext,
  input: { execution: { uuid: string; recovery_error: string | null; stop_recovery_pending: boolean; backup: VolumeBackupData | null } },
): Notification {
  const B = ctx.brand;
  const ex = input.execution;
  const backup = ex.backup;
  const resourceName = backup?.resourceName ?? "Unknown resource";
  const target = backup ? backup.targetType + " " + backup.targetName : "Unknown storage";
  const reason = (ex.recovery_error !== null && RECOVERY_REASONS[ex.recovery_error]) || "Unknown error";
  const stopped = Boolean(ex.stop_recovery_pending);
  const url = backup?.resourceUrl ?? null;
  const first = `Recovery after the storage backup of ${target} (${resourceName}) failed: ${reason}.`;
  const summary = stopped
    ? first + " The containers stopped for the backup are still stopped, and new backups of this storage are skipped until you retry the recovery."
    : first + " The partial S3 upload was not removed. Retry the recovery after fixing the S3 storage.";
  return base({
    kind: "VolumeBackupRecoveryFailed",
    event: "backup_failure",
    telegramThread: "backup_failure",
    toMail: () => ({ subject: `${B}: [ACTION REQUIRED] Storage backup recovery FAILED for ${resourceName}`, view: "emails.volume-backup-recovery-failed" }),
    toDiscord: () => {
      const message = new DiscordMessage(":cross_mark: Storage backup recovery failed", summary, DiscordMessage.errorColor(), stopped);
      if (url) message.addField("Resource", "[Link](" + url + ")");
      return message;
    },
    toTelegram: () => {
      const data: TelegramMessage = { message: `${B}: [ACTION REQUIRED] ${summary}` };
      if (url) data.buttons = openResource(ctx, url);
      return data;
    },
    toPushover: () => new PushoverMessage("Storage backup recovery failed", `[ACTION REQUIRED] ${summary}`, openResource(ctx, url), "error"),
    toSlack: () => new SlackMessage(`${B}: [ACTION REQUIRED] Storage backup recovery failed`, summary + (url ? `\n\n<${url}|Open resource in ${B}>` : ""), SlackMessage.errorColor()),
    toWebhook: () => ({
      success: false,
      message: "Storage backup recovery failed",
      event: "volume_backup_recovery_failed",
      resource_name: resourceName,
      storage: target,
      execution_uuid: ex.uuid,
      reason: ex.recovery_error,
      containers_stopped: stopped,
      url,
    }),
  });
}

/** The notification of a backup or scheduled task class, or null for another class. */
export function backupNotification(ctx: PayloadContext, n: BackupNotificationInput): Notification | null {
  switch (n.class) {
    case "BackupFailed":
      return backupFailed(ctx, n.input);
    case "BackupMissing":
      return backupMissing(ctx, n.input);
    case "BackupSuccess":
      return backupSuccess(ctx, n.input);
    case "BackupSuccessWithS3Warning":
      return backupSuccessWithS3Warning(ctx, n.input);
    case "TaskSuccess":
      return taskSuccess(ctx, n.input);
    case "TaskFailed":
      return taskFailed(ctx, n.input);
    case "VolumeBackupSuccess":
      return volumeBackupSuccess(ctx, n.input);
    case "VolumeBackupFailed":
      return volumeBackupFailed(ctx, n.input);
    case "VolumeBackupMissing":
      return volumeBackupMissing(ctx, n.input);
    case "VolumeBackupRecoveryFailed":
      return volumeBackupRecoveryFailed(ctx, n.input);
    default:
      return null;
  }
}
