// Derived from coollabsio/coolify@91b7e3e:resources/views/auth/login.blade.php (Apache-2.0), modified.
// /login: Coolify's markup (generated from the reference's rendered page), the
// brand swapped. Submitting signs in with email + password through Freeploy's
// identity service; failures show Laravel's messages in Coolify's error alert.
import { useState, type FormEvent } from "react";
import { LoginMarkup } from "./generated/LoginMarkup";
import { AuthAlert, ErrorList } from "../components/AuthAlert";
import { takeStatus } from "../lib/flash";
import { postJson, storeSession } from "../lib/api";
import { CHALLENGE_KEY } from "./TwoFactorChallenge";

export function LoginPage() {
  const [errors, setErrors] = useState<string[]>([]);
  // Laravel's session('status'), e.g. after a password reset.
  const [status] = useState<string | null>(() => takeStatus());
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const result = await postJson<{ token?: string; twoFactor?: boolean; challenge?: string }>("/v1/auth/password/login", { email: form.get("email"), password: form.get("password") });
    if (!result.ok) {
      setErrors(result.error.messages);
      return;
    }
    if (result.data.twoFactor && result.data.challenge) {
      // Fortify's RedirectIfTwoFactorAuthenticatable: finish at /two-factor-challenge.
      try {
        sessionStorage.setItem(CHALLENGE_KEY, result.data.challenge);
      } catch {
        /* storage blocked */
      }
      window.location.assign("/two-factor-challenge");
      return;
    }
    if (result.data.token) storeSession(result.data.token);
    window.location.assign("/");
  }
  const alert = (
    <>
      {status ? <AuthAlert type="success">{status}</AuthAlert> : null}
      <ErrorList errors={errors} />
    </>
  );
  return <LoginMarkup alert={alert} onSubmit={onSubmit} />;
}
