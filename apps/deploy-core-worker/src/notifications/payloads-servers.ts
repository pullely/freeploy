// Derived from coollabsio/coolify@91b7e3e:app/Notifications/Server/{DockerCleanupFailed,DockerCleanupSuccess,
// ForceDisabled,ForceEnabled,HetznerDeletionFailed,HighDiskUsage,HostKeyChanged,Reachable,Unreachable,
// ServerPatchCheck,TraefikVersionOutdated}.php (Apache-2.0), modified.
//
// The server notifications, from plain data (see payloads.ts).
import { DiscordMessage, PushoverMessage, SlackMessage, type PayloadContext, type TelegramMessage } from "./messages.js";
import { filled, str, ucfirst, type PhpValue } from "./php.js";
import { base, type Notification, type ServerData, type WebhookPayload } from "./notification.js";

export interface PatchUpdate {
  package: string;
  current_version: string;
  new_version: string;
  risk?: string | null;
}

export interface PatchData {
  error?: string | null;
  total_updates?: number;
  updates?: PatchUpdate[];
  osId?: string;
  package_manager?: string;
  security_updates?: PhpValue;
  reboot_required?: PhpValue;
}

export interface TraefikOutdatedInfo {
  current?: string;
  latest?: string;
  type?: string;
  upgrade_target?: string;
  newer_branch_target?: string;
  newer_branch_latest?: string;
}

export type ServerNotificationInput =
  | { class: "DockerCleanupFailed" | "DockerCleanupSuccess"; input: { server: ServerData; message: string } }
  | { class: "ForceDisabled" | "ForceEnabled" | "HostKeyChanged" | "Reachable" | "Unreachable"; input: { server: ServerData } }
  | { class: "HetznerDeletionFailed"; input: { hetznerServerId: number; teamId: number; errorMessage: string } }
  | { class: "HighDiskUsage"; input: { server: ServerData; disk_usage: number; server_disk_usage_notification_threshold: number } }
  | { class: "ServerPatchCheck"; input: { server: ServerData; patchData: PatchData } }
  | { class: "TraefikVersionOutdated"; input: { servers: Array<ServerData & { outdatedInfo?: TraefikOutdatedInfo | null }> } };

const serverUrl = (ctx: PayloadContext, server: ServerData) => ctx.baseUrl + "/server/" + server.uuid;

function dockerCleanup(ctx: PayloadContext, input: { server: ServerData; message: string }, failed: boolean): Notification {
  const B = ctx.brand;
  const { server, message } = input;
  if (failed) {
    return base({
      kind: "DockerCleanupFailed",
      event: "docker_cleanup_failure",
      telegramThread: "docker_cleanup_failure",
      toMail: () => ({ subject: `${B}: [ACTION REQUIRED] Docker cleanup job failed on ${server.name}`, view: "emails.docker-cleanup-failed" }),
      toDiscord: () => new DiscordMessage(`:cross_mark: ${B}: [ACTION REQUIRED] Docker cleanup job failed on ` + server.name, message, DiscordMessage.errorColor()),
      toTelegram: () => ({ message: `${B}: [ACTION REQUIRED] Docker cleanup job failed on ${server.name}!\n\n${message}` }),
      toPushover: () => new PushoverMessage("Docker cleanup job failed", `[ACTION REQUIRED] Docker cleanup job failed on ${server.name}!\n\n${message}`, [], "error"),
      toSlack: () => new SlackMessage(`${B}: [ACTION REQUIRED] Docker cleanup job failed`, `Docker cleanup job failed on '${server.name}'!\n\n${message}`, SlackMessage.errorColor()),
      toWebhook: () => ({
        success: false,
        message: "Docker cleanup job failed",
        event: "docker_cleanup_failed",
        server_name: server.name,
        server_uuid: server.uuid,
        error_message: message,
        url: serverUrl(ctx, server),
      }),
    });
  }
  return base({
    kind: "DockerCleanupSuccess",
    event: "docker_cleanup_success",
    telegramThread: "docker_cleanup_success",
    toMail: () => ({ subject: `${B}: Docker cleanup job succeeded on ${server.name}`, view: "emails.docker-cleanup-success" }),
    toDiscord: () => new DiscordMessage(`:white_check_mark: ${B}: Docker cleanup job succeeded on ` + server.name, message, DiscordMessage.successColor()),
    toTelegram: () => ({ message: `${B}: Docker cleanup job succeeded on ${server.name}!\n\n${message}` }),
    toPushover: () => new PushoverMessage("Docker cleanup job succeeded", `Docker cleanup job succeeded on ${server.name}!\n\n${message}`, [], "success"),
    toSlack: () => new SlackMessage(`${B}: Docker cleanup job succeeded`, `Docker cleanup job succeeded on '${server.name}'!\n\n${message}`, SlackMessage.successColor()),
    toWebhook: () => ({
      success: true,
      message: "Docker cleanup job succeeded",
      event: "docker_cleanup_success",
      server_name: server.name,
      server_uuid: server.uuid,
      cleanup_message: message,
      url: serverUrl(ctx, server),
    }),
  });
}

