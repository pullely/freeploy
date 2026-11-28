import { test } from "node:test";
import assert from "node:assert/strict";
import { callbackUrl, loginLabel, oauthErrorMessage, parseCallbackFragment, startUrl } from "../src/lib/oauth-login.ts";
import { pageFor } from "../src/routes.ts";

// DP-122: sign in with GitHub and Google.
test("loginLabel(): Coolify's auth.login.{provider}", () => {
  assert.equal(loginLabel({ id: "github", displayName: "GitHub" }), "Login with GitHub");
  assert.equal(loginLabel({ id: "google", displayName: "Google" }), "Login with Google");
  assert.equal(loginLabel({ id: "acme", displayName: "Acme" }), "Login with Acme");
});

test("startUrl(): the provider's startUrl on the callback host, with return_to the console's /auth/{provider}/callback", () => {
  assert.equal(callbackUrl("https://app.freeploy.io", "github"), "https://app.freeploy.io/auth/github/callback");
  assert.equal(
    startUrl({ id: "github", displayName: "GitHub", startUrl: "https://api.freeploy.io/v1/auth/oauth/github/start" }, "https://freeploy-deploy-web-prod.nexo-7be.workers.dev", "https://freeploy-api-edge-prod.nexo-7be.workers.dev"),
    "https://api.freeploy.io/v1/auth/oauth/github/start?return_to=https%3A%2F%2Ffreeploy-deploy-web-prod.nexo-7be.workers.dev%2Fauth%2Fgithub%2Fcallback",
  );
  assert.equal(
    startUrl({ id: "google", displayName: "Google" }, "https://stage.freeploy.io", "https://api-stage.freeploy.io"),
    "https://api-stage.freeploy.io/v1/auth/oauth/google/start?return_to=https%3A%2F%2Fstage.freeploy.io%2Fauth%2Fgoogle%2Fcallback",
  );
});

test("parseCallbackFragment(): the session token, or the error code", () => {
  assert.deepEqual(parseCallbackFragment("#token=abc.def&token_type=bearer&expires_at=1"), { token: "abc.def" });
  assert.deepEqual(parseCallbackFragment("#error=access_denied"), { error: "access_denied" });
  assert.deepEqual(parseCallbackFragment(""), { error: "missing_token" });
});

test("oauthErrorMessage(): Coolify's auth.failed messages", () => {
  assert.equal(oauthErrorMessage("email_unverified"), "Your sign-in provider did not verify your email address. Verify it with the provider and try again.");
  assert.equal(oauthErrorMessage("missing_code"), "Failed to process callback from login provider.");
  assert.equal(oauthErrorMessage("exchange_failed"), "Sign-in with this provider failed. Contact your administrator if the problem continues.");
});

test("routes: /auth/{provider}/redirect and /auth/{provider}/callback", () => {
  assert.equal(pageFor("/auth/github/redirect"), "auth.redirect");
  assert.equal(pageFor("/auth/google/callback"), "auth.callback");
  assert.equal(pageFor("/auth/github/callback/"), "auth.callback");
  assert.equal(pageFor("/auth/link"), "not-ported");
});
