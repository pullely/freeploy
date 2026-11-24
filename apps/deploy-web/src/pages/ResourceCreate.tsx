// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/resource/create.blade.php,
// resources/views/livewire/project/new/{select,docker-image}.blade.php and
// app/Livewire/Project/{Resource/Create,New/Select,New/DockerImage}.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/new (project.resource.create): the New
// Resource page. Without ?type and ?destination it is Select — the resource
// types, then the server, then the destination — which ends, as in Coolify,
// on this same URL with ?type=…&destination=…&server_id=…; there the type's
// own form shows. The Docker Image form is here; the Dockerfile and Public Git
// Repository forms are in ResourceCreateBuilt.tsx; every other type stays in
// the grid and ends on the not-ported notice. The one-click services (their
// 390 templates), the category filter's values and the database image steps
// are not ported; server_id is the server's uuid, not a numeric id.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Callout, DeprecatedBadge, Empty, FormInput, SettingsSection, StatusBadge } from "../components/Coolify";
import { TableDropdown } from "../components/CoolifyList";
import { environmentPath, environmentUuidFromPath, limit, ProjectBreadcrumb, projectsApi, projectUuidFromPath } from "./ProjectChrome";
import { applicationPath, applicationsApi } from "./ApplicationChrome";
import { BetaBadge } from "./ServerChrome";
import { splitPastedImageName, type ImageForm } from "../lib/docker-image";
import { DockerfileForm, PublicGitRepositoryForm } from "./ResourceCreateBuilt";

interface ResourceType {
  id: string;
  name: string;
  description: string;
  documentation?: string;
  logo: string;
  logoDark?: string;
  experimental?: boolean;
  creatable: boolean;
}

interface Destination {
  uuid: string;
  name: string;
  network: string;
  type: "standalone" | "swarm";
}

interface Server {
  uuid: string;
  name: string;
  description: string | null;
  ip: string;
  isSwarm: boolean;
  destinations: Destination[];
}

/** GET /projects/{uuid}/environments/{env_uuid}/new. */
interface NewResourceData {
  project: { uuid: string; name: string };
  environment: { uuid: string; name: string };
  servers: Server[];
  buildServers: Array<{ uuid: string; name: string }>;
  onlyBuildServerAvailable: boolean;
  gitBasedApplications: ResourceType[];
  dockerBasedApplications: ResourceType[];
  databases: ResourceType[];
}

const logoUrl = (logo: string) => `/svgs/${logo}.svg`;

/** Select's databaseLinks. */
const DATABASE_LINKS: Record<string, { docs: string; website: string }> = {
  postgresql: { docs: "https://www.postgresql.org/docs/", website: "https://www.postgresql.org/" },
  mysql: { docs: "https://dev.mysql.com/doc/", website: "https://www.mysql.com/" },
  mariadb: { docs: "https://mariadb.com/kb/en/documentation/", website: "https://mariadb.org/" },
  redis: { docs: "https://redis.io/docs/latest/", website: "https://redis.io/" },
  keydb: { docs: "https://docs.keydb.dev/", website: "https://keydb.dev/" },
  dragonfly: { docs: "https://www.dragonflydb.io/docs", website: "https://www.dragonflydb.io/" },
  mongodb: { docs: "https://www.mongodb.com/docs/", website: "https://www.mongodb.com/" },
  clickhouse: { docs: "https://clickhouse.com/docs", website: "https://clickhouse.com/" },
  sqlite: { docs: "https://sqlite.org/docs.html", website: "https://sqlite.org/" },
};

/** The types setType() treats as databases or Compose: Swarm servers are not offered for them. */
const NO_SWARM_TYPES = ["postgresql", "mysql", "mariadb", "redis", "keydb", "dragonfly", "clickhouse", "mongodb", "sqlite", "docker-compose-empty"];

