// Derived from coollabsio/coolify@91b7e3e:app/Livewire/SelectTeam.php, app/Models/User.php (resolveStoredTeam),
// resources/views/livewire/select-team.blade.php, resources/views/livewire/project/shared/maintenance.blade.php,
// app/Livewire/Project/Application/Swarm.php and resources/views/livewire/project/service/{domains,
// partials/domain-table}.blade.php (Apache-2.0), modified.
//
// The decisions of DP-102's pages, without the DOM: /select-team on Freeploy's org switching (the org a user last
// worked in, users.last_org_slug, which the console's frame reads), the Maintenance Mode confirmation's copy, the
// Swarm form, and the service Domains page's groups and search.

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
}

/**
 * SelectTeam::mount(). Coolify's current team is the session's; Freeploy's is the org the user last worked in
 * (lastOrgSlug), when it is one of theirs. With one, or with at most one org, there is nothing to pick: the stored
 * team (resolveStoredTeam(): the last one, else the only one) becomes current — `store`, when it is not already —
 * and the page goes to the dashboard.
 */
export function selectTeamMount(orgs: readonly OrgSummary[], lastOrgSlug: string | null | undefined): { action: "redirect"; store: string | null } | { action: "show" } {
  const current = orgs.find((o) => o.slug === lastOrgSlug) ?? null;
  if (current === null && orgs.length > 1) return { action: "show" };
  const resolved = current ?? (orgs.length === 1 ? orgs[0]! : null);
  return { action: "redirect", store: resolved !== null && resolved.slug !== lastOrgSlug ? resolved.slug : null };
}

/** SelectTeam::selectTeam(): only one of the user's own teams; null for any other (nothing happens). */
export function selectTeam(orgs: readonly OrgSummary[], slug: string): string | null {
  return orgs.some((o) => o.slug === slug) ? slug : null;
}

/** strtoupper(mb_substr($team->name, 0, 1)) */
export const teamInitial = (name: string): string => ([...name][0] ?? "").toUpperCase();

// ---------------------------------------------------------------- Maintenance

/** The header button's <x-modal-confirmation> of maintenance.blade.php. */
export function maintenanceConfirmation(enabled: boolean): { title: string; buttonTitle: string; step2ButtonText: string; isErrorButton: boolean; warningMessage: string; actions: string[] } {
  return enabled
    ? {
        title: "Disable maintenance mode?",
        buttonTitle: "Disable maintenance",
        step2ButtonText: "Disable maintenance",
        isErrorButton: false,
        warningMessage: "Visitors can reach this resource again right away.",
        actions: ["All domains of this resource serve the resource again."],
      }
    : {
        title: "Enable maintenance mode?",
        buttonTitle: "Enable maintenance",
        step2ButtonText: "Enable maintenance",
        isErrorButton: true,
        warningMessage: "Visitors cannot reach this resource until you disable maintenance mode.",
        actions: ["All domains of this resource show the maintenance page with a 503 status.", "The containers keep running."],
      };
}

// ---------------------------------------------------------------- Swarm

export interface SwarmSettings {
  swarmReplicas: number;
  swarmPlacementConstraints: string | null;
  isSwarmOnlyWorkerNodes: boolean;
}

/** The form's fields (wire:model), as typed. */
export interface SwarmForm {
  swarmReplicas: string;
  swarmPlacementConstraints: string;
  isSwarmOnlyWorkerNodes: boolean;
}

export const swarmFormOf = (s: SwarmSettings): SwarmForm => ({ swarmReplicas: String(s.swarmReplicas), swarmPlacementConstraints: s.swarmPlacementConstraints ?? "", isSwarmOnlyWorkerNodes: s.isSwarmOnlyWorkerNodes });

/** <x-unsaved-bar action="submit">: the replicas or the constraints differ from what was loaded (the listbox saves itself). */
export const swarmDirty = (form: SwarmForm, saved: SwarmSettings): boolean => form.swarmReplicas !== String(saved.swarmReplicas) || form.swarmPlacementConstraints !== (saved.swarmPlacementConstraints ?? "");

// ---------------------------------------------------------------- a service's Domains

export interface DomainParts {
  scheme: string;
  host: string;
  port: string;
  path: string;
}

export type Redirect = "both" | "www" | "non-www";

export interface ServiceDomainApp {
  uuid: string;
  name: string;
  heading: string;
  image: string | null;
  requiredPort: number | null;
  redirect: Redirect;
  isForceHttpsEnabled: boolean;
  isPermanentRedirectEnabled: boolean;
}

export interface ServiceDomainRow {
  serviceApplicationUuid: string;
  serviceName: string;
  url: string;
  publicUrl: string;
  internalPort: number | null;
  hasPortOverride: boolean;
  dnsStatus: string;
  dnsMessage: string;
  expectedIp: string | null;
  checkedAt: string | null;
  isNoindexed: boolean;
  parts: DomainParts;
}

export interface DomainGroup {
  app: ServiceDomainApp;
  rows: ServiceDomainRow[];
  /** A domain of the group is https: the "Redirect HTTP to HTTPS" listbox shows. */
  hasHttpsDomains: boolean;
  /** $heading.' '.$rows->pluck('url')->implode(' '): what the search matches. */
  searchValue: string;
}

/** $domainGroups: the rows grouped by application in the rows' order (groupBy keeps first appearance). */
export function domainGroups(rows: readonly ServiceDomainRow[], apps: readonly ServiceDomainApp[]): DomainGroup[] {
  const groups: DomainGroup[] = [];
  for (const row of rows) {
    let group = groups.find((g) => g.app.uuid === row.serviceApplicationUuid);
    if (!group) {
      const app = apps.find((a) => a.uuid === row.serviceApplicationUuid);
      if (!app) continue;
      group = { app, rows: [], hasHttpsDomains: false, searchValue: "" };
      groups.push(group);
    }
    group.rows.push(row);
  }
  for (const group of groups) {
    group.hasHttpsDomains = group.rows.some((r) => r.url.toLowerCase().startsWith("https://"));
    group.searchValue = `${group.app.heading} ${group.rows.map((r) => r.url).join(" ")}`;
  }
  return groups;
}

/** matchesDomainSearch(): a case-insensitive substring of the trimmed search. */
export const matchesDomainSearch = (value: string, search: string): boolean => !search.trim() || value.toLowerCase().includes(search.trim().toLowerCase());

/** The "Domain redirect" cell of domain-table.blade.php. */
export const DOMAIN_REDIRECT_LABEL: Record<Redirect, string> = { www: "non-www → www", "non-www": "www → non-www", both: "Disabled" };
/** $directionLabel: the cell's title. */
export const DIRECTION_TITLE: Record<Redirect, string> = { www: "Redirect to www", "non-www": "Redirect to non-www", both: "Both www and non-www" };

/** The Service application listbox's options of the add dialog: the name, with the image in brackets. */
export const serviceApplicationOptions = (apps: readonly ServiceDomainApp[]): Array<{ value: string; label: string }> => apps.map((a) => ({ value: a.uuid, label: a.image ? `${a.name} (${a.image})` : a.name }));
