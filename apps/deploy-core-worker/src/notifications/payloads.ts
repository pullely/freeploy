// Derived from coollabsio/coolify@91b7e3e:app/Notifications/** (every notification class: toMail, toDiscord,
// toTelegram, toSlack, toPushover, toWebhook, via), app/Notifications/Channels/TelegramChannel.php (the
// thread of each class) and app/Traits/IncludesDeploymentCommitDetails.php (Apache-2.0), modified.
//
// A pure port: each notification is built from plain data — what Coolify's models hold when the class reads
// them — and answers what Coolify's class answers, held to fixtures/notifications/goldens.json byte for byte.
// The resolved values that belong to other parts of Coolify are inputs: a database's link(), a volume
// backup's target and resourceUrl(), the image scan's findings (ExploitedProblemFound keeps only scalars).
//
// Email: the subject and the view's name. The rendered body (Blade + Markdown) is not ported (DP-67 cut),
// except the test email's, which has no variables (testEmailHtml).
import { DiscordMessage, NotificationText, PushoverMessage, SlackMessage, type PayloadContext, type TelegramMessage } from "./messages.js";
import { e, firstFqdn, mbStrlen, mbSubstr, phpRtrim, str, type PhpValue } from "./php.js";
import {
  base,
  projectName,
  type ApplicationData,
  type EnvironmentData,
  type Notification,
  type PreviewData,
  type ResourceData,
  type ScanGateResult,
  type ServerData,
  type VulnerabilityDigestResource,
  type WebhookPayload,
} from "./notification.js";
import { serverNotification, type ServerNotificationInput } from "./payloads-servers.js";
import { backupNotification, type BackupNotificationInput } from "./payloads-backups.js";

export type NotificationInput =
  | { class: "Test"; input: { ping?: boolean } }
  | { class: "DeploymentSuccess" | "DeploymentFailed"; input: { application: ApplicationData; deployment_uuid: string; preview: PreviewData | null; deployment: { scan_gate_result?: ScanGateResult | null } | null } }
  | { class: "RestartLimitReached" | "StatusChanged"; input: { resource: ResourceData } }
  | { class: "ContainerRestarted"; input: { name: string; server: ServerData; url: string | null } }
  | { class: "SslExpirationNotification"; input: { resources: Array<{ name: string; uuid: string; environment: EnvironmentData | null }> } }
  | { class: "ApiTokenExpiringNotification"; input: { token: { name: string; expires_at: string | null } } }
  | { class: "ApiTokenFailingNotification"; input: { token: { name: string }; failedRequests: number; lastRequest: string } }
  | { class: "ScheduledJobRecovered"; input: { failureEvent: string; title: string; webhookEvent: string; url: string | null; webhookData: { [key: string]: PhpValue } } }
  | { class: "GeneralNotification"; input: { message: string; success: boolean } }
  | {
      class: "ExploitedProblemFound";
      input: { resourceName: string; resourceUuid: string; url: string | null; count: number; exploited: boolean; action: string | null; checkIncomplete: boolean };
    }
  | {
      class: "VulnerabilityDigest";
      input: {
        digest: {
          resources: VulnerabilityDigestResource[];
          ignores: Array<{ resource: string | null; id: string | null; package: string | null; expires_at: string }>;
          servers: Array<{ name: string; url: string }>;
        };
      };
    }
  | ServerNotificationInput
  | BackupNotificationInput;

/** Every class of app/Notifications that a team's channels send (the transactional emails are the instance's). */
export const NOTIFICATION_CLASSES = [
  "Test",
  "DeploymentSuccess",
  "DeploymentFailed",
  "RestartLimitReached",
  "StatusChanged",
  "ContainerRestarted",
  "BackupFailed",
  "BackupMissing",
  "BackupSuccess",
  "BackupSuccessWithS3Warning",
  "TaskSuccess",
  "TaskFailed",
  "DockerCleanupFailed",
  "DockerCleanupSuccess",
  "ForceDisabled",
  "ForceEnabled",
  "HetznerDeletionFailed",
  "HighDiskUsage",
  "HostKeyChanged",
  "Reachable",
  "Unreachable",
  "ServerPatchCheck",
  "TraefikVersionOutdated",
  "SslExpirationNotification",
  "ApiTokenExpiringNotification",
  "ApiTokenFailingNotification",
  "ScheduledJobRecovered",
  "GeneralNotification",
  "VolumeBackupSuccess",
  "VolumeBackupFailed",
  "VolumeBackupMissing",
  "VolumeBackupRecoveryFailed",
  "ExploitedProblemFound",
  "VulnerabilityDigest",
] as const;

/** The test email's body (resources/views/emails/test.blade.php in its layout), rendered. */
export function testEmailHtml(ctx: PayloadContext): string {
  return (
    "Hello,\n<p>If you are seeing this, it means that your Email settings are correct.</p>\n\n<hr />\n\n\nThank you,<br>\n" +
    e(ctx.appName) +
    '\n\n<p><a href="https://coolify.io/docs/contact">Contact Support</a></p>\n\n'
  );
}

// ---------------------------------------------------------------------------------------------------
// app/Notifications/Test.php

