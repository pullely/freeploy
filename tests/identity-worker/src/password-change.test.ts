// Changing the password from /profile (freeploy-coolify-parity DP3): Coolify's
// rules and Laravel's messages for current_password and new_password.
import { webcrypto } from "node:crypto";
import { handlePasswordChange, passwordChangeErrors } from "../../../apps/identity-worker/src/handlers/password-change";
import type { Env } from "../../../apps/identity-worker/src/env";

if (!globalThis.crypto) (globalThis as { crypto: unknown }).crypto = webcrypto;
const never = async () => false;

describe("passwordChangeErrors", () => {
  it("reports empty fields with `required` alone, named as Laravel names them", async () => {
    expect(await passwordChangeErrors({}, never)).toEqual({
      current_password: ["The current password field is required."],
      new_password: ["The new password field is required."],
    });
  });

  it("reports every failing rule of the new password, then the confirmation", async () => {
    const e = await passwordChangeErrors({ current_password: "x", new_password: "abc", new_password_confirmation: "y" }, never);
    expect(e.new_password).toEqual([
      "The new password field must be at least 8 characters.",
      "The new password field must contain at least one uppercase and one lowercase letter.",
      "The new password field must contain at least one number.",
      "The new password field must contain at least one symbol.",
      "The new password field confirmation does not match.",
    ]);
  });

  it("accepts a valid change", async () => {
    expect(await passwordChangeErrors({ current_password: "x", new_password: "Str0ng!pass", new_password_confirmation: "Str0ng!pass" }, never)).toEqual({});
  });
});

describe("POST /v1/auth/password/change", () => {
  it("needs a session", async () => {
    const res = await handlePasswordChange(new Request("https://identity.internal/v1/auth/password/change", { method: "POST", body: "{}" }), { ENVIRONMENT: "test" } as unknown as Env, "req_1");
    expect(res.status).toBe(401);
  });
});
