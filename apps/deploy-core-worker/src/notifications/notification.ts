// Derived from coollabsio/coolify@91b7e3e:app/Notifications/** and app/Notifications/Channels/TelegramChannel.php
// (Apache-2.0), modified.
//
// What every ported notification class answers (payloads.ts, payloads-servers.ts, payloads-backups.ts), and
// the plain data the classes share.
import type { DiscordMessage, PushoverMessage, SlackMessage, TelegramMessage } from "./messages.js";
import type { PhpValue } from "./php.js";

export type Channel = "email" | "discord" | "telegram" | "slack" | "pushover" | "webhook";

/** The Telegram thread setting a class posts to (TelegramChannel's match): telegram_notifications_{key}_thread_id. */
export type TelegramThread =
  | "deployment_success"
  | "deployment_failure"
  | "status_change"
  | "restart_limit_reached"
  | "backup_success"
  | "backup_failure"
  | "scheduled_task_success"
  | "scheduled_task_failure"
  | "docker_cleanup_success"
  | "docker_cleanup_failure"
  | "server_disk_usage"
  | "server_unreachable"
  | "server_reachable"
  | "server_patch"
  | "traefik_outdated"
  | "image_vulnerabilities";

export interface MailMessage {
  subject: string;
  view: string;
}

export type WebhookPayload = { [key: string]: PhpValue | undefined };

/** One notification, as Coolify's class answers for each channel. */
export interface Notification {
  /** Coolify's class. */
  kind: string;
  /** The event of via(): getEnabledChannels($event). */
  event: string;
  /** A test notification never counts a delivery failure ($isTestNotification). */
  isTest: boolean;
  telegramThread: TelegramThread | null;
  /** GeneralNotification has no email. */
  toMail: (() => MailMessage) | null;
  toDiscord(): DiscordMessage;
  toTelegram(): TelegramMessage;
  toSlack(): SlackMessage;
  toPushover(): PushoverMessage;
  toWebhook(): WebhookPayload;
}

export interface ProjectData {
  uuid: string;
  name?: string | null;
}
export interface EnvironmentData {
  uuid: string;
  name?: string | null;
  project?: ProjectData | null;
}
export interface ApplicationData {
  uuid: string;
  name: string;
  fqdn?: string | null;
  git_branch?: string | null;
  max_restart_count?: number | null;
  environment?: EnvironmentData | null;
}
export interface PreviewData {
  pull_request_id: number;
  fqdn: string | null;
}
export interface ServerData {
  uuid: string;
  name: string;
}

/** A resource a status or restart notification names: Application, ApplicationPreview, ServiceApplication/ServiceDatabase or a database. */
export type ResourceData =
  | { type: "application" | "database"; uuid: string; name: string; fqdn?: string | null; restart_count: number; max_restart_count?: number | null; environment: EnvironmentData | null }
  | { type: "preview"; uuid: string; pull_request_id: number; fqdn?: string | null; restart_count: number; max_restart_count?: number | null; application: ApplicationData }
  | {
      type: "service_application" | "service_database";
      uuid: string;
      name: string;
      fqdn?: string | null;
      restart_count: number;
      max_restart_count?: number | null;
      service: { uuid: string; environment: EnvironmentData | null };
    };

export interface ScanGateResult {
  blocked?: boolean;
  headline?: string | null;
  headline_plain?: string | null;
}

export interface VulnerabilityDigestResource {
  name: string;
  uuid: string;
  url: string | null;
  status: string;
  badge: string;
  action: string | null;
}

/** Helpers the class files share. */
export function base(n: Omit<Notification, "isTest" | "telegramThread"> & Partial<Pick<Notification, "isTest" | "telegramThread">>): Notification {
  return { isTest: false, telegramThread: null, ...n };
}

/** data_get($x, 'project.name') of an environment: the name, or null. */
export function projectName(environment: EnvironmentData | null | undefined): string | null {
  return environment?.project?.name ?? null;
}

