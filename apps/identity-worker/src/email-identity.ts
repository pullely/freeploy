// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/email.php (Apache-2.0), modified.
// normalize_email_identity(): the key Coolify throttles sign-in and
// registration by, so Gmail's "+tag" and dot aliases count as one person.
// Registered as a command-golden port (tools/parity/commands/ports.ts).
export function normalize_email_identity(email: string | null | undefined): string | null {
  if (email === null || email === undefined || email.trim() === "" || !email.includes("@")) return null;
  const lower = email.trim().toLowerCase();
  const at = lower.indexOf("@");
  let local = lower.slice(0, at);
  const domain = lower.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const plus = local.indexOf("+");
    if (plus !== -1) local = local.slice(0, plus);
    local = local.split(".").join("");
  }
  if (local.trim() === "" || domain.trim() === "") return null;
  return `${local}@${domain}`;
}