function forceDisabled(ctx: PayloadContext, server: ServerData): Notification {
  const B = ctx.brand;
  const sub = ctx.subscriptionUrl;
  return base({
    kind: "ForceDisabled",
    event: "server_force_disabled",
    toMail: () => ({ subject: `${B}: Server (${server.name}) disabled because it is not paid!`, view: "emails.server-force-disabled" }),
    toDiscord: () =>
      new DiscordMessage(":cross_mark: Server disabled", `Server (${server.name}) disabled because it is not paid!`, DiscordMessage.errorColor()).addField(
        "Please update your subscription to enable the server again!",
        `[Link](${sub})`,
      ),
    toTelegram: () => ({
      message: `${B}: Server (${server.name}) disabled because it is not paid!\n All automations and integrations are stopped.\nPlease update your subscription to enable the server again [here](${sub}).`,
    }),
    toPushover: () =>
      new PushoverMessage(
        "Server disabled",
        `Server (${server.name}) disabled because it is not paid!\n All automations and integrations are stopped.<br/>Please update your subscription to enable the server again [here](${sub}).`,
        [],
        "error",
      ),
    toSlack: () =>
      new SlackMessage(
        "Server disabled",
        `Server (${server.name}) disabled because it is not paid!\n` + "All automations and integrations are stopped.\n\n" + `Please update your subscription to enable the server again: ${sub}`,
        SlackMessage.errorColor(),
      ),
    toWebhook: () => ({
      success: false,
      message: `Server (${server.name}) disabled because it is not paid! All automations and integrations are stopped.`,
      event: "server_force_disabled",
      server_name: server.name,
      server_uuid: server.uuid,
      url: serverUrl(ctx, server),
    }),
  });
}

function forceEnabled(ctx: PayloadContext, server: ServerData): Notification {
  const B = ctx.brand;
  return base({
    kind: "ForceEnabled",
    event: "server_force_enabled",
    toMail: () => ({ subject: `${B}: Server (${server.name}) enabled again!`, view: "emails.server-force-enabled" }),
    toDiscord: () => new DiscordMessage(":white_check_mark: Server enabled", `Server '${server.name}' enabled again!`, DiscordMessage.successColor()),
    toTelegram: () => ({ message: `${B}: Server (${server.name}) enabled again!` }),
    toPushover: () => new PushoverMessage("Server enabled", `Server (${server.name}) enabled again!`, [], "success"),
    toSlack: () => new SlackMessage("Server enabled", `Server '${server.name}' enabled again!`, SlackMessage.successColor()),
    toWebhook: () => ({
      success: true,
      message: `Server (${server.name}) enabled again!`,
      event: "server_force_enabled",
      server_name: server.name,
      server_uuid: server.uuid,
      url: serverUrl(ctx, server),
    }),
  });
}

