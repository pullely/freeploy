// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/show.blade.php,
// resources/views/livewire/server/partials/force-disabled-callout.blade.php and
// app/Livewire/Server/Show.php (Apache-2.0), modified.
//
// /server/{uuid}: General. Connection settings, the server role, and the
// overview. Validating the connection and fetching server details need the
// SSH executor, which is not deployed yet: the API says so and the page shows
// it as Coolify shows a failed action, an error toast. Cloud provider linking
// and server transfers are not ported.
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify, toast } from "../lib/toast";
import { takeNotice } from "../lib/flash";
import { Reicon } from "../components/Reicon";
import { Button, DangerCallout, FormInput, Listbox, ModalConfirmation, SettingsSection, StatusBadge, UnsavedBar } from "../components/Coolify";
import { limit, SERVER_ROLE_OPTIONS, serverUuidFromPath, ServerWorkspace, type ServerInfo } from "./ServerChrome";

/** The fields the form saves (the unsaved bar's targets). */
interface General {
  name: string;
  description: string;
  ip: string;
  user: string;
  port: string;
  connectionTimeout: string;
  serverTimezone: string;
  wildcardDomain: string;
  publicIpv4: string;
  publicIpv6: string;
}

function generalOf(s: ServerInfo): General {
  return {
    name: s.name,
    description: s.description ?? "",
    ip: s.ip,
    user: s.user,
    port: String(s.port),
    connectionTimeout: String(s.connectionTimeout),
    serverTimezone: s.serverTimezone,
    wildcardDomain: s.wildcardDomain ?? "",
    publicIpv4: s.publicIpv4 ?? "",
    publicIpv6: s.publicIpv6 ?? "",
  };
}

/** Show::timezones(): timezone_identifiers_list(), sorted; here the runtime's list with UTC. */
function timezoneOptions(): Array<{ value: string; label: string }> {
  const list = new Set<string>(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []);
  list.add("UTC");
  return [...list].sort().map((tz) => ({ value: tz, label: tz }));
}

