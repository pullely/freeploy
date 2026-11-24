// The password reset email (freeploy-coolify-parity DP3): Coolify's subject and
// copy (resources/views/emails/reset-password.blade.php), brand swapped.
import { renderEmailTemplate } from "../../../apps/notifications-worker/src/templates/index";

describe("auth.password_reset", () => {
  it("renders Coolify's subject and copy with the link and expiry", () => {
    const r = renderEmailTemplate("auth.password_reset", { url: "https://app.example/reset-password/abc?email=a%40b.c", count: 10 })!;
    expect(r.subject).toBe("Freeploy: Reset Password");
    expect(r.text).toBe(
      "A password reset has been requested for this email address.\n\nClick here (https://app.example/reset-password/abc?email=a%40b.c) to reset your password.\n\nThis link will expire in 10 minutes.",
    );
    expect(r.html).toContain('<a href="https://app.example/reset-password/abc?email=a%40b.c">here</a>');
  });

  it("escapes the link in HTML", () => {
    const r = renderEmailTemplate("auth.password_reset", { url: 'https://x/"><script>', count: 10 })!;
    expect(r.html).not.toContain("<script>");
  });
});

describe("auth.email_verification and auth.email_change", () => {
  it("use Coolify's subjects and copy", () => {
    const v = renderEmailTemplate("auth.email_verification", { url: "https://app.example/email/verify/x/y?expires=1&signature=z" })!;
    expect(v.subject).toBe("Freeploy: Verify your email.");
    expect(v.text).toBe("Verify your email here (https://app.example/email/verify/x/y?expires=1&signature=z).");
    const c = renderEmailTemplate("auth.email_change", { newEmail: "new@example.com", code: "123456", expiryMinutes: 10 })!;
    expect(c.subject).toBe("Freeploy: Verify Your New Email Address");
    expect(c.text).toContain("Verification Code: 123456");
    expect(c.text).toContain("This code is valid for 10 minutes.");
  });
});
