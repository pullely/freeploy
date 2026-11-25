// Derived from coollabsio/coolify@91b7e3e:app/Support/ValidationPatterns.php (DB_IDENTIFIER_PATTERN, DB_PASSWORD_PATTERN,
// databaseIdentifierRules, databasePasswordRules and their messages, portMappingRules),
// app/Livewire/Project/Database/{Postgresql,Redis,Mysql,Mariadb,Mongodb,Keydb,Dragonfly,Clickhouse}/General.php (the
// typed properties, rules(), messages(), $validationAttributes; save_new_init_script's rules) and
// bootstrap/helpers/shared.php (validateFilenameSafe) (Apache-2.0), modified.
//
// Laravel's validator for a database's General form, rule by rule, for every
// engine: the rules are the same but for each engine's credentials, which
// come from its spec (engines.ts). What the validator sees in Coolify is the
// component's typed properties, so a value is first coerced as PHP coerces it
// for the property (12345 is "12345" in a string property); a value the
// property cannot hold (null in a `string`, a list anywhere) never reaches
// the validator there — Livewire fails on it — and is refused here with
// Laravel's `string` / `boolean` message. All failing rules of a field are
// reported in rule order (no `bail`); a blank value skips every rule but
// `required`.
import type { DatabaseEngine } from "@saas/db/deploy";
import { add, blank, descriptionRules, length, nameRules, type FieldErrors } from "../private-keys/validation.js";
import { LARAVEL } from "../servers/settings-validation.js";
import { APPLICATION_MESSAGES, PORT_MAPPINGS_PATTERN } from "../applications/validation.js";
import { StoragePathError, validateShellSafePath } from "../applications/storage-paths.js";
import { DATABASE_ENGINE_SPECS, isDatabaseEngine, type DatabaseEngineSpec, type DatabaseField } from "./engines.js";

/**
 * ValidationPatterns::DB_IDENTIFIER_PATTERN and DB_PASSWORD_PATTERN. PCRE's
 * `$` also matches before a final newline, so "user\n" passes in Coolify; the
 * optional "\n" keeps that.
 */
