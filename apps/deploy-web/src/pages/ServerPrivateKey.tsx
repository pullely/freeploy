// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/private-key/show.blade.php and
// app/Livewire/Server/PrivateKey/Show.php (Apache-2.0), modified.
//
// /server/{uuid}/private-key: which of the org's SSH keys the server uses.
// Coolify checks the connection with a newly chosen key and keeps the old key
// when it fails; that check needs the SSH executor, so the key is stored
// unchecked and "Check connection" answers that it is not available yet.
import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Empty, ModalInput, SettingsSection, StatusBadge } from "../components/Coolify";
import { CreatePrivateKey } from "./PrivateKeys";
import { limit, serverUuidFromPath, ServerWorkspace, type ServerInfo } from "./ServerChrome";

interface KeyItem {
  uuid: string;
  name: string;
  description: string | null;
  publicKey: string;
  isActive: boolean;
}

function closeMenu(e: MouseEvent<HTMLElement>): void {
  const panel = e.currentTarget.closest<HTMLElement>(".listbox-panel");
  if (!panel) return;
  panel.style.display = "none";
  panel.removeAttribute("data-open");
}

/** window.copyPublicKeyToClipboard(). */
function copyPublicKey(publicKey: string): void {
  if (!publicKey || !navigator.clipboard?.writeText) {
    notify.error("Failed to copy public key to clipboard.");
    return;
  }
  navigator.clipboard.writeText(publicKey).then(
    () => notify.success("Public key copied to clipboard."),
    () => notify.error("Failed to copy public key to clipboard."),
  );
}

function ServerPrivateKeyContent() {
  const { me } = useSignedIn();
  const uuid = serverUuidFromPath();
  const orgBase = `/v1/organizations/${me.team?.id ?? ""}/deploy`;
  const base = `${orgBase}/servers/${encodeURIComponent(uuid)}`;
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [canUpdate, setCanUpdate] = useState(false);
  const [addOpen, setAddOpen] = useState(false);

  /** loadPrivateKeys(). */
  const load = useCallback(async () => {
    const r = await getJson<{ server: ServerInfo; privateKeys: KeyItem[]; canUpdate: boolean }>(`${base}/private-key`);
    if (!r.data) {
      if (r.status === 404) window.location.replace("/servers");
      return null;
    }
    setServer(r.data.server);
    setKeys(r.data.privateKeys);
    setCanUpdate(r.data.canUpdate);
    return r.data.privateKeys;
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (server) document.title = `${limit(server.name, 10)} > Private Key | Freeploy`;
  }, [server]);

  async function setPrivateKey(keyUuid: string) {
    const r = await postJson<{ message: string }>(`${base}/private-key`, { private_key_uuid: keyUuid }, "PATCH");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    await load();
    notify.success(r.data.message);
  }

  async function checkConnection() {
    const r = await postJson(`${base}/check-connection`, {});
    if (!r.ok) notify.error(summarize(r.error.messages));
  }

  /** generatePrivateKey(): the new key's public key goes to the clipboard. */
  async function generate(type: "ed25519" | "rsa") {
    const r = await postJson<{ uuid: string }>(`${orgBase}/private-keys/generate`, { type });
    if (!r.ok) return notify.error(summarize(r.error.messages));
    const list = await load();
    const created = list?.find((k) => k.uuid === r.data.uuid);
    if (created) copyPublicKey(created.publicKey);
    notify.success("Private key created successfully.");
  }

  if (!server) return null;
  return (
    <ServerWorkspace server={server} orgId={me.team?.id} active="private-key" canUpdate={canUpdate}>
      <div className="application-settings-form flex w-full flex-col gap-6">
        <SettingsSection
          id="server-private-keys-section"
          title="Private key"
          helper="Choose the SSH key Freeploy uses to connect to this server."
          flush
          actions={
            <div className="flex items-center gap-2">
              <Button disabled={!canUpdate} onClick={() => void checkConnection()}>
                <Reicon name="refresh" className="size-3.5" />
                Check connection
              </Button>
              {canUpdate ? (
                <div className="relative">
                  <button type="button" className="button button-highlighted" aria-haspopup="menu" aria-expanded="false">
                    <Reicon name="plus" className="size-3.5" />
                    Add
                    <Reicon name="chevron-down" className="size-3 opacity-55" />
                  </button>
                  <div role="menu" className="listbox-panel left-auto! right-0! z-[90]! w-52! min-w-52!" style={{ display: "none" }}>
                    <button type="button" className="listbox-option justify-start! gap-2.5!" role="menuitem" onClick={(e) => (closeMenu(e), void generate("ed25519"))}>
                      <Reicon name="keys" className="size-3.5 shrink-0 opacity-70" />
                      Generate ED25519
                    </button>
                    <button type="button" className="listbox-option justify-start! gap-2.5!" role="menuitem" onClick={(e) => (closeMenu(e), void generate("rsa"))}>
                      <Reicon name="keys" className="size-3.5 shrink-0 opacity-70" />
                      Generate RSA
                    </button>
                    <ModalInput
                      title="Add Private Key Manually"
                      open={addOpen}
                      onOpenChange={setAddOpen}
                      trigger={
                        <button type="button" className="listbox-option justify-start! gap-2.5! w-full" role="menuitem" onClick={closeMenu}>
                          <Reicon name="plus" className="size-3.5 shrink-0 opacity-70" />
                          Add manually
                        </button>
                      }
                    >
                      <CreatePrivateKey
                        base={`${orgBase}/private-keys`}
                        onCreated={() => {
                          setAddOpen(false);
                          void load();
                        }}
                      />
                    </ModalInput>
                  </div>
                </div>
              ) : null}
            </div>
          }
        >
          {keys.length === 0 ? (
            <Empty title="No private keys" description="Add or generate a private key to connect to this server." iconName="keys" />
          ) : (
            keys.map((key) => (
              <div
                key={key.uuid}
                className="flex flex-col gap-4 border-b border-neutral-200 px-4 py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between dark:border-white/[0.08]"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-white/[0.06] dark:text-fg-dim">
                    <Reicon name="keys" className="size-4" />
                  </div>
                  <div className="min-w-0 self-center">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-neutral-950 dark:text-fg">{key.name}</p>
                      {key.isActive ? <StatusBadge label="Active" type="success" /> : null}
                    </div>
                    {key.description ? <p className="mt-1 text-xs text-neutral-500 dark:text-fg-dim">{key.description}</p> : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button onClick={() => copyPublicKey(key.publicKey)}>Copy public key</Button>
                  {!key.isActive && !server.isTransferredAway ? (
                    <Button disabled={!canUpdate} onClick={() => void setPrivateKey(key.uuid)}>
                      Use this key
                    </Button>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </SettingsSection>
      </div>
    </ServerWorkspace>
  );
}

export function ServerPrivateKeyPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Private Key">
      <ServerPrivateKeyContent />
    </Layout>
  );
}
