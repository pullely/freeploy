// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/application/{configuration,general,internal-access}.blade.php
// and app/Livewire/Project/Application/{Configuration,General}.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}
// (project.application.configuration): the configuration frame and the General
// page of a Docker image application — details, access, the image, the
// deployment commands, networking and the container's Docker options.
// Not here yet: HTTP Basic Authentication, the container labels (both need
// Coolify's label generator) and the internal hostname of a running container
// (nothing is deployed yet). Domains are edited on the Domains page, as in
// Coolify; that page is not ported.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify, toast } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Callout, FormInput, ModalInput, SettingsSection, SettingsSubsection, UnsavedBar } from "../components/Coolify";
import { environmentPath, environmentUuidFromPath, limit, projectUuidFromPath } from "./ProjectChrome";
import { applicationPath, applicationsApi, applicationUuidFromPath, ApplicationWorkspace, type ApplicationInfo, type ApplicationShowData } from "./ApplicationChrome";

/** The form's fields: General's properties that apply to a Docker image application. */
const FIELDS = [
  "name",
  "description",
  "dockerRegistryImageName",
  "dockerRegistryImageTag",
  "portsExposes",
  "portsMappings",
  "customNetworkAliases",
  "customDockerRunOptions",
  "preDeploymentCommand",
  "postDeploymentCommand",
] as const;
type Field = (typeof FIELDS)[number];
type Form = Record<Field, string>;

const formOf = (a: ApplicationInfo): Form => Object.fromEntries(FIELDS.map((f) => [f, a[f] ?? ""])) as Form;

