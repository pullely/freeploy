// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Service/StackForm.php (rules, messages,
// syncData, saveCompose, submit, instantSave), app/Livewire/Project/Service/EditCompose.php
// (saveEditedCompose, instantSave), app/Support/ValidationPatterns.php (nameRules, descriptionRules,
// combinedMessages) and Illuminate\Validation\ValidationException::summarize (Apache-2.0), modified.
//
// A service's General page as plain operations on its rows in memory (store.ts): what "Save" and the
// "Edit Compose file" dialog's "Save changes" do — StackForm::submit(): the rules, then the name,
// description, Compose file and network setting, the template's fields written to their variables, and the
// Compose file parsed again (parser.ts) on the rows already stored, so that its parts, variables and volumes
// are reconciled, not duplicated. The caller loads the rows, runs this, and writes them back in one
// transaction; a refusal leaves the rows as they were.
import { descriptionRules, nameRules, MESSAGES, type FieldErrors } from "../private-keys/validation.js";
import { ComposeError } from "./compose-helpers.js";
import { validateDockerComposeForInjection } from "./compose-validation.js";
import { lockedFieldKeys, saveExtraFields, stackFormFields, validateField, type StackFormField } from "./extra-fields.js";
import { parseService, type ServiceParserContext } from "./parser.js";
import type { ServiceStore } from "./store.js";

export const STACK_FORM_MESSAGES = {
  /** StackForm::messages() */
  nameRequired: "The Name field is required.",
  dockerComposeRawRequired: "The Docker Compose Raw field is required.",
  /** StackForm::submit() */
  saved: "Service saved.",
  /** StackForm::instantSave() */
  settingsSaved: "Service settings saved.",
  /** EditCompose::instantSave() */
  updated: "Service updated successfully",
} as const;

/** What the form sends: the fields' values by variable key; a field left out keeps the value the page loaded. */
export interface StackFormInput {
  name?: unknown;
  description?: unknown;
  dockerComposeRaw?: unknown;
  connectToDockerNetwork?: unknown;
  fields?: unknown;
}

/** A refusal: Coolify's toast (for a validation error ValidationException's summary) and the messages per field. */
export class StackFormError extends Error {
  constructor(
    message: string,
    readonly fields: FieldErrors = {},
  ) {
    super(message);
  }
}

/** ValidationException::summarize(): the first message, and how many more there are. */
export function summarize(errors: FieldErrors): string {
  const messages = Object.values(errors).flat();
  const first = messages.shift() ?? "";
  if (messages.length === 0) return first;
  return `${first} (and ${messages.length} more ${messages.length === 1 ? "error" : "errors"})`;
}

/** Livewire's binding of a text input: a number arrives as its text, anything that is not a string or null is refused by the rules. */
const asText = (value: unknown): unknown => (typeof value === "number" && Number.isFinite(value) ? String(value) : value);

export interface StackFormOptions {
  parser: ServiceParserContext;
  /** @can('manageEnvironment', $service): the fields are written to their variables. */
  canManageEnvironment: boolean;
  /** services.description as stored (the rows in memory do not carry it). */
  description: string | null;
}

export interface StackFormSaved {
  message: string;
  /** What services.description is to hold. */
  description: string | null;
  /** docker_compose_raw changed: Coolify then asks Docker Compose on the server to accept the file. */
  isComposeChanged: boolean;
  /** Service::composeVolumeWarnings() of the parse. */
  warnings: string[];
}

/**
 * StackForm::submit() on the service's rows. `fields` are the fields the page loaded (mount()), with the
 * values the form sends. Throws StackFormError with what Coolify shows; on success the rows are changed.
 */
export function submitStackForm(store: ServiceStore, input: StackFormInput, options: StackFormOptions): StackFormSaved {
  const service = store.service;
  const loaded = stackFormFields(store, !options.canManageEnvironment);
  const sent = input.fields !== null && typeof input.fields === "object" ? (input.fields as Record<string, unknown>) : {};
  const fields: (StackFormField & { sent: unknown })[] = loaded.map((field) => ({ ...field, sent: Object.hasOwn(sent, field.key) ? asText(sent[field.key]) : field.value }));
  const name = input.name === undefined ? service.name : asText(input.name);
  const description = input.description === undefined ? options.description : asText(input.description);
  const raw = input.dockerComposeRaw === undefined ? service.docker_compose_raw : asText(input.dockerComposeRaw);
  const connect = input.connectToDockerNetwork === undefined ? service.connect_to_docker_network : input.connectToDockerNetwork;

  // $this->validate(): the rules in their order, then each field that is not locked.
  const errors: FieldErrors = {};
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) (errors.dockerComposeRaw ??= []).push(STACK_FORM_MESSAGES.dockerComposeRawRequired);
  nameRules(errors, name, STACK_FORM_MESSAGES.nameRequired);
  descriptionRules(errors, description);
  for (const field of fields) if (!field.isLocked) validateField(errors, field, field.sent);
  if (typeof raw !== "string" && !errors.dockerComposeRaw) (errors.dockerComposeRaw ??= []).push(MESSAGES.string("docker compose raw"));
  if (Object.keys(errors).length > 0) throw new StackFormError(summarize(errors), errors);

  // syncData(true)
  const isComposeChanged = raw !== service.docker_compose_raw;
  // Validate for command injection BEFORE any database operations.
  try {
    validateDockerComposeForInjection(raw as string);
  } catch (error) {
    if (error instanceof ComposeError) throw new StackFormError(error.message);
    throw error;
  }
  service.name = name as string;
  service.docker_compose_raw = raw as string;
  service.connect_to_docker_network = connect === true || connect === "true" || connect === 1 || connect === "1";
  if (options.canManageEnvironment) {
    const locked = lockedFieldKeys(store);
    saveExtraFields(
      store,
      fields.filter((field) => !locked.includes(field.key)).map((field) => ({ key: field.key, value: field.sent === null || field.sent === undefined ? null : String(field.sent) })),
    );
  }
  let warnings: string[];
  try {
    warnings = parseService(store, options.parser).warnings;
  } catch (error) {
    if (error instanceof ComposeError) throw new StackFormError(error.message);
    throw error;
  }
  return { message: STACK_FORM_MESSAGES.saved, description: typeof description === "string" ? description : null, isComposeChanged, warnings };
}
