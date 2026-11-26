// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/application/previews.blade.php,
// resources/views/livewire/project/application/preview/form.blade.php and
// resources/views/livewire/project/application/preview-domains.blade.php (the rows, Generate and Remove) (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/preview-deployments
// (project.application.preview-deployments, DP-99): the preview settings, GitHub's open pull requests (Configure,
// Deploy preview), the preview URL template, the manual Docker image preview, and each preview with its links,
// actions, domains and Docker tag. Deploying, redeploying and stopping a preview run on the server and say the SSH
// executor is not available yet. Not here: a Docker Compose application's per-service preview domains, and adding or
// editing a preview's domain by hand.
import { useState, type FormEvent } from "react";
import { Layout } from "../layout/Layout";
import { postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Callout, Empty, FormInput, Listbox, ModalConfirmation, ModalInput, SettingsSection, StatusBadge, UnsavedBar } from "../components/Coolify";
import { TableDropdown } from "../components/CoolifyList";
import { useApplicationSection, resourceApi, yesNo, type ApplicationSectionData } from "./ApplicationSection";
import { ApplicationWorkspace } from "./ApplicationChrome";

interface DomainRow {
  url: string;
  internalPort: number | null;
  hasPortOverride: boolean;
  dnsStatus: string;
  dnsMessage: string;
}

interface Preview {
  id: string;
  pullRequestId: number;
  pullRequestHtmlUrl: string;
  fqdn: string | null;
  status: string;
  dockerRegistryImageTag: string | null;
  restartLimitReached: boolean;
  domains: DomainRow[];
}

type PreviewsData = ApplicationSectionData & {
  gitBased: boolean;
  isGithubAppSource: boolean;
  buildPack: string;
  isPreviewDeploymentsEnabled: boolean;
  isPrDeploymentsPublicEnabled: boolean;
  previewUrlTemplate: string;
  generatedPattern: string;
  previewServerName: string | null;
  previews: Preview[];
};

interface PullRequest {
  number: number;
  title: string;
  htmlUrl: string;
}

const ACCESS_HELPER =
  "When public, anyone can trigger PR deployments. Otherwise only PRs from branches in the same repository are deployed and fork PRs are blocked. Docker Compose: with repository members only, a preview of a branch in the same repository deploys the compose file of its PR. Public previews, and previews added by PR number or through the API, deploy the compose file of the base branch. Secrets: the code of a fork PR can read all environment variables of its preview. When public, previews do not get preview variables that still have the production value, and shared variables are resolved only in preview variables, not in the compose file. This is not full isolation: the preview runs on the same server as production. Give previews their own values, and do not use production secrets in them.";

const DNS_TYPE: Record<string, "success" | "error" | "warning"> = { ok: "success", failed: "error", skipped: "warning" };
const DNS_LABEL: Record<string, string> = { ok: "DNS matches", failed: "DNS mismatch", skipped: "DNS skipped", checking: "Checking DNS...", pending: "Not checked" };

function statusOf(status: string): [string, "success" | "error" | "warning" | "neutral"] {
  const [state] = status.split(":");
  if (state === "running") return ["Running", "success"];
  if (state === "restarting") return ["Restarting", "warning"];
  if (state === "exited") return ["Exited", "error"];
  return [state ? state.charAt(0).toUpperCase() + state.slice(1) : "Unknown", "neutral"];
}

