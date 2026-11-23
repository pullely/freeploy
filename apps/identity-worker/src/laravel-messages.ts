// Laravel's English messages that Coolify's auth pages show (lang/en/{auth,
// passwords,validation}.php from the framework, as Coolify@91b7e3e ships them).
// `__()` reproduces Laravel's translator for these keys, including :attribute,
// :Attribute and :ATTRIBUTE replacement. Registered as the `__` port in
// tools/parity/commands/ports.ts, so every message is checked byte for byte
// against the reference's own output (tools/parity/commands/goldens.json).
const MESSAGES: Record<string, string> = {
  "auth.failed": "These credentials do not match our records.",
  "auth.password": "The provided password is incorrect.",
  "auth.throttle": "Too many login attempts. Please try again in :seconds seconds.",
  "passwords.reset": "Your password has been reset.",
  // Coolify overrides both with one message, so an address's existence is not revealed.
  "passwords.sent": "If an account exists with this email address, you will receive a password reset link shortly.",
  "passwords.throttled": "Please wait before retrying.",
  "passwords.token": "This password reset token is invalid.",
  "passwords.user": "If an account exists with this email address, you will receive a password reset link shortly.",
  "validation.required": "The :attribute field is required.",
  "validation.string": "The :attribute field must be a string.",
  "validation.email": "The :attribute field must be a valid email address.",
  "validation.max.string": "The :attribute field must not be greater than :max characters.",
  "validation.min.string": "The :attribute field must be at least :min characters.",
  "validation.unique": "The :attribute has already been taken.",
  "validation.confirmed": "The :attribute field confirmation does not match.",
  "validation.password.letters": "The :attribute field must contain at least one letter.",
  "validation.password.mixed": "The :attribute field must contain at least one uppercase and one lowercase letter.",
  "validation.password.numbers": "The :attribute field must contain at least one number.",
  "validation.password.symbols": "The :attribute field must contain at least one symbol.",
  "validation.password.uncompromised": "The given :attribute has appeared in a data leak. Please choose a different :attribute.",
};

const ucfirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Laravel's __(): look the key up, then replace placeholders longest-first. */
export function __(key: string, replace: Record<string, string | number> = {}): string {
  let line = MESSAGES[key] ?? key;
  const entries = Object.entries(replace).sort((a, b) => b[0].length - a[0].length);
  for (const [k, v] of entries) {
    const value = String(v);
    line = line
      .split(`:${ucfirst(k)}`)
      .join(ucfirst(value))
      .split(`:${k.toUpperCase()}`)
      .join(value.toUpperCase())
      .split(`:${k}`)
      .join(value);
  }
  return line;
}
