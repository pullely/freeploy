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
