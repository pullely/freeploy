// Which auth routes are brute-force targets (tight `auth` limit) and which are
// a signed-in user's own account (ordinary `account` limit).
import { rateLimitFamilyFor } from "@api-edge/auth-facade";

describe("rateLimitFamilyFor", () => {
  it("keeps every step that checks a secret in `auth`", () => {
    for (const p of ["/v1/auth/password/login", "/v1/auth/password/register", "/v1/auth/password/forgot", "/v1/auth/password/reset", "/v1/auth/password/confirm", "/v1/auth/password/change", "/v1/auth/two-factor/challenge", "/v1/auth/two-factor/confirm", "/v1/auth/passkeys/login", "/v1/auth/email/change/verify", "/v1/auth/account", "/v1/auth/oauth/github/start"]) {
      expect(rateLimitFamilyFor(p)).toBe("auth");
    }
  });

  it("gives account reads and settings the ordinary cap", () => {
    for (const p of ["/v1/auth/session", "/v1/auth/profile", "/v1/auth/two-factor", "/v1/auth/passkeys", "/v1/auth/email/change", "/v1/auth/account/deletion", "/v1/auth/avatar"]) {
      expect(rateLimitFamilyFor(p)).toBe("account");
    }
  });
});
