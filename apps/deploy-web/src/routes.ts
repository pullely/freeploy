// The URL structure is routes/web.php's, one to one (design §3.1). A route
// whose page is not ported yet renders NotPorted, which the parity harness
// reports as a failing (not missing) route once deploy-web is the target.
export type PageKey = "login" | "register" | "forgot-password" | "reset-password" | "profile.appearance" | "profile" | "profile.passkeys.confirm" | "password.confirm" | "verify.email" | "two-factor.required" | "verify.verify" | "two-factor.login" | "security.private-key.index" | "security.private-key.show" | "security.cloud-tokens" | "security.cloud-tokens.show" | "security.cloud-init-scripts" | "security.cloud-init-scripts.show" | "server.index" | "server.create" | "server.create.manual" | "server.show" | "server.advanced" | "server.private-key" | "server.cloud-provider-token" | "server.ca-certificate" | "server.sentinel" | "server.swarm" | "server.docker-cleanup" | "server.log-drains" | "server.destinations" | "server.delete" | "server.registries" | "registries.index" | "project.index" | "project.show" | "project.edit" | "project.resource.index" | "project.environment.edit" | "project.environment.canvas" | "deploy-canvas" | "project.resource.create" | "project.application.configuration" | "project.application.environment-variables" | "project.application.domains" | "project.application.advanced" | "project.application.healthcheck" | "project.application.resource-limits" | "project.application.persistent-storage" | "project.application.tags" | "project.application.resource-operations" | "project.application.danger" | "project.database.configuration" | "project.application.source" | "project.application.servers" | "project.application.webhooks" | "project.application.scheduled-tasks" | "project.application.rollback" | "project.service.configuration" | "project.application.deployment.index" | "project.application.deployment.show" | "destination.index" | "destination.show" | "destination.danger" | "destination.resources" | "not-ported" | SharedVariablesPageKey | DatabaseSharedPageKey | StoragePageKey | NotificationsPageKey | ServicePageKey | TeamPageKey | ApiTokensPageKey | SourcesPageKey | BoardingPageKey | PlatformPageKey | SubscriptionPageKey | ServerMorePageKey | ResourcePagesKey | CanvasViewsPageKey | BackupPagesKey;

/**
 * The canvases that reuse the environment canvas's view (DP-98): the projects, project, servers, server and dashboard
 * canvases, each scope's shared variable canvas, and the tags canvas.
 */
export type CanvasViewsPageKey =
  | "project.canvas.index"
  | "project.canvas"
  | "server.canvas.index"
  | "server.canvas"
  | "dashboard.canvas"
  | "shared-variables.team.canvas"
  | "shared-variables.project.canvas"
  | "shared-variables.environment.canvas"
  | "shared-variables.server.canvas"
  | "tags.canvas";

/**
 * The storage backups of an application and a service, and an application's preview deployments (DP-99). The keys
 * that end in .redirect are routes/web.php's redirects of old links.
 */
export type BackupPagesKey =
  | "project.application.backup.index"
  | "project.application.backup.show"
  | "project.application.backup.redirect"
  | "project.service.volume-backups.index"
  | "project.service.volume-backups.show"
  | "project.service.import-backup.redirect"
  | "project.service.database.backups"
  | "project.application.preview-deployments";

/**
 * routes/web.php's Route::redirect()s of the backup links: an application's …/backups/{backup_uuid}/{s3|retention} to the
 * schedule, a service's …/import-backup to …/storage-backups, …/import-backup/{stack_service_uuid} and
 * …/{stack_service_uuid}/import to …/{stack_service_uuid}/backups.
 */
export function backupLinkRedirect(pathname: string): string {
  const parts = pathname.replace(/\/+$/, "").split("/");
  const last = parts[parts.length - 1];
  if (last === "s3" || last === "retention") return parts.slice(0, -1).join("/");
  if (last === "import") return `${parts.slice(0, -1).join("/")}/backups`;
  const at = parts.lastIndexOf("import-backup");
  if (at === parts.length - 1) return `${parts.slice(0, at).join("/")}/storage-backups`;
  return `${parts.slice(0, at).join("/")}/${parts[at + 1]}/backups`;
}

/**
 * The resource pages of DP-97: a service's Scheduled Tasks (and its task links), Webhooks, Resource Operations
 * and a part's Advanced; an application's task links; a database's Healthcheck and Servers.
 */