type ViewMode = "list" | "grid";
const VIEW_KEY = "new-resource-view";
const VIEW_CLASSES: Record<ViewMode, Record<"container" | "item" | "logo" | "header" | "description" | "footer" | "action", string>> = {
  list: {
    container: "flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-[calc(0.5rem-1px)] dark:divide-white/[0.07]",
    item: "items-center gap-4 px-4 py-2.5 hover:bg-neutral-50 dark:hover:bg-white/[0.025]",
    logo: "size-8 rounded-lg",
    header: "flex-1 items-center! lg:w-64 lg:flex-none",
    description: "hidden min-w-0 flex-1 truncate lg:block",
    footer: "w-44 shrink-0 justify-end",
    action: "",
  },
  grid: {
    container: "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3",
    item: "min-h-48 flex-col rounded-xl border border-neutral-200 bg-white p-4 hover:border-neutral-300 dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14]",
    logo: "size-11 rounded-xl",
    header: "",
    description: "mt-3 line-clamp-2",
    footer: "mt-auto border-t border-neutral-200 pt-3 dark:border-white/[0.07]",
    action: "ml-auto",
  },
};

function storedView(): ViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

const RESOURCE_TYPE_OPTIONS = [
  { value: "all", label: "All resources" },
  { value: "applications", label: "Applications" },
  { value: "databases", label: "Databases" },
  { value: "services", label: "Services" },
];

/** One resource type: its logo, name, kind, description, links and "Configure". */
function TypeCard(props: { type: ResourceType; view: ViewMode; kind: string | null; onSelect: () => void; links: ReactNode }) {
  const { type } = props;
  const classes = VIEW_CLASSES[props.view];
  return (
    <article
      role="button"
      tabIndex={0}
      aria-label={`Configure ${type.name}`}
      onClick={props.onSelect}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          props.onSelect();
        }
      }}
      className={`group flex cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${classes.item}`}
    >
      <div className={`flex min-w-0 ${props.kind === null ? "items-center" : "items-start"} gap-3 ${classes.header}`.trimEnd()}>
        <div className={`flex shrink-0 items-center justify-center overflow-hidden border border-neutral-200 bg-neutral-50 dark:border-white/[0.08] dark:bg-white/[0.04] ${classes.logo}`}>
          {type.logoDark ? (
            <span className="size-full">
              <img className="size-full object-contain block dark:hidden" src={logoUrl(type.logo)} alt="" />
              <img className="size-full object-contain hidden dark:block" src={logoUrl(type.logoDark)} alt="" />
            </span>
          ) : (
            <img className="size-full object-contain" src={logoUrl(type.logo)} alt="" />
          )}
        </div>
        {props.kind === null ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h3 className="truncate text-[13px] font-semibold text-black dark:text-fg">{type.name}</h3>
            {type.experimental ? <BetaBadge /> : null}
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[13px] font-semibold text-black dark:text-fg">{type.name}</h3>
            <p className="mt-0.5 text-[11px] text-neutral-500 dark:text-fg-faint">{props.kind}</p>
          </div>
        )}
      </div>

      <p className={`text-[12px] leading-5 text-neutral-600 dark:text-fg-dim ${classes.description}`}>{type.description}</p>

      <div className={`flex items-center gap-1.5 ${classes.footer}`}>
        {props.links}
        <span className={`button ${classes.action}`.trimEnd()}>
          Configure
          <Reicon name="arrow-right" className="size-3.5" />
        </span>
      </div>
    </article>
  );
}

function IconLink({ href, title, icon }: { href: string | undefined; title: string; icon: string }) {
  return (
    <a className="icon-button" title={title} aria-label={title} href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
      <Reicon name={icon} className="size-4" />
    </a>
  );
}

function TypeSection({ icon, title, view, children }: { icon: string; title: string; view: ViewMode; children: ReactNode }) {
  return (
    <section className="application-settings-section">
      <div className="application-settings-section-header">
        <div className="flex items-center gap-2">
          <Reicon name={icon} className="size-4 text-neutral-400 dark:text-fg-faint" />
          <h2>{title}</h2>
        </div>
      </div>
      <div className={`application-settings-section-body${view === "list" ? " is-flush" : ""}`}>
        <div className={`text-left ${VIEW_CLASSES[view].container}`}>{children}</div>
      </div>
    </section>
  );
}

