// Email + password sign-in (freeploy-coolify-parity DP3): hashing, Coolify's
// registration rules and their exact messages, and the throttle key helper.
import { webcrypto } from "node:crypto";
import { hashPassword, verifyPassword, isCompromised } from "../../../apps/identity-worker/src/password";
import { validateRegistration, isValidEmail } from "../../../apps/identity-worker/src/password-rules";
import { normalize_email_identity } from "../../../apps/identity-worker/src/email-identity";
import { __ } from "../../../apps/identity-worker/src/laravel-messages";

if (!globalThis.crypto) (globalThis as { crypto: unknown }).crypto = webcrypto;

const never = async () => false;

describe("password hashing", () => {
  it("verifies the right password and rejects a wrong one; never stores the password", async () => {
    const stored = await hashPassword("S3cure-pass!", 1000);
    expect(stored).toMatch(/^pbkdf2-sha256\$1000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(stored).not.toContain("S3cure-pass!");
    expect(await verifyPassword("S3cure-pass!", stored)).toBe(true);
    expect(await verifyPassword("s3cure-pass!", stored)).toBe(false);
    expect(await verifyPassword("anything", "md5$abc")).toBe(false);
  });

  it("defaults to 100,000 iterations, the most Workers' PBKDF2 accepts", async () => {
    expect(await hashPassword("x")).toMatch(/^pbkdf2-sha256\$100000\$/);
  });

  it("salts every hash", async () => {
    expect(await hashPassword("same", 1000)).not.toBe(await hashPassword("same", 1000));
  });

  it("checks the breach range by k-anonymity and fails open like Laravel", async () => {
    // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
    const fake = (async (url: string) => {
      expect(url).toBe("https://api.pwnedpasswords.com/range/5BAA6");
      return new Response("1E4C9B93F3F0682250B6CF8331B7EE68FD8:9999\nABC:1");
    }) as unknown as typeof fetch;
    expect(await isCompromised("password", fake)).toBe(true);
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await isCompromised("password", down)).toBe(false);
  });
});

describe("Coolify registration rules", () => {
  const ok = { name: "Ada", email: "ada@example.com", password: "Str0ng!pass", password_confirmation: "Str0ng!pass" };

  it("accepts a valid registration", async () => {
    expect(await validateRegistration(ok, { emailTaken: never, compromised: never })).toEqual({});
  });

  it("reports an empty field with `required` alone", async () => {
    const e = await validateRegistration({}, { emailTaken: never, compromised: never });
    expect(e).toEqual({
      name: ["The name field is required."],
      email: ["The email field is required."],
      password: ["The password field is required."],
    });
  });

  it("reports every failing password rule in Laravel's order, then confirmation", async () => {
    const e = await validateRegistration({ ...ok, password: "abc", password_confirmation: "x" }, { emailTaken: never, compromised: never });
    expect(e.password).toEqual([
      "The password field must be at least 8 characters.",
      "The password field must contain at least one uppercase and one lowercase letter.",
      "The password field must contain at least one number.",
      "The password field must contain at least one symbol.",
      "The password field confirmation does not match.",
    ]);
  });

  it("asks the breach service only when the other password rules pass", async () => {
    let asked = 0;
    const compromised = async () => {
      asked++;
      return true;
    };
    await validateRegistration({ ...ok, password: "weak", password_confirmation: "weak" }, { emailTaken: never, compromised });
    expect(asked).toBe(0);
    const e = await validateRegistration(ok, { emailTaken: never, compromised });
    expect(asked).toBe(1);
    expect(e.password).toEqual(["The given password has appeared in a data leak. Please choose a different password."]);
  });

  it("rejects a taken or malformed email", async () => {
    const taken = await validateRegistration(ok, { emailTaken: async () => true, compromised: never });
    expect(taken.email).toEqual(["The email has already been taken."]);
    const bad = await validateRegistration({ ...ok, email: "not-an-email" }, { emailTaken: never, compromised: never });
    expect(bad.email).toEqual(["The email field must be a valid email address."]);
    expect(isValidEmail("a.b+c@sub.example.co")).toBe(true);
    expect(isValidEmail("a..b@example.com")).toBe(false);
  });

  it("translates placeholders the way Laravel does", () => {
    expect(__("auth.throttle", { seconds: 42 })).toBe("Too many login attempts. Please try again in 42 seconds.");
    expect(__("validation.max.string", { attribute: "name", max: 255 })).toBe("The name field must not be greater than 255 characters.");
    expect(__("no.such.key")).toBe("no.such.key");
  });
});

describe("normalize_email_identity", () => {
  it("folds Gmail aliases and case, and rejects non-addresses", () => {
    expect(normalize_email_identity("John.Doe+tag@Gmail.com")).toBe("johndoe@gmail.com");
    expect(normalize_email_identity("  User@Example.COM ")).toBe("user@example.com");
    expect(normalize_email_identity("plain")).toBeNull();
    expect(normalize_email_identity(null)).toBeNull();
  });
});
