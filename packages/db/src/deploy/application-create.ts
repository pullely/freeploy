// Derived from coollabsio/coolify@91b7e3e:app/Models/{Application,ApplicationSetting,EnvironmentVariable}.php
// (the creating, created and saving hooks, otherApplicationBuildingSameImage, fileStorages),
// app/Livewire/Project/New/{SimpleDockerfile,PublicGitRepository}.php (the rows these start as),
// app/Livewire/Project/Application/General.php (the columns of the build packs) and
// database/seeders/ProductionSeeder.php (the public GitHub source) (Apache-2.0), modified.
//
// deploy.applications queries for the applications that are built: created
// from a Dockerfile or from a public Git repository, and the columns General
// reads and writes for their build packs. Every function takes the
// transaction of withOrg(): row-level security confines each query to that
// org. A soft-deleted application is never returned.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { APPLICATION_WEBHOOK_SECRET_COLUMNS, type ApplicationWebhookSecretColumn } from "./applications.js";
import { DESTINATION_MORPH_CLASS, type DestinationType } from "./destinations.js";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** Application::class as a morph type (environment_variables.resourceable_type, local_file_volumes.resource_type). */
export const APPLICATION_MORPH_CLASS = "App\\Models\\Application";
const APPLICATION_MORPH_SQL = APPLICATION_MORPH_CLASS.replace(/\\/g, "\\\\");

/**
 * Coolify's "Public GitHub" source: the GithubApp row with id 0 that its
 * seeder creates for the whole instance (team 0). deploy.github_apps has no
 * such row — every row there belongs to one org, and its identity column
 * starts at 1 — so the source is this constant: an application whose
 * source_id is 0 and whose source_type is GithubApp's morph class has the
 * public GitHub source, exactly the two values Coolify stores.
 */
export const PUBLIC_GITHUB_SOURCE = {
  id: 0,
  type: "App\\Models\\GithubApp",
  name: "Public GitHub",
  apiUrl: "https://api.github.com",
  htmlUrl: "https://github.com",
  isPublic: true,
} as const;

/** An environment variable the created hook adds, its value already encrypted for environment_variables.value. */
export interface NewApplicationVariable {
  /** BaseModel's creating hook: new_public_id(). */
  uuid: string;
  key: string;
  value: string;
  isMultiline: boolean;
  isLiteral: boolean;
  isBuildtime: boolean;
  isRuntime: boolean;
  isPreview: boolean;
  /** EnvironmentVariable's creating hook: config('constants.coolify.version'). */
  version: string;
}

/** What `new Application([...])->save()` and the update after it store, with the model's hooks. */
export interface NewBuiltApplication {
  orgId: string;
  /** BaseModel's creating hook: new_public_id(). */
  uuid: string;
  name: string;
  /** generateUrl() as the saving hook normalizes it, or null. */
  fqdn: string | null;
  domainPortOverrides: Record<string, number> | null;
  /** 0 for an application from a Dockerfile; null (not set) for one from a Git repository. */
  repositoryProjectId: number | null;
  gitRepository: string;
  gitBranch: string;
  buildPack: string;
  portsExposes: string;
  baseDirectory: string;
  publishDirectory: string | null;
  dockerfile: string | null;
  dockerfileLocation: string | null;
  /** Null keeps the schema's default ('/docker-compose.yaml'). */
  dockerComposeLocation: string | null;
  /** Null keeps the schema's default (false). */
  healthCheckEnabled: boolean | null;
  /** parseHealthcheckFromDockerfile(isInit: true): the HEALTHCHECK's options; a null option keeps the schema's default. */
  dockerfileHealthcheck: { interval: number | null; timeout: number | null; startPeriod: number | null; retries: number | null } | null;
  sourceId: number | null;
  sourceType: string | null;
  /** $application->settings->is_static */
  isStatic: boolean;
  environmentId: string | number;
  destinationId: string | number;
  destinationType: DestinationType;
  /** Str::random(40) for each manual webhook secret, already encrypted for its column. */
  webhookSecrets: Record<ApplicationWebhookSecretColumn, string>;
  /** The created hook's default variables (NIXPACKS_NODE_VERSION and its preview copy for Nixpacks). */
  variables: NewApplicationVariable[];
}

/**
 * Application::save() with the creating hook (the webhook secrets,
 * compose_parsing_version '5') and the created hook (the settings row, the
 * default variables), then what the component sets on the settings row.
 * Every column not listed keeps the schema's default (status 'exited',
 * git_commit_sha 'HEAD', static_image 'nginx:alpine', …). All rows carry the
 * org. Answers the new application's id.
 */
