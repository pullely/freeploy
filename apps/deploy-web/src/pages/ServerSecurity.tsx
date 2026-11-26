// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/security/{index,host-key,terminal-access,
// patches}.blade.php and app/Livewire/Server/Security/{Index,HostKey,TerminalAccess,Patches}.php (Apache-2.0), modified.
//
// /server/{uuid}/security: the SSH host key and terminal access; /server/{uuid}/security/patches: server patching.
// Both are for who may update the server (writers). Terminal access is a row and is saved. Every host key change is
// saved by Coolify and then checked with a new connection (ServerConnectionCheckJob, over SSH): its API answers that
// the check is not available yet and nothing is stored. Patching runs the package manager on the server, so a server
// that is not validated shows Coolify's empty state, and Check for updates on a validated one is not available yet.
// The confirmations ask for the server name, not the account password (deploy-core cannot check it yet).
import { useCallback } from "react";
import { Layout } from "../layout/Layout";
import { Reicon } from "../components/Reicon";
import { Button, Callout, DangerCallout, Empty, Listbox, ModalConfirmation, SettingsSection, StatusBadge } from "../components/Coolify";
import { limit, ServerWorkspace, useServerPage, type ServerPageData } from "./ServerChrome";

interface SecurityData extends ServerPageData {
  hostKey: {
    mode: "warn" | "enforce" | "off";
    instanceMode: string;
    fingerprints: string[];
    pendingFingerprints: string[];
    pendingKeyHash: string | null;
    source: string | null;
    trustedAt: string | null;
    checkDisabled: boolean;
    checkEnforced: boolean;
  };
  terminal: { isTerminalEnabled: boolean };
}

