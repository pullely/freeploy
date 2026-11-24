// Email verification and email change (freeploy-coolify-parity DP3).
import { webcrypto } from "node:crypto";
import { verificationUrl, newEmailErrors, handleEmailVerify, handleEmailChangeVerify } from "../../../apps/identity-worker/src/handlers/email";
import type { Env } from "../../../apps/identity-worker/src/env";

if (!globalThis.crypto) (globalThis as { crypto: unknown }).crypto = webcrypto;
const env = { ENVIRONMENT: "test", DEPLOY_WEB_URL: "https://app.example/", IDENTITY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64") } as unknown as Env;

describe("verification link", () => {
  it("is Coolify's signed route on deploy-web: /email/verify/{id}/{sha256(email)}?expires&signature, 60 minutes", async () => {
    const url = new URL(await verificationUrl(env, "usr_abc", "Ada@Example.com", 1_700_000_000_000));
    expect(url.origin).toBe("https://app.example");
    const [, , , id, hash] = url.pathname.split("/");
    expect(id).toBe("usr_abc");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Number(url.searchParams.get("expires"))).toBe(1_700_000_000 + 3600);
    expect(url.searchParams.get("signature")).toMatch(/^[0-9a-f]{64}$/);
    // Same inputs, same signature; a different user, a different one.
    expect(await verificationUrl(env, "usr_abc", "ada@example.com", 1_700_000_000_000)).toBe(url.toString());
    expect(await verificationUrl(env, "usr_abd", "ada@example.com", 1_700_000_000_000)).not.toBe(url.toString());
  });

  it("verifying needs a session", async () => {
    const r = await handleEmailVerify(new Request("https://i/v1/auth/email/verify", { method: "POST", body: "{}" }), env, "r");
    expect(r.status).toBe(401);
  });
});

describe("email change", () => {
  it("validates new_email as requestEmailChange does", async () => {
    const free = async () => false;
    expect(await newEmailErrors("", free)).toEqual(["The new email field is required."]);
    expect(await newEmailErrors("nope", free)).toEqual(["The new email field must be a valid email address."]);
    expect(await newEmailErrors("a@b.co", async () => true)).toEqual(["The new email has already been taken."]);
    expect(await newEmailErrors("a@b.co", free)).toEqual([]);
  });

  it("verifying the code needs a session", async () => {
    const r = await handleEmailChangeVerify(new Request("https://i/x", { method: "POST", body: "{}" }), env, "r");
    expect(r.status).toBe(401);
  });
});
