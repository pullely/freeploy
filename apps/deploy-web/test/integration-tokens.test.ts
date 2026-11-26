// DP-104: the Integration Tokens page's browser side — IntegrationTokenForm::updatedProvider(), updatedCapabilities(),
// IntegrationToken::cloudflareTokenTemplateUrl(), and the form's and editor's labels, helpers and counts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INITIAL_FORM,
  INTEGRATION_PROVIDER_OPTIONS,
  cloudflareTokenTemplateUrl,
  metadataFields,
  newSecretField,
  secretLabel,
  settingsOf,
  toggleCapability,
  tokenNamePlaceholder,
  withProvider,
  zoneCount,
} from "../src/lib/integration-tokens.ts";

test("the form starts as a Cloudflare DNS token, and a provider change resets its state as updatedProvider() does", () => {
  assert.deepEqual(INITIAL_FORM, { provider: "cloudflare", capabilities: ["dns"], metadata: {}, automaticDns: true, proxiedDns: false });
  assert.deepEqual(withProvider("infisical"), { provider: "infisical", capabilities: ["secrets"], metadata: { base_url: "https://app.infisical.com" }, automaticDns: true, proxiedDns: false });
  assert.deepEqual(withProvider("vault").metadata, {});
  assert.deepEqual(withProvider("doppler").capabilities, ["secrets"]);
  assert.deepEqual(withProvider("cloudflare"), INITIAL_FORM);
  assert.deepEqual(
    INTEGRATION_PROVIDER_OPTIONS.map((o) => o.label),
    ["Cloudflare", "Doppler", "Infisical", "HashiCorp Vault"],
  );
});

test("selecting Cloudflare Tunnel also selects DNS", () => {
  assert.deepEqual(toggleCapability(["dns"], "tunnel", true), ["dns", "tunnel"]);
  assert.deepEqual(toggleCapability([], "tunnel", true), ["tunnel", "dns"]);
  assert.deepEqual(toggleCapability(["dns", "tunnel"], "dns", false), ["tunnel", "dns"]);
  assert.deepEqual(toggleCapability(["dns", "tunnel"], "tunnel", false), ["dns"]);
  assert.deepEqual(toggleCapability(["dns"], "dns", false), []);
});

test("the Cloudflare link pre-fills the permissions the capabilities need, as http_build_query(RFC 3986) writes it", () => {
  assert.equal(
    cloudflareTokenTemplateUrl(["dns"]),
    "https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22dns%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%5D&accountId=%2A&zoneId=all&name=Coolify%20DNS%20Management&ref=coolify.io",
  );
  const tunnel = new URL(cloudflareTokenTemplateUrl(["dns", "tunnel"]));
  assert.deepEqual(JSON.parse(tunnel.searchParams.get("permissionGroupKeys")!), [
    { key: "dns", type: "edit" },
    { key: "zone", type: "read" },
    { key: "argotunnel", type: "edit" },
  ]);
  assert.equal(tunnel.searchParams.get("name"), "Coolify DNS and Tunnel Management");
});

test("the labels, placeholders and helpers of the form and the editor", () => {
  assert.deepEqual(["cloudflare", "doppler", "infisical", "vault"].map(tokenNamePlaceholder), ["Production DNS", "Production secrets", "Production secrets", "Production secrets"]);
  assert.deepEqual(["cloudflare", "doppler", "infisical", "vault"].map(secretLabel), ["API token", "API token", "Client secret", "Vault token"]);
  assert.deepEqual(newSecretField("infisical"), { label: "New client secret", helper: "Paste a replacement client secret to rotate this credential. Required when you change the base URL or the client ID." });
  assert.deepEqual(newSecretField("vault"), { label: "New API token", helper: "Paste a replacement token to rotate this credential. Required when you change the base URL or the namespace." });
  assert.deepEqual(newSecretField("cloudflare"), { label: "New API token", helper: "Paste a replacement token to rotate this credential." });
});

test("the zone counts, and the settings each provider's form sends", () => {
  assert.deepEqual([zoneCount(0), zoneCount(1), zoneCount(2), zoneCount(1, true)], ["0 zones", "1 zone", "2 zones", "1 accessible zone"]);
  assert.deepEqual(settingsOf("infisical", { base_url: "u", client_id: "c", namespace: "n" }), { base_url: "u", client_id: "c" });
  assert.deepEqual(settingsOf("vault", { base_url: "u", namespace: "n", timeout: "5" }), { base_url: "u", namespace: "n", timeout: "5" });
  assert.deepEqual(settingsOf("cloudflare", { zones_synced_at: "x" }), {});
  assert.deepEqual(metadataFields({ base_url: "u", timeout: 15, automatic_dns: false }), { base_url: "u", timeout: "15" });
});