function hetznerDeletionFailed(ctx: PayloadContext, input: { hetznerServerId: number; teamId: number; errorMessage: string }): Notification {
  const B = ctx.brand;
  const { hetznerServerId: id, errorMessage: error } = input;
  return base({
    kind: "HetznerDeletionFailed",
    event: "hetzner_deletion_failure",
    toMail: () => ({ subject: `${B}: [ACTION REQUIRED] Failed to delete Hetzner server #${id}`, view: "emails.hetzner-deletion-failed" }),
    toDiscord: () =>
      new DiscordMessage(
        `:cross_mark: ${B}: [ACTION REQUIRED] Failed to delete Hetzner server`,
        `Failed to delete Hetzner server #${id} from Hetzner Cloud.\n\n**Error:** ${error}\n\nThe server has been removed from ${B}, but may still exist in your Hetzner Cloud account. Please check your Hetzner Cloud console and manually delete the server if needed.`,
        DiscordMessage.errorColor(),
      ),
    toTelegram: () => ({
      message: `${B}: [ACTION REQUIRED] Failed to delete Hetzner server #${id} from Hetzner Cloud.\n\nError: ${error}\n\nThe server has been removed from ${B}, but may still exist in your Hetzner Cloud account. Please check your Hetzner Cloud console and manually delete the server if needed.`,
    }),
    toPushover: () =>
      new PushoverMessage(
        "Hetzner Server Deletion Failed",
        `[ACTION REQUIRED] Failed to delete Hetzner server #${id}.\n\nError: ${error}\n\nThe server has been removed from ${B}, but may still exist in your Hetzner Cloud account. Please check and manually delete if needed.`,
        [],
        "error",
      ),
    toSlack: () =>
      new SlackMessage(
        `${B}: [ACTION REQUIRED] Hetzner Server Deletion Failed`,
        `Failed to delete Hetzner server #${id} from Hetzner Cloud.\n\nError: ${error}\n\nThe server has been removed from ${B}, but may still exist in your Hetzner Cloud account. Please check your Hetzner Cloud console and manually delete the server if needed.`,
        SlackMessage.errorColor(),
      ),
    toWebhook: () => ({
      success: false,
      message: `[ACTION REQUIRED] Failed to delete Hetzner server #${id} from Hetzner Cloud. The server has been removed from ${B}, but may still exist in your Hetzner Cloud account.`,
      event: "hetzner_deletion_failed",
      hetzner_server_id: id,
      error,
      url: ctx.baseUrl + "/servers",
    }),
  });
}

const CLEANUP_TIPS = "https://coolify.io/docs/knowledge-base/server/automated-cleanup";

function highDiskUsage(ctx: PayloadContext, input: { server: ServerData; disk_usage: number; server_disk_usage_notification_threshold: number }): Notification {
  const B = ctx.brand;
  const { server, disk_usage: usage, server_disk_usage_notification_threshold: threshold } = input;
  return base({
    kind: "HighDiskUsage",
    event: "server_disk_usage",
    telegramThread: "server_disk_usage",
    toMail: () => ({ subject: `${B}: Server (${server.name}) high disk usage detected!`, view: "emails.high-disk-usage" }),
    toDiscord: () =>
      new DiscordMessage(":cross_mark: High disk usage detected", `Server '${server.name}' high disk usage detected!`, DiscordMessage.errorColor(), true)
        .addField("Disk usage", `${usage}%`, true)
        .addField("Threshold", `${threshold}%`, true)
        .addField("What to do?", `[Link](${CLEANUP_TIPS})`, true)
        .addField("Change Settings", "[Threshold](" + ctx.baseUrl + "/server/" + server.uuid + "#advanced) | [Notification](" + ctx.baseUrl + "/notifications/discord)"),
    toTelegram: () => ({
      message: `${B}: Server '${server.name}' high disk usage detected!\nDisk usage: ${usage}%. Threshold: ${threshold}%.\nPlease cleanup your disk to prevent data-loss.\nHere are some tips: ${CLEANUP_TIPS}.`,
    }),
    toPushover: () =>
      new PushoverMessage(
        "High disk usage detected",
        `Server '${server.name}' high disk usage detected!<br/><br/><b>Disk usage:</b> ${usage}%.<br/><b>Threshold:</b> ${threshold}%.<br/>Please cleanup your disk to prevent data-loss.`,
        // An array keyed by the label: the job finds no text or URL in a string ("Click here", no link).
        [ctx.baseUrl + "/server/" + server.uuid + "#advanced", CLEANUP_TIPS],
        "warning",
      ),
    toSlack: () => {
      let description = `Server '${server.name}' high disk usage detected!\n`;
      description += `Disk usage: ${usage}%\n`;
      description += `Threshold: ${threshold}%\n\n`;
      description += "Please cleanup your disk to prevent data-loss.\n";
      description += `Tips for cleanup: ${CLEANUP_TIPS}\n`;
      description += "Change settings:\n";
      description += "- Threshold: " + ctx.baseUrl + "/server/" + server.uuid + "#advanced\n";
      description += "- Notifications: " + ctx.baseUrl + "/notifications/slack";
      return new SlackMessage("High disk usage detected", description, SlackMessage.errorColor());
    },
    toWebhook: () => ({
      success: false,
      message: "High disk usage detected",
      event: "high_disk_usage",
      server_name: server.name,
      server_uuid: server.uuid,
      disk_usage: usage,
      threshold,
      url: serverUrl(ctx, server),
    }),
  });
}