/** countDomains() and the first domain of the list. */
function domains(fqdn: string | null): { count: number; primary: string | null } {
  const list = (fqdn ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  return { count: list.length, primary: list[0] ?? null };
}

interface Saved {
  application: ApplicationInfo;
  message: string;
  warning: boolean;
}

function ApplicationGeneralContent() {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const uuid = applicationUuidFromPath();
  const base = `${applicationsApi(me.team?.id)}/${encodeURIComponent(uuid)}`;
  const [data, setData] = useState<ApplicationShowData | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [saved, setSaved] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [networking, setNetworking] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await getJson<ApplicationShowData>(base);
      // Configuration::mount(): the application through its project and environment, or a 404.
      if (!r.data) {
        if (r.status === 404) window.location.replace(environmentPath(projectUuid, environmentUuid));
        return;
      }
      if (r.data.application.project.uuid !== projectUuid || r.data.application.environment.uuid !== environmentUuid) return window.location.replace("/projects");
      setData(r.data);
      setForm(formOf(r.data.application));
      setSaved(formOf(r.data.application));
    })();
  }, [base, projectUuid, environmentUuid]);
  useEffect(() => {
    if (data) document.title = `${limit(data.application.name, 10)} > Configuration | Freeploy`;
  }, [data]);

  /** General::submit(): the changed fields, then 'Application settings updated!' (or the sslip warning in its place). */
  const submit = useCallback(async () => {
    if (!form || !saved) return;
    const changed = Object.fromEntries(FIELDS.filter((f) => form[f] !== saved[f]).map((f) => [f, form[f]]));
    setSaving(true);
    const r = await postJson<Saved>(base, changed, "PATCH");
    setSaving(false);
    if (!r.ok) {
      const fields = r.error.fields ?? {};
      const inline: Record<string, string> = {};
      for (const f of FIELDS) if (fields[f]?.[0]) inline[f] = fields[f][0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    setData((d) => (d ? { ...d, application: r.data.application } : d));
    setForm(formOf(r.data.application));
    setSaved(formOf(r.data.application));
    setNetworking(false);
    if (r.data.warning) toast(r.data.message, { type: "warning" });
    else notify.success(r.data.message);
  }, [base, form, saved]);

  if (!data || !form || !saved) return null;
  const { application, canUpdate } = data;
  const dirty = FIELDS.some((f) => form[f] !== saved[f]);
  const here = applicationPath(application.project.uuid, application.environment.uuid, application.uuid);
  const domainsUrl = `${here}/domains`;
  const { count: domainCount, primary: primaryDomain } = domains(application.fqdn);
  const additional = Math.max(0, domainCount - 1);
  const swarm = application.server?.isSwarm ?? false;
  const readonlyLabels = application.isContainerLabelReadonlyEnabled;
  const field = (name: Field) => ({ id: name, value: form[name], onChange: (v: string) => setForm({ ...form, [name]: v }), error: errors[name], disabled: !canUpdate });
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    void submit();
  };
  const exposed = (application.portsExposes ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .join(", ");
  const aliases = (application.customNetworkAliases ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .join(", ");
  const portsHint = "You can also set a different internal port for each domain on the Domains page.";

  return (
    <ApplicationWorkspace application={application} orgId={me.team?.id} active="General" canUpdate={canUpdate} canDeploy={data.canDeploy}>
      <div>
        <form onSubmit={onSubmit} className="application-settings-form flex flex-col">
          <UnsavedBar dirty={dirty && !networking} saving={saving} onSave={() => void submit()} />
          <div className="application-settings-grid flex flex-col gap-6">
            <SettingsSection
              id="application-details-section"
              title="Application details"
              helper="Name the application and choose the build strategy Freeploy should use to deploy it."
              className="application-details-card"
            >
              <div className="grid gap-4">
                <FormInput {...field("name")} label="Name" required />
                <FormInput {...field("description")} label="Description" />
              </div>
            </SettingsSection>

            <SettingsSection id="access-section" title="Access" helper="Manage how this application is reached publicly, who can access it, and how it is reached from the Docker network.">
              <section id="public-access-section" className="border-b border-neutral-200 pb-5 dark:border-white/[0.07]">
                <h3 className="mb-3 text-sm font-semibold text-black dark:text-fg">Public access</h3>
                <div className="group relative flex items-center gap-3 rounded-lg border border-neutral-200 bg-neutral-50/60 px-4 py-3 transition-colors hover:bg-neutral-100 focus-within:ring-2 focus-within:ring-coollabs/40 dark:border-white/[0.07] dark:bg-white/[0.05] dark:hover:bg-white/[0.08] dark:focus-within:ring-brand-light/40">
                  <a
                    className="flex min-w-0 flex-1 items-center gap-3 after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
                    aria-label={domainCount > 0 ? "Manage application domains" : "Add an application domain"}
                    href={domainsUrl}
                  >
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-neutral-200/70 text-neutral-600 dark:bg-white/[0.07] dark:text-fg-dim">
                      <Reicon name="globe" className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-black dark:text-fg">{primaryDomain ? <span className="block truncate">{primaryDomain}</span> : "No public domain configured"}</p>
                      <p className="text-xs text-neutral-500 dark:text-fg-dim">
                        {additional > 0
                          ? `+${additional} more ${additional === 1 ? "domain" : "domains"}`
                          : domainCount === 0
                            ? "Make this application available from a URL"
                            : "Manage DNS checks and redirect settings"}
                      </p>
                    </div>
                  </a>
                  <a className="button relative z-10 ml-auto shrink-0" aria-label={domainCount > 0 ? "Manage application domains" : "Add an application domain"} href={domainsUrl}>
                    {domainCount > 0 ? "Manage domains" : "Add domain"}
                    <Reicon name="arrow-right" className="size-4" />
                  </a>
                </div>
              </section>

              <section id="internal-access-section" className="pt-5">
                <h3 className="mb-4 text-sm font-semibold text-black dark:text-fg">Internal access</h3>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <FormInput label="Internal hostname" value="No deployed container found" readOnly />
                  <FormInput label="Docker network" value={application.destination?.network ?? ""} readOnly />
                  <FormInput label="Exposed ports" value={exposed || "None"} readOnly />
                  <FormInput label="Network aliases" value={aliases || "None"} readOnly />
                </div>
                <div className="mt-4 flex flex-col gap-3 border-t border-neutral-200 pt-4 sm:flex-row sm:items-center sm:justify-between dark:border-white/[0.07]">
                  <p className="text-sm text-neutral-500 dark:text-fg-dim">Internal hostnames are only reachable by resources connected to this Docker network.</p>
                  <button type="button" className="button shrink-0" onClick={() => setNetworking(true)}>
                    Edit networking
                  </button>
                </div>
              </section>
            </SettingsSection>

            <SettingsSection
              id="build-pipeline-section"
              title="Build & deploy"
              helper="How Freeploy builds the application, where it pushes the image, and the commands it runs around each deployment."
            >
              <div className="flex flex-col gap-5">
                <p className="text-sm text-neutral-500 dark:text-fg-dim">Nothing to build. This application deploys a prebuilt Docker image.</p>
              </div>
              <SettingsSubsection id="container-image-section" title="Image">
                <div className="grid gap-4 lg:grid-cols-2">
                  <FormInput {...field("dockerRegistryImageName")} label="Image" placeholder="nginx" required={swarm} />
                  <FormInput
                    {...field("dockerRegistryImageTag")}
                    label="Tag"
                    placeholder="alpine"
                    helper="Enter a tag (e.g., 'latest', 'v1.2.3') or SHA256 hash (e.g., 'sha256-59e02939b1bf39f16c93138a28727aec520bb916da021180ae502c61626b3cf0')"
                  />
                </div>
              </SettingsSubsection>
              <SettingsSubsection id="deployment-lifecycle-section" title="Deployment commands">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-4">
                    <FormInput
                      {...field("preDeploymentCommand")}
                      placeholder="php artisan migrate"
                      label="Pre-deployment"
                      helper={"An optional script or command to execute in the existing container before the deployment begins.\nIt is always executed with 'sh -c', so you do not need add it manually."}
                    />
                  </div>
                  <div className="flex flex-col gap-4">
                    <FormInput
                      {...field("postDeploymentCommand")}
                      placeholder="php artisan migrate"
                      label="Post-deployment"
                      helper={"An optional script or command to execute in the newly built container after the deployment completes.\nIt is always executed with 'sh -c', so you do not need add it manually."}
                    />
                  </div>
                </div>
              </SettingsSubsection>
            </SettingsSection>

            <SettingsSection id="container-section" title="Container" helper="Options and labels applied to the container when it starts.">
              <FormInput
                {...field("customDockerRunOptions")}
                helper={
                  "You can add custom docker run options that will be used when your container is started.\nNote: Not all options are supported, as they could mess up Freeploy's automation and could cause bad experience for users."
                }
                placeholder="--cap-add SYS_ADMIN --device=/dev/fuse --security-opt apparmor:unconfined --ulimit nofile=1024:1024 --tmpfs /run:rw,noexec,nosuid,size=65536k --hostname=myapp"
                label="Custom Docker options"
              />
            </SettingsSection>
          </div>
        </form>

        <ModalInput title="Networking" subtitle="Ports the container exposes, host port mappings and internal network aliases." open={networking} onOpenChange={setNetworking}>
          <form onSubmit={onSubmit} className="flex flex-col">
            {(form.portsExposes === "" || form.portsExposes === "0") && application.fqdn ? (
              <Callout type="info" title="No ports exposed" className="mb-4">
                This application does not expose any ports and will not be reachable through the proxy or your domains. This behavior is normal for background workers, bots, or scheduled tasks. If your
                application needs to handle HTTP traffic, please specify the port(s) it listens on.
              </Callout>
            ) : null}
            <div className="grid gap-4 lg:grid-cols-[14rem_16rem_minmax(0,1fr)]">
              <div className="min-w-0">
                <FormInput
                  {...field("portsExposes")}
                  placeholder="3000,3001"
                  label="Ports exposes"
                  readOnly={!readonlyLabels}
                  helper={
                    readonlyLabels
                      ? `A comma separated list of ports your application uses. The first port will be used as default healthcheck port if nothing defined in the Healthcheck menu. Be sure to set this correctly.\n\n${portsHint}`
                      : `Readonly labels are disabled. You can set the ports manually in the labels section.\n\n${portsHint}`
                  }
                />
                <p className="mt-1.5 text-xs text-neutral-500 dark:text-fg-dim">
                  You can also set an internal port per domain on{" "}
                  <a className="underline dark:text-white" href={domainsUrl}>
                    Domains
                  </a>
                  .
                </p>
              </div>
              {swarm ? null : (
                <FormInput
                  {...field("portsMappings")}
                  placeholder="3000:3000"
                  label="Port mappings"
                  helper={
                    "A comma separated list of ports you would like to map to the host system. Useful when you do not want to use domains.\n\nFormat: host:container\n\nExample: 3000:3000,3002:3002\n\nRolling update is not supported if you have a port mapped to the host."
                  }
                />
              )}
              {swarm ? null : (
                <FormInput
                  {...field("customNetworkAliases")}
                  label="Network aliases"
                  helper={"A comma separated list of custom network aliases you would like to add for container in Docker network.\n\nExample:\napi.internal,api.local"}
                />
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2 border-t border-neutral-200 pt-4 dark:border-white/[0.07]">
              <Button onClick={() => setNetworking(false)}>Close</Button>
              <Button type="submit" highlighted disabled={!canUpdate}>
                Save
              </Button>
            </div>
          </form>
        </ModalInput>
      </div>
    </ApplicationWorkspace>
  );
}

export function ApplicationGeneralPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ApplicationGeneralContent />
    </Layout>
  );
}
