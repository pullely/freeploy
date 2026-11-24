// Derived from coollabsio/coolify@91b7e3e:resources/views/auth/verify-email.blade.php,
// resources/views/livewire/verify-email.blade.php, app/Livewire/VerifyEmail.php and
// Controller::email_verify (Apache-2.0), modified.
// /verify: an unverified account waits here (Coolify Cloud's DecideWhatToDoWithUser);
// /email/verify/{id}/{hash}: the signed link from the email.
import { useEffect, useState } from "react";
import { Reicon } from "../components/Reicon";
import { postJson, sessionToken, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Toasts } from "../layout/Toasts";

function AuthShell({ description, children, footer }: { description: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <main className="h-full bg-neutral-50 dark:bg-base">
      <section className="auth-shell application-settings-form">
        <div className="auth-shell-content">
          <div className="auth-card">
            <div className="auth-card-heading">
              <h1>Freeploy</h1>
              <p>{description}</p>
            </div>
            <div className="auth-card-body">{children}</div>
            {footer ? <footer className="auth-card-footer">{footer}</footer> : null}
          </div>
        </div>
      </section>
    </main>
  );
}

export function VerifyEmailPage() {
  if (!sessionToken()) {
    window.location.replace("/login");
    return null;
  }
  async function again() {
    const r = await postJson<{ status: string }>("/v1/auth/email/verification-notification", {});
    if (!r.ok) return notify.error(summarize(r.error.messages));
    notify.success(r.data.status);
  }
  return (
    <>
      <AuthShell
        description="Verify your email address to activate your account."
        footer={
          <span className="text-center">
            <span className="block sm:inline">Didn’t receive the email?</span>
            <span className="block sm:ml-1 sm:inline">Check your spam folder or resend it.</span>
          </span>
        }
      >
        <div className="flex flex-col gap-4">
          <div className="auth-guidance">
            <Reicon name="mail" className="mt-0.5 size-4 shrink-0" />
            <p>We sent a verification link to your email address. Open it to continue to Freeploy.</p>
          </div>
          <div>
            <button {...({ ishighlighted: "" } as object)} className="button w-full justify-center" type="button" onClick={() => void again()}>
              Resend verification email
            </button>
          </div>
        </div>
      </AuthShell>
      <ul className="fixed z-9999 flex w-[calc(100%-2rem)] gap-2.5 sm:max-w-[26rem] right-4 bottom-4 flex-col-reverse">
        <Toasts />
      </ul>
    </>
  );
}

/** The link's landing: Laravel's auth middleware first, then the signature check (403 when invalid). */
export function EmailVerifyLinkPage() {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!sessionToken()) {
      try {
        sessionStorage.setItem("freeploy.intended", window.location.pathname + window.location.search);
      } catch {
        /* storage blocked */
      }
      window.location.replace("/login");
      return;
    }
    const [, , , id, hash] = window.location.pathname.split("/");
    const q = new URLSearchParams(window.location.search);
    void postJson("/v1/auth/email/verify", { id, hash, expires: q.get("expires"), signature: q.get("signature") }).then((r) => {
      if (r.ok) window.location.replace("/");
      else setFailed(true);
    });
  }, []);
  // Laravel answers an invalid signature with its 403 page.
  return failed ? <AuthShell description="403 | Invalid signature.">{null}</AuthShell> : null;
}
