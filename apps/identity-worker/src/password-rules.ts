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
  const pw = await passwordErrors(input.password, input.password_confirmation, "password", checks.compromised);
  if (pw.length) errors.password = pw;
  return errors;
}


/**
 * Password::defaults() + confirmed on one field, with the field's name as
 * Laravel shows it ("new_password" → "new password"): every failing rule in
 * Laravel's order, `required` alone when empty, the breach check only when
 * the other rules pass, then the confirmation.
 */
export async function passwordErrors(
  value: unknown,
  confirmation: unknown,
  field: string,
  compromised: (password: string) => Promise<boolean>,
): Promise<string[]> {
  const attribute = field.replace(/_/g, " ");
  if (typeof value !== "string" || value.trim() === "") return [__("validation.required", { attribute })];
  const out: string[] = [];
  if (value.length < 8) out.push(__("validation.min.string", { attribute, min: 8 }));
  if (!/\p{Lu}/u.test(value) || !/\p{Ll}/u.test(value)) out.push(__("validation.password.mixed", { attribute }));
  if (!/\p{L}/u.test(value)) out.push(__("validation.password.letters", { attribute }));
  if (!/\p{N}/u.test(value)) out.push(__("validation.password.numbers", { attribute }));
  if (!/\p{Z}|\p{S}|\p{P}/u.test(value)) out.push(__("validation.password.symbols", { attribute }));
  if (!out.length && (await compromised(value))) out.push(__("validation.password.uncompromised", { attribute }));
  if (confirmation !== value) out.push(__("validation.confirmed", { attribute }));
  return out;
}
