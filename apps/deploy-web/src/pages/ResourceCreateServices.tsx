// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/new/select.blade.php (the
// Services section, the category filter), resources/views/livewire/project/resource/create.blade.php
// (the pending resource) and app/Livewire/Project/Resource/Create.php (Apache-2.0), modified.
//
// The one-click services of the New Resource page (ResourceCreate.tsx): the Services section with its
// cards, the category filter beside the search, and what the page shows while a chosen service is being
// created. The list is GET …/deploy/services/templates; creating is POST …/deploy/services, after which
// the browser goes to the service's page.
//
// Not as in Coolify: a card's documentation link is the template's own documentation (Coolify links its
// docs site and falls back to this). A logo is only ever loaded from Freeploy's own origin: Coolify's
// page tries the same file in its GitHub repository when a logo is missing; here a missing logo shows the
// placeholder that chain ends on (svgs/default.webp).
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Callout, Loading } from "../components/Coolify";
import { filterCategories, isOneClickType, ONE_CLICK_PREFIX, servicePath, servicesApi, templateDescription, templateStatus, type ServiceTemplate, type ServiceTemplates } from "../lib/service-templates";

type ViewClasses = Record<"container" | "item" | "logo" | "header" | "description" | "footer" | "action", string>;

/** Select's loadResources() for the services: the catalogue, once per page. */
export function useServiceTemplates(orgId: string | undefined): ServiceTemplates {
  const [templates, setTemplates] = useState<ServiceTemplates>({ services: [], categories: [] });
  useEffect(() => {
    let current = true;
    void (async () => {
      const r = await getJson<ServiceTemplates>(`${servicesApi(orgId)}/templates`);
      if (current && r.data) setTemplates(r.data);
    })();
    return () => {
      current = false;
    };
  }, [orgId]);
  return templates;
}

/** The logo, else the placeholder, else nothing — never from another host. */
function ServiceLogo({ service }: { service: ServiceTemplate }) {
  const sources = useMemo(() => [...new Set([service.logo, service.logo_default_url])], [service]);
  const [index, setIndex] = useState(0);
  const source = sources[index];
  if (source === undefined) return null;
  return <img className="h-full w-full object-contain p-2" src={source} alt="" loading="lazy" onError={() => setIndex(index + 1)} />;
}

const BADGE = "shrink-0 rounded-md border border-amber-300/50 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:border-warning/20 dark:bg-warning/10 dark:text-warning";

function ServiceCard({ service, classes, onSelect }: { service: ServiceTemplate; classes: ViewClasses; onSelect: () => void }) {
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Configure ${service.name}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`group flex cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${classes.item}`}
    >
      <div className={`flex min-w-0 items-start gap-3 ${classes.header}`.trimEnd()}>
        <div className={`flex shrink-0 items-center justify-center overflow-hidden border border-neutral-200 bg-neutral-50 dark:border-white/[0.08] dark:bg-white/[0.04] ${classes.logo}`}>
          <ServiceLogo service={service} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-semibold text-black dark:text-fg">{service.name}</h3>
          <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{templateStatus(service)}</p>
        </div>
        {service.amd_only || service.arm_only ? <span className={BADGE}>{service.arm_only ? "ARM only" : "AMD only"}</span> : null}
        {service.outdated ? (
          <span title="The image of this service has not been updated in the last 2 months" className={`${BADGE} cursor-help`}>
            Outdated
          </span>
        ) : null}
      </div>

      <p className={`text-[12px] leading-5 text-neutral-600 dark:text-fg-dim ${classes.description}`}>{templateDescription(service)}</p>

      <div className={`flex items-center gap-1.5 ${classes.footer}`}>
        <a href={service.documentation} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="icon-button" title="Documentation" aria-label="Documentation">
          <Reicon name="documentation" className="size-4" />
        </a>
        {service.website ? (
          <a href={service.website} target="_blank" rel="noopener noreferrer" className="icon-button" title="Website" aria-label="Website" onClick={(e) => e.stopPropagation()}>
            <Reicon name="globe" className="size-4" />
          </a>
        ) : null}
        <span className={`button ${classes.action}`.trimEnd()}>
          Configure
          <Reicon name="arrow-right" className="size-3.5" />
        </span>
      </div>
    </article>
  );
}

