// A golden run (fixtures/deployments/cases.json) as the deployment engine's world: the rows Coolify's PHP
// was given, as the plain row data the engine reads; an executor that plays the processes Coolify started,
// one by one, and refuses any other; and a store that keeps what the engine writes. For the
// deployments*.test.ts files.
import type { ApplicationHealthcheckChanges, DeployDeploymentApplicationRow, DeployDeploymentBuildRow, DeployDeploymentRow, NewDeploymentLogEntry } from "@saas/db/deploy";
import { normalizeDomainPortOverrides } from "@deploy-core-worker/applications/domains";
import { labelApplication } from "@deploy-core-worker/applications/labels-service";
import { resolveRealValue, sharedVariableReferences } from "@deploy-core-worker/environment-variables/references";
import { withoutEdgeLineBreaks } from "@deploy-core-worker/environment-variables/env-format";
import { generateLabelsApplication } from "@deploy-core-worker/labels/labels";
import { DEFAULT_ENGINE_CONFIG, type DeploymentContext, type DeploymentEffect, type DeploymentExecutor, type DeploymentStore, type EngineDeps, type RemoteProcess } from "@deploy-core-worker/deployments/engine";
import type { RuntimeVariable } from "@deploy-core-worker/deployments/runtime-env";
import { GOLDEN_NOW, goldenRun, type GoldenLog, type GoldenProcess, type GoldenRun, type Json, type RunCase } from "./deployment-goldens";

/** The APP_KEY the goldens were made with — the one of Coolify's own .env.testing, which the `testing` environment reads: the key of the build secrets hash. */
export const GOLDEN_APP_KEY = "base64:8VEfVNVkXQ9mH2L33WBWNMF4eQ0BWD5CTzB8mIxcl+k=";

/** What Coolify's rows held when the job started (goldens.json's `build`); undefined for a case without a golden run. */
const before = (run: RunCase): GoldenRun["build"] | undefined => (goldenRun(run.id) as GoldenRun | undefined)?.build;

export const ORG = "00000000-0000-4000-8000-00000000000a";

const text = (value: unknown, fallback: string | null = null): string | null => (typeof value === "string" ? value : value === null || value === undefined ? fallback : String(value));
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : value === undefined || value === null ? fallback : Boolean(value));
const int = (value: unknown, fallback: number): number => (typeof value === "number" ? value : fallback);

/**
 * The application row of a case: what the case gives, and for everything else the column's default in
 * Coolify's schema (which deploy.applications, deploy.application_settings and deploy.server_settings share).
 */