function hostKeyChanged(ctx: PayloadContext, server: ServerData): Notification {
  const B = ctx.brand;
  const text =
    `The SSH host key of your server '${server.name}' does not match the key that ${B} trusts. ` +
    "This occurs when the server was reinstalled, or when another machine answers at its address. " +
    "Compare the new key with the key on the server, then trust it or reset it.";
  const url = ctx.baseUrl + "/server/" + server.uuid + "/security#server-host-key-section";
  return base({
    kind: "HostKeyChanged",
    event: "server_unreachable",
    toMail: () => ({ subject: `${B}: The SSH host key of your server (${server.name}) changed.`, view: "emails.server-host-key-changed" }),
    toDiscord: () => new DiscordMessage(":warning: SSH host key changed", text, DiscordMessage.errorColor()).addField("Check the new key", "[Link](" + url + ")"),
    toTelegram: () => ({ message: `${B}: ` + text, buttons: [{ text: "Check the new key", url }] }),
    toPushover: () => new PushoverMessage("SSH host key changed", text, [{ text: "Check the new key", url }], "error"),
    toSlack: () => new SlackMessage("SSH host key changed", text + "\n\nCheck the new key: " + url, SlackMessage.errorColor()),
    toWebhook: () => ({ success: false, message: "SSH host key changed", event: "server_ssh_host_key_changed", server_name: server.name, server_uuid: server.uuid, url }),
  });
}

function reachable(ctx: PayloadContext, server: ServerData): Notification {
  const B = ctx.brand;
  return base({
    kind: "Reachable",
    event: "server_reachable",
    telegramThread: "server_reachable",
    toMail: () => ({ subject: `${B}: Server (${server.name}) revived.`, view: "emails.server-revived" }),
    toDiscord: () => new DiscordMessage(`:white_check_mark: Server '${server.name}' revived`, "All automations & integrations are turned on again!", DiscordMessage.successColor()),
    toPushover: () => new PushoverMessage("Server revived", `Server '${server.name}' revived. All automations & integrations are turned on again!`, [], "success"),
    toTelegram: () => ({ message: `${B}: Server '${server.name}' revived. All automations & integrations are turned on again!` }),
    toSlack: () => new SlackMessage("Server revived", `Server '${server.name}' revived.\nAll automations & integrations are turned on again!`, SlackMessage.successColor()),
    toWebhook: () => ({ success: true, message: "Server revived", event: "server_reachable", server_name: server.name, server_uuid: server.uuid, url: serverUrl(ctx, server) }),
  });
}

