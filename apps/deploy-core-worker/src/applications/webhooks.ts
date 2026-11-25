// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Shared/Webhooks.php,
// app/Rules/ManualWebhookSecret.php, bootstrap/helpers/shared.php (generateDeployWebhook,
// generateGitManualWebhook) and app/Models/Application.php (git_based, gitWebhook) (Apache-2.0), modified.
//
// An application's Webhooks page: the deploy webhook, and the manual Git
// webhooks of GitHub, GitLab, Bitbucket and Gitea with their secrets (four
// `encrypted` columns). The URLs are Coolify's paths; their host is the
// environment's API origin, which the page knows and this worker does not, so
// the paths are answered. The endpoints that receive them are DP6 and DP9.
import { WEBHOOK_SECRET_COLUMN, type ApplicationSourceChanges, type DeployApplicationSourceRow } from "@saas/db/deploy";
import { randomString } from "../helpers/names.js";
import { length, type FieldErrors } from "../private-keys/validation.js";
import type { ApplicationShow } from "./service.js";
import { SettingsError, SettingsFieldErrors } from "./settings.js";
import { loadApplication, type ApplicationMoreContext, type LoadedApplication } from "./more.js";
import { gitLinks, resolveSource } from "./source.js";

type Body = Record<string, unknown>;

export const WEBHOOK_PROVIDERS = ["github", "gitlab", "bitbucket", "gitea"] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

/** Webhooks::SECRET_FIELDS: the component's property and the label of each provider's secret. */
export const SECRET_FIELDS: Record<WebhookProvider, { property: string; label: string }> = {
  github: { property: "githubManualWebhookSecret", label: "GitHub webhook secret" },
  gitlab: { property: "gitlabManualWebhookSecret", label: "GitLab webhook secret" },
  bitbucket: { property: "bitbucketManualWebhookSecret", label: "Bitbucket webhook secret" },
  gitea: { property: "giteaManualWebhookSecret", label: "Gitea webhook secret" },
};

/** ManualWebhookSecret::MIN_LENGTH */
export const WEBHOOK_SECRET_MIN_LENGTH = 16;

export const WEBHOOK_MESSAGES = {
  /** Laravel's `string`, with the label as the attribute. */
  string: (label: string) => `The ${label} field must be a string.`,
  /** ManualWebhookSecret */
  minLength: (label: string) => `The ${label} must be at least ${WEBHOOK_SECRET_MIN_LENGTH} characters.`,
  saved: "Webhook secrets saved.",
  generated: (label: string) => `New ${label} generated and saved.`,
  unknownProvider: "Unknown webhook provider.",
} as const;

export interface WebhooksPage {
  application: ApplicationShow;
  /** generateDeployWebhook(): the path and query below the API origin. */
  deployWebhookPath: string;
  /** $resource->git_based() */
  gitBased: boolean;
  /** generateGitManualWebhook() per provider; null when the application has a Git source other than the public one. */
  manualWebhookPaths: Record<WebhookProvider, string | null>;
  /** The source-level endpoint of a GitLab App source, which GitLab projects are given by hand. */
  gitlabAppWebhookPath: string | null;
  /** $resource->gitWebhook: the repository's webhook settings at its provider. */
  gitWebhook: string | null;
  /** The secrets by property; null for who may not update (canViewSecrets()). */
  secrets: Record<string, string | null> | null;
}

/** Application::git_based() */
export const gitBased = (row: Pick<DeployApplicationSourceRow, "has_dockerfile" | "build_pack">): boolean => !row.has_dockerfile && row.build_pack !== "dockerimage";

async function storedSecrets(ctx: ApplicationMoreContext, row: DeployApplicationSourceRow): Promise<Record<WebhookProvider, string | null>> {
  const secrets = {} as Record<WebhookProvider, string | null>;
  for (const provider of WEBHOOK_PROVIDERS) {
    const column = WEBHOOK_SECRET_COLUMN[provider];
    const stored = row[column];
    secrets[provider] = stored === null || stored === undefined || stored === "" ? null : await ctx.secret(column).decrypt(stored);
  }
  return secrets;
}

