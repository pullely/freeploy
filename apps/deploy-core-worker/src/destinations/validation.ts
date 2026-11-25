// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Destination/Show.php and
// app/Livewire/Destination/New/Docker.php (the #[Validate] rules) and
// app/Support/ValidationPatterns.php (DOCKER_NETWORK_PATTERN) (Apache-2.0), modified.
//
// Laravel's validator for the destination forms, rule by rule, with Laravel's
// default messages (the Livewire property is the attribute). A blank value
// skips every rule but `required`.
import { add, blank, length, MESSAGES, type FieldErrors } from "../private-keys/validation.js";

/**
 * ValidationPatterns::DOCKER_NETWORK_PATTERN. PCRE's `$` also matches before a
 * final newline, which Livewire trims away before validating; here such a
 * name is simply invalid.
 */
export const DOCKER_NETWORK_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const DESTINATION_VALIDATION_MESSAGES = {
  nameRequired: MESSAGES.required("name"),
  nameString: MESSAGES.string("name"),
  /** Not a rule of Coolify's: see nameRules(). */
  nameMax: "The name field must not be greater than 255 characters.",
  networkRequired: MESSAGES.required("network"),
  networkString: MESSAGES.string("network"),
  networkMax: "The network field must not be greater than 255 characters.",
  networkRegex: "The network field format is invalid.",
} as const;

/**
 * Show and New/Docker: ['string', 'required'] on name. Coolify has no length
 * rule and lets a name over 255 characters fail in the database (VARCHAR(255))
 * as a raw SQL error toast; here it is a validation error in Laravel's words.
 */
function nameRules(errors: FieldErrors, value: unknown): void {
  if (blank(value)) return add(errors, "name", DESTINATION_VALIDATION_MESSAGES.nameRequired);
  if (typeof value !== "string") return add(errors, "name", DESTINATION_VALIDATION_MESSAGES.nameString);
  if (length(value) > 255) add(errors, "name", DESTINATION_VALIDATION_MESSAGES.nameMax);
}

/** New/Docker: required|string|max:255|regex:DOCKER_NETWORK_PATTERN on network. */
function networkRules(errors: FieldErrors, value: unknown): void {
  if (blank(value)) return add(errors, "network", DESTINATION_VALIDATION_MESSAGES.networkRequired);
  if (typeof value !== "string") return add(errors, "network", DESTINATION_VALIDATION_MESSAGES.networkString);
  if (length(value) > 255) add(errors, "network", DESTINATION_VALIDATION_MESSAGES.networkMax);
  if (!DOCKER_NETWORK_PATTERN.test(value)) add(errors, "network", DESTINATION_VALIDATION_MESSAGES.networkRegex);
}

export interface UpdateDestinationInput {
  name: string;
}

/** Show::submit() → validate(). */
export function validateUpdateDestination(body: Record<string, unknown>): { ok: true; input: UpdateDestinationInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  nameRules(errors, body.name);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { name: body.name as string } };
}

export interface NewDestinationInput {
  name: string;
  network: string;
}

/** New/Docker::submit() → validate(). The server (serverId) is the route's. */
export function validateNewDestination(body: Record<string, unknown>): { ok: true; input: NewDestinationInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  nameRules(errors, body.name);
  networkRules(errors, body.network);
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { name: body.name as string, network: body.network as string } };
}
