// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/application/advanced.blade.php,
// resources/views/components/server/gpu-list.blade.php and app/Livewire/Project/Application/Advanced.php
// (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/advanced
// (project.application.advanced), for an application that is not Git based
// and not a Docker Compose one: the build switches, the container's name,
// shutdown and restart limits, the log drain, GPU access and the proxy
// options. A listbox saves itself (instantSave); the number fields save when
// they change; the name, the GPU form and the resolver name are forms.
// Refreshing the detected GPUs needs the SSH executor: the API answers "not
// available yet".
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Layout } from "../layout/Layout";
import { ago } from "../lib/ago";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Callout, Empty, FormInput, FormTextarea, Listbox, SettingsSection, SettingsSubsection, UnsavedBar } from "../components/Coolify";
import { applicationPath, ApplicationWorkspace } from "./ApplicationChrome";
import { inlineErrors, useApplicationSection, yesNo, type ApplicationSectionData } from "./ApplicationSection";

interface Settings {
  disableBuildCache: boolean;
  injectBuildArgsToDockerfile: boolean;
  includeSourceCommitInBuild: boolean;
  includeNetworkHostsInBuild: boolean;
  isConsistentContainerNameEnabled: boolean;
  isLogDrainEnabled: boolean;
  isGpuEnabled: boolean;
  isGzipEnabled: boolean;
  isStripprefixEnabled: boolean;
  gpuDriver: string;
  gpuCount: string | null;
  gpuDeviceIds: string | null;
  gpuOptions: string | null;
  customInternalName: string | null;
  customContainerNamePrefix: string | null;
  stopGracePeriod: number | null;
  rollingUpdateDrainSeconds: number;
  maxRestartCount: number;
  certificateResolverMode: "server" | "none" | "custom";
  certificateResolverName: string | null;
}

interface GpuServer {
  uuid: string;
  name: string;
  functional: boolean;
  collectedAt: string | null;
  gpus: Array<{ index: string; name: string; memoryMb: number; uuid: string }> | null;
  nvidiaContainerToolkit: boolean;
}

interface Page {
  settings: Settings;
  gitBased: boolean;
  labelsManaged: boolean;
  isTraefikProxy: boolean;
  serverCertificateResolver: string;
  gpuServers: GpuServer[];
}

type Data = ApplicationSectionData & Page;
type Saved = Page & { message: string | null };
type Switch = "disableBuildCache" | "injectBuildArgsToDockerfile" | "includeSourceCommitInBuild" | "includeNetworkHostsInBuild" | "isConsistentContainerNameEnabled" | "isLogDrainEnabled" | "isGpuEnabled" | "isGzipEnabled" | "isStripprefixEnabled";

/** bootstrap/helpers/constants.php and ApplicationSetting::MAX_CONTAINER_NAME_PREFIX_LENGTH */
const DEFAULT_STOP_GRACE_PERIOD_SECONDS = 30;
const MIN_STOP_GRACE_PERIOD_SECONDS = 1;
const MAX_STOP_GRACE_PERIOD_SECONDS = 3600;
const DEFAULT_ROLLING_UPDATE_DRAIN_SECONDS = 5;
const MAX_ROLLING_UPDATE_DRAIN_SECONDS = 300;
const MAX_CONTAINER_NAME_PREFIX_LENGTH = 30;

/** The fields that are typed before they are saved. */
interface Draft {
  customInternalName: string;
  customContainerNamePrefix: string;
  stopGracePeriod: string;
  rollingUpdateDrainSeconds: string;
  maxRestartCount: string;
  gpuDriver: string;
  gpuCount: string;
  gpuDeviceIds: string;
  gpuOptions: string;
  certificateResolverMode: Settings["certificateResolverMode"];
  certificateResolverName: string;
}
const draftOf = (s: Settings): Draft => ({
  customInternalName: s.customInternalName ?? "",
  customContainerNamePrefix: s.customContainerNamePrefix ?? "",
  stopGracePeriod: s.stopGracePeriod === null ? "" : String(s.stopGracePeriod),
  rollingUpdateDrainSeconds: String(s.rollingUpdateDrainSeconds),
  maxRestartCount: String(s.maxRestartCount),
  gpuDriver: s.gpuDriver,
  gpuCount: s.gpuCount ?? "",
  gpuDeviceIds: s.gpuDeviceIds ?? "",
  gpuOptions: s.gpuOptions ?? "",
  certificateResolverMode: s.certificateResolverMode,
  certificateResolverName: s.certificateResolverName ?? "",
});