export function applicationRow(run: RunCase): DeployDeploymentApplicationRow {
  // What the user changed since the last deployment is what the job reads.
  const a = { ...run.application, ...run.changedSince?.application };
  const s = { ...run.settings, ...run.changedSince?.settings };
  const stored = before(run)?.row;
  const ss = run.serverSettings;
  // The saving hook of Coolify's model: the domains without their ports, and the ports apart.
  const domains = normalizeDomainPortOverrides(text(a.fqdn), null);
  return {
    id: 1,
    uuid: text(a.uuid)!,
    name: text(a.name)!,
    build_pack: text(a.build_pack, "nixpacks")!,
    status: "exited",
    fqdn: domains.fqdn,
    git_branch: text(a.git_branch, "main")!,
    has_dockerfile: typeof a.dockerfile === "string" && a.dockerfile !== "",
    dockerfile_target_build: text(a.dockerfile_target_build),
    docker_registry_image_name: text(a.docker_registry_image_name),
    docker_registry_image_tag: text(a.docker_registry_image_tag),
    ports_exposes: text(a.ports_exposes),
    ports_mappings: text(a.ports_mappings),
    custom_network_aliases: text(a.custom_network_aliases),
    custom_labels: text(a.custom_labels),
    custom_docker_run_options: text(a.custom_docker_run_options),
    pre_deployment_command: text(a.pre_deployment_command),
    pre_deployment_command_container: text(a.pre_deployment_command_container),
    post_deployment_command: text(a.post_deployment_command),
    post_deployment_command_container: text(a.post_deployment_command_container),
    health_check_enabled: bool(a.health_check_enabled, true),
    health_check_type: text(a.health_check_type, "http"),
    health_check_command: text(a.health_check_command),
    health_check_method: text(a.health_check_method, "GET")!,
    health_check_scheme: text(a.health_check_scheme, "http")!,
    health_check_host: text(a.health_check_host, "localhost")!,
    health_check_port: text(a.health_check_port),
    health_check_path: text(a.health_check_path, "/"),
    health_check_return_code: int(a.health_check_return_code, 200),
    health_check_response_text: text(a.health_check_response_text),
    health_check_interval: int(a.health_check_interval, 5),
    health_check_timeout: int(a.health_check_timeout, 5),
    health_check_retries: int(a.health_check_retries, 10),
    health_check_start_period: int(a.health_check_start_period, 5),
    custom_healthcheck_found: a.custom_healthcheck_found === true,
    limits_cpus: text(a.limits_cpus, "0")!,
    limits_cpuset: text(a.limits_cpuset),
    limits_cpu_shares: int(a.limits_cpu_shares, 1024),
    limits_memory: text(a.limits_memory, "0")!,
    limits_memory_swap: text(a.limits_memory_swap, "0")!,
    limits_memory_swappiness: int(a.limits_memory_swappiness, 60),
    limits_memory_reservation: text(a.limits_memory_reservation, "0")!,
    // The creating hook of Coolify's model: its current parser version.
    compose_parsing_version: "5",
    git_ssh_known_hosts: text(stored?.git_ssh_known_hosts ?? a.git_ssh_known_hosts),
    redirect: "both",
    is_http_basic_auth_enabled: false,
    http_basic_auth_username: null,
    http_basic_auth_password: null,
    http_basic_auth_hash_algorithm: "bcrypt",
    http_basic_auth_bcrypt_cost: 10,
    http_basic_auth_argon2id_memory_cost: 65536,
    http_basic_auth_argon2id_time_cost: 4,
    noindex_domains: null,
    domain_port_overrides: domains.overrides,
    is_static: bool(s.is_static, false),
    is_force_https_enabled: true,
    is_gzip_enabled: true,
    is_stripprefix_enabled: true,
    is_permanent_redirect_enabled: false,
    is_container_label_readonly_enabled: bool(s.is_container_label_readonly_enabled, true),
    is_container_label_escape_enabled: bool(s.is_container_label_escape_enabled, true),
    application_traefik_certificate_resolver: null,
    is_consistent_container_name_enabled: bool(s.is_consistent_container_name_enabled, false),
    custom_internal_name: text(s.custom_internal_name),
    custom_container_name_prefix: text(s.custom_container_name_prefix),
    stop_grace_period: typeof s.stop_grace_period === "number" ? s.stop_grace_period : null,
    rolling_update_drain_seconds: int(s.rolling_update_drain_seconds, 5),
    is_log_drain_enabled: bool(s.is_log_drain_enabled, false),
    is_gpu_enabled: bool(s.is_gpu_enabled, false),
    gpu_driver: text(s.gpu_driver, "nvidia"),
    gpu_count: text(s.gpu_count),
    gpu_device_ids: text(s.gpu_device_ids),
    gpu_options: text(s.gpu_options),
    is_env_sorting_enabled: bool(s.is_env_sorting_enabled, false),
    include_coolify_default_variables: bool(s.include_coolify_default_variables, true),
    redact_all_env_values_in_logs: bool(s.redact_all_env_values_in_logs, true),
    use_build_secrets: bool(s.use_build_secrets, false),
    include_network_hosts_in_build: bool(s.include_network_hosts_in_build, true),
    is_debug_enabled: false,
    environment_id: 1,
    environment_uuid: "env0000000000000000000001",
    environment_name: text(run.environment.name)!,
    project_id: 1,
    project_uuid: "prj0000000000000000000001",
    project_name: text(run.project.name)!,
    destination_id: 1,
    destination_type: "App\\Models\\StandaloneDocker",
    destination_network: text(run.destination.network)!,
    server_id: 1,
    server_uuid: "srv0000000000000000000001",
    server_name: text(run.server.name)!,
    server_ip: text(run.server.ip)!,
    server_user: text(run.server.user, "root"),
    server_port: int(run.server.port, 22),
    server_proxy: run.server.proxy ?? null,
    server_is_swarm_manager: false,
    server_is_swarm_worker: false,
    server_is_reachable: bool(ss.is_reachable, false),
    server_is_usable: bool(ss.is_usable, false),
    server_force_disabled: false,
    server_docker_version: text(ss.docker_version),
    server_timezone: "UTC",
    server_generate_exact_labels: false,
    server_traefik_certificate_resolver: "letsencrypt",
    server_is_traffic_analytics_enabled: false,
    is_logdrain_newrelic_enabled: bool(ss.is_logdrain_newrelic_enabled, false),
    is_logdrain_axiom_enabled: bool(ss.is_logdrain_axiom_enabled, false),
    is_logdrain_custom_enabled: bool(ss.is_logdrain_custom_enabled, false),
    is_logdrain_cloudwatch_enabled: bool(ss.is_logdrain_cloudwatch_enabled, false),
    logdrain_cloudwatch_region: text(ss.logdrain_cloudwatch_region),
    logdrain_cloudwatch_group: text(ss.logdrain_cloudwatch_group),
    logdrain_cloudwatch_stream_prefix: text(ss.logdrain_cloudwatch_stream_prefix),
  };
}

