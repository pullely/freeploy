import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeBase } from "../src/lib/api.ts";

// The console finds api-edge from its own host (DP-120): the custom domains
// infra/terraform/cloudflare-domain attaches pair app/api and stage/api-stage.
test("edgeBase(): the API host for each console host", () => {
  assert.equal(edgeBase("app.freeploy.io"), "https://api.freeploy.io");
  assert.equal(edgeBase("stage.freeploy.io"), "https://api-stage.freeploy.io");
  assert.equal(edgeBase("freeploy-deploy-web-stage.nexo-7be.workers.dev"), "https://freeploy-api-edge-stage.nexo-7be.workers.dev");
  assert.equal(edgeBase("freeploy-deploy-web-prod.nexo-7be.workers.dev"), "https://freeploy-api-edge-prod.nexo-7be.workers.dev");
  assert.equal(edgeBase("localhost:5173"), "http://127.0.0.1:8787");
  assert.equal(edgeBase("console.acme.test"), "https://api.console.acme.test");
});
