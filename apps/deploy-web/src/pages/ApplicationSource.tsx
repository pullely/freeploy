// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/application/source.blade.php and
// app/Livewire/Project/Application/Source.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/source
// (project.application.source): the repository, branch and commit; the SSH
// host keys git accepts; the HTTPS credentials of a custom Git host; the
// deploy key; and the Git source.
import { useState } from "react";
import { Layout } from "../layout/Layout";
import { Reicon } from "../components/Reicon";
import { Button, Empty, FormInput, FormTextarea, ModalConfirmation, SettingsSection, StatusBadge, UnsavedBar } from "../components/Coolify";
import { applicationsApi, ApplicationWorkspace } from "./ApplicationChrome";
import { inlineErrors, useApplicationSection, type ApplicationSectionData } from "./ApplicationSection";
import { sendJson, showError, showSaved } from "./ApplicationResource";

interface SourceOption {
  id: string;
  kind: "github" | "gitlab" | "gitea";
  type: string;
  name: string;
  subtitle: string;
}

interface HostKey {
  id: string;
  published: boolean;
  host: string;
  type: string;
  fingerprint: string;
}

interface Source {
  gitRepository: string;
  gitBranch: string;
  gitCommitSha: string | null;
  gitBranchLocation: string | null;
  gitCommits: string | null;
  deploymentType: "deploy_key" | "source" | "other";
  usesGitSsh: boolean;
  gitSshKnownHosts: string | null;
  hostKeys: HostKey[];
  gitHttpsUsername: string | null;
  hasGitHttpsPassword: boolean;
  privateKeyId: string | null;
  privateKeyName: string | null;
  privateKeys: Array<{ id: string; name: string }>;
  currentSource: SourceOption | null;
  sources: SourceOption[];
}

type Data = ApplicationSectionData & { source: Source };
type Saved = { source: Source; message: string; unavailable?: string };

const HOST_KEYS_HELPER =
  "The host keys that git over SSH accepts for self-hosted Git hosts. On the first deployment, Freeploy saves the key that the host sends, and later deployments fail if the key changes. To accept a new key (also of a submodule host), click Fetch current host key, compare the fingerprint with the fingerprint from the administrator of the Git host, and click Accept. GitHub, GitLab.com, and Bitbucket Cloud always accept their published keys. If GitHub or Bitbucket Cloud changes its keys, click Fetch current host key to read the new keys from their official HTTPS endpoint. If GitLab.com changes its keys, click Fetch current host key and compare the fingerprint with the keys on docs.gitlab.com.";
const ROW = "grid min-h-14 w-full grid-cols-[minmax(0,1fr)_7rem] items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-white/[0.025] border-b border-neutral-200 last:border-b-0 dark:border-white/[0.07]";
const ICON_BOX = "flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim";
const HEAD = "items-center gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[13px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint";
const HOST_GRID = "grid grid-cols-[minmax(0,1fr)_7rem_minmax(0,2fr)_1.75rem]";

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a target="_blank" rel="noreferrer" className="button" href={href}>
      {children}
      <Reicon name="external-link" className="size-3.5" />
    </a>
  );
}