/** The variables of a case as a deployment reads them: decrypted, with their shared variable references filled in. */
export function variablesOf(run: RunCase): RuntimeVariable[] {
  // Coolify's Server model creates these two for every server.
  const shared: Json[] = [
    ...run.sharedVariables,
    { key: "COOLIFY_SERVER_UUID", value: "srv0000000000000000000001", type: "server" },
    { key: "COOLIFY_SERVER_NAME", value: text(run.server.name), type: "server" },
  ];
  const find = (type: string, key: string) => {
    const found = shared.find((v) => v.type === type && v.key === key);
    return found ? { value: text(found.value, "")!, isShownOnce: found.is_shown_once === true } : null;
  };
  const byCase = run.variables.map((v): RuntimeVariable => {
    // The model's accessor: nothing stored is null, and a single-line value loses its edge line breaks.
    const stored = text(v.value);
    const value = stored === null || stored === "" ? null : withoutEdgeLineBreaks(stored);
    return {
      key: text(v.stored_key ?? v.key)!,
      value,
      realValue: resolveRealValue(value, { find }),
      is_literal: v.is_literal === true,
      is_multiline: v.is_multiline === true,
      is_runtime: v.is_runtime !== false,
      is_buildtime: v.is_buildtime !== false,
      is_shown_once: v.is_shown_once === true,
      referencesLockedSharedVariable: sharedVariableReferences(value).some((r) => find(r.type, r.key)?.isShownOnce === true),
    };
  });
  const variables = [...byCase];
  // orderBy('key') of the SQLite the goldens were made with: by code unit.
  if (run.settings.is_env_sorting_enabled === true) variables.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const rows = before(run)?.variables;
  if (!rows || rows.length < run.variables.length) return variables;
  // The rows Coolify had: the case's variables in the order they were created, after the ones the model's
  // creating hook made (a Nixpacks application's NIXPACKS_NODE_VERSION), in the order the job reads them.
  const byId = [...rows].sort((x, y) => x.id - y.id);
  const made = byId.slice(0, rows.length - run.variables.length);
  const own = new Map(byId.slice(made.length).map((row, index) => [row.id, index]));
  const created = run.variables.map((_, index) => variables.find((v) => v === byCase[index])!);
  return rows.map((row): RuntimeVariable => {
    const index = own.get(row.id);
    if (index !== undefined) return { ...created[index]!, id: row.id };
    return { id: row.id, key: row.key, value: row.value, realValue: row.value, is_literal: row.is_literal, is_multiline: row.is_multiline, is_runtime: row.is_runtime, is_buildtime: row.is_buildtime, is_shown_once: false, referencesLockedSharedVariable: false };
  });
}

