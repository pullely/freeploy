// Derived from coollabsio/coolify@91b7e3e:resources/views/auth/login.blade.php,
// app/Http/Controllers/OauthController.php and lang/en.json (Apache-2.0), modified.
// Sign-in with GitHub and Google (DP-122). Coolify's login page links each
// enabled provider to /auth/{provider}/redirect, which sends the browser to the
// provider; the provider returns to /auth/{provider}/callback. In Freeploy the
// identity worker runs the OAuth exchange behind api-edge, so:
//   /auth/{provider}/redirect  -> the provider's `startUrl` (on the API host the
//                                 provider calls back to), with return_to set to
//   /auth/{provider}/callback  <- the API's redirect, the session token (or an
//                                 error code) in the URL fragment.

/** GET /v1/auth/oauth/providers: one entry per fully configured provider. */
export interface OAuthLoginProvider {
  id: string;
  displayName: string;
  startUrl?: string;
}

/** OauthSetting::loginLabel() with no custom label: __("auth.login.{provider}"). */
export function loginLabel(provider: Pick<OAuthLoginProvider, "id" | "displayName">): string {
  const labels: Record<string, string> = { github: "Login with GitHub", google: "Login with Google" };
  return labels[provider.id] ?? `Login with ${provider.displayName}`;
}

/** The console page the API returns to after the provider. */
export function callbackUrl(origin: string, providerId: string): string {
  return `${origin}/auth/${encodeURIComponent(providerId)}/callback`;
}

/**
 * Where /auth/{provider}/redirect sends the browser. The provider's startUrl
 * when the API gives one (its callback host, so the state cookie is
 * first-party to the callback); otherwise start on the console's own API.
 */
export function startUrl(provider: OAuthLoginProvider, origin: string, apiBase: string): string {
  const start = provider.startUrl ?? `${apiBase}/v1/auth/oauth/${encodeURIComponent(provider.id)}/start`;
  return `${start}?return_to=${encodeURIComponent(callbackUrl(origin, provider.id))}`;
}

/** The fragment the API's callback redirects with: a session token, or an error code. */
export function parseCallbackFragment(hash: string): { token: string } | { error: string } {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("token");
  if (token) return { token };
  return { error: params.get("error") ?? "missing_token" };
}

/**
 * The message the login page shows for a failed sign-in, in Coolify's words
 * (lang/en.json auth.failed.*).
 */
export function oauthErrorMessage(code: string): string {
  if (code === "email_unverified") return "Your sign-in provider did not verify your email address. Verify it with the provider and try again.";
  if (code === "email_required" || code === "access_denied") return "Sign-in with this provider failed. Contact your administrator if the problem continues.";
  if (code === "invalid_state" || code === "missing_code" || code === "missing_token") return "Failed to process callback from login provider.";
  return "Sign-in with this provider failed. Contact your administrator if the problem continues.";
}
