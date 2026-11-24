// Derived from coollabsio/coolify@91b7e3e:app/Livewire/TwoFactorRequired.php and its view
// (Apache-2.0), modified. Shown when the current team requires 2FA and the user
// has not set it up: configure it, switch to another team, or sign out.
import type { FormEvent } from "react";
import { TwoFactorRequiredMarkup } from "./generated/TwoFactorRequiredMarkup";
import { useMe } from "../layout/Layout";
import { clearSession, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";

export function TwoFactorRequiredPage() {
  const [me] = useMe();
  if (!me) return null;
  async function onConfigure(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await postJson("/v1/auth/two-factor", {});
    if (!r.ok && r.error.status === 423) {
      try {
        sessionStorage.setItem("freeploy.intended", "/profile");
      } catch {
        /* storage blocked */
      }
      window.location.assign("/user/confirm-password");
      return;
    }
    if (!r.ok) return notify.error(summarize(r.error.messages));
    window.location.assign("/profile");
  }
  async function onLogout(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    await postJson("/v1/auth/logout", {});
    clearSession();
    window.location.assign("/login");
  }
  const teams = me.team ? [me.team] : [];
  return (
    <TwoFactorRequiredMarkup
      teamName={me.team?.name ?? ""}
      onConfigure={onConfigure}
      onLogout={onLogout}
      switchTeams={teams.map((t) => (
        <form key={t.slug} action="/two-factor-required/switch-team" method="POST" onSubmit={(e) => (e.preventDefault(), window.location.assign("/"))}>
          <input type="hidden" name="_token" defaultValue="" autoComplete="off" />
          <input type="hidden" name="team_id" defaultValue={t.slug} />
          <button className="button w-full justify-center" type="submit">
            {" "}
            {t.name}{" "}
          </button>
        </form>
      ))}
    />
  );
}