export type ResourcePagesKey =
  | "project.service.scheduled-tasks.show"
  | "project.service.scheduled-tasks"
  | "project.service.webhooks"
  | "project.service.resource-operations"
  | "project.service.index.advanced"
  | "project.application.scheduled-tasks.task"
  | "project.database.healthcheck"
  | "project.database.servers"
  | "tags.show";

/** routes/web.php: …/tasks/{task_uuid} redirects to …/scheduled-tasks with the task's uuid in the query (get_route_parameters()). */
export function scheduledTaskRedirect(pathname: string): string {
  const parts = pathname.replace(/\/+$/, "").split("/");
  const at = parts.lastIndexOf("tasks");
  return `${parts.slice(0, at).join("/")}/scheduled-tasks?task_uuid=${encodeURIComponent(decodeURIComponent(parts[at + 1] ?? ""))}`;
}

/**
 * The platform operator's pages (DP-79): settings.index and settings.advanced (Settings\Index, Settings\Advanced),
 * admin.index (Admin\Index) and team.admin-view (Team\AdminView). settings.updates, settings.image-scanning,
 * settings.backup, settings.email and settings.oauth(.provider) are not ported (IMPLEMENTATION-STATUS.md, Notes on DP12).
 */
export type PlatformPageKey = "settings.index" | "settings.advanced" | "admin.index" | "team.admin-view";

/**
 * A server's proxy, security, Cloudflare Tunnel, Sentinel logs, transfer, resources and images pages (DP-96).
 * server.security.vulnerabilities, server.github-runners and their old redirects are not ported (IMPLEMENTATION-STATUS.md,
 * Notes on DP4).
 */
export type ServerMorePageKey =
  | "server.proxy"
  | "server.proxy.dynamic-confs"
  | "server.proxy.certificates"
  | "server.proxy.logs"
  | "server.security"
  | "server.security.patches"
  | "server.cloudflare-tunnel"
  | "server.sentinel.logs"
  | "server.transfer"
  | "server.resources"
  | "server.docker-images";

/** Boarding (DP-75): routes/web.php's onboarding. */
export type BoardingPageKey = "onboarding";

/** The subscription pages (DP-82): routes/web.php's subscription.show and subscription.index, over Freeploy's billing. */
export type SubscriptionPageKey = "subscription.show" | "subscription.index";

/** Integrations → Sources (DP-72): the list, a GitHub App's pages, and the pages GitHub sends the browser back to. */
export type SourcesPageKey = "source.all" | "source.github.show" | "source.github.permissions" | "source.github.resources" | "source.github.danger" | "source.github.redirect" | "source.github.install";

/** Keys & Tokens → API Tokens (DP-70). */
export type ApiTokensPageKey = "security.api-tokens";

/** A database's pages that are Coolify's shared components with the database as their resource (DP-64). */
export type DatabaseSharedPageKey =
  | "project.database.environment-variables"
  | "project.database.persistent-storage"
  | "project.database.tags"
  | "project.database.resource-operations"
  | "project.database.resource-limits"
  | "project.database.webhooks"
  | "project.database.danger";

/** Integrations → Storage and a database's backup schedules (DP-65). */
export type StoragePageKey = "storage.index" | "storage.show" | "storage.resources" | "storage.danger" | "project.database.backup.index" | "project.database.backup.show";
/** The notifications.* routes (DP-67). */
export type NotificationsPageKey = "notifications.email" | "notifications.discord" | "notifications.telegram" | "notifications.slack" | "notifications.pushover" | "notifications.webhook";
/** A service's pages beside General (DP-66): Coolify's shared components with the service as their resource, and one part's settings. */
export type ServicePageKey = "project.service.environment-variables" | "project.service.storages" | "project.service.tags" | "project.service.danger" | "project.service.index";

/** Coolify's routes below a service (routes/web.php project.service.*): a {stack_service_uuid} is none of these. */
const SERVICE_SUBROUTES = "domains|maintenance|logs|analytics|vulnerabilities|environment-variables|storages|import-backup|storage-backups|scheduled-tasks|webhooks|resource-operations|tags|danger|terminal|files|tasks";

/** The team pages (DP-69): team.index, team.member.index and the invitation page (team.invitation.show); the audit log and the Danger Zone (DP-75). */
export type TeamPageKey = "team.index" | "team.member.index" | "team.invitation.show" | "team.audit-log" | "team.danger-zone";

