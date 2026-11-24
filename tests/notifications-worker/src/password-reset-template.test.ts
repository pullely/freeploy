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
