// Derived from coollabsio/coolify@91b7e3e:app/Models/{Application,ApplicationSetting}.php (the creating
// and created hooks, the relations), app/Livewire/Project/New/DockerImage.php (the row a Docker image
// application starts as), app/Livewire/Project/Application/{Configuration,General}.php and
// app/Livewire/Project/Resource/Index.php (the queries) (Apache-2.0), modified.
//
// deploy.applications and deploy.application_settings queries. Every function
// takes the transaction of withOrg(): row-level security confines each query
// to that org, which is what Coolify's ownedByCurrentTeam() does. A
// soft-deleted application (deleted_at) is never returned, as with Eloquent's
// SoftDeletes scope.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DESTINATION_MORPH_CLASS, type DestinationType } from "./destinations.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/**
 * The manual webhook secrets the creating hook fills in. Application casts
 * each as `encrypted`: the stored value is the caller's ciphertext.
 */
export const APPLICATION_WEBHOOK_SECRET_COLUMNS = [
  "manual_webhook_secret_github",
  "manual_webhook_secret_gitlab",
  "manual_webhook_secret_bitbucket",
  "manual_webhook_secret_gitea",
] as const;
export type ApplicationWebhookSecretColumn = (typeof APPLICATION_WEBHOOK_SECRET_COLUMNS)[number];

/** An application with its settings and where it lives: environment, project, destination, server. */
export interface DeployApplicationRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  fqdn: string | null;
  build_pack: string;
  status: string;
  git_repository: string;
  git_branch: string;
  docker_registry_image_name: string | null;
  docker_registry_image_tag: string | null;
  ports_exposes: string | null;
  ports_mappings: string | null;
  custom_network_aliases: string | null;
  custom_labels: string | null;
  custom_docker_run_options: string | null;
  pre_deployment_command: string | null;
  pre_deployment_command_container: string | null;
  post_deployment_command: string | null;
  post_deployment_command_container: string | null;
  /** JSON columns: the driver may hand back the parsed value or its text. */
  domain_port_overrides: unknown;
  noindex_domains: unknown;
  health_check_enabled: boolean;
  restart_count: number;
  max_restart_count: number;
  restart_limit_reached: boolean;
  container_present: boolean | null;
  environment_id: string | number;
  destination_id: string | number | null;
  destination_type: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
  // application_settings
  is_container_label_readonly_enabled: boolean | null;
  is_container_label_escape_enabled: boolean | null;
  // environment and project
  environment_uuid: string;
  environment_name: string;
  project_uuid: string;
  project_name: string;
  // destination (standalone or Swarm, by destination_type) and its server
  destination_uuid: string | null;
  destination_name: string | null;
  destination_network: string | null;
  server_uuid: string | null;
  server_name: string | null;
  server_ip: string | null;
  server_is_swarm_manager: boolean | null;
  server_is_swarm_worker: boolean | null;
  server_is_reachable: boolean | null;
  server_is_usable: boolean | null;
  server_force_disabled: boolean | null;
}

const APPLICATION_COLUMNS = [
  "id", "uuid", "name", "description", "fqdn", "build_pack", "status", "git_repository", "git_branch",
  "docker_registry_image_name", "docker_registry_image_tag", "ports_exposes", "ports_mappings", "custom_network_aliases",
  "custom_labels", "custom_docker_run_options", "pre_deployment_command", "pre_deployment_command_container",
  "post_deployment_command", "post_deployment_command_container", "domain_port_overrides", "noindex_domains",
  "health_check_enabled", "restart_count", "max_restart_count", "restart_limit_reached", "container_present", "environment_id",
  "destination_id", "destination_type", "created_at", "updated_at",
].map((c) => `a."${c}"`);

const STANDALONE = DESTINATION_MORPH_CLASS.standalone.replace(/\\/g, "\\\\");
const SWARM = DESTINATION_MORPH_CLASS.swarm.replace(/\\/g, "\\\\");

