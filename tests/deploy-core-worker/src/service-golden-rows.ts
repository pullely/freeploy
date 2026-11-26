// What the service parser's golden tests share (service-parser.test.ts, service-reparse.test.ts): the shape of
// the rows Coolify's emitters print, the port's rows in that shape, the first difference between two states,
// and the parser's context with PHP's random values replayed (see service-parser.test.ts).
import { generateEnvValue, type MagicValueSource } from "@deploy-core-worker/services/magic-values";
import type { ServiceParserContext } from "@deploy-core-worker/services/parser";
import type { ServiceSnapshot } from "@deploy-core-worker/services/store";

export type Row = Record<string, unknown>;
export interface GoldenState {
  service: Row;
  applications: Row[];
  databases: Row[];
  environment_variables: Row[];
  persistent_volumes: Row[];
  file_volumes: Row[];
}
export interface Goldens {
  fixture: {
    coolify_version: string;
    service_uuid: string;
    server: {
      ip: string;
      wildcard_domain: string | null;
      proxy_type: string | null;
      generate_exact_labels: boolean;
      traefik_certificate_resolver: string | null;
      is_traffic_analytics_enabled: boolean;
      caddy_supports_log_append: boolean;
      is_log_drain_enabled: boolean;
    };
    destination: { network: string };
    project: { name: string };
    environment: { name: string };
    base_configuration_dir: string;
  };
  services: Record<string, { ok: true; first: GoldenState; second: GoldenState | "same" } | { ok: false; error: string }>;
}

export const NOW = Date.UTC(2026, 0, 1) / 1000;

const PART_CLASS = { application: "App\\Models\\ServiceApplication", database: "App\\Models\\ServiceDatabase" } as const;
const flag = (value: boolean): number => (value ? 1 : 0);
const json = (value: unknown): string | null => (value === null ? null : JSON.stringify(value));

