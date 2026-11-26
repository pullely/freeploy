// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/application/domains.blade.php,
// resources/views/livewire/project/application/partials/domain-row.blade.php,
// resources/views/livewire/project/shared/cloudflare-autoconfigure.blade.php (the DNS menu),
// resources/views/components/{domain-conflict-modal,forms/domain-input,table/row-actions,table/row-action}.blade.php
// and app/Livewire/Project/Application/Domains.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/domains
// (project.application.domains), for an application that is not a Docker
// Compose one: the domains with their redirects, internal port, search
// indexing and DNS status; adding, generating, editing and removing a domain;
// the Redirects section. Not here: Coolify's managed DNS (Cloudflare Domain
// Connect, DNS providers, the manual records dialog), the favicons, and the
// DNS check itself — the API stores a check as not started and says so.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Layout } from "../layout/Layout";
import { notify, toast } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Callout, DangerCallout, Empty, Listbox, ModalConfirmation, ModalInput, SettingsSection, StatusBadge } from "../components/Coolify";
import { TableDropdown } from "../components/CoolifyList";
import { applicationPath, ApplicationWorkspace, type ApplicationInfo } from "./ApplicationChrome";
import { useApplicationSection, yesNo, type ApplicationSectionData } from "./ApplicationSection";

export interface DomainParts {
  scheme: string;
  host: string;
  port: string;
  path: string;
}

interface DomainRow {
  url: string;
  publicUrl: string;
  internalPort: number | null;
  hasPortOverride: boolean;
  inheritedPort: number | null;
  dnsStatus: string;
  dnsMessage: string;
  expectedIp: string | null;
  checkedAt: string | null;
  isNoindexed: boolean;
  parts: DomainParts;
}

type Redirect = "both" | "www" | "non-www";

interface Domains {
  rows: DomainRow[];
  redirect: Redirect;
  isForceHttpsEnabled: boolean;
  isPermanentRedirectEnabled: boolean;
  labelsAreWritable: boolean;
  isCompose: boolean;
  dnsValidationEnabled: boolean;
  serverIp: string | null;
  dnsTargetLabel: string | null;
}

interface Data extends ApplicationSectionData {
  domains: Domains;
}

interface Saved {
  application: ApplicationInfo;
  domains: Domains;
  message: string | null;
  notices: string[];
  warning: string | null;
  unavailable: string | null;
}

export interface Conflict {
  domain: string;
  resource_name: string;
  resource_type: string;
}

/** DomainUrlParts::empty() */
export const EMPTY_PARTS: DomainParts = { scheme: "https", host: "", port: "", path: "" };

const PROTOCOL_OPTIONS = [
  { value: "https", label: "https" },
  { value: "http", label: "http" },
];

/** <x-forms.domain-input>: protocol, host, port and path of one domain. */
export function DomainInput(props: { id: string; parts: DomainParts; onChange: (parts: DomainParts) => void; error?: string | undefined; inheritedPort?: number | null }) {
  const { id, parts, onChange } = props;
  const withInherited = props.inheritedPort !== undefined;
  return (
    <div className="grid gap-4 sm:grid-cols-[8rem_minmax(0,1fr)_8rem]">
      <div className="min-w-0">
        <Listbox id={`${id}-protocol`} label="Protocol" options={PROTOCOL_OPTIONS} value={parts.scheme} onChange={(scheme) => onChange({ ...parts, scheme })} />
      </div>

      <div className="min-w-0">
        <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
          <label htmlFor={`${id}-host`} className="mb-0! flex items-center gap-1.5 leading-4">
            Domain <span className="text-helper">*</span>
          </label>
        </div>
        <input id={`${id}-host`} type="text" className="input" value={parts.host} onChange={(e) => onChange({ ...parts, host: e.target.value })} placeholder="app.example.com" autoComplete="off" required />
        {props.error ? <p className="mt-1 text-[12px] text-red-500">{props.error}</p> : null}
      </div>

      <div className="min-w-0">
        <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
          <label htmlFor={`${id}-port`} className="mb-0! flex items-center gap-1.5 leading-4">
            Port
          </label>
        </div>
        <input
          id={`${id}-port`}
          type="number"
          className="input"
          value={parts.port}
          onChange={(e) => onChange({ ...parts, port: e.target.value })}
          placeholder={withInherited ? String(props.inheritedPort ?? "") : "3000"}
          min={1}
          max={65535}
          inputMode="numeric"
        />
      </div>

      {withInherited && !props.inheritedPort && !parts.port ? (
        <div className="min-w-0 sm:col-span-3">
          <DangerCallout title="Port is required" className="">
            The proxy cannot route this domain. Enter the port your container listens on in the Port field.
          </DangerCallout>
        </div>
      ) : null}

      <div className="min-w-0 sm:col-span-3">
        <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
          <label htmlFor={`${id}-path`} className="mb-0! flex items-center gap-1.5 leading-4">
            Path
          </label>
        </div>
        <input id={`${id}-path`} type="text" className="input" value={parts.path} onChange={(e) => onChange({ ...parts, path: e.target.value })} placeholder="/api/v3" autoComplete="off" />
        <p className="mt-1 text-[12px] text-neutral-500 dark:text-fg-dim">Optional path, query, or fragment appended after the domain and port.</p>
      </div>
    </div>
  );
}

