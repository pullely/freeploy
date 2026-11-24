// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/profile/passkeys.blade.php
// and resources/js/passkeys.js (Apache-2.0), modified. WebAuthn in the browser
// by @simplewebauthn/browser in place of @laravel/passkeys.
import { useEffect, useState, type FormEvent } from "react";
import { startRegistration, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { ago } from "../lib/ago";
import { Reicon } from "../components/Reicon";

interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** resources/js/passkeys.js passkeyDeviceName(). */
export function deviceName(ua = navigator.userAgent): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "device";
  return `${browser} on ${os}`;
}

function Field({ label, value, onChange, ariaLabel }: { label?: string; value: string; onChange: (v: string) => void; ariaLabel?: string }) {
  return (
    <div className="w-full min-w-0">
      {label ? (
        <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
          <label className="mb-0! flex items-center gap-1 text-sm font-medium leading-4">
            {label}
            <span className="text-helper">*</span>
          </label>
        </div>
      ) : null}
      <input className="input" required maxLength={255} value={value} aria-label={ariaLabel} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function PasskeyRow({ p, reload }: { p: Passkey; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [deleting, setDeleting] = useState(false);
  async function rename(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await postJson<{ status: string }>(`/v1/auth/passkeys/${p.id}`, { name }, "PATCH");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    notify.success(r.data.status);
    setEditing(false);
    await reload();
  }
  async function remove(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (String(f.get("confirm") ?? "") !== p.name) return notify.error("The passkey name does not match.");
    const r = await postJson<{ status: string }>(`/v1/auth/passkeys/${p.id}`, { password: f.get("password") }, "DELETE");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    notify.success(r.data.status);
    await reload();
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-neutral-200 p-3 dark:border-white/[0.07]">
      <div className="min-w-0">
        {!editing ? (
          <div className="text-sm font-semibold text-black dark:text-fg">{p.name}</div>
        ) : (
          <form className="flex items-end gap-2" onSubmit={rename}>
            <Field value={name} onChange={setName} ariaLabel="Passkey name" />
            <button className="button" type="submit">
              Save
            </button>
          </form>
        )}
        <p className="mt-1 text-xs text-neutral-500 dark:text-fg-dim">
          Passkey · Added {ago(p.createdAt)} · {p.lastUsedAt ? `Last used ${ago(p.lastUsedAt)}` : "Not used yet"}
        </p>
        {deleting ? (
          // <x-modal-confirmation> (the passkey's name, then the password) arrives with the component gallery.
          <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={remove}>
            <p className="w-full text-xs text-neutral-500 dark:text-fg-dim">You cannot sign in with this passkey after it is deleted.</p>
            <input className="input" name="confirm" required aria-label="Passkey name" placeholder="Enter the passkey name to confirm" />
            <input className="input" name="password" type="password" required aria-label="Password" placeholder="Password" />
            <button className="button button-error" type="submit">
              Delete passkey
            </button>
          </form>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <button className="button" type="button" onClick={() => (setEditing(!editing), setName(p.name))}>
          <span>{editing ? "Cancel" : "Rename"}</span>
        </button>
        <button className="button button-error" type="button" onClick={() => setDeleting(!deleting)}>
          Delete
        </button>
      </div>
    </div>
  );
}

/** Passkeys on this address (Coolify's PasskeyRelyingParty::isAvailable): the server's relying party and a secure context. */
export async function passkeysAvailable(): Promise<boolean> {
  const r = await getJson<{ available: boolean }>("/v1/auth/passkeys");
  return Boolean(r.data?.available) && window.isSecureContext;
}

/** Rendered only where passkeys are available; elsewhere the generated "not available" callout stays. */
export function PasskeysSection({ requirePasswordConfirmation }: { requirePasswordConfirmation: (status: number, intended?: string) => boolean }) {
  const available = true;
  const [list, setList] = useState<Passkey[]>([]);
  // Coolify shows the form after the password confirmation round trip (status 'passkey-add').
  const [showForm, setShowForm] = useState(() => new URLSearchParams(window.location.search).get("status") === "passkey-add");
  const [name, setName] = useState(() => deviceName());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reload = async () => {
    const r = await getJson<{ available: boolean; passkeys: Passkey[] }>("/v1/auth/passkeys");
    if (r.data) setList(r.data.passkeys);
  };
  useEffect(() => {
    void reload();
  }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    const opts = await postJson<{ options: Parameters<typeof startRegistration>[0]["optionsJSON"]; state: string }>("/v1/auth/passkeys/options", {});
    if (!opts.ok) {
      // Coolify's /profile/passkeys/confirm returns with status 'passkey-add', which opens the form.
      if (!requirePasswordConfirmation(opts.error.status, "/profile?status=passkey-add")) notify.error(summarize(opts.error.messages));
      return;
    }
    setShowForm(true);
  }

  async function register(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      if (!browserSupportsWebAuthn()) throw new Error("This browser does not support passkeys.");
      const opts = await postJson<{ options: Parameters<typeof startRegistration>[0]["optionsJSON"]; state: string }>("/v1/auth/passkeys/options", {});
      if (!opts.ok) {
        if (!requirePasswordConfirmation(opts.error.status, "/profile?status=passkey-add")) throw new Error(summarize(opts.error.messages));
        return;
      }
      const response = await startRegistration({ optionsJSON: opts.data.options });
      const r = await postJson<{ status: string }>("/v1/auth/passkeys", { name, state: opts.data.state, response });
      if (!r.ok) throw new Error(summarize(r.error.messages));
      setShowForm(false);
      notify.success(r.data.status);
      window.history.replaceState(null, "", "/profile");
      await reload();
    } catch (err) {
      // The user closing the browser's dialog is not an error (UserCancelledError).
      if ((err as Error).name !== "NotAllowedError") setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <section className="application-settings-section">
        <div className="application-settings-section-header">
          <div>
            <h2>Passkeys</h2>
            <p>Sign in with your fingerprint, face, or a security key. A passkey sign-in skips two-factor authentication.</p>
          </div>
          {available && !showForm ? (
            <a className="button" href="/profile/passkeys/confirm" onClick={add}>
              Add passkey
            </a>
          ) : null}
        </div>
        <div className="application-settings-section-body flex flex-col gap-4">
          {available && showForm ? (
            <form className="flex flex-col gap-2" onSubmit={register}>
              <div className="flex items-end gap-2">
                <Field label="Passkey name" value={name} onChange={setName} />
                <button {...({ ishighlighted: "" } as object)} className="button" type="submit" disabled={loading}>
                  Create passkey
                </button>
                <button className="button" type="button" onClick={() => setShowForm(false)}>
                  Cancel
                </button>
              </div>
              {error ? <p className="text-sm text-error">{error}</p> : null}
            </form>
          ) : null}
          {list.map((p) => (
            <PasskeyRow key={p.id} p={p} reload={reload} />
          ))}
          {!list.length && available && !showForm ? (
            <div className="empty-state w-full">
              <div className="empty-state-well min-h-32">
                <div className="mb-3 size-10 flex items-center justify-center rounded-xl border border-neutral-200 bg-white text-neutral-400 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-fg-faint">
                  <Reicon name="keys" className="size-4.5" />
                </div>
                <h2 className="empty-state-title">No passkeys</h2>
                <p className="empty-state-description text-[12px]">Add a passkey to sign in without your password.</p>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
