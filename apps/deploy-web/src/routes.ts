// The URL structure is routes/web.php's, one to one (design §3.1). A route
// whose page is not ported yet renders NotPorted, which the parity harness
// reports as a failing (not missing) route once deploy-web is the target.
export type PageKey = "login" | "register" | "forgot-password" | "reset-password" | "profile.appearance" | "profile" | "profile.passkeys.confirm" | "password.confirm" | "verify.email" | "two-factor.required" | "verify.verify" | "two-factor.login" | "security.private-key.index" | "security.private-key.show" | "security.cloud-tokens" | "security.cloud-tokens.show" | "security.cloud-init-scripts" | "security.cloud-init-scripts.show" | "server.index" | "server.create" | "server.create.manual" | "server.show" | "server.advanced" | "server.private-key" | "server.cloud-provider-token" | "server.ca-certificate" | "server.sentinel" | "server.swarm" | "server.docker-cleanup" | "server.log-drains" | "server.destinations" | "server.delete" | "server.registries" | "registries.index" | "project.index" | "project.show" | "project.edit" | "project.resource.index" | "project.environment.edit" | "project.resource.create" | "project.application.configuration" | "project.application.environment-variables" | "project.application.domains" | "project.application.advanced" | "project.application.healthcheck" | "project.application.resource-limits" | "project.application.persistent-storage" | "project.application.tags" | "project.application.resource-operations" | "project.application.danger" | "project.application.source" | "project.application.servers" | "project.application.webhooks" | "project.application.scheduled-tasks" | "project.application.rollback" | "destination.index" | "destination.show" | "destination.danger" | "destination.resources" | "not-ported" | SharedVariablesPageKey;

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
  // Projects and environments. Their canvas and clone pages (…/canvas, …/clone) are not ported.
  [/^\/projects\/?$/, "project.index"],
  [/^\/project\/[^/]+\/?$/, "project.show"],
  [/^\/project\/[^/]+\/edit\/?$/, "project.edit"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/?$/, "project.resource.index"],
  [/^\/project\/[^/]+\/environment\/[^/]+\/edit\/?$/, "project.environment.edit"],
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
  [/^\/security\/private-key\/?$/, "security.private-key.index"],
  // Coolify redirects the old show page to the index, whose dialog edits the key.
  [/^\/security\/private-key\/[^/]+\/?$/, "security.private-key.show"],
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
  [/^\/registries\/?$/, "registries.index"],
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
];

export function pageFor(pathname: string): PageKey {
  for (const [re, key] of ROUTES) if (re.test(pathname)) return key;
  return "not-ported";
}
