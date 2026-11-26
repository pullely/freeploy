// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/AuditEventsController.php (index),
// app/Models/AuditEvent.php (scopeVisibleToTeam, scopeFiltered, scopeLatestFirst, $casts), bootstrap/helpers/api.php
// (serializeApiResponse), and laravel/framework's Validator (integer, min, max, string, in, nullable, sometimes, their
// messages), LengthAwarePaginator (toArray, linkCollection, url) and UrlWindow (Apache-2.0 / MIT), modified.
//
//   GET /v1/internal/api-v1/{org}/audit-events?per_page=&page=&search=&action=&source=
//
// Coolify's GET /api/v1/audit-events (DP-107), for api-edge once it has resolved the token (x-api-v1-* headers, and
// x-api-v1-url: the public URL the paginator's links name). Who may read it: `$request->user()->isAdminOfTeam()` —
// policy-worker's audit.read (owner and admin), as the team audit log page asks (DP-75) — else the controller's 403. The
// rows are the org's audit entries of the last 90 days that the team audit log page reads, mapped onto Coolify's columns as
// that page maps them (src/team-audit-log.ts: TEAM_EVENTS for the events Coolify records too, Freeploy's own name and
// description for the rest), filtered as scopeFiltered() does (the search in the event, description, resource name, actor
// name and — for a token that may read sensitive data — actor email; Postgres LIKE, case-sensitive), newest first, and paged
// as Laravel's LengthAwarePaginator writes a page.
//
// Departures, as Freeploy records them: the ids are Freeploy's (the entry's, `org_…` for team_id, `usr_…` or the service
// principal for actor_id, where Coolify's are integers, as GET /api/v1/team's are); `level` is always `info` (Freeploy
// records no warning levels); resource_uuid is null for the events Coolify records too (Coolify's team events name none) and
// the subject's id otherwise; of the sensitive columns Freeploy answers actor_email only — it records no token, no field
// changes, no request address or user agent, and its payloads are not Coolify's context, so actor_token_id,
// actor_token_name, metadata, changes, ip_address and user_agent are null.
import type { TeamAuditRow } from "@saas/db/events";
import { coolifyJson, laravelDate, obj, type CoolifyAnswer, type PhpObject, type PhpValue } from "@saas/contracts/coolify-api";
import { toTeamAuditEvent, TEAM_EVENTS } from "./team-audit-log.js";

export const AUDIT_EVENTS_MESSAGES = {
  notAdmin: "Only team admins and owners can view audit logs.",
} as const;

const SOURCES = ["all", "ui", "api", "mcp", "webhook", "system", "scheduler"];
const DEFAULT_PER_PAGE = 25;
const ON_EACH_SIDE = 3;

type Errors = Array<[string, string[]]>;
const add = (errors: Errors, field: string, message: string) => {
  const at = errors.find(([k]) => k === field);
  if (at) at[1].push(message);
  else errors.push([field, [message]]);
};

/** TrimStrings, then ConvertEmptyStringsToNull, of the query string ($request->all() of a GET). */
export function queryInput(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  url.searchParams.forEach((v, k) => {
    const t = v.replace(/^[\s\u0000\u000B]+|[\s\u0000\u000B]+$/g, "");
    out[k] = t === "" ? null : t;
  });
  return out;
}

/** filter_var($value, FILTER_VALIDATE_INT) !== false */
const isInteger = (v: unknown): boolean => (typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^[+-]?(0|[1-9]\d*)$/.test(v));
/** getSize() with an integer rule: the number, else the string's length. */
const size = (v: unknown): number => (isInteger(v) ? Number(v) : [...String(v ?? "")].length);
const display = (field: string) => field.replace(/_/g, " ");

/** index()'s Validator::make() of $request->all() with Laravel's messages, in the rules' order. */
export function auditEventsErrors(all: Record<string, unknown>): Errors {
  const errors: Errors = [];
  for (const [field, max] of [["per_page", 100], ["page", null]] as const) {
    if (!(field in all)) continue;
    const v = all[field];
    if (!isInteger(v)) add(errors, field, `The ${display(field)} field must be an integer.`);
    if (size(v) < 1) add(errors, field, `The ${display(field)} field must be at least 1.`);
    if (max !== null && size(v) > max) add(errors, field, `The ${display(field)} field must not be greater than ${max}.`);
  }
  for (const field of ["search", "action", "source"]) {
    if (!(field in all) || all[field] === null) continue;
    const v = all[field];
    if (typeof v !== "string") add(errors, field, `The ${display(field)} field must be a string.`);
    if (field === "source") {
      if (!SOURCES.includes(String(v))) add(errors, field, `The selected ${display(field)} is invalid.`);
    } else if ([...String(v)].length > 255) add(errors, field, `The ${display(field)} field must not be greater than 255 characters.`);
  }
  return errors;
}