/** Select's Services section: the trademarks notice, then one card per service. */
export function ServicesSection({ services, list, classes, onSelect }: { services: ServiceTemplate[]; list: boolean; classes: ViewClasses; onSelect: (type: string) => void }) {
  return (
    <section className="application-settings-section">
      <div className="application-settings-section-header">
        <div className="flex items-center gap-2">
          <Reicon name="layers" className="size-4 text-neutral-400 dark:text-fg-faint" />
          <h2>Services</h2>
        </div>
      </div>
      <div className={`application-settings-section-body${list ? " is-flush" : ""}`}>
        <div className={list ? "px-4 pt-4" : undefined}>
          <Callout type="info" title="Trademarks policy" className="mb-4">
            The respective trademarks mentioned here are owned by the respective companies, and use of them does not imply any affiliation or endorsement.
          </Callout>
        </div>
        <div className={`text-left ${classes.container}`}>
          {services.map((service) => (
            <ServiceCard key={service.id} service={service} classes={classes} onSelect={() => onSelect(`${ONE_CLICK_PREFIX}${service.id}`)} />
          ))}
        </div>
      </div>
    </section>
  );
}

/** Select's category filter: "All categories", then the service categories, searchable. */
export function CategoryFilter({ categories, selected, onSelect }: { categories: string[]; selected: string; onSelect: (category: string) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  function choose(category: string) {
    onSelect(category);
    setSearch("");
    setOpen(false);
  }
  const option = (category: string, label: ReactNode, capitalize: boolean) => (
    <button key={category} type="button" className={`listbox-option${capitalize ? " capitalize" : ""}`} role="option" aria-selected={selected === category} onClick={() => choose(category)}>
      {label}
      {selected === category ? <Reicon name="check" className="size-3.5 text-black dark:text-fg" /> : null}
    </button>
  );
  return (
    <div
      ref={root}
      className="relative w-48"
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        className="listbox-trigger"
        disabled={categories.length === 0}
        aria-haspopup="listbox"
        aria-controls="resource-category-options"
        aria-expanded={open}
        title={selected === "" ? "All categories" : selected}
        onClick={() => setOpen(!open)}
      >
        <span className="listbox-trigger-label capitalize">{selected === "" ? "All categories" : selected}</span>
        <svg className="size-3.5 shrink-0 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m8 9 4-4 4 4m0 6-4 4-4-4" />
        </svg>
      </button>
      {open ? (
        <div id="resource-category-options" role="listbox" aria-label="Service category" className="listbox-panel left-auto! right-0! z-[90]! min-w-56!">
          <div className="border-b border-neutral-200 p-2 dark:border-white/[0.08]">
            <input
              type="search"
              ref={input}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search categories"
              className="h-8! w-full rounded-md! border-neutral-200! bg-neutral-50! px-2.5! py-0! text-[12px]! shadow-none! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.04]! dark:text-fg"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <div className="max-h-60 overflow-auto p-1">
            {option("", <span>All categories</span>, false)}
            {filterCategories(categories, search).map((category) => option(category, <span className="truncate">{category}</span>, true))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * create.blade.php's pending resource: the page a chosen one-click service lands on. It creates the
 * service (Create::createResource) and goes to the service's page; a failure is said and the list comes back.
 */
export function OneClickServiceCreate(props: { orgId: string | undefined; projectUuid: string; environmentUuid: string; type: string; destination: string; serverUuid: string | null; back: string }) {
  const { orgId, projectUuid, environmentUuid, type, destination, serverUuid, back } = props;
  const templates = useServiceTemplates(orgId);
  const started = useRef(false);
  const service = isOneClickType(type) ? templates.services.find((item) => item.id === type.slice(ONE_CLICK_PREFIX.length)) : undefined;

  useEffect(() => {
    // wire:init="createResource": once.
    if (started.current) return;
    started.current = true;
    void (async () => {
      const r = await postJson<{ uuid: string; projectUuid: string; environmentUuid: string }>(servicesApi(orgId), {
        type,
        project_uuid: projectUuid,
        environment_uuid: environmentUuid,
        ...(serverUuid ? { server_uuid: serverUuid } : {}),
        destination_uuid: destination,
      });
      if (!r.ok) {
        notify.error(summarize(r.error.messages));
        window.location.replace(back);
        return;
      }
      window.location.assign(servicePath(r.data.projectUuid, r.data.environmentUuid, r.data.uuid));
    })();
  }, [orgId, projectUuid, environmentUuid, type, destination, serverUuid, back]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center pt-24 text-center">
      {service ? (
        <div className="mb-4 size-10">
          <ServiceLogo service={service} />
        </div>
      ) : (
        <Reicon name="layers" className="mb-4 size-8 text-neutral-400 dark:text-fg-faint" />
      )}
      <h2 className="empty-state-title">Creating {service?.name ?? "service"}</h2>
      <p className="empty-state-description text-[13px]">Setting up the resource. You will be redirected when it is ready.</p>
      <div className="mt-4">
        <Loading text="Creating..." />
      </div>
    </div>
  );
}