interface PatchesData extends ServerPageData {
  patches: {
    checkedAt: string | null;
    error: string | null;
    totalUpdates: number;
    securityUpdates: number | null;
    rebootRequired: boolean;
    packageManager: string | null;
    frequency: string;
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The host key's source, as the view words it. */
function sourceLabel(source: string | null): string {
  switch (source) {
    case "tofu":
      return "Saved on the first connection";
    case "upgrade":
      return "Saved on the first connection after the Coolify upgrade";
    case "transfer":
      return "Moved with the server transfer";
    case "manual":
      return "Saved by a user";
    default:
      return "Saved";
  }
}

function HostKey({ data, act }: { data: SecurityData; act: ReturnType<typeof useServerPage<SecurityData>>["act"] }) {
  const { server, hostKey: k, canUpdate } = data;
  const pending = k.pendingFingerprints.length > 0;
  const badge = pending ? (
    <StatusBadge label="Key changed" type="error" />
  ) : k.mode === "off" ? (
    <StatusBadge label="Check off" type="warning" />
  ) : k.fingerprints.length > 0 ? (
    <StatusBadge label={`Trusted, ${k.mode} mode`} type="success" />
  ) : (
    <StatusBadge label="No key yet" type="neutral" />
  );
  return (
    <div className="application-settings-form flex w-full flex-col gap-6">
      {pending ? (
        <DangerCallout title="The SSH host key of this server changed" className="">
          {k.pendingFingerprints.map((f) => (
            <code key={f} className="block break-all">
              {f}
            </code>
          ))}
          <p className="mt-2">
            {k.mode === "enforce" ? "Freeploy does not connect until you trust or reset the key." : "Freeploy still connects (warn mode)."} Expected after a reinstall. Otherwise, compare the key on the server before you trust it.
          </p>
        </DangerCallout>
      ) : null}

      <SettingsSection
        id="server-host-key-section"
        title="SSH host key"
        helper="Freeploy trusts the first host key of the server. Later, a different key is reported (warn mode, the default) or refused (enforce mode). The setting below sets enforce mode for this server only."
        badges={badge}
        actions={
          canUpdate ? (
            <div className="flex flex-wrap items-center gap-2">
              {pending ? (
                <ModalConfirmation
                  title="Trust the new host key?"
                  buttonTitle="Trust new key"
                  actions={["Freeploy trusts the new host key and stops trusting the old key.", "Only do this after you compared the new key with the key on the server."]}
                  confirmationText={server.name}
                  shortConfirmationLabel="Server Name"
                  step2ButtonText="Trust New Key"
                  onSubmit={async () => void (await act("security/host-key/trust", { pendingKeyHash: k.pendingKeyHash }))}
                />
              ) : null}
              <ModalConfirmation
                title="Reset the host key?"
                buttonTitle="Reset"
                actions={["Freeploy removes the trusted key and the new key.", "Freeploy trusts the key that the server sends on the next connection."]}
                confirmationText={server.name}
                shortConfirmationLabel="Server Name"
                step2ButtonText="Reset Host Key"
                onSubmit={async () => void (await act("security/host-key/reset"))}
              />
              <ModalConfirmation
                title={k.checkDisabled ? "Enable the host key check?" : "Disable the host key check?"}
                buttonTitle={k.checkDisabled ? "Enable check" : "Disable check"}
                actions={
                  k.checkDisabled
                    ? ["Freeploy checks the host key of this server again."]
                    : ["Freeploy does not check the host key of this server.", "Use this only for a server that changes its host key often, for example a load balancer address or a server that you rebuild often."]
                }
                confirmationText={server.name}
                shortConfirmationLabel="Server Name"
                step2ButtonText="Confirm"
                onSubmit={async () => void (await act("security/host-key/check", { disabled: !k.checkDisabled }))}
              />
            </div>
          ) : null
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          {k.mode === "off" ? (
            <Callout type="warning" title="The host key check is off">
              {k.checkDisabled ? "Disabled for this server." : "Disabled for this instance."}
            </Callout>
          ) : null}
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-white/[0.06] dark:text-fg-dim">
              <Reicon name="keys" className="size-4" />
            </div>
            <div className="min-w-0">
              {k.fingerprints.length ? (
                k.fingerprints.map((f) => (
                  <code key={f} className="block break-all text-xs">
                    {f}
                  </code>
                ))
              ) : (
                <p className="font-medium text-neutral-950 dark:text-fg">No key yet</p>
              )}
              <p className="mt-1 text-xs text-neutral-500 dark:text-fg-dim">
                {k.fingerprints.length ? (
                  <>
                    {sourceLabel(k.source)}
                    {k.trustedAt ? <> &middot; Trusted {k.trustedAt} UTC</> : null} &middot;{" "}
                  </>
                ) : (
                  <>Saved on the next connection &middot; </>
                )}
                Mode: {k.mode}
                {k.mode === "enforce" && k.instanceMode !== "enforce" ? " (set for this server)" : ""}
              </p>
            </div>
          </div>
          {k.instanceMode !== "enforce" && k.instanceMode !== "off" && !k.checkDisabled ? (
            <div className="max-w-sm">
              <Listbox
                id="checkMode"
                label="When the host key changes"
                helper="Warn: Freeploy connects and reports the new key. Enforce: Freeploy refuses to connect until you trust or reset the new key, so deployments, backups, and checks on this server stop. A reinstall of the server also changes the key."
                options={[
                  { value: "warn", label: "Warn and connect" },
                  { value: "enforce", label: "Refuse to connect (enforce)" },
                ]}
                value={k.checkEnforced ? "enforce" : "warn"}
                onChange={(mode) => void act("security/host-key/mode", { mode }, "PATCH")}
                disabled={!canUpdate}
              />
            </div>
          ) : null}
        </div>
      </SettingsSection>
    </div>
  );
}

function TerminalAccess({ data, act, onChange }: { data: SecurityData; act: ReturnType<typeof useServerPage<SecurityData>>["act"]; onChange: (enabled: boolean) => void }) {
  const { server, canUpdate } = data;
  const enabled = data.terminal.isTerminalEnabled;
  return (
    <div className="application-settings-form w-full">
      <SettingsSection
        id="server-terminal-access-section"
        title="Terminal access"
        helper="Control dashboard terminal access for this server and its containers."
        badges={<StatusBadge label={enabled ? "Enabled" : "Disabled"} type={enabled ? "success" : "neutral"} />}
        actions={
          canUpdate ? (
            <ModalConfirmation
              key={String(enabled)}
              title="Confirm Terminal Access Change?"
              buttonTitle={enabled ? "Disable terminal" : "Enable terminal"}
              actions={[enabled ? "Disable terminal access for this server and all of its containers." : "Enable terminal access for this server and all of its containers.", "The change takes effect immediately for every user."]}
              confirmationText={server.name}
              shortConfirmationLabel="Server Name"
              step2ButtonText={enabled ? "Disable Terminal" : "Enable Terminal"}
              onSubmit={async () => {
                const r = await act<{ terminal: { isTerminalEnabled: boolean } }>("security/terminal");
                if (r) onChange(r.terminal.isTerminalEnabled);
              }}
            />
          ) : null
        }
      >
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-white/[0.06] dark:text-fg-dim">
            <Reicon name="browser-terminal" className="size-4" />
          </div>
          <div>
            <p className="text-sm font-medium text-neutral-950 dark:text-fg">{enabled ? "Dashboard terminal is available" : "Dashboard terminal is blocked"}</p>
            <p className="mt-1 max-w-xl text-xs leading-5 text-neutral-500 dark:text-fg-dim">
              This setting applies to every user, including administrators and the team owner. Only administrators and owners can change it.
            </p>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}

function ServerSecurityContent() {
  const title = useCallback((name: string) => `${limit(name, 10)} > Security | Freeploy`, []);
  const { me, data, setData, act } = useServerPage<SecurityData>("security", title);
  if (!data) return null;
  return (
    <ServerWorkspace server={data.server} orgId={me.team?.id} active="security" activeSub="overview" canUpdate={data.canUpdate}>
      <div className="application-settings-form flex w-full min-w-0 flex-col gap-6">
        <HostKey data={data} act={act} />
        <TerminalAccess data={data} act={act} onChange={(enabled) => setData((d) => (d ? { ...d, terminal: { isTerminalEnabled: enabled } } : d))} />
      </div>
    </ServerWorkspace>
  );
}

function ServerPatchesContent() {
  const title = useCallback((name: string) => `${limit(name, 10)} > Patching | Freeploy`, []);
  const { me, data, act } = useServerPage<PatchesData>("security/patches", title);
  if (!data) return null;
  const { server, patches: p, canUpdate } = data;
  const status = p.error ? (
    <StatusBadge label="Check failed" type="error" />
  ) : p.checkedAt ? (
    p.totalUpdates === 0 ? (
      <StatusBadge label="Up to date" type="success" />
    ) : (p.securityUpdates ?? 0) > 0 ? (
      <StatusBadge label={plural(p.securityUpdates ?? 0, "security update")} type="error" />
    ) : (
      <StatusBadge label={plural(p.totalUpdates, "update")} type="warning" />
    )
  ) : (
    <StatusBadge label="Not checked yet" type="neutral" />
  );
  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="security" activeSub="patches" canUpdate={canUpdate}>
      <div className="application-settings-form flex w-full min-w-0 flex-col gap-6">
        {!server.isFunctional ? (
          <Empty size="sm" iconName="shield-alert" title={`Freeploy cannot reach ${server.name}.`} description="Patching runs commands on the server. Validate the server first." />
        ) : (
          <SettingsSection
            id="server-patching-overview-section"
            title="Server patching"
            helper="Discover and apply operating system package updates."
            badges={
              <>
                {status}
                {p.rebootRequired ? <StatusBadge label="Reboot required" type="warning" /> : null}
              </>
            }
            actions={canUpdate ? <Button onClick={() => void act("security/patches/check")}>Check for updates</Button> : null}
          >
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-600 dark:text-fg-dim">
                <span>Last checked: {p.checkedAt ?? "never"}</span>
              </div>
              <Callout type="info" title="Supported package managers">
                Automated package discovery currently supports apk, apt, dnf, pacman, and zypper. Automatic security updates are available for apt and dnf (Debian, Ubuntu, and RHEL family). Status notifications can be managed from{" "}
                <a className="font-medium underline" href="/notifications/email">
                  notification settings
                </a>
                .
              </Callout>
            </div>
          </SettingsSection>
        )}
      </div>
    </ServerWorkspace>
  );
}

export function ServerSecurityPage({ page }: { page: "overview" | "patches" }) {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle={page === "patches" ? "Patching" : "Security"}>
      {page === "patches" ? <ServerPatchesContent /> : <ServerSecurityContent />}
    </Layout>
  );
}
