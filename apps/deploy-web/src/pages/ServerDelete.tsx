// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/delete.blade.php and
// app/Livewire/Server/Delete.php (Apache-2.0), modified.
//
// /server/{uuid}/danger: delete the server. The confirmation asks for the
// server's name; Coolify also asks for the account password, which
// deploy-core cannot check yet, so that step is left out. Resources, cloud
// provider servers and the SSH key option have nothing to act on yet
// (resources, providers and the SSH executor are not ported), so the
// dialog has no checkboxes.
import { useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { DangerZone, ModalConfirmation, SettingsSection } from "../components/Coolify";
import { limit, serverUuidFromPath, ServerWorkspace, type ServerInfo } from "./ServerChrome";

function ServerDeleteContent() {
  const { me } = useSignedIn();
  const uuid = serverUuidFromPath();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/servers/${encodeURIComponent(uuid)}`;
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [canUpdate, setCanUpdate] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await getJson<{ server: ServerInfo; canUpdate: boolean }>(base);
      if (!r.data) {
        if (r.status === 404) window.location.replace("/servers");
        return;
      }
      setServer(r.data.server);
      setCanUpdate(r.data.canUpdate);
    })();
  }, [base]);
  useEffect(() => {
    if (server) document.title = `${limit(server.name, 10)} > Delete Server | Freeploy`;
  }, [server]);

  /** Delete::delete(): then redirectRoute('server.index'). */
  async function remove() {
    const r = await postJson<{ deleted: boolean }>(base, {}, "DELETE");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    window.location.assign("/servers");
  }

  if (!server) return null;
  const transferred = server.isTransferredAway;
  const hostinger = server.hostingerVirtualMachineId !== null && !transferred;
  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="danger" canUpdate={canUpdate}>
      <div className="application-settings-form w-full">
        <SettingsSection id="server-danger-section" title="Delete server" helper="Permanently remove this server and its configuration from Freeploy." className="server-danger-section">
          <DangerZone
            title="This action cannot be undone"
            action={
              <ModalConfirmation
                title="Confirm Server Deletion?"
                buttonTitle="Delete server"
                disabled={!canUpdate}
                actions={
                  transferred
                    ? ["This server and the records of its resources will be permanently deleted from this Freeploy instance. Nothing on the server changes."]
                    : ["This server will be permanently deleted from Freeploy."]
                }
                confirmationText={server.name}
                confirmationLabel="Please confirm by entering the Server Name below"
                shortConfirmationLabel="Server Name"
                onSubmit={remove}
              />
            }
          >
            <p>
              The server will be removed from Freeploy.
              {transferred
                ? " This server was transferred to another Freeploy instance. Only the records on this instance are deleted, also the records of its resources. The server, its containers, and its data stay as they are."
                : null}
            </p>
            {hostinger ? (
              <p>
                Hostinger deletes the VPS only at the end of its paid period, and only if you select this in the confirmation dialog.{" "}
                <a className="underline" href="https://hpanel.hostinger.com/" target="_blank" rel="noopener noreferrer">
                  Manage the VPS and billing in hPanel.
                </a>
              </p>
            ) : null}
            <p>Type the server name in the confirmation dialog to continue.</p>
          </DangerZone>
        </SettingsSection>
      </div>
    </ServerWorkspace>
  );
}

export function ServerDeletePage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Delete Server">
      <ServerDeleteContent />
    </Layout>
  );
}
