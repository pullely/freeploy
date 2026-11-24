// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/docker.php (generateLabelsApplication: what it
// reads of an application, its settings, its destination and that destination's server) and
// app/Livewire/Project/Application/General.php (what its label and HTTP Basic Authentication fields
// write) (Apache-2.0), modified.
//
// The columns Coolify's label generator reads, and the ones the General page's Labels and
// Authentication sections write, in queries of their own: deploy.applications, its
// deploy.application_settings row, the destination's network and the server's proxy and settings. Every
// function takes the transaction of withOrg(), so row-level security confines it to that org.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";
import { DESTINATION_MORPH_CLASS } from "./destinations.js";

const NOW = "date_trunc('second', timezone('UTC', now()))";

export interface DeployApplicationLabelRow extends SqlRow {
  id: string | number;
  uuid: string;
  fqdn: string | null;
  build_pack: string;
  ports_exposes: string | null;
  redirect: string;
  /** base64 of the labels text (Coolify's format); older rows may hold the text itself. */
  custom_labels: string | null;
  is_http_basic_auth_enabled: boolean;
  http_basic_auth_username: string | null;
  /** An `encrypted` column: the stored value is ciphertext. */
  http_basic_auth_password: string | null;
  http_basic_auth_hash_algorithm: string;
  http_basic_auth_bcrypt_cost: number;
  http_basic_auth_argon2id_memory_cost: number;
  http_basic_auth_argon2id_time_cost: number;
  /** JSON columns: the driver may hand back the parsed value or its text. */
  noindex_domains: unknown;
  domain_port_overrides: unknown;
  // application_settings
  is_static: boolean | null;
  is_force_https_enabled: boolean | null;
  is_gzip_enabled: boolean | null;
  is_stripprefix_enabled: boolean | null;
  is_permanent_redirect_enabled: boolean | null;
  is_container_label_readonly_enabled: boolean | null;
  is_container_label_escape_enabled: boolean | null;
  application_traefik_certificate_resolver: string | null;
  // destination and its server
  destination_network: string | null;
  server_uuid: string | null;
  /** servers.proxy (JSON): type, status and what the proxy pages keep there. */
  server_proxy: unknown;
  server_generate_exact_labels: boolean | null;
  server_traefik_certificate_resolver: string | null;
  server_is_traffic_analytics_enabled: boolean | null;
}

const STANDALONE = DESTINATION_MORPH_CLASS.standalone.replace(/\\/g, "\\\\");
const SWARM = DESTINATION_MORPH_CLASS.swarm.replace(/\\/g, "\\\\");

/** The application with what generateLabelsApplication() reads: settings, destination.network, destination.server and its settings. */
export async function findApplicationLabelSource(tx: SqlExecutor, uuid: string): Promise<DeployApplicationLabelRow | null> {
  const r = await tx.execute<DeployApplicationLabelRow>(
    `SELECT a.id, a.uuid, a.fqdn, a.build_pack, a.ports_exposes, a.redirect, a.custom_labels,
            a.is_http_basic_auth_enabled, a.http_basic_auth_username, a.http_basic_auth_password, a.http_basic_auth_hash_algorithm,
            a.http_basic_auth_bcrypt_cost, a.http_basic_auth_argon2id_memory_cost, a.http_basic_auth_argon2id_time_cost,
            a.noindex_domains, a.domain_port_overrides,
            st.is_static, st.is_force_https_enabled, st.is_gzip_enabled, st.is_stripprefix_enabled, st.is_permanent_redirect_enabled,
            st.is_container_label_readonly_enabled, st.is_container_label_escape_enabled,
            st.traefik_certificate_resolver AS application_traefik_certificate_resolver,
            COALESCE(sd.network, wd.network) AS destination_network,
            s.uuid AS server_uuid, s.proxy AS server_proxy,
            ss.generate_exact_labels AS server_generate_exact_labels,
            ss.traefik_certificate_resolver AS server_traefik_certificate_resolver,
            ss.is_traffic_analytics_enabled AS server_is_traffic_analytics_enabled
       FROM deploy.applications a
       LEFT JOIN deploy.application_settings st ON st.application_id = a.id
       LEFT JOIN deploy.standalone_dockers sd ON sd.id = a.destination_id AND a.destination_type = E'${STANDALONE}'
       LEFT JOIN deploy.swarm_dockers wd ON wd.id = a.destination_id AND a.destination_type = E'${SWARM}'
       LEFT JOIN deploy.servers s ON s.id = COALESCE(sd.server_id, wd.server_id) AND s.deleted_at IS NULL
       LEFT JOIN deploy.server_settings ss ON ss.server_id = s.id
      WHERE a.uuid = $1 AND a.deleted_at IS NULL`,
    [uuid],
  );
  return r.rows[0] ?? null;
}

/** The columns of deploy.applications the Labels and Authentication sections write. */
export const APPLICATION_LABEL_COLUMNS = [
  "custom_labels",
  "is_http_basic_auth_enabled",
  "http_basic_auth_username",
  "http_basic_auth_password",
  "http_basic_auth_hash_algorithm",
  "http_basic_auth_bcrypt_cost",
  "http_basic_auth_argon2id_memory_cost",
  "http_basic_auth_argon2id_time_cost",
] as const;
export type ApplicationLabelColumn = (typeof APPLICATION_LABEL_COLUMNS)[number];
/** http_basic_auth_password is given already encrypted for its column. */
export type ApplicationLabelChanges = Partial<Record<ApplicationLabelColumn, string | number | boolean | null>>;

/** $application->save(): only the given columns, and updated_at. False when the application is gone. */
export async function updateApplicationLabels(tx: SqlExecutor, id: string | number, changes: ApplicationLabelChanges): Promise<boolean> {
  const columns = APPLICATION_LABEL_COLUMNS.filter((c) => changes[c] !== undefined);
  if (columns.length === 0) return true;
  const r = await tx.execute<{ id: string | number }>(
    `UPDATE deploy.applications SET ${[...columns.map((c, i) => `"${c}" = $${i + 2}`), `updated_at = ${NOW}`].join(", ")} WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [id, ...columns.map((c) => changes[c] ?? null)],
  );
  return r.rows.length > 0;
}

/** The two container label settings of deploy.application_settings. */
export const APPLICATION_LABEL_SETTING_COLUMNS = ["is_container_label_escape_enabled", "is_container_label_readonly_enabled"] as const;
export type ApplicationLabelSettingColumn = (typeof APPLICATION_LABEL_SETTING_COLUMNS)[number];
export type ApplicationLabelSettingChanges = Partial<Record<ApplicationLabelSettingColumn, boolean>>;

/** $application->settings->save(): only the given columns, and updated_at. */
export async function updateApplicationLabelSettings(tx: SqlExecutor, applicationId: string | number, changes: ApplicationLabelSettingChanges): Promise<boolean> {
  const columns = APPLICATION_LABEL_SETTING_COLUMNS.filter((c) => changes[c] !== undefined);
  if (columns.length === 0) return true;
  const r = await tx.execute<{ id: string | number }>(
    `UPDATE deploy.application_settings SET ${[...columns.map((c, i) => `"${c}" = $${i + 2}`), `updated_at = ${NOW}`].join(", ")} WHERE application_id = $1 RETURNING id`,
    [applicationId, ...columns.map((c) => changes[c]!)],
  );
  return r.rows.length > 0;
}