function test(ctx: PayloadContext, input: { ping?: boolean }): Notification {
  const B = ctx.brand;
  return base({
    kind: "Test",
    event: "test",
    isTest: true,
    toMail: () => ({ subject: `${B}: Test Email`, view: "emails.test" }),
    toDiscord: () =>
      new DiscordMessage(
        ":white_check_mark: Test Success",
        `This is a test Discord notification from ${B}. :cross_mark: :warning: :information_source:`,
        DiscordMessage.successColor(),
        input.ping ?? false,
      ).addField("Dashboard", "[Link](" + ctx.baseUrl + ")", true),
    toTelegram: () => ({
      message: `${B}: This is a test Telegram notification from ${B}.`,
      buttons: [{ text: "Go to your dashboard", url: ctx.baseUrl }],
    }),
    toPushover: () => new PushoverMessage("Test Pushover Notification", `This is a test Pushover notification from ${B}.`, [{ text: "Go to your dashboard", url: ctx.baseUrl }]),
    toSlack: () => new SlackMessage("Test Slack Notification", `This is a test Slack notification from ${B}.`),
    toWebhook: () => ({ success: true, message: `This is a test webhook notification from ${B}.`, event: "test", url: ctx.baseUrl }),
  });
}

// ---------------------------------------------------------------------------------------------------
// app/Notifications/Application/DeploymentSuccess.php, DeploymentFailed.php

interface DeploymentInput {
  application: ApplicationData;
  deployment_uuid: string;
  preview: PreviewData | null;
  deployment: { scan_gate_result?: ScanGateResult | null } | null;
}

function deploymentFields(ctx: PayloadContext, input: DeploymentInput) {
  const app = input.application;
  const environment = app.environment ?? null;
  const fqdn = firstFqdn(app.fqdn);
  const deploymentUrl = `${ctx.baseUrl}/project/${str(environment?.project?.uuid)}/environment/${str(environment?.uuid)}/application/${app.uuid}/deployment/${input.deployment_uuid}`;
  return { app, name: app.name, environmentName: environment?.name ?? null, project: projectName(environment), fqdn, deploymentUrl };
}

function deploymentSuccess(ctx: PayloadContext, input: DeploymentInput): Notification {
  const B = ctx.brand;
  const { app, name, environmentName, project, fqdn, deploymentUrl } = deploymentFields(ctx, input);
  const preview = input.preview;
  return base({
    kind: "DeploymentSuccess",
    event: "deployment_success",
    telegramThread: "deployment_success",
    toMail: () => {
      const pr = preview?.pull_request_id ?? 0;
      return {
        subject: pr === 0 ? `${B}: New version is deployed of ${name}` : `${B}: Pull request #${pr} of ${name} deployed successfully`,
        view: "emails.application-deployment-success",
      };
    },
    toDiscord: () => {
      let message: DiscordMessage;
      if (preview) {
        message = new DiscordMessage(":white_check_mark: Preview deployment successful", "Pull request: " + preview.pull_request_id, DiscordMessage.successColor());
        if (preview.fqdn) message.addField("Application", "[Link](" + preview.fqdn + ")");
        message.addField("Project", project, true);
        message.addField("Environment", environmentName, true);
        message.addField("Name", name, true);
        message.addField("Deployment logs", "[Link](" + deploymentUrl + ")");
      } else {
        const description = fqdn ? "[Open application](" + fqdn + ")" : "";
        message = new DiscordMessage(":white_check_mark: New version successfully deployed", description, DiscordMessage.successColor());
        message.addField("Project", project, true);
        message.addField("Environment", environmentName, true);
        message.addField("Name", name, true);
        message.addField("Deployment logs", "[Link](" + deploymentUrl + ")");
      }
      return message;
    },
    toTelegram: () => {
      const buttons: PhpValue[] = [];
      let message: string;
      if (preview) {
        message = `${B}: New PR` + preview.pull_request_id + " version successfully deployed of " + name;
        if (preview.fqdn) buttons.push({ text: "Open Application", url: preview.fqdn });
      } else {
        message = "✅ New version successfully deployed of " + name;
        if (fqdn) buttons.push({ text: "Open Application", url: fqdn });
      }
      buttons.push({ text: "Deployment logs", url: deploymentUrl });
      return { message, buttons };
    },
    toPushover: () => {
      const buttons: PhpValue[] = [];
      let title: string;
      let message: string;
      if (preview) {
        title = `Pull request #${preview.pull_request_id} successfully deployed`;
        message = "New PR" + preview.pull_request_id + " version successfully deployed of " + name;
        if (preview.fqdn) buttons.push({ text: "Open Application", url: preview.fqdn });
      } else {
        title = "New version successfully deployed";
        message = "New version successfully deployed of " + name;
        if (fqdn) buttons.push({ text: "Open Application", url: fqdn });
      }
      buttons.push({ text: "Deployment logs", url: deploymentUrl });
      return new PushoverMessage(title, message, buttons, "success");
    },
    toSlack: () => {
      let title: string;
      let description: string;
      if (preview) {
        title = `Pull request #${preview.pull_request_id} successfully deployed`;
        description = `New version successfully deployed for ${name}`;
        if (preview.fqdn) description += `\nPreview URL: ${preview.fqdn}`;
      } else {
        title = "New version successfully deployed";
        description = `New version successfully deployed for ${name}`;
        if (fqdn) description += `\nApplication URL: ${fqdn}`;
      }
      description += "\n\n*Project:* " + str(project);
      description += `\n*Environment:* ${str(environmentName)}`;
      description += `\n*<${deploymentUrl}|Deployment Logs>*`;
      return new SlackMessage(title, description, SlackMessage.successColor());
    },
    toWebhook: () => {
      const data: WebhookPayload = {
        success: true,
        message: "New version successfully deployed",
        event: "deployment_success",
        application_name: name,
        application_uuid: app.uuid,
        deployment_uuid: input.deployment_uuid,
        deployment_url: deploymentUrl,
        project,
        environment: environmentName,
      };
      if (preview) {
        data.pull_request_id = preview.pull_request_id;
        data.preview_fqdn = preview.fqdn;
      }
      if (fqdn) data.fqdn = fqdn;
      return data;
    },
  });
}

