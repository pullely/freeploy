// Derived from coollabsio/coolify@91b7e3e:routes/web.php (auth.redirect,
// auth.callback) and app/Http/Controllers/OauthController.php (Apache-2.0),
// modified. /auth/{provider}/redirect sends the browser to the provider through
// the identity worker; /auth/{provider}/callback takes the session the worker
// hands back in the URL fragment and signs in (DP-122).
import { useEffect } from "react";
import { edgeBase, getJson, storeSession } from "../lib/api";
import { flashOAuthError } from "../lib/flash";
import { oauthErrorMessage, parseCallbackFragment, startUrl, type OAuthLoginProvider } from "../lib/oauth-login";

/** The {provider} segment of /auth/{provider}/(redirect|callback). */
export function providerFromPath(pathname: string): string {
  return decodeURIComponent(pathname.split("/")[2] ?? "");
}

/** OauthController::redirect(): an unknown or disabled provider goes back to /login with Coolify's message. */
export function OAuthRedirectPage() {
  useEffect(() => {
    void (async () => {
      const id = providerFromPath(window.location.pathname);
      const res = await getJson<{ providers: OAuthLoginProvider[] }>("/v1/auth/oauth/providers");
      const provider = res.data?.providers.find((p) => p.id === id);
      if (!provider) {
        flashOAuthError(oauthErrorMessage("provider_unavailable"));
        window.location.replace("/login");
        return;
      }
      window.location.replace(startUrl(provider, window.location.origin, edgeBase()));
    })();
  }, []);
  return null;
}

/** OauthController::callback(): sign in with the handed-back session, or back to /login with the error. */
export function OAuthCallbackPage() {
  useEffect(() => {
    const result = parseCallbackFragment(window.location.hash);
    // The token never stays in the address bar or the history.
    window.history.replaceState(null, "", window.location.pathname);
    if ("token" in result) {
      storeSession(result.token);
      window.location.replace("/");
      return;
    }
    flashOAuthError(oauthErrorMessage(result.error));
    window.location.replace("/login");
  }, []);
  return null;
}
