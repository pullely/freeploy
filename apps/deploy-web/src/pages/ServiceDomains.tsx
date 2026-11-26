// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/service/domains.blade.php,
// resources/views/livewire/project/service/partials/domain-table.blade.php, resources/views/livewire/project/shared/
// cloudflare-autoconfigure.blade.php (the DNS menu), resources/views/components/{domain-conflict-modal,forms/domain-input,
// table/row-actions,table/row-action}.blade.php and app/Livewire/Project/Service/Domains.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/service/{service_uuid}/domains (project.service.domains): the domains of the
// service's applications, one group per application with its two redirect switches; adding a domain to an
// application, generating one, editing (address, search indexing, the application's www redirect), removing, and the
// DNS checks. Not here: Coolify's managed DNS (Cloudflare Domain Connect, DNS providers, the manual records dialog and
// the remove dialog's "Also delete the DNS record" checkbox), the favicons, the suggested www rows, and the DNS check
// itself — the API stores a check as not started and says so.
import { useState, type FormEvent } from "react";
import { Layout } from "../layout/Layout";
import { notify, toast } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Callout, DangerCallout, Empty, Helper, Listbox, ModalConfirmation, ModalInput, StatusBadge } from "../components/Coolify";
import { TableDropdown } from "../components/CoolifyList";
import { useResourceSection, yesNo, type ServiceSectionData } from "./ApplicationSection";
import { ResourceWorkspace } from "./ResourceWorkspace";
import { DNS_LABEL, DNS_TYPE, Dialog, DomainInput, EMPTY_PARTS, type Conflict } from "./ApplicationDomains";
import type { ServiceInfo } from "./ServiceChrome";
import {
  DIRECTION_TITLE,
  DOMAIN_REDIRECT_LABEL,
  domainGroups,
  matchesDomainSearch,
  serviceApplicationOptions,
  type DomainParts,
  type Redirect,
  type ServiceDomainApp,
  type ServiceDomainRow,
} from "../lib/config-subpages";

interface Domains {
  apps: ServiceDomainApp[];
  rows: ServiceDomainRow[];
  dnsValidationEnabled: boolean;
  serverIp: string | null;
  dnsTargetLabel: string | null;
}

type Data = ServiceSectionData & { domains: Domains };

interface Saved {
  service: ServiceInfo;
  domains: Domains;
  toasts: Array<{ type: "success" | "warning" | "error"; message: string }>;
}

interface Editing {
  app: ServiceDomainApp;
  url: string;
  parts: DomainParts;
  indexing: "index" | "noindex";
  redirect: Redirect;
  generatedHost: string | null;
}

