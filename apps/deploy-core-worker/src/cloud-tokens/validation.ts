// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Security/CloudProviderTokenForm.php and
// app/Livewire/Security/CloudProviderToken/Show.php (rules, messages) (Apache-2.0), modified.
//
// Laravel's validator for the cloud token forms, rule by rule: the components'
// own messages, and Laravel's defaults where they have none. All failing rules
// of a field are reported in rule order (no `bail`); the form shows the first.
import { add, blank, length, type FieldErrors } from "../private-keys/validation.js";
import { LARAVEL } from "../servers/settings-validation.js";
import { CLOUD_PROVIDERS, type CloudProvider } from "./providers.js";

export const CLOUD_TOKEN_VALIDATION_MESSAGES = {
  /** CloudProviderTokenForm::messages() */
  providerRequired: "Please select a cloud provider.",
  providerIn: "Invalid cloud provider selected.",
  tokenRequired: "API token is required.",
  /** CloudProviderTokenForm::messages() and Show::messages() */
  nameRequired: "Token name is required.",
} as const;

/** name: required|string|max:255. */
function nameRules(errors: FieldErrors, value: unknown): void {
  if (blank(value)) return add(errors, "name", CLOUD_TOKEN_VALIDATION_MESSAGES.nameRequired);
  if (typeof value !== "string") return add(errors, "name", LARAVEL.string("name"));
  if (length(value) > 255) add(errors, "name", LARAVEL.maxString("name", 255));
}

/** description: nullable|string|max:1000. */
function descriptionRules(errors: FieldErrors, value: unknown): void {
  if (blank(value)) return;
  if (typeof value !== "string") return add(errors, "description", LARAVEL.string("description"));
  if (length(value) > 1000) add(errors, "description", LARAVEL.maxString("description", 1000));
}

/** trim($this->description ?? ''), null when nothing is left. */
function descriptionValue(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed === "" ? null : trimmed;
}

export interface CreateTokenInput {
  provider: CloudProvider;
  token: string;
  name: string;
  description: string | null;
}

/** CloudProviderTokenForm::rules() with its messages(). */
export function validateCreateToken(body: Record<string, unknown>): { ok: true; input: CreateTokenInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  if (blank(body.provider)) add(errors, "provider", CLOUD_TOKEN_VALIDATION_MESSAGES.providerRequired);
  else {
    if (typeof body.provider !== "string") add(errors, "provider", LARAVEL.string("provider"));
    if (!CLOUD_PROVIDERS.includes(body.provider as CloudProvider)) add(errors, "provider", CLOUD_TOKEN_VALIDATION_MESSAGES.providerIn);
  }
  if (blank(body.token)) add(errors, "token", CLOUD_TOKEN_VALIDATION_MESSAGES.tokenRequired);
  else if (typeof body.token !== "string") add(errors, "token", LARAVEL.string("token"));
  nameRules(errors, body.name);
  descriptionRules(errors, body.description);
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    input: { provider: body.provider as CloudProvider, token: body.token as string, name: body.name as string, description: descriptionValue(body.description) },
  };
}

export interface UpdateTokenInput {
  name: string;
  description: string | null;
}

/** Show::rules() with its messages(). */
export function validateUpdateToken(body: Record<string, unknown>): { ok: true; input: UpdateTokenInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  nameRules(errors, body.name);
  descriptionRules(errors, body.description);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { name: body.name as string, description: descriptionValue(body.description) } };
}