/** The dialog shell of <x-domain-conflict-modal> and of the port warning (also a service's Domains page, DP-102). */
export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-99 flex min-h-full items-center justify-center overflow-y-auto p-4">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" />
      <div
        className="application-settings-form application-settings-section relative w-full lg:min-w-[36rem] lg:max-w-2xl"
        style={{ boxShadow: "0 0 0 1px var(--coollabs-hairline), var(--shadow-modal)" }}
      >
        <header>
          <h3>{title}</h3>
          <button type="button" onClick={onClose} className="icon-button" aria-label="Close">
            <Reicon name="x" className="size-4" />
          </button>
        </header>
        <div className="application-settings-section-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export const DNS_TYPE: Record<string, "success" | "error" | "warning"> = { ok: "success", failed: "error", skipped: "warning" };
export const DNS_LABEL: Record<string, string> = { ok: "DNS matches", failed: "DNS mismatch", skipped: "DNS skipped", checking: "Checking DNS...", pending: "Not checked" };
const DIRECTION: Record<Redirect, string> = { www: "non-www → www", "non-www": "www → non-www", both: "Disabled" };

interface Editing {
  url: string;
  parts: DomainParts;
  indexing: "index" | "noindex";
  redirect: Redirect;
  inheritedPort: number | null;
  /** editingGeneratedHost: set by "Regenerate hostname". */
  generatedHost: string | null;
}

