// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Team/AuditLog.php, app/Models/AuditEvent.php
// (scopeFiltered, scopeLatestFirst, attributesFor), resources/views/livewire/team/audit-log.blade.php and
// laravel/framework's Str::headline (Apache-2.0 / MIT), modified.
//
// The team's audit log (DP-75) over the audit entries Freeploy records. Coolify's rows have an event name
// (`<source>.<resource>.<action>`), a source (ui, api, mcp, webhook), an action, an actor and a
// description; Freeploy's have an event type, an actor type and its own description. Where a Freeploy event
// is one Coolify records, it is shown as Coolify shows it (TEAM_EVENTS, held to Coolify's own rows in
// tests/events-worker/fixtures/audit-log/goldens.json); every other Freeploy event is shown under its own
// name and description, with its action the last part of its name.
//
// Source: Freeploy does not record where a request came from. An API key's service principal is Coolify's
// API token (`api`); a user is the web UI (`ui`), so a user's own /api/v1 token reads as `ui`; Freeploy's
// workflows and system are `system`, which Coolify's source filter does not list either.
import type { TeamAuditRow } from "@saas/db/events";

/** The source listbox, word for word. */
export const SOURCE_OPTIONS = [
  { value: "all", label: "All sources" },
  { value: "ui", label: "Web UI" },
  { value: "api", label: "API" },
  { value: "mcp", label: "MCP" },
  { value: "webhook", label: "Webhook" },
] as const;

/** AuditLog::SORT_COLUMNS: sort value prefix => column. */
const SORT_COLUMNS = { time: "createdAt", actor: "actorName", activity: "description", source: "source" } as const;

export const DEFAULT_PER_PAGE = 25;

/** Laravel's Str::title (mb_convert_case MB_CASE_TITLE): each word's first letter up, the rest down. */
function title(value: string): string {
  return value.toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_m, before: string, letter: string) => before + letter.toUpperCase());
}

/** Laravel's Str::ucsplit: split before each upper-case letter. */
function ucsplit(value: string): string[] {
  return value.split(/(?=\p{Lu})/u).filter((s) => s !== "");
}

/** Laravel's Str::headline: "role_updated" → "Role Updated", "api_token" → "Api Token". */
export function headline(value: string): string {
  const parts = value.split(" ");
  const titled = (parts.length > 1 ? parts : ucsplit(parts.join("_"))).map(title);
  return titled
    .join("_")
    .replace(/[-_ ]/g, "_")
    .split("_")
    .filter((s) => s !== "")
    .join(" ");
}

/**
 * The Freeploy events Coolify records as well: Coolify's resource and action (its event is
 * `<source>.<resource>.<action>`), and the name Coolify's description starts with (AuditEvent::attributesFor:
 * the `<resource>_name` of the context, else the first `*_name`).
 */
export const TEAM_EVENTS: Record<string, { resource: string; action: string; name: (row: TeamAuditRow) => string | null }> = {
  // The Auditable trait on Team: the team's name.
  "organization.created": { resource: "team", action: "created", name: (r) => str(r.payload.name) ?? r.subjectName },
  "organization.updated": { resource: "team", action: "updated", name: (r) => str(r.payload.name) ?? r.subjectName },
  "organization.deleted": { resource: "team", action: "deleted", name: (r) => str(r.payload.name) ?? r.subjectName },
  // Team\Member: member_name.
  "membership.updated": { resource: "team_member", action: "role_updated", name: (r) => r.memberName ?? r.memberEmail },
  "membership.removed": { resource: "team_member", action: "removed", name: (r) => r.memberName ?? r.memberEmail },
  // Team\InviteLink and Team\Invitations: no name; Controller::acceptInvitation: the accepting user's name.
  "invite.created": { resource: "team_invitation", action: "created", name: () => null },
  "invite.revoked": { resource: "team_invitation", action: "revoked", name: () => null },
  "invite.accepted": { resource: "team_invitation", action: "accepted", name: (r) => r.actorName ?? r.actorEmail },
};

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Coolify's actor_type for Freeploy's: a service principal acts through an API key. */
function actorType(freeploy: string): string {
  if (freeploy === "user") return "user";
  if (freeploy === "service_principal") return "api_token";
  return "system";
}

function sourceOf(freeploy: string): string {
  if (freeploy === "user") return "ui";
  if (freeploy === "service_principal") return "api";
  return "system";
}

/** One row as audit-log.blade.php shows it. */
export interface TeamAuditEvent {
  id: string;
  event: string;
  source: string;
  action: string;
  actorType: string;
  actorName: string | null;
  actorEmail: string | null;
  actorTokenName: string | null;
  description: string;
  /** Freeploy records no field changes: "View changes" is never shown. */
  changes: null;
  createdAt: string;
  /** Whether the row is one Coolify records too (else Freeploy's own event and wording). */
  coolify: boolean;
}