function ApplicationSourceContent() {
  const { me, data, setData, saving, patch } = useApplicationSection<Data>("source");
  const [form, setForm] = useState({ gitRepository: "", gitBranch: "", gitCommitSha: "", gitSshKnownHosts: "", gitHttpsUsername: "", gitHttpsPassword: "" });
  const [loaded, setLoaded] = useState(form);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [editManually, setEditManually] = useState(false);
  const [busy, setBusy] = useState("");
  const source = data?.source;

  /** syncData(false): the form from the model, whenever the model arrives or changes; the password field is always empty. */
  const [synced, setSynced] = useState<Source | null>(null);
  if (source && synced !== source) {
    const next = { gitRepository: source.gitRepository, gitBranch: source.gitBranch, gitCommitSha: source.gitCommitSha ?? "", gitSshKnownHosts: source.gitSshKnownHosts ?? "", gitHttpsUsername: source.gitHttpsUsername ?? "", gitHttpsPassword: "" };
    setSynced(source);
    setForm(next);
    setLoaded(next);
  }
  if (!data || !source) return null;
  const { application, canUpdate } = data;
  const base = `${applicationsApi(me.team?.id)}/${encodeURIComponent(application.uuid)}/source`;
  const set = (field: keyof typeof form) => (value: string) => setForm({ ...form, [field]: value });
  const dirty = (Object.keys(form) as Array<keyof typeof form>).some((k) => form[k] !== loaded[k]);
  const apply = (saved: Saved) => {
    setData({ ...data, source: saved.source });
    setErrors({});
    showSaved(saved);
  };

  /** Source::submit() */
  async function submit() {
    const r = await patch<Saved>({ ...form, loadedGitSshKnownHosts: loaded.gitSshKnownHosts });
    if (!r.ok) {
      setErrors(inlineErrors(r.error));
      // dispatch('known-hosts-invalid'): the manual editor opens on its error.
      if (r.error.fields.gitSshKnownHosts) setEditManually(true);
      else showError(r.error);
      return;
    }
    apply(r.data);
  }

  async function send(method: "POST" | "DELETE", path: string, body?: Record<string, unknown>) {
    setBusy(path);
    const r = await sendJson<Saved>(method, base + path, body);
    setBusy("");
    if (!r.ok) return showError(r.error);
    apply(r.data);
  }

  const showHostKeys = source.usesGitSsh || Boolean(source.gitSshKnownHosts);
  return (
    <ApplicationWorkspace application={application} orgId={me.team?.id} active="Git Source" canUpdate={canUpdate} canDeploy={data.canDeploy}>
      <div className="application-settings-form flex flex-col gap-6">
        <form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <UnsavedBar dirty={dirty} saving={saving} onSave={() => void submit()} />

          <SettingsSection
            title="Repository"
            helper="Configure the Git repository, branch, and commit Freeploy deploys."
            actions={
              <div className="flex flex-wrap items-center gap-2">
                {source.gitBranchLocation ? <ExternalLink href={source.gitBranchLocation}>Repository</ExternalLink> : null}
                {source.gitCommits ? <ExternalLink href={source.gitCommits}>Commits</ExternalLink> : null}
              </div>
            }
          >
            <div className="grid gap-4 lg:grid-cols-2">
              <FormInput id="gitRepository" label="Repository" placeholder="coollabsio/coolify-example" value={form.gitRepository} onChange={set("gitRepository")} disabled={!canUpdate} error={errors.gitRepository} />
              <FormInput id="gitBranch" label="Branch" placeholder="main" value={form.gitBranch} onChange={set("gitBranch")} disabled={!canUpdate} error={errors.gitBranch} />
              <FormInput id="gitCommitSha" label="Commit SHA" placeholder="HEAD" value={form.gitCommitSha} onChange={set("gitCommitSha")} disabled={!canUpdate} error={errors.gitCommitSha} />
            </div>
          </SettingsSection>

          {showHostKeys ? (
            <SettingsSection
              id="ssh-host-keys"
              title="SSH host keys"
              helper={HOST_KEYS_HELPER}
              flush
              actions={
                canUpdate ? (
                  <>
                    <button type="button" className="button" onClick={() => setEditManually(!editManually)} aria-expanded={editManually} aria-controls="manual-host-keys">
                      <Reicon name="edit" className="size-3.5" />
                      Edit manually
                    </button>
                    <Button disabled={busy === "/host-keys/fetch"} onClick={() => void send("POST", "/host-keys/fetch")}>
                      Fetch current host key
                    </Button>
                  </>
                ) : undefined
              }
            >
              {source.hostKeys.length === 0 ? (
                <Empty size="sm" iconName="keys" title="No saved host keys" description="The next deployment saves the key that the Git host sends. To save it now, click Fetch current host key." />
              ) : (
                <div className="data-table">
                  <div className="min-w-[36rem]">
                    <div className={`${HOST_GRID} ${HEAD}`}>
                      <span className="pl-11">Host</span>
                      <span>Type</span>
                      <span>Fingerprint</span>
                      <span />
                    </div>
                    <ul className="divide-y divide-neutral-200 dark:divide-white/[0.07]">
                      {source.hostKeys.map((key) => (
                        <li key={key.id} className={`${HOST_GRID} min-h-14 items-center gap-3 px-4 py-2.5 transition-colors hover:bg-neutral-50 dark:hover:bg-white/[0.025]`}>
                          <div className="flex min-w-0 items-center gap-3">
                            <div className={ICON_BOX}>
                              <Reicon name="keys" className="size-4" />
                            </div>
                            <div className="min-w-0">
                              <span className="break-all text-[13px] font-semibold text-black dark:text-fg">{key.host}</span>
                              {key.published ? <p className="text-[12px] text-neutral-500 dark:text-fg-dim">Published by the provider, used for every deployment</p> : null}
                            </div>
                          </div>
                          <span className="text-[12px] text-neutral-500 dark:text-fg-dim">{key.type}</span>
                          <span className="break-all font-mono text-[12px] text-neutral-500 dark:text-fg-dim">{key.fingerprint}</span>
                          {key.published || !canUpdate ? (
                            <span />
                          ) : (
                            <ModalConfirmation
                              title="Remove host key?"
                              buttonTitle="Remove"
                              actions={[`The host key ${key.fingerprint} of ${key.host} will be removed.`, "The next deployment saves the key that the Git host sends then, without a check."]}
                              confirmationText={null}
                              step2ButtonText="Remove host key"
                              onSubmit={() => send("DELETE", `/host-keys/${key.id}`)}
                              trigger={
                                <button type="button" className="icon-button shrink-0 text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300" title="Remove host key" aria-label={`Remove host key of ${key.host}`}>
                                  <Reicon name="trash" className="size-3.5" />
                                </button>
                              }
                            />
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              {canUpdate && editManually ? (
                <div id="manual-host-keys" className="p-4">
                  <FormTextarea
                    id="gitSshKnownHosts"
                    rows={4}
                    label="Known hosts"
                    helper="One line for each key: host key-type key. Use [host]:port for a custom SSH port. GitHub and Bitbucket Cloud use their published keys and cannot be added here. Click Save to apply."
                    placeholder="[git.example.com]:2222 ssh-ed25519 AAAA..."
                    value={form.gitSshKnownHosts}
                    onChange={set("gitSshKnownHosts")}
                    error={errors.gitSshKnownHosts}
                  />
                </div>
              ) : null}
            </SettingsSection>
          ) : null}

          {source.deploymentType === "other" ? (
            <SettingsSection
              title="HTTPS credentials"
              helper="The username and password or access token Freeploy uses to clone a private repository from a custom Git host (Azure DevOps, Bitbucket, Gitea, and others) over HTTP(S). Freeploy sends them only to the host of the repository URL and never shows the saved password or token."
              actions={
                source.hasGitHttpsPassword && canUpdate ? (
                  <Button error onClick={() => void send("DELETE", "/https-credentials")}>
                    Remove credentials
                  </Button>
                ) : undefined
              }
            >
              <div className="grid gap-4 lg:grid-cols-2">
                <FormInput id="gitHttpsUsername" label="Username" helper="Some hosts accept any username with an access token (for example Azure DevOps)." value={form.gitHttpsUsername} onChange={set("gitHttpsUsername")} disabled={!canUpdate} error={errors.gitHttpsUsername} />
                <FormInput
                  id="gitHttpsPassword"
                  type="password"
                  label="Password or token"
                  placeholder={source.hasGitHttpsPassword ? "Saved. Enter a new value to replace it." : ""}
                  value={form.gitHttpsPassword}
                  onChange={set("gitHttpsPassword")}
                  disabled={!canUpdate}
                  error={errors.gitHttpsPassword}
                />
              </div>
            </SettingsSection>
          ) : null}
        </form>

        {source.privateKeyId !== null ? (
          <SettingsSection title="Deploy key" helper="The SSH key Freeploy uses to clone this private repository." flush>
            <div className="data-table">
              <div className={`grid grid-cols-[minmax(0,1fr)_7rem] ${HEAD}`}>
                <span className="pl-11">Private key</span>
                <span className="text-right">Selection</span>
              </div>
              <div className={ROW}>
                <div className="flex min-w-0 items-center gap-3">
                  <div className={ICON_BOX}>
                    <Reicon name="keys" className="size-4" />
                  </div>
                  <span className="truncate text-[13px] font-semibold text-black dark:text-fg">{source.privateKeyName}</span>
                </div>
                <div className="flex justify-end">
                  <StatusBadge label="Selected" type="success" />
                </div>
              </div>
              {canUpdate
                ? source.privateKeys.map((key) => (
                    <div key={key.id} className={ROW}>
                      <div className="flex min-w-0 items-center gap-3">
                        <div className={ICON_BOX}>
                          <Reicon name="keys" className="size-4" />
                        </div>
                        <span className="truncate text-[13px] font-semibold text-black dark:text-fg">{key.name}</span>
                      </div>
                      <div className="flex justify-end">
                        <button
                          type="button"
                          disabled={busy === "/private-key"}
                          title={`Select ${key.name}`}
                          aria-label={`Select ${key.name}`}
                          className="icon-button disabled:cursor-wait disabled:opacity-60"
                          onClick={() => void send("POST", "/private-key", { privateKeyId: key.id })}
                        >
                          <Reicon name="link" className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                : null}
            </div>
          </SettingsSection>
        ) : canUpdate ? (
          <SettingsSection title="Git source" helper="Switch the Git provider App Freeploy uses to clone this repository.">
            <div className="grid gap-2 sm:grid-cols-2">
              {source.currentSource ? (
                <div
                  className="relative flex min-h-16 items-center gap-3 rounded-xl border border-coollabs/30 bg-coollabs/[0.06] p-3 ring-1 ring-coollabs/20 dark:border-brand-light/30 dark:bg-brand/[0.12] dark:ring-brand-light/15"
                  aria-current="true"
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-coollabs/20 bg-white text-coollabs dark:border-brand-light/20 dark:bg-white/[0.04] dark:text-brand-light">
                    <Reicon name="sources" className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-[13px] font-semibold text-black dark:text-fg">{source.currentSource.name}</span>
                      <StatusBadge label="Current" type="success" />
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{source.currentSource.subtitle}</p>
                  </div>
                </div>
              ) : null}

              {source.sources.map((option) => (
                <ModalConfirmation
                  key={`${option.kind}-${option.id}`}
                  title="Change Git source?"
                  actions={[`Change Git source to ${option.name}`]}
                  confirmationText="Change Git Source"
                  confirmationLabel="Enter the text below to confirm changing the Git source."
                  shortConfirmationLabel="Confirmation text"
                  onSubmit={() => send("POST", "/change", { sourceId: option.id, sourceType: option.type })}
                  trigger={
                    <button
                      type="button"
                      className="group flex w-full min-h-16 items-center gap-3 rounded-xl border border-neutral-200 bg-white p-3 text-left shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:bg-neutral-50 hover:shadow-md focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14] dark:hover:bg-white/[0.05]"
                    >
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 transition-colors group-hover:border-neutral-300 group-hover:text-neutral-700 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim dark:group-hover:border-white/[0.12] dark:group-hover:text-fg">
                        <Reicon name="sources" className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-black dark:text-fg">{option.name}</span>
                        <span className="mt-0.5 block truncate text-[11px] text-neutral-500 dark:text-fg-faint">{option.subtitle}</span>
                      </div>
                      <Reicon name="arrow-right" className="size-3.5 shrink-0 text-neutral-300 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100 dark:text-fg-faint" />
                    </button>
                  }
                />
              ))}
              {source.sources.length === 0 && !source.currentSource ? (
                <div className="col-span-full">
                  <Empty title="No other sources" description="Connect another Git source before moving this application." iconName="sources" size="sm">
                    <a href="/sources" className="button">
                      Connect source
                    </a>
                  </Empty>
                </div>
              ) : null}
            </div>
            {source.currentSource && source.sources.length === 0 ? (
              <p className="mt-3 text-[12px] leading-5 text-neutral-500 dark:text-fg-dim">
                No other sources available.{" "}
                <a href="/sources" className="font-medium text-coollabs underline-offset-2 hover:underline dark:text-brand-light">
                  Connect another source
                </a>{" "}
                to switch providers.
              </p>
            ) : null}
          </SettingsSection>
        ) : null}
      </div>
    </ApplicationWorkspace>
  );
}

export function ApplicationSourcePage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ApplicationSourceContent />
    </Layout>
  );
}