/** The rows of the store in the shape of the golden: Coolify's columns, with the defaults of the ones the port does not carry. */
export function asGolden(snapshot: ServiceSnapshot): GoldenState {
  const partDefaults = { description: null, exposes: null, status: "exited", service_id: snapshot.service.id, is_include_timestamps: 0 };
  return {
    service: {
      id: snapshot.service.id,
      uuid: snapshot.service.uuid,
      name: snapshot.service.name,
      environment_id: 1,
      server_id: 1,
      description: null,
      docker_compose_raw: snapshot.service.docker_compose_raw,
      docker_compose: snapshot.service.docker_compose,
      destination_type: "App\\Models\\StandaloneDocker",
      destination_id: 1,
      connect_to_docker_network: flag(snapshot.service.connect_to_docker_network),
      config_hash: null,
      service_type: snapshot.service.service_type,
      is_container_label_escape_enabled: flag(snapshot.service.is_container_label_escape_enabled),
      compose_parsing_version: snapshot.service.compose_parsing_version,
      redact_all_env_values_in_logs: 1,
      is_maintenance_enabled: 0,
      maintenance_page: null,
      include_coolify_default_variables: flag(snapshot.service.include_coolify_default_variables),
    },
    applications: snapshot.applications.map((row) => ({
      id: row.id,
      uuid: row.uuid,
      name: row.name,
      human_name: row.human_name,
      description: partDefaults.description,
      fqdn: row.fqdn,
      ports: row.ports,
      exposes: partDefaults.exposes,
      status: partDefaults.status,
      service_id: partDefaults.service_id,
      exclude_from_status: flag(row.exclude_from_status),
      required_fqdn: 0,
      image: row.image,
      is_log_drain_enabled: flag(row.is_log_drain_enabled),
      is_include_timestamps: partDefaults.is_include_timestamps,
      is_gzip_enabled: flag(row.is_gzip_enabled),
      is_stripprefix_enabled: flag(row.is_stripprefix_enabled),
      is_migrated: flag(row.is_migrated),
      noindex_domains: json(row.noindex_domains),
      domain_dns_statuses: null,
      redirect: row.redirect,
      is_force_https_enabled: flag(row.is_force_https_enabled),
      restart_count: 0,
      max_restart_count: 0,
      restart_limit_reached: 0,
      last_restart_at: null,
      last_restart_type: null,
      domain_port_overrides: json(row.domain_port_overrides),
      traefik_certificate_resolver: row.traefik_certificate_resolver,
      is_permanent_redirect_enabled: flag(row.is_permanent_redirect_enabled),
      is_removed_from_compose: flag(row.is_removed_from_compose),
    })),
    databases: snapshot.databases.map((row) => ({
      id: row.id,
      uuid: row.uuid,
      name: row.name,
      human_name: row.human_name,
      description: partDefaults.description,
      ports: row.ports,
      exposes: partDefaults.exposes,
      status: partDefaults.status,
      service_id: partDefaults.service_id,
      exclude_from_status: flag(row.exclude_from_status),
      image: row.image,
      public_port: null,
      is_public: 0,
      is_log_drain_enabled: flag(row.is_log_drain_enabled),
      is_include_timestamps: partDefaults.is_include_timestamps,
      is_gzip_enabled: flag(row.is_gzip_enabled),
      is_stripprefix_enabled: flag(row.is_stripprefix_enabled),
      is_migrated: flag(row.is_migrated),
      custom_type: null,
      public_port_timeout: 3600,
      is_removed_from_compose: flag(row.is_removed_from_compose),
    })),
    environment_variables: snapshot.environmentVariables.map((row) => ({
      id: row.id,
      key: row.key,
      value: row.value,
      is_preview: flag(row.is_preview),
      is_shown_once: flag(row.is_shown_once ?? false),
      is_multiline: flag(row.is_multiline),
      version: row.version,
      is_literal: flag(row.is_literal),
      order: null,
      is_required: flag(row.is_required),
      is_shared: flag(row.is_shared),
      resourceable_type: "App\\Models\\Service",
      resourceable_id: snapshot.service.id,
      is_runtime: 1,
      is_buildtime: 1,
      comment: row.comment,
      uses_legacy_escaping: 0,
      preserve_compose_null: flag(row.preserve_compose_null),
    })),
    persistent_volumes: snapshot.persistentVolumes.map((row) => ({
      id: row.id,
      name: row.name,
      mount_path: row.mount_path,
      host_path: null,
      container_id: null,
      resource_type: PART_CLASS[row.resource_type],
      resource_id: row.resource_id,
      is_preview_suffix_enabled: 1,
      standalone_sqlite_id: null,
      ignores_compose_driver_options: flag(row.ignores_compose_driver_options),
    })),
    file_volumes: snapshot.fileVolumes.map((row) => ({
      id: row.id,
      fs_path: row.fs_path,
      mount_path: row.mount_path,
      content: row.content,
      resource_type: PART_CLASS[row.resource_type],
      resource_id: row.resource_id,
      is_directory: flag(row.is_directory),
      is_host_file: flag(row.is_host_file),
      chown: null,
      chmod: null,
      is_based_on_git: 0,
      is_preview_suffix_enabled: 1,
      variable_fs_path: row.variable_fs_path,
    })),
  };
}

/** The first place two states differ, as a short text; null when they are equal. */
export function difference(actual: GoldenState, expected: GoldenState): string | null {
  for (const section of ["applications", "databases", "environment_variables", "persistent_volumes", "file_volumes"] as const) {
    const a = actual[section];
    const e = expected[section];
    for (let index = 0; index < Math.max(a.length, e.length); index += 1) {
      const left = a[index];
      const right = e[index];
      if (!left || !right) return `${section}[${index}]: ${left ? "not in PHP" : "missing"} ${JSON.stringify((left ?? right)?.key ?? (left ?? right)?.name)}`;
      for (const column of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (JSON.stringify(left[column]) !== JSON.stringify(right[column])) return `${section}[${index}].${column} (${String(right.key ?? right.name)}): ${JSON.stringify(left[column])} instead of ${JSON.stringify(right[column])}`;
      }
    }
  }
  for (const column of new Set([...Object.keys(actual.service), ...Object.keys(expected.service)])) {
    const left = actual.service[column];
    const right = expected.service[column];
    if (left === right) continue;
    if (typeof left === "string" && typeof right === "string") {
      const a = left.split("\n");
      const e = right.split("\n");
      const line = a.findIndex((text, index) => text !== e[index]);
      const at = line === -1 ? Math.min(a.length, e.length) : line;
      return `service.${column} line ${at + 1}: ${JSON.stringify(a[at])} instead of ${JSON.stringify(e[at])}`;
    }
    return `service.${column}: ${JSON.stringify(left)} instead of ${JSON.stringify(right)}`;
  }
  return null;
}

