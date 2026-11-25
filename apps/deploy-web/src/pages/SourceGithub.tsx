// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/source/github/{change,permissions,resources}.blade.php,
// resources/views/source/github/show.blade.php, app/Livewire/Source/Github/Change.php and
// app/Http/Controllers/Webhook/Github.php (redirect, install) (Apache-2.0), modified.
//
// A GitHub App source (DP-72): /source/github/{uuid} and its tabs /permissions, /resources and /danger. Before the
// App is registered the page offers Coolify's two ways: the automated installation (GitHub's manifest flow — the
// form posts the manifest to GitHub, which sends the browser back to /webhooks/source/github/redirect) and the
// manual one. Freeploy is a hosted service, so the automated card has no endpoint chooser, as Coolify Cloud's has
// none: the webhook is api-edge's public origin. /webhooks/source/github/redirect and /install are the pages GitHub
// returns to; they hand the manifest's code or the installation to the API and go on to the source's page.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { edgeBase, getJson, postJson, summarize } from "../lib/api";
import { githubManifest, setupStateOrg } from "../lib/github-manifest";
import { notify, toast } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Callout, DangerCallout, DangerZone, DashboardTitle, Empty, FormInput, Listbox, ModalConfirmation, SettingsSection, StatusBadge, UnsavedBar } from "../components/Coolify";
import { sourcesApi } from "./Sources";
import { flashSource as flash, showSourceFlash } from "../lib/source-flash";

export type GithubSourceTab = "general" | "permissions" | "resources" | "danger";

interface GithubAppPage {
  uuid: string;
  name: string;
  storedName: string;
  organization: string | null;
  apiUrl: string;
  htmlUrl: string;
  customUser: string;
  customPort: number;
  appId: number | null;
  installationId: number | null;
  installationAccount: string | null;
  accountName: string | null;
  clientId: string | null;
  clientSecret: string | null;
  webhookSecret: string | null;
  isSystemWide: boolean;
  privateKeyId: string | number | null;
  contents: string | null;
  metadata: string | null;
  pullRequests: string | null;
  deployments: string | null;
  organizationSelfHostedRunners: string | null;
  actions: string | null;
  webhookEvents: string[];
  missingDeploymentRequirements: string[];
  missingRunnerRequirements: string[];
  isConnected: boolean;
  privateKeys: Array<{ id: string | number; name: string }>;
  applications: Array<{ uuid: string; name: string; project_uuid: string; project_name: string; environment_uuid: string; environment_name: string }>;
  manifestState: string | null;
  installationUrl: string | null;
  settingsUrl: string;
  permissionsUrl: string;
  canUpdate: boolean;
  canDelete: boolean;
  canCreate: boolean;
}

const uuidFromPath = (pathname = window.location.pathname): string => decodeURIComponent(pathname.split("/")[3] ?? "");

/** The menu of a registered App: General, Permissions, Resources, then the Danger Zone. */
function Workspace({ app, tab, children }: { app: GithubAppPage; tab: GithubSourceTab; children: ReactNode }) {
  const base = `/source/github/${app.uuid}`;
  const items: Array<{ label: string; path: string; icon: string; key: GithubSourceTab }> = [
    { label: "General", path: "", icon: "settings", key: "general" },
    { label: "Permissions", path: "/permissions", icon: "keys", key: "permissions" },
    { label: "Resources", path: "/resources", icon: "grid", key: "resources" },
    { label: "Danger Zone", path: "/danger", icon: "danger", key: "danger" },
  ];
  return (
    <div>
      <DashboardTitle title={app.name || "GitHub App"} subtitle={app.organization ? `GitHub App for ${app.organization}` : "Private GitHub source"} />
      <section className="application-settings-workspace mt-4 w-full max-w-none lg:mt-0">
        <div className="grid min-w-0 gap-8 xl:grid-cols-[210px_minmax(0,1fr)] xl:gap-8">
          <aside className="application-settings-navigation min-w-0">
            <a href="/sources" className="menu-item mb-2" title="Back to Integrations">
              <Reicon name="arrow-left" className="menu-item-icon" />
              <span className="menu-item-label">Sources</span>
            </a>
            <nav aria-label="GitHub App settings" className="grid grid-cols-1 gap-0.5">
              {items.map((item) => (
                <div key={item.key} className="contents">
                  {item.key === "danger" ? <div className="col-span-full my-2 border-t border-neutral-200 dark:border-white/[0.06]" aria-hidden="true" /> : null}
                  <a className={item.key === tab ? "menu-item menu-item-active" : "menu-item"} href={base + item.path}>
                    <Reicon name={item.icon} className="menu-item-icon" />
                    <span className="menu-item-label">{item.label}</span>
                  </a>
                </div>
              ))}
            </nav>
          </aside>
          <div className="min-w-0">{children}</div>
        </div>
      </section>
    </div>
  );
}

