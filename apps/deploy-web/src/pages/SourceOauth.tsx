// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/source/{gitlab,gitea}/{change,create}.blade.php,
// app/Livewire/Source/{Gitlab,Gitea}/{Create,Change}.php and app/Http/Controllers/Webhook/{Gitlab,Gitea}.php (redirect)
// (Apache-2.0), modified.
//
// The two OAuth Git sources (DP-103): the New GitLab App and New Gitea / Forgejo App dialogs of /sources, a source's page
// (/source/gitlab/{uuid}, /source/gitea/{uuid}) — before it is connected, Coolify's three steps (create an OAuth application
// on the instance, enter its credentials, authorize); once connected, its form, Test connection and the applications that
// use it — and the page the instance sends the browser back to (/webhooks/source/{gitlab,gitea}/redirect), which hands the
// code to the API and goes on to the source's page. Freeploy is a hosted service, so the pages are Coolify Cloud's: no
// "System wide" option and no endpoint chooser — the redirect URI is the console's own, the webhook URL api-edge's.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { edgeBase, getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { flashSource as flash, showSourceFlash } from "../lib/source-flash";
import { setupStateOrg } from "../lib/github-manifest";
import { followHtmlUrl, GITEA_PROVIDERS, oauthApplicationsUrl, oauthAuthorizeUrl, oauthWebhookUrl, selectGiteaProvider, type OauthSourceKind } from "../lib/oauth-source";
import { Reicon } from "../components/Reicon";
import { Button, DangerCallout, Empty, FormInput, Listbox, ModalConfirmation, SettingsSection, SettingsSubsection, StatusBadge, UnsavedBar } from "../components/Coolify";
import { sourcesApi } from "./Sources";