/** The shared-variables.* routes (their canvas routes are not ported). */
export type SharedVariablesPageKey =
  | "shared-variables.index"
  | "shared-variables.team.index"
  | "shared-variables.project.index"
  | "shared-variables.project.show"
  | "shared-variables.environment.index"
  | "shared-variables.environment.show"
  | "shared-variables.server.index"
  | "shared-variables.server.show";

const ROUTES: Array<[RegExp, PageKey]> = [
  [/^\/login\/?$/, "login"],
  [/^\/register\/?$/, "register"],
  [/^\/forgot-password\/?$/, "forgot-password"],
  [/^\/reset-password\/[^/]+\/?$/, "reset-password"],
  [/^\/profile\/appearance\/?$/, "profile.appearance"],
  [/^\/profile\/?$/, "profile"],
  [/^\/profile\/passkeys\/confirm\/?$/, "profile.passkeys.confirm"],
  [/^\/user\/confirm-password\/?$/, "password.confirm"],
  [/^\/verify\/?$/, "verify.email"],
  [/^\/two-factor-required\/?$/, "two-factor.required"],
  [/^\/email\/verify\/[^/]+\/[^/]+\/?$/, "verify.verify"],
  [/^\/two-factor-challenge\/?$/, "two-factor.login"],
  // The deploy canvas (DP-94): routes/web.php's deploy-canvas.
  [/^\/canvas\/?$/, "deploy-canvas"],
  // DP-98: the tags canvas, the projects' and a project's canvas, the servers' and a server's, and the dashboard's.
  [/^\/canvas\/tags\/?$/, "tags.canvas"],
  [/^\/projects\/canvas\/?$/, "project.canvas.index"],
  [/^\/project\/[^/]+\/canvas\/?$/, "project.canvas"],
  [/^\/servers\/canvas\/?$/, "server.canvas.index"],
  [/^\/server\/[^/]+\/canvas\/?$/, "server.canvas"],
  [/^\/dashboard\/canvas\/?$/, "dashboard.canvas"],
  // DP-98: each scope's shared variable canvas.
  [/^\/shared-variables\/team\/canvas\/?$/, "shared-variables.team.canvas"],
  [/^\/shared-variables\/project\/[^/]+\/canvas\/?$/, "shared-variables.project.canvas"],
  [/^\/shared-variables\/environments\/project\/[^/]+\/environment\/[^/]+\/canvas\/?$/, "shared-variables.environment.canvas"],
  [/^\/shared-variables\/server\/[^/]+\/canvas\/?$/, "shared-variables.server.canvas"],
  // Projects and environments. An environment's canvas is ported (DP-91); the projects' and a project's canvas
  // (/projects/canvas, /project/{uuid}/canvas) and the clone page (…/clone) are not.
  [/^\/projects\/?$/, "project.index"],
  [/^\/project\/[^/]+\/?$/, "project.show"],
  [/^\/project\/[^/]+\/edit\/?$/, "project.edit"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/?$/, "project.resource.index"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/edit\/?$/, "project.environment.edit"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/canvas\/?$/, "project.environment.canvas"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/new\/?$/, "project.resource.create"],
  // An application's configuration: General. Its other pages (…/logs, …/metrics, …) are not ported, except the ones below.
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/?$/, "project.application.configuration"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/domains\/?$/, "project.application.domains"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/advanced\/?$/, "project.application.advanced"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/healthcheck\/?$/, "project.application.healthcheck"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/resource-limits\/?$/, "project.application.resource-limits"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/environment-variables\/?$/, "project.application.environment-variables"],
  // Persistent Storage, Tags, Resource Operations and the Danger Zone.
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/persistent-storage\/?$/, "project.application.persistent-storage"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/tags\/?$/, "project.application.tags"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/resource-operations\/?$/, "project.application.resource-operations"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/danger\/?$/, "project.application.danger"],
  // Git Source, Servers, Webhooks, Scheduled Tasks and Rollback.
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/source\/?$/, "project.application.source"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/servers\/?$/, "project.application.servers"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/webhooks\/?$/, "project.application.webhooks"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/scheduled-tasks\/?$/, "project.application.scheduled-tasks"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/rollback\/?$/, "project.application.rollback"],
  // DP-99: the storage backups (…/backups/{backup_uuid}/{s3|retention} redirect to the schedule) and Preview Deployments.
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/backups\/?$/, "project.application.backup.index"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/backups\/[^/]+(?:\/(?:executions|danger))?\/?$/, "project.application.backup.show"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/backups\/[^/]+\/(?:s3|retention)\/?$/, "project.application.backup.redirect"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/preview-deployments\/?$/, "project.application.preview-deployments"],
  // DP-97: …/tasks/{task_uuid} (Coolify's project.application.scheduled-tasks) redirects to the list with ?task_uuid=.
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/tasks\/[^/]+\/?$/, "project.application.scheduled-tasks.task"],
  // A standalone database's configuration: General. Its other pages (…/backups, …/servers, …) are not ported, except the ones below.
  [/^\/project\/[^/]+\/environment\/[^/]+\/database\/[^/]+\/?$/, "project.database.configuration"],
  // The pages that are the applications' shared components with the database as their resource (DP-64).
  [/^\/project\/[^/]+\/environment\/[^/]+\/database\/[^/]+\/environment-variables\/?$/, "project.database.environment-variables"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/database\/[^/]+\/persistent-storage\/?$/, "project.database.persistent-storage"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/database\/[^/]+\/tags\/?$/, "project.database.tags"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/database\/[^/]+\/resource-operations\/?$/, "project.database.resource-operations"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/database\/[^/]+\/resource-limits\/?$/, "project.database.resource-limits"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/database\/[^/]+\/webhooks\/?$/, "project.database.webhooks"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/database\/[^/]+\/danger\/?$/, "project.database.danger"],
  // DP-97: Healthcheck (Database\Health) and Servers (the shared destination component).
  [/^\/project\/[^/]+\/environment\/[^/]+\/database\/[^/]+\/healthcheck\/?$/, "project.database.healthcheck"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/database\/[^/]+\/servers\/?$/, "project.database.servers"],
  // Its backup schedules; a schedule's own links (…/backups/{backup_uuid}[/executions|danger|s3|retention]) redirect to them.
  [/^\/project\/[^/]+\/environment\/[^/]+\/database\/[^/]+\/backups\/?$/, "project.database.backup.index"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/database\/[^/]+\/backups\/[^/]+(?:\/(?:executions|danger|s3|retention))?\/?$/, "project.database.backup.show"],
  // The deployment history and one deployment's logs.
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/deployment\/?$/, "project.application.deployment.index"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/application\/[^/]+\/deployment\/[^/]+\/?$/, "project.application.deployment.show"],
  // A service (DP-59): where creating a one-click service ends — its General page — and the pages that are its
  // shared components (DP-66). Its other pages (…/domains, …/logs, …) are not ported.
  [/^\/project\/[^/]+\/environment\/[^/]+\/service\/[^/]+\/?$/, "project.service.configuration"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/service\/[^/]+\/environment-variables\/?$/, "project.service.environment-variables"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/service\/[^/]+\/storages\/?$/, "project.service.storages"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/service\/[^/]+\/tags\/?$/, "project.service.tags"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/service\/[^/]+\/danger\/?$/, "project.service.danger"],
  // DP-97: a service's Scheduled Tasks (…/tasks/{task_uuid} redirects to the list with ?task_uuid=), Webhooks and
  // Resource Operations, and a part's …/advanced (Coolify's ServiceIndex with the part, as project.service.index).
  [/^\/project\/[^/]+\/environment\/[^/]+\/service\/[^/]+\/scheduled-tasks\/?$/, "project.service.scheduled-tasks.show"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/service\/[^/]+\/tasks\/[^/]+\/?$/, "project.service.scheduled-tasks"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/service\/[^/]+\/webhooks\/?$/, "project.service.webhooks"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/service\/[^/]+\/resource-operations\/?$/, "project.service.resource-operations"],
  // DP-99: the storage backups (a schedule's links redirect to the list), the old import links, and a database's
  // …/{stack_service_uuid}/backups[/{backup_uuid}[/…]], which DatabaseBackups::mount() redirects.
  [/^\/project\/[^/]+\/environment\/[^/]+\/service\/[^/]+\/storage-backups\/?$/, "project.service.volume-backups.index"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/service\/[^/]+\/storage-backups\/[^/]+(?:\/(?:executions|danger|s3|retention))?\/?$/, "project.service.volume-backups.show"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/service\/[^/]+\/import-backup(?:\/[^/]+)?\/?$/, "project.service.import-backup.redirect"],
  [new RegExp(`^/project/[^/]+/environment/[^/]+/service/[^/]+/(?!(?:${SERVICE_SUBROUTES})/)[^/]+/import/?$`), "project.service.import-backup.redirect"],
  [new RegExp(`^/project/[^/]+/environment/[^/]+/service/[^/]+/(?!(?:${SERVICE_SUBROUTES})/)[^/]+/backups(?:/[^/]+(?:/(?:executions|danger|s3|retention))?)?/?$`), "project.service.database.backups"],
  [new RegExp(`^/project/[^/]+/environment/[^/]+/service/[^/]+/(?!(?:${SERVICE_SUBROUTES})/)[^/]+/advanced/?$`), "project.service.index.advanced"],
  // project.service.index: one application's or database's settings.
  [new RegExp(`^/project/[^/]+/environment/[^/]+/service/[^/]+/(?!(?:${SERVICE_SUBROUTES})/?$)[^/]+/?$`), "project.service.index"],
  [/^\/security\/private-key\/?$/, "security.private-key.index"],
  // Coolify redirects the old show page to the index, whose dialog edits the key.
  [/^\/security\/private-key\/[^/]+\/?$/, "security.private-key.show"],
  [/^\/security\/api-tokens\/?$/, "security.api-tokens"],
  [/^\/security\/cloud-tokens\/?$/, "security.cloud-tokens"],
  [/^\/security\/cloud-tokens\/[^/]+\/?$/, "security.cloud-tokens.show"],
  [/^\/security\/cloud-init-scripts\/?$/, "security.cloud-init-scripts"],
  [/^\/security\/cloud-init-scripts\/[^/]+\/?$/, "security.cloud-init-scripts.show"],
  [/^\/servers\/?$/, "server.index"],
  [/^\/servers\/new\/?$/, "server.create"],
  // server.create.type with {type} manual (ByIp); the cloud provider types are not ported.
  [/^\/servers\/new\/manual\/?$/, "server.create.manual"],
  [/^\/server\/[^/]+\/?$/, "server.show"],
  [/^\/server\/[^/]+\/advanced\/?$/, "server.advanced"],
  [/^\/server\/[^/]+\/private-key\/?$/, "server.private-key"],
  [/^\/server\/[^/]+\/cloud-provider-token\/?$/, "server.cloud-provider-token"],
  [/^\/server\/[^/]+\/ca-certificate\/?$/, "server.ca-certificate"],
  [/^\/server\/[^/]+\/sentinel\/?$/, "server.sentinel"],
  [/^\/server\/[^/]+\/swarm\/?$/, "server.swarm"],
  [/^\/server\/[^/]+\/docker-cleanup\/?$/, "server.docker-cleanup"],
  [/^\/server\/[^/]+\/log-drains\/?$/, "server.log-drains"],
  [/^\/server\/[^/]+\/destinations\/?$/, "server.destinations"],
  [/^\/server\/[^/]+\/registries\/?$/, "server.registries"],
  [/^\/server\/[^/]+\/danger\/?$/, "server.delete"],
  // DP-96.
  [/^\/server\/[^/]+\/proxy\/?$/, "server.proxy"],
  [/^\/server\/[^/]+\/proxy\/dynamic\/?$/, "server.proxy.dynamic-confs"],
  [/^\/server\/[^/]+\/proxy\/certificates\/?$/, "server.proxy.certificates"],
  [/^\/server\/[^/]+\/proxy\/logs\/?$/, "server.proxy.logs"],
  [/^\/server\/[^/]+\/security\/?$/, "server.security"],
  [/^\/server\/[^/]+\/security\/patches\/?$/, "server.security.patches"],
  [/^\/server\/[^/]+\/cloudflare-tunnel\/?$/, "server.cloudflare-tunnel"],
  [/^\/server\/[^/]+\/sentinel\/logs\/?$/, "server.sentinel.logs"],
  [/^\/server\/[^/]+\/transfer\/?$/, "server.transfer"],
  [/^\/server\/[^/]+\/resources\/?$/, "server.resources"],
  [/^\/server\/[^/]+\/images\/?$/, "server.docker-images"],
  [/^\/registries\/?$/, "registries.index"],
  // Integrations → Storage: New storage is a dialog of the list (no /storages/new page).
  [/^\/storages\/?$/, "storage.index"],
  [/^\/storages\/[^/]+\/?$/, "storage.show"],
  [/^\/storages\/[^/]+\/resources\/?$/, "storage.resources"],
  [/^\/storages\/[^/]+\/danger\/?$/, "storage.danger"],
  // Sources (DP-72). GitLab's and Gitea's pages are not ported. GitHub sends the browser to
  // /webhooks/source/github/{redirect,install} (Coolify's routes/webhooks.php, GET): pages here that post the code on.
  [/^\/sources\/?$/, "source.all"],
  [/^\/source\/github\/[^/]+\/?$/, "source.github.show"],
  [/^\/source\/github\/[^/]+\/permissions\/?$/, "source.github.permissions"],
  [/^\/source\/github\/[^/]+\/resources\/?$/, "source.github.resources"],
  [/^\/source\/github\/[^/]+\/danger\/?$/, "source.github.danger"],
  [/^\/webhooks\/source\/github\/redirect\/?$/, "source.github.redirect"],
  [/^\/webhooks\/source\/github\/install\/?$/, "source.github.install"],
  [/^\/destinations\/?$/, "destination.index"],
  [/^\/destination\/[^/]+\/?$/, "destination.show"],
  // destination.danger is the same component as destination.show (routeIs picks the section).
  [/^\/destination\/[^/]+\/danger\/?$/, "destination.danger"],
  [/^\/destination\/[^/]+\/resources\/?$/, "destination.resources"],
  // Shared variables. Each scope's canvas (…/canvas) is not ported.
  [/^\/shared-variables\/?$/, "shared-variables.index"],
  [/^\/shared-variables\/team\/?$/, "shared-variables.team.index"],
  [/^\/shared-variables\/projects\/?$/, "shared-variables.project.index"],
  [/^\/shared-variables\/project\/[^/]+\/?$/, "shared-variables.project.show"],
  [/^\/shared-variables\/environments\/?$/, "shared-variables.environment.index"],
  [/^\/shared-variables\/environments\/project\/[^/]+\/environment\/[^/]+\/?$/, "shared-variables.environment.show"],
  [/^\/shared-variables\/servers\/?$/, "shared-variables.server.index"],
  [/^\/shared-variables\/server\/[^/]+\/?$/, "shared-variables.server.show"],
  // Notifications (DP-67): each channel's settings.
  [/^\/notifications\/email\/?$/, "notifications.email"],
  [/^\/notifications\/discord\/?$/, "notifications.discord"],
  [/^\/notifications\/telegram\/?$/, "notifications.telegram"],
  [/^\/notifications\/slack\/?$/, "notifications.slack"],
  [/^\/notifications\/pushover\/?$/, "notifications.pushover"],
  [/^\/notifications\/webhook\/?$/, "notifications.webhook"],
  // The team pages (DP-69); the audit log and the Danger Zone (DP-75). Image Scanning is not ported; Admin View is below (DP-79).
  [/^\/team\/?$/, "team.index"],
  [/^\/team\/members\/?$/, "team.member.index"],
  [/^\/team\/audit-log\/?$/, "team.audit-log"],
  [/^\/team\/danger\/?$/, "team.danger-zone"],
  [/^\/invitations\/[^/]+\/?$/, "team.invitation.show"],
  // Boarding (DP-75).
  [/^\/onboarding\/?$/, "onboarding"],
  // The subscription pages (DP-82).
  [/^\/subscription\/?$/, "subscription.show"],
  [/^\/subscription\/new\/?$/, "subscription.index"],
  // The platform operator's pages (DP-79): a customer gets the API's 404 on each.
  [/^\/settings\/?$/, "settings.index"],
  [/^\/settings\/advanced\/?$/, "settings.advanced"],
  [/^\/admin\/?$/, "admin.index"],
  [/^\/team\/admin\/?$/, "team.admin-view"],
  // The team's tags (DP-97): /tags/{tagName?}. The tags canvas (/canvas/tags) is not ported.
  [/^\/tags(?:\/[^/]+)?\/?$/, "tags.show"],
];

/** routes/web.php: …/backups/{backup_uuid}/{section?} redirects to the backups page with ?schedule={backup_uuid}. */
export function backupScheduleRedirect(pathname: string): string {
  const parts = pathname.replace(/\/+$/, "").split("/");
  const at = parts.lastIndexOf("backups");
  return `${parts.slice(0, at + 1).join("/")}?schedule=${encodeURIComponent(decodeURIComponent(parts[at + 1] ?? ""))}`;
}

export function pageFor(pathname: string): PageKey {
  for (const [re, key] of ROUTES) if (re.test(pathname)) return key;
  return "not-ported";
}
