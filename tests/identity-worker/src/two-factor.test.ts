// Two-factor authentication (freeploy-coolify-parity DP3): TOTP as Google2FA
// computes it for Fortify, sealed secrets, and the endpoints' guards.
import { webcrypto } from "node:crypto";
import { base32Decode, base32Encode, codeAt, generateSecret, matchStep, otpauthUrl, recoveryCode, stepAt } from "../../../apps/identity-worker/src/totp";
import { loadKey, open, seal } from "../../../apps/identity-worker/src/secret-box";
import { handleTwoFactorChallenge, handleTwoFactorConfirm, MESSAGES } from "../../../apps/identity-worker/src/handlers/two-factor";
import type { Env } from "../../../apps/identity-worker/src/env";

if (!globalThis.crypto) (globalThis as { crypto: unknown }).crypto = webcrypto;

// RFC 6238 appendix B, SHA-1, secret "12345678901234567890", last six digits.
const RFC_SECRET = base32Encode(new TextEncoder().encode("12345678901234567890"));

describe("TOTP", () => {
  it("matches RFC 6238's SHA-1 test vectors", async () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(await codeAt(RFC_SECRET, stepAt(59))).toBe("287082");
    expect(await codeAt(RFC_SECRET, stepAt(1111111109))).toBe("081804");
    expect(await codeAt(RFC_SECRET, stepAt(1234567890))).toBe("005924");
    expect(await codeAt(RFC_SECRET, stepAt(2000000000))).toBe("279037");
  });

  it("accepts a code one step either side of now, and nothing else", async () => {
    const now = 1111111109;
    expect(await matchStep(RFC_SECRET, await codeAt(RFC_SECRET, stepAt(now) - 1), now)).toBe(stepAt(now) - 1);
    expect(await matchStep(RFC_SECRET, await codeAt(RFC_SECRET, stepAt(now) + 1), now)).toBe(stepAt(now) + 1);
    expect(await matchStep(RFC_SECRET, await codeAt(RFC_SECRET, stepAt(now) - 2), now)).toBeNull();
    expect(await matchStep(RFC_SECRET, "12345", now)).toBeNull();
  });

  it("makes Fortify-shaped secrets, URLs and recovery codes", () => {
    expect(generateSecret()).toMatch(/^[A-Z2-7]{16}$/);
    expect(base32Decode(base32Encode(new Uint8Array([1, 2, 3, 250])))).toEqual(new Uint8Array([1, 2, 3, 250]));
    expect(otpauthUrl("Freeploy", "a@b.c", "ABC")).toBe("otpauth://totp/Freeploy:a%40b.c?secret=ABC&issuer=Freeploy&algorithm=SHA1&digits=6&period=30");
    expect(recoveryCode()).toMatch(/^[A-Za-z0-9]{10}-[A-Za-z0-9]{10}$/);
  });
});

describe("secret box", () => {
  it("round-trips, and refuses a value sealed for another context", async () => {
    const key = await loadKey(Buffer.alloc(32, 7).toString("base64"));
    const sealed = await seal(key, "2fa-secret:u1", "JBSWY3DPEHPK3PXP");
    expect(sealed).toMatch(/^fp1:/);
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(await open(key, "2fa-secret:u1", sealed)).toBe("JBSWY3DPEHPK3PXP");
    await expect(open(key, "2fa-secret:u2", sealed)).rejects.toThrow();
  });

  it("requires a 32-byte key", async () => {
    await expect(loadKey(undefined)).rejects.toThrow();
    await expect(loadKey(Buffer.alloc(16).toString("base64"))).rejects.toThrow();
  });
});

describe("two-factor endpoints", () => {
  const env = { ENVIRONMENT: "test", PLATFORM_DB: {}, IDENTITY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") } as unknown as Env;
  const post = (path: string, body: unknown) => new Request(`https://identity.internal${path}`, { method: "POST", body: JSON.stringify(body) });

  it("confirming needs a session", async () => {
    expect((await handleTwoFactorConfirm(post("/v1/auth/two-factor/confirm", { code: "123456" }), env, "r")).status).toBe(401);
  });

  it("a forged or expired challenge goes back to sign-in", async () => {
    expect((await handleTwoFactorChallenge(post("/v1/auth/two-factor/challenge", { challenge: "fp1:AAAA", code: "123456" }), env, "r")).status).toBe(401);
    const key = await loadKey(env.IDENTITY_ENCRYPTION_KEY);
    const expired = await seal(key, "2fa-challenge", JSON.stringify({ u: "x", exp: 1 }));
    expect((await handleTwoFactorChallenge(post("/v1/auth/two-factor/challenge", { challenge: expired, code: "123456" }), env, "r")).status).toBe(401);
  });

  it("uses Fortify's messages", () => {
    expect(MESSAGES.codeInvalid).toBe("The provided two factor authentication code was invalid.");
    expect(MESSAGES.recoveryInvalid).toBe("The provided two factor recovery code was invalid.");
  });
});
