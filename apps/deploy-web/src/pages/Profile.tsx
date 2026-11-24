// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/profile/index.blade.php and
// app/Livewire/Profile/Index.php (Apache-2.0), modified.
// /profile: Coolify's markup (generated from the reference's rendered page).
// Saving the name and changing the password work as in Coolify, with its
// toasts; the email change, avatar, 2FA, passkeys and account deletion are
// later DP3 tasks.
import { useEffect, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { Layout, useSignedIn } from "../layout/Layout";
import { ProfileMarkup } from "./generated/ProfileMarkup";
import { ProfilePortalMarkup } from "./generated/ProfilePortalMarkup";
import { postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { getJson } from "../lib/api";
import { PasskeysSection, passkeysAvailable } from "./PasskeysSection";
import { EnabledBadge, EnabledBody, PendingSetup, type TwoFactorState } from "./TwoFactorSection";

/**
 * Fortify's password.confirm middleware: a 423 sends the user to
 * /user/confirm-password, which returns them here (redirect()->intended()).
 */
function requirePasswordConfirmation(status: number): boolean {
  if (status !== 423) return false;
  try {
    sessionStorage.setItem("freeploy.intended", window.location.pathname);
  } catch {
    /* storage blocked: the confirm page falls back to / */
  }
  window.location.assign("/user/confirm-password");
  return true;
}

const initial = (s: string) => (s.trim()[0] ?? "").toUpperCase();

/** The verification step of Coolify's email change dialog. */
function VerifyEmailForm({ onSubmit, onResend }: { onSubmit: (e: FormEvent<HTMLFormElement>) => void; onResend: () => void }) {
  return (
    <form className="application-settings-section-body space-y-4" onSubmit={onSubmit}>
      <div className="w-full">
        <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
          <label htmlFor="email_verification_code" className="mb-0! flex items-center gap-1 text-sm font-medium leading-4">
            Verification code <span className="text-helper">*</span>
          </label>
        </div>
        <input autoComplete="off" className="input" required id="email_verification_code" name="email_verification_code" inputMode="numeric" maxLength={6} />
      </div>
      <p className="text-xs text-neutral-500 dark:text-fg-dim">The code expires after 10 minutes.</p>
      <div className="flex justify-end gap-2">
        <button className="button" type="button" onClick={onResend}>
          Resend code
        </button>
        <button {...({ ishighlighted: "" } as object)} className="button" type="submit">
          Verify email
        </button>
      </div>
    </form>
  );
}

function ProfileContent() {
  const { me, setMe } = useSignedIn();
  const name = me.user.displayName?.trim() || me.user.email;
  const [twoFactor, setTwoFactor] = useState<TwoFactorState>({ enabled: false, pending: false });
  const [codes, setCodes] = useState<string[] | null>(null);
  const loadTwoFactor = async () => {
    const r = await getJson<TwoFactorState>("/v1/auth/two-factor");
    if (r.data) setTwoFactor(r.data);
  };
  const [passkeysOn, setPasskeysOn] = useState(false);
  // Email change (Coolify's emailModalOpen / show_verification), opened again while a code is pending.
  const [emailOpen, setEmailOpen] = useState(false);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  useEffect(() => {
    void getJson<{ pending: string | null }>("/v1/auth/email/change").then((r) => {
      if (r.data?.pending) {
        setPendingEmail(r.data.pending);
        setEmailOpen(true);
      }
    });
  }, []);
  const toastError = (messages: string[]) => notify.error(summarize(messages));
  async function sendCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await postJson<{ status: string; pending: string }>("/v1/auth/email/change", { new_email: new FormData(e.currentTarget).get("new_email") });
    if (!r.ok) return toastError(r.error.messages);
    setPendingEmail(r.data.pending);
    notify.success(r.data.status);
  }
  async function verifyCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await postJson<{ status: string; email: string }>("/v1/auth/email/change/verify", { email_verification_code: new FormData(e.currentTarget).get("email_verification_code") });
    if (!r.ok) {
      toastError(r.error.messages);
      if (r.error.messages[0]?.startsWith("Email change request cancelled")) setPendingEmail(null);
      return;
    }
    setMe({ ...me, user: { ...me.user, email: r.data.email } });
    setPendingEmail(null);
    setEmailOpen(false);
    notify.success(r.data.status);
  }
  async function resendCode() {
    const r = await postJson<{ status: string }>("/v1/auth/email/change/resend", {});
    if (!r.ok) return toastError(r.error.messages);
    notify.success(r.data.status);
  }
  async function closeEmail() {
    if (pendingEmail) {
      const r = await postJson<{ status: string }>("/v1/auth/email/change", {}, "DELETE");
      if (r.ok) notify.success(r.data.status);
      setPendingEmail(null);
    }
    setEmailOpen(false);
  }
  useEffect(() => {
    void loadTwoFactor();
    void passkeysAvailable().then(setPasskeysOn);
  }, []);

  async function twoFactorAction(e: FormEvent<HTMLFormElement>, path: string, method: "POST" | "DELETE", body: unknown = {}) {
    e.preventDefault();
    const res = await postJson<{ status: string; recoveryCodes?: string[] }>(path, body, method);
    if (!res.ok) {
      if (!requirePasswordConfirmation(res.error.status)) notify.error(summarize(res.error.messages));
      return;
    }
    setCodes(res.data.recoveryCodes ?? null);
    await loadTwoFactor();
  }

  // <x-unsaved-bar>: shown (class is-dirty) while the form differs from what is saved.
  function onProfileInput(e: FormEvent<HTMLFormElement>) {
    const value = (e.currentTarget.elements.namedItem("name") as HTMLInputElement | null)?.value ?? "";
    e.currentTarget.firstElementChild?.classList.toggle("is-dirty", value !== name);
  }

  async function onSaveProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const value = String(new FormData(form).get("name") ?? "");
    if (!value.trim()) {
      notify.error("The name field is required.");
      return;
    }
    const res = await postJson<unknown>("/v1/auth/profile", { displayName: value }, "PATCH");
    if (!res.ok) {
      notify.error(summarize(res.error.messages));
      return;
    }
    setMe({ ...me, user: { ...me.user, displayName: value } });
    form.firstElementChild?.classList.remove("is-dirty");
    notify.success("Profile updated.");
  }

  async function onChangePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const res = await postJson<{ status: string }>("/v1/auth/password/change", {
      current_password: form.get("current_password"),
      new_password: form.get("new_password"),
      new_password_confirmation: form.get("new_password_confirmation"),
    });
    if (!res.ok) {
      notify.error(summarize(res.error.messages));
      return;
    }
    notify.success(res.data.status);
    // Every session ended with the old password; the reload lands on /login.
    setTimeout(() => window.location.reload(), 1000);
  }

  return (
    <>
    <ProfileMarkup
      onSaveProfile={onSaveProfile}
      onProfileInput={onProfileInput}
      onChangePassword={onChangePassword}
      userInitial={initial(name)}
      userName={name}
      userEmail={me.user.email}
      teamName={me.team?.name ?? ""}
      {...(passkeysOn ? { passkeys: <PasskeysSection requirePasswordConfirmation={requirePasswordConfirmation} /> } : {})}
      onChangeEmail={() => setEmailOpen(true)}
      emailDialogOpen={emailOpen}
      onEnableTwoFactor={(e) => void twoFactorAction(e, "/v1/auth/two-factor", "POST")}
      {...(twoFactor.enabled
        ? {
            twoFactorAction: <EnabledBadge />,
            twoFactorBody: (
              <EnabledBody
                codes={codes}
                onRegenerate={(e) => void twoFactorAction(e, "/v1/auth/two-factor/recovery-codes", "POST")}
                onDisable={(e) => void twoFactorAction(e, "/v1/auth/two-factor", "DELETE")}
              />
            ),
          }
        : twoFactor.pending
          ? {
              // Coolify hides the Configure button while setup is pending.
              twoFactorAction: <></>,
              twoFactorBody: (
                <PendingSetup
                  state={twoFactor}
                  onConfirm={(e) => void twoFactorAction(e, "/v1/auth/two-factor/confirm", "POST", { code: new FormData(e.currentTarget).get("code") })}
                />
              ),
            }
          : {})}
    />
    {createPortal(
    <ProfilePortalMarkup
      emailOpen={emailOpen}
      verifying={pendingEmail !== null}
      pendingEmail={pendingEmail ?? ""}
      onEmailClose={() => void closeEmail()}
      onSendCode={(e) => void sendCode(e)}
      verifyForm={<VerifyEmailForm onSubmit={(e) => void verifyCode(e)} onResend={() => void resendCode()} />}
    />,
    // x-teleport="body": after the layout, as on the reference.
    document.body,
    )}
    </>
  );
}

export function ProfilePage() {
  return (
    <Layout title="Profile" href="/profile" searchTitle="Search this page and everything (Press / or Ctrl+K, then Tab to switch)">
      <ProfileContent />
    </Layout>
  );
}