/** The Git and build columns of a case's application, as Coolify stored them (after its mutators and defaults). */
export function buildRow(run: RunCase): DeployDeploymentBuildRow {
  const stored = before(run)?.row ?? {};
  const flag = (name: string, fallback: boolean): boolean => (stored[name] === undefined || stored[name] === null ? fallback : Boolean(stored[name]));
  return {
    application_id: 1,
    git_repository: text(stored.git_repository, text(run.application.git_repository, "")!)!,
    git_commit_sha: text(stored.git_commit_sha, "HEAD")!,
    base_directory: text(stored.base_directory, "/"),
    publish_directory: text(stored.publish_directory),
    dockerfile: text(stored.dockerfile),
    dockerfile_location: text(stored.dockerfile_location),
    install_command: text(stored.install_command),
    build_command: text(stored.build_command),
    start_command: text(stored.start_command),
    static_image: text(stored.static_image, "nginx:alpine"),
    custom_nginx_configuration: text(stored.custom_nginx_configuration),
    source_id: stored.source_id === undefined || stored.source_id === null ? null : Number(stored.source_id),
    source_type: text(stored.source_type),
    private_key_id: stored.private_key_id === undefined || stored.private_key_id === null ? null : Number(stored.private_key_id),
    has_git_https_credentials: false,
    is_spa: flag("is_spa", false),
    is_git_submodules_enabled: flag("is_git_submodules_enabled", true),
    is_git_lfs_enabled: flag("is_git_lfs_enabled", true),
    is_git_shallow_clone_enabled: flag("is_git_shallow_clone_enabled", true),
    disable_build_cache: flag("disable_build_cache", false),
    inject_build_args_to_dockerfile: flag("inject_build_args_to_dockerfile", true),
    include_source_commit_in_build: flag("include_source_commit_in_build", false),
    is_build_server_enabled: flag("is_build_server_enabled", false),
    is_preserve_repository_enabled: flag("is_preserve_repository_enabled", false),
    server_role: "both",
  };
}

export function deploymentRow(run: RunCase): DeployDeploymentRow {
  const d = run.deployment;
  return {
    id: 100,
    application_id: "1",
    deployment_uuid: d.deployment_uuid,
    pull_request_id: 0,
    force_rebuild: d.force_rebuild === true,
    // $commit ?: ($application->git_commit_sha ?: 'HEAD')
    commit: text(d.commit, text(run.application.git_commit_sha, "HEAD")!)!,
    status: "in_progress",
    is_webhook: false,
    is_api: false,
    is_mcp: false,
    restart_only: d.restart_only === true,
    rollback: d.rollback === true,
    only_this_server: false,
    git_type: null,
    server_id: 1,
    build_server_id: null,
    application_name: text(run.application.name),
    server_name: text(run.server.name),
    deployment_url: `/project/prj0000000000000000000001/environment/env0000000000000000000001/application/${text(run.application.uuid)}/deployment/${d.deployment_uuid}`,
    destination_id: "1",
    commit_message: null,
    docker_registry_image_tag: null,
    parent_deployment_uuid: null,
    created_at: GOLDEN_NOW,
    updated_at: GOLDEN_NOW,
    finished_at: null,
    deploy_started_at: null,
  };
}

