// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/profile/index.blade.php
// (danger zone) and app/Actions/User/DeleteUserAccount.php (Apache-2.0), modified.
import { useEffect, useState, type FormEvent } from "react";
import { getJson, postJson, clearSession, summarize } from "../lib/api";
import { notify } from "../lib/toast";

export function useDeletion(email: string) {
  const [blockers, setBlockers] = useState<string[] | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    void getJson<{ blockers: string[]; actions: string[] }>("/v1/auth/account/deletion").then((r) => {
      if (r.data) {
        setBlockers(r.data.blockers);
        setActions(r.data.actions);
      }
    });
  }, []);

  async function remove(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (String(f.get("confirm") ?? "") !== email) return notify.error("The email address does not match.");
    const r = await postJson("/v1/auth/account", { password: f.get("password") }, "DELETE");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    clearSession();
    window.location.assign("/login");
  }

  const text =
    blockers === null ? null : blockers.length ? (
      <>
        <p>Before you can delete your account:</p>
        <ul className="space-y-1">
          {blockers.map((b) => (
            <li key={b}>• {b}</li>
          ))}
        </ul>
      </>
    ) : (
      <>
        <p>Permanently delete your account from Freeploy. This action cannot be undone.</p>
        <ul className="space-y-1 text-xs">
          {/* Coolify deletes single-member teams; Freeploy cannot delete an organisation yet (DP10), so it says what happens. */}
          <li>• Teams where you are the only member are left without members.</li>
          <li>• You are removed from all other teams.</li>
          <li>• Your API tokens and sessions are revoked.</li>
        </ul>
        {confirming ? (
          // <x-modal-confirmation>: the actions, the email address, then the password.
          <form className="mt-3 flex flex-col gap-2" onSubmit={remove}>
            <ul className="space-y-1 text-xs">
              {actions.map((a) => (
                <li key={a}>• {a}</li>
              ))}
            </ul>
            <input className="input" name="confirm" required aria-label="Email" placeholder="Enter your email address to confirm permanent deletion" />
            <input className="input" name="password" type="password" required aria-label="Password" placeholder="Password" />
            <div className="flex gap-2">
              <button className="button button-error" type="submit">
                Permanently Delete
              </button>
              <button className="button" type="button" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </>
    );

  const action =
    blockers === null ? null : blockers.length ? (
      <span className="relative inline-flex" tabIndex={0} title="Resolve the requirements shown before deleting your account.">
        <button disabled className="button button-error" type="button">
          {" "}
          Delete account{" "}
        </button>
      </span>
    ) : (
      <button className="button button-error" type="button" onClick={() => setConfirming(true)}>
        Delete account
      </button>
    );
  return { text, action };
}