export async function insertBuiltApplication(tx: SqlExecutor, application: NewBuiltApplication): Promise<string | number> {
  const health = application.dockerfileHealthcheck;
  const inserted = await tx.execute<{ id: string | number }>(
    `INSERT INTO deploy.applications
       (uuid, name, fqdn, domain_port_overrides, repository_project_id, git_repository, git_branch, build_pack, ports_exposes,
        base_directory, publish_directory, dockerfile, dockerfile_location, docker_compose_location, health_check_enabled,
        health_check_interval, health_check_timeout, health_check_start_period, health_check_retries, custom_healthcheck_found,
        source_id, source_type, environment_id, destination_id, destination_type,
        ${APPLICATION_WEBHOOK_SECRET_COLUMNS.join(", ")}, compose_parsing_version, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4::json, $5, $6, $7, $8, $9,
             $10, $11, $12, $13, COALESCE($14, '/docker-compose.yaml'), COALESCE($15, false),
             COALESCE($16, 5), COALESCE($17, 5), COALESCE($18, 5), COALESCE($19, 10), $20,
             $21, $22, $23, $24, $25,
             $26, $27, $28, $29, '5', $30, ${NOW}, ${NOW})
     RETURNING id`,
    [
      application.uuid,
      application.name,
      application.fqdn,
      application.domainPortOverrides === null ? null : JSON.stringify(application.domainPortOverrides),
      application.repositoryProjectId,
      application.gitRepository,
      application.gitBranch,
      application.buildPack,
      application.portsExposes,
      application.baseDirectory,
      application.publishDirectory,
      application.dockerfile,
      application.dockerfileLocation,
      application.dockerComposeLocation,
      application.healthCheckEnabled,
      health?.interval ?? null,
      health?.timeout ?? null,
      health?.startPeriod ?? null,
      health?.retries ?? null,
      health !== null,
      application.sourceId,
      application.sourceType,
      application.environmentId,
      application.destinationId,
      DESTINATION_MORPH_CLASS[application.destinationType],
      ...APPLICATION_WEBHOOK_SECRET_COLUMNS.map((c) => application.webhookSecrets[c]),
      application.orgId,
    ],
  );
  const id = inserted.rows[0]!.id;
  await tx.execute(`INSERT INTO deploy.application_settings (application_id, is_static, org_id, created_at, updated_at) VALUES ($1, $2, $3, ${NOW}, ${NOW})`, [
    id,
    application.isStatic,
    application.orgId,
  ]);
  for (const variable of application.variables) {
    await tx.execute(
      `INSERT INTO deploy.environment_variables
         (uuid, key, value, is_multiline, is_literal, is_buildtime, is_runtime, is_preview, version, resourceable_type, resourceable_id, org_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${NOW}, ${NOW})`,
      [
        variable.uuid,
        variable.key,
        variable.value,
        variable.isMultiline,
        variable.isLiteral,
        variable.isBuildtime,
        variable.isRuntime,
        variable.isPreview,
        variable.version,
        APPLICATION_MORPH_CLASS,
        id,
        application.orgId,
      ],
    );
  }
  return id;
}

/** The columns of an application that its build pack reads, with the settings General edits beside them. */
export interface DeployApplicationBuildRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  build_pack: string;
  git_repository: string;
  git_branch: string;
  git_commit_sha: string;
  repository_project_id: number | null;
  source_id: string | number | null;
  source_type: string | null;
  private_key_id: string | number | null;
  static_image: string;
  install_command: string | null;
  build_command: string | null;
  start_command: string | null;
  base_directory: string;
  publish_directory: string | null;
  ports_exposes: string | null;
  dockerfile: string | null;
  dockerfile_location: string | null;
  dockerfile_target_build: string | null;
  docker_registry_image_name: string | null;
  docker_compose_location: string | null;
  docker_compose: string | null;
  docker_compose_raw: string | null;
  docker_compose_domains: string | null;
  docker_compose_custom_start_command: string | null;
  docker_compose_custom_build_command: string | null;
  compose_parsing_version: string;
  watch_paths: string | null;
  /** Stored base64-encoded (the customNginxConfiguration mutator). */
  custom_nginx_configuration: string | null;
  health_check_enabled: boolean;
  health_check_interval: number;
  health_check_timeout: number;
  health_check_retries: number;
  health_check_start_period: number;
  custom_healthcheck_found: boolean;
  // application_settings
  is_static: boolean | null;
  is_spa: boolean | null;
  is_build_server_enabled: boolean | null;
  is_preserve_repository_enabled: boolean | null;
  is_raw_compose_deployment_enabled: boolean | null;
}

const BUILD_COLUMNS = [
  "id", "uuid", "name", "build_pack", "git_repository", "git_branch", "git_commit_sha", "repository_project_id", "source_id", "source_type",
  "private_key_id", "static_image", "install_command", "build_command", "start_command", "base_directory", "publish_directory", "ports_exposes",
  "dockerfile", "dockerfile_location", "dockerfile_target_build", "docker_registry_image_name", "docker_compose_location", "docker_compose",
  "docker_compose_raw", "docker_compose_domains", "docker_compose_custom_start_command", "docker_compose_custom_build_command",
  "compose_parsing_version", "watch_paths", "custom_nginx_configuration", "health_check_enabled", "health_check_interval", "health_check_timeout",
  "health_check_retries", "health_check_start_period", "custom_healthcheck_found",
].map((c) => `a."${c}"`);

