// Password reset (freeploy-coolify-parity DP3): Fortify's field rules and
// Laravel's messages on the paths that answer before the database is touched.
import { handlePasswordForgot, handlePasswordReset } from "../../../apps/identity-worker/src/handlers/password-reset";
import type { Env } from "../../../apps/identity-worker/src/env";

const env = { ENVIRONMENT: "test" } as unknown as Env;
const post = (path: string, body: unknown) =>
  new Request(`https://identity.internal${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const fields = async (res: Response) => ((await res.json()) as { error: { details: { fields: Record<string, string[]> } } }).error.details.fields;

describe("POST /v1/auth/password/forgot", () => {
  it("requires an email", async () => {
    const res = await handlePasswordForgot(post("/v1/auth/password/forgot", {}), env, "req_1");
    expect(res.status).toBe(422);
    expect(await fields(res)).toEqual({ email: ["The email field is required."] });
  });

  it("rejects a malformed email", async () => {
    const res = await handlePasswordForgot(post("/v1/auth/password/forgot", { email: "nope" }), env, "req_1");
    expect(await fields(res)).toEqual({ email: ["The email field must be a valid email address."] });
  });

  it("refuses to send a link without a configured console URL (never from the request)", async () => {
    const res = await handlePasswordForgot(post("/v1/auth/password/forgot", { email: "a@example.com" }), { ...env, PLATFORM_DB: {} } as unknown as Env, "req_1");
    expect(res.status).toBe(503);
  });
});

describe("POST /v1/auth/password/reset", () => {
  it("requires the token and a valid email", async () => {
    const res = await handlePasswordReset(post("/v1/auth/password/reset", { email: "x" }), env, "req_1");
    expect(await fields(res)).toEqual({
      token: ["The token field is required."],
      email: ["The email field must be a valid email address."],
    });
  });
});