export function toTeamAuditEvent(row: TeamAuditRow): TeamAuditEvent {
  const source = sourceOf(row.actorType);
  const known = TEAM_EVENTS[row.eventType];
  const base = {
    id: row.id,
    source,
    actorType: actorType(row.actorType),
    actorName: row.actorName ?? row.actorEmail,
    actorEmail: row.actorEmail,
    actorTokenName: null,
    changes: null,
    createdAt: row.occurredAt.toISOString(),
  };
  if (known) {
    const name = known.name(row);
    return {
      ...base,
      event: `${source}.${known.resource}.${known.action}`,
      action: known.action,
      // trim(($resourceName ?? Str::headline($resourceType)).' '.Str::headline($action))
      description: `${name ?? headline(known.resource)} ${headline(known.action)}`.trim(),
      coolify: true,
    };
  }
  const parts = row.eventType.split(".");
  return { ...base, event: row.eventType, action: parts[parts.length - 1] || "event", description: row.description, coolify: false };
}

export interface TeamAuditQuery {
  search: string;
  action: string;
  source: string;
  sort: string;
  perPage: number;
  page: number;
}

/** The component's public properties from the query string; an unknown sort is ignored as setSort() ignores it. */
export function parseTeamAuditQuery(url: URL): TeamAuditQuery {
  const sort = url.searchParams.get("sort") ?? "time-desc";
  const [column, direction] = sort.split("-", 2);
  const validSort = column !== undefined && column in SORT_COLUMNS && (direction === "asc" || direction === "desc") && sort === `${column}-${direction}`;
  const perPageRaw = Number(url.searchParams.get("perPage") ?? DEFAULT_PER_PAGE);
  const pageRaw = Number(url.searchParams.get("page") ?? 1);
  return {
    search: (url.searchParams.get("search") ?? "").trim(),
    action: url.searchParams.get("action") || "all",
    source: url.searchParams.get("source") || "all",
    sort: validSort ? sort : "time-desc",
    // updatedPerPage(): max(10, min(100, perPage)).
    perPage: Number.isFinite(perPageRaw) ? Math.max(10, Math.min(100, Math.trunc(perPageRaw))) : DEFAULT_PER_PAGE,
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
  };
}

/** scopeFiltered(): the action, the source, and a search in the event, description, name, actor and actor email (LIKE: case-sensitive). */
function matches(e: TeamAuditEvent, q: TeamAuditQuery): boolean {
  if (q.action !== "all" && e.action !== q.action) return false;
  if (q.source !== "all" && e.source !== q.source) return false;
  if (q.search === "") return true;
  return [e.event, e.description, e.actorName, e.actorEmail].some((v) => v !== null && v.includes(q.search));
}

/** NULLs sort last ascending and first descending, as Postgres does; times by their instant. */
function compare(a: string | null, b: string | null, byTime: boolean): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (byTime) return Date.parse(a) - Date.parse(b);
  return a.localeCompare(b, "en");
}

export interface TeamAuditPage {
  sort: string;
  actionOptions: Array<{ value: string; label: string }>;
  sourceOptions: typeof SOURCE_OPTIONS;
  events: TeamAuditEvent[];
  /** Laravel's LengthAwarePaginator: firstItem/lastItem (0 when empty), total, currentPage, lastPage, perPage. */
  from: number;
  to: number;
  total: number;
  currentPage: number;
  lastPage: number;
  perPage: number;
}

/** AuditLog::render() over the team's visible events (newest first, as read). */
export function teamAuditPage(all: TeamAuditEvent[], q: TeamAuditQuery): TeamAuditPage {
  const actionOptions = [{ value: "all", label: "All actions" }, ...[...new Set(all.map((e) => e.action))].sort().map((a) => ({ value: a, label: headline(a) }))];
  let rows = all.filter((e) => matches(e, q));
  if (q.sort !== "time-desc") {
    const [column, direction] = q.sort.split("-", 2) as [keyof typeof SORT_COLUMNS, "asc" | "desc"];
    const key = SORT_COLUMNS[column];
    const order = direction === "desc" ? -1 : 1;
    // orderBy(column, direction) then latestFirst(): the read order breaks ties.
    rows = rows.map((e, i) => [e, i] as const).sort(([a, i], [b, j]) => order * compare(a[key], b[key], key === "createdAt") || i - j).map(([e]) => e);
  }
  const total = rows.length;
  const lastPage = Math.max(1, Math.ceil(total / q.perPage));
  const start = (q.page - 1) * q.perPage;
  const events = rows.slice(start, start + q.perPage);
  return {
    sort: q.sort,
    actionOptions,
    sourceOptions: SOURCE_OPTIONS,
    events,
    from: events.length ? start + 1 : 0,
    to: events.length ? start + events.length : 0,
    total,
    currentPage: q.page,
    lastPage,
    perPage: q.perPage,
  };
}