/** Select's "type" step: search, view, the resource type filter, and the types. */
function TypeStep({ data, canvasUrl, onSelect, onReload }: { data: NewResourceData; canvasUrl: string; onSelect: (type: string) => void; onReload: () => void }) {
  const [search, setSearch] = useState("");
  const [resourceType, setResourceType] = useState("all");
  const [view, setView] = useState<ViewMode>(storedView);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || (e.target as Element | null)?.closest("input, textarea")) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  function setViewMode(mode: ViewMode) {
    setView(mode);
    try {
      localStorage.setItem(VIEW_KEY, mode);
    } catch {
      /* storage blocked: the choice lasts this page only */
    }
  }
  const [git, docker, databases] = useMemo(() => {
    const query = search.trim().toLowerCase();
    const filter = (items: ResourceType[]) => (query === "" ? items : items.filter((item) => item.name.toLowerCase().includes(query) || item.description.toLowerCase().includes(query)));
    return [filter(data.gitBasedApplications), filter(data.dockerBasedApplications), filter(data.databases)];
  }, [data, search]);
  const showApplications = (resourceType === "all" || resourceType === "applications") && git.length + docker.length > 0;
  const showDatabases = (resourceType === "all" || resourceType === "databases") && databases.length > 0;

  return (
    <div>
      <SettingsSection
        title="Choose a resource"
        flush
        actions={
          <button type="button" className="button" onClick={onReload}>
            <Reicon name="refresh" className="size-3.5" />
            Reload
          </button>
        }
      >
        <div className="flex flex-col gap-3 border-b border-neutral-200 p-4 dark:border-white/[0.08] sm:flex-row sm:items-center sm:justify-between">
          <div className="relative min-w-0 flex-1">
            <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
            <input
              autoComplete="off"
              ref={input}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              type="search"
              placeholder="Search resources"
              className="h-8! w-full rounded-lg! border-neutral-200! bg-white! py-0! pr-8! pl-8! text-[12px]! shadow-none! placeholder:text-neutral-400 focus:border-accent! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.035]! dark:text-fg! dark:placeholder:text-fg-faint"
            />
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* Only the view that is not current shows, as an icon: the button switches to that view. */}
            <div className="view-toggle w-fit">
              {(
                [
                  ["list", "List view", "unordered-list"],
                  ["grid", "Grid view", "grid"],
                ] as const
              ).map(([mode, label, icon]) =>
                view === mode ? null : (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setViewMode(mode)}
                    title={label}
                    aria-label={label}
                    className="relative flex h-7.5 w-7.5 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:hover:text-white"
                  >
                    <Reicon name={icon} className="size-3.5" />
                  </button>
                ),
              )}
            </div>

            <TableDropdown
              panelClass="w-48!"
              trigger={(open) => (
                <button type="button" className="button" aria-haspopup="listbox" aria-expanded={open}>
                  <Reicon name="filter" className="size-3.5" />
                  Filter
                </button>
              )}
            >
              {(close) => (
                <>
                  <div className="px-2 py-1 text-[10px] font-semibold tracking-wide text-neutral-400 uppercase dark:text-fg-faint">Resource type</div>
                  {RESOURCE_TYPE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className="listbox-option"
                      role="option"
                      aria-selected={resourceType === option.value}
                      onClick={() => {
                        setResourceType(option.value);
                        close();
                      }}
                    >
                      <span>{option.label}</span>
                      {resourceType === option.value ? <Reicon name="check" className="size-3.5 text-black dark:text-fg" /> : null}
                    </button>
                  ))}
                </>
              )}
            </TableDropdown>

            {/* The category filter lists the service templates' categories: none until the templates are ported. */}
            <div className="relative w-48">
              <button type="button" className="listbox-trigger" disabled aria-haspopup="listbox" title="All categories">
                <span className="listbox-trigger-label capitalize">All categories</span>
                <svg className="size-3.5 shrink-0 opacity-60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="m8 9 4-4 4 4m0 6-4 4-4-4" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </SettingsSection>

      {search === "" ? (
        <a
          href={canvasUrl}
          className="mt-6 flex items-center gap-4 rounded-xl border border-neutral-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.05)] transition-colors hover:border-neutral-300 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent dark:border-white/[0.08] dark:bg-white/[0.05] dark:shadow-none dark:hover:border-white/[0.14]"
        >
          <div className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim">
            <Reicon name="deploy-canvas" className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-[14px]! leading-5! font-semibold! text-black! dark:text-fg!">Deploy canvas</h2>
              <BetaBadge />
            </div>
            <p className="mt-0.5 text-[12px] leading-5 text-neutral-600 dark:text-fg-dim">Connect a server, a source, and its settings step by step, then deploy every resource at once.</p>
          </div>
          <span className="button button-highlighted shrink-0 max-sm:hidden">
            Try it
            <Reicon name="arrow-right" className="size-3.5" />
          </span>
        </a>
      ) : null}

      <div className="mt-6 flex flex-col gap-6">
        {showApplications ? (
          <TypeSection icon="globe" title="Applications" view={view}>
            {git.map((application) => (
              <TypeCard key={application.id} type={application} view={view} kind="Git source" onSelect={() => onSelect(application.id)} links={<IconLink href={application.documentation} title="Documentation" icon="documentation" />} />
            ))}
            {docker.map((application) => (
              <TypeCard key={application.id} type={application} view={view} kind="Docker source" onSelect={() => onSelect(application.id)} links={<IconLink href={application.documentation} title="Documentation" icon="documentation" />} />
            ))}
          </TypeSection>
        ) : null}

        {showDatabases ? (
          <TypeSection icon="database" title="Databases" view={view}>
            {databases.map((database) => (
              <TypeCard
                key={database.id}
                type={database}
                view={view}
                kind={null}
                onSelect={() => onSelect(database.id)}
                links={
                  <>
                    <IconLink href={DATABASE_LINKS[database.id]?.docs} title="Documentation" icon="documentation" />
                    <IconLink href={DATABASE_LINKS[database.id]?.website} title="Website" icon="globe" />
                  </>
                }
              />
            ))}
          </TypeSection>
        ) : null}

        {!showApplications && !showDatabases ? (
          <div>
            <Empty title="No resources found" description="Try a different search or resource type." iconName="layers" size="sm" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

const ROW = "group flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-white/[0.025]";
const ROW_ICON =
  "flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-fg-dim";

/** Select's "servers" step. */
function ServersStep({ data, servers, onSelect }: { data: NewResourceData; servers: Server[]; onSelect: (server: Server) => void }) {
  return (
    <SettingsSection title="Select a server" helper="Choose the machine that will host this resource." flush>
      {data.onlyBuildServerAvailable ? (
        <Callout type="warning" title="No deployment server" className="m-4">
          Only build servers are available. Add or reconfigure a server before continuing.{" "}
          <a className="font-medium underline" href="/servers">
            Open servers
          </a>
        </Callout>
      ) : null}
      <div className="divide-y divide-neutral-200 dark:divide-white/[0.07]">
        {servers.map((server) => (
          <button key={server.uuid} type="button" onClick={() => onSelect(server)} className={ROW}>
            <span className={ROW_ICON}>
              <Reicon name="servers" className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-black dark:text-fg">{server.name}</span>
              <span className="block truncate text-[11px] text-neutral-500 dark:text-fg-faint">{server.description || server.ip}</span>
            </span>
            <StatusBadge type="success" label="Running" />
          </button>
        ))}
        {servers.length === 0 && data.buildServers.length === 0 && !data.onlyBuildServerAvailable ? (
          <Empty title="No available servers" description="Validate a reachable server before creating this resource." iconName="servers" size="sm">
            <a className="button" href="/servers">
              Open servers
            </a>
          </Empty>
        ) : null}

        {data.buildServers.map((buildServer) => (
          <div key={buildServer.uuid} className="flex min-h-14 items-center gap-3 px-4 py-3 opacity-55">
            <span className={ROW_ICON}>
              <Reicon name="servers" className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold text-black dark:text-fg">{buildServer.name}</span>
              <span className="block text-[11px] text-neutral-500 dark:text-fg-faint">Build-only servers cannot host resources.</span>
            </span>
            <StatusBadge label="Build only" />
            <a href={`/server/${buildServer.uuid}`} className="button">
              Settings
            </a>
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

/** Select's "destinations" step: a Swarm server's Swarm destinations, else its standalone ones. */
function DestinationsStep({ server, onSelect }: { server: Server; onSelect: (destination: Destination) => void }) {
  const kind = server.isSwarm ? "swarm" : "standalone";
  return (
    <SettingsSection title="Select a destination" helper="Destinations separate resources by Docker network. Use the default destination when unsure." flush>
      <div className="divide-y divide-neutral-200 dark:divide-white/[0.07]">
        {server.destinations
          .filter((d) => d.type === kind)
          .map((destination) => (
            <button key={destination.uuid} type="button" onClick={() => onSelect(destination)} className={ROW}>
              <span className={ROW_ICON}>
                <Reicon name="destinations" className="size-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-black dark:text-fg">{destination.name}</span>
                {destination.type === "swarm" ? (
                  <span className="block text-[11px] text-neutral-500 dark:text-fg-faint">Docker Swarm destination</span>
                ) : (
                  <span className="block truncate text-[11px] text-neutral-500 dark:text-fg-faint">Network: {destination.network}</span>
                )}
              </span>
              {destination.type === "swarm" ? <DeprecatedBadge /> : <StatusBadge type="success" label="Standalone Docker" />}
            </button>
          ))}
      </div>
    </SettingsSection>
  );
}

/**
 * <livewire:project.new.select>: the type, then the server, then the
 * destination. A step with one choice is skipped, as setType() and
 * setServer() do; the end is whatToDoNext()'s redirect to this page with the
 * type, the destination and the server in the query string.
 */
function Select({ data, here, onReload }: { data: NewResourceData; here: string; onReload: () => void }) {
  const [step, setStep] = useState<"type" | "servers" | "destinations">("type");
  const [type, setTypeValue] = useState("");
  const [server, setServerValue] = useState<Server | null>(null);

  function next(chosenType: string, chosenServer: Server, destination: Destination) {
    window.location.assign(`${here}/new?${new URLSearchParams({ type: chosenType, destination: destination.uuid, server_id: chosenServer.uuid }).toString()}`);
  }
  function setServer(chosenType: string, chosen: Server) {
    setServerValue(chosen);
    // count($this->standaloneDockers) + count($this->swarmDockers) === 1
    if (chosen.destinations.length === 1) return next(chosenType, chosen, chosen.destinations[0]!);
    setStep("destinations");
  }
  // Databases, Compose and one-click services: no Swarm servers (setType()).
  const serversFor = (chosenType: string) => (NO_SWARM_TYPES.includes(chosenType) || chosenType.startsWith("one-click-service") ? data.servers.filter((s) => !s.isSwarm) : data.servers);
  function setType(chosen: string) {
    setTypeValue(chosen);
    const servers = serversFor(chosen);
    if (servers.length === 1 && data.buildServers.length === 0) return setServer(chosen, servers[0]!);
    setStep("servers");
  }

  return (
    <div className="application-settings-form">
      {step === "type" ? <TypeStep data={data} canvasUrl={`/canvas?${new URLSearchParams({ project: data.project.uuid, environment: data.environment.uuid }).toString()}`} onSelect={setType} onReload={onReload} /> : null}
      {step === "servers" ? <ServersStep data={data} servers={serversFor(type)} onSelect={(chosen) => setServer(type, chosen)} /> : null}
      {step === "destinations" && server ? <DestinationsStep server={server} onSelect={(destination) => next(type, server, destination)} /> : null}
    </div>
  );
}

/** <livewire:project.new.docker-image>: the image name, and a tag or a SHA256 digest. */
function DockerImage({ orgId, data, destination, serverUuid }: { orgId: string | undefined; data: NewResourceData; destination: string; serverUuid: string | null }) {
  const [form, setForm] = useState<ImageForm>({ imageName: "", imageTag: "", imageSha256: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  /** DockerImage::submit(): the application is created, not deployed; then its configuration page. */
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    const r = await postJson<{ uuid: string; projectUuid: string; environmentUuid: string }>(applicationsApi(orgId), {
      type: "dockerimage",
      project_uuid: data.project.uuid,
      environment_uuid: data.environment.uuid,
      ...(serverUuid ? { server_uuid: serverUuid } : {}),
      destination_uuid: destination,
      ...form,
    });
    if (!r.ok) {
      setSaving(false);
      const fields = r.error.fields ?? {};
      const inline: Record<string, string> = {};
      for (const f of ["imageName", "imageTag", "imageSha256"]) if (fields[f]?.[0]) inline[f] = fields[f][0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    window.location.assign(applicationPath(r.data.projectUuid, r.data.environmentUuid, r.data.uuid));
  }

  return (
    <div className="mt-8 w-full max-w-[920px] lg:mt-3">
      <form onSubmit={(e) => void submit(e)}>
        <section className="application-settings-section">
          <div className="application-settings-section-header">
            <div>
              <h2>Docker image</h2>
              <p>Deploy an existing image from Docker Hub or another OCI registry.</p>
            </div>
            <button type="submit" className="button button-highlighted" disabled={saving}>
              Create application
            </button>
          </div>
          <div className="application-settings-section-body space-y-4">
            <FormInput
              id="imageName"
              label="Image name"
              placeholder="nginx, ghcr.io/user/app:v1.2.3, or nginx:stable@sha256:…"
              helper="Paste a complete image reference, or enter a name and use one of the optional fields below."
              required
              value={form.imageName}
              onChange={(imageName) => setForm(splitPastedImageName({ ...form, imageName }))}
              error={errors.imageName}
            />
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-end" aria-label="Tag and SHA256 digest are mutually exclusive">
              <FormInput
                id="imageTag"
                label="Tag"
                placeholder="latest"
                helper="Use a mutable tag such as latest or v1.2.3."
                value={form.imageTag}
                onChange={(imageTag) => setForm({ ...form, imageTag })}
                error={errors.imageTag}
              />
              <div className="flex items-center justify-center text-xs font-semibold text-neutral-400 sm:h-9 dark:text-fg-faint">
                <span>OR</span>
              </div>
              <FormInput
                id="imageSha256"
                label="SHA256 digest"
                placeholder="59e02939b1bf39f16c93138a28727aec…"
                helper="Use the 64-character digest without the sha256: prefix."
                value={form.imageSha256}
                onChange={(imageSha256) => setForm({ ...form, imageSha256 })}
                error={errors.imageSha256}
              />
            </div>
          </div>
        </section>
      </form>
    </div>
  );
}

/** A type whose form is not ported yet (Freeploy's notice, as on a route that is not ported). */
function TypeNotPorted() {
  return (
    <div data-freeploy-not-ported="">
      <div className="mt-8 lg:mt-3">
        <div className="empty-state w-full">
          <div className="empty-state-well min-h-32">
            <h2 className="empty-state-title">This resource type is not available in Freeploy yet</h2>
            <p className="empty-state-description text-[12px]">It is being ported. An application from a public Git repository, a Dockerfile or a Docker image can be created today.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResourceCreateContent() {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const here = environmentPath(projectUuid, environmentUuid);
  const base = `${projectsApi(me.team?.id)}/${encodeURIComponent(projectUuid)}/environments/${encodeURIComponent(environmentUuid)}/new`;
  const [data, setData] = useState<NewResourceData | null>(null);
  const [reload, setReload] = useState(0);
  const query = new URLSearchParams(window.location.search);
  const type = query.get("type");
  const destination = query.get("destination");

  useEffect(() => {
    void (async () => {
      const r = await getJson<NewResourceData>(base);
      if (!r.data) {
        // Create::mount() redirects to the dashboard; the route's can.create.resources answers 403. Here: back to the environment.
        if (r.status === 404) window.location.replace(here);
        return;
      }
      setData(r.data);
    })();
  }, [base, here, reload]);
  useEffect(() => {
    if (data) document.title = `${limit(data.project.name, 10)} > New | Freeploy`;
  }, [data]);

  if (!data) return null;
  let content: ReactNode;
  if (type && destination) {
    // Create::mount(): find_resource_destination_for_current_team(), or back to the dashboard.
    const known = data.servers.some((s) => s.destinations.some((d) => d.uuid === destination));
    if (!known) {
      window.location.replace("/");
      return null;
    }
    const target = { orgId: me.team?.id, projectUuid: data.project.uuid, environmentUuid: data.environment.uuid, destination, serverUuid: query.get("server_id") };
    if (type === "docker-image") content = <DockerImage orgId={me.team?.id} data={data} destination={destination} serverUuid={query.get("server_id")} />;
    else if (type === "dockerfile") content = <DockerfileForm {...target} />;
    else if (type === "public") content = <PublicGitRepositoryForm {...target} />;
    else content = <TypeNotPorted />;
  } else {
    content = <Select data={data} here={here} onReload={() => setReload((n) => n + 1)} />;
  }
  return (
    <div>
      <ProjectBreadcrumb orgId={me.team?.id} project={data.project} environment={data.environment} />
      {content}
    </div>
  );
}

export function ResourceCreatePage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="New">
      <ResourceCreateContent />
    </Layout>
  );
}