export function contextOf(run: RunCase): DeploymentContext {
  const application = applicationRow(run);
  return {
    orgId: ORG,
    deployment: deploymentRow(run),
    application,
    variables: variablesOf(run),
    persistentStorages: run.persistentStorages.map((storage, index) => ({ id: index + 1, name: text(storage.name)!, mount_path: text(storage.mount_path)!, host_path: text(storage.host_path) })),
    fileStorages: run.fileStorages.map((storage, index) => ({ id: index + 1, fs_path: text(storage.fs_path)!, mount_path: text(storage.mount_path), is_directory: storage.is_directory === true, has_content: typeof storage.content === "string" })),
    generateLabels: () => generateLabelsApplication(labelApplication(application, null), null),
    build: buildRow(run),
    // What Coolify's pendingDeploymentConfigurationDiff() answered for the rows of the case.
    configurationDiff: before(run)?.configurationDiff ?? { legacyFallback: true, requiresBuild: true },
  };
}

/** The log as fixtures/deployments/goldens.json writes it: without what is the same in every entry. */
export function compactLogs(logs: NewDeploymentLogEntry[]): GoldenLog[] {
  return logs.map((entry) => ({
    ...(entry.command === null ? {} : { command: entry.command }),
    output: entry.output,
    ...(entry.type === "stdout" ? {} : { type: entry.type }),
    ...(entry.hidden ? { hidden: true } : {}),
    ...(entry.batch === 1 ? {} : { batch: entry.batch }),
  }));
}

/** What a run of the engine leaves behind. */
export interface World {
  deployment: { status: string; finishedAt: boolean; deployStartedAt: boolean; logs: NewDeploymentLogEntry[] };
  application: { status: string; custom_labels: string | null; restart_count: number; last_restart_at: string | null; last_restart_type: string | null; restart_limit_reached: boolean };
  dockerVersion: string | null;
  /** What a build writes: the commit and its message on the deployment, and on the application its health check and host keys. */
  build: { commit: string; commitMessage: string | null; healthcheck: Required<ApplicationHealthcheckChanges>; gitSshKnownHosts: string | null; createdVariables: Array<{ key: string; value: string | null; is_preview: boolean }> };
  /** The deployment uuids deploymentUuidsAmong() knows. */
  deploymentUuids: string[];
  processes: RemoteProcess[];
  /** The first process that was not the one Coolify started at that point. */
  mismatch: string | null;
  sleeps: number[];
  effects: DeploymentEffect[];
  /** The deployments startNextQueued() answers with. */
  startNext: string[];
  /** The commit messages earlier deployments stored, by commit (reuse_commit_message). */
  earlierMessages: Record<string, string>;
  nextQueuedCalls: Array<{ applicationId: string | number; serverId: string | number | null }>;
}

export function newWorld(run: RunCase): World {
  return {
    deployment: { status: "in_progress", finishedAt: false, deployStartedAt: false, logs: [] },
    application: { status: "exited", custom_labels: text(run.application.custom_labels), restart_count: 0, last_restart_at: null, last_restart_type: null, restart_limit_reached: false },
    dockerVersion: text(run.serverSettings.docker_version),
    build: {
      commit: deploymentRow(run).commit,
      commitMessage: null,
      healthcheck: {
        health_check_enabled: applicationRow(run).health_check_enabled,
        health_check_interval: applicationRow(run).health_check_interval,
        health_check_timeout: applicationRow(run).health_check_timeout,
        health_check_retries: applicationRow(run).health_check_retries,
        health_check_start_period: applicationRow(run).health_check_start_period,
        custom_healthcheck_found: applicationRow(run).custom_healthcheck_found,
      },
      gitSshKnownHosts: applicationRow(run).git_ssh_known_hosts,
      createdVariables: [],
    },
    deploymentUuids: [run.deployment.deployment_uuid, ...(run.earlierDeployments ?? []).map((d) => String(d.deployment_uuid))],
    processes: [],
    mismatch: null,
    sleeps: [],
    effects: [],
    startNext: [],
    earlierMessages: Object.fromEntries((run.earlierDeployments ?? []).filter((d) => typeof d.commit_message === "string" && d.commit_message !== "" && d.status !== "skipped").map((d) => [String(d.commit ?? "HEAD"), String(d.commit_message)])),
    nextQueuedCalls: [],
  };
}

