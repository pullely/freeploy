// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/service/{index,advanced-settings}.blade.php
// (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/service/{service_uuid}/{stack_service_uuid} (project.service.index): one
// application's or database's settings — Index, which Coolify opens in a dialog from the service's resource card
// and Freeploy shows as this page inside the service's frame. An application's domains are edited here, with the
// rules of its save (Coolify edits them on the service's Domains page, which is not ported).
import { useCallback, useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { toast } from "../lib/toast";
import { Button, FormInput, Listbox, ModalConfirmation, StatusBadge } from "../components/Coolify";
import { Reicon } from "../components/Reicon";
import { environmentPath, environmentUuidFromPath, limit, projectUuidFromPath } from "./ProjectChrome";
import { servicePath, serviceUuidFromPath } from "../lib/service-templates";
import { sendJson, showError, showSaved } from "./ApplicationResource";
import { serviceApi, ServiceWorkspace, type ServiceInfo, type ServicePartSummary } from "./ServiceChrome";

interface Part extends ServicePartSummary {
  isLogDrainEnabled: boolean;
  isGzipEnabled?: boolean;
  isStripprefixEnabled?: boolean;
  certificateResolverMode?: "server" | "none" | "custom";
  certificateResolverName?: string | null;
  maxRestartCount?: number;
  showCertificateResolver?: boolean;
  serverCertificateResolver?: string;
  publicPort?: number | null;
  publicPortTimeout?: number | null;
  isPublic?: boolean;
}

interface Page {
  service: ServiceInfo;
  part: Part;
  canUpdate: boolean;
}
type Saved = Omit<Page, "canUpdate"> & { message: string | null; warning?: string; unavailable?: string };

/** The part's uuid: the segment after the service's. */
const partUuidFromPath = (pathname = window.location.pathname) => decodeURIComponent(pathname.split("/")[7] ?? "");
const IMAGE_HELPER = "You can change the image you would like to deploy.\n\nWARNING. You could corrupt your data. Only do it if you know what you are doing.";

function ServicePartContent() {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const uuid = serviceUuidFromPath();
  const partUuid = partUuidFromPath();
  const api = `${serviceApi(me.team?.id, uuid)}/parts/${encodeURIComponent(partUuid)}`;
  const [page, setPage] = useState<Page | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const show = useCallback((data: Omit<Page, "canUpdate">, canUpdate: boolean) => {
    setPage({ ...data, canUpdate });
    const p = data.part;
    setForm({
      humanName: p.humanName ?? "",
      description: p.description ?? "",
      image: p.image ?? "",
      fqdn: p.fqdn ?? "",
      isGzipEnabled: String(p.isGzipEnabled ?? true),
      isStripprefixEnabled: String(p.isStripprefixEnabled ?? true),
      excludeFromStatus: String(p.excludeFromStatus),
      isLogDrainEnabled: String(p.isLogDrainEnabled),
      maxRestartCount: String(p.maxRestartCount ?? 0),
      certificateResolverMode: p.certificateResolverMode ?? "server",
      certificateResolverName: p.certificateResolverName ?? "",
      publicPort: p.publicPort === null || p.publicPort === undefined ? "" : String(p.publicPort),
    });
  }, []);

  useEffect(() => {
    void (async () => {
      const r = await getJson<Page>(api);
      if (!r.data) {
        if (r.status === 404) window.location.replace(environmentPath(projectUuid, environmentUuid));
        return;
      }
      show(r.data, r.data.canUpdate);
    })();
  }, [api, projectUuid, environmentUuid, show]);
  useEffect(() => {
    if (page) document.title = `${limit(page.service.name, 10)} > ${limit(page.part.name, 10)} | Freeploy`;
  }, [page]);

  if (!page) return null;
  const { service, part, canUpdate } = page;
  const isApplication = part.kind === "application";
  const back = servicePath(service.project.uuid, service.environment.uuid, service.uuid);
  const set = (field: string) => (value: string) => setForm({ ...form, [field]: value });

  async function send(body: Record<string, unknown>) {
    setSaving(true);
    const r = await sendJson<Saved>("PATCH", api, body);
    setSaving(false);
    if (!r.ok) return showError(r.error);
    show(r.data, canUpdate);
    showSaved(r.data);
    if (r.data.warning) toast(r.data.warning.replace(/<br>/g, "\n"), { type: "warning" });
  }

  /** submitApplication() / submitDatabase() */
  const submit = () =>
    send({
      action: "submit",
      humanName: form.humanName,
      description: form.description,
      image: form.image,
      excludeFromStatus: form.excludeFromStatus === "true",
      isLogDrainEnabled: form.isLogDrainEnabled === "true",
      ...(isApplication
        ? {
            fqdn: form.fqdn,
            isGzipEnabled: form.isGzipEnabled === "true",
            isStripprefixEnabled: form.isStripprefixEnabled === "true",
            maxRestartCount: form.maxRestartCount,
            certificateResolverMode: form.certificateResolverMode,
            certificateResolverName: form.certificateResolverName,
          }
        : { publicPort: form.publicPort === "" ? null : form.publicPort }),
    });

  /** deleteApplication() / deleteDatabase(): then back to the service. */
  async function remove() {
    const r = await sendJson<{ message: string }>("DELETE", api);
    if (!r.ok) return showError(r.error);
    showSaved(r.data);
    window.location.assign(back);
  }

  const listbox = (id: string, label: string, options: Array<[string, string]>, helper?: string, disabled = !canUpdate) => (
    <Listbox id={id} label={label} {...(helper ? { helper } : {})} disabled={disabled} value={form[id] ?? null} onChange={set(id)} options={options.map(([value, text]) => ({ value, label: text }))} />
  );
  const displayName = part.displayName;

  return (
    <ServiceWorkspace service={service} orgId={me.team?.id} active="General" canUpdate={canUpdate}>
      <div className="mb-4 flex items-center gap-2">
        <a className="menu-item" href={back}>
          <Reicon name="logout" className="menu-item-icon rotate-180" />
          <span className="menu-item-label">Back to service</span>
        </a>
        <h2 className="text-[15px] font-semibold text-black dark:text-fg">{part.humanName || part.name}</h2>
        {part.isRemovedFromCompose ? <StatusBadge label="Not in Compose file" type="error" /> : null}
      </div>
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormInput id="humanName" label="Name" placeholder={isApplication ? "Human readable name" : "Name"} value={form.humanName ?? ""} disabled={!canUpdate} onChange={set("humanName")} />
            <FormInput id="description" label="Description" value={form.description ?? ""} disabled={!canUpdate} onChange={set("description")} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {isApplication ? <FormInput id="fqdn" label="Domains" helper="Comma separated list of domains." value={form.fqdn ?? ""} disabled={!canUpdate} onChange={set("fqdn")} /> : null}
            <FormInput id="image" label="Image" required={Boolean(part.image)} helper={IMAGE_HELPER} value={form.image ?? ""} disabled={!canUpdate} onChange={set("image")} />
          </div>
        </div>

        {!isApplication ? (
          <div className="border-t border-neutral-200 pt-5 dark:border-white/[0.06]">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-black dark:text-fg">Public access</h3>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="w-full sm:max-w-xs">
                <FormInput type="number" id="publicPort" label="Public Port" placeholder="5432" disabled={!canUpdate || part.isPublic === true} value={form.publicPort ?? ""} onChange={set("publicPort")} />
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {part.isPublic ? (
                  <>
                    <StatusBadge label="Public" type="success" />
                    <Button disabled={!canUpdate} onClick={() => void send({ action: "publicAccess", isPublic: false, publicPort: form.publicPort || null })}>
                      Make private
                    </Button>
                  </>
                ) : (
                  <Button disabled={!canUpdate || (form.publicPort ?? "").trim() === ""} onClick={() => void send({ action: "publicAccess", isPublic: true, publicPort: form.publicPort })}>
                    Make publicly available
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {/* advanced-settings.blade.php */}
        <div className="grid gap-4 sm:grid-cols-2">
          {isApplication ? (
            <>
              {(part.image ?? "").includes("pocketbase")
                ? listbox("isGzipEnabled", "Gzip compression", [["true", "Enabled"], ["false", "Disabled"]], "PocketBase keeps compression disabled so server-sent events continue to work.", true)
                : listbox("isGzipEnabled", "Gzip compression", [["true", "Enabled"], ["false", "Disabled"]])}
              {listbox("isStripprefixEnabled", "Path prefixes", [["true", "Strip prefixes"], ["false", "Keep prefixes"]])}
            </>
          ) : null}
          {listbox("excludeFromStatus", "Service status", [["false", "Include in status"], ["true", "Exclude from status"]])}
          {listbox("isLogDrainEnabled", "Log drain", [["true", "Send logs to drain"], ["false", "Do not drain logs"]])}
          {isApplication ? (
            <FormInput
              type="number"
              min={0}
              id="maxRestartCount"
              label="Max restart count"
              helper="Maximum number of Docker restarts before Freeploy stops this container. Set to 0 to disable the limit. Docker counts expected and unexpected restarts."
              value={form.maxRestartCount ?? "0"}
              disabled={!canUpdate}
              onChange={set("maxRestartCount")}
            />
          ) : null}
          {isApplication && part.showCertificateResolver ? (
            <>
              {listbox(
                "certificateResolverMode",
                "Certificate resolver",
                [
                  ["server", `Server setting (${part.serverCertificateResolver ?? ""})`],
                  ["none", "None (use your own certificates)"],
                  ["custom", "Custom resolver"],
                ],
                "Sets the Traefik certificate resolver for this service's HTTPS routes. Choose None for domains that use certificates from Traefik's dynamic configuration (for example Cloudflare Origin CA certificates). Restart or redeploy the service to apply the change.",
              )}
              {form.certificateResolverMode === "custom" ? (
                <FormInput id="certificateResolverName" label="Certificate resolver name" placeholder="cloudflare" required helper="Name of a certificate resolver defined in the Traefik configuration of this server." value={form.certificateResolverName ?? ""} disabled={!canUpdate} onChange={set("certificateResolverName")} />
              ) : null}
            </>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 pt-5 dark:border-white/[0.08]">
          <div>
            {canUpdate ? (
              <ModalConfirmation
                title={isApplication ? "Confirm Service Application Deletion?" : "Confirm Service Database Deletion?"}
                buttonTitle="Delete"
                actions={[isApplication ? "The selected service application container will be stopped and permanently deleted." : "The selected service database container will be stopped and permanently deleted."]}
                confirmationText={displayName}
                confirmationLabel={`Please confirm the execution of the actions by entering the ${isApplication ? "Service Application" : "Service Database"} Name below`}
                shortConfirmationLabel={isApplication ? "Service Application Name" : "Service Database Name"}
                onSubmit={remove}
              />
            ) : null}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {canUpdate ? (
              <Button type="submit" highlighted disabled={saving}>
                Save changes
              </Button>
            ) : null}
          </div>
        </div>
      </form>
    </ServiceWorkspace>
  );
}

export function ServicePartPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ServicePartContent />
    </Layout>
  );
}