function ServiceDomainsContent() {
  const { me, data, setData, saving, patch } = useResourceSection<Data>("service", "domains");
  const [search, setSearch] = useState("");
  const [dnsMenu, setDnsMenu] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newApp, setNewApp] = useState<string | null>(null);
  const [newParts, setNewParts] = useState<DomainParts>(EMPTY_PARTS);
  const [addError, setAddError] = useState<string | undefined>();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [editError, setEditError] = useState<string | undefined>();
  const [conflict, setConflict] = useState<{ conflicts: Conflict[]; retry: () => void } | null>(null);
  const [portWarning, setPortWarning] = useState<{ requiredPort: number; requestedPort: number; retry: () => void } | null>(null);
  if (!data) return null;
  const { canUpdate, domains } = data;
  const groups = domainGroups(domains.rows, domains.apps);
  const selectedApp = newApp ?? domains.apps[0]?.uuid ?? null;

  /**
   * One action of the component. A domain conflict or a port the service does not require opens its dialog, whose
   * confirmation repeats the action with the force flag; a field error goes under its field; anything else is a toast.
   */
  async function run(body: Record<string, unknown>, onField?: (message: string) => void): Promise<boolean> {
    const r = await patch<Saved>(body);
    if (!r.ok) {
      const { details, fields } = r.error;
      if (r.error.status === 409 && Array.isArray(details.conflicts)) setConflict({ conflicts: details.conflicts as Conflict[], retry: () => void run({ ...body, forceSaveDomains: true }, onField) });
      else if (r.error.status === 409 && typeof details.requiredPort === "number") {
        setPortWarning({ requiredPort: details.requiredPort, requestedPort: Number(details.requestedPort), retry: () => void run({ ...body, forceRemovePort: true }, onField) });
      } else {
        const first = Object.values(fields).flat()[0];
        if (first && onField && (fields.newDomain || fields.editingDomain)) onField(first);
        else notify.error(first ?? r.error.message);
      }
      return false;
    }
    setData({ ...data!, service: r.data.service, domains: r.data.domains });
    // The messages' <br> tags as line breaks, as a part's settings page shows them.
    for (const t of r.data.toasts) {
      const message = t.message.replace(/<br>/g, "\n");
      if (t.type === "warning") toast(message, { type: "warning" });
      else if (t.type === "error") notify.error(message);
      else notify.success(message);
    }
    // dispatch('close-modal') / 'edit-domain-saved'
    if (body.action === "add") {
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
    void run({ action: "add", serviceApplicationUuid: selectedApp, newDomainParts: newParts }, setAddError);
  };
  /** generateDomain(): fills the dialog, nothing is stored. */
  const generate = async () => {
    const r = await patch<{ domain: string; parts: DomainParts }>({ action: "generate", serviceApplicationUuid: selectedApp });
    if (!r.ok) return notify.error(r.error.message);
    setNewParts(r.data.parts);
    setAddError(undefined);
  };
  const updateDomain = () => {
    if (!editing) return;
    setEditError(undefined);
    void run(
      { action: "update", serviceApplicationUuid: editing.app.uuid, url: editing.url, editingDomainParts: editing.parts, editingIndexing: editing.indexing, editingRedirect: editing.redirect, generatedHost: editing.generatedHost },
      setEditError,
    );
  };
  /** regenerateEditingDomain(): a new generated hostname, keeping a www prefix. */
  const regenerate = async () => {
    if (!editing) return;
    const r = await patch<{ host: string | null }>({ action: "regenerateHostname" });
    if (!r.ok) return notify.error(r.error.message);
    if (!r.data.host) return;
    const host = editing.parts.host.toLowerCase().startsWith("www.") ? `www.${r.data.host}` : r.data.host;
    setEditing({ ...editing, parts: { ...editing.parts, host }, generatedHost: r.data.host });
  };
  const onSubmit = (submit: () => void) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit();
  };

  /** partials/domain-table.blade.php: one row. */
  const rowView = (app: ServiceDomainApp, row: ServiceDomainRow) => {
    const https = row.url.startsWith("https://") && app.isForceHttpsEnabled;
    const direction = app.redirect;
    const indexing = row.isNoindexed ? "Search indexing blocked" : "Search indexing allowed";
    return (
      <div key={`${row.serviceApplicationUuid}|${row.url}`} className="env-table-item">
        <div className="data-table-row service-domains-overview-grid">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
              <a
                href={row.publicUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="min-w-0 flex-1 truncate text-[13px] text-black underline decoration-neutral-300 underline-offset-2 hover:decoration-coollabs [overflow-wrap:anywhere] dark:text-fg dark:decoration-white/20 dark:hover:decoration-brand-light"
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
          <div className="service-domain-detail" title={DIRECTION_TITLE[direction]}>
            <span className="service-domain-detail-label">Domain redirect</span>
            <span>{DOMAIN_REDIRECT_LABEL[direction]}</span>
          </div>
          <div className="service-domain-detail" title={row.hasPortOverride ? "Custom internal port for this domain" : "Inherited from the Freeploy service port"}>
            <span className="service-domain-detail-label">Internal port</span>
            <span {...(row.internalPort !== null ? { "aria-label": `Internal port ${row.internalPort}` } : {})}>{row.internalPort ?? "—"}</span>
          </div>
          <div className="service-domain-detail">
            <span className="service-domain-detail-label">Search indexing</span>
            <span role="img" aria-label={indexing} title={indexing}>
              <Reicon name={row.isNoindexed ? "x" : "check"} className="size-4" />
            </span>
          </div>

          <div className="service-domain-mobile-summary" aria-label="Domain routing summary">
            {https ? <span>HTTP → HTTPS</span> : null}
            {direction !== "both" ? <span>{DOMAIN_REDIRECT_LABEL[direction]}</span> : !https ? <span>No redirects</span> : null}
            <span>Port {row.internalPort ?? "missing"}</span>
            <span>{row.isNoindexed ? "Noindex" : "Indexable"}</span>
          </div>

          <div className="service-domain-dns flex min-w-0 items-center">
            <StatusBadge label={DNS_LABEL[row.dnsStatus] ?? "DNS unknown"} type={DNS_TYPE[row.dnsStatus] ?? "neutral"} title={row.dnsStatus === "ok" ? null : row.dnsMessage} />
          </div>

          <div className="service-domain-actions flex items-center justify-end gap-1">
            {canUpdate ? (
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
                        void run({ action: "checkDns", serviceApplicationUuid: app.uuid, url: row.url });
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
                        setEditing({ app, url: row.url, parts: row.parts, indexing: row.isNoindexed ? "noindex" : "index", redirect: app.redirect, generatedHost: null });
                      }}
                    >
                      Edit
                    </button>
                    <div className="my-1 border-t border-neutral-200 dark:border-white/[0.08]" />
                    <div className="row-actions-danger contents" onClick={close}>
                      <ModalConfirmation
                        title="Remove domain?"
                        buttonTitle="Remove"
                        trigger={
                          <button type="button" role="menuitem" className="listbox-option justify-start!">
                            Delete
                          </button>
                        }
                        actions={["This domain will be removed from the service application.", "Redeploy or restart may be required for proxy changes."]}
                        confirmationText={null}
                        step2ButtonText="Remove domain"
                        onSubmit={async () => {
                          await run({ action: "remove", serviceApplicationUuid: app.uuid, url: row.url });
                        }}
                      />
                    </div>
                  </div>
                )}
              </TableDropdown>
            ) : null}
          </div>
        </div>
      </div>
    );
  };

  const noSearchResults = search.trim() !== "" && !groups.some((g) => matchesDomainSearch(g.searchValue, search));

  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Domains">
      <div id="service-domains-section" className="flex flex-col gap-4">
        {canUpdate ? null : (
          <DangerCallout title="Insufficient permissions" className="">
            You don&apos;t have permission to manage domains. Contact your team administrator for access.
          </DangerCallout>
        )}

        {/* Toolbar */}
        <div id="domains-section" className="flex flex-wrap items-center gap-2">
          {groups.length ? (
            <div className="relative w-full sm:w-64">
              <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search services or domains" className="input h-8! w-full pl-8! text-[13px]!" placeholder="Search services or domains" />
            </div>
          ) : null}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {canUpdate && domains.apps.length > 0 ? (
              <>
                {domains.rows.length > 0 ? (
                  <div className="relative shrink-0">
                    <button type="button" className="button" onClick={() => setDnsMenu(!dnsMenu)} aria-haspopup="menu" aria-expanded={dnsMenu} title="DNS checks and records for this server">
                      <Reicon name="globe" className="size-3.5" />
                      DNS
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
                ) : null}
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
                    <Listbox
                      id="newServiceApplicationId"
                      label="Service application"
                      required
                      helper="Domain will be assigned to this compose service application."
                      options={serviceApplicationOptions(domains.apps)}
                      value={selectedApp}
                      onChange={setNewApp}
                    />
                    <DomainInput id="newDomainParts" parts={newParts} onChange={setNewParts} error={addError} />
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                      <Button onClick={() => void generate()}>Generate domain</Button>
                      <div className="flex flex-wrap gap-2">
                        <Button type="submit" highlighted>
                          Save
                        </Button>
                      </div>
                    </div>
                  </form>
                </ModalInput>
              </>
            ) : null}
          </div>
        </div>

        {domains.apps.length === 0 ? (
          <div className="application-settings-section-body mt-1 w-full scroll-mt-28">
            <Empty size="sm" title="No application services" description="Only database services are available. Domains can only be assigned to application services." iconName="globe" />
          </div>
        ) : domains.rows.length === 0 ? (
          <div className="application-settings-section-body mt-1 w-full scroll-mt-28">
            <Empty size="sm" title="No domains configured" description="Add your first domain with the Add domain button above. Choose which service application receives it." iconName="globe" />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map((group) => (
              <section
                key={group.app.uuid}
                id={`service-domain-group-${group.app.uuid}`}
                className="application-settings-section-body is-flush overflow-visible"
                style={matchesDomainSearch(group.searchValue, search) ? undefined : { display: "none" }}
              >
                <div className="flex w-full flex-wrap items-center gap-3 rounded-t-lg border-b border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-white/10 dark:bg-white/[0.04]">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-black dark:text-white">{group.app.heading}</span>
                  {group.hasHttpsDomains ? (
                    <div className="flex w-full items-center gap-2 sm:w-auto service-domains-https">
                      <label htmlFor={`service-force-https-${group.app.uuid}-trigger`} className="mb-0! whitespace-nowrap text-[12px]!">
                        Redirect HTTP to HTTPS
                      </label>
                      <Helper helper="Disable only when Cloudflare Tunnel or another proxy connects to Freeploy over HTTP. Keep enabled when Cloudflare uses Full or Full (Strict) SSL." />
                      <Listbox
                        id={`service-force-https-${group.app.uuid}`}
                        options={[
                          { value: "true", label: "Enabled" },
                          { value: "false", label: "Disabled" },
                        ]}
                        value={yesNo(group.app.isForceHttpsEnabled)}
                        onChange={(v) => void run({ action: "forceHttps", serviceApplicationUuid: group.app.uuid, enabled: v === "true" })}
                        disabled={!canUpdate}
                      />
                    </div>
                  ) : null}
                  <div className="flex w-full items-center gap-2 sm:w-auto service-domains-https">
                    <label htmlFor={`service-permanent-redirect-${group.app.uuid}-trigger`} className="mb-0! whitespace-nowrap text-[12px]!">
                      Redirect type
                    </label>
                    <Helper helper="Applies to the HTTP to HTTPS and www redirects. Permanent (301/308) is better for SEO, but browsers cache it. Use Temporary (302/307) while you test a redirect." />
                    <Listbox
                      id={`service-permanent-redirect-${group.app.uuid}`}
                      options={[
                        { value: "false", label: "Temporary" },
                        { value: "true", label: "Permanent" },
                      ]}
                      value={yesNo(group.app.isPermanentRedirectEnabled)}
                      onChange={(v) => void run({ action: "permanentRedirect", serviceApplicationUuid: group.app.uuid, enabled: v === "true" })}
                      disabled={!canUpdate}
                    />
                  </div>
                </div>

                <div className="data-table w-full">
                  <div className="data-table-header service-domains-overview-grid">
                    <span>Domain</span>
                    <span>Protocol redirect</span>
                    <span>Domain redirect</span>
                    <span>Internal port</span>
                    <span>Search indexing</span>
                    <span>DNS status</span>
                    <span className="text-right">Actions</span>
                  </div>
                  {group.rows.map((row) => rowView(group.app, row))}
                </div>
              </section>
            ))}
            {noSearchResults ? (
              <div className="px-4 py-8">
                <Empty size="sm" title="No domains found" description="No service or domain matches your search." iconName="search" />
              </div>
            ) : null}
          </div>
        )}

        {/* One dialog for the address and domain settings. */}
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
            <form onSubmit={onSubmit(updateDomain)} className="flex flex-col gap-4">
              <div className="w-full">
                <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
                  <label className="mb-0! flex items-center gap-1 text-sm font-medium leading-4">Service application</label>
                </div>
                <input type="text" className="input" readOnly value={editing.app.heading} />
                <p className="mt-1 text-[12px] text-neutral-500 dark:text-fg-dim">Domains stay on the service they were added to. Remove and re-add to move.</p>
              </div>
              <DomainInput id="editingDomainParts" parts={editing.parts} onChange={(parts) => setEditing({ ...editing, parts })} error={editError} />
              {canUpdate ? (
                <>
                  <div className="mt-4 grid grid-cols-1 gap-4 border-t border-neutral-200 pt-4 sm:grid-cols-2 dark:border-white/10">
                    <Listbox
                      id="service-domain-indexing"
                      label="Search engine indexing"
                      options={[
                        { value: "index", label: "Indexable" },
                        { value: "noindex", label: "Noindex" },
                      ]}
                      value={editing.indexing}
                      onChange={(indexing) => setEditing({ ...editing, indexing: indexing as Editing["indexing"] })}
                    />
                    <Listbox
                      id="service-domain-direction"
                      label="www redirect"
                      helper="Applies to all domains for this service application."
                      options={[
                        { value: "both", label: "No redirect" },
                        { value: "www", label: "Redirect to www" },
                        { value: "non-www", label: "Redirect to non-www" },
                      ]}
                      value={editing.redirect}
                      onChange={(redirect) => setEditing({ ...editing, redirect: redirect as Redirect })}
                    />
                  </div>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 pt-4 dark:border-white/10">
                    <Button onClick={() => void regenerate()}>Regenerate hostname</Button>
                    <Button type="submit" highlighted>
                      Save
                    </Button>
                  </div>
                </>
              ) : null}
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
            <Callout type="warning" title="Port requirement" className="mb-4">
              This service requires port <strong>{portWarning.requiredPort}</strong> to function correctly. One or more of your domains use port <strong>{portWarning.requestedPort}</strong>.
            </Callout>
            <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
              <Button
                error
                onClick={() => {
                  const { retry } = portWarning;
                  setPortWarning(null);
                  retry();
                }}
              >
                Use port {portWarning.requestedPort} anyway
              </Button>
              <Button onClick={() => setPortWarning(null)}>Keep port {portWarning.requiredPort}</Button>
            </div>
          </Dialog>
        ) : null}
      </div>
    </ResourceWorkspace>
  );
}

export function ServiceDomainsPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ServiceDomainsContent />
    </Layout>
  );
}
