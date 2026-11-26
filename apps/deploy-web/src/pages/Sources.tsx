// Derived from coollabsio/coolify@91b7e3e:resources/views/source/all.blade.php,
// resources/views/livewire/source/github/create.blade.php, resources/views/livewire/shared/list-search-*.blade.php and
// app/Livewire/Source/Github/Create.php (Apache-2.0), modified.
//
// Integrations → Sources (DP-72): /sources lists the org's Git sources and creates a GitHub App in Coolify's
// "New GitHub App" dialog, which goes on to the App's page (/source/github/{uuid}) to register it with GitHub.
// DP-103: the New source menu also offers a GitLab App and a Gitea / Forgejo App (SourceOauth.tsx's dialogs), which go
// on to their pages. Freeploy is a hosted service, so the dialogs have no "System wide" option and no GitHub Actions runners.
import { useEffect, useState, type FormEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { showSourceFlash } from "../lib/source-flash";
import { Reicon } from "../components/Reicon";
import { Checkbox, Collapsible, DangerCallout, Empty, FormInput, ListSearchControls, ListSearchEmpty, ModalInput, StatusBadge, type ListViewMode } from "../components/Coolify";
import { OauthCreateForm } from "./SourceOauth";

export interface SourceItem {
  kind: "github" | "gitlab" | "gitea";
  uuid: string;
  name: string;
  provider: string;
  account: string | null;
  connected: boolean;
  htmlUrl: string;
  registered: boolean;
}

export const sourcesApi = (orgId: string | undefined) => `/v1/organizations/${orgId ?? ""}/deploy/sources`;
const VIEW_KEY = "coolify-sources-view";
const COLUMNS = "grid-cols-[minmax(0,1fr)_minmax(10rem,.7fr)_9rem]";

/** The page of a source (GitLab's and Gitea's since DP-103). */
const sourceHref = (s: SourceItem): string => `/source/${s.kind}/${s.uuid}`;
const statusLabel = (s: SourceItem): string => (s.connected ? "Connected" : s.kind === "github" ? "Setup incomplete" : "Setup required");

/** githubApiUrlFromHtmlUrl(), for the dialog's "API URL follows HTML URL" behaviour. */
export function apiUrlFromHtmlUrl(htmlUrl: string): string {
  let host = "";
  let origin = "";
  try {
    const u = new URL(htmlUrl);
    host = u.hostname.toLowerCase();
    origin = `${u.protocol}//${u.host}`;
  } catch {
    return "";
  }
  if (host === "github.com") return "https://api.github.com";
  if (host.endsWith(".ghe.com") && !host.startsWith("api.")) return `https://api.${host}`;
  return `${origin}/api/v3`;
}

/** <livewire:source.github.create>: the New GitHub App dialog. */
export function GithubCreateForm({ defaultName, canCreate }: { defaultName: string; canCreate: boolean }) {
  const { me } = useSignedIn();
  const [f, setF] = useState({ name: defaultName, organization: "", html_url: "https://github.com", api_url: "https://api.github.com", custom_user: "git", custom_port: "22" });
  const [previews, setPreviews] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  if (!canCreate) {
    return <DangerCallout title="Insufficient permissions">You don&apos;t have permission to create new GitHub Apps. Contact your team administrator.</DangerCallout>;
  }
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  /** updatingHtmlUrl() / updatedHtmlUrl(): the API URL follows while it is the derived one or empty. */
  function setHtmlUrl(value: string) {
    setF((x) => ({ ...x, html_url: value, api_url: x.api_url === "" || x.api_url === apiUrlFromHtmlUrl(x.html_url) ? apiUrlFromHtmlUrl(value) : x.api_url }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    const r = await postJson<{ uuid: string; previews: boolean }>(sourcesApi(me.team?.id), { ...f, custom_port: f.custom_port, organization: f.organization === "" ? null : f.organization, use_for_pull_request_previews: previews });
    setSaving(false);
    if (!r.ok) {
      const inline: Record<string, string> = {};
      for (const [k, m] of Object.entries(r.error.fields ?? {})) if (m[0]) inline[k] = m[0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    window.location.assign(`/source/github/${r.data.uuid}?previews=${r.data.previews ? 1 : 0}&runners=0`);
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex w-full flex-col gap-4">
      <p className="text-[12px] leading-5 text-neutral-500 dark:text-fg-dim">Connect a GitHub App for private repositories, webhooks, and commit / pull request deployments.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormInput id="name" label="Name" required value={f.name} onChange={set("name")} error={errors.name} />
        <FormInput
          id="organization"
          label="Organization"
          value={f.organization}
          onChange={set("organization")}
          error={errors.organization}
          helper="If empty, your GitHub user will be used. For an organization, your GitHub user must be an owner or a GitHub App manager of it."
          placeholder="Personal account when empty"
        />
      </div>
      <div>
        <p className="text-[12px] font-medium text-neutral-700 dark:text-fg-dim">Use this App for</p>
        <p className="mt-1 text-[12px] leading-5 text-neutral-500 dark:text-fg-dim">Deploying applications from private repositories is always included. The choices below select the permissions and webhook events on the next page.</p>
        <div className="mt-2 flex max-w-xs flex-col gap-1">
          <Checkbox id="use_for_pull_request_previews" label="Pull request previews" helper="Deploys pull requests and posts deployment status on them." checked={previews} onChange={setPreviews} />
        </div>
      </div>
      <div className="rounded-lg border border-neutral-200 dark:border-white/[0.08]">
        <Collapsible title="Self-hosted / Enterprise GitHub" contentClassName="border-t border-neutral-200 px-3 py-3 dark:border-white/[0.08]">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormInput id="html_url" label="HTML URL" required value={f.html_url} onChange={setHtmlUrl} error={errors.html_url} helper="For GitHub Enterprise, enter your instance URL (e.g. https://github.example.com)." />
            <FormInput id="api_url" label="API URL" required value={f.api_url} onChange={set("api_url")} error={errors.api_url} helper="Usually https://api.github.com or your Enterprise API base URL." />
            <FormInput id="custom_user" label="Custom Git user" required value={f.custom_user} onChange={set("custom_user")} error={errors.custom_user} />
            <FormInput id="custom_port" type="number" label="Custom Git port" required value={f.custom_port} onChange={set("custom_port")} error={errors.custom_port} />
          </div>
        </Collapsible>
      </div>
      <button type="submit" className="button mt-1 w-full justify-center" disabled={saving}>
        Continue
      </button>
    </form>
  );
}

function storedView(): ListViewMode {
  try {
    return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "table";
  } catch {
    return "table";
  }
}

function SourcesContent() {
  const { me } = useSignedIn();
  const [data, setData] = useState<{ sources: SourceItem[]; canCreate: boolean; defaultName: string } | null>(null);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<ListViewMode>(storedView);
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState(false);
  const [openGitlab, setOpenGitlab] = useState(false);
  const [openGitea, setOpenGitea] = useState(false);

  useEffect(() => {
    showSourceFlash();
    void (async () => {
      const r = await getJson<{ sources: SourceItem[]; canCreate: boolean; defaultName: string }>(sourcesApi(me.team?.id));
      if (!r.data && r.status !== 401) notify.error("Failed to load sources.");
      setData(r.data ?? { sources: [], canCreate: false, defaultName: "" });
    })();
  }, [me.team?.id]);

  function changeView(mode: ListViewMode) {
    setViewMode(mode);
    try {
      localStorage.setItem(VIEW_KEY, mode);
    } catch {
      /* storage blocked: the view lasts this page only */
    }
  }

  if (!data) return null;
  const { sources } = data;
  const q = search.trim().toLowerCase();
  const matches = (s: SourceItem) => !q || [s.name, s.provider, s.account ?? "", statusLabel(s)].some((v) => v.toLowerCase().includes(q));
  const filtered = sources.filter(matches);
  const badge = (s: SourceItem) => <StatusBadge label={statusLabel(s)} type={s.connected ? "success" : "warning"} />;
  const providerLine = (s: SourceItem) => (s.account ? `${s.kind === "gitea" ? "Gitea" : s.provider} · ${s.account}` : s.kind === "gitea" ? "Gitea" : s.provider);

  return (
    <div className="application-settings-form w-full">
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-[24px]! leading-7! font-semibold! tracking-tight!">Sources</h1>
          <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">
            {sources.length} {sources.length === 1 ? "Git source" : "Git sources"} connected to your team
          </p>
        </div>
        {data.canCreate ? (
          <div className="relative w-fit shrink-0">
            <button type="button" className="button button-highlighted" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
              <Reicon name="plus" className="size-3.5" />
              New source
              <Reicon name="chevron-down" className="size-3 opacity-55" />
            </button>
            {menu ? (
              <div role="menu" className="listbox-panel left-auto! right-0! z-[90]! w-52! min-w-52!">
                <ModalInput
                  title="New GitHub App"
                  open={open}
                  onOpenChange={setOpen}
                  closeOutside={false}
                  trigger={
                    <button type="button" className="listbox-option justify-start! gap-2.5!" role="menuitem" onClick={() => setMenu(false)}>
                      <Reicon name="sources" className="size-3.5 shrink-0 opacity-70" />
                      GitHub App
                    </button>
                  }
                >
                  <GithubCreateForm defaultName={data.defaultName} canCreate={data.canCreate} />
                </ModalInput>
                <ModalInput
                  title="New GitLab App"
                  open={openGitlab}
                  onOpenChange={setOpenGitlab}
                  closeOutside={false}
                  trigger={
                    <button type="button" className="listbox-option justify-start! gap-2.5!" role="menuitem" onClick={() => setMenu(false)}>
                      <Reicon name="sources" className="size-3.5 shrink-0 opacity-70" />
                      GitLab App
                    </button>
                  }
                >
                  <OauthCreateForm kind="gitlab" defaultName={data.defaultName} canCreate={data.canCreate} />
                </ModalInput>
                <ModalInput
                  title="New Gitea / Forgejo App"
                  open={openGitea}
                  onOpenChange={setOpenGitea}
                  closeOutside={false}
                  trigger={
                    <button type="button" className="listbox-option justify-start! gap-2.5!" role="menuitem" onClick={() => setMenu(false)}>
                      <Reicon name="sources" className="size-3.5 shrink-0 opacity-70" />
                      Gitea / Forgejo App
                    </button>
                  }
                >
                  <OauthCreateForm kind="gitea" defaultName={data.defaultName} canCreate={data.canCreate} />
                </ModalInput>
              </div>
            ) : null}
          </div>
        ) : null}
      </header>

      {sources.length === 0 ? (
        <Empty title="No sources yet" description="Connect a Git provider to deploy applications directly from your repositories." iconName="sources" />
      ) : (
        <div>
          <ListSearchControls placeholder="Search sources" search={search} onSearch={setSearch} viewMode={viewMode} onViewMode={changeView} />
          {viewMode === "grid" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {filtered.map((s) => (
                <a
                  key={`${s.kind}-${s.uuid}`}
                  href={sourceHref(s)}
                  className="group flex min-h-28 flex-col rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:no-underline hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14]"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim">
                      <Reicon name="sources" className="size-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{s.name}</h2>
                      <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{providerLine(s)}</p>
                    </div>
                  </div>
                  <div className="mt-auto pt-4">{badge(s)}</div>
                </a>
              ))}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]">
              <div className={`grid min-w-[620px] ${COLUMNS} border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint`}>
                <div>Source</div>
                <div>Provider</div>
                <div>Status</div>
              </div>
              {filtered.map((s) => (
                <a
                  key={`${s.kind}-${s.uuid}`}
                  href={sourceHref(s)}
                  className={`grid min-h-14 min-w-[620px] ${COLUMNS} items-center border-b border-neutral-200 px-4 py-2.5 text-[12px] transition-colors last:border-b-0 hover:bg-neutral-50 hover:no-underline dark:border-white/[0.07] dark:hover:bg-white/[0.025]`}
                >
                  <div className="truncate font-semibold text-black dark:text-fg">{s.name}</div>
                  <div className="truncate text-neutral-500 dark:text-fg-dim">{s.account ? `${s.kind === "gitea" ? "Gitea" : s.provider} · ${s.account}` : s.kind === "gitea" ? "Gitea" : s.provider}</div>
                  <div>
                    <StatusBadge label={s.connected ? "Connected" : "Setup incomplete"} type={s.connected ? "success" : "warning"} />
                  </div>
                </a>
              ))}
            </div>
          )}
          {filtered.length === 0 ? <ListSearchEmpty label="sources" /> : null}
        </div>
      )}
    </div>
  );
}

export function SourcesPage() {
  return (
    <Layout title="Sources" href="/sources" navHref="/sources" documentTitle="Sources">
      <SourcesContent />
    </Layout>
  );
}
