// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/security/private-key/{index,create}.blade.php,
// resources/views/components/security/settings-layout.blade.php,
// resources/views/components/application/settings-section.blade.php and
// app/Livewire/Security/PrivateKey/{Index,Create}.php (Apache-2.0), modified.
//
// /security/private-key: the org's SSH keys. Generate (ED25519 / RSA), add one
// by hand, delete the unused ones, and edit a key in Coolify's editor dialog.
// Livewire's dispatch('success' | 'error', …) are the same toasts here.
import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Empty, FormInput, FormTextarea, Helper, ModalConfirmation, ModalInput, StatusBadge } from "../components/Coolify";
import { PrivateKeyEditor, PrivateKeyEditorLoading } from "./PrivateKeyEditor";

export interface PrivateKeyItem {
  uuid: string;
  name: string;
  description: string | null;
  is_git_related: boolean;
  is_in_use: boolean;
}

const COLS = "grid-cols-[minmax(0,1fr)_7rem_4.5rem]";
const SM_COLS = "sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_7rem_4.5rem]";

/** The Keys & Tokens pages, as settingsSearchItems() feeds them to the page search. */
function searchItems(): string {
  const origin = window.location.origin;
  const pages: Array<[string, string]> = [
    ["Private Keys", "/security/private-key"],
    ["API Tokens", "/security/api-tokens"],
    ["Cloud Tokens", "/security/cloud-tokens"],
    ["Integration Tokens", "/security/integration-tokens"],
    ["Cloud-Init Scripts", "/security/cloud-init-scripts"],
  ];
  return JSON.stringify(pages.map(([label, path]) => ({ label, breadcrumb: "Keys & Tokens", search_text: `${label} Keys & Tokens`, href: origin + path, navigate: true })));
}

/** Alpine's `@click="dropdownOpen = false"`: close the menu the clicked item is in. */
function closeMenu(e: MouseEvent<HTMLElement>): void {
  const panel = e.currentTarget.closest<HTMLElement>(".listbox-panel");
  if (!panel) return;
  panel.style.display = "none";
  panel.removeAttribute("data-open");
}

/** create.blade.php in modal mode: Livewire's Create component. onCreated gets the new key's uuid (privateKeyCreated). */
export function CreatePrivateKey({ base, onCreated }: { base: string; onCreated: (uuid: string) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // realtimeValidation: wire:model.debounce.200ms, then Create::updated('value') → validatePrivateKey().
  function onValue(v: string) {
    setValue(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void (async () => {
        const r = await postJson<{ error: string | null; publicKey: string }>(`${base}/validate`, { value: v });
        if (!r.ok) return;
        setPublicKey(r.data.publicKey);
        setErrors((e) => {
          const rest = { ...e };
          delete rest.value;
          return r.data.error ? { ...rest, value: r.data.error } : rest;
        });
      })();
    }, 200);
  }
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await postJson<{ uuid: string; message: string }>(base, { name, description, value });
    if (!r.ok) {
      const fields = r.error.fields ?? {};
      const inline: Record<string, string> = {};
      for (const f of ["name", "description", "value"]) if (fields[f]?.[0]) inline[f] = fields[f][0];
      setErrors(inline);
      // A ValidationException from the model's saving hook goes through handleError(): an error toast.
      if (fields.private_key?.[0]) notify.error(fields.private_key[0]);
      else if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    notify.success(r.data.message);
    onCreated(r.data.uuid);
  }

  return (
    <div className="application-settings-form">
      <form className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <div className="grid gap-4 lg:grid-cols-2">
          <FormInput id="name" label="Name" required value={name} onChange={setName} error={errors.name} />
          <FormInput id="description" label="Description" value={description} onChange={setDescription} error={errors.description} />
          <div className="lg:col-span-2">
            <FormTextarea id="value" label="Private key" required rows={10} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={value} onChange={onValue} error={errors.value} />
          </div>
          <div className="lg:col-span-2">
            <FormInput id="publicKey" readOnly label="Public key" helper="Copy this value to ~/.ssh/authorized_keys on the target server." value={publicKey} />
          </div>
        </div>
        <div className="flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
          <button type="submit" className="button button-highlighted">
            Continue
          </button>
        </div>
      </form>
    </div>
  );
}