function ApplicationDomainsContent() {
  const { me, data, setData, saving, patch } = useApplicationSection<Data>("domains");
  const [search, setSearch] = useState("");
  const [dnsMenu, setDnsMenu] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newParts, setNewParts] = useState<DomainParts>(EMPTY_PARTS);
  const [addError, setAddError] = useState<string | undefined>();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [editError, setEditError] = useState<string | undefined>();
  const [conflict, setConflict] = useState<{ conflicts: Conflict[]; retry: () => void } | null>(null);
  const [portWarning, setPortWarning] = useState<{ port: number; retry: () => void } | null>(null);
  if (!data) return null;
  const { application, canUpdate, domains } = data;
  const hasRows = domains.rows.length > 0;
  const hasHttpsDomains = domains.rows.some((row) => row.url.toLowerCase().startsWith("https://"));
  const general = applicationPath(application.project.uuid, application.environment.uuid, application.uuid);
  const matches = (value: string) => !search.trim() || value.toLowerCase().includes(search.trim().toLowerCase());

  /**
   * One action of the component. A domain conflict or an unknown port opens
   * its dialog, whose confirmation repeats the action with the force flag; a
   * field error goes under its field; anything else is a toast.
   */
  async function run(body: Record<string, unknown>, onField?: (message: string) => void): Promise<boolean> {
    const r = await patch<Saved>(body);
    if (!r.ok) {
      const { details, fields } = r.error;
      if (r.error.status === 409 && Array.isArray(details.conflicts)) setConflict({ conflicts: details.conflicts as Conflict[], retry: () => void run({ ...body, forceSaveDomains: true }, onField) });
      else if (r.error.status === 409 && typeof details.unrecognizedPort === "number") setPortWarning({ port: details.unrecognizedPort, retry: () => void run({ ...body, forceUseUnknownPort: true }, onField) });
      else {
        const first = Object.values(fields).flat()[0];
        if (first && onField && (fields.newDomain || fields.editingDomain)) onField(first);
        else notify.error(first ?? r.error.message);
      }
      return false;
    }
    setData({ ...data!, application: r.data.application, domains: r.data.domains });
    if (r.data.warning) toast(r.data.warning, { type: "warning" });
    if (r.data.message) notify.success(r.data.message);
    for (const notice of r.data.notices) notify.success(notice);
    if (r.data.unavailable) notify.error(r.data.unavailable);
    // Each action closes its dialog (dispatch('close-modal'), 'edit-domain-saved').
    if (body.action === "add" || body.action === "generate") {
      setAdding(false);
      setNewParts(EMPTY_PARTS);
      setAddError(undefined);
    }
    if (body.action === "update") {
      setEditing(null);
      setEditError(undefined);
    }
    return true;
  }

  const addDomain = () => {
    setAddError(undefined);
    void run({ action: "add", newDomainParts: newParts }, setAddError);
  };
  const updateDomain = () => {
    if (!editing) return;
    setEditError(undefined);
    void run({ action: "update", url: editing.url, editingDomainParts: editing.parts, editingIndexing: editing.indexing, editingRedirect: editing.redirect, generatedHost: editing.generatedHost }, setEditError);
  };
  /** regenerateEditingDomain(): a new generated hostname, keeping a www prefix. */
  const regenerate = async () => {
    if (!editing) return;
    const r = await patch<{ host: string }>({ action: "regenerateHostname" });
    if (!r.ok) return notify.error(r.error.message);
    const host = editing.parts.host.toLowerCase().startsWith("www.") ? `www.${r.data.host}` : r.data.host;
    setEditing({ ...editing, parts: { ...editing.parts, host }, generatedHost: r.data.host });
    setEditError(undefined);
  };
  const onSubmit = (submit: () => void) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit();
  };

  /** partials/domain-row.blade.php */
  const rowView = (row: DomainRow) => {
    const https = row.url.startsWith("https://") && domains.isForceHttpsEnabled;
    const direction = domains.redirect;
    const indexing = row.isNoindexed ? "Search indexing blocked" : "Search indexing allowed";
    return (
      <div key={row.url} className="env-table-item" style={matches(` ${row.url}`) ? undefined : { display: "none" }}>
        <div className="data-table-row service-domains-overview-grid">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <a
                href={row.publicUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 flex-1 truncate text-[13px] text-black underline decoration-neutral-300 underline-offset-2 hover:decoration-coollabs dark:text-fg dark:decoration-white/20 dark:hover:decoration-brand-light"
                title={row.publicUrl}
              >
                {row.publicUrl}
              </a>
            </div>
          </div>

          <div className="service-domain-detail" title="Protocol redirect">
            <span className="service-domain-detail-label">Protocol redirect</span>
            <span>{https ? "HTTP → HTTPS" : "Disabled"}</span>
          </div>
          <div className="service-domain-detail" title="Domain redirect">
            <span className="service-domain-detail-label">Domain redirect</span>
            <span>{DIRECTION[direction]}</span>
          </div>
          <div className="service-domain-detail" title={row.hasPortOverride ? "Custom internal port for this domain" : "Inherited from the application or Compose service port"}>
            <span className="service-domain-detail-label">Internal port</span>
            {row.internalPort !== null ? (
              <span aria-label={`Internal port ${row.internalPort}`}>{row.internalPort}</span>
            ) : (
              <span role="img" aria-label="No internal port" title="No internal port. Set Ports Exposes or a per-domain internal port so the proxy can route this domain." className="text-red-500 dark:text-red-400">
                <Reicon name="alert-triangle" className="size-4" />
              </span>
            )}
          </div>
          <div className="service-domain-detail">
            <span className="service-domain-detail-label">Search indexing</span>
            <span role="img" aria-label={indexing} title={indexing}>
              <Reicon name={row.isNoindexed ? "x" : "check"} className="size-4" />
            </span>
          </div>

          <div className="service-domain-mobile-summary" aria-label="Domain routing summary">
            {https ? <span>HTTP → HTTPS</span> : null}
            {direction !== "both" ? <span>{DIRECTION[direction]}</span> : !https ? <span>No redirects</span> : null}
            <span>Port {row.internalPort ?? "missing"}</span>
            <span>{row.isNoindexed ? "Noindex" : "Indexable"}</span>
          </div>

          <div className="service-domain-dns flex min-w-0 items-center">
            <StatusBadge label={DNS_LABEL[row.dnsStatus] ?? "DNS unknown"} type={DNS_TYPE[row.dnsStatus] ?? "neutral"} title={row.dnsStatus === "ok" ? null : row.dnsMessage} />
          </div>

          <div className="service-domain-actions flex items-center justify-end gap-1">
            {canUpdate ? (
              domains.labelsAreWritable ? (
                <button type="button" onClick={() => void run({ action: "checkDns", url: row.url })} disabled={saving} className="icon-button shrink-0" title="Check DNS" aria-label="Check DNS">
                  <Reicon name="refresh" className="size-3.5" />
                </button>
              ) : (
                <TableDropdown
                  panelClass="w-44!"
                  trigger={(open) => (
                    <button type="button" className="icon-button" title="Domain actions" aria-label="Domain actions" aria-haspopup="menu" aria-expanded={open}>
                      <Reicon name="dots-horizontal" className="size-4" />
                    </button>
                  )}
                >
                  {(close) => (
                    <div className="contents">
                      <button
                        type="button"
                        role="menuitem"
                        className="listbox-option justify-start!"
                        disabled={saving}
                        onClick={() => {
                          close();
                          void run({ action: "checkDns", url: row.url });
                        }}
                      >
                        Check DNS
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        className="listbox-option justify-start!"
                        aria-label={`Edit ${row.publicUrl}`}
                        onClick={() => {
                          close();
                          setEditError(undefined);
                          setEditing({ url: row.url, parts: row.parts, indexing: row.isNoindexed ? "noindex" : "index", redirect: domains.redirect, inheritedPort: row.inheritedPort, generatedHost: null });
                        }}
                      >
                        Edit
                      </button>
                      <div className="my-1 border-t border-neutral-200 dark:border-white/[0.08]" />
                      <div className="row-actions-danger contents" onClick={close}>
                        <ModalConfirmation
                          title="Remove domain?"
                          trigger={
                            <button type="button" role="menuitem" className="listbox-option justify-start!">
                              Delete
                            </button>
                          }
                          actions={["This domain will be removed from the application.", "Redeploy or restart may be required for proxy changes."]}
                          confirmationText={null}
                          step2ButtonText="Remove domain"
                          onSubmit={async () => {
                            await run({ action: "remove", url: row.url });
                          }}
                        />
                      </div>
                    </div>
                  )}
                </TableDropdown>
              )
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const noSearchResults = search.trim() !== "" && !domains.rows.some((row) => matches(` ${row.url}`));

  return (
    <ApplicationWorkspace application={application} orgId={me.team?.id} active="Domains" canUpdate={canUpdate} canDeploy={data.canDeploy}>
      <div id="application-domains-section" className="domains-overview-container flex flex-col gap-4">
        {domains.labelsAreWritable ? (
          <Callout type="warning" title="Domains managed via labels" className="mb-4">
            Container label readonly mode is disabled. Domains must be set in the Labels section on the General page.
            <a className="mt-2 block font-medium underline" href={`${general}#container-labels-section`}>
              Go to Container labels
            </a>
          </Callout>
        ) : null}

        {canUpdate ? null : (
          <DangerCallout title="Insufficient permissions" className="">
            You don&apos;t have permission to manage domains. Contact your team administrator for access.
          </DangerCallout>
        )}

        <SettingsSection
          id="domains-section"
          title="Domains"
          flush={hasRows}
          className="scroll-mt-28"
          actions={
            <>
              {hasRows ? (
                <div className="relative w-full sm:w-64">
                  <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search services or domains"
                    className="input h-8! w-full pl-8! text-[13px]!"
                    placeholder="Search services or domains"
                  />
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                {canUpdate ? (
                  <>
                    {hasRows ? (
                      <div className="relative shrink-0">
                        <div className="relative">
                          <button type="button" className="button" onClick={() => setDnsMenu(!dnsMenu)} aria-haspopup="menu" aria-expanded={dnsMenu} title="DNS checks and records for this server">
                            <Reicon name="globe" className="size-3.5" />
                            DNS
                            <span className={`inline-flex transition-transform${dnsMenu ? " rotate-180" : ""}`}>
                              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="size-3.5 shrink-0 opacity-60">
                                <path strokeLinecap="round" strokeLinejoin="round" d="m8 9 4-4 4 4m0 6-4 4-4-4" />
                              </svg>
                            </span>
                          </button>
                          <div role="menu" className="listbox-panel left-auto! right-0! z-[90]! w-56! min-w-56!" style={dnsMenu ? undefined : { display: "none" }}>
                            <button
                              type="button"
                              className="listbox-option justify-start! gap-2.5!"
                              role="menuitem"
                              disabled={saving}
                              onClick={() => {
                                setDnsMenu(false);
                                void run({ action: "checkDns" });
                              }}
                            >
                              <Reicon name="refresh" className="size-3.5 shrink-0 opacity-70" />
                              Check all DNS
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                    {domains.labelsAreWritable ? null : (
                      <ModalInput
                        title="Add domain"
                        open={adding}
                        onOpenChange={(open) => {
                          setAdding(open);
                          if (!open) setAddError(undefined);
                        }}
                        trigger={
                          <button type="button" className="button button-highlighted">
                            <Reicon name="plus" className="size-3.5" />
                            Add domain
                          </button>
                        }
                      >
                        <form onSubmit={onSubmit(addDomain)} className="application-settings-form flex flex-col gap-4">
                          <DomainInput id="newDomainParts" parts={newParts} onChange={setNewParts} error={addError} />
                          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                            <Button onClick={() => void run({ action: "generate" })}>Generate domain</Button>
                            <div className="flex flex-wrap gap-2">
                              <Button type="submit" highlighted>
                                Save
                              </Button>
                            </div>
                          </div>
                        </form>
                      </ModalInput>
                    )}
                  </>
                ) : null}
              </div>
            </>
          }
        >
          {hasRows ? (
            <>
              <div className="data-table-header service-domains-overview-grid">
                <span>Domain</span>
                <span>Protocol redirect</span>
                <span>Domain redirect</span>
                <span>Internal port</span>
                <span>Search indexing</span>
                <span>DNS status</span>
                <span className="text-right">Actions</span>
              </div>
              <div className="data-table w-full">{domains.rows.map(rowView)}</div>
              {noSearchResults ? (
                <div className="px-4 py-8">
                  <Empty size="sm" title="No domains found" description="No domain matches your search." iconName="search" />
                </div>
              ) : null}
            </>
          ) : (
            <Empty
              size="sm"
              title="No domains configured"
              description="Add your first domain with the Add domain button above, or generate one with the server wildcard domain."
              iconName="globe"
            />
          )}
        </SettingsSection>

        {hasRows && !domains.labelsAreWritable ? (
          <SettingsSection id="domain-redirects-section" title="Redirects" helper="Applies to all domains of this application.">
            <div className="grid gap-4 lg:grid-cols-2">
              {hasHttpsDomains ? (
                <Listbox
                  id="isForceHttpsEnabled"
                  label="Redirect HTTP to HTTPS"
                  helper="Disable only when Cloudflare Tunnel or another proxy connects to Freeploy over HTTP. Keep enabled when Cloudflare uses Full or Full (Strict) SSL."
                  options={[
                    { value: "true", label: "Enabled" },
                    { value: "false", label: "Disabled" },
                  ]}
                  value={yesNo(domains.isForceHttpsEnabled)}
                  onChange={(v) => void run({ action: "forceHttps", isForceHttpsEnabled: v === "true" })}
                  disabled={!canUpdate}
                />
              ) : null}
              <Listbox
                id="isPermanentRedirectEnabled"
                label="Redirect type"
                helper="Applies to the HTTP to HTTPS and www redirects. Permanent (301/308) is better for SEO, but browsers cache it. Use Temporary (302/307) while you test a redirect."
                options={[
                  { value: "false", label: "Temporary" },
                  { value: "true", label: "Permanent" },
                ]}
                value={yesNo(domains.isPermanentRedirectEnabled)}
                onChange={(v) => void run({ action: "permanentRedirect", isPermanentRedirectEnabled: v === "true" })}
                disabled={!canUpdate}
              />
            </div>
          </SettingsSection>
        ) : null}

        {/* One dialog for address edits and automatically saved domain settings. */}
        <ModalInput
          title="Domain settings"
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) {
              setEditing(null);
              setEditError(undefined);
            }
          }}
        >
          {editing ? (
            <form onSubmit={onSubmit(updateDomain)} className="flex min-h-0 flex-1 flex-col">
              <div data-testid="domain-settings-scroll" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain pb-4">
                <DomainInput id="editingDomainParts" parts={editing.parts} onChange={(parts) => setEditing({ ...editing, parts })} error={editError} inheritedPort={editing.inheritedPort} />
                {domains.labelsAreWritable || !canUpdate ? null : (
                  <div className="grid grid-cols-1 gap-4 border-t border-neutral-200 pt-4 sm:grid-cols-2 dark:border-white/10">
                    <Listbox
                      id="application-domain-indexing"
                      label="Search engine indexing"
                      options={[
                        { value: "index", label: "Indexable" },
                        { value: "noindex", label: "Noindex" },
                      ]}
                      value={editing.indexing}
                      onChange={(indexing) => setEditing({ ...editing, indexing: indexing as Editing["indexing"] })}
                    />
                    <Listbox
                      id="application-domain-direction"
                      label="www redirect"
                      helper="Applies to all domains for this application."
                      options={[
                        { value: "both", label: "No redirect" },
                        { value: "www", label: "Redirect to www" },
                        { value: "non-www", label: "Redirect to non-www" },
                      ]}
                      value={editing.redirect}
                      onChange={(redirect) => setEditing({ ...editing, redirect: redirect as Redirect })}
                    />
                  </div>
                )}
              </div>

              <div data-testid="domain-settings-footer" className="shrink-0 border-t border-neutral-200 pt-4 dark:border-white/10">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button onClick={() => void regenerate()}>Regenerate hostname</Button>
                  <Button type="submit" highlighted>
                    Save
                  </Button>
                </div>
              </div>
            </form>
          ) : null}
        </ModalInput>

        {conflict ? (
          <Dialog title="Domain already in use" onClose={() => setConflict(null)}>
            <DangerCallout title="Domain conflict detected">
              The following domain(s) are already in use by other resources. Using the same domain for multiple resources can cause routing conflicts and unpredictable behavior.
            </DangerCallout>

            <div className="mb-4">
              <ul className="space-y-2">
                {conflict.conflicts.map((c) => (
                  <li key={`${c.domain}|${c.resource_name}`} className="flex items-start text-[12px] leading-5 text-red-600 dark:text-red-400">
                    <div>
                      <strong>{c.domain}</strong> is used by <strong>{c.resource_name}</strong> ({c.resource_type})
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            <Callout type="warning" title="What will happen if you continue?" className="mb-4">
              <ul className="mt-2 ml-4 list-disc">
                <li>Only one resource will be accessible at this domain</li>
                <li>The routing behavior will be unpredictable</li>
                <li>You may experience service disruptions</li>
                <li>SSL certificates might not work correctly</li>
              </ul>
            </Callout>

            <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
              <Button onClick={() => setConflict(null)}>Cancel</Button>
              <Button
                error
                onClick={() => {
                  const { retry } = conflict;
                  setConflict(null);
                  retry();
                }}
              >
                Proceed anyway
              </Button>
            </div>
          </Dialog>
        ) : null}

        {portWarning ? (
          <Dialog title="Use a different port?" onClose={() => setPortWarning(null)}>
            <Callout type="warning" title="Unrecognized internal port" className="mb-4">
              Port <strong>{portWarning.port}</strong> is not listed in Ports Exposes and is not used by any application domain. The proxy will still route to it, but the container may not be listening
              there.
            </Callout>

            <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
              <Button onClick={() => setPortWarning(null)}>Cancel</Button>
              <Button
                error
                onClick={() => {
                  const { retry } = portWarning;
                  setPortWarning(null);
                  retry();
                }}
              >
                Use this port anyway
              </Button>
            </div>
          </Dialog>
        ) : null}
      </div>
    </ApplicationWorkspace>
  );
}

export function ApplicationDomainsPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ApplicationDomainsContent />
    </Layout>
  );
}
