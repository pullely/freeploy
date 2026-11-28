// Passkeys (freeploy-coolify-parity DP3): the relying party, guards and messages.
import { webcrypto } from "node:crypto";
import { relyingParty, handlePasskeyLoginOptions, handlePasskeyLogin, handlePasskeyOptions } from "../../../apps/identity-worker/src/handlers/passkeys";
import type { Env } from "../../../apps/identity-worker/src/env";

if (!globalThis.crypto) (globalThis as { crypto: unknown }).crypto = webcrypto;
const env = {
  ENVIRONMENT: "test",
  PLATFORM_DB: {},
  DEPLOY_WEB_URL: "https://freeploy-deploy-web-stage.example.workers.dev/",
  IDENTITY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
} as unknown as Env;
const post = (path: string, body: unknown) => new Request(`https://identity.internal${path}`, { method: "POST", body: JSON.stringify(body) });

describe("passkeys", () => {
  it("uses deploy-web's host as the relying party, and is unavailable without it", () => {
    expect(relyingParty(env)).toEqual({ rpID: "freeploy-deploy-web-stage.example.workers.dev", origin: "https://freeploy-deploy-web-stage.example.workers.dev" });
    expect(relyingParty({ ENVIRONMENT: "test" } as unknown as Env)).toBeNull();
  });

  it("picks the console host the request comes from among DEPLOY_WEB_URL and DEPLOY_WEB_ALT_URLS, the primary otherwise", () => {
    const both = { ...env, DEPLOY_WEB_URL: "https://stage.freeploy.io", DEPLOY_WEB_ALT_URLS: " https://freeploy-deploy-web-stage.example.workers.dev , not a url" } as unknown as Env;
    expect(relyingParty(both, "https://stage.freeploy.io")).toEqual({ rpID: "stage.freeploy.io", origin: "https://stage.freeploy.io" });
    expect(relyingParty(both, "https://freeploy-deploy-web-stage.example.workers.dev")).toEqual({ rpID: "freeploy-deploy-web-stage.example.workers.dev", origin: "https://freeploy-deploy-web-stage.example.workers.dev" });
    expect(relyingParty(both, "https://evil.example")).toEqual({ rpID: "stage.freeploy.io", origin: "https://stage.freeploy.io" });
    expect(relyingParty(both, null)).toEqual({ rpID: "stage.freeploy.io", origin: "https://stage.freeploy.io" });
  });

  it("offers sign-in options for the relying party of the request's Origin", async () => {
    const both = { ...env, DEPLOY_WEB_URL: "https://app.freeploy.io", DEPLOY_WEB_ALT_URLS: "https://freeploy-deploy-web-prod.example.workers.dev" } as unknown as Env;
    const from = (origin: string) => new Request("https://identity.internal/v1/auth/passkeys/login/options", { method: "POST", body: "{}", headers: { origin } });
    const onDomain = (await (await handlePasskeyLoginOptions(from("https://app.freeploy.io"), both, "r")).json()) as { data: { options: { rpId: string } } };
    const onWorkers = (await (await handlePasskeyLoginOptions(from("https://freeploy-deploy-web-prod.example.workers.dev"), both, "r")).json()) as { data: { options: { rpId: string } } };
    expect(onDomain.data.options.rpId).toBe("app.freeploy.io");
    expect(onWorkers.data.options.rpId).toBe("freeploy-deploy-web-prod.example.workers.dev");
  });

  it("offers sign-in options for any credential on the relying party, with sealed state", async () => {
    const res = await handlePasskeyLoginOptions(post("/v1/auth/passkeys/login/options", {}), env, "r");
    const body = (await res.json()) as { data: { options: { rpId: string; challenge: string; allowCredentials?: unknown[] }; state: string } };
    expect(res.status).toBe(200);
    expect(body.data.options.rpId).toBe("freeploy-deploy-web-stage.example.workers.dev");
    expect(body.data.options.allowCredentials ?? []).toEqual([]);
    expect(body.data.state).toMatch(/^fp1:/);
    expect(body.data.state).not.toContain(body.data.options.challenge);
  });

  it("refuses a sign-in with forged state", async () => {
    const res = await handlePasskeyLogin(post("/v1/auth/passkeys/login", { state: "fp1:AAAA", response: { id: "x" } }), env, "r");
    expect(res.status).toBe(422);
  });

  it("registration needs a session", async () => {
    expect((await handlePasskeyOptions(post("/v1/auth/passkeys/options", {}), env, "r")).status).toBe(401);
  });
});
