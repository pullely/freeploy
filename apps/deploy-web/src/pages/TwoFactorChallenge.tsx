// Derived from coollabsio/coolify@91b7e3e:resources/views/auth/two-factor-challenge.blade.php (Apache-2.0), modified.
// /two-factor-challenge: the second sign-in step for a user with 2FA. Six
// digit boxes over one hidden input that submits itself at six digits, or a
// recovery code; Fortify's messages in Coolify's error alert.
import { useRef, useState, type FormEvent } from "react";
import { Reicon } from "../components/Reicon";
import { ErrorList } from "../components/AuthAlert";
import { postJson, storeSession } from "../lib/api";

export const CHALLENGE_KEY = "freeploy.two-factor-challenge";

export function TwoFactorChallengePage() {
  const [showRecovery, setShowRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [focused, setFocused] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const formRef = useRef<HTMLFormElement>(null);
  let challenge: string | null = null;
  try {
    challenge = sessionStorage.getItem(CHALLENGE_KEY);
  } catch {
    /* storage blocked */
  }
  if (!challenge) {
    // Fortify: no pending sign-in, back to /login.
    window.location.replace("/login");
    return null;
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    const form = new FormData(e.currentTarget);
    const body = showRecovery ? { challenge, recovery_code: form.get("recovery_code") } : { challenge, code: form.get("code") };
    const result = await postJson<{ token: string }>("/v1/auth/two-factor/challenge", body);
    setSubmitting(false);
    if (!result.ok) {
      if (result.error.status === 401) {
        window.location.replace("/login");
        return;
      }
      setErrors(result.error.messages);
      return;
    }
    try {
      sessionStorage.removeItem(CHALLENGE_KEY);
    } catch {
      /* storage blocked */
    }
    storeSession(result.data.token);
    window.location.assign("/");
  }

  const digit = (i: number) =>
    `flex h-14 w-11 items-center justify-center rounded-md border bg-white text-xl font-semibold text-neutral-900 transition-colors dark:bg-coolgray-100 dark:text-white ${
      focused && (code.length === i || (code.length === 6 && i === 5)) ? "border-coollabs ring-1 ring-coollabs" : "border-neutral-300 dark:border-white/10"
    }`;

  return (
    <main className="h-full bg-neutral-50 dark:bg-base">
      <section className="auth-shell application-settings-form">
        <div className="auth-shell-content">
          <div className="auth-card">
            <div className="auth-card-heading">
              <h1>Freeploy</h1>
              <p>Verify your identity to finish signing in.</p>
            </div>
            <div className="auth-card-body">
              <div className="flex flex-col gap-4">
                <ErrorList errors={errors} />
                <div className="auth-guidance">
                  <Reicon name="info-circle" className="mt-0.5 size-4 shrink-0" />
                  {showRecovery ? (
                    <p>Enter one of the recovery codes you saved when setting up two-factor authentication.</p>
                  ) : (
                    <p>Enter the 6-digit code from your authenticator app.</p>
                  )}
                </div>
                <form ref={formRef} action="/two-factor-challenge" method="POST" className="flex flex-col gap-4" onSubmit={onSubmit}>
                  {!showRecovery ? (
                    <div className="flex flex-col gap-3">
                      <div className="relative mx-auto flex gap-2">
                        {[0, 1, 2, 3, 4, 5].map((i) => (
                          <div key={i} aria-hidden="true" data-code-digit="" className={digit(i)}>
                            {code[i] ?? ""}
                          </div>
                        ))}
                        <input
                          type="text"
                          name="code"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={6}
                          autoComplete="one-time-code"
                          autoFocus
                          aria-label="Two-factor authentication code"
                          value={code}
                          onFocus={() => setFocused(true)}
                          onBlur={() => setFocused(false)}
                          onChange={(e) => {
                            const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                            setCode(v);
                            if (v.length === 6) setTimeout(() => formRef.current?.requestSubmit());
                          }}
                          className="absolute inset-0 h-full w-full cursor-text rounded-md border-0 bg-transparent text-transparent caret-transparent opacity-0 focus:outline-none focus:ring-0"
                        />
                      </div>
                      <button type="button" className="auth-text-link self-center" onClick={() => setShowRecovery(true)}>
                        Use a recovery code
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-3">
                      <div className="w-full">
                        <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
                          <label htmlFor="recovery_code" className="mb-0! flex items-center gap-1 text-sm font-medium leading-4">
                            Recovery code
                          </label>
                        </div>
                        <input id="recovery_code" name="recovery_code" autoComplete="one-time-code" autoFocus className="input" />
                      </div>
                      <button type="button" className="auth-text-link self-center" onClick={() => setShowRecovery(false)}>
                        Use an authenticator code
                      </button>
                    </div>
                  )}
                  <button {...({ ishighlighted: "" } as object)} className="button w-full justify-center" type="submit" disabled={submitting}>
                    Verify and continue
                  </button>
                </form>
              </div>
            </div>
            <footer className="auth-card-footer">
              <span>Not your account?</span>
              <a href="/login" className="auth-text-link">
                Back to login
              </a>
            </footer>
          </div>
        </div>
      </section>
    </main>
  );
}