/** DeploymentFailed::blockedTitle(). */
function blockedTitle(headline: string): string {
  const h = phpRtrim(NotificationText.plain(mbSubstr(headline, 0, 300)), ".");
  if (h === "") return "Deploy blocked by the image scan";
  return h.startsWith("Deploy blocked") ? h : `Deploy blocked: ${h}`;
}

function deploymentFailed(ctx: PayloadContext, input: DeploymentInput): Notification {
  const B = ctx.brand;
  const { app, name, environmentName, project, fqdn, deploymentUrl } = deploymentFields(ctx, input);
  const preview = input.preview;
  let blocked: string | null = null;
  let blockedChat: string | null = null;
  const gate = input.deployment?.scan_gate_result ?? null;
  if (gate && typeof gate === "object" && gate.blocked) {
    const headline = str(gate.headline);
    blocked = blockedTitle(headline);
    blockedChat =
      gate.headline_plain !== undefined && gate.headline_plain !== null ? blockedTitle(str(gate.headline_plain)) : /\d/.test(headline) ? blockedTitle("") : blocked;
  }
  return base({
    kind: "DeploymentFailed",
    event: "deployment_failure",
    telegramThread: "deployment_failure",
    toMail: () => {
      const pr = preview?.pull_request_id ?? 0;
      let subject: string;
      if (blocked !== null) subject = `${B}: ` + blocked + " (" + name + ").";
      else if (pr === 0) subject = `${B}: Deployment failed of ` + name + ".";
      else subject = `${B}: Deployment failed of pull request #` + preview!.pull_request_id + " of " + name + ".";
      return { subject, view: "emails.application-deployment-failed" };
    },
    toDiscord: () => {
      let message: DiscordMessage;
      if (preview) {
        message = new DiscordMessage(blockedChat ?? ":cross_mark: Deployment failed", "Pull request: " + preview.pull_request_id, DiscordMessage.errorColor(), true);
        message.addField("Project", project, true);
        message.addField("Environment", environmentName, true);
        message.addField("Name", name, true);
        message.addField("Deployment Logs", "[Link](" + deploymentUrl + ")");
        if (fqdn) message.addField("Domain", fqdn, true);
      } else {
        const description = fqdn ? "[Open application](" + fqdn + ")" : "";
        message = new DiscordMessage(blockedChat ?? ":cross_mark: Deployment failed", description, DiscordMessage.errorColor(), true);
        message.addField("Project", project, true);
        message.addField("Environment", environmentName, true);
        message.addField("Name", name, true);
        message.addField("Deployment Logs", "[Link](" + deploymentUrl + ")");
      }
      return message;
    },
    toTelegram: () => {
      let message: string;
      if (blockedChat !== null) message = `${B}: ` + blockedChat + " (" + name + "): ";
      else if (preview) message = `${B}: Pull request #` + preview.pull_request_id + " of " + name + " (" + str(preview.fqdn) + ") deployment failed: ";
      else message = `${B}: Deployment failed of ` + name + " (" + str(fqdn) + "): ";
      return { message, buttons: [{ text: "Deployment logs", url: deploymentUrl }] };
    },
    toPushover: () => {
      let title: string;
      let message: string;
      if (blockedChat !== null) {
        title = blockedChat;
        message = "The image scan blocked the deployment of " + NotificationText.html(name) + ".";
      } else if (preview) {
        title = `Pull request #${preview.pull_request_id} deployment failed`;
        message = `Pull request deployment failed for ${name}`;
      } else {
        title = "Deployment failed";
        message = `Deployment failed for ${name}`;
      }
      return new PushoverMessage(title, message, [{ text: "Deployment logs", url: deploymentUrl }], "error");
    },
    toSlack: () => {
      let title: string;
      let description: string;
      if (preview) {
        title = `Pull request #${preview.pull_request_id} deployment failed`;
        description = `Pull request deployment failed for ${name}`;
        if (preview.fqdn) description += `\nPreview URL: ${preview.fqdn}`;
      } else {
        title = "Deployment failed";
        description = `Deployment failed for ${name}`;
        if (fqdn) description += `\nApplication URL: ${fqdn}`;
      }
      if (blockedChat !== null) {
        title = blockedChat;
        description = "The image scan blocked the deployment of " + NotificationText.slack(name) + ".";
      }
      description += "\n\n*Project:* " + str(project);
      description += `\n*Environment:* ${str(environmentName)}`;
      description += `\n*<${deploymentUrl}|Deployment Logs>*`;
      return new SlackMessage(title, description, SlackMessage.errorColor());
    },
    toWebhook: () => {
      const data: WebhookPayload = {
        success: false,
        message: blockedChat ?? "Deployment failed",
        event: "deployment_failed",
        application_name: name,
        application_uuid: app.uuid,
        deployment_uuid: input.deployment_uuid,
        deployment_url: deploymentUrl,
        project,
        environment: environmentName,
      };
      if (preview) {
        data.pull_request_id = preview.pull_request_id;
        data.preview_fqdn = preview.fqdn;
      }
      if (fqdn) data.fqdn = fqdn;
      if (blockedChat !== null) data.blocked = true;
      return data;
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// app/Notifications/Application/RestartLimitReached.php, StatusChanged.php

function resourceEnvironment(r: ResourceData): EnvironmentData | null {
  if ("application" in r) return r.application.environment ?? null;
  if ("service" in r) return r.service.environment ?? null;
  return r.environment ?? null;
}

/** [type, uuid] of the resource's page: its application's for a preview, its service's for a service part. */
function resourcePage(r: ResourceData): [string, string] {
  if ("application" in r) return ["application", r.application.uuid];
  if ("service" in r) return ["service", r.service.uuid];
  return [r.type, r.uuid];
}

function resourceFields(ctx: PayloadContext, r: ResourceData) {
  const environment = resourceEnvironment(r);
  const name = "application" in r ? r.application.name + " PR #" + r.pull_request_id : r.name;
  const [type, uuid] = resourcePage(r);
  const url = `${ctx.baseUrl}/project/${str(environment?.project?.uuid)}/environment/${str(environment?.uuid)}/${type}/${uuid}`;
  return { environment, name, fqdn: firstFqdn(r.fqdn ?? null), url, environmentName: environment?.name ?? null };
}

function restartLimitReached(ctx: PayloadContext, r: ResourceData): Notification {
  const B = ctx.brand;
  const { environment, name, fqdn, url, environmentName } = resourceFields(ctx, r);
  const count = r.restart_count;
  // restartLimitMaximum(): a preview's limit is its application's.
  const max = "application" in r ? (r.application.max_restart_count ?? r.max_restart_count ?? 0) : (r.max_restart_count ?? 0);
  const stopped = `${name} has been stopped after ${count} restarts (limit: ${max})`;
  return base({
    kind: "RestartLimitReached",
    event: "restart_limit_reached",
    telegramThread: "restart_limit_reached",
    toMail: () => ({ subject: `${B}: ${name} stopped - restart limit reached (${count}/${max})`, view: "emails.application-restart-limit-reached" }),
    toDiscord: () => new DiscordMessage(":warning: Restart limit reached", `${stopped}.\n\n[Open Resource in ${B}](${url})`, DiscordMessage.errorColor(), true),
    toTelegram: () => ({ message: `${B}: ${stopped}.`, buttons: [{ text: `Open Resource in ${B}`, url }] }),
    toPushover: () => new PushoverMessage("Restart limit reached", `${stopped}.`, [{ text: `Open Resource in ${B}`, url }], "error"),
    toSlack: () => {
      let description = stopped;
      description += "\n\n*Project:* " + str(projectName(environment));
      description += `\n*Environment:* ${str(environmentName)}`;
      description += `\n*Resource URL:* ${url}`;
      return new SlackMessage("Restart limit reached", description, SlackMessage.errorColor());
    },
    toWebhook: () => ({
      success: false,
      message: "Restart limit reached",
      event: "restart_limit_reached",
      application_name: name,
      application_uuid: r.uuid,
      resource_name: name,
      resource_uuid: r.uuid,
      restart_count: count,
      max_restart_count: max,
      url,
      // data_get($this->resource, 'environment.project.name'): only a resource with its own environment.
      project: "environment" in r ? projectName(r.environment) : null,
      environment: environmentName,
      fqdn,
    }),
  });
}

function statusChanged(ctx: PayloadContext, r: ResourceData): Notification {
  const B = ctx.brand;
  const { environment, name, fqdn, url, environmentName } = resourceFields(ctx, r);
  const project = projectName(environment);
  return base({
    kind: "StatusChanged",
    event: "status_change",
    telegramThread: "status_change",
    toMail: () => ({ subject: `${B}: ${name} has stopped`, view: "emails.application-status-changes" }),
    toDiscord: () => new DiscordMessage(":cross_mark: Resource stopped", `${name} has stopped.\n\n[Open Resource in ${B}](${url})`, DiscordMessage.errorColor(), true),
    toTelegram: () => ({ message: `${B}: ${name} has stopped.`, buttons: [{ text: `Open Resource in ${B}`, url }] }),
    toPushover: () => new PushoverMessage("Resource stopped", `${name} has stopped.`, [{ text: `Open Resource in ${B}`, url }], "error"),
    toSlack: () =>
      new SlackMessage("Resource stopped", `${name} has stopped\n\n*Project:* ${str(project)}\n*Environment:* ${str(environmentName)}\n*Resource URL:* ${url}`, SlackMessage.errorColor()),
    toWebhook: () => ({
      success: false,
      message: "Resource stopped",
      event: "status_changed",
      status: "exited",
      application_name: name,
      application_uuid: r.uuid,
      resource_name: name,
      resource_uuid: r.uuid,
      url,
      project,
      environment: environmentName,
      fqdn,
    }),
  });
}

// ---------------------------------------------------------------------------------------------------
// app/Notifications/Container/ContainerRestarted.php

function containerRestarted(ctx: PayloadContext, input: { name: string; server: ServerData; url: string | null }): Notification {
  const B = ctx.brand;
  const { name, server, url } = input;
  return base({
    kind: "ContainerRestarted",
    event: "status_change",
    telegramThread: "status_change",
    toMail: () => ({ subject: `${B}: A resource (${name}) has been restarted automatically on ${server.name}`, view: "emails.container-restarted" }),
    toDiscord: () => {
      const message = new DiscordMessage(":warning: Resource restarted", `${name} has been restarted automatically on ${server.name}.`, DiscordMessage.infoColor());
      if (url) message.addField("Resource", "[Link](" + url + ")");
      return message;
    },
    toTelegram: () => {
      const payload: TelegramMessage = { message: `${B}: A resource (${name}) has been restarted automatically on ${server.name}` };
      // A list in a list: the job finds no text or URL in it ("Click here", no link).
      if (url) payload.buttons = [[{ text: `Check Proxy in ${B}`, url }]];
      return payload;
    },
    toPushover: () =>
      new PushoverMessage("Resource restarted", `A resource (${name}) has been restarted automatically on ${server.name}`, url ? [{ text: `Check Proxy in ${B}`, url }] : [], "warning"),
    toSlack: () => {
      let description = `A resource (${name}) has been restarted automatically on ${server.name}`;
      if (url) description += `\n*Resource URL:* ${url}`;
      return new SlackMessage("Resource restarted", description, SlackMessage.warningColor());
    },
    toWebhook: () => {
      const data: WebhookPayload = {
        success: true,
        message: "Resource restarted automatically",
        event: "container_restarted",
        container_name: name,
        server_name: server.name,
        server_uuid: server.uuid,
      };
      if (url) data.url = url;
      return data;
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// app/Notifications/SslExpirationNotification.php

function sslExpiration(ctx: PayloadContext, input: { resources: Array<{ name: string; uuid: string; environment: EnvironmentData | null }> }): Notification {
  const B = ctx.brand;
  // mapWithKeys: one URL per name (a later resource with the same name replaces the earlier one's URL).
  const urls = new Map<string, string>();
  for (const r of input.resources) urls.set(r.name, `${ctx.baseUrl}/project/${str(r.environment?.project?.uuid)}/environment/${str(r.environment?.uuid)}/database/${r.uuid}`);
  const names = input.resources.map((r) => r.name).join(", ");
  const buttons = () => [...urls].map(([name, url]) => ({ text: `View ${name}`, url }));
  return base({
    kind: "SslExpirationNotification",
    event: "ssl_certificate_renewal",
    toMail: () => ({ subject: `${B}: [Action Required] SSL Certificates Renewed - Manual Redeployment Needed`, view: "emails.ssl-certificate-renewed" }),
    toDiscord: () => {
      const message = new DiscordMessage(
        "🔒 SSL Certificates Renewed",
        `SSL certificates have been renewed for: ${names}.\n\n**Action Required:** These resources need to be redeployed manually.`,
        DiscordMessage.warningColor(),
      );
      for (const [name, url] of urls) message.addField(name, `[View Resource](${url})`);
      return message;
    },
    toTelegram: () => ({
      message: `${B}: SSL certificates have been renewed for: ${names}.\n\nAction Required: These resources need to be redeployed manually for the new SSL certificates to take effect.`,
      buttons: buttons(),
    }),
    toPushover: () =>
      new PushoverMessage(
        "SSL Certificates Renewed",
        `SSL certificates have been renewed for: ${names}<br/><br/>` + "<b>Action Required:</b> These resources need to be redeployed manually for the new SSL certificates to take effect.",
        buttons(),
        "warning",
      ),
    toSlack: () => {
      let description = `SSL certificates have been renewed for: ${names}\n\n`;
      description += "**Action Required:** These resources need to be redeployed manually for the new SSL certificates to take effect.";
      if (urls.size > 0) {
        description += "\n\n**Resource URLs:**\n";
        for (const [name, url] of urls) description += `• ${name}: ${url}\n`;
      }
      return new SlackMessage("🔒 SSL Certificates Renewed", description, SlackMessage.warningColor());
    },
    toWebhook: () => ({
      success: false,
      message: `SSL certificates have been renewed for: ${names}. These resources need to be redeployed manually for the new SSL certificates to take effect.`,
      event: "ssl_certificate_renewal",
      resources: input.resources.map((r) => r.name),
      urls: Object.fromEntries(urls),
      url: ctx.baseUrl,
    }),
  });
}

// ---------------------------------------------------------------------------------------------------
// app/Notifications/ApiTokenExpiringNotification.php, ApiTokenFailingNotification.php

function apiTokenExpiring(ctx: PayloadContext, input: { token: { name: string; expires_at: string | null } }): Notification {
  const B = ctx.brand;
  const tokenName = input.token.name;
  const expiresAt = input.token.expires_at ?? "";
  const manageUrl = ctx.baseUrl + "/security/api-tokens";
  return base({
    kind: "ApiTokenExpiringNotification",
    event: "api_token_expiring",
    toMail: () => ({ subject: `${B}: API token '${tokenName}' expires on ${expiresAt}`, view: "emails.api-token-expiring" }),
    toDiscord: () =>
      new DiscordMessage(
        "🔑 API token expiring soon",
        `API token **${tokenName}** expires on ${expiresAt}.\n\n**Action Required:** Rotate this token before it expires to avoid API outages.`,
        DiscordMessage.warningColor(),
      ).addField("Manage tokens", `[Open API Tokens](${manageUrl})`),
    toTelegram: () => ({
      message: `${B}: API token '${tokenName}' expires on ${expiresAt}.\n\nAction Required: Rotate this token before it expires to avoid API outages.`,
      buttons: [{ text: "Manage API tokens", url: manageUrl }],
    }),
    toPushover: () =>
      new PushoverMessage(
        "API token expiring soon",
        `API token <b>${tokenName}</b> expires on ${expiresAt}.<br/><br/>` + "<b>Action Required:</b> Rotate this token before it expires to avoid API outages.",
        [{ text: "Manage API tokens", url: manageUrl }],
        "warning",
      ),
    toSlack: () =>
      new SlackMessage(
        "🔑 API token expiring soon",
        `API token *${tokenName}* expires on ${expiresAt}.\n\n` + "*Action Required:* Rotate this token before it expires to avoid API outages.\n\n" + `Manage tokens: ${manageUrl}`,
        SlackMessage.warningColor(),
      ),
    toWebhook: () => ({
      success: false,
      message: `API token '${tokenName}' expires on ${expiresAt}. Rotate this token before it expires to avoid API outages.`,
      event: "api_token_expiring",
      token_name: tokenName,
      expires_at: expiresAt,
      url: manageUrl,
    }),
  });
}

function apiTokenFailing(ctx: PayloadContext, input: { token: { name: string }; failedRequests: number; lastRequest: string }): Notification {
  const B = ctx.brand;
  const tokenName = input.token.name;
  const manageUrl = ctx.baseUrl + "/security/api-tokens";
  const summary = `API token '${tokenName}' sent ${input.failedRequests} failed requests in one minute. ${B} now answers its requests with 429 (Too Many Requests) until the failures stop.`;
  const action = "Find the client that uses this token and fix its requests, give the token the permissions it needs, or revoke the token.";
  return base({
    kind: "ApiTokenFailingNotification",
    event: "api_token_failing",
    toMail: () => ({ subject: `${B}: API token '${tokenName}' sends many failed requests`, view: "emails.api-token-failing" }),
    toDiscord: () =>
      new DiscordMessage("🔑 API token sends many failed requests", summary + "\n\n**Action Required:** " + action, DiscordMessage.warningColor())
        .addField("Last failed request", input.lastRequest)
        .addField("Manage tokens", `[Open API Tokens](${manageUrl})`),
    toTelegram: () => ({
      message: `${B}: ${summary}\n\nLast failed request: ${input.lastRequest}\n\nAction Required: ${action}`,
      buttons: [{ text: "Manage API tokens", url: manageUrl }],
    }),
    toPushover: () =>
      new PushoverMessage(
        "API token sends many failed requests",
        e(summary) + "<br/><br/>" + "Last failed request: " + e(input.lastRequest) + "<br/><br/>" + "<b>Action Required:</b> " + e(action),
        [{ text: "Manage API tokens", url: manageUrl }],
        "warning",
      ),
    toSlack: () =>
      new SlackMessage(
        "🔑 API token sends many failed requests",
        summary + "\n\n" + `Last failed request: ${input.lastRequest}\n\n` + "*Action Required:* " + action + "\n\n" + `Manage tokens: ${manageUrl}`,
        SlackMessage.warningColor(),
      ),
    toWebhook: () => ({
      success: false,
      message: summary,
      event: "api_token_failing",
      token_name: tokenName,
      failed_requests: input.failedRequests,
      last_request: input.lastRequest,
      url: manageUrl,
    }),
  });
}

// ---------------------------------------------------------------------------------------------------
// app/Notifications/ScheduledJobRecovered.php

function scheduledJobRecovered(
  ctx: PayloadContext,
  input: { failureEvent: string; title: string; webhookEvent: string; url: string | null; webhookData: { [key: string]: PhpValue } },
): Notification {
  const B = ctx.brand;
  const { title, url } = input;
  return base({
    kind: "ScheduledJobRecovered",
    event: input.failureEvent,
    toMail: () => ({ subject: `${B}: ${title}`, view: "emails.scheduled-job-recovered" }),
    toDiscord: () => {
      const message = new DiscordMessage(":white_check_mark: " + title, "The last run succeeded after failed runs.", DiscordMessage.successColor());
      if (url) message.addField("Link", `[Open in ${B}](` + url + ")");
      return message;
    },
    toTelegram: () => ({ message: `${B}: ${title}\n\nThe last run succeeded after failed runs.` }),
    toPushover: () => new PushoverMessage(title, "The last run succeeded after failed runs.", url ? [{ text: `Open in ${B}`, url }] : [], "success"),
    toSlack: () => new SlackMessage(title, "The last run succeeded after failed runs." + (url ? `\n\n*Link:* ${url}` : ""), SlackMessage.successColor()),
    toWebhook: () => {
      // array_filter([...]) of the non-null values; a key of webhookData replaces the same key in place.
      const merged: WebhookPayload = { success: true, message: title, event: input.webhookEvent, ...input.webhookData, url };
      return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== null && v !== undefined));
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// app/Notifications/Internal/GeneralNotification.php

function generalNotification(ctx: PayloadContext, input: { message: string; success: boolean }): Notification {
  const B = ctx.brand;
  const { message, success } = input;
  return base({
    kind: "GeneralNotification",
    event: "general",
    toMail: null,
    toDiscord: () => new DiscordMessage(success ? `${B}: General Notification` : `${B}: Action required`, message, success ? DiscordMessage.infoColor() : DiscordMessage.errorColor()),
    toTelegram: () => ({ message }),
    toPushover: () => new PushoverMessage(success ? "General Notification" : "Action required", message, [], success ? "info" : "error"),
    toSlack: () => new SlackMessage(success ? `${B}: General Notification` : `${B}: Action required`, message, success ? SlackMessage.infoColor() : SlackMessage.errorColor()),
    toWebhook: () => ({ success, message, event: "general", url: ctx.baseUrl }),
  });
}

// ---------------------------------------------------------------------------------------------------
// app/Notifications/ImageScan/ExploitedProblemFound.php, VulnerabilityDigest.php

const DIGEST_TITLE = "Daily security digest";
const DIGEST_BUTTON = "Open security status";
const DISCORD_LIMIT = 4096;
const TELEGRAM_LIMIT = 4096;
const SLACK_LIMIT = 3000;
const PUSHOVER_LIMIT = 1024;
const NAME_LIMIT = 100;
const SENTENCE_LIMIT = 500;

function exploitedProblemFound(
  ctx: PayloadContext,
  input: { resourceName: string; resourceUuid: string; url: string | null; count: number; exploited: boolean; action: string | null; checkIncomplete: boolean },
): Notification {
  const B = ctx.brand;
  const { resourceName, url, count, exploited, action, checkIncomplete } = input;
  const title = action !== null ? "Update now" : checkIncomplete ? "Check needed" : "No fix yet";
  const status = action !== null ? "update_now" : checkIncomplete ? "check_needed" : "no_fix";
  const sentence = (withCount: boolean): string => {
    const problems = withCount ? `${count} ` + (count === 1 ? "problem" : "problems") : count === 1 ? "a problem" : "problems";
    const use = exploited ? "are using" : "are likely to use";
    if (action !== null) return `${problems} that attackers ${use}. ${action}`;
    if (checkIncomplete) return `${problems} that attackers ${use}. ${B} could not check for a fixed version yet.`;
    return `${problems} that attackers ${use}, and no fixed version exists yet.`;
  };
  const fit = (build: (name: string, sentence: string) => string, budget: number): string => {
    let text = "";
    for (const [nameLimit, sentenceLimit] of [
      [100, 600],
      [60, 200],
      [30, 80],
    ] as const) {
      text = build(NotificationText.limit(resourceName, nameLimit), NotificationText.limit(sentence(false), sentenceLimit));
      if (mbStrlen(text) <= budget) break;
    }
    return text;
  };
  return base({
    kind: "ExploitedProblemFound",
    event: "image_vulnerabilities",
    telegramThread: "image_vulnerabilities",
    toMail: () => ({ subject: `${B}: ` + title + ": " + NotificationText.plain(resourceName), view: "emails.image-vulnerabilities" }),
    toDiscord: () =>
      new DiscordMessage(
        title,
        fit((name, s) => (url === null ? NotificationText.discord(name) : "[" + NotificationText.discord(name) + `](${url})`) + ": " + NotificationText.discord(s), DISCORD_LIMIT),
        DiscordMessage.errorColor(),
        true,
      ),
    toSlack: () =>
      new SlackMessage(
        title,
        fit((name, s) => (url === null ? NotificationText.slack(name) : `<${url}|` + NotificationText.slack(name) + ">") + ": " + NotificationText.slack(s), SLACK_LIMIT),
        SlackMessage.errorColor(),
      ),
    toTelegram: () => ({
      message: fit((name, s) => `${B}: ` + title + "\n\n" + name + ": " + s, TELEGRAM_LIMIT),
      buttons: url === null ? [] : [{ text: DIGEST_BUTTON, url }],
    }),
    toPushover: () => {
      const buttons = url === null ? [] : [{ text: DIGEST_BUTTON, url }];
      const buttonLength = url === null ? 0 : mbStrlen(`&nbsp;<a href='${url}'>${DIGEST_BUTTON}</a>`);
      return new PushoverMessage(title, fit((name, s) => NotificationText.html(name) + ": " + NotificationText.html(s), PUSHOVER_LIMIT - buttonLength), buttons, "error");
    },
    toWebhook: () => ({
      success: false,
      message: title,
      event: "image_exploited_problem",
      resource_name: resourceName,
      resource_uuid: input.resourceUuid,
      url,
      status,
      text: NotificationText.plain(resourceName) + ": " + sentence(false),
      action,
    }),
  });
}

function vulnerabilityDigest(
  ctx: PayloadContext,
  input: {
    digest: {
      resources: VulnerabilityDigestResource[];
      ignores: Array<{ resource: string | null; id: string | null; package: string | null; expires_at: string }>;
      servers: Array<{ name: string; url: string }>;
    };
  },
): Notification {
  const B = ctx.brand;
  const digest = input.digest;
  const teamUrl = phpRtrim(ctx.baseUrl, "/") + "/vulnerabilities";
  const name = (r: VulnerabilityDigestResource) => NotificationText.limit(r.name, NAME_LIMIT);
  const resourceSentence = (r: VulnerabilityDigestResource) => NotificationText.limit(phpTrimSpace(r.badge + ". " + (r.action ?? "")), SENTENCE_LIMIT);
  const chatLines = (resourceLine: (r: VulnerabilityDigestResource) => string, escape: (s: string) => string, budget: number): string[] => {
    const lines = digest.resources.map(resourceLine);
    const ignores = digest.ignores.length;
    if (ignores > 0) lines.push(ignores === 1 ? "An ignore ends within 7 days." : "Some ignores end within 7 days.");
    for (const server of digest.servers) lines.push(escape("Image scans failed for 2 days on " + NotificationText.limit(server.name, NAME_LIMIT) + "."));
    return NotificationText.fitLines(lines, budget);
  };
  return base({
    kind: "VulnerabilityDigest",
    event: "image_vulnerabilities",
    telegramThread: "image_vulnerabilities",
    toMail: () => ({ subject: `${B}: ` + DIGEST_TITLE, view: "emails.image-vulnerabilities" }),
    toDiscord: () => {
      const suffix = `\n\n[${DIGEST_BUTTON}](${teamUrl})`;
      const lines = chatLines(
        (r) => "• " + (r.url === null ? NotificationText.discord(name(r)) : "[" + NotificationText.discord(name(r)) + "](" + r.url + ")") + ": " + NotificationText.discord(resourceSentence(r)),
        NotificationText.discord,
        DISCORD_LIMIT - mbStrlen(suffix),
      );
      return new DiscordMessage(DIGEST_TITLE, lines.join("\n") + suffix, DiscordMessage.warningColor());
    },
    toSlack: () => {
      const suffix = `\n\n<${teamUrl}|${DIGEST_BUTTON}>`;
      const lines = chatLines(
        (r) => "• " + (r.url === null ? NotificationText.slack(name(r)) : "<" + r.url + "|" + NotificationText.slack(name(r)) + ">") + ": " + NotificationText.slack(resourceSentence(r)),
        NotificationText.slack,
        SLACK_LIMIT - mbStrlen(suffix),
      );
      return new SlackMessage(DIGEST_TITLE, lines.join("\n") + suffix, SlackMessage.warningColor());
    },
    toTelegram: () => {
      const prefix = `${B}: ` + DIGEST_TITLE + "\n\n";
      const lines = chatLines(
        (r) => "• " + NotificationText.plain(name(r)) + ": " + NotificationText.plain(resourceSentence(r)) + (r.url === null ? "" : "\n  " + r.url),
        NotificationText.plain,
        TELEGRAM_LIMIT - mbStrlen(prefix),
      );
      return { message: prefix + lines.join("\n"), buttons: [{ text: DIGEST_BUTTON, url: teamUrl }] };
    },
    toPushover: () => {
      const button = { text: DIGEST_BUTTON, url: teamUrl };
      const buttonLength = mbStrlen(`&nbsp;<a href='${button.url}'>${button.text}</a>`);
      const lines = chatLines(
        (r) =>
          "• " +
          (r.url === null ? NotificationText.html(name(r)) : "<a href='" + NotificationText.html(r.url) + "'>" + NotificationText.html(name(r)) + "</a>") +
          ": " +
          NotificationText.html(resourceSentence(r)),
        NotificationText.html,
        PUSHOVER_LIMIT - buttonLength,
      );
      return new PushoverMessage(DIGEST_TITLE, lines.join("\n"), [button], "warning");
    },
    toWebhook: () => ({
      success: false,
      message: DIGEST_TITLE,
      event: "image_vulnerabilities_digest",
      url: teamUrl,
      resources: digest.resources.map((r) => ({ name: r.name, uuid: r.uuid, url: r.url, status: r.status, action: r.action })),
      ignores_ending: digest.ignores.length > 0,
      servers_failing: digest.servers.map((s) => ({ name: s.name, url: s.url })),
    }),
  });
}

/** PHP's trim() of the digest sentence (ASCII whitespace only). */
function phpTrimSpace(s: string): string {
  return s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");
}

// ---------------------------------------------------------------------------------------------------

/** The notification of a class from its plain data. */
export function buildNotification(ctx: PayloadContext, n: NotificationInput): Notification {
  switch (n.class) {
    case "Test":
      return test(ctx, n.input);
    case "DeploymentSuccess":
      return deploymentSuccess(ctx, n.input);
    case "DeploymentFailed":
      return deploymentFailed(ctx, n.input);
    case "RestartLimitReached":
      return restartLimitReached(ctx, n.input.resource);
    case "StatusChanged":
      return statusChanged(ctx, n.input.resource);
    case "ContainerRestarted":
      return containerRestarted(ctx, n.input);
    case "SslExpirationNotification":
      return sslExpiration(ctx, n.input);
    case "ApiTokenExpiringNotification":
      return apiTokenExpiring(ctx, n.input);
    case "ApiTokenFailingNotification":
      return apiTokenFailing(ctx, n.input);
    case "ScheduledJobRecovered":
      return scheduledJobRecovered(ctx, n.input);
    case "GeneralNotification":
      return generalNotification(ctx, n.input);
    case "ExploitedProblemFound":
      return exploitedProblemFound(ctx, n.input);
    case "VulnerabilityDigest":
      return vulnerabilityDigest(ctx, n.input);
    default: {
      const server = serverNotification(ctx, n as ServerNotificationInput);
      if (server) return server;
      const backup = backupNotification(ctx, n as BackupNotificationInput);
      if (backup) return backup;
      throw new Error(`Unknown notification ${(n as { class: string }).class}`);
    }
  }
}