function unreachable(ctx: PayloadContext, server: ServerData): Notification {
  const B = ctx.brand;
  return base({
    kind: "Unreachable",
    event: "server_unreachable",
    telegramThread: "server_unreachable",
    toMail: () => ({ subject: `${B}: Your server (${server.name}) is unreachable.`, view: "emails.server-lost-connection" }),
    toDiscord: () =>
      new DiscordMessage(":cross_mark: Server unreachable", `Your server '${server.name}' is unreachable.`, DiscordMessage.errorColor()).addField(
        "IMPORTANT",
        "We automatically try to revive your server and turn on all automations & integrations.",
      ),
    toTelegram: () => ({
      message: `${B}: Your server '${server.name}' is unreachable. All automations & integrations are turned off! Please check your server! IMPORTANT: We automatically try to revive your server and turn on all automations & integrations.`,
    }),
    toPushover: () =>
      new PushoverMessage(
        "Server unreachable",
        `Your server '${server.name}' is unreachable.<br/>All automations & integrations are turned off!<br/><br/><b>IMPORTANT:</b> We automatically try to revive your server and turn on all automations & integrations.`,
        [],
        "error",
      ),
    toSlack: () =>
      new SlackMessage(
        "Server unreachable",
        `Your server '${server.name}' is unreachable.\n` + "All automations & integrations are turned off!\n\n" + "*IMPORTANT:* We automatically try to revive your server and turn on all automations & integrations.",
        SlackMessage.errorColor(),
      ),
    toWebhook: () => ({ success: false, message: "Server unreachable", event: "server_unreachable", server_name: server.name, server_uuid: server.uuid, url: serverUrl(ctx, server) }),
  });
}

