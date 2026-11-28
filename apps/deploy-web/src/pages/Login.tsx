// Derived from coollabsio/coolify@91b7e3e:resources/views/auth/login.blade.php (Apache-2.0), modified.
// /login: Coolify's markup (generated from the reference's rendered page), the
// brand swapped. Submitting signs in with email + password through Freeploy's
// identity service; failures show Laravel's messages in Coolify's error alert.
import { useEffect, useState, type FormEvent } from "react";
import { browserSupportsWebAuthn, browserSupportsWebAuthnAutofill, startAuthentication } from "@simplewebauthn/browser";
import { LoginMarkup } from "./generated/LoginMarkup";
import { AuthAlert, ErrorList } from "../components/AuthAlert";
import { takeOAuthError, takeStatus } from "../lib/flash";
import { getJson, postJson, storeSession } from "../lib/api";
import { loginLabel, type OAuthLoginProvider } from "../lib/oauth-login";
import { CHALLENGE_KEY } from "./TwoFactorChallenge";

type Options = Parameters<typeof startAuthentication>[0]["optionsJSON"];

/** <x-auth.passkey-verify autofill />: a passkey button, and the browser's passkey autofill on the email field. */
function usePasskeySignIn() {
  const [supported] = useState(() => browserSupportsWebAuthn());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(autofill: boolean) {
    const opts = await postJson<{ options: Options; state: string }>("/v1/auth/passkeys/login/options", {});
    if (!opts.ok) throw new Error(opts.error.messages[0] ?? "Passkeys are not available.");
    const response = await startAuthentication({ optionsJSON: opts.data.options, useBrowserAutofill: autofill });
    const result = await postJson<{ token: string }>("/v1/auth/passkeys/login", { state: opts.data.state, response });
    if (!result.ok) throw new Error(result.error.messages[0] ?? "The passkey could not be verified.");
    storeSession(result.data.token);
    window.location.assign("/");
  }
  useEffect(() => {
    if (!supported) return;
    void (async () => {
      try {
        // @laravel/passkeys autofill(): browsers without conditional mediation report it.
        if (!(await browserSupportsWebAuthnAutofill())) throw new Error("Passkeys are not supported in this browser.");
        await run(true);
      } catch (e) {
        if ((e as Error).name !== "AbortError" && (e as Error).name !== "NotAllowedError") setError((e as Error).message);
      }
    })();
  }, [supported]);
  async function verify() {
    setLoading(true);
    setError(null);
    try {
      await run(false);
    } catch (e) {
      if ((e as Error).name !== "NotAllowedError") setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  return { supported, loading, error, verify };
}

/**
 * @if ($enabled_oauth_providers->isNotEmpty()): "Or continue with" and a
 * button per provider, each to /auth/{provider}/redirect (DP-122).
 */
function OAuthButtons({ providers }: { providers: OAuthLoginProvider[] }) {
  if (providers.length === 0) return null;
  return (
    <>
      <div className="auth-divider">
        <span>Or continue with</span>
      </div>
      <div className="flex flex-col gap-2">
        {providers.map((p) => (
          <button key={p.id} className="button w-full justify-center" type="button" onClick={() => window.location.assign(`/auth/${encodeURIComponent(p.id)}/redirect`)}>
            <img className="size-5 shrink-0 dark:invert" src={`/svgs/${p.id}.svg`} alt="" aria-hidden="true" />
            {loginLabel(p)}
          </button>
        ))}
      </div>
    </>
  );
}

export function LoginPage() {
  const passkey = usePasskeySignIn();
  // A failed provider sign-in comes back here with its message (DP-122).
  const [errors, setErrors] = useState<string[]>(() => {
    const oauthError = takeOAuthError();
    return oauthError ? [oauthError] : [];
  });
  const [providers, setProviders] = useState<OAuthLoginProvider[]>([]);
  useEffect(() => {
    void getJson<{ providers: OAuthLoginProvider[] }>("/v1/auth/oauth/providers").then((res) => setProviders(res.data?.providers ?? []));
  }, []);
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
  return (
    <LoginMarkup
      alert={alert}
      onSubmit={onSubmit}
      passkeySupported={passkey.supported}
      onPasskey={() => void passkey.verify()}
      passkeyLoading={passkey.loading}
      passkeyError={passkey.error}
      oauth={<OAuthButtons providers={providers} />}
    />
  );
}