function ServerShowContent() {
  const { me } = useSignedIn();
  const uuid = serverUuidFromPath();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/servers/${encodeURIComponent(uuid)}`;
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [canUpdate, setCanUpdate] = useState(false);
  const [form, setForm] = useState<General | null>(null);
  const [saved, setSaved] = useState<General | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [confirmRole, setConfirmRole] = useState(0);
  const timezones = useMemo(timezoneOptions, []);

  const load = useCallback(async () => {
    const r = await getJson<{ server: ServerInfo; canUpdate: boolean }>(base);
    if (!r.data) {
      if (r.status === 404) window.location.replace("/servers");
      return;
    }
    setServer(r.data.server);
    setCanUpdate(r.data.canUpdate);
    const g = generalOf(r.data.server);
    setForm(g);
    setSaved(g);
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  // DP-118: what the cloud server form could not do yet after it stored the server (its validation over SSH).
  useEffect(() => {
    const notice = takeNotice();
    if (notice) notify.error(notice);
  }, []);
  useEffect(() => {
    if (server) document.title = `${limit(server.name, 24)} | Server | Freeploy`;
  }, [server]);

  const dirty = form !== null && saved !== null && (Object.keys(form) as Array<keyof General>).some((k) => form[k] !== saved[k]);

  /** Show::submit(): 'Server settings updated.' */
  const submit = useCallback(async () => {
    if (!form) return;
    setSaving(true);
    const r = await postJson<{ server: ServerInfo; message: string }>(base, form, "PATCH");
    setSaving(false);
    if (!r.ok) {
      const fields = r.error.fields ?? {};
      const inline: Record<string, string> = {};
      for (const [f, m] of Object.entries(fields)) if (m[0]) inline[f] = m[0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    setServer(r.data.server);
    const g = generalOf(r.data.server);
    setForm(g);
    setSaved(g);
    notify.success(r.data.message);
  }, [base, form]);

  /** requestServerRoleChange() / confirmServerRoleChange(). */
  async function changeRole(role: string, confirmed = false) {
    const r = await postJson<{ confirm?: boolean; serverRole?: string; info?: string | null; message?: string }>(`${base}/role`, { serverRole: role, confirmed }, "PATCH");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    if (r.data.confirm) return setConfirmRole((n) => n + 1);
    if (r.data.info) toast(r.data.info, { type: "info" });
    if (r.data.message) notify.success(r.data.message);
    setServer((s) => (s ? { ...s, serverRole: (r.data.serverRole as ServerInfo["serverRole"]) ?? s.serverRole } : s));
  }

  async function validateServer() {
    const r = await postJson(`${base}/validate`, {});
    if (!r.ok) notify.error(summarize(r.error.messages));
  }

  if (!server || !form) return null;
  const set = (k: keyof General) => (v: string) => setForm({ ...form, [k]: v });
  const locked = !canUpdate || server.isValidating;
  const connectionLocked = locked || server.isTransferredAway;
  const functional = server.isFunctional;

  return (
    <>
    <ServerWorkspace server={server} orgId={me.team?.id} active="general" canUpdate={canUpdate}>
      <div className="w-full min-w-0">
        {server.sshHostKeyPending ? (
          <DangerCallout title="The SSH host key of this server changed">
            The server sent a host key that does not match the key that Freeploy trusts. Check it on the{" "}
            <a href={`/server/${server.uuid}/security#server-host-key-section`} className="underline">
              Security
            </a>{" "}
            page.
          </DangerCallout>
        ) : null}
        <form
          className="application-settings-form flex flex-col gap-6"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            void submit();
          }}
        >
          <UnsavedBar dirty={dirty} saving={saving} onSave={() => void submit()} />
          <SettingsSection
            id="server-connection-section"
            title="Connection"
            helper="Configure how Freeploy identifies, reaches, and validates this server."
            badges={
              server.isTransferredAway ? (
                <StatusBadge label="Transferred away" type="warning" />
              ) : (
                <StatusBadge label={functional ? "Ready" : "Validation required"} type={functional ? "success" : "warning"} />
              )
            }
            actions={
              !server.isTransferredAway ? (
                <Button highlighted={!functional} disabled={!canUpdate} onClick={() => void validateServer()}>
                  <Reicon name={functional ? "refresh" : "alert-circle"} className="size-3.5" />
                  {functional ? "Revalidate connection" : "Validate connection"}
                </Button>
              ) : undefined
            }
          >
            {server.isTransferredAway ? (
              <DangerCallout title="Transferred to another instance">
                This server was transferred to <strong>another Freeploy instance</strong>, which manages it now. Use that instance.
              </DangerCallout>
            ) : null}
            {server.isForceDisabled && !server.isTransferredAway ? (
              <DangerCallout title="Server disabled">
                Freeploy disabled this server because it was unreachable for more than 7 days. Freeploy does not connect to it. Correct the connection settings, then click{" "}
                <strong>Validate connection</strong>. When the connection works, the server is enabled again.
              </DangerCallout>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <FormInput id="name" label="Name" required disabled={locked} value={form.name} onChange={set("name")} error={errors.name} />
              <FormInput id="description" label="Description" disabled={locked} value={form.description} onChange={set("description")} error={errors.description} />
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <FormInput
                id="ip"
                type="password"
                label="IP address or domain"
                helper="Enter a hostname or IP address without http:// or https://."
                required
                disabled={connectionLocked}
                value={form.ip}
                onChange={set("ip")}
                error={errors.ip}
              />
              <FormInput id="user" label="SSH user" required disabled={connectionLocked} value={form.user} onChange={set("user")} error={errors.user} />
              <FormInput id="port" type="number" label="SSH port" required disabled={connectionLocked} value={form.port} onChange={set("port")} error={errors.port} />
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-3">
              <FormInput
                id="connectionTimeout"
                type="number"
                label="Connection timeout"
                helper="Seconds to wait before an SSH connection fails."
                min={1}
                max={300}
                required
                disabled={locked}
                value={form.connectionTimeout}
                onChange={set("connectionTimeout")}
                error={errors.connectionTimeout}
              />
              <Listbox
                id="serverTimezone"
                label="Server timezone"
                helper="Used for backups, cron jobs, and displayed timestamps."
                searchable
                searchPlaceholder="Search timezones"
                searchEmptyText="No matching timezone"
                options={timezones}
                value={form.serverTimezone}
                onChange={set("serverTimezone")}
                disabled={locked}
                error={errors.serverTimezone}
              />
              {!server.isSwarmWorker && server.serverRole !== "build" ? (
                <FormInput
                  id="wildcardDomain"
                  label="Wildcard domain"
                  placeholder="https://example.com"
                  helper="New resources can receive generated subdomains from this domain."
                  disabled={locked}
                  value={form.wildcardDomain}
                  onChange={set("wildcardDomain")}
                  error={errors.wildcardDomain}
                />
              ) : null}
            </div>
            {!server.isLocalhost && !server.isSwarmWorker && server.serverRole !== "build" ? (
              <div className="mt-4 grid gap-4 lg:grid-cols-3">
                <FormInput
                  id="publicIpv4"
                  label="Public IPv4"
                  placeholder="203.0.113.10"
                  helper="Set this when Freeploy connects to the server over a private network. DNS checks and DNS records use this address instead of the IP address above."
                  disabled={locked}
                  value={form.publicIpv4}
                  onChange={set("publicIpv4")}
                  error={errors.publicIpv4}
                />
                <FormInput
                  id="publicIpv6"
                  label="Public IPv6"
                  placeholder="2001:db8::10"
                  helper="Set this when Freeploy connects to the server over a private network. DNS checks and DNS records use this address instead of the IP address above."
                  disabled={locked}
                  value={form.publicIpv6}
                  onChange={set("publicIpv6")}
                  error={errors.publicIpv6}
                />
              </div>
            ) : null}
            {!server.isLocalhost ? (
              <div className="mt-4 border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
                <Listbox
                  id="serverRole"
                  label="Server role"
                  helper="Builds can use large amounts of CPU and memory. Deployments on the same server can become slow or unreachable during a build. GitHub Actions runners need the Builds only or the Deployments and builds role."
                  disabled={locked}
                  options={SERVER_ROLE_OPTIONS}
                  value={server.serverRole}
                  onChange={(role) => void changeRole(role)}
                />
              </div>
            ) : null}
          </SettingsSection>
          <SettingsSection
            id="server-overview-section"
            title="Server overview"
            helper="Provider state, operating system, and hardware details."
            actions={
              <Button disabled={!functional} tooltip={functional ? null : "Validate the connection first."}>
                <Reicon name="refresh" className="size-3.5" />
                {server.hasServerMetadata ? "Refresh details" : "Fetch server details"}
              </Button>
            }
          >
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-600 dark:bg-white/[0.06] dark:text-fg-dim">
                <Reicon name="servers" className="size-4.5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-neutral-950 dark:text-fg">{server.name}</p>
                <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-fg-dim">
                  {server.isTransferredAway
                    ? "This server was migrated away from this Freeploy instance and cannot be managed here."
                    : functional
                      ? "The server is reachable, validated, and ready to host resources."
                      : "Validate the SSH connection before using this server."}
                </p>
              </div>
            </div>
          </SettingsSection>
          {server.validationLogs ? (
            <SettingsSection title="Previous validation output" helper="The latest output produced while checking this server.">
              <div className="max-h-72 overflow-auto rounded-lg bg-neutral-950 p-4 font-mono text-xs leading-5 text-neutral-300 whitespace-pre-wrap">{server.validationLogs}</div>
            </SettingsSection>
          ) : null}
        </form>
      </div>
    </ServerWorkspace>
      <ModalConfirmation
        title="Use this server for deployments and builds?"
        confirmationText={null}
        step2ButtonText="Enable deployments and builds"
        warningMessage="Builds can use a large amount of CPU and memory. During a build, deployed resources on this server can become slow or unreachable."
        actions={["Enable builds on this deployment server."]}
        openRequest={confirmRole}
        onSubmit={() => changeRole("both", true)}
        trigger={<button id="server-role-confirmation-trigger" type="button" className="hidden" aria-hidden="true" />}
      />
    </>
  );
}

export function ServerShowPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Server">
      <ServerShowContent />
    </Layout>
  );
}