/** The application's build columns and settings, by uuid. */
export async function findApplicationBuild(tx: SqlExecutor, uuid: string): Promise<DeployApplicationBuildRow | null> {
  const r = await tx.execute<DeployApplicationBuildRow>(
    `SELECT ${BUILD_COLUMNS.join(", ")},
            st.is_static, st.is_spa, st.is_build_server_enabled, st.is_preserve_repository_enabled, st.is_raw_compose_deployment_enabled
       FROM deploy.applications a
       LEFT JOIN deploy.application_settings st ON st.application_id = a.id
      WHERE a.uuid = $1 AND a.deleted_at IS NULL`,
    [uuid],
  );
  return r.rows[0] ?? null;
}

/** The columns of deploy.applications that General writes for the build packs (and the Dockerfile's health check). */
export const APPLICATION_BUILD_COLUMNS = [
  "build_pack",
  "static_image",
  "install_command",
  "build_command",
  "start_command",
  "base_directory",
  "publish_directory",
  "dockerfile",
  "dockerfile_location",
  "dockerfile_target_build",
  "docker_compose_location",
  "docker_compose_raw",
  "docker_compose_domains",
  "docker_compose_custom_start_command",
  "docker_compose_custom_build_command",
  "watch_paths",
  "custom_nginx_configuration",
  "health_check_interval",
  "health_check_timeout",
  "health_check_retries",
  "health_check_start_period",
  "custom_healthcheck_found",
] as const;
export type ApplicationBuildColumn = (typeof APPLICATION_BUILD_COLUMNS)[number];
export type ApplicationBuildChanges = Partial<Record<ApplicationBuildColumn, string | number | boolean | null>>;

/** The columns of deploy.application_settings that General writes for the build packs. */
export const APPLICATION_BUILD_SETTING_COLUMNS = ["is_static", "is_spa", "is_build_server_enabled", "is_preserve_repository_enabled"] as const;
export type ApplicationBuildSettingColumn = (typeof APPLICATION_BUILD_SETTING_COLUMNS)[number];
export type ApplicationBuildSettingChanges = Partial<Record<ApplicationBuildSettingColumn, boolean>>;

/** $application->save() and $application->settings->save(): only the given columns, and updated_at of the row that changes. */
export async function updateApplicationBuild(tx: SqlExecutor, id: string | number, changes: ApplicationBuildChanges, settings: ApplicationBuildSettingChanges = {}): Promise<void> {
  const columns = APPLICATION_BUILD_COLUMNS.filter((c) => changes[c] !== undefined);
  if (columns.length) {
    const sets = columns.map((c, i) => `"${c}" = $${i + 2}`);
    await tx.execute(`UPDATE deploy.applications SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE id = $1 AND deleted_at IS NULL`, [id, ...columns.map((c) => changes[c] ?? null)]);
  }
  const settingColumns = APPLICATION_BUILD_SETTING_COLUMNS.filter((c) => settings[c] !== undefined);
  if (settingColumns.length) {
    const sets = settingColumns.map((c, i) => `"${c}" = $${i + 2}`);
    await tx.execute(`UPDATE deploy.application_settings SET ${[...sets, `updated_at = ${NOW}`].join(", ")} WHERE application_id = $1`, [id, ...settingColumns.map((c) => settings[c])]);
  }
}

/**
 * Application::otherApplicationBuildingSameImage(): another application of
 * the org that builds and pushes an image with this name (Docker image and
 * Docker Compose applications push none).
 */
export async function findOtherApplicationBuildingImage(tx: SqlExecutor, id: string | number, imageName: string): Promise<{ uuid: string; name: string } | null> {
  const r = await tx.execute<{ uuid: string; name: string }>(
    `SELECT uuid, name FROM deploy.applications
      WHERE id <> $1 AND deleted_at IS NULL AND docker_registry_image_name = $2 AND build_pack NOT IN ('dockerimage', 'dockercompose')
      ORDER BY id LIMIT 1`,
    [id, imageName],
  );
  return r.rows[0] ?? null;
}

/**
 * The saving hook when the build pack changes away from Docker Compose: the
 * application's SERVICE_FQDN_* and SERVICE_URL_* variables go, preview ones
 * included. Answers how many rows went.
 */
export async function deleteApplicationServiceVariables(tx: SqlExecutor, id: string | number): Promise<number> {
  const r = await tx.execute<{ id: string | number }>(
    `DELETE FROM deploy.environment_variables
      WHERE resourceable_type = E'${APPLICATION_MORPH_SQL}' AND resourceable_id = $1 AND (key LIKE 'SERVICE_FQDN_%' OR key LIKE 'SERVICE_URL_%')
      RETURNING id`,
    [id],
  );
  return r.rows.length;
}

/** General::instantSave() when "Preserve repository" is switched off: the application's file storages are no longer based on Git. */
export async function clearApplicationFileStoragesBasedOnGit(tx: SqlExecutor, id: string | number): Promise<void> {
  await tx.execute(`UPDATE deploy.local_file_volumes SET is_based_on_git = false, updated_at = ${NOW} WHERE resource_type = E'${APPLICATION_MORPH_SQL}' AND resource_id = $1 AND is_based_on_git`, [id]);
}