function PrivateKeysContent() {
  const { me } = useSignedIn();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/private-keys`;
  const [keys, setKeys] = useState<PrivateKeyItem[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  // openEditor($uuid): the editor dialog opens at once with the name and description, then loads the key.
  const [editing, setEditing] = useState<{ uuid: string; name: string; description: string } | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);

  const reload = useCallback(async () => {
    const r = await getJson<{ privateKeys: PrivateKeyItem[]; canWrite: boolean }>(base);
    if (!r.data) {
      if (r.status !== 401) notify.error("Failed to load private keys.");
      setKeys([]);
      return;
    }
    setKeys(r.data.privateKeys);
    setCanWrite(r.data.canWrite);
  }, [base]);
  useEffect(() => {
    void reload();
  }, [reload]);

  /** refreshResources(): closeEditor(), dispatch('close-modal'). */
  const refreshResources = useCallback(() => {
    setEditorOpen(false);
    setEditing(null);
    setAddOpen(false);
    void reload();
  }, [reload]);

  async function generate(type: "ed25519" | "rsa") {
    const r = await postJson<{ uuid: string; message: string }>(`${base}/generate`, { type });
    if (!r.ok) return notify.error(summarize(r.error.messages));
    notify.success(r.data.message);
    await reload();
  }

  async function cleanup() {
    const r = await postJson<{ message: string }>(`${base}/cleanup`, {});
    if (!r.ok) return notify.error(summarize(r.error.messages));
    notify.success(r.data.message);
    await reload();
  }

  const onEditorOpenChange = useCallback((open: boolean) => {
    setEditorOpen(open);
    // modalClosed → closeEditor()
    if (!open) setEditing(null);
  }, []);

  return (
    <div>
      <section className="w-full max-w-none">
        <header className="settings-mobile-header xl:hidden">
          <h1 className="settings-mobile-title">Keys & Tokens</h1> <p className="settings-mobile-description">Manage SSH keys, cloud credentials, and API access tokens.</p>
        </header>{" "}
        <div hidden data-settings-search-items={searchItems()} />{" "}
        <div className="min-w-0">
          <section className="application-settings-section" data-settings-section-title="Private keys">
            <header>
              <div className="min-w-0 py-0.5">
                <h3>
                  <Helper helper="SSH keys used to connect servers and private repositories." label="More information about Private keys" trigger={<span className="underline underline-offset-4">Private keys</span>} />
                </h3>
              </div>
              <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
                {canWrite ? (
                  <>
                    <ModalConfirmation
                      title="Confirm unused SSH Key Deletion?"
                      actions={["All unused SSH keys (marked with unused) are permanently deleted."]}
                      confirmationText={null}
                      onSubmit={cleanup}
                      trigger={
                        <button type="button" className="button button-error whitespace-nowrap">
                          <span className="max-sm:hidden">Delete unused keys</span> <span className="sm:hidden">Delete unused</span>
                        </button>
                      }
                    />{" "}
                    <div className="relative">
                      <button type="button" className="button whitespace-nowrap button-highlighted" aria-haspopup="menu" aria-expanded="false">
                        <Reicon name="plus" className="size-3.5" /> <span className="max-sm:hidden">New private key</span> <span className="sm:hidden">New key</span>{" "}
                        <Reicon name="chevron-down" className="size-3 opacity-55" />
                      </button>{" "}
                      <div role="menu" className="listbox-panel left-auto! right-0! z-[90]! w-52! min-w-52!" style={{ display: "none" }}>
                        <button type="button" className="listbox-option justify-start! gap-2.5!" role="menuitem" onClick={(e) => (closeMenu(e), void generate("ed25519"))}>
                          <Reicon name="keys" className="size-3.5 shrink-0 opacity-70" /> Generate ED25519{" "}
                        </button>{" "}
                        <button type="button" className="listbox-option justify-start! gap-2.5!" role="menuitem" onClick={(e) => (closeMenu(e), void generate("rsa"))}>
                          <Reicon name="keys" className="size-3.5 shrink-0 opacity-70" /> Generate RSA{" "}
                        </button>{" "}
                        <ModalInput
                          title="Add Private Key Manually"
                          open={addOpen}
                          onOpenChange={setAddOpen}
                          trigger={
                            <button type="button" className="listbox-option justify-start! gap-2.5!" role="menuitem" onClick={closeMenu}>
                              <Reicon name="plus" className="size-3.5 shrink-0 opacity-70" /> Add manually{" "}
                            </button>
                          }
                        >
                          <CreatePrivateKey base={base} onCreated={refreshResources} />
                        </ModalInput>
                      </div>
                    </div>
                  </>
                ) : null}
              </div>{" "}
            </header>{" "}
            <div className="application-settings-section-body is-flush">
              {keys === null ? null : keys.length === 0 ? (
                <Empty title="No private keys yet" description="Generate or add an SSH key to connect Freeploy to servers and private repositories." iconName="keys" />
              ) : (
                <div>
                  <div
                    className={`grid ${COLS} items-center gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[13px] font-medium text-neutral-500 ${SM_COLS} dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint`}
                  >
                    <div className="pl-11">Private key</div> <div className="hidden sm:block">Description</div> <div className="text-center">Status</div>{" "}
                    <div className="text-right">Actions</div>
                  </div>{" "}
                  {keys.map((key) => (
                    <div key={key.uuid} className="border-b border-neutral-200 last:border-b-0 dark:border-white/[0.07]">
                      <div
                        className={`grid min-h-14 w-full ${COLS} items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-neutral-50 ${SM_COLS} dark:hover:bg-white/[0.025]`}
                      >
                        <div className="flex min-w-0 items-center gap-3">
                          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim">
                            <Reicon name="keys" />
                          </div>{" "}
                          <div className="min-w-0 flex-1">
                            <h3 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg"> {key.name} </h3>
                          </div>
                        </div>{" "}
                        <p className="hidden truncate text-[12px] text-neutral-500 sm:block dark:text-fg-dim"> {key.description || "-"} </p>{" "}
                        <div className="flex justify-center">
                          {key.is_in_use ? <StatusBadge label="In use" type="success" /> : <StatusBadge label="Unused" type="warning" />}
                        </div>{" "}
                        <div className="flex justify-end">
                          <button
                            type="button"
                            className="icon-button"
                            aria-label={`Edit ${key.name}`}
                            data-icon-tooltip={`Edit ${key.name}`}
                            onClick={() => {
                              setEditing({ uuid: key.uuid, name: key.name, description: key.description ?? "" });
                              setEditorOpen(true);
                            }}
                          >
                            <Reicon name="settings" className="size-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}{" "}
                </div>
              )}{" "}
              <ModalInput title="Edit Private Key" open={editorOpen} onOpenChange={onEditorOpenChange} trigger={<span className="hidden" aria-hidden="true" />}>
                {editing ? (
                  <PrivateKeyEditor
                    key={editing.uuid}
                    base={base}
                    uuid={editing.uuid}
                    fallback={<PrivateKeyEditorLoading name={editing.name} description={editing.description} />}
                    onChanged={refreshResources}
                  />
                ) : null}
              </ModalInput>
            </div>{" "}
          </section>
        </div>
      </section>
    </div>
  );
}

export function PrivateKeysPage() {
  return (
    <Layout title="Keys & Tokens" href="/security/private-key">
      <PrivateKeysContent />
    </Layout>
  );
}
