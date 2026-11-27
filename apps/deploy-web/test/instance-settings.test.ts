// DP-101: the decisions of the platform's Updates, Email and Authentication pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  channelCallout,
  defaultRedirectUri,
  frequencyFallback,
  INSTANCE_SETTINGS_API,
  isProviderHost,
  missingRequired,
  notActiveYet,
  oauthCheckboxes,
  oauthFields,
  randomAutoUpdateFrequency,
  SETTINGS_PAGES,
  UPDATE_CHANNEL_OPTIONS,
} from "../src/lib/instance-settings.ts";

test("<x-settings.layout>'s pages, with Image Scanning (DP-116), in Coolify's order and sections", () => {
  assert.deepEqual(
    SETTINGS_PAGES.map((p) => [p.section, p.label, p.href]),
    [
      ["Configuration", "General", "/settings"],
      ["Configuration", "Advanced", "/settings/advanced"],
      ["Configuration", "Updates", "/settings/updates"],
      ["Configuration", "Image Scanning", "/settings/image-scanning"],
      ["Instance", "Authentication", "/settings/oauth"],
      ["Instance", "Email", "/settings/email"],
      ["Instance", "Backup", "/settings/backup"],
    ],
  );
  assert.equal(INSTANCE_SETTINGS_API.oauth(null), "/v1/platform/settings/oauth");
  assert.equal(INSTANCE_SETTINGS_API.oauth("github"), "/v1/platform/settings/oauth/github");
});

test("Updates: the channels and the callout each shows; submit()'s value for an empty frequency", () => {
  assert.deepEqual(
    UPDATE_CHANNEL_OPTIONS.map((o) => o.label),
    ["Stable", "Preview", "Nightly", "Custom image"],
  );
  assert.equal(channelCallout("stable")?.title, "Try the next version early");
  assert.equal(channelCallout("stable")?.type, "info");
  assert.equal(channelCallout("preview"), null);
  assert.equal(channelCallout("nightly")?.title, "Nightly builds can break this instance");
  assert.equal(channelCallout("custom")?.type, "danger");
  assert.equal(randomAutoUpdateFrequency(() => 0.999), "59 0 * * *");
  assert.equal(randomAutoUpdateFrequency(() => 0), "0 0 * * *");
  assert.deepEqual(frequencyFallback("Invalid Cron / Human expression for Auto Update Frequency.", "", "0 * * * *", () => 0.5), { auto_update_frequency: "30 0 * * *" });
  assert.deepEqual(frequencyFallback("Invalid Cron / Human expression for Auto Update Frequency.", "nope", "0 * * * *"), {});
  assert.deepEqual(frequencyFallback("Invalid Cron / Human expression for Update Check Frequency.", "x", ""), { update_check_frequency: "0 * * * *" });
});

test("Email: the 'Not active yet' notice, the provider hosts that need a login", () => {
  assert.equal(notActiveYet("smtp", "smtp"), null);
  assert.equal(notActiveYet("smtp", "none"), "Enter the SMTP settings and save. Until then, Freeploy does not send email.");
  assert.equal(notActiveYet("resend", "smtp"), "Enter the Resend settings and save. Until then, Freeploy sends email with SMTP.");
  assert.equal(isProviderHost(" SMTP.Mailgun.org "), true);
  assert.equal(isProviderHost("mail.example.com"), false);
  assert.equal(isProviderHost(null), false);
});

test("Authentication: each provider's fields and checkboxes in the blade's order, its required fields, the redirect URI's placeholder", () => {
  assert.deepEqual(
    oauthFields("github").map((f) => f.label),
    ["Redirect URI", "Client ID", "Client secret"],
  );
  assert.deepEqual(
    oauthFields("oidc").map((f) => [f.label, f.required ?? false]),
    [
      ["Redirect URI", false],
      ["Issuer URL", true],
      ["Client ID", true],
      ["Client secret", true],
      ["Scopes", false],
      ["Clock skew (seconds)", false],
      ["Login button label", false],
    ],
  );
  assert.deepEqual(oauthFields("azure").at(-1), { field: "tenant", label: "Tenant", required: true });
  assert.equal(oauthFields("google").at(-1)?.label, "Hosted domain");
  assert.deepEqual(
    ["authentik", "clerk", "zitadel", "gitlab", "discord"].map((p) => [p, oauthFields(p).find((f) => f.field === "base_url")?.required ?? null]),
    [
      ["authentik", true],
      ["clerk", true],
      ["zitadel", false],
      ["gitlab", false],
      ["discord", null],
    ],
  );
  assert.deepEqual(
    oauthCheckboxes("oidc").map((c) => c.field),
    ["allow_registration", "require_email_verified", "use_pkce", "auto_join_root_team"],
  );
  assert.deepEqual(
    oauthCheckboxes("github").map((c) => c.label),
    ["Auto-join new users to Root team"],
  );
  assert.equal(missingRequired("github", { client_id: "a", client_secret: " " }), "client_secret");
  assert.equal(missingRequired("azure", { client_id: "a", client_secret: "b" }), "tenant");
  assert.equal(missingRequired("gitlab", { client_id: "a", client_secret: "b" }), null);
  assert.equal(defaultRedirectUri("https://api.example.com/", "github"), "https://api.example.com/v1/auth/oauth/github/callback");
});