const ExternalLink = () => <Reicon name="arrow-right" className="size-3.5 -rotate-45" />;

interface Form {
  name: string;
  organization: string;
  htmlUrl: string;
  apiUrl: string;
  customUser: string;
  customPort: string;
  appId: string;
  installationId: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  privateKeyId: string;
}

const formOf = (a: GithubAppPage): Form => ({
  name: a.name,
  organization: a.organization ?? "",
  htmlUrl: a.htmlUrl,
  apiUrl: a.apiUrl,
  customUser: a.customUser,
  customPort: String(a.customPort),
  appId: a.appId === null ? "" : String(a.appId),
  installationId: a.installationId === null ? "" : String(a.installationId),
  clientId: a.clientId ?? "",
  clientSecret: a.clientSecret ?? "",
  webhookSecret: a.webhookSecret ?? "",
  privateKeyId: a.privateKeyId === null ? "" : String(a.privateKeyId),
});

/** General of a registered App: the installation step, or the form with its actions. */
function General({ app, api, onChanged }: { app: GithubAppPage; api: string; onChanged: () => void }) {
  const [form, setForm] = useState<Form>(() => formOf(app));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const dirty = app.canUpdate && JSON.stringify(form) !== JSON.stringify(formOf(app));
  const set = (k: keyof Form) => (v: string) => setForm((x) => ({ ...x, [k]: v }));
  const disabled = !app.canUpdate;

  if (app.installationId === null) {
    return (
      <div className="application-settings-form">
        <SettingsSection title="Complete GitHub installation" helper="Choose which repositories this GitHub App can access before using it as a source.">
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning/10 text-warning">
                <Reicon name="alert-triangle" className="size-4" />
              </div>
              <p className="max-w-xl text-[12px] leading-5 text-neutral-500 dark:text-fg-dim">Repository access has not been installed yet. Complete this step before attaching the source to an application.</p>
            </div>
            {app.canUpdate && app.installationUrl ? (
              <a className="button shrink-0 button-highlighted" href={app.installationUrl}>
                Install repositories
                <ExternalLink />
              </a>
            ) : null}
          </div>
        </SettingsSection>
      </div>
    );
  }

  const body = () => ({ ...form, organization: form.organization === "" ? null : form.organization, appId: form.appId === "" ? null : form.appId, installationId: form.installationId === "" ? null : form.installationId, privateKeyId: form.privateKeyId === "" ? null : form.privateKeyId });

  async function submit() {
    setSaving(true);
    const r = await postJson<{ message: string }>(api, body(), "PATCH");
    setSaving(false);
    if (!r.ok) {
      const inline: Record<string, string> = {};
      for (const [k, m] of Object.entries(r.error.fields ?? {})) if (m[0]) inline[k] = m[0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    notify.success(r.data.message);
    onChanged();
  }

  async function action(path: string, payload: unknown = {}) {
    const r = await postJson<{ message: string; kind?: "success" | "info" }>(`${api}/${path}`, payload);
    if (!r.ok) return notify.error(summarize(r.error.messages));
    if (r.data.kind === "info") toast(r.data.message, { type: "info" });
    else notify.success(r.data.message);
    onChanged();
  }

  /** instantSave(): the private key listbox saves at once. */
  async function choosePrivateKey(value: string) {
    setForm((x) => ({ ...x, privateKeyId: value }));
    const r = await postJson<{ message: string }>(api, { instantSave: true, privateKeyId: value === "" || value === "0" ? null : value }, "PATCH");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    notify.success(r.data.message);
    onChanged();
  }

  const keyOptions = [...(app.privateKeyId === null ? [{ value: "0", label: "Select a private key" }] : []), ...app.privateKeys.map((k) => ({ value: String(k.id), label: k.name }))];
  return (
    <form
      className="application-settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <UnsavedBar dirty={dirty} saving={saving} onSave={() => void submit()} />
      <SettingsSection
        title="General"
        helper="Connection and authentication settings for this private GitHub source."
        actions={
          app.canUpdate ? (
            <>
              {app.isConnected ? <Button onClick={() => void action("test")}>Test connection</Button> : null}
              <Button onClick={() => void action("sync-name", { appId: form.appId === "" ? null : form.appId, privateKeyId: form.privateKeyId === "" ? null : form.privateKeyId })}>
                <Reicon name="refresh" className="size-3.5" />
                Sync name
              </Button>
              <a href={app.settingsUrl} className="button">
                Rename
                <ExternalLink />
              </a>
              {app.installationUrl ? (
                <a href={app.installationUrl} className="button">
                  Repositories
                  <ExternalLink />
                </a>
              ) : null}
            </>
          ) : undefined
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <FormInput id="name" label="App name" value={form.name} onChange={set("name")} disabled={disabled} error={errors.name} />
          <FormInput id="organization" label="Organization" placeholder="Personal account when empty" value={form.organization} onChange={set("organization")} disabled={disabled} error={errors.organization} />
          <FormInput id="htmlUrl" label="HTML URL" value={form.htmlUrl} onChange={set("htmlUrl")} disabled={disabled} error={errors.htmlUrl} />
          <FormInput id="apiUrl" label="API URL" value={form.apiUrl} onChange={set("apiUrl")} disabled={disabled} error={errors.apiUrl} />
          <FormInput id="customUser" label="User" required value={form.customUser} onChange={set("customUser")} disabled={disabled} error={errors.customUser} />
          <FormInput id="customPort" type="number" label="Port" required value={form.customPort} onChange={set("customPort")} disabled={disabled} error={errors.customPort} />
          <FormInput id="appId" type="number" label="App ID" required value={form.appId} onChange={set("appId")} disabled={disabled} error={errors.appId} />
          <FormInput
            id="installationId"
            type="number"
            label="Installation ID"
            required
            value={form.installationId}
            onChange={set("installationId")}
            disabled={disabled}
            error={errors.installationId}
            helper={`${app.installationAccount ? `Installed on ${app.installationAccount}. ` : ""}To use this GitHub App with another account or organization, click Repositories and install it there. Freeploy adds a new source for each installation.`}
          />
          <FormInput id="clientId" type="password" label="Client ID" required value={form.clientId} onChange={set("clientId")} disabled={disabled} error={errors.clientId} />
          <FormInput id="clientSecret" type="password" label="Client secret" required value={form.clientSecret} onChange={set("clientSecret")} disabled={disabled} error={errors.clientSecret} />
          <FormInput id="webhookSecret" type="password" label="Webhook secret" required value={form.webhookSecret} onChange={set("webhookSecret")} disabled={disabled} error={errors.webhookSecret} />
          <Listbox id="privateKeyId" label="Private key" required options={keyOptions} value={form.privateKeyId === "" ? "0" : form.privateKeyId} onChange={(v) => void choosePrivateKey(v)} disabled={disabled} error={errors.privateKeyId} />
        </div>
      </SettingsSection>
    </form>
  );
}

/** livewire/source/github/permissions. */
function Permissions({ app, api, onChanged }: { app: GithubAppPage; api: string; onChanged: () => void }) {
  async function refetch() {
    const r = await postJson<{ message: string }>(`${api}/permissions`, {});
    if (!r.ok) return notify.error(summarize(r.error.messages));
    notify.success(r.data.message);
    onChanged();
  }
  const update = (
    <a href={app.permissionsUrl} className="button" target="_blank" rel="noopener noreferrer">
      Update on GitHub
      <ExternalLink />
    </a>
  );
  const missing = (title: string, list: string[]) =>
    list.length ? (
      <Callout type="info" title={title} className="mt-4">
        Update the App on GitHub, then click Refetch. Missing:
        <ul className="mt-1 list-disc pl-4">
          {list.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <div className="mt-2">{update}</div>
      </Callout>
    ) : null;
  return (
    <div className="application-settings-form flex flex-col gap-6">
      <SettingsSection
        title="Permissions"
        helper="GitHub permissions currently granted to this App."
        actions={
          <>
            {app.canUpdate ? (
              <Button onClick={() => void refetch()}>
                <Reicon name="refresh" className="size-3.5" />
                Refetch
              </Button>
            ) : null}
            <a href={app.permissionsUrl} className="button">
              Update on GitHub
              <ExternalLink />
            </a>
          </>
        }
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <FormInput id="contents" label="Contents" helper="Read access is mandatory." readOnly placeholder="N/A" value={app.contents ?? ""} />
          <FormInput id="metadata" label="Metadata" helper="Read access is mandatory." readOnly placeholder="N/A" value={app.metadata ?? ""} />
          <FormInput id="pullRequests" label="Pull requests" helper="Write access is needed for preview deployment status updates." readOnly placeholder="N/A" value={app.pullRequests ?? ""} />
        </div>
      </SettingsSection>
      <SettingsSection title="GitHub deployments" helper="Freeploy creates a GitHub deployment for each deployment and updates its status, so branches and pull requests show what is deployed.">
        <div className="grid gap-4 lg:grid-cols-3">
          <FormInput label="Deployments" readOnly placeholder="N/A" value={app.deployments ?? ""} helper="Repository permission. Write access is needed to create deployments and their statuses." />
        </div>
        {missing("Not ready for GitHub deployments", app.missingDeploymentRequirements)}
      </SettingsSection>
      <SettingsSection title="GitHub Actions runners" helper="Your servers can run the organization's workflow jobs in Docker containers. Configure them in the GitHub Runners menu of a server.">
        <div className="grid gap-4 lg:grid-cols-3">
          <FormInput label="Self-hosted runners" readOnly placeholder="N/A" value={app.organizationSelfHostedRunners ?? ""} helper="Organization permission. Write access is needed to register runners." />
          <FormInput label="Actions" readOnly placeholder="N/A" value={app.actions ?? ""} helper="Repository permission. Read access is needed for the Workflow job webhook event." />
          <FormInput label="Webhook events" readOnly placeholder="N/A" value={app.webhookEvents.join(", ")} helper="Refetch to update this list after you change the App on GitHub." />
        </div>
        {missing("Not ready for runners", app.missingRunnerRequirements)}
      </SettingsSection>
    </div>
  );
}

/** livewire/source/github/resources. */
function Resources({ app }: { app: GithubAppPage }) {
  const [search, setSearch] = useState("");
  const q = search.toLowerCase();
  const rows = [...app.applications].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const COLS = "grid-cols-[minmax(10rem,.8fr)_minmax(10rem,.8fr)_minmax(12rem,1fr)_8rem]";
  return (
    <div className="application-settings-form">
      <SettingsSection title="Resources" helper="Applications currently using this GitHub App." flush>
        {rows.length === 0 ? (
          <Empty title="No resources use this source" description="Applications will appear here after this GitHub App is selected as their source." iconName="sources" size="sm" />
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
                <div>Type</div>
              </div>
              {rows
                .filter((r) => q === "" || `${r.project_name} ${r.environment_name} ${r.name} application`.toLowerCase().includes(q))
                .map((r) => (
                  <a
                    key={r.uuid}
                    href={`/project/${r.project_uuid}/environment/${r.environment_uuid}/application/${r.uuid}`}
                    className={`grid min-h-13 min-w-[680px] ${COLS} items-center border-b border-neutral-200 px-4 py-2.5 text-[12px] transition-colors last:border-b-0 hover:bg-neutral-50 hover:no-underline dark:border-white/[0.07] dark:hover:bg-white/[0.025]`}
                  >
                    <span className="truncate text-neutral-500 dark:text-fg-dim">{r.project_name}</span>
                    <span className="truncate text-neutral-500 dark:text-fg-dim">{r.environment_name}</span>
                    <span className="truncate font-medium text-black dark:text-fg">{r.name}</span>
                    <span className="text-neutral-500 dark:text-fg-dim">Application</span>
                  </a>
                ))}
            </div>
          </>
        )}
      </SettingsSection>
    </div>
  );
}

/** The delete confirmation of the App, as Coolify's modal asks for it. */
function DeleteApp({ app, api, trigger }: { app: GithubAppPage; api: string; trigger?: ReactNode }) {
  return (
    <ModalConfirmation
      title="Confirm GitHub App Deletion?"
      buttonTitle="Delete"
      {...(trigger ? { trigger } : {})}
      actions={["The selected GitHub App will be permanently deleted."]}
      confirmationText={app.storedName}
      confirmationLabel="Please confirm the execution of the actions by entering the GitHub App Name below"
      shortConfirmationLabel="GitHub App Name"
      step2ButtonText="Permanently Delete"
      onSubmit={async () => {
        const r = await postJson<{ redirect: string }>(api, {}, "DELETE");
        if (!r.ok) return notify.error(summarize(r.error.messages));
        window.location.assign(r.data.redirect);
      }}
    />
  );
}

function Danger({ app, api }: { app: GithubAppPage; api: string }) {
  return (
    <div className="application-settings-form">
      <SettingsSection id="github-app-danger-section" title="Danger zone" helper="Destructive actions for this GitHub App source cannot be undone.">
        <DangerZone
          title="Delete GitHub App"
          action={
            app.canDelete ? (
              <DeleteApp app={app} api={api} />
            ) : (
              <Button error disabled tooltip="You do not have permission to delete this GitHub App.">
                Delete
              </Button>
            )
          }
        >
          <p>
            Permanently delete <strong className="font-semibold text-black dark:text-fg">{app.name || "this GitHub App"}</strong> from Freeploy. Applications using this source will need another Git provider configured.
          </p>
          <ul className="space-y-1 text-xs">
            <li>• The App registration on GitHub is not removed automatically.</li>
            <li>• Linked applications keep their Git settings until you change them.</li>
            <li>• This source cannot be restored from Freeploy after deletion.</li>
          </ul>
        </DangerZone>
        {!app.canDelete ? (
          <div className="mt-4">
            <DangerCallout className="" title="Insufficient permissions">
              Contact a team administrator if this GitHub App must be deleted.
            </DangerCallout>
          </div>
        ) : null}
      </SettingsSection>
    </div>
  );
}

/** Before the App is registered: the automated (manifest) and the manual installation. */
function Register({ app, api, onChanged }: { app: GithubAppPage; api: string; onChanged: () => void }) {
  const query = new URLSearchParams(window.location.search);
  const [previews, setPreviews] = useState(query.get("previews") !== "0");
  const [deployments, setDeployments] = useState(true);

  /** createGithubApp(): the manifest, posted to GitHub in a form. */
  function register() {
    if (!app.manifestState) return;
    const { action, manifest } = githubManifest({
      name: app.name,
      organization: app.organization,
      htmlUrl: app.htmlUrl,
      state: app.manifestState,
      webOrigin: window.location.origin,
      edgeOrigin: edgeBase(),
      previewDeploymentPermissions: previews,
      deploymentStatusPermissions: deployments,
      administration: false,
    });
    const form = document.createElement("form");
    form.setAttribute("method", "post");
    form.setAttribute("action", action);
    const input = document.createElement("input");
    input.setAttribute("id", "manifest");
    input.setAttribute("name", "manifest");
    input.setAttribute("type", "hidden");
    input.setAttribute("value", JSON.stringify(manifest));
    form.appendChild(input);
    document.getElementsByTagName("body")[0]!.appendChild(form);
    form.submit();
  }

  async function manually() {
    const r = await postJson<{ message: string }>(`${api}/manual`, {});
    if (!r.ok) return notify.error(summarize(r.error.messages));
    flash("success", r.data.message);
    onChanged();
  }

  return (
    <div>
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-[24px]! leading-7! font-semibold! tracking-tight!">{app.name || "GitHub App"}</h1>
          <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">Finish registering this GitHub App before using it as a source</p>
        </div>
        {app.canDelete ? (
          <div className="shrink-0">
            <DeleteApp app={app} api={api} />
          </div>
        ) : null}
      </header>
      {app.canCreate ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="application-settings-form flex">
            <SettingsSection title="Automated installation" helper="Register through GitHub's manifest flow with permissions and webhooks preconfigured." className="w-full" badges={<StatusBadge label="Recommended" type="success" />}>
              <div className="flex min-h-[24rem] flex-1 flex-col gap-4">
                <p className="text-[12px] leading-5 text-neutral-500 dark:text-fg-dim">Register the GitHub App before using this source.</p>
                <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-[12px] leading-5 text-neutral-600 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-dim">
                  <p className="font-medium text-black dark:text-fg">Mandatory permissions</p>
                  <p className="mt-1">Contents: read · Metadata: read · Email: read</p>
                </div>
                <Listbox
                  id="preview_deployment_permissions"
                  label="Preview deployment access"
                  helper="Write access lets Freeploy post deployment status and links on pull requests."
                  options={[
                    { value: "false", label: "Do not update pull requests" },
                    { value: "true", label: "Read and update pull requests" },
                  ]}
                  value={String(previews)}
                  onChange={(v) => setPreviews(v === "true")}
                />
                <Listbox
                  id="deployment_status_permissions"
                  label="GitHub deployments"
                  helper="Deployments (write) access lets Freeploy show each deployment and its status on GitHub, so pull requests show the preview as deployed."
                  options={[
                    { value: "false", label: "Do not create GitHub deployments" },
                    { value: "true", label: "Create GitHub deployments" },
                  ]}
                  value={String(deployments)}
                  onChange={(v) => setDeployments(v === "true")}
                />
                <button type="button" className="button mt-auto w-full justify-center button-highlighted" onClick={register} disabled={!app.manifestState}>
                  Register with GitHub
                </button>
              </div>
            </SettingsSection>
          </div>
          <div className="application-settings-form flex">
            <SettingsSection title="Manual installation" helper="Enter GitHub App credentials manually for GitHub Enterprise or custom permission sets." className="w-full" badges={<StatusBadge label="Advanced" type="neutral" />}>
              <div className="flex min-h-[24rem] flex-1 flex-col">
                <div className="flex size-10 items-center justify-center rounded-xl border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-fg-dim">
                  <Reicon name="settings" className="size-5" />
                </div>
                <p className="mt-4 max-w-md text-[12px] leading-5 text-neutral-500 dark:text-fg-dim">Use this path when the automated GitHub manifest flow is unavailable or you need complete control over the App configuration.</p>
                <button type="button" className="button mt-auto w-fit" onClick={() => void manually()}>
                  Continue manually
                  <Reicon name="arrow-right" className="size-3.5" />
                </button>
              </div>
            </SettingsSection>
          </div>
        </div>
      ) : (
        <DangerCallout className="" title="Insufficient permissions">
          You do not have permission to create GitHub Apps. Contact your team administrator.
        </DangerCallout>
      )}
    </div>
  );
}

function GithubSourceContent({ tab }: { tab: GithubSourceTab }) {
  const { me } = useSignedIn();
  const uuid = uuidFromPath();
  const api = `${sourcesApi(me.team?.id)}/github/${encodeURIComponent(uuid)}`;
  const [app, setApp] = useState<GithubAppPage | null>(null);
  const load = useCallback(async () => {
    const r = await getJson<GithubAppPage>(api);
    if (!r.data) {
      // ownedByCurrentTeam()->firstOrFail(): not this org's.
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
    if (app) document.title = `${app.name || "GitHub App"} | Sources | Freeploy`;
  }, [app]);
  if (!app) return null;
  if (app.appId === null) return <Register app={app} api={api} onChanged={() => void load()} />;
  let content: ReactNode;
  if (tab === "permissions") content = <Permissions app={app} api={api} onChanged={() => void load()} />;
  else if (tab === "resources") content = <Resources app={app} />;
  else if (tab === "danger") content = <Danger app={app} api={api} />;
  else content = <General key={JSON.stringify(app)} app={app} api={api} onChanged={() => void load()} />;
  return (
    <Workspace app={app} tab={tab}>
      {content}
    </Workspace>
  );
}

export function GithubSourcePage({ tab }: { tab: GithubSourceTab }) {
  return (
    <Layout title="Sources" href="/sources" navHref="/sources" documentTitle="Sources">
      <GithubSourceContent tab={tab} />
    </Layout>
  );
}

// ── /webhooks/source/github/redirect and /install ───────────────────────────────────────────────────────

/** Hands what GitHub sent back to the API, then goes where Coolify's controller redirects. */
function SetupCallback({ kind }: { kind: "redirect" | "install" }) {
  const { me } = useSignedIn();
  useEffect(() => {
    void (async () => {
      const query = new URLSearchParams(window.location.search);
      const state = query.get("state");
      // The state names the org that started the setup (the user may have switched orgs on GitHub); an
      // "update" of an installation has none and goes to the current org's source.
      const org = setupStateOrg(state) ?? me.team?.id;
      const body = kind === "redirect" ? { code: query.get("code") ?? "", state } : { installation_id: query.get("installation_id") ?? "", setup_action: query.get("setup_action") ?? "", state };
      const r = await postJson<{ redirect: string; error: string | null; success?: string | null }>(`${sourcesApi(org)}/github/${kind}`, body);
      if (!r.ok) {
        // An invalid state is Coolify's redirect to the Sources page; anything else an error page's message.
        if (r.error.status !== 404) flash("error", summarize(r.error.messages));
        window.location.replace("/sources");
        return;
      }
      if (r.data.error) flash("error", r.data.error);
      else if (r.data.success) flash("success", r.data.success);
      window.location.replace(r.data.redirect);
    })();
  }, [kind, me.team?.id]);
  return <Empty title={kind === "redirect" ? "Registering the GitHub App" : "Installing the GitHub App"} description="One moment…" iconName="sources" />;
}

export function GithubSetupCallbackPage({ kind }: { kind: "redirect" | "install" }) {
  return (
    <Layout title="Sources" href="/sources" navHref="/sources" documentTitle="Sources">
      <SetupCallback kind={kind} />
    </Layout>
  );
}
