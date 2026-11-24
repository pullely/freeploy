// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/security/private-key/{show,rotate,index}.blade.php,
// resources/views/livewire/security/private-key/partials/key-field.blade.php and
// app/Livewire/Security/PrivateKey/{Show,Rotate}.php (Apache-2.0), modified.
//
// The "Edit Private Key" dialog of /security/private-key: name, description,
// public key, fingerprint, the stored key (reveal / replace), where the key is
// used, delete, rotate and save. The private key itself is never loaded:
// Coolify sends it only through revealPrivateKey() after a password, which is
// not available yet, nor is rotation (it needs the SSH executor).
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { FormInput, FormTextarea, Loading, ModalConfirmation, ModalInput } from "../components/Coolify";

type UsageType = "Server" | "Application" | "GitHub App" | "GitLab App" | "Gitea App";
export interface PrivateKeyShow {
  uuid: string;
  name: string;
  description: string | null;
  publicKey: string;
  fingerprint: string | null;
  isGitRelated: boolean;
  isInUse: boolean;
  hasServers: boolean;
  usedByOthers: boolean;
  canUpdate: boolean;
  usages: { counts: Partial<Record<UsageType, number>>; matches: number; rows: Array<{ type: UsageType; name: string; url: string | null }> };
}

const DELETE_DISABLED = "This private key is currently used by a server, application, or Git app and cannot be deleted.";
const HIDDEN = { display: "none" as const };

/** str($type)->plural($count)->lower(). */
export function usageCount(type: string, count: number): string {
  return `${count} ${(count === 1 ? type : `${type}s`).toLowerCase()}`;
}

/** index.blade.php's loading state of the editor (wire:loading on openEditor). */
export function PrivateKeyEditorLoading({ name, description }: { name: string; description: string }) {
  return (
    <div aria-label="Loading private key editor" className="w-full flex-col gap-4" style={{ display: "flex" }}>
      <div className="grid gap-4 lg:grid-cols-2">
        <FormInput label="Name" required value={name} readOnly />
        <FormInput label="Description" value={description} readOnly />
        <div className="lg:col-span-2">
          <FormInput label="Public key" loading helper="Copy this value to ~/.ssh/authorized_keys on the target server." value="" />
        </div>
        <div className="lg:col-span-2">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <label className="text-[13px] font-medium">
              Private key <span className="text-helper">*</span>
            </label>
            <span className="text-[11px] font-medium text-neutral-400 dark:text-fg-faint">Edit key</span>
          </div>
          <FormInput loading value="" />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
        <button disabled className="button button-error" type="button">
          Delete
        </button>
        <button disabled {...({ ishighlighted: "" } as object)} className="button" type="button">
          Save changes
        </button>
      </div>
    </div>
  );
}