/** $application with settings, environment.project and destination.server (the morphTo by destination_type). */
const SELECT_APPLICATION = `SELECT ${APPLICATION_COLUMNS.join(", ")},
       st.is_container_label_readonly_enabled, st.is_container_label_escape_enabled,
       e.uuid AS environment_uuid, e.name AS environment_name, p.uuid AS project_uuid, p.name AS project_name,
       COALESCE(sd.uuid, wd.uuid) AS destination_uuid, COALESCE(sd.name, wd.name) AS destination_name,
       COALESCE(sd.network, wd.network) AS destination_network,
       s.uuid AS server_uuid, s.name AS server_name, s.ip AS server_ip,
       ss.is_swarm_manager AS server_is_swarm_manager, ss.is_swarm_worker AS server_is_swarm_worker,
       ss.is_reachable AS server_is_reachable, ss.is_usable AS server_is_usable, ss.force_disabled AS server_force_disabled
  FROM deploy.applications a
  JOIN deploy.environments e ON e.id = a.environment_id
  JOIN deploy.projects p ON p.id = e.project_id
  LEFT JOIN deploy.application_settings st ON st.application_id = a.id
  LEFT JOIN deploy.standalone_dockers sd ON sd.id = a.destination_id AND a.destination_type = E'${STANDALONE}'
  LEFT JOIN deploy.swarm_dockers wd ON wd.id = a.destination_id AND a.destination_type = E'${SWARM}'
  LEFT JOIN deploy.servers s ON s.id = COALESCE(sd.server_id, wd.server_id) AND s.deleted_at IS NULL
  LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id`;

/** Application::where('uuid', $uuid)->first() within the org. */
export async function findApplicationByUuid(tx: SqlExecutor, uuid: string): Promise<DeployApplicationRow | null> {
  const r = await tx.execute<DeployApplicationRow>(`${SELECT_APPLICATION} WHERE a.uuid = $1 AND a.deleted_at IS NULL`, [uuid]);
  return r.rows[0] ?? null;
}

/** $environment->applications (Resource\Index): the environment's applications, oldest first. */
export async function listEnvironmentApplications(tx: SqlExecutor, environmentId: string | number): Promise<DeployApplicationRow[]> {
  const r = await tx.execute<DeployApplicationRow>(`${SELECT_APPLICATION} WHERE a.environment_id = $1 AND a.deleted_at IS NULL ORDER BY a.id`, [environmentId]);
  return r.rows;
}

/**
 * ServerCanvas::loadResources()'s applications (DP-98): every application of the org (row-level security), oldest
 * first, with its environment, project and server; the canvases keep the ones of the environments they show.
 */
export async function listOrgApplications(tx: SqlExecutor): Promise<DeployApplicationRow[]> {
  const r = await tx.execute<DeployApplicationRow>(`${SELECT_APPLICATION} WHERE a.deleted_at IS NULL ORDER BY a.id`);
  return r.rows;
}

/** What New\DockerImage::submit() stores, after the model's hooks. */
export interface NewDockerImageApplication {
  orgId: string;
  /** BaseModel's creating hook: new_public_id(). */
  uuid: string;
  name: string;
  /** generateUrl() as the saving hook normalizes it, or null. */
  fqdn: string | null;
  /** DomainPortOverrides::normalize()'s overrides for that fqdn, or null. */
  domainPortOverrides: Record<string, number> | null;
  dockerRegistryImageName: string;
  dockerRegistryImageTag: string;
  environmentId: string | number;
  destinationId: string | number;
  destinationType: DestinationType;
  /** Str::random(40) for each manual webhook secret, already encrypted for its column. */
  webhookSecrets: Record<ApplicationWebhookSecretColumn, string>;
}

/**
 * Application::save() for a Docker image application, with the creating hook
 * (the webhook secrets, compose_parsing_version '5') and the created hook
 * (ApplicationSetting::create(['application_id' => …])). What Coolify sets:
 * repository_project_id 0, git_repository 'coollabsio/coolify', git_branch
 * 'main', build_pack 'dockerimage', ports_exposes 80, health_check_enabled
 * false. Every other column keeps the schema's default (status 'exited').
 * Both rows carry the org.
 */
export async function insertDockerImageApplication(tx: SqlExecutor, application: NewDockerImageApplication): Promise<DeployApplicationRow> {
  const inserted = await tx.execute<{ id: string | number }>(
    `INSERT INTO deploy.applications
       (uuid, name, fqdn, domain_port_overrides, repository_project_id, git_repository, git_branch, build_pack, ports_exposes,
        docker_registry_image_name, docker_registry_image_tag, environment_id, destination_id, destination_type, health_check_enabled,
        ${APPLICATION_WEBHOOK_SECRET_COLUMNS.join(", ")}, compose_parsing_version, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4::json, 0, 'coollabsio/coolify', 'main', 'dockerimage', '80',
             $5, $6, $7, $8, $9, false, $10, $11, $12, $13, '5', $14, ${NOW}, ${NOW})
     RETURNING id`,
    [
      application.uuid,
      application.name,
      application.fqdn,
      application.domainPortOverrides === null ? null : JSON.stringify(application.domainPortOverrides),
      application.dockerRegistryImageName,
      application.dockerRegistryImageTag,
      application.environmentId,
      application.destinationId,
      DESTINATION_MORPH_CLASS[application.destinationType],
      ...APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => application.webhookSecrets[c]),
      application.orgId,
    ],
  );
  await tx.execute(`INSERT INTO deploy.application_settings (application_id, org_id, created_at, updated_at) VALUES ($1, $2, ${NOW}, ${NOW})`, [
    inserted.rows[0]!.id,
    application.orgId,
  ]);
  return (await findApplicationByUuid(tx, application.uuid))!;
}