/** The words of each provider, as its blades write them ("Coolify" in prose reads "Freeploy"). */
const COPY = {
  gitlab: {
    app: "GitLab App",
    apps: "GitLab Apps",
    forFilter: (f: string) => `GitLab App for ${f}`,
    privateSource: "Private GitLab source",
    filterLabel: "Group name",
    clientIdLabel: "Application ID",
    clientSecretLabel: "Application secret",
    createIntro: "Connect a GitLab OAuth application for private repositories, webhooks, and deployments.",
    createFilterHelper: "Optional. Comma-separated group names to filter repositories (e.g. myorg,myteam).",
    selfHosted: "Self-hosted GitLab",
    htmlUrlLabel: "GitLab URL",
    createHtmlHelper: "For self-hosted GitLab, enter your instance URL (e.g. https://gitlab.example.com).",
    apiHelper: "Usually your GitLab URL with /api/v4 appended.",
    noPermission: "You don't have permission to create new GitLab Apps. Contact your team administrator.",
    webhookHelper:
      "Configure this webhook URL in your GitLab project settings (Settings → Webhooks). On self-managed GitLab, an admin can instead add the same URL and token once as a system hook (Admin Area → System hooks) with Push events and Merge request events enabled.",
    webhookLabel: "Webhook secret token",
    webhookFieldHelper: "Set this same token in your GitLab webhook's Secret token field. Stored encrypted.",
    credentialsHelper: "Application credentials from your GitLab OAuth application.",
    filterHelper: "Comma-separated group names to filter visible repositories.",
    advancedHelper: "Override endpoints and SSH settings for self-hosted GitLab.",
    step1Description: "Register a new OAuth application in your GitLab instance with the redirect URI below.",
    step2Description: "Paste the Application ID and secret from GitLab, then save.",
    clientIdHelper: "The Application ID from your GitLab OAuth Application.",
    clientSecretHelper: "The Secret from your GitLab OAuth Application. Saved encrypted.",
    step2FilterHelper: "Optional. Comma-separated group names to filter repositories.",
    advancedHtmlHelper: "Only change this for self-hosted GitLab (e.g. https://gitlab.example.com).",
    step3Title: "Step 3 · Authorize with GitLab",
    step3Description: "Authorize Freeploy with your GitLab instance. The redirect URI must match the Callback URL configured in GitLab.",
    connect: "Connect to GitLab",
  },
  gitea: {
    app: "Gitea / Forgejo App",
    apps: "Gitea / Forgejo Apps",
    forFilter: (f: string) => `Gitea / Forgejo App for ${f}`,
    privateSource: "Private Gitea / Forgejo source",
    filterLabel: "Organization",
    clientIdLabel: "Client ID",
    clientSecretLabel: "Client secret",
    createIntro: "Connect a Gitea or Forgejo OAuth2 application (Gitea.com, Codeberg, or your own instance) for private repositories, webhooks, and deployments.",
    createFilterHelper: "Optional. Comma-separated organization or user names to filter repositories (e.g. myorg,myuser).",
    selfHosted: "Self-hosted Gitea or Forgejo",
    htmlUrlLabel: "Instance URL",
    createHtmlHelper: "For self-hosted Gitea or Forgejo, enter your instance URL (e.g. https://git.example.com).",
    apiHelper: "Usually your instance URL with /api/v1 appended.",
    noPermission: "You don't have permission to create new Gitea / Forgejo Apps. Contact your team administrator.",
    webhookHelper: "Configure this webhook URL in Gitea or Forgejo (user, organization, or repository settings → Webhooks → Add webhook → Gitea or Forgejo).",
    webhookLabel: "Webhook secret",
    webhookFieldHelper:
      "Set this as the Secret in a Gitea webhook (user, organization, or repository settings → Webhooks → Add webhook → Gitea or Forgejo), content type application/json, trigger on Push and Pull Request events. Stored encrypted.",
    credentialsHelper: "Client credentials from your Gitea or Forgejo OAuth2 application.",
    filterHelper: "Comma-separated organization or user names to filter visible repositories.",
    advancedHelper: "Override endpoints and SSH settings for self-hosted Gitea or Forgejo.",
    step1Description: "In Gitea or Forgejo, open Settings → Applications → Manage OAuth2 Applications and create a new application with the redirect URI below.",
    step2Description: "Paste the Client ID and Client secret from Gitea or Forgejo, then save.",
    clientIdHelper: "The Client ID from your Gitea or Forgejo OAuth2 application.",
    clientSecretHelper: "The Client secret from your Gitea or Forgejo OAuth2 application. Saved encrypted.",
    step2FilterHelper: "Optional. Comma-separated organization or user names to filter repositories.",
    advancedHtmlHelper: "Only change this for self-hosted Gitea or Forgejo (e.g. https://git.example.com).",
    step3Title: "Step 3 · Authorize with Gitea or Forgejo",
    step3Description: "Authorize Freeploy with your Gitea or Forgejo instance. The redirect URI must match the one configured there.",
    connect: "Connect to Gitea / Forgejo",
  },
} as const;

const DEFAULTS = { gitlab: { html_url: "https://gitlab.com", api_url: "https://gitlab.com/api/v4" }, gitea: { html_url: "https://gitea.com", api_url: "https://gitea.com/api/v1" } } as const;
const FILTER_FIELD = { gitlab: "group_name", gitea: "organization" } as const;
const FORM_FILTER = { gitlab: "groupName", gitea: "organization" } as const;
const FORM_WEBHOOK = { gitlab: "webhookToken", gitea: "webhookSecret" } as const;

const ExternalLink = () => <Reicon name="arrow-right" className="size-3.5 -rotate-45" />;