/** <x-server.gpu-list> */
function GpuList({ server }: { server: GpuServer }) {
  return (
    <div className="text-[12px] leading-5 text-neutral-600 dark:text-fg-dim">
      {server.gpus === null ? (
        <p>Not checked yet. Refresh to find GPUs.</p>
      ) : server.gpus.length === 0 ? (
        <p>
          No NVIDIA GPU found (<span className="font-mono">nvidia-smi</span> is not installed or shows no GPU).
        </p>
      ) : (
        <>
          <ul>
            {server.gpus.map((gpu) => (
              <li key={gpu.uuid}>
                <span className="font-mono font-medium text-neutral-950 dark:text-fg">{gpu.index}</span> · {gpu.name} · {Math.round((gpu.memoryMb / 1024) * 10) / 10} GB · <span className="font-mono">{gpu.uuid}</span>
              </li>
            ))}
          </ul>
          {server.nvidiaContainerToolkit ? null : (
            <p className="mt-1 text-warning-900 dark:text-warning">
              NVIDIA Container Toolkit not found. Containers cannot use these GPUs until you{" "}
              <a href="https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html" className="underline" target="_blank" rel="noreferrer">
                install it
              </a>{" "}
              and restart Docker.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ApplicationAdvancedContent() {
  const { me, data, setData, saving, patch, reload } = useApplicationSection<Data>("advanced");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data) setDraft(draftOf(data.settings));
  }, [data]);
  if (!data || !draft) return null;
  const { application, canUpdate, settings } = data;
  const saved = draftOf(settings);
  const type = (name: keyof Draft) => (v: string) => setDraft({ ...draft, [name]: v });
  const compose = application.buildPack === "dockercompose";

  /** One save of the component: the page as it is now, Coolify's toast, or the errors. */
  const send = async (body: Record<string, unknown>): Promise<boolean> => {
    const r = await patch<Saved>(body);
    if (!r.ok) {
      const inline = inlineErrors(r.error);
      setErrors(inline);
      // What Coolify reports with dispatch('error'), and the errors of fields that are not inputs.
      const shown = ["customInternalName", "customContainerNamePrefix", "certificateResolverName", "stopGracePeriod", "rollingUpdateDrainSeconds", "maxRestartCount"];
      const toasts = Object.entries(inline).filter(([f]) => !shown.includes(f));
      if (!Object.keys(inline).length) notify.error(r.error.message);
      else for (const [, message] of toasts) notify.error(message);
      // instantSave() without a log drain on the server saves the other settings before it reports the error.
      if (inline.isLogDrainEnabled) void reload();
      return false;
    }
    setErrors({});
    const { message, ...page } = r.data;
    setData({ ...data, ...page });
    if (message) notify.success(message);
    return true;
  };
  /** A listbox with onChange="instantSave". */
  const switchBox = (id: Switch, label: string, helper: string | undefined, options: Array<{ value: boolean; label: string }>): ReactNode => (
    <Listbox
      id={id}
      label={label}
      {...(helper ? { helper } : {})}
      options={options.map((o) => ({ value: yesNo(o.value), label: o.label }))}
      value={yesNo(settings[id])}
      onChange={(v) => void send({ instantSave: true, [id]: v === "true" })}
      disabled={!canUpdate}
    />
  );
  /** wire:change: the field saves itself when it loses focus with another value. */
  const autosave = (name: "stopGracePeriod" | "rollingUpdateDrainSeconds" | "maxRestartCount") => ({
    onBlur: () => {
      if (draft[name] !== saved[name]) void send({ save: name, [name]: draft[name] });
    },
  });
  const form = (submit: () => void) => (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    submit();
  };
  const saveCustomName = () => void send({ save: "customName", customInternalName: draft.customInternalName });
  const savePrefix = () => void send({ save: "customNamePrefix", customContainerNamePrefix: draft.customContainerNamePrefix });
  const saveGpu = () => void send({ gpuDriver: draft.gpuDriver, gpuCount: draft.gpuCount, gpuDeviceIds: draft.gpuDeviceIds, gpuOptions: draft.gpuOptions });
  const saveResolver = (mode = draft.certificateResolverMode) => void send({ save: "certificateResolver", certificateResolverMode: mode, certificateResolverName: draft.certificateResolverName });
  /** saveCertificateResolverMode(): "custom" waits for a resolver name before it saves. */
  const changeResolverMode = (mode: string) => {
    setDraft({ ...draft, certificateResolverMode: mode as Draft["certificateResolverMode"] });
    if (mode === "custom" && draft.certificateResolverName.trim() === "") return setErrors({});
    saveResolver(mode as Draft["certificateResolverMode"]);
  };
  const gpuDirty = (["gpuDriver", "gpuCount", "gpuDeviceIds", "gpuOptions"] as const).some((f) => draft[f] !== saved[f]);
  const canRefreshGpus = data.gpuServers.some((s) => s.functional);
  const general = applicationPath(application.project.uuid, application.environment.uuid, application.uuid);

  return (
    <ApplicationWorkspace application={application} orgId={me.team?.id} active="Advanced" canUpdate={canUpdate} canDeploy={data.canDeploy}>
      <div>
        <div className="flex flex-col gap-6">
          <SettingsSection id="advanced-build-section" title="Build & deploy" helper="How images are built, how deployments start, and how the repository is cloned.">
            <div className="grid w-full gap-4 sm:grid-cols-2">
              {switchBox("disableBuildCache", "Build cache", "Disabling the cache forces a completely fresh Docker build on every deployment.", [
                { value: false, label: "Use Docker build cache" },
                { value: true, label: "Rebuild from scratch every time" },
              ])}
              {switchBox(
                "injectBuildArgsToDockerfile",
                "Build arguments",
                "When injected automatically, Freeploy adds ARG statements to your Dockerfile for build-time variables. Manage them manually to preserve Docker build cache.",
                [
                  { value: true, label: "Inject build args automatically" },
                  { value: false, label: "Managed manually in Dockerfile" },
                ],
              )}
              {switchBox(
                "includeSourceCommitInBuild",
                "Source commit availability",
                "SOURCE_COMMIT (git commit hash) is always available at runtime. Making it available during build invalidates the cache on every commit.",
                [
                  { value: false, label: "Runtime only (preserves cache)" },
                  { value: true, label: "Available during build" },
                ],
              )}
              {switchBox(
                "includeNetworkHostsInBuild",
                "Network hosts during build",
                "When added, the build can reach the containers on the destination network by name. Each time a resource on the network is added or removed, the Docker build cache is invalidated. Preview deployments are never added, and no hosts are added on a build server.",
                [
                  { value: true, label: "Add network containers as hosts" },
                  { value: false, label: "Do not add (preserves cache)" },
                ],
              )}
            </div>
          </SettingsSection>

          <SettingsSection id="advanced-container-section" title="Container" helper="Naming, shutdown, logs, and GPU access for the deployed container.">
            <div className="grid w-full gap-4 sm:grid-cols-2">
              {switchBox("isConsistentContainerNameEnabled", "Container naming", `With a consistent name the container is always called ${application.uuid}. You will lose the rolling update feature!`, [
                { value: false, label: "Generated name (rolling updates)" },
                { value: true, label: "Consistent name (no rolling updates)" },
              ])}
              {settings.isConsistentContainerNameEnabled ? (
                <form onSubmit={form(saveCustomName)} className="w-full">
                  <UnsavedBar dirty={draft.customInternalName !== saved.customInternalName} saving={saving} onSave={saveCustomName} />
                  <FormInput
                    helper={"You can add a custom name for your container.\n\nThe name is converted to slug format when saved. You will lose the rolling update feature!"}
                    id="customInternalName"
                    label="Custom container name"
                    value={draft.customInternalName}
                    onChange={type("customInternalName")}
                    error={errors.customInternalName}
                    disabled={!canUpdate}
                  />
                </form>
              ) : (
                <form onSubmit={form(savePrefix)} className="w-full">
                  <UnsavedBar dirty={draft.customContainerNamePrefix !== saved.customContainerNamePrefix} saving={saving} onSave={savePrefix} />
                  <FormInput
                    helper={`Optional prefix for generated container names. Containers are named prefix-timestamp, for example shop-api-20260908T141530, instead of starting with ${application.uuid}.\n\nThe prefix is converted to slug format when saved, can be up to ${MAX_CONTAINER_NAME_PREFIX_LENGTH} characters and must be unique on this server. Rolling updates keep working.`}
                    id="customContainerNamePrefix"
                    label="Container name prefix"
                    placeholder="e.g. my-api"
                    value={draft.customContainerNamePrefix}
                    onChange={type("customContainerNamePrefix")}
                    error={errors.customContainerNamePrefix}
                    disabled={!canUpdate}
                  />
                </form>
              )}
            </div>
            <SettingsSubsection id="advanced-operations-section" title="Operations" helper="Shutdown and restart behavior for this application's containers.">
              <div className="grid w-full gap-4 lg:grid-cols-2">
                <div {...autosave("stopGracePeriod")}>
                  <FormInput
                    type="number"
                    id="stopGracePeriod"
                    label="Stop grace period (seconds)"
                    placeholder={String(DEFAULT_STOP_GRACE_PERIOD_SECONDS)}
                    helper={`How long to wait for graceful shutdown during rolling updates, manual stops, and restarts. Applies to all containers for this application. Saved automatically. Default: ${DEFAULT_STOP_GRACE_PERIOD_SECONDS} seconds. Range: ${MIN_STOP_GRACE_PERIOD_SECONDS}-${MAX_STOP_GRACE_PERIOD_SECONDS} seconds (1 hour).`}
                    min={MIN_STOP_GRACE_PERIOD_SECONDS}
                    max={MAX_STOP_GRACE_PERIOD_SECONDS}
                    value={draft.stopGracePeriod}
                    onChange={type("stopGracePeriod")}
                    error={errors.stopGracePeriod}
                    disabled={!canUpdate}
                  />
                </div>
                {compose ? null : (
                  <div {...autosave("rollingUpdateDrainSeconds")}>
                    <FormInput
                      type="number"
                      min={0}
                      max={MAX_ROLLING_UPDATE_DRAIN_SECONDS}
                      id="rollingUpdateDrainSeconds"
                      label="Rolling update drain time (seconds)"
                      helper={`How long to wait after the new container is healthy before the old containers stop during a rolling update. The proxy needs this time to send traffic to the new container. Saved automatically. Default: ${DEFAULT_ROLLING_UPDATE_DRAIN_SECONDS} seconds. Range: 0-${MAX_ROLLING_UPDATE_DRAIN_SECONDS} seconds. Set to 0 to turn off the wait.`}
                      value={draft.rollingUpdateDrainSeconds}
                      onChange={type("rollingUpdateDrainSeconds")}
                      error={errors.rollingUpdateDrainSeconds}
                      disabled={!canUpdate}
                    />
                  </div>
                )}
                <div {...autosave("maxRestartCount")}>
                  <FormInput
                    type="number"
                    min={0}
                    id="maxRestartCount"
                    label="Max restart count"
                    helper="Maximum number of restarts before Freeploy automatically stops the application and sends a notification. Saved automatically. Set to 0 to disable the limit."
                    value={draft.maxRestartCount}
                    onChange={type("maxRestartCount")}
                    error={errors.maxRestartCount}
                    disabled={!canUpdate}
                  />
                </div>
              </div>
            </SettingsSubsection>
            <SettingsSubsection id="advanced-logs-section" title="Logs" helper="Forward container logs to an external endpoint.">
              <div className="grid w-full gap-4 sm:grid-cols-2">
                {switchBox("isLogDrainEnabled", "Log drain", "Drain logs to the log drain endpoint configured in your Server settings.", [
                  { value: false, label: "Disabled" },
                  { value: true, label: "Send logs to the log drain endpoint" },
                ])}
              </div>
            </SettingsSubsection>
            {compose ? null : (
              <section id="advanced-gpu-section" className="mt-5 border-t border-neutral-200 pt-5 dark:border-white/[0.07]">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h3 className="flex items-center gap-1.5 text-sm! font-semibold! text-black dark:text-fg">GPU</h3>
                  <Button onClick={() => void send({ save: "refreshGpus" })} disabled={!canUpdate || !canRefreshGpus} tooltip={canRefreshGpus ? null : "Validate the server connection first."}>
                    <Reicon name="refresh" className="size-3.5" />
                    Refresh GPUs
                  </Button>
                </div>
                <p className="mb-3 text-xs text-neutral-500 dark:text-fg-dim">
                  Give this application access to the host&apos;s GPUs. More info{" "}
                  <a href="https://docs.docker.com/compose/gpu-support/" className="underline dark:text-white" target="_blank" rel="noreferrer">
                    here
                  </a>
                  .
                </p>
                <Callout type="info" title="Detected GPUs" className="mb-5">
                  {data.gpuServers.map((server, i) => (
                    <div key={server.uuid} className={i === 0 ? undefined : "mt-2"}>
                      <p className="font-medium text-neutral-700 dark:text-fg">
                        <a href={`/server/${server.uuid}`} className="underline">
                          {server.name}
                        </a>
                        {server.collectedAt ? <span className="font-normal text-neutral-500 dark:text-fg-dim"> · checked {ago(server.collectedAt)}</span> : null}
                      </p>
                      <GpuList server={server} />
                    </div>
                  ))}
                </Callout>
                <div className="grid w-full gap-4 sm:grid-cols-2">
                  {switchBox("isGpuEnabled", "GPU access", undefined, [
                    { value: false, label: "Disabled" },
                    { value: true, label: "Enabled" },
                  ])}
                </div>
                {settings.isGpuEnabled ? (
                  <form id="gpu-settings-form" onSubmit={form(saveGpu)} className="mt-5 flex w-full flex-col gap-4 border-t border-neutral-200 pt-5 dark:border-white/[0.07]">
                    <UnsavedBar dirty={gpuDirty} saving={saving} onSave={saveGpu} />
                    <div className="grid gap-4 sm:grid-cols-2">
                      <FormInput label="GPU driver" id="gpuDriver" value={draft.gpuDriver} onChange={type("gpuDriver")} disabled={!canUpdate} />
                      <FormInput label="GPU count" placeholder="Empty means use all GPUs" helper="A number, or all." id="gpuCount" value={draft.gpuCount} onChange={type("gpuCount")} disabled={!canUpdate} />
                    </div>
                    <FormInput label="GPU device ids" placeholder="0,2" helper="Comma separated list of device ids." id="gpuDeviceIds" value={draft.gpuDeviceIds} onChange={type("gpuDeviceIds")} disabled={!canUpdate} />
                    <FormTextarea
                      rows={6}
                      label="GPU options"
                      id="gpuOptions"
                      placeholder="key=value"
                      helper="Driver options. Use one key=value pair per line, or a YAML mapping."
                      value={draft.gpuOptions}
                      onChange={type("gpuOptions")}
                      disabled={!canUpdate}
                    />
                  </form>
                ) : null}
              </section>
            )}
          </SettingsSection>

          <SettingsSection id="advanced-proxy-section" title="Proxy" helper="How the proxy serves traffic for this application.">
            {data.labelsManaged ? (
              <div className="grid w-full gap-4 sm:grid-cols-2">
                {switchBox("isGzipEnabled", "Gzip compression", "Some services compress data by default. In that case you do not need this.", [
                  { value: true, label: "Enabled" },
                  { value: false, label: "Disabled" },
                ])}
                {switchBox("isStripprefixEnabled", "Path prefixes", "Strip Prefix removes prefixes from paths, like /api/ to /.", [
                  { value: true, label: "Strip prefixes" },
                  { value: false, label: "Keep paths as-is" },
                ])}
                {data.isTraefikProxy ? (
                  <>
                    <Listbox
                      id="certificateResolverMode"
                      label="Certificate resolver"
                      helper="Traefik certificate resolver for this application's HTTPS routes. Choose None for domains that use certificates from Traefik's dynamic configuration (for example Cloudflare Origin CA certificates). Redeploy the application to apply the change."
                      options={[
                        { value: "server", label: `Server setting (${data.serverCertificateResolver})` },
                        { value: "none", label: "None (use your own certificates)" },
                        { value: "custom", label: "Custom resolver" },
                      ]}
                      value={draft.certificateResolverMode}
                      onChange={changeResolverMode}
                      disabled={!canUpdate}
                      error={errors.certificateResolverMode}
                    />
                    {draft.certificateResolverMode === "custom" ? (
                      <form onSubmit={form(() => saveResolver())} className="w-full">
                        <UnsavedBar dirty={draft.certificateResolverName !== saved.certificateResolverName} saving={saving} onSave={() => saveResolver()} />
                        <FormInput
                          id="certificateResolverName"
                          label="Resolver name"
                          placeholder="cloudflare"
                          required
                          helper="Name of a certificate resolver defined in your Traefik configuration. Letters, numbers, hyphens, and underscores only."
                          value={draft.certificateResolverName}
                          onChange={type("certificateResolverName")}
                          error={errors.certificateResolverName}
                          disabled={!canUpdate}
                        />
                      </form>
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : (
              <Empty
                size="sm"
                title="Proxy behavior is managed through labels"
                description="Container labels are managed manually for this application. Switch label management back to Freeploy to configure the proxy here."
                iconName="globe"
              >
                <a className="button" href={`${general}#container-labels-section`}>
                  Go to Container labels
                </a>
              </Empty>
            )}
          </SettingsSection>
        </div>
      </div>
    </ApplicationWorkspace>
  );
}

export function ApplicationAdvancedPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ApplicationAdvancedContent />
    </Layout>
  );
}