/** The columns General::submit() writes for a Docker image application. */
export const APPLICATION_GENERAL_COLUMNS = [
  "name",
  "description",
  "fqdn",
  "domain_port_overrides",
  "noindex_domains",
  "docker_registry_image_name",
  "docker_registry_image_tag",
  "ports_exposes",
  "ports_mappings",
  "custom_network_aliases",
  "custom_docker_run_options",
  "pre_deployment_command",
  "pre_deployment_command_container",
  "post_deployment_command",
  "post_deployment_command_container",
] as const;
export type ApplicationGeneralColumn = (typeof APPLICATION_GENERAL_COLUMNS)[number];
/** The JSON columns among them take a JSON text or null. */
export type ApplicationGeneralChanges = Partial<Record<ApplicationGeneralColumn, string | null>>;

const JSON_COLUMNS: readonly string[] = ["domain_port_overrides", "noindex_domains"];

/** $application->save(): only the given columns (the dirty ones), and updated_at. */
export async function updateApplicationGeneral(tx: SqlExecutor, id: string | number, changes: ApplicationGeneralChanges): Promise<DeployApplicationRow | null> {
  const columns = APPLICATION_GENERAL_COLUMNS.filter((c) => changes[c] !== undefined);
  const sets = columns.map((c, i) => `"${c}" = $${i + 2}${JSON_COLUMNS.includes(c) ? "::json" : ""}`);
  const r = await tx.execute<{ uuid: string }>(
    `UPDATE deploy.applications SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING uuid`,
    [id, ...columns.map((c) => changes[c] ?? null)],
  );
  return r.rows[0] ? findApplicationByUuid(tx, r.rows[0].uuid) : null;
}

/** An application's domains, for checkDomainUsage(). */
export interface DeployApplicationDomainsRow extends SqlRow {
  uuid: string;
  name: string;
  fqdn: string;
  environment_uuid: string;
  project_uuid: string;
}

/** checkDomainUsage(): every application of the team (here, the org) that has domains. */
export async function listApplicationDomains(tx: SqlExecutor): Promise<DeployApplicationDomainsRow[]> {
  const r = await tx.execute<DeployApplicationDomainsRow>(
    `SELECT a.uuid, a.name, a.fqdn, e.uuid AS environment_uuid, p.uuid AS project_uuid
       FROM deploy.applications a
       JOIN deploy.environments e ON e.id = a.environment_id
       JOIN deploy.projects p ON p.id = e.project_id
      WHERE a.deleted_at IS NULL AND a.fqdn IS NOT NULL AND a.fqdn <> ''
      ORDER BY a.id`,
  );
  return r.rows;
}

/** A server the New Resource page lists. */
export interface DeployResourceServerRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  ip: string;
  is_swarm_manager: boolean | null;
  is_swarm_worker: boolean | null;
}

/**
 * Select::loadServers(): Server::isUsable() (role deployment or both) or
 * Server::isUsableBuildServer() (role build) — reachable, usable, not a Swarm
 * worker, not disabled; a null role falls back to the legacy build flag —
 * sortBy('name').
 */
export async function listResourceServers(tx: SqlExecutor, kind: "deployment" | "build"): Promise<DeployResourceServerRow[]> {
  const role =
    kind === "build"
      ? "(ss.server_role = 'build' OR (ss.server_role IS NULL AND ss.is_build_server))"
      : "(ss.server_role IN ('deployment', 'both') OR (ss.server_role IS NULL AND NOT ss.is_build_server))";
  const r = await tx.execute<DeployResourceServerRow>(
    `SELECT s.id, s.uuid, s.name, s.description, s.ip, ss.is_swarm_manager, ss.is_swarm_worker
       FROM deploy.servers s JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE s.deleted_at IS NULL AND ss.is_reachable AND ss.is_usable AND NOT ss.is_swarm_worker AND NOT ss.force_disabled AND ${role}
      ORDER BY s.name, s.id`,
  );
  return r.rows;
}
