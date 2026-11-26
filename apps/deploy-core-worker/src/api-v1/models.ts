// Derived from coollabsio/coolify@91b7e3e:app/Models/{Project,Environment,PrivateKey,Server,ServerSetting}.php
// ($hidden, $casts, $appends) and Laravel's Model::toArray() (Apache-2.0 / MIT), modified.
//
// A row (every column, PostgreSQL's types) as Eloquent's toArray() gives it to Coolify's API: the hidden
// columns left out unless made visible, dates as their casts format them, the appended attributes added,
// and Coolify's team_id in place of Freeploy's org_id.
import type { ApiRow } from "@saas/db/deploy";
import { fromJs, laravelDate, obj, sqlDate, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";

export interface ModelShape {
  /** $hidden */
  hidden: readonly string[];
  /** 'datetime' and 'date' casts (with the model's created_at / updated_at / deleted_at). */
  dates: readonly string[];
}

const TIMESTAMP_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?([+-]\d\d:\d\d|Z)?$/;

/** row_to_json()'s text for a timestamp column, as a UTC date. */
function asUtc(text: string): Date {
  return new Date(/[+-]\d\d:\d\d$|Z$/.test(text) ? text : `${text}Z`);
}

function value(column: string, v: unknown, shape: ModelShape): PhpValue {
  if (typeof v === "string" && TIMESTAMP_RE.test(v)) return shape.dates.includes(column) ? laravelDate(asUtc(v)) : sqlDate(asUtc(v));
  return fromJs(v);
}

/** toArray(): the columns (and `extra`, as appended attributes and loaded relations) minus the hidden ones not made visible. */
export function toModel(row: ApiRow, shape: ModelShape, opts: { visible?: readonly string[]; extra?: Array<[string, PhpValue]>; teamId?: string | undefined } = {}): PhpObject {
  const entries: Array<[string, PhpValue]> = [];
  for (const [k, v] of row) {
    if (shape.hidden.includes(k) && !opts.visible?.includes(k)) continue;
    entries.push([k, value(k, v, shape)]);
  }
  if (opts.teamId !== undefined) entries.push(["team_id", opts.teamId]);
  for (const [k, v] of opts.extra ?? []) {
    const at = entries.findIndex(([key]) => key === k);
    if (at === -1) entries.push([k, v]);
    else entries[at] = [k, v];
  }
  return obj(entries);
}

export const PROJECT: ModelShape = { hidden: [], dates: ["created_at", "updated_at"] };
export const ENVIRONMENT: ModelShape = { hidden: [], dates: ["created_at", "updated_at"] };
export const PRIVATE_KEY: ModelShape = { hidden: ["private_key"], dates: ["created_at", "updated_at"] };
export const SERVER: ModelShape = {
  hidden: ["logdrain_axiom_api_key", "logdrain_newrelic_license_key", "proxy_error_page"],
  dates: ["created_at", "updated_at", "deleted_at", "sentinel_waiting_since"],
};
export const SERVER_SETTING: ModelShape = {
  hidden: ["is_build_server", "sentinel_token", "sentinel_custom_url", "logdrain_newrelic_license_key", "logdrain_axiom_api_key", "logdrain_custom_config", "logdrain_custom_config_parser", "geoip_maxmind_license_key"],
  dates: ["created_at", "updated_at", "docker_version_checked_at", "compose_version_checked_at", "patch_checked_at", "image_candidate_scans_date", "ssh_host_key_trusted_at"],
};

export function rowValue(row: ApiRow, column: string): unknown {
  return row.find(([k]) => k === column)?.[1];
}

export function withoutColumns(row: ApiRow, columns: readonly string[]): ApiRow {
  return row.filter(([k]) => !columns.includes(k));
}

export function onlyColumns(row: ApiRow, columns: readonly string[]): ApiRow {
  return row.filter(([k]) => columns.includes(k));
}