function serverPatchCheck(ctx: PayloadContext, input: { server: ServerData; patchData: PatchData }): Notification {
  const B = ctx.brand;
  const { server, patchData: p } = input;
  const patchesUrl = ctx.baseUrl + "/server/" + server.uuid + "/security/patches";
  // isset($patchData['error']): set and not null.
  const isError = p.error !== undefined && p.error !== null;
  const osId = p.osId ?? "unknown";
  const pm = p.package_manager ?? "unknown";
  const total = p.total_updates ?? 0;
  const updates = p.updates ?? [];
  const critical = () => updates.filter((u) => filled(u.risk ?? null));
  const line = (u: PatchUpdate) => `• ${u.package}: ${u.current_version} → ${u.new_version}\n`;
  return base({
    kind: "ServerPatchCheck",
    event: "server_patch",
    telegramThread: "server_patch",
    toMail: () =>
      isError
        ? { subject: `${B}: [ERROR] Failed to check patches on ${server.name}`, view: "emails.server-patches-error" }
        : { subject: `${B}: [ACTION REQUIRED] ${total} server patches available on ${server.name}`, view: "emails.server-patches" },
    toDiscord: () => {
      if (isError) {
        let description = `**Failed to check for updates** on server ${server.name}\n\n`;
        description += "**Error Details:**\n";
        description += "• OS: " + ucfirst(osId) + "\n";
        description += `• Package Manager: ${pm}\n`;
        description += `• Error: ${str(p.error)}\n\n`;
        description += `[Manage Server](${patchesUrl})`;
        return new DiscordMessage(`:x: ${B}: [ERROR] Failed to check patches on ` + server.name, description, DiscordMessage.errorColor());
      }
      let description = `**${total} package updates** available for server ${server.name}\n\n`;
      description += "**Summary:**\n";
      description += "• OS: " + ucfirst(osId) + "\n";
      description += `• Package Manager: ${pm}\n`;
      description += `• Total Updates: ${total}\n\n`;
      if (updates.length > 0) {
        description += "**Sample Updates:**\n";
        for (const u of updates.slice(0, 5)) description += line(u);
        if (updates.length > 5) description += "• ... and " + (updates.length - 5) + " more packages\n";
        const c = critical();
        if (c.length > 0) description += `\n **Critical packages detected** (${c.length} packages may require restarts)`;
        description += `\n [Manage Server Patches](${patchesUrl})`;
      }
      return new DiscordMessage(`:warning: ${B}: [ACTION REQUIRED] Server patches available on ` + server.name, description, DiscordMessage.errorColor());
    },
    toTelegram: (): TelegramMessage => {
      if (isError) {
        let message = `❌ ${B}: [ERROR] Failed to check patches on ${server.name}!\n\n`;
        message += "📊 Error Details:\n";
        message += "• OS: " + ucfirst(osId) + "\n";
        message += `• Package Manager: ${pm}\n`;
        message += `• Error: ${str(p.error)}\n\n`;
        return { message, buttons: [{ text: "Manage Server", url: patchesUrl }] };
      }
      let message = `🔧 ${B}: [ACTION REQUIRED] ${total} server patches available on ${server.name}!\n\n`;
      message += "📊 Summary:\n";
      message += "• OS: " + ucfirst(osId) + "\n";
      message += `• Package Manager: ${pm}\n`;
      message += `• Total Updates: ${total}\n\n`;
      if (updates.length > 0) {
        message += "📦 Sample Updates:\n";
        for (const u of updates.slice(0, 5)) message += line(u);
        if (updates.length > 5) message += "• ... and " + (updates.length - 5) + " more packages\n";
        const c = critical();
        if (c.length > 0) {
          message += `\n⚠️ Critical packages detected: ${c.length} packages may require restarts\n`;
          for (const u of c.slice(0, 3)) message += line(u);
          if (c.length > 3) message += "• ... and " + (c.length - 3) + " more critical packages\n";
        }
      }
      return { message, buttons: [{ text: "Manage Server Patches", url: patchesUrl }] };
    },
    toPushover: () => {
      if (isError) {
        let message = `[ERROR] Failed to check patches on ${server.name}!\n\n`;
        message += "Error Details:\n";
        message += "• OS: " + ucfirst(osId) + "\n";
        message += `• Package Manager: ${pm}\n`;
        message += `• Error: ${str(p.error)}\n\n`;
        return new PushoverMessage("Server patch check failed", message, [{ text: "Manage Server", url: patchesUrl }], "error");
      }
      let message = `[ACTION REQUIRED] ${total} server patches available on ${server.name}!\n\n`;
      message += "Summary:\n";
      message += "• OS: " + ucfirst(osId) + "\n";
      message += `• Package Manager: ${pm}\n`;
      message += `• Total Updates: ${total}\n\n`;
      if (updates.length > 0) {
        message += "Sample Updates:\n";
        for (const u of updates.slice(0, 3)) message += line(u);
        if (updates.length > 3) message += "• ... and " + (updates.length - 3) + " more packages\n";
        const c = critical();
        if (c.length > 0) message += `\nCritical packages detected: ${c.length} may require restarts`;
      }
      return new PushoverMessage("Server patches available", message, [{ text: "Manage Server Patches", url: patchesUrl }], "error");
    },
    toSlack: () => {
      if (isError) {
        let description = `Failed to check patches on '${server.name}'!\n\n`;
        description += "*Error Details:*\n";
        description += "• OS: " + ucfirst(osId) + "\n";
        description += `• Package Manager: ${pm}\n`;
        description += `• Error: \`${str(p.error)}\`\n\n`;
        description += `\n:link: <${patchesUrl}|Manage Server>`;
        return new SlackMessage(`${B}: [ERROR] Server patch check failed`, description, SlackMessage.errorColor());
      }
      let description = `${total} server patches available on '${server.name}'!\n\n`;
      description += "*Summary:*\n";
      description += "• OS: " + ucfirst(osId) + "\n";
      description += `• Package Manager: ${pm}\n`;
      description += `• Total Updates: ${total}\n\n`;
      const slackLine = (u: PatchUpdate) => `• \`${u.package}\`: ${u.current_version} → ${u.new_version}\n`;
      if (updates.length > 0) {
        description += "*Sample Updates:*\n";
        for (const u of updates.slice(0, 5)) description += slackLine(u);
        if (updates.length > 5) description += "• ... and " + (updates.length - 5) + " more packages\n";
        const c = critical();
        if (c.length > 0) {
          description += `\n:warning: *Critical packages detected:* ${c.length} packages may require restarts\n`;
          for (const u of c.slice(0, 3)) description += slackLine(u);
          if (c.length > 3) description += "• ... and " + (c.length - 3) + " more critical packages\n";
        }
      }
      description += `\n:link: <${patchesUrl}|Manage Server Patches>`;
      return new SlackMessage(`${B}: [ACTION REQUIRED] Server patches available`, description, SlackMessage.errorColor());
    },
    toWebhook: (): WebhookPayload => {
      if (isError) {
        return {
          success: false,
          message: "Failed to check patches",
          event: "server_patch_check_error",
          server_name: server.name,
          server_uuid: server.uuid,
          os_id: osId,
          package_manager: pm,
          error: p.error ?? null,
          url: patchesUrl,
        };
      }
      return {
        success: false,
        message: "Server patches available",
        event: "server_patch_check",
        server_name: server.name,
        server_uuid: server.uuid,
        total_updates: total,
        os_id: osId,
        package_manager: pm,
        updates: updates as unknown as PhpValue,
        critical_packages_count: critical().length,
        security_updates: p.security_updates ?? null,
        reboot_required: p.reboot_required ?? null,
        url: patchesUrl,
      };
    },
  });
}