/** The "Self-hosted …" / "Advanced / self-hosted" disclosure of the blades (x-collapse), open when told to be. */
function Disclosure({ title, open, onToggle, framed, children }: { title: string; open: boolean; onToggle: () => void; framed: boolean; children: ReactNode }) {
  const chevron = (
    <svg className={`size-3.5 transition-transform${open ? " rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
  if (framed) {
    return (
      <div className="rounded-lg border border-neutral-200 dark:border-white/[0.08]">
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center justify-between px-3 py-2.5 text-left text-[12px] font-medium text-neutral-700 transition-colors hover:bg-neutral-50 dark:text-fg-dim dark:hover:bg-white/[0.03]">
          {title}
          {chevron}
        </button>
        {open ? <div className="border-t border-neutral-200 px-3 py-3 dark:border-white/[0.08]">{children}</div> : null}
      </div>
    );
  }
  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-lg border border-neutral-200 px-3 py-2.5 text-left text-[12px] font-medium text-neutral-700 transition-colors hover:bg-neutral-50 dark:border-white/[0.08] dark:text-fg-dim dark:hover:bg-white/[0.03]"
      >
        {title}
        {chevron}
      </button>
      {open ? <div className="mt-3 grid gap-4 rounded-lg border border-neutral-200 p-3 lg:grid-cols-2 dark:border-white/[0.08]">{children}</div> : null}
    </div>
  );
}

/** The field errors of a 422, inline; anything else a toast. */
function fieldErrors(r: { error: { fields?: Record<string, string[]>; messages: string[] } }, setErrors: (e: Record<string, string>) => void): void {
  const inline: Record<string, string> = {};
  for (const [k, m] of Object.entries(r.error.fields ?? {})) if (m[0]) inline[k] = m[0];
  setErrors(inline);
  if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
}

// ── Create ──────────────────────────────────────────────────────────────────────────────────────────────

/** <livewire:source.gitlab.create> / <livewire:source.gitea.create>: the New GitLab App / New Gitea / Forgejo App dialog. */
export function OauthCreateForm({ kind, defaultName, canCreate }: { kind: OauthSourceKind; defaultName: string; canCreate: boolean }) {
  const { me } = useSignedIn();
  const copy = COPY[kind];
  const [f, setF] = useState<{ name: string; filter: string; html_url: string; api_url: string; custom_user: string; custom_port: string }>({ name: defaultName, filter: "", ...DEFAULTS[kind], custom_user: "git", custom_port: "22" });
  const [provider, setProvider] = useState("gitea.com");
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  if (!canCreate) return <DangerCallout title="Insufficient permissions">{copy.noPermission}</DangerCallout>;
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const setHtmlUrl = (value: string) => setF((x) => ({ ...x, html_url: value, api_url: followHtmlUrl(kind, x.html_url, x.api_url, value) }));
  function chooseProvider(value: string) {
    setProvider(value);
    setF((x) => selectGiteaProvider(value, x));
    // x-effect: the self-hosted choice opens the disclosure.
    if (value === "self-hosted") setOpen(true);
  }

  async function submit() {
    if (saving) return;
    setSaving(true);
    const r = await postJson<{ uuid: string }>(`${sourcesApi(me.team?.id)}/${kind}`, {
      name: f.name,
      [FILTER_FIELD[kind]]: f.filter === "" ? null : f.filter,
      html_url: f.html_url,
      api_url: f.api_url,
      custom_user: f.custom_user,
      custom_port: f.custom_port,
      is_system_wide: false,
    });
    setSaving(false);
    if (!r.ok) return fieldErrors(r, setErrors);
    window.location.assign(`/source/${kind}/${r.data.uuid}`);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex w-full flex-col gap-4"
    >
      <p className="text-[12px] leading-5 text-neutral-500 dark:text-fg-dim">{copy.createIntro}</p>
      {kind === "gitea" ? (
        <Listbox
          id="provider"
          label="Provider"
          options={GITEA_PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
          value={provider}
          onChange={chooseProvider}
          helper="Codeberg runs Forgejo. For your own Gitea or Forgejo instance, select Self-hosted and enter its URL below."
        />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormInput id="name" label="Name" required value={f.name} onChange={set("name")} error={errors.name} />
        <FormInput id={FILTER_FIELD[kind]} label={copy.filterLabel} value={f.filter} onChange={set("filter")} error={errors[FILTER_FIELD[kind]]} helper={copy.createFilterHelper} placeholder="All accessible repositories when empty" />
      </div>
      <Disclosure title={copy.selfHosted} open={open} onToggle={() => setOpen((o) => !o)} framed>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormInput id="html_url" label={copy.htmlUrlLabel} required value={f.html_url} onChange={setHtmlUrl} error={errors.html_url} helper={copy.createHtmlHelper} />
          <FormInput id="api_url" label="API URL" required value={f.api_url} onChange={set("api_url")} error={errors.api_url} helper={copy.apiHelper} />
          <FormInput id="custom_user" label="Custom Git user" required value={f.custom_user} onChange={set("custom_user")} error={errors.custom_user} />
          <FormInput id="custom_port" type="number" label="Custom Git port" required value={f.custom_port} onChange={set("custom_port")} error={errors.custom_port} />
        </div>
      </Disclosure>
      <button type="submit" className="button mt-1 w-full justify-center" disabled={saving}>
        Continue
      </button>
    </form>
  );
}

// ── The page ────────────────────────────────────────────────────────────────────────────────────────────

export interface OauthSourcePageData {
  kind: OauthSourceKind;
  uuid: string;
  name: string;
  apiUrl: string;
  htmlUrl: string;
  customUser: string;
  customPort: number;
  clientId: string | null;
  clientSecretInput: string | null;
  webhookToken: string | null;
  webhookSecret: string | null;
  hasClientSecret: boolean;
  groupName: string | null;
  organization: string | null;
  isSystemWide: boolean;
  privateKeyId: string | number | null;
  privateKeys: Array<{ id: string | number; name: string }>;
  applications: Array<{ uuid: string; name: string; project_uuid: string; project_name: string; environment_uuid: string; environment_name: string; git_repository: string | null; git_branch: string | null }>;
  isConnected: boolean;
  redirectUri: string;
  oauthState: string | null;
  canUpdate: boolean;
  canDelete: boolean;
}

interface Form {
  name: string;
  clientId: string;
  clientSecretInput: string;
  webhook: string;
  filter: string;
  htmlUrl: string;
  apiUrl: string;
  customUser: string;
  customPort: string;
  privateKeyId: string;
}

const formOf = (a: OauthSourcePageData): Form => ({
  name: a.name,
  clientId: a.clientId ?? "",
  clientSecretInput: a.clientSecretInput ?? "",
  webhook: (a.kind === "gitlab" ? a.webhookToken : a.webhookSecret) ?? "",
  filter: (a.kind === "gitlab" ? a.groupName : a.organization) ?? "",
  htmlUrl: a.htmlUrl,
  apiUrl: a.apiUrl,
  customUser: a.customUser,
  customPort: String(a.customPort),
  privateKeyId: a.privateKeyId === null ? "" : String(a.privateKeyId),
});

/** The delete confirmation, as Coolify's modal asks for it. */
function DeleteSource({ app, api }: { app: OauthSourcePageData; api: string }) {
  const label = COPY[app.kind].app;
  return (
    <ModalConfirmation
      title={`Confirm ${label} Deletion?`}
      buttonTitle="Delete"
      actions={[`The selected ${label} will be permanently deleted.`]}
      confirmationText={app.name}
      confirmationLabel={`Please confirm by entering the ${label} Name below`}
      shortConfirmationLabel={`${label} Name`}
      step2ButtonText="Permanently Delete"
      onSubmit={async () => {
        const r = await postJson<{ redirect: string }>(api, {}, "DELETE");
        if (!r.ok) return notify.error(summarize(r.error.messages));
        window.location.assign(r.data.redirect);
      }}
    />
  );
}

/** The resources table of a connected source. */
function Resources({ app }: { app: OauthSourcePageData }) {
  const [search, setSearch] = useState("");
  const copy = COPY[app.kind];
  const COLS = "grid-cols-[minmax(10rem,.8fr)_minmax(10rem,.8fr)_minmax(12rem,1fr)_8rem]";
  const rows = [...app.applications].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const q = search.toLowerCase();
  return (
    <div className="application-settings-form mt-6">
      <SettingsSection title="Resources" helper={`Applications currently using this ${copy.app}.`} flush>
        {rows.length === 0 ? (
          <Empty title="No resources use this source" description={`Applications will appear here after this ${copy.app} is selected as their source.`} iconName="sources" size="sm" />
        ) : (
          <>
            <div className="border-b border-neutral-200 p-3 dark:border-white/[0.08]">
              <div className="relative w-full max-w-sm">
                <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
                <input
                  type="search"
                  placeholder="Search resources"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8! w-full rounded-lg! border-neutral-200! bg-white! py-0! pr-3! pl-8! text-[12px]! shadow-none! placeholder:text-neutral-400 focus:border-accent! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.035]! dark:text-fg! dark:placeholder:text-fg-faint"
                />
              </div>
            </div>
            <div className="overflow-x-auto">
              <div className={`grid min-w-[680px] ${COLS} border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint`}>
                <div>Project</div>
                <div>Environment</div>
                <div>Resource</div>
                <div>Repository</div>
              </div>
              {rows
                .map((r) => ({ r, repo: `${r.git_repository ?? ""}:${r.git_branch ?? ""}` }))
                .filter(({ r, repo }) => q === "" || `${r.project_name} ${r.environment_name} ${r.name} ${repo}`.toLowerCase().includes(q))
                .map(({ r, repo }) => (
                  <a
                    key={r.uuid}
                    href={`/project/${r.project_uuid}/environment/${r.environment_uuid}/application/${r.uuid}`}
                    className={`grid min-h-13 min-w-[680px] ${COLS} items-center border-b border-neutral-200 px-4 py-2.5 text-[12px] transition-colors last:border-b-0 hover:bg-neutral-50 hover:no-underline dark:border-white/[0.07] dark:hover:bg-white/[0.025]`}
                  >
                    <span className="truncate text-neutral-500 dark:text-fg-dim">{r.project_name}</span>
                    <span className="truncate text-neutral-500 dark:text-fg-dim">{r.environment_name}</span>
                    <span className="truncate font-medium text-black dark:text-fg">{r.name}</span>
                    <span className="truncate text-neutral-500 dark:text-fg-dim">{repo}</span>
                  </a>
                ))}
            </div>
          </>
        )}
      </SettingsSection>
    </div>
  );
}

/** Change: the page of a connected source, or its three setup steps. */
function OauthSourceForm({ app, api, onChanged }: { app: OauthSourcePageData; api: string; onChanged: () => void }) {
  const copy = COPY[app.kind];
  const [form, setForm] = useState<Form>(() => formOf(app));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const set = (k: keyof Form) => (v: string) => setForm((x) => ({ ...x, [k]: v }));
  const setHtmlUrl = (value: string) => setForm((x) => ({ ...x, htmlUrl: value, apiUrl: followHtmlUrl(app.kind, x.htmlUrl, x.apiUrl, value) }));
  const disabled = !app.canUpdate;
  const dirty = app.canUpdate && JSON.stringify(form) !== JSON.stringify(formOf(app));
  const err = (k: string) => errors[k];

  async function submit() {
    setSaving(true);
    const r = await postJson<{ message: string }>(
      api,
      {
        name: form.name,
        clientId: form.clientId === "" ? null : form.clientId,
        clientSecretInput: form.clientSecretInput === "" ? null : form.clientSecretInput,
        [FORM_WEBHOOK[app.kind]]: form.webhook === "" ? null : form.webhook,
        [FORM_FILTER[app.kind]]: form.filter === "" ? null : form.filter,
        htmlUrl: form.htmlUrl,
        apiUrl: form.apiUrl,
        customUser: form.customUser,
        customPort: form.customPort,
        privateKeyId: form.privateKeyId === "" ? null : form.privateKeyId,
      },
      "PATCH",
    );
    setSaving(false);
    if (!r.ok) return fieldErrors(r, setErrors);
    setErrors({});
    notify.success(r.data.message);
    onChanged();
  }

  async function testConnection() {
    const r = await postJson<{ message: string }>(`${api}/test`, {});
    if (!r.ok) return notify.error(summarize(r.error.messages));
    notify.success(r.data.message);
    onChanged();
  }

  const onSubmit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    void submit();
  };

  if (app.isConnected) {
    const keyOptions = [{ value: "", label: "None" }, ...app.privateKeys.map((k) => ({ value: String(k.id), label: k.name }))];
    const filter = app.kind === "gitlab" ? app.groupName : app.organization;
    return (
      <div>
        <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[24px]! leading-7! font-semibold! tracking-tight!">{app.name || copy.app}</h1>
              <StatusBadge label="Connected" type="success" />
            </div>
            <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">{filter ? copy.forFilter(filter) : copy.privateSource}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:ml-auto">
            <Button onClick={() => void testConnection()}>Test connection</Button>
            {app.canDelete ? <DeleteSource app={app} api={api} /> : null}
          </div>
        </header>
        <form onSubmit={onSubmit} className="application-settings-form flex flex-col gap-6">
          <UnsavedBar dirty={dirty} saving={saving} onSave={() => void submit()} />
          <SettingsSection title="General" helper="Name, visibility, and webhook of this source.">
            <div className="grid gap-4 lg:grid-cols-2">
              <FormInput id="name" label="Name" value={form.name} onChange={set("name")} disabled={disabled} error={err("name")} />
            </div>
            <SettingsSubsection title="Webhook" helper={copy.webhookHelper}>
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="lg:col-span-2">
                  <FormInput label="Webhook URL" readOnly value={oauthWebhookUrl(app.kind, edgeBase())} />
                </div>
                <FormInput id={FORM_WEBHOOK[app.kind]} label={copy.webhookLabel} type="password" value={form.webhook} onChange={set("webhook")} disabled={disabled} error={err(FORM_WEBHOOK[app.kind])} helper={copy.webhookFieldHelper} />
              </div>
            </SettingsSubsection>
          </SettingsSection>
          <SettingsSection id="connection-section" title="Connection" helper="OAuth credentials and the endpoints Freeploy uses to reach this source.">
            <SettingsSubsection first title="OAuth credentials" helper={copy.credentialsHelper}>
              <div className="grid gap-4 lg:grid-cols-2">
                <FormInput id="clientId" label={copy.clientIdLabel} value={form.clientId} onChange={set("clientId")} disabled={disabled} error={err("clientId")} />
                <FormInput
                  id="clientSecretInput"
                  label={copy.clientSecretLabel}
                  type="password"
                  value={form.clientSecretInput}
                  onChange={set("clientSecretInput")}
                  disabled={disabled}
                  error={err("clientSecretInput")}
                  helper="Stored encrypted. Leave empty to keep the existing secret."
                />
                <FormInput id={FORM_FILTER[app.kind]} label={copy.filterLabel} value={form.filter} onChange={set("filter")} disabled={disabled} error={err(FORM_FILTER[app.kind])} helper={copy.filterHelper} />
              </div>
            </SettingsSubsection>
            <SettingsSubsection title="Self-hosted / advanced" helper={copy.advancedHelper}>
              <div className="grid gap-4 lg:grid-cols-2">
                <FormInput id="htmlUrl" label={copy.htmlUrlLabel} value={form.htmlUrl} onChange={setHtmlUrl} disabled={disabled} error={err("htmlUrl")} />
                <FormInput id="apiUrl" label="API URL" value={form.apiUrl} onChange={set("apiUrl")} disabled={disabled} error={err("apiUrl")} />
                <FormInput id="customUser" label="SSH user" value={form.customUser} onChange={set("customUser")} disabled={disabled} error={err("customUser")} />
                <FormInput id="customPort" type="number" label="SSH port" value={form.customPort} onChange={set("customPort")} disabled={disabled} error={err("customPort")} />
                <div className="lg:col-span-2">
                  <Listbox id="privateKeyId" label="SSH private key (optional)" options={keyOptions} value={form.privateKeyId} onChange={set("privateKeyId")} disabled={disabled} error={err("privateKeyId")} />
                </div>
              </div>
            </SettingsSubsection>
          </SettingsSection>
        </form>
        <Resources app={app} />
      </div>
    );
  }

  const secretRequired = form.clientSecretInput === "" && !app.hasClientSecret;
  return (
    <div>
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-[24px]! leading-7! font-semibold! tracking-tight!">{app.name || copy.app}</h1>
          <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">Finish connecting this {copy.app} before using it as a source</p>
        </div>
        {app.canDelete ? (
          <div className="shrink-0 sm:ml-auto">
            <DeleteSource app={app} api={api} />
          </div>
        ) : null}
      </header>
      <div className="application-settings-form flex flex-col gap-6">
        <SettingsSection title="Step 1 · Create an OAuth application" helper={copy.step1Description}>
          <div className="flex flex-col gap-3 text-[12px] leading-5 text-neutral-600 dark:text-fg-dim">
            <a href={oauthApplicationsUrl(app.kind, app.htmlUrl)} target="_blank" rel="noopener noreferrer" className="inline-flex w-fit items-center gap-1 font-medium text-black underline-offset-2 hover:underline dark:text-fg">
              {oauthApplicationsUrl(app.kind, app.htmlUrl)}
              <ExternalLink />
            </a>
            <ul className="list-inside list-disc space-y-1.5">
              <li>
                Set <strong className="text-black dark:text-fg">Redirect URI</strong> to: <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] dark:bg-white/[0.06]">{app.redirectUri}</code>
              </li>
              {app.kind === "gitlab" ? (
                <>
                  <li>
                    Enable scopes: <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] dark:bg-white/[0.06]">api</code>, <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] dark:bg-white/[0.06]">read_user</code>,{" "}
                    <code className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] dark:bg-white/[0.06]">read_repository</code>
                  </li>
                  <li>
                    Uncheck <strong className="text-black dark:text-fg">Confidential</strong> if you run into issues
                  </li>
                </>
              ) : (
                <li>
                  Keep <strong className="text-black dark:text-fg">Confidential client</strong> checked
                </li>
              )}
            </ul>
          </div>
        </SettingsSection>
        <form onSubmit={onSubmit} className="contents">
          <SettingsSection
            title="Step 2 · Enter credentials"
            helper={copy.step2Description}
            actions={
              app.canUpdate ? (
                <Button type="submit" disabled={saving}>
                  Save
                </Button>
              ) : undefined
            }
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <FormInput id="name" label="Name" value={form.name} onChange={set("name")} disabled={disabled} error={err("name")} />
              <FormInput id="clientId" label={copy.clientIdLabel} required value={form.clientId} onChange={set("clientId")} disabled={disabled} error={err("clientId")} helper={copy.clientIdHelper} />
              <FormInput
                id="clientSecretInput"
                label={copy.clientSecretLabel}
                type="password"
                required={secretRequired}
                value={form.clientSecretInput}
                onChange={set("clientSecretInput")}
                disabled={disabled}
                error={err("clientSecretInput")}
                helper={copy.clientSecretHelper}
              />
              <FormInput id={FORM_FILTER[app.kind]} label={copy.filterLabel} value={form.filter} onChange={set("filter")} disabled={disabled} error={err(FORM_FILTER[app.kind])} helper={copy.step2FilterHelper} />
            </div>
            <Disclosure title="Advanced / self-hosted" open={advanced} onToggle={() => setAdvanced((o) => !o)} framed={false}>
              <FormInput id="htmlUrl" label={copy.htmlUrlLabel} value={form.htmlUrl} onChange={setHtmlUrl} disabled={disabled} error={err("htmlUrl")} helper={copy.advancedHtmlHelper} />
              <FormInput id="apiUrl" label="API URL" value={form.apiUrl} onChange={set("apiUrl")} disabled={disabled} error={err("apiUrl")} helper={copy.apiHelper} />
              <FormInput id="customUser" label="SSH user" value={form.customUser} onChange={set("customUser")} disabled={disabled} error={err("customUser")} />
              <FormInput id="customPort" type="number" label="SSH port" value={form.customPort} onChange={set("customPort")} disabled={disabled} error={err("customPort")} />
            </Disclosure>
          </SettingsSection>
        </form>
        {app.clientId && app.oauthState ? (
          <SettingsSection title={copy.step3Title} helper={copy.step3Description}>
            <a href={oauthAuthorizeUrl(app.kind, { htmlUrl: app.htmlUrl, clientId: app.clientId, redirectUri: app.redirectUri, state: app.oauthState })} className="button button-highlighted w-fit">
              {copy.connect}
              <ExternalLink />
            </a>
          </SettingsSection>
        ) : null}
      </div>
    </div>
  );
}

const uuidFromPath = (pathname = window.location.pathname): string => decodeURIComponent(pathname.split("/")[3] ?? "");

function OauthSourceContent({ kind }: { kind: OauthSourceKind }) {
  const { me } = useSignedIn();
  const uuid = uuidFromPath();
  const api = `${sourcesApi(me.team?.id)}/${kind}/${encodeURIComponent(uuid)}`;
  const [app, setApp] = useState<OauthSourcePageData | null>(null);
  const load = useCallback(async () => {
    const r = await getJson<OauthSourcePageData>(api);
    if (!r.data) {
      // ->firstOrFail(): not this org's.
      if (r.status === 404) window.location.replace("/sources");
      return;
    }
    setApp(r.data);
  }, [api]);
  useEffect(() => {
    void load();
    showSourceFlash();
  }, [load]);
  useEffect(() => {
    if (app) document.title = `${app.name || COPY[kind].app} | Sources | Freeploy`;
  }, [app, kind]);
  if (!app) return null;
  return <OauthSourceForm key={JSON.stringify(app)} app={app} api={api} onChanged={() => void load()} />;
}

export function OauthSourcePage({ kind }: { kind: OauthSourceKind }) {
  return (
    <Layout title="Sources" href="/sources" navHref="/sources" documentTitle="Sources">
      <OauthSourceContent kind={kind} />
    </Layout>
  );
}

// ── /webhooks/source/{gitlab,gitea}/redirect ────────────────────────────────────────────────────────────

/** Hands the instance's code to the API, then goes where Coolify's controller redirects, with its flash. */
function OauthCallback({ kind }: { kind: OauthSourceKind }) {
  const { me } = useSignedIn();
  useEffect(() => {
    void (async () => {
      const query = new URLSearchParams(window.location.search);
      const state = query.get("state");
      // The state names the org that started the authorization (the user may have switched orgs meanwhile).
      const org = setupStateOrg(state) ?? me.team?.id;
      const r = await postJson<{ redirect: string; error: string | null }>(`${sourcesApi(org)}/${kind}/redirect`, { code: query.get("code") ?? "", state: state ?? "" });
      if (!r.ok) {
        if (r.error.status !== 404) flash("error", summarize(r.error.messages));
        window.location.replace("/sources");
        return;
      }
      if (r.data.error) flash("error", r.data.error);
      window.location.replace(r.data.redirect);
    })();
  }, [kind, me.team?.id]);
  return <Empty title={`Connecting the ${COPY[kind].app}`} description="One moment…" iconName="sources" />;
}

export function OauthCallbackPage({ kind }: { kind: OauthSourceKind }) {
  return (
    <Layout title="Sources" href="/sources" navHref="/sources" documentTitle="Sources">
      <OauthCallback kind={kind} />
    </Layout>
  );
}