/** One audit entry as Coolify's select() and casts give it (the sensitive columns added for a token that may read them). */
function auditRow(row: TeamAuditRow, teamId: string, sensitive: boolean): { fields: Array<[string, PhpValue]>; searchable: Array<string | null>; email: string | null; action: string; source: string } {
  const e = toTeamAuditEvent(row);
  const known = TEAM_EVENTS[row.eventType];
  const resourceType = known ? known.resource : row.subjectKind;
  const resourceName = known ? known.name(row) : row.subjectName;
  const fields: Array<[string, PhpValue]> = [
    ["id", row.id],
    ["team_id", teamId],
    ["event", e.event],
    ["source", e.source],
    ["action", e.action],
    ["level", "info"],
    ["actor_type", e.actorType],
    ["actor_id", row.actorId],
    ["actor_name", e.actorName],
    ["resource_type", resourceType],
    ["resource_uuid", known ? null : row.subjectId],
    ["resource_name", resourceName],
    ["description", e.description],
    ["created_at", laravelDate(row.occurredAt)],
  ];
  if (sensitive) {
    fields.push(["actor_email", e.actorEmail], ["actor_token_id", null], ["actor_token_name", null], ["metadata", null], ["changes", null], ["ip_address", null], ["user_agent", null]);
  }
  return { fields, searchable: [e.event, e.description, resourceName, e.actorName], email: e.actorEmail, action: e.action, source: e.source };
}

/** UrlWindow::get() of LengthAwarePaginator::elements(): the pages around the current one, '...' between. */
function elements(current: number, last: number): Array<number[] | "..."> {
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  if (last < ON_EACH_SIDE * 2 + 8) return [range(1, last)];
  const window = ON_EACH_SIDE + 4;
  if (current <= window) return [range(1, window + ON_EACH_SIDE), "...", range(last - 1, last)];
  if (current > last - window) return [range(1, 2), "...", range(last - (window + (ON_EACH_SIDE - 1)), last)];
  return [range(1, 2), "...", range(current - ON_EACH_SIDE, current + ON_EACH_SIDE), "...", range(last - 1, last)];
}

/** LengthAwarePaginator::toArray() of one page. */
function paginator(items: PhpObject[], total: number, perPage: number, current: number, path: string): PhpObject {
  const last = Math.max(Math.ceil(total / perPage), 1);
  const url = (page: number) => `${path}?page=${page}`;
  const from = items.length ? (current - 1) * perPage + 1 : null;
  const link = (u: string | null, label: string, page: number | null, active: boolean) => obj({ url: u, label, page, active });
  const links: PhpObject[] = [link(current > 1 ? url(current - 1) : null, "&laquo; Previous", current > 1 ? current - 1 : null, false)];
  for (const el of elements(current, last)) {
    if (el === "...") links.push(obj({ url: null, label: "...", active: false }));
    else for (const page of el) links.push(link(url(page), String(page), page, page === current));
  }
  const more = last > current;
  links.push(link(more ? url(current + 1) : null, "Next &raquo;", more ? current + 1 : null, false));
  return obj({
    current_page: current,
    data: items,
    first_page_url: url(1),
    from,
    last_page: last,
    last_page_url: url(last),
    links,
    next_page_url: more ? url(current + 1) : null,
    path,
    per_page: perPage,
    prev_page_url: current > 1 ? url(current - 1) : null,
    to: from === null ? null : from + items.length - 1,
    total,
  });
}

export interface AuditEventsRequest {
  url: URL;
  /** The org's public id (Coolify's team id). */
  teamId: string;
  canReadSensitive: boolean;
  /** The public URL of the request, without its query (the paginator's path). */
  path: string;
}

/** index(), the admin check already passed: the validator, then the page of the team's events (`rows`: newest first). */
export function auditEventsPage(req: AuditEventsRequest, rows: readonly TeamAuditRow[]): CoolifyAnswer {
  const all = queryInput(req.url);
  const errors = auditEventsErrors(all);
  if (errors.length) return coolifyJson(obj({ message: "Validation failed.", errors: obj(errors) }), 422);
  const perPage = all.per_page !== undefined ? Number(all.per_page) : DEFAULT_PER_PAGE;
  const page = all.page !== undefined ? Number(all.page) : 1;
  const search = typeof all.search === "string" ? all.search.trim() : "";
  const action = typeof all.action === "string" ? all.action : "all";
  const source = typeof all.source === "string" ? all.source : "all";
  const mapped = rows.map((r) => ({ row: r, ...auditRow(r, req.teamId, req.canReadSensitive) }));
  // latestFirst(): created_at, then id, both descending.
  mapped.sort((a, b) => b.row.occurredAt.getTime() - a.row.occurredAt.getTime() || (a.row.id < b.row.id ? 1 : a.row.id > b.row.id ? -1 : 0));
  const visible = mapped.filter((m) => {
    if (action !== "all" && m.action !== action) return false;
    if (source !== "all" && m.source !== source) return false;
    if (search === "") return true;
    const fields = req.canReadSensitive ? [...m.searchable, m.email] : m.searchable;
    return fields.some((f) => f !== null && f.includes(search));
  });
  const items = visible.slice((page - 1) * perPage, page * perPage).map((m) => obj(m.fields));
  return coolifyJson(paginator(items, visible.length, perPage, page, req.path));
}
