import { test } from "node:test";
import assert from "node:assert/strict";
import { githubManifest, setupStateOrg } from "../src/lib/github-manifest.ts";

const input = {
  name: "freeploy-acme-1a2b3c",
  organization: null,
  htmlUrl: "https://github.com",
  state: "eyJvcmciOiJvcmdfYWJjIn0.c2ln",
  webOrigin: "https://console.example.com/",
  edgeOrigin: "https://api.example.com",
  previewDeploymentPermissions: true,
  deploymentStatusPermissions: false,
  administration: false,
};

test("createGithubApp(): Coolify's permissions and events, the webhook on api-edge, the redirects on the console", () => {
  const { action, manifest } = githubManifest(input);
  assert.equal(action, "https://github.com/settings/apps/new?state=eyJvcmciOiJvcmdfYWJjIn0.c2ln");
  assert.deepEqual(manifest.hook_attributes, { url: "https://api.example.com/webhooks/source/github/events", active: true });
  assert.equal(manifest.url, "https://console.example.com");
  assert.equal(manifest.redirect_url, "https://console.example.com/webhooks/source/github/redirect");
  assert.equal(manifest.setup_url, "https://console.example.com/webhooks/source/github/install");
  assert.deepEqual(manifest.callback_urls, ["https://console.example.com/login/github/app"]);
  assert.equal(manifest.public, false);
  assert.equal(manifest.setup_on_update, true);
  assert.deepEqual(manifest.default_permissions, { contents: "read", metadata: "read", emails: "read", administration: "read", pull_requests: "write" });
  assert.deepEqual(manifest.default_events, ["push", "pull_request"]);
});

test("createGithubApp(): an organization's App, deployments and administration write, no previews", () => {
  const { action, manifest } = githubManifest({ ...input, organization: "/acme/", previewDeploymentPermissions: false, deploymentStatusPermissions: true, administration: true });
  assert.equal(action, "https://github.com/organizations/acme/settings/apps/new?state=eyJvcmciOiJvcmdfYWJjIn0.c2ln");
  assert.deepEqual(manifest.default_permissions, { contents: "read", metadata: "read", emails: "read", administration: "write", deployments: "write" });
  assert.deepEqual(manifest.default_events, ["push"]);
});

test("setupStateOrg(): the org of a well-formed state, else null", () => {
  assert.equal(setupStateOrg(input.state), "org_abc");
  assert.equal(setupStateOrg(null), null);
  assert.equal(setupStateOrg("not-base64!.x"), null);
  assert.equal(setupStateOrg(`${btoa(JSON.stringify({ org: "../x" }))}.s`), null);
  assert.equal(setupStateOrg(`${btoa(JSON.stringify({ org: 7 }))}.s`), null);
});