async function page(ctx: ApplicationMoreContext, l: LoadedApplication, row: DeployApplicationSourceRow, canUpdate: boolean): Promise<WebhooksPage> {
  const source = await resolveSource(ctx, row);
  // generateGitManualWebhook(): only without a source, or with the public one (source_id 0).
  const manual = row.source_id === null || Number(row.source_id) === 0;
  const secrets = canUpdate ? await storedSecrets(ctx, row) : null;
  return {
    application: l.application,
    deployWebhookPath: `/api/v1/deploy?uuid=${row.uuid}&force=false`,
    gitBased: gitBased(row),
    manualWebhookPaths: Object.fromEntries(WEBHOOK_PROVIDERS.map((p) => [p, manual ? `/webhooks/source/${p}/events/manual` : null])) as WebhooksPage["manualWebhookPaths"],
    gitlabAppWebhookPath: source?.kind === "gitlab" ? "/webhooks/source/gitlab/events" : null,
    gitWebhook: gitLinks(row, source).webhook,
    secrets: secrets && Object.fromEntries(WEBHOOK_PROVIDERS.map((p) => [SECRET_FIELDS[p].property, secrets[p]])),
  };
}

async function load(ctx: ApplicationMoreContext, uuid: string, canUpdate: boolean): Promise<{ l: LoadedApplication; row: DeployApplicationSourceRow } | null> {
  const l = await loadApplication(ctx, uuid, canUpdate);
  const row = l ? await ctx.store.source(uuid) : null;
  return l && row ? { l, row } : null;
}

/** Webhooks::mount() */
export async function showWebhooks(ctx: ApplicationMoreContext, uuid: string, canUpdate: boolean): Promise<WebhooksPage | null> {
  const found = await load(ctx, uuid, canUpdate);
  return found ? page(ctx, found.l, found.row, canUpdate) : null;
}

export interface WebhooksSaved extends WebhooksPage {
  message: string;
}

async function saved(ctx: ApplicationMoreContext, uuid: string, message: string): Promise<WebhooksSaved | null> {
  const shown = await showWebhooks(ctx, uuid, true);
  return shown && { ...shown, message };
}

/**
 * Webhooks::submit(): a secret is checked only when it differs from the
 * stored one (changedSecretRules(): a short secret saved before the rule
 * keeps saving until it is changed), and only changed secrets are written.
 * An empty secret disables the provider's webhook and is stored as null.
 */
export async function saveWebhookSecrets(ctx: ApplicationMoreContext, uuid: string, body: Body): Promise<WebhooksSaved | null> {
  const found = await load(ctx, uuid, true);
  if (!found) return null;
  const current = await storedSecrets(ctx, found.row);
  const errors: FieldErrors = {};
  const changes: ApplicationSourceChanges = {};
  for (const provider of WEBHOOK_PROVIDERS) {
    const { property, label } = SECRET_FIELDS[provider];
    const given = body[property];
    // A field the body leaves out keeps its secret.
    if (given === undefined) continue;
    const value = given === "" ? null : given;
    if (value === current[provider]) continue;
    if (value === null) {
      changes[WEBHOOK_SECRET_COLUMN[provider]] = null;
    } else if (typeof value !== "string") {
      errors[property] = [WEBHOOK_MESSAGES.string(label)];
    } else if (length(value) < WEBHOOK_SECRET_MIN_LENGTH) {
      errors[property] = [WEBHOOK_MESSAGES.minLength(label)];
    } else {
      changes[WEBHOOK_SECRET_COLUMN[provider]] = await ctx.secret(WEBHOOK_SECRET_COLUMN[provider]).encrypt(value);
    }
  }
  if (Object.keys(errors).length) throw new SettingsFieldErrors(errors);
  await ctx.store.updateSource(found.row.id, changes);
  return saved(ctx, uuid, WEBHOOK_MESSAGES.saved);
}

/** Webhooks::generateSecret(): Str::random(40), saved at once; the other secrets stay as they are. */
export async function generateWebhookSecret(ctx: ApplicationMoreContext, uuid: string, provider: string): Promise<WebhooksSaved | null> {
  const found = await load(ctx, uuid, true);
  if (!found) return null;
  if (!(WEBHOOK_PROVIDERS as readonly string[]).includes(provider)) throw new SettingsError(WEBHOOK_MESSAGES.unknownProvider, 422);
  const column = WEBHOOK_SECRET_COLUMN[provider as WebhookProvider];
  await ctx.store.updateSource(found.row.id, { [column]: await ctx.secret(column).encrypt(randomString(40)) });
  return saved(ctx, uuid, WEBHOOK_MESSAGES.generated(SECRET_FIELDS[provider as WebhookProvider].label));
}