/** rotate.blade.php: the dialog shows while servers use the key; Freeploy cannot run a rotation yet. */
function RotateKey({ base, data, onDeleteOld }: { base: string; data: PrivateKeyShow; onDeleteOld: () => void }) {
  const [open, setOpen] = useState(false);
  const [keyType, setKeyType] = useState<"ed25519" | "rsa">("ed25519");
  if (!data.hasServers && !open) return null;
  const servers = data.usages.rows.filter((r) => r.type === "Server");
  async function rotate() {
    const r = await postJson(`${base}/${data.uuid}/rotate`, { keyType });
    if (!r.ok) notify.error(summarize(r.error.messages));
  }
  return (
    <div>
      <ModalInput
        title="Rotate key"
        subtitle="Move the servers to a new key. Servers that fail stay on this key."
        open={open}
        onOpenChange={setOpen}
        trigger={
          <button className="button" type="button">
            {data.hasServers ? "Rotate key" : "Rotation result"}
          </button>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-white/[0.06]">
            {servers.map((s) => (
              <li key={s.url ?? s.name} className="flex flex-col gap-0.5 py-2">
                <span className="flex items-center gap-2">
                  <span>{s.name}</span>
                  <span className="ml-auto" />
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-neutral-500 dark:text-fg-dim">Rotation progress and logs will appear here.</p>
          {data.hasServers ? (
            <div className="w-full">
              <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
                <label htmlFor="keyType" className="mb-0! flex items-center gap-1 text-sm font-medium leading-4">
                  New key type
                </label>
              </div>
              {/* <x-forms.listbox> arrives with the component gallery; a native select carries the same options. */}
              <select id="keyType" className="input" value={keyType} onChange={(e) => setKeyType(e.target.value === "rsa" ? "rsa" : "ed25519")}>
                <option value="ed25519">Ed25519 — Recommended.</option>
                <option value="rsa">RSA 4096 — For hosts that do not accept Ed25519, for example FIPS hosts.</option>
              </select>
            </div>
          ) : null}
          {data.usedByOthers ? (
            <p className="text-xs text-neutral-500 dark:text-fg-dim">Applications and Git sources stay on this key.</p>
          ) : !data.hasServers ? (
            <p className="text-xs text-neutral-500 dark:text-fg-dim">Nothing uses this key now. You can delete it.</p>
          ) : null}
          <div className="flex items-center justify-end gap-2 border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
            {!data.hasServers && !data.usedByOthers && data.canUpdate ? (
              <button className="button button-error" type="button" onClick={() => (setOpen(false), onDeleteOld())}>
                Delete old key
              </button>
            ) : null}
            {data.hasServers ? (
              <button {...({ ishighlighted: "" } as object)} className="button" type="button" onClick={() => void rotate()}>
                Rotate key
              </button>
            ) : null}
          </div>
        </div>
      </ModalInput>
    </div>
  );
}

/** partials/key-field.blade.php: the fingerprint, and the stored key behind Reveal / Replace. */
function KeyField({ base, data, newKey, setNewKey, error }: { base: string; data: PrivateKeyShow; newKey: string; setNewKey: (v: string) => void; error?: string | undefined }) {
  const [replacing, setReplacing] = useState(false);
  const [askPassword, setAskPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [revealed, setRevealed] = useState("");
  const [revealing, setRevealing] = useState(false);
  const hide = () => {
    setRevealed("");
    setAskPassword(false);
    setPassword("");
  };
  async function reveal() {
    if (replacing) return;
    if (!password) return setAskPassword(true);
    setRevealing(true);
    const r = await postJson<{ privateKey: string }>(`${base}/${data.uuid}/reveal`, { password });
    setRevealing(false);
    setPassword("");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    if (!replacing) {
      setRevealed(r.data.privateKey);
      setAskPassword(false);
    }
  }
  return (
    <>
      <div className="lg:col-span-2">
        <FormInput id="fingerprint" readOnly label="Fingerprint" value={data.fingerprint ?? ""} />
      </div>
      <div className="lg:col-span-2">
        <div className="mb-1.5 flex items-center justify-between gap-3">
          <label className="text-[13px] font-medium">Private key</label>
          {data.canUpdate ? (
            <div className="flex items-center gap-3">
              <button
                type="button"
                className="text-[11px] font-medium text-coollabs hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50 dark:text-brand-light"
                disabled={replacing}
                onClick={() => (revealed || askPassword ? hide() : void reveal())}
              >
                {revealed || askPassword ? "Hide key" : "Reveal key"}
              </button>
              <button
                type="button"
                className="text-[11px] font-medium text-coollabs hover:underline dark:text-brand-light"
                onClick={() => {
                  const next = !replacing;
                  setReplacing(next);
                  if (next) hide();
                  else setNewKey("");
                }}
              >
                {replacing ? "Cancel replace" : "Replace key"}
              </button>
            </div>
          ) : null}
        </div>
        <p className="text-xs text-neutral-500 dark:text-fg-dim" style={!replacing && !revealed && !askPassword ? undefined : HIDDEN}>
          The private key is stored encrypted and is not shown. Use the public key and the fingerprint to identify it.
        </p>
        {data.canUpdate ? (
          <>
            <div className="flex items-end gap-2" style={askPassword && !revealed ? undefined : HIDDEN}>
              <div className="flex-1">
                <label className="text-[13px] font-medium">Enter your password to reveal the private key</label>
                <input
                  type="password"
                  className="w-full input"
                  autoComplete="current-password"
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void reveal();
                    }
                  }}
                />
              </div>
              <button className="button" type="button" disabled={!password || revealing} onClick={() => void reveal()}>
                Reveal
              </button>
            </div>
            <div style={revealed ? undefined : HIDDEN}>
              <pre className="input h-auto! overflow-x-auto whitespace-pre font-mono text-xs">{revealed}</pre>
            </div>
            <div className="mt-2" style={replacing ? undefined : HIDDEN}>
              <FormTextarea id="newPrivateKey" rows={10} placeholder="Paste the new private key. Leave empty to keep the stored key." value={newKey} onChange={setNewKey} error={error} />
            </div>
          </>
        ) : null}
      </div>
    </>
  );
}

/** show.blade.php inside the editor dialog. `onChanged`: privateKeyUpdated / privateKeyDeleted → Index::refreshResources(). */
export function PrivateKeyEditor({ base, uuid, fallback, onChanged }: { base: string; uuid: string; fallback: ReactNode; onChanged: () => void }) {
  const [data, setData] = useState<PrivateKeyShow | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [newKey, setNewKey] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteRequest, setDeleteRequest] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (usageSearch: string, sync: boolean) => {
      const q = usageSearch ? `?usage_search=${encodeURIComponent(usageSearch)}` : "";
      const r = await getJson<PrivateKeyShow>(`${base}/${uuid}${q}`);
      if (!r.data) {
        // Show::mount() aborts with 404; the dialog closes.
        notify.error("Private key not found.");
        onChanged();
        return;
      }
      setData(r.data);
      if (sync) {
        setName(r.data.name);
        setDescription(r.data.description ?? "");
        setNewKey("");
      }
    },
    [base, uuid, onChanged],
  );
  useEffect(() => {
    void load("", true);
  }, [load]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  if (!data) return <>{fallback}</>;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await postJson<{ message: string }>(`${base}/${uuid}`, { name, description, newPrivateKey: newKey }, "PATCH");
    if (!r.ok) {
      const fields = r.error.fields ?? {};
      const inline: Record<string, string> = {};
      for (const f of ["name", "description", "newPrivateKey"]) if (fields[f]?.[0]) inline[f] = fields[f][0];
      setErrors(inline);
      if (fields.private_key?.[0]) notify.error(fields.private_key[0]);
      else if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    notify.success(r.data.message);
    onChanged();
  }

  async function remove() {
    setDeleting(true);
    const r = await postJson<{ deleted: boolean }>(`${base}/${uuid}`, {}, "DELETE");
    setDeleting(false);
    if (!r.ok) {
      if (r.error.status === 409) setData((d) => (d ? { ...d, isInUse: true } : d));
      return notify.error(summarize(r.error.messages));
    }
    onChanged();
  }

  function onSearch(v: string) {
    setSearch(v);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(v, false), 300);
  }

  const counts = Object.entries(data.usages.counts) as Array<[UsageType, number]>;
  const total = counts.reduce((n, [, c]) => n + c, 0);
  const rows = data.usages.rows;
  const disabled = !data.canUpdate;
  return (
    <div>
      <div className="relative">
        <form className={`flex flex-col gap-4${deleting ? " pointer-events-none opacity-50" : ""}`} onSubmit={(e) => void save(e)}>
          <div className="grid gap-4 lg:grid-cols-2">
            <FormInput id="name" label="Name" required value={name} onChange={setName} disabled={disabled} error={errors.name} />
            <FormInput id="description" label="Description" value={description} onChange={setDescription} disabled={disabled} error={errors.description} />
            <div className="lg:col-span-2">
              <FormInput id="public_key" readOnly disabled={disabled} label="Public key" helper="Copy this value to ~/.ssh/authorized_keys on the target server." value={data.publicKey} />
            </div>
            <KeyField base={base} data={data} newKey={newKey} setNewKey={setNewKey} error={errors.newPrivateKey} />
            <div className="lg:col-span-2">
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <label className="text-[13px] font-medium">Used by</label>
                {counts.length ? <span className="text-xs text-neutral-500 dark:text-fg-dim">{counts.map(([type, count]) => usageCount(type, count)).join(" · ")}</span> : null}
              </div>
              {!counts.length ? (
                <p className="text-xs text-neutral-500 dark:text-fg-dim">Nothing uses this key.</p>
              ) : (
                <>
                  {total > 5 ? (
                    <input
                      type="search"
                      className="input mb-2"
                      placeholder="Search by name"
                      aria-label="Search where this key is used"
                      value={search}
                      onChange={(e) => onSearch(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
                    />
                  ) : null}
                  <ul className="max-h-48 divide-y divide-neutral-200 overflow-y-auto rounded-md border border-neutral-200 text-sm dark:divide-white/[0.06] dark:border-white/[0.08]">
                    {rows.length ? (
                      rows.map((usage) => (
                        <li key={`usage-${usage.type}-${usage.url ?? usage.name}`} className="flex items-center gap-2 px-3 py-1">
                          <span className="w-20 shrink-0 text-xs text-neutral-500 dark:text-fg-dim">{usage.type}</span>
                          {usage.url ? (
                            <a className="truncate underline" href={usage.url}>
                              {usage.name}
                            </a>
                          ) : (
                            <span className="truncate">{usage.name}</span>
                          )}
                        </li>
                      ))
                    ) : (
                      <li className="px-3 py-1 text-xs text-neutral-500 dark:text-fg-dim">No match.</li>
                    )}
                    {data.usages.matches > rows.length ? <li className="px-3 py-1 text-xs text-neutral-500 dark:text-fg-dim">and {data.usages.matches - rows.length} more</li> : null}
                  </ul>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
            {data.canUpdate ? (
              <ModalConfirmation
                title="Confirm Private Key Deletion?"
                buttonTitle="Delete"
                disabled={data.isInUse}
                disabledTooltip={DELETE_DISABLED}
                actions={["This private key will be permanently deleted.", "Freeploy does not remove its public key from servers. To remove it, rotate the key before you delete it."]}
                confirmationText={data.name}
                step2ButtonText="Delete private key"
                onSubmit={remove}
                openRequest={deleteRequest}
              />
            ) : null}
            <div className="flex items-center gap-2">
              {data.canUpdate ? <RotateKey base={base} data={data} onDeleteOld={() => setDeleteRequest((n) => n + 1)} /> : null}
              <button {...({ ishighlighted: "" } as object)} className="button" type="submit">
                Save changes
              </button>
            </div>
          </div>
        </form>
        {deleting ? (
          <div className="absolute inset-0 z-10 items-center justify-center rounded-lg bg-white/50 dark:bg-black/40" style={{ display: "flex" }}>
            <Loading text="Deleting private key..." />
          </div>
        ) : null}
      </div>
    </div>
  );
}