function PreviewsContent() {
  const { me, data, setData, reload } = useApplicationSection<PreviewsData>("previews");
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [rateLimit, setRateLimit] = useState<number | null>(null);
  const [loadingPrs, setLoadingPrs] = useState(false);
  const [prsOpen, setPrsOpen] = useState(false);
  const [template, setTemplate] = useState<string | null>(null);
  const [templateError, setTemplateError] = useState<string | undefined>();
  const [manualId, setManualId] = useState("");
  const [manualTag, setManualTag] = useState("");
  const [manualErrors, setManualErrors] = useState<Record<string, string>>({});
  const [tags, setTags] = useState<Record<string, string>>({});
  if (!data) return null;
  const api = `${resourceApi("application", me.team?.id, data.application.uuid)}/previews`;
  const can = data.canUpdate;
  const templateValue = template ?? data.previewUrlTemplate;

  async function send<T>(path: string, body: unknown, method: "POST" | "PATCH" | "DELETE" = "POST"): Promise<T | null> {
    const r = await postJson<T & { message?: string }>(`${api}${path}`, body, method);
    if (!r.ok) {
      notify.error(summarize(r.error.messages));
      return null;
    }
    if (r.data.message) notify.success(r.data.message);
    return r.data;
  }
  const refreshWith = (d: Partial<PreviewsData> | null) => d && setData({ ...data!, ...d });

  async function loadPrs() {
    setLoadingPrs(true);
    const r = await postJson<{ rateLimitRemaining: number | null; pullRequests: PullRequest[] }>(`${api}/pull-requests`, {});
    setLoadingPrs(false);
    if (!r.ok) {
      setRateLimit(0);
      return notify.error(summarize(r.error.messages));
    }
    setRateLimit(r.data.rateLimitRemaining);
    setPrs(r.data.pullRequests);
  }
  async function saveTemplate(e?: FormEvent, reset = false) {
    e?.preventDefault();
    const r = await postJson<{ message: string; previewUrlTemplate: string; generatedPattern: string }>(`${api}/template`, reset ? { reset: true } : { previewUrlTemplate: templateValue }, "PATCH");
    if (!r.ok) {
      setTemplateError(r.error.fields?.previewUrlTemplate?.[0]);
      return notify.error(summarize(r.error.messages));
    }
    setTemplateError(undefined);
    setTemplate(null);
    notify.success(r.data.message);
    setData({ ...data!, previewUrlTemplate: r.data.previewUrlTemplate, generatedPattern: r.data.generatedPattern });
  }
  async function manual(e: FormEvent) {
    e.preventDefault();
    const r = await postJson<PreviewsData>(api, { manual: true, manualPullRequestId: manualId, manualDockerTag: manualTag });
    if (!r.ok) {
      const inline: Record<string, string> = {};
      for (const [f, m] of Object.entries(r.error.fields ?? {})) if (m[0]) inline[f] = m[0];
      setManualErrors(inline);
      return notify.error(summarize(r.error.messages));
    }
    setManualErrors({});
    setManualId("");
    setManualTag("");
    refreshWith(r.data);
  }

  return (
    <ApplicationWorkspace application={data.application} orgId={me.team?.id} active="Preview Deployments" canUpdate={data.canUpdate} canDeploy={data.canDeploy}>
      <div className="flex flex-col gap-6">
        {data.gitBased ? (
          <SettingsSection
            id="preview-settings-section"
            title="Preview settings"
            helper="Automatic pull request deployments and who can trigger them."
            actions={
              can ? (
                <>
                  {data.isGithubAppSource ? (
                    <ModalInput
                      title="Pull requests"
                      subtitle="Load open pull requests from GitHub, then configure or deploy a preview."
                      open={prsOpen}
                      onOpenChange={setPrsOpen}
                      trigger={<Button onClick={() => void loadPrs()}>Load pull requests</Button>}
                    >
                      <div className="mb-3 flex items-center justify-end gap-2">
                        {rateLimit !== null ? <span className="text-xs text-neutral-500 dark:text-fg-dim">{rateLimit} requests remaining</span> : null}
                        <Button onClick={() => void loadPrs()}>Refresh</Button>
                      </div>
                      {loadingPrs ? (
                        <p className="text-sm text-neutral-500">Loading pull requests</p>
                      ) : prs && prs.length ? (
                        prs.map((pr) => (
                          <div key={pr.number} className="flex flex-col gap-3 border-b border-neutral-200 px-4 py-3.5 last:border-b-0 sm:flex-row sm:items-center dark:border-white/[0.07]">
                            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 font-mono text-xs font-semibold text-neutral-600 ring-1 ring-neutral-200 dark:bg-white/[0.05] dark:text-fg-dim dark:ring-white/[0.07]">#{pr.number}</div>
                            <div className="min-w-0 flex-1">
                              <h4 className="truncate text-sm font-semibold text-black dark:text-fg">{pr.title}</h4>
                              <a target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-coollabs dark:text-fg-dim dark:hover:text-brand-light" href={pr.htmlUrl}>
                                Open on GitHub
                                <Reicon name="external-link" className="size-3" />
                              </a>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                              <Button onClick={() => void send<PreviewsData>("", { pullRequestId: pr.number, pullRequestHtmlUrl: pr.htmlUrl }).then(refreshWith)}>Configure</Button>
                              <Button onClick={() => void send("", { pullRequestId: pr.number, pullRequestHtmlUrl: pr.htmlUrl, deploy: true })}>Deploy preview</Button>
                            </div>
                          </div>
                        ))
                      ) : (
                        <Empty size="sm" title="No open pull requests" description="No open pull requests were found for this repository." iconName="sources" />
                      )}
                    </ModalInput>
                  ) : null}
                  <Button highlighted={!data.isPreviewDeploymentsEnabled} onClick={() => void send<PreviewsData>("/settings", { toggle: true }, "PATCH").then(refreshWith)}>
                    {data.isPreviewDeploymentsEnabled ? "Disable preview deployments" : "Enable preview deployments"}
                  </Button>
                </>
              ) : undefined
            }
          >
            <div className="w-full">
              <Listbox
                id="isPrDeploymentsPublicEnabled"
                label="PR deployment access"
                helper={ACCESS_HELPER}
                options={[
                  { value: "false", label: "Repository members only" },
                  { value: "true", label: "Public (fork PRs allowed)" },
                ]}
                value={yesNo(data.isPrDeploymentsPublicEnabled)}
                onChange={(v) => void send<PreviewsData>("/settings", { isPrDeploymentsPublicEnabled: v === "true" }, "PATCH").then(refreshWith)}
                disabled={!can || !data.isPreviewDeploymentsEnabled}
              />
            </div>
          </SettingsSection>
        ) : null}

        <form className="application-settings-form flex flex-col" onSubmit={(e) => void saveTemplate(e)}>
          <UnsavedBar dirty={can && template !== null && template !== data.previewUrlTemplate} saving={false} onSave={() => void saveTemplate()} />
          <SettingsSection id="preview-template-section" title="Preview URL template" helper="Define how Freeploy generates domains for pull request deployments." actions={can ? <Button onClick={() => void saveTemplate(undefined, true)}>Reset template</Button> : undefined}>
            <FormInput
              id="previewUrlTemplate"
              label="URL template"
              helper="Use {{ random }} for a random subdomain, {{ pr_id }} for the pull request number, or {{ domain }} for the application domain."
              value={templateValue}
              onChange={setTemplate}
              disabled={!can}
              error={templateError}
            />
            {data.generatedPattern ? (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-lg bg-neutral-100 px-3 py-2.5 ring-1 ring-neutral-200 dark:bg-white/[0.04] dark:ring-white/[0.07]">
                <span className="text-[13px] text-neutral-500 dark:text-fg-dim">Generated pattern</span>
                <code className="break-all text-right font-mono text-xs text-neutral-700 dark:text-fg">{data.generatedPattern}</code>
              </div>
            ) : null}
          </SettingsSection>
        </form>

        {data.previewServerName ? (
          <Callout type="info" title="Preview deployment server">
            Preview deployments run on {data.previewServerName}.
          </Callout>
        ) : null}

        {data.buildPack === "dockerimage" ? (
          <SettingsSection id="manual-preview-section" title="Manual preview" helper="Deploy a preview directly from a Docker image tag.">
            <form onSubmit={(e) => void manual(e)} className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] md:items-end">
              <FormInput id="manualPullRequestId" label="Preview ID" helper="Used for domains, logs, container names, and cleanup." value={manualId} onChange={setManualId} error={manualErrors.manualPullRequestId} />
              <FormInput id="manualDockerTag" label="Docker tag" helper="For example, pr_1234." value={manualTag} onChange={setManualTag} error={manualErrors.manualDockerTag} />
              {data.canDeploy ? <Button type="submit">Deploy preview</Button> : null}
            </form>
          </SettingsSection>
        ) : null}

        <SettingsSection id="preview-deployments-section" title="Preview deployments" helper="Manage domains, deployments, logs, and lifecycle actions for configured previews." flush>
          {data.previews.length ? (
            data.previews.map((p) => {
              const stopped = p.status.startsWith("exited");
              const [label, type] = statusOf(p.status);
              const base = window.location.pathname.replace(/\/preview-deployments\/?$/, "");
              return (
                <section key={p.pullRequestId} className="border-b border-neutral-200 p-4 last:border-b-0 dark:border-white/[0.07]">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 font-mono text-xs font-semibold text-neutral-600 ring-1 ring-neutral-200 dark:bg-white/[0.05] dark:text-fg-dim dark:ring-white/[0.07]">#{p.pullRequestId}</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-semibold text-black dark:text-fg">Preview #{p.pullRequestId}</h4>
                        <StatusBadge label={label} type={type} title="Preview status" />
                        {p.restartLimitReached ? <StatusBadge label="Restart limit reached" type="error" /> : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2 lg:justify-end">
                      <TableDropdown trigger={(open) => <button type="button" className="button gap-1.5" aria-expanded={open}>Links</button>}>
                        {(close) => (
                          <>
                            {!stopped && p.fqdn ? (
                              <a target="_blank" rel="noreferrer" className="listbox-option justify-start! gap-2.5!" href={p.fqdn.split(",")[0]} onClick={close}>
                                Open preview
                              </a>
                            ) : null}
                            {/^https?:\/\//.test(p.pullRequestHtmlUrl) ? (
                              <a target="_blank" rel="noreferrer" className="listbox-option justify-start! gap-2.5!" href={p.pullRequestHtmlUrl} onClick={close}>
                                Open pull request
                              </a>
                            ) : null}
                          </>
                        )}
                      </TableDropdown>
                      <TableDropdown trigger={(open) => <button type="button" className="button gap-1.5" aria-expanded={open}>Logs</button>}>
                        {(close) => (
                          <>
                            <a className="listbox-option justify-start! gap-2.5!" href={`${base}/deployment?pull_request_id=${p.pullRequestId}`} onClick={close}>
                              Deployment logs
                            </a>
                            <a className="listbox-option justify-start! gap-2.5!" href={`${base}/logs?pull_request_id=${p.pullRequestId}`} onClick={close}>
                              Runtime logs
                            </a>
                          </>
                        )}
                      </TableDropdown>
                      {can ? (
                        <TableDropdown trigger={(open) => <button type="button" className="button gap-1.5" aria-expanded={open}>Actions</button>}>
                          {(close) => (
                            <>
                              <button type="button" className="listbox-option justify-start! gap-2.5!" onClick={() => (close(), void send(`/${p.pullRequestId}/deploy`, {}))}>
                                {stopped ? "Deploy" : "Redeploy"}
                              </button>
                              <button type="button" className="listbox-option justify-start! gap-2.5!" onClick={() => (close(), void send(`/${p.pullRequestId}/deploy`, { force: true }))}>
                                {stopped ? "Deploy (without cache)" : "Redeploy (without cache)"}
                              </button>
                              {!stopped ? (
                                <button type="button" className="listbox-option justify-start! gap-2.5! text-error!" onClick={() => (close(), void send(`/${p.pullRequestId}/stop`, {}))}>
                                  Stop
                                </button>
                              ) : null}
                            </>
                          )}
                        </TableDropdown>
                      ) : null}
                      {can ? (
                        <ModalConfirmation
                          title="Delete preview deployment?"
                          trigger={<button className="button button-error">Delete</button>}
                          actions={["All containers for this preview deployment will be stopped and permanently deleted."]}
                          confirmationText={`${p.fqdn ?? ""}/`}
                          confirmationLabel="Enter the preview deployment name to confirm deletion"
                          shortConfirmationLabel="Preview deployment name"
                          onSubmit={async () => {
                            refreshWith(await send<PreviewsData>(`/${p.pullRequestId}`, {}, "DELETE"));
                          }}
                        />
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-4 border-t border-neutral-200 pt-4 dark:border-white/[0.07]">
                    <div className="application-settings-section-body is-flush overflow-visible">
                      <div className="data-table-header flex items-center justify-between">
                        <span>Domains</span>
                        {can && data.buildPack !== "dockercompose" ? (
                          <button type="button" className="button" onClick={() => void send<PreviewsData>(`/${p.id}/domains/generate`, {}).then(refreshWith)}>
                            Generate domain
                          </button>
                        ) : null}
                      </div>
                      {p.domains.length ? (
                        p.domains.map((d, index) => (
                          <div key={d.url} className="data-table-row flex items-center justify-between gap-3 text-[13px]">
                            <a className="min-w-0 truncate" href={d.url} target="_blank" rel="noreferrer">
                              {d.url}
                            </a>
                            <span className="flex shrink-0 items-center gap-2">
                              <span className="tabular-nums text-neutral-500">{d.internalPort ?? "—"}</span>
                              <StatusBadge label={DNS_LABEL[d.dnsStatus] ?? "DNS unknown"} type={DNS_TYPE[d.dnsStatus] ?? "neutral"} title={d.dnsStatus === "ok" ? null : d.dnsMessage} />
                              {can ? (
                                <button type="button" className="icon-button" title="Remove domain" aria-label="Remove domain" onClick={() => void send<PreviewsData>(`/${p.id}/domains/${index}`, {}, "DELETE").then(refreshWith)}>
                                  <Reicon name="trash" className="size-3.5" />
                                </button>
                              ) : null}
                            </span>
                          </div>
                        ))
                      ) : (
                        <p className="px-3 py-3 text-[13px] text-neutral-500 dark:text-fg-dim">No domains configured.</p>
                      )}
                    </div>

                    {data.buildPack === "dockerimage" ? (
                      <form
                        className="application-settings-section-body is-flush mt-3 overflow-visible"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void send(`/${p.id}/docker-tag`, { dockerTag: tags[p.id] ?? p.dockerRegistryImageTag ?? "" }, "PATCH").then(() => reload());
                        }}
                      >
                        <div className="data-table-header grid-cols-1">
                          <span>Docker tag</span>
                        </div>
                        <div className="p-3">
                          <FormInput
                            id={`previewDockerTags.${p.id}`}
                            value={tags[p.id] ?? p.dockerRegistryImageTag ?? ""}
                            onChange={(v) => setTags((t) => ({ ...t, [p.id]: v }))}
                            disabled={!can}
                          />
                        </div>
                      </form>
                    ) : null}
                  </div>
                </section>
              );
            })
          ) : (
            <Empty title="No preview deployments" description="Configure a pull request or manual preview to create an isolated deployment." iconName="eye" />
          )}
        </SettingsSection>
      </div>
    </ApplicationWorkspace>
  );
}

export const ApplicationPreviewsPage = () => (
  <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
    <PreviewsContent />
  </Layout>
);