export const DB_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,62}\n?$/;
export const DB_PASSWORD_PATTERN = /^[A-Za-z0-9!@#%^*()_+\-=[\]{}:,.?/~]+\n?$/;

export const DATABASE_MESSAGES = {
  /** General::messages() */
  imageRequired: "The Docker Image field is required.",
  publicPortInteger: "The Public Port must be an integer.",
  publicPortMin: "The Public Port must be at least 1.",
  publicPortMax: "The Public Port must not exceed 65535.",
  publicPortTimeoutInteger: "The Public Port Timeout must be an integer.",
  publicPortTimeoutMin: "The Public Port Timeout must be at least 1.",
  /** ValidationPatterns::portMappingMessages() */
  portsMappingsRegex: APPLICATION_MESSAGES.portsMappingsRegex,
  /** ValidationPatterns::databaseIdentifierMessages() and databasePasswordMessages() */
  identifierRegex: (label: string) => `The ${label} may only contain letters, digits, and underscores, and must start with a letter or underscore.`,
  passwordRegex: (label: string) => `The ${label} may not contain shell-unsafe characters (backtick, $, ;, |, &, <, >, \\, quotes, spaces, or control characters).`,
  credentialMax: (label: string, max: number) => `The ${label} may not be greater than ${max} characters.`,
  /** Laravel's default `required`, with $validationAttributes' name. */
  required: (attribute: string) => `The ${attribute} field is required.`,
} as const;

type Body = Record<string, unknown>;
type Result<T> = { ok: true; input: T } | { ok: false; errors: FieldErrors };

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

export interface CreateDatabaseInput {
  engine: DatabaseEngine;
  projectUuid: string;
  environmentUuid: string;
  /** Optional: when given, the destination must be one of this server's. */
  serverUuid: string | null;
  destinationUuid: string | null;
  /** Select::setDatabaseImage(): the image of the PostgreSQL or Redis / Valkey step; null for every other engine. */
  databaseImage: string | null;
}

/**
 * What Resource\Create reads before it creates a database: the route's
 * project and environment, and the query string's type, destination, server
 * and — for PostgreSQL and Redis, which ask for an image first — the image.
 * Coolify has no validator here: an unknown type falls back to the type
 * picker, a missing image to the image step. As an API, both are refused.
 */
export function validateCreateDatabase(body: Body): Result<CreateDatabaseInput> {
  const errors: FieldErrors = {};
  if (!isDatabaseEngine(body.type)) add(errors, "type", LARAVEL.in("type"));
  for (const field of ["project_uuid", "environment_uuid"] as const) {
    if (blank(body[field])) add(errors, field, `The ${field.replace("_", " ")} field is required.`);
    else if (typeof body[field] !== "string" || !UUID_RE.test(body[field])) add(errors, field, `The selected ${field.replace("_", " ")} is invalid.`);
  }
  let databaseImage: string | null = null;
  if (isDatabaseEngine(body.type) && DATABASE_ENGINE_SPECS[body.type].imageStep) {
    if (blank(body.database_image)) add(errors, "database_image", "The database image field is required.");
    else if (typeof body.database_image !== "string") add(errors, "database_image", "The database image field must be a string.");
    else if (length(body.database_image) > 255) add(errors, "database_image", "The database image field must not be greater than 255 characters.");
    else databaseImage = body.database_image;
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const uuid = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return {
    ok: true,
    input: {
      engine: body.type as DatabaseEngine,
      projectUuid: body.project_uuid as string,
      environmentUuid: body.environment_uuid as string,
      serverUuid: uuid(body.server_id) ?? uuid(body.server_uuid),
      destinationUuid: uuid(body.destination) ?? uuid(body.destination_uuid),
      databaseImage,
    },
  };
}

/** What PHP makes of a value assigned to a `string` or `?string` property (no strict types); undefined for a value it refuses. */
function coerceString(value: unknown, nullable: boolean): string | null | undefined {
  if (typeof value === "string") return value;
  if (value === null) return nullable ? null : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "1" : "";
  return undefined;
}

/** What PHP makes of a value assigned to a `bool` or `?bool` property; undefined for a value it refuses. */
export function coerceBoolean(value: unknown, nullable: boolean): boolean | null | undefined {
  if (typeof value === "boolean") return value;
  if (value === null) return nullable ? null : undefined;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "" && value !== "0";
  return undefined;
}

/** filter_var($value, FILTER_VALIDATE_INT): Laravel's `integer`. The integer, or null when the value is not one. */
function filterInt(value: unknown): number | null {
  if (typeof value === "boolean") return value ? 1 : null;
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/^[ \t\n\r\v\0]+|[ \t\n\r\v\0]+$/g, "");
  if (!/^[+-]?(?:0|[1-9][0-9]*)$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/** Laravel's size of a value under a numeric rule: the number when is_numeric(), else the string's length. */
function numericSize(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^[ \t\n\r\v\f]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(value)) return Number(value);
  return length(String(value === true ? "1" : value === false ? "" : value));
}

/**
 * 'nullable|integer|min:1[|max:n]' for a `mixed` property. Returns what
 * syncData() stores — `$this->publicPort ?: null` — or undefined when a rule
 * failed.
 */
function integerRules(errors: FieldErrors, field: string, value: unknown, messages: { integer: string; min: string; max?: string }, max?: number): number | null | undefined {
  // `nullable`, and a blank string, skip the rules.
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  if (typeof value === "object") {
    add(errors, field, messages.integer);
    return undefined;
  }
  const before = errors[field]?.length ?? 0;
  const integer = filterInt(value);
  if (integer === null) add(errors, field, messages.integer);
  const size = numericSize(value);
  if (size < 1) add(errors, field, messages.min);
  if (max !== undefined && messages.max && size > max) add(errors, field, messages.max);
  if ((errors[field]?.length ?? 0) > before) return undefined;
  return integer === 0 ? null : integer;
}

/** The stored credentials the rules compare the input with: by property. */
export type StoredCredentials = Readonly<Record<string, string | null>>;

export interface GeneralValidationContext {
  /** The stored value of each identifier and password property (a Redis credential is its variable's value). */
  stored: StoredCredentials;
  /** StandaloneRedis::isCredentialLocked(): the password is then only 'nullable'. */
  credentialLocked?: boolean;
}

/**
 * General's fields, as the model's columns take them. A field the body leaves
 * out is undefined: it keeps its stored value (Livewire always sends every
 * property; this API is a PATCH).
 */
export interface DatabaseGeneralInput {
  name?: string;
  description?: string | null;
  image?: string;
  portsMappings?: string | null;
  isPublic?: boolean | null;
  publicPort?: number | null;
  publicPortTimeout?: number | null;
  isLogDrainEnabled?: boolean;
  customDockerRunOptions?: string | null;
  /** The engine's own properties: credentials and free text. */
  fields: Record<string, string | null>;
}

/** Laravel's `string` message for a value the typed property cannot hold. */
const notAString = (attribute: string): string => `The ${attribute} field must be a string.`;

function credentialRules(errors: FieldErrors, field: DatabaseField, value: string | null, ctx: GeneralValidationContext): void {
  const { property } = field;
  const label = field.label ?? property;
  const nullable = field.kind === "password" && ctx.credentialLocked === true && field.variable === "REDIS_PASSWORD";
  if (nullable) return;
  if (blank(value)) return add(errors, property, DATABASE_MESSAGES.required(field.attribute));
  const text = value as string;
  const max = field.kind === "identifier" ? 63 : 128;
  if (length(text) > max) add(errors, property, DATABASE_MESSAGES.credentialMax(label, max));
  // enforcePattern: only a value that differs from the stored one is held to the pattern, so legacy values stay editable.
  if (text !== (ctx.stored[property] ?? null)) {
    if (field.kind === "identifier" && !DB_IDENTIFIER_PATTERN.test(text)) add(errors, property, DATABASE_MESSAGES.identifierRegex(label));
    if (field.kind === "password" && !DB_PASSWORD_PATTERN.test(text)) add(errors, property, DATABASE_MESSAGES.passwordRegex(label));
  }
}

/**
 * General::validate() with rules() and messages(), for the properties the
 * body gives. The values are checked as given: what submit() does to the port
 * mappings first (spaces removed) is the caller's part.
 */
export function validateDatabaseGeneral(spec: DatabaseEngineSpec, body: Body, ctx: GeneralValidationContext): Result<DatabaseGeneralInput> {
  const errors: FieldErrors = {};
  const input: DatabaseGeneralInput = { fields: {} };
  const has = (field: string): boolean => body[field] !== undefined;

  if (has("name")) {
    const name = coerceString(body.name, false);
    if (name === undefined || name === null) add(errors, "name", notAString("name"));
    else {
      nameRules(errors, name, spec.nameRequired);
      input.name = name;
    }
  }
  if (has("description")) {
    const description = coerceString(body.description, true);
    if (description === undefined) add(errors, "description", notAString("description"));
    else {
      descriptionRules(errors, description);
      input.description = description;
    }
  }
  if (has("image")) {
    const image = coerceString(body.image, false);
    if (image === undefined || image === null) add(errors, "image", notAString("image"));
    else if (blank(image)) add(errors, "image", DATABASE_MESSAGES.imageRequired);
    else input.image = image;
  }
  if (has("portsMappings")) {
    const mappings = coerceString(body.portsMappings, true);
    if (mappings === undefined) add(errors, "portsMappings", notAString("portsMappings"));
    else {
      // ValidationPatterns::portMappingRules(): nullable|string|regex (the pattern's `$` allows a final newline).
      if (!blank(mappings) && !PORT_MAPPINGS_PATTERN.test((mappings as string).replace(/\n$/, ""))) add(errors, "portsMappings", DATABASE_MESSAGES.portsMappingsRegex);
      input.portsMappings = mappings;
    }
  }
  if (has("isPublic")) {
    const isPublic = coerceBoolean(body.isPublic, true);
    if (isPublic === undefined) add(errors, "isPublic", LARAVEL.boolean("isPublic"));
    else input.isPublic = isPublic;
  }
  if (has("publicPort")) {
    const port = integerRules(errors, "publicPort", body.publicPort, { integer: DATABASE_MESSAGES.publicPortInteger, min: DATABASE_MESSAGES.publicPortMin, max: DATABASE_MESSAGES.publicPortMax }, 65535);
    if (port !== undefined) input.publicPort = port;
  }
  if (has("publicPortTimeout")) {
    const timeout = integerRules(errors, "publicPortTimeout", body.publicPortTimeout, { integer: DATABASE_MESSAGES.publicPortTimeoutInteger, min: DATABASE_MESSAGES.publicPortTimeoutMin });
    if (timeout !== undefined) input.publicPortTimeout = timeout;
  }
  if (has("isLogDrainEnabled")) {
    const enabled = coerceBoolean(body.isLogDrainEnabled, false);
    if (enabled === undefined || enabled === null) add(errors, "isLogDrainEnabled", LARAVEL.boolean("isLogDrainEnabled"));
    else input.isLogDrainEnabled = enabled;
  }
  if (has("customDockerRunOptions")) {
    const options = coerceString(body.customDockerRunOptions, true);
    if (options === undefined) add(errors, "customDockerRunOptions", notAString("customDockerRunOptions"));
    else input.customDockerRunOptions = options;
  }
  // $initScripts is #[Locked] and ?array: the form never sends it; the init script routes change it.
  if (has("initScripts") && body.initScripts !== null && !Array.isArray(body.initScripts)) add(errors, "initScripts", "The init scripts field must be an array.");

  for (const field of spec.fields) {
    if (!has(field.property)) continue;
    // Every credential is a `string` property but Redis's password (?string); free text is ?string.
    const nullable = field.kind === "text" || field.variable === "REDIS_PASSWORD";
    const value = coerceString(body[field.property], nullable);
    if (value === undefined) {
      add(errors, field.property, notAString(field.attribute));
      continue;
    }
    if (field.kind !== "text") credentialRules(errors, field, value, ctx);
    input.fields[field.property] = value;
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, input };
}

/** validateFilenameSafe()'s refusal: the message is shown as it is. */
export class FilenameError extends Error {}

const EXPANSION: ReadonlyArray<[string, string]> = [
  [" ", "whitespace"],
  ["*", "glob wildcard"],
  ["?", "glob wildcard"],
  ["[", "glob character class"],
  ["]", "glob character class"],
  ["~", "tilde expansion"],
  ['"', "double quote"],
  ["'", "single quote"],
];

/**
 * validateFilenameSafe(): a single path component without shell
 * metacharacters, NUL bytes, separators, "..", or anything a shell expands.
 */
export function validateFilenameSafe(input: string, context = "filename"): string {
  try {
    validateShellSafePath(input, context);
  } catch (e) {
    if (e instanceof StoragePathError) throw new FilenameError(e.message);
    throw e;
  }
  if (input.includes("\0")) throw new FilenameError(`Invalid ${context}: contains null byte. Null bytes are not allowed in filenames for security reasons.`);
  if (input.includes("/") || input.includes("\\")) throw new FilenameError(`Invalid ${context}: directory separators ('/' or '\\') are not allowed. Provide a plain filename without path components.`);
  if (input.includes("..")) throw new FilenameError(`Invalid ${context}: parent directory sequence ('..') is not allowed.`);
  for (const [char, description] of EXPANSION) {
    if (input.includes(char)) throw new FilenameError(`Invalid ${context}: contains forbidden character '${char}' (${description}).`);
  }
  return input;
}

export interface InitScriptInput {
  filename: string;
  content: string;
}

/** save_new_init_script(): 'new_filename' => 'required|string', 'new_content' => 'required|string' (Laravel's default messages). */
export function validateNewInitScript(body: Body): Result<InitScriptInput> {
  const errors: FieldErrors = {};
  const read = (field: "new_filename" | "new_content"): string => {
    const value = coerceString(body[field], false);
    if (value === undefined || blank(value)) add(errors, field, value === undefined && body[field] !== null && body[field] !== undefined ? LARAVEL.string(field).replace("_", " ") : LARAVEL.required(field).replace("_", " "));
    return value ?? "";
  };
  const filename = read("new_filename");
  const content = read("new_content");
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, input: { filename, content } };
}