export function storeOf(world: World): DeploymentStore {
  return {
    status: async () => world.deployment.status,
    appendLog: async (_id, entry, hint) => {
      world.deployment.logs.push(entry);
      if (hint && !world.deployment.logs.some((e) => e.output === hint.output)) world.deployment.logs.push(hint);
    },
    markInProgress: async () => {
      if (world.deployment.status !== "cancelled-by-user") world.deployment.status = "in_progress";
      return world.deployment.status;
    },
    markDeployStarted: async () => {
      if (world.deployment.status === "in_progress") world.deployment.deployStartedAt = true;
    },
    setStatus: async (_id, status) => {
      world.deployment.status = status;
      world.deployment.finishedAt = true;
    },
    setFinishedAt: async () => {
      world.deployment.finishedAt = true;
    },
    updateApplication: async (_id, changes) => {
      Object.assign(world.application, changes);
    },
    rememberDockerVersion: async (_id, version) => {
      world.dockerVersion = version;
    },
    startNextQueued: async (applicationId, serverId) => {
      world.nextQueuedCalls.push({ applicationId, serverId });
      return world.startNext;
    },
    setCommit: async (_id, commit) => {
      world.build.commit = commit;
    },
    setCommitMessage: async (_applicationId, commit, message) => {
      if (world.build.commit === commit) world.build.commitMessage = message;
    },
    reuseCommitMessage: async (_id, _applicationId, commit) => {
      if (world.build.commitMessage === null) world.build.commitMessage = world.earlierMessages[commit] ?? null;
    },
    updateHealthcheck: async (_id, changes) => {
      Object.assign(world.build.healthcheck, changes);
    },
    mergeGitSshKnownHosts: async (_id, merge) => {
      const merged = merge(world.build.gitSshKnownHosts);
      if (merged.changed) world.build.gitSshKnownHosts = merged.knownHosts;
      return merged;
    },
    deploymentUuidsAmong: async (names) => names.filter((name) => world.deploymentUuids.includes(name)),
    createVariable: async (_id, key, value) => {
      world.build.createdVariables.push({ key, value, is_preview: false });
    },
  };
}

/**
 * An executor that answers like the server of a golden run: the processes must come in Coolify's order, each
 * with Coolify's script and input, and gets the output the case scripted. `cancelOn`: the user cancels while
 * the first process with that text runs.
 */
export function replayExecutor(world: World, golden: GoldenProcess[], cancelOn?: string): DeploymentExecutor {
  let cancelled = false;
  return {
    async run(process, onOutput) {
      const index = world.processes.length;
      const expected = golden[index];
      world.processes.push(process);
      const refuse = (message: string): never => {
        world.mismatch ??= message;
        throw new Error(message);
      };
      if (!expected) return refuse(`Process ${index + 1} is one more than Coolify ran:\n${process.script}`);
      if (expected.script !== process.script) return refuse(`Process ${index + 1} is not Coolify's.\n  Coolify: ${expected.script}\n  engine:  ${process.script}`);
      if ((expected.input ?? null) !== (process.input ?? null)) return refuse(`Process ${index + 1} (${process.script}) has another stdin.\n--- Coolify\n${expected.input}\n--- engine\n${process.input}`);
      if (!cancelled && cancelOn !== undefined && process.script.includes(cancelOn)) {
        cancelled = true;
        world.deployment.status = "cancelled-by-user";
      }
      if (expected.output) await onOutput?.("out", expected.output);
      if (expected.errorOutput) await onOutput?.("err", expected.errorOutput);
      return { exitCode: expected.exitCode ?? 0, stdout: expected.output ?? "", stderr: expected.errorOutput ?? "" };
    },
  };
}

export function depsOf(world: World, executor: DeploymentExecutor): EngineDeps {
  return {
    executor,
    store: storeOf(world),
    now: () => new Date(GOLDEN_NOW),
    sleep: async (seconds) => {
      world.sleeps.push(seconds);
    },
    effect: (effect) => {
      world.effects.push(effect);
    },
    config: { ...DEFAULT_ENGINE_CONFIG, secretsHashKey: GOLDEN_APP_KEY },
  };
}
