// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Configuration.php (Apache-2.0),
// modified.
//
// What an application's Git Source, Servers, Webhooks, Scheduled Tasks and
// Rollback pages share: the store they read and write through, the ciphers of
// the `encrypted` columns they touch, and the application as the
// configuration frame and each page need it.
import type {
  ApplicationSourceChanges,
  DeployAdditionalDestinationRow,
  DeployApplicationConfigurationRow,
  DeployApplicationRollbackRow,
  DeployApplicationRow,
  DeployApplicationSourceRow,
  DeployDestinationServerRow,
  DeployGitSourceRow,
  DeployScheduledTaskExecutionRow,
  DeployScheduledTaskRow,
  DeployServerNetworkRow,
  GitSourceKind,
  ScheduledTaskChanges,
} from "@saas/db/deploy";
import type { KeyCipher } from "../private-keys/service.js";
import { applicationShow, type ApplicationShow } from "./service.js";

type Id = string | number;

export interface DeployKey {
  id: Id;
  uuid: string;
  name: string;
}

export interface ApplicationMoreStore {
  /** The application as the configuration frame reads it (heading, menu). */
  findByUuid(uuid: string): Promise<DeployApplicationRow | null>;
  /** The application with its settings and its destination's server. */
  configuration(uuid: string): Promise<DeployApplicationConfigurationRow | null>;

  // Git Source and Webhooks
  source(uuid: string): Promise<DeployApplicationSourceRow | null>;
  updateSource(applicationId: Id, changes: ApplicationSourceChanges): Promise<boolean>;
  /** The org's private keys, oldest first. */
  deployKeys(): Promise<DeployKey[]>;
  findDeployKey(id: Id): Promise<DeployKey | null>;
  /** Team::sources(): the org's Git sources that are not public. */
  gitSources(): Promise<DeployGitSourceRow[]>;
  findGitSource(kind: GitSourceKind, id: Id): Promise<DeployGitSourceRow | null>;

  // Servers
  /** $application->additional_networks, oldest first. */
  additionalDestinations(applicationId: Id): Promise<DeployAdditionalDestinationRow[]>;
  /** Every standalone network of the org's servers, by server name. */
  serverNetworks(): Promise<DeployServerNetworkRow[]>;
  findServer(serverId: Id): Promise<DeployDestinationServerRow | null>;
  findNetwork(serverId: Id, networkId: Id): Promise<{ id: Id; uuid: string; name: string; network: string } | null>;
  hasAdditionalDestination(applicationId: Id, serverId: Id, networkId?: Id): Promise<boolean>;
  attachDestination(applicationId: Id, serverId: Id, networkId: Id): Promise<boolean>;
  detachDestination(applicationId: Id, serverId: Id, networkId: Id): Promise<boolean>;
  promoteDestination(applicationId: Id, promoted: { serverId: Id; networkId: Id }, main: { serverId: Id; networkId: Id } | null): Promise<boolean>;
  /** $application->persistentStorages()->count() */
  volumeCount(applicationId: Id): Promise<number>;
  /** Whether a deployment was ever queued for the application. */
  hasDeployments(applicationId: Id): Promise<boolean>;

  // Scheduled Tasks
  tasks(applicationId: Id): Promise<DeployScheduledTaskRow[]>;
  findTask(applicationId: Id, uuid: string): Promise<DeployScheduledTaskRow | null>;
  insertTask(task: { applicationId: Id; uuid: string; name: string; command: string; frequency: string; container: string | null; timeout: number; useShell: boolean }): Promise<DeployScheduledTaskRow>;
  updateTask(applicationId: Id, id: Id, changes: ScheduledTaskChanges): Promise<boolean>;
  deleteTask(applicationId: Id, id: Id): Promise<boolean>;
  /** The task's last 20 executions, the newest first. */
  executions(taskId: Id): Promise<DeployScheduledTaskExecutionRow[]>;

  // Rollback
  rollback(uuid: string): Promise<DeployApplicationRollbackRow | null>;
  updateImagesToKeep(applicationId: Id, dockerImagesToKeep: number): Promise<boolean>;
}

/** The `encrypted` columns of deploy.applications these pages read and write. */
export const MORE_SECRET_COLUMNS = [
  "git_https_password",
  "manual_webhook_secret_github",
  "manual_webhook_secret_gitlab",
  "manual_webhook_secret_bitbucket",
  "manual_webhook_secret_gitea",
] as const;
export type MoreSecretColumn = (typeof MORE_SECRET_COLUMNS)[number];

export interface ApplicationMoreContext {
  store: ApplicationMoreStore;
  /** The cipher of one `encrypted` column: the value is bound to "applications.<column>". */
  secret(column: MoreSecretColumn): KeyCipher;
  /**
   * DP-72: githubApi($source, "repos/{slug}")['data']['id'] — the repository's id at GitHub, asked through the
   * org's GitHub App of that id (a refusal throws githubApi()'s message).
   */
  githubRepositoryId?(sourceId: string | number, slug: string): Promise<number | null>;
}

export interface LoadedApplication {
  /** The frame's row: status, build pack, the main destination. */
  frame: DeployApplicationRow;
  /** The configuration row: the main destination's server (id, proxy). */
  row: DeployApplicationConfigurationRow;
  application: ApplicationShow;
}

/** The application for the frame and for the page, or null when it is not the org's. */
export async function loadApplication(ctx: ApplicationMoreContext, uuid: string, canUpdate: boolean): Promise<LoadedApplication | null> {
  const row = await ctx.store.configuration(uuid);
  const frame = row ? await ctx.store.findByUuid(uuid) : null;
  return row && frame ? { frame, row, application: applicationShow(frame, canUpdate) } : null;
}

/** A body field read as PHP's bool cast for a `boolean` rule: true, false, 1, 0, "1", "0"; anything else is undefined. */
export function booleanValue(value: unknown): boolean | undefined {
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return undefined;
}

/** Laravel's `integer` rule (FILTER_VALIDATE_INT): an integer or its decimal text. */
export function integerOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) return Number(value.trim());
  return null;
}

/** Whether the application's status says it runs: str($status)->startsWith('running'). */
export const isRunning = (status: string): boolean => status.startsWith("running");
