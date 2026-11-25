// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/DockerRegistries/Login.php (login, targetServers)
// and app/Services/DockerRegistryLogins.php (REGISTRY_PATTERN) (Apache-2.0), modified.
//
// Laravel's validator for the registry login form, rule by rule: the
// component's own messages, and Laravel's defaults where it has none (the
// Livewire property is the attribute). All failing rules of a field are
// reported in rule order (no `bail`), a message only once (MessageBag); a
// blank value skips every rule but `required`.
import { add, blank, length, type FieldErrors } from "../private-keys/validation.js";
import { LARAVEL } from "../servers/settings-validation.js";
import { normalizeRegistry, providerPreset, REGISTRY_PATTERN, type RegistryProvider } from "./logins.js";

export const REGISTRY_VALIDATION_MESSAGES = {
  /** Login::targetServers() */
  serversRequired: "Choose at least one server.",
  serversArray: "The selected servers field must be an array.",
  /** Login::login() */
  registryRegex: "Enter a registry host, for example ghcr.io or registry.example.com:5000.",
  registryHost: (preset: RegistryProvider) => `Enter a valid ${preset.label} host, for example ${preset.placeholder}. Choose Other for a different registry.`,
  usernameRegex: "The username must not contain spaces.",
} as const;

/** /^[^\s]+$/ with PCRE's \s (no UCP). PCRE's `$` also matches before a final newline; here such a username is simply invalid. */
const NO_WHITESPACE = /^[^ \t\n\x0B\f\r]+$/;

/**
 * targetServers(): ['required', 'array', 'min:1'] on selectedServers, with
 * "Choose at least one server." for `required` (an empty list fails it, so
 * `min:1` never reports). The uuids, without repeats.
 */
export function validateSelectedServers(value: unknown): { ok: true; uuids: string[] } | { ok: false; errors: FieldErrors } {
  if (blank(value) || (Array.isArray(value) && value.length === 0)) return { ok: false, errors: { selectedServers: [REGISTRY_VALIDATION_MESSAGES.serversRequired] } };
  if (!Array.isArray(value)) return { ok: false, errors: { selectedServers: [REGISTRY_VALIDATION_MESSAGES.serversArray] } };
  return { ok: true, uuids: [...new Set(value.map((v) => String(v)))] };
}

export interface RegistryLoginInput {
  /** The normalized registry host. */
  registry: string;
  username: string;
  password: string;
  /** Whether this replaces an existing login (Login::$editRegistry). */
  edit: boolean;
}

/**
 * Login::login() → validate(). The registry is the edited login's, else the
 * provider's fixed host, else the typed host normalized; a provider with a
 * host pattern also checks the typed host against it (not when editing), and
 * both `regex` rules then share the provider's message.
 */
export function validateRegistryLogin(body: Record<string, unknown>): { ok: true; input: RegistryLoginInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const preset = providerPreset(body.provider);
  const edit = typeof body.editRegistry === "string" && body.editRegistry !== "" ? normalizeRegistry(body.editRegistry) : null;
  const registry = edit ?? (preset.registry !== "" ? preset.registry : typeof body.registry === "string" ? normalizeRegistry(body.registry) : body.registry);
  const hostPattern = edit === null ? preset.hostPattern : undefined;
  const regexMessage = hostPattern ? REGISTRY_VALIDATION_MESSAGES.registryHost(preset) : REGISTRY_VALIDATION_MESSAGES.registryRegex;

  if (blank(registry)) add(errors, "registry", LARAVEL.required("registry"));
  else if (typeof registry !== "string") add(errors, "registry", LARAVEL.string("registry"));
  else {
    if (length(registry) > 255) add(errors, "registry", LARAVEL.maxString("registry", 255));
    if (!REGISTRY_PATTERN.test(registry) || (hostPattern && !hostPattern.test(registry))) add(errors, "registry", regexMessage);
  }

  const username = body.username;
  if (blank(username)) add(errors, "username", LARAVEL.required("username"));
  else if (typeof username !== "string") add(errors, "username", LARAVEL.string("username"));
  else {
    if (length(username) > 255) add(errors, "username", LARAVEL.maxString("username", 255));
    if (!NO_WHITESPACE.test(username)) add(errors, "username", REGISTRY_VALIDATION_MESSAGES.usernameRegex);
  }

  const password = body.password;
  if (blank(password)) add(errors, "password", LARAVEL.required("password"));
  else if (typeof password !== "string") add(errors, "password", LARAVEL.string("password"));
  else if (length(password) > 20000) add(errors, "password", LARAVEL.maxString("password", 20000));

  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { registry: registry as string, username: username as string, password: password as string, edit: edit !== null } };
}
