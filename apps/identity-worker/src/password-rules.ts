// Derived from coollabsio/coolify@91b7e3e:app/Actions/Fortify/CreateNewUser.php and
// app/Providers/AppServiceProvider.php (Password::defaults) (Apache-2.0), modified.
//
// Coolify's registration rules, evaluated in Laravel's order so the messages
// (and their order in `$errors->all()`) match:
//   name     required | string | max:255
//   email    required | string | email | max:255 | unique:users
//   password required | Password::min(8)->mixedCase()->letters()->numbers()->symbols()->uncompromised() | confirmed
// Laravel reports every failing rule of an attribute, except that an empty
// value fails `required` alone.
import { __ } from "./laravel-messages.js";

export interface RegistrationInput {
  name?: unknown;
  email?: unknown;
  password?: unknown;
  password_confirmation?: unknown;
}

/** Laravel's default `email` rule (RFC validation), approximated for the shapes it accepts in practice. */
export function isValidEmail(v: string): boolean {
  if (v.length > 254 || /\s/.test(v)) return false;
  const at = v.lastIndexOf("@");
  if (at < 1 || at === v.length - 1) return false;
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/.test(domain);
}

export async function validateRegistration(
  input: RegistrationInput,
  checks: { emailTaken: (emailLower: string) => Promise<boolean>; compromised: (password: string) => Promise<boolean> },
): Promise<Record<string, string[]>> {
  const errors: Record<string, string[]> = {};
  const add = (field: string, message: string) => (errors[field] ??= []).push(message);
  const filled = (v: unknown) => typeof v === "string" ? v.trim() !== "" : v !== undefined && v !== null;

  // name
  if (!filled(input.name)) add("name", __("validation.required", { attribute: "name" }));
  else {
    if (typeof input.name !== "string") add("name", __("validation.string", { attribute: "name" }));
    else if (input.name.length > 255) add("name", __("validation.max.string", { attribute: "name", max: 255 }));
  }

  // email
  if (!filled(input.email)) add("email", __("validation.required", { attribute: "email" }));
  else if (typeof input.email !== "string") add("email", __("validation.string", { attribute: "email" }));
  else {
    if (!isValidEmail(input.email)) add("email", __("validation.email", { attribute: "email" }));
    if (input.email.length > 255) add("email", __("validation.max.string", { attribute: "email", max: 255 }));
    if (await checks.emailTaken(input.email.toLowerCase())) add("email", __("validation.unique", { attribute: "email" }));
  }

  // password
  if (!filled(input.password)) add("password", __("validation.required", { attribute: "password" }));
  else {
    const p = String(input.password);
    if (p.length < 8) add("password", __("validation.min.string", { attribute: "password", min: 8 }));
    if (!/\p{Lu}/u.test(p) || !/\p{Ll}/u.test(p)) add("password", __("validation.password.mixed", { attribute: "password" }));
    if (!/\p{L}/u.test(p)) add("password", __("validation.password.letters", { attribute: "password" }));
    if (!/\p{N}/u.test(p)) add("password", __("validation.password.numbers", { attribute: "password" }));
    if (!/\p{Z}|\p{S}|\p{P}/u.test(p)) add("password", __("validation.password.symbols", { attribute: "password" }));
    // Laravel only asks the breach service when every other password rule passed.
    if (!errors.password?.length && (await checks.compromised(p))) add("password", __("validation.password.uncompromised", { attribute: "password" }));
    if (input.password_confirmation !== input.password) add("password", __("validation.confirmed", { attribute: "password" }));
  }
  return errors;
}