export const RANDOM_SHAPES: Record<string, RegExp> = {
  PASSWORD: /^[A-Za-z0-9]{32}$/,
  PASSWORD_64: /^[A-Za-z0-9]{64}$/,
  PASSWORDWITHSYMBOLS: /^[A-Za-z0-9~!#$%^&*()\-_.,<>?/\\{}[\]|:;]{32}$/,
  PASSWORDWITHSYMBOLS_64: /^[A-Za-z0-9~!#$%^&*()\-_.,<>?/\\{}[\]|:;]{64}$/,
  BASE64: /^[A-Za-z0-9]{32}$/,
  BASE64_32: /^[A-Za-z0-9]{32}$/,
  BASE64_64: /^[A-Za-z0-9]{64}$/,
  BASE64_128: /^[A-Za-z0-9]{128}$/,
  REALBASE64: /^[A-Za-z0-9+/]{43}=$/,
  REALBASE64_32: /^[A-Za-z0-9+/]{43}=$/,
  REALBASE64_64: /^[A-Za-z0-9+/]{86}==$/,
  REALBASE64_128: /^[A-Za-z0-9+/]{171}=$/,
  HEX_32: /^[0-9a-f]{32}$/,
  HEX_64: /^[0-9a-f]{64}$/,
  HEX_128: /^[0-9a-f]{128}$/,
  USER: /^[A-Za-z0-9]{16}$/,
  LOWERCASEUSER: /^[a-z0-9]{16}$/,
};

export const source: MagicValueSource = { bytes: (count) => crypto.getRandomValues(new Uint8Array(count)), now: () => NOW };

export function contextFor(used: Goldens["fixture"], golden: GoldenState, shapeErrors: string[]): ServiceParserContext {
  const values = new Map(golden.environment_variables.map((row) => [row.key as string, row.value as string | null]));
  let subCounter = 0;
  return {
    server: {
      ip: used.server.ip,
      wildcardDomain: used.server.wildcard_domain,
      proxyType: used.server.proxy_type,
      generateExactLabels: used.server.generate_exact_labels,
      traefikCertificateResolver: used.server.traefik_certificate_resolver,
      isTrafficAnalyticsEnabled: used.server.is_traffic_analytics_enabled,
      caddySupportsLogAppend: used.server.caddy_supports_log_append,
      logDrainConfiguration: null,
    },
    destinationNetwork: used.destination.network,
    projectName: used.project.name,
    environmentName: used.environment.name,
    newUuid: () => {
      subCounter += 1;
      return `sub${String(subCounter).padStart(21, "0")}`;
    },
    magicValue: (command, key, signingKey) => {
      const shape = RANDOM_SHAPES[command];
      // Not random: unknown commands (null) and the Supabase keys, which the port computes itself.
      if (!shape) return generateEnvValue(command, source, signingKey);
      const own = generateEnvValue(command, source, signingKey) ?? "";
      const replayed = values.get(key) ?? own;
      if (!shape.test(own)) shapeErrors.push(`${key}: the port generated ${JSON.stringify(own)}`);
      if (!shape.test(replayed)) shapeErrors.push(`${key}: PHP generated ${JSON.stringify(replayed)}`);
      return replayed;
    },
  };
}