type OutdatedServer = ServerData & { outdatedInfo?: TraefikOutdatedInfo | null };

function traefikVersionOutdated(ctx: PayloadContext, input: { servers: OutdatedServer[] }): Notification {
  const B = ctx.brand;
  const servers = input.servers;
  const count = servers.length;
  const formatVersion = (v: string) => (v.startsWith("v") ? v : `v${v}`);
  const upgradeTarget = (info: TraefikOutdatedInfo) =>
    (info.type ?? "patch_update") === "minor_upgrade" && info.upgrade_target !== undefined && info.upgrade_target !== null ? formatVersion(info.upgrade_target) : formatVersion(info.latest ?? "unknown");
  const hasUpgrades = servers.some((s) => (s.outdatedInfo?.type ?? "patch_update") === "minor_upgrade" || (s.outdatedInfo?.newer_branch_target !== undefined && s.outdatedInfo?.newer_branch_target !== null));
  /** The lines of one server; `code` wraps the name for Slack, `also` is the "Also available" line's form. */
  const serverLines = (s: OutdatedServer, nameOf: (name: string) => string, also: (target: string, latest: string) => string): string => {
    const info = s.outdatedInfo ?? {};
    const current = formatVersion(info.current ?? "unknown");
    const latest = formatVersion(info.latest ?? "unknown");
    const target = upgradeTarget(info);
    const isPatch = (info.type ?? "patch_update") === "patch_update";
    const hasNewerBranch = info.newer_branch_target !== undefined && info.newer_branch_target !== null;
    if (isPatch && hasNewerBranch) {
      return `• ${nameOf(s.name)}: ${current} → ${target} (patch update available)\n` + also(info.newer_branch_target!, formatVersion(info.newer_branch_latest!));
    }
    if (isPatch) return `• ${nameOf(s.name)}: ${current} → ${target} (patch update available)\n`;
    return `• ${nameOf(s.name)}: ${current} (latest patch: ${latest}) → ${target} (new minor version available)\n`;
  };
  const plainName = (n: string) => n;
  const longAlso = (t: string, l: string) => `  ↳ Also available: ${t} (latest patch: ${l}) - new minor version\n`;
  return base({
    kind: "TraefikVersionOutdated",
    event: "traefik_outdated",
    telegramThread: "traefik_outdated",
    toMail: () => ({ subject: `${B}: Traefik proxy outdated on ${count} server(s)`, view: "emails.traefik-version-outdated" }),
    toDiscord: () => {
      let description = `**${count} server(s)** running outdated Traefik proxy. Update recommended for security and features.\n\n`;
      description += "**Affected servers:**\n";
      for (const s of servers) description += serverLines(s, plainName, longAlso);
      description += "\n⚠️ It is recommended to test before switching the production version.";
      if (hasUpgrades) description += "\n\n📖 **For minor version upgrades**: Read the Traefik changelog before upgrading to understand breaking changes and new features.";
      return new DiscordMessage(`:warning: ${B}: Traefik proxy outdated`, description, DiscordMessage.warningColor());
    },
    toTelegram: () => {
      let message = `⚠️ ${B}: Traefik proxy outdated on ${count} server(s)!\n\n`;
      message += "Update recommended for security and features.\n";
      message += "📊 Affected servers:\n";
      for (const s of servers) message += serverLines(s, plainName, longAlso);
      message += "\n⚠️ It is recommended to test before switching the production version.";
      if (hasUpgrades) message += "\n\n📖 For minor version upgrades: Read the Traefik changelog before upgrading to understand breaking changes and new features.";
      return { message, buttons: [] };
    },
    toPushover: () => {
      let message = `Traefik proxy outdated on ${count} server(s)!\n`;
      message += "Affected servers:\n";
      for (const s of servers) message += serverLines(s, plainName, (t, l) => `  Also: ${t} (latest: ${l}) - new minor version\n`);
      message += "\nIt is recommended to test before switching the production version.";
      if (hasUpgrades) message += "\n\nFor minor version upgrades: Read the Traefik changelog before upgrading.";
      return new PushoverMessage("Traefik proxy outdated", message, [], "warning");
    },
    toSlack: () => {
      let description = `Traefik proxy outdated on ${count} server(s)!\n`;
      description += "*Affected servers:*\n";
      for (const s of servers) description += serverLines(s, (n) => `\`${n}\``, longAlso);
      description += "\n:warning: It is recommended to test before switching the production version.";
      if (hasUpgrades) description += "\n\n:book: For minor version upgrades: Read the Traefik changelog before upgrading to understand breaking changes and new features.";
      return new SlackMessage(`${B}: Traefik proxy outdated`, description, SlackMessage.warningColor());
    },
    toWebhook: () => ({
      success: false,
      message: "Traefik proxy outdated",
      event: "traefik_version_outdated",
      affected_servers_count: count,
      servers: servers.map((s) => {
        const info = s.outdatedInfo ?? {};
        const data: WebhookPayload = {
          name: s.name,
          uuid: s.uuid,
          current_version: info.current ?? "unknown",
          latest_version: info.latest ?? "unknown",
          update_type: info.type ?? "patch_update",
        };
        if ((info.type ?? "patch_update") === "minor_upgrade" && info.upgrade_target !== undefined && info.upgrade_target !== null) data.upgrade_target = info.upgrade_target;
        if (info.newer_branch_target !== undefined && info.newer_branch_target !== null) {
          data.newer_branch_target = info.newer_branch_target;
          data.newer_branch_latest = info.newer_branch_latest ?? null;
        }
        return data;
      }),
    }),
  });
}

/** The notification of a server class, or null for another class. */
export function serverNotification(ctx: PayloadContext, n: ServerNotificationInput): Notification | null {
  switch (n.class) {
    case "DockerCleanupFailed":
      return dockerCleanup(ctx, n.input, true);
    case "DockerCleanupSuccess":
      return dockerCleanup(ctx, n.input, false);
    case "ForceDisabled":
      return forceDisabled(ctx, n.input.server);
    case "ForceEnabled":
      return forceEnabled(ctx, n.input.server);
    case "HetznerDeletionFailed":
      return hetznerDeletionFailed(ctx, n.input);
    case "HighDiskUsage":
      return highDiskUsage(ctx, n.input);
    case "HostKeyChanged":
      return hostKeyChanged(ctx, n.input.server);
    case "Reachable":
      return reachable(ctx, n.input.server);
    case "Unreachable":
      return unreachable(ctx, n.input.server);
    case "ServerPatchCheck":
      return serverPatchCheck(ctx, n.input);
    case "TraefikVersionOutdated":
      return traefikVersionOutdated(ctx, n.input);
    default:
      return null;
  }
}
