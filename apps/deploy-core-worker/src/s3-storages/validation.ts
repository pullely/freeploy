// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Storage/{Create,Form}.php (rules, messages,
// validationAttributes, normalizeEndpoint), app/Models/S3Storage.php (connectionRules),
// app/Rules/ValidS3BucketName.php and app/Support/ValidationPatterns.php (Apache-2.0), modified.
//
// Laravel's validator for the New Storage form and a storage's General form,
// for the S3 type, rule by rule with the components' messages and attribute
// names. All failing rules of a field are reported in rule order (no
// `bail`); a blank value skips every rule but `required`.
// tests/deploy-core-worker/fixtures/s3/goldens.json holds what Laravel answers.
import { add, blank, DESCRIPTION_PATTERN, length, MESSAGES as PATTERN_MESSAGES, NAME_PATTERN, type FieldErrors } from "../private-keys/validation.js";
import { parseUrl, safeUrlError, type HostResolver } from "./safe-url.js";

/** BackupStorageType: only S3 is offered (see the status note). */
export const STORAGE_TYPES = ["s3", "sftp", "ftps", "webdav"] as const;
export type StorageType = (typeof STORAGE_TYPES)[number];

/** ValidationPatterns::S3_BUCKET_NAME_PATTERN */
const S3_BUCKET_NAME_PATTERN = /^(?=.{3,63}$)[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/;

/** ValidationPatterns::isValidS3BucketName() */
export function validS3BucketName(value: unknown): boolean {
  if (typeof value !== "string" || !S3_BUCKET_NAME_PATTERN.test(value)) return false;
  if (value.includes("..") || value.includes(".-") || value.includes("-.")) return false;
  return !/^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.test(value) || value.split(".").some((p) => Number(p) > 255);
}

/** ValidS3BucketName's message for an attribute. */
export const BUCKET_NAME_MESSAGE = (attribute: string) =>
  `The ${attribute} must be a valid S3 bucket name: 3-63 letters, numbers, dots, or hyphens; start and end with a letter or number; no consecutive dots, dot-hyphen pairs, or IP address format.`;

export const STORAGE_MESSAGES = {
  /** Create::messages() / Form::messages() for S3 */
  regionRequired: "The Region field is required.",
  regionMax: "The Region may not be greater than 255 characters.",
  keyRequired: "The Access Key field is required.",
  keyMax: "The Access Key may not be greater than 255 characters.",
  secretRequired: "The Secret Key field is required.",
  secretMax: "The Secret Key may not be greater than 255 characters.",
  bucketRequired: "The Bucket field is required.",
  endpointRequired: "The Endpoint field is required.",
  endpointMax: "The Endpoint may not be greater than 255 characters.",
  /** connectionRules()'s closure */
  endpointCredentials: "The Endpoint must not contain a username or password. Enter the credentials in their own fields.",
  endpointControl: "The Endpoint path must not contain control characters.",
  /** Laravel's defaults, with the components' attribute names */
  nameRequired: "The Name field is required.",
  typeRequired: "The type field is required.",
  typeInvalid: "The selected type is invalid.",
  string: (attribute: string) => `The ${attribute} field must be a string.`,
  boolean: (attribute: string) => `The ${attribute} field must be true or false.`,
} as const;

/** Create::normalizeEndpoint(): a scheme where none is given, and a DigitalOcean Spaces bucket host reduced to its region. */
export function normalizeEndpoint(endpoint: string): string {
  let e = endpoint.trim();
  if (!/^(?:https?:|[a-z][a-z0-9+.-]*:\/\/)/i.test(e)) e = "https://" + e;
  if (e.includes("digitaloceanspaces.com")) {
    const host = parseUrl(e)?.host ?? "";
    const m = /^(.+)\.([^.]+\.digitaloceanspaces\.com)$/.exec(host);
    if (m) return `https://${m[2]}`;
  }
  return e;
}

function nameRules(errors: FieldErrors, value: unknown, required: boolean): void {
  if (blank(value)) {
    if (required) add(errors, "name", STORAGE_MESSAGES.nameRequired);
    return;
  }
  if (typeof value !== "string") return add(errors, "name", STORAGE_MESSAGES.string("Name"));
  if (length(value) < 3) add(errors, "name", PATTERN_MESSAGES.nameMin(3));
  if (length(value) > 255) add(errors, "name", PATTERN_MESSAGES.nameMax(255));
  if (!NAME_PATTERN.test(value)) add(errors, "name", PATTERN_MESSAGES.nameRegex);
}

function descriptionRules(errors: FieldErrors, value: unknown): void {
  if (blank(value)) return;
  if (typeof value !== "string") return add(errors, "description", STORAGE_MESSAGES.string("Description"));
  if (length(value) > 255) add(errors, "description", PATTERN_MESSAGES.descriptionMax(255));
  if (!DESCRIPTION_PATTERN.test(value)) add(errors, "description", PATTERN_MESSAGES.descriptionRegex);
}

/** required|string|max:255 with the component's messages. */
function stringRules(errors: FieldErrors, field: string, value: unknown, attribute: string, requiredMessage: string | null, maxMessage: string): void {
  if (blank(value)) {
    if (requiredMessage) add(errors, field, requiredMessage);
    return;
  }
  if (typeof value !== "string") return add(errors, field, STORAGE_MESSAGES.string(attribute));
  if (length(value) > 255) add(errors, field, maxMessage);
}

/** connectionRules(S3)['endpoint']: required|string|max:255, the credentials and control-character closure, SafeWebhookUrl. */
async function endpointRules(errors: FieldErrors, value: unknown, savedEndpoint: string | null, resolve: HostResolver): Promise<void> {
  if (blank(value)) return add(errors, "endpoint", STORAGE_MESSAGES.endpointRequired);
  if (typeof value !== "string") return add(errors, "endpoint", STORAGE_MESSAGES.string("Endpoint"));
  if (length(value) > 255) add(errors, "endpoint", STORAGE_MESSAGES.endpointMax);
  const parts = parseUrl(value.trim()) ?? {};
  if ((parts.user !== undefined || parts.pass !== undefined) && value.trim() !== (savedEndpoint ?? "").trim()) add(errors, "endpoint", STORAGE_MESSAGES.endpointCredentials);
  let path = parts.path ?? "";
  try {
    path = decodeURIComponent(path.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"));
  } catch {
    /* rawurldecode() leaves what it cannot decode */
  }
  if (/[\x00-\x1f\x7f]/.test(path)) add(errors, "endpoint", STORAGE_MESSAGES.endpointControl);
  const unsafe = await safeUrlError(value, "Endpoint", "endpoint", resolve);
  if (unsafe) add(errors, "endpoint", unsafe);
}

function bucketRules(errors: FieldErrors, value: unknown): void {
  if (blank(value)) return add(errors, "bucket", STORAGE_MESSAGES.bucketRequired);
  if (!validS3BucketName(value)) add(errors, "bucket", BUCKET_NAME_MESSAGE("Bucket"));
}

function booleanRule(errors: FieldErrors, field: string, value: unknown, attribute: string, nullable = false): void {
  if (value === undefined || (nullable && value === null)) return;
  if (![true, false, 0, 1, "0", "1"].includes(value as never)) add(errors, field, STORAGE_MESSAGES.boolean(attribute));
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const bool = (v: unknown, fallback: boolean): boolean => (v === undefined || v === null ? fallback : v === true || v === 1 || v === "1");

export interface StorageInput {
  name: string | null;
  description: string | null;
  endpoint: string;
  bucket: string;
  region: string;
  key: string;
  /** The secret from the form; "" keeps the saved one (update). */
  secret: string;
  usePathStyleEndpoint: boolean;
  skipTlsVerification: boolean;
}

type Result<T> = { ok: true; input: T } | { ok: false; errors: FieldErrors };

/** Create::submit(): normalizeEndpoint(), then rules() with messages() and validationAttributes(). */
export async function validateCreateStorage(body: Record<string, unknown>, resolve: HostResolver): Promise<Result<StorageInput & { type: StorageType }>> {
  const errors: FieldErrors = {};
  const type = body.type ?? "s3";
  if (blank(type)) add(errors, "type", STORAGE_MESSAGES.typeRequired);
  else if (!STORAGE_TYPES.includes(type as StorageType)) add(errors, "type", STORAGE_MESSAGES.typeInvalid);
  nameRules(errors, body.name, true);
  descriptionRules(errors, body.description);
  const endpoint = typeof body.endpoint === "string" || body.endpoint === undefined || body.endpoint === null ? normalizeEndpoint(text(body.endpoint)) : body.endpoint;
  await endpointRules(errors, endpoint, null, resolve);
  bucketRules(errors, body.bucket);
  stringRules(errors, "region", body.region ?? "us-east-1", "Region", STORAGE_MESSAGES.regionRequired, STORAGE_MESSAGES.regionMax);
  stringRules(errors, "key", body.key, "Key", STORAGE_MESSAGES.keyRequired, STORAGE_MESSAGES.keyMax);
  stringRules(errors, "secret", body.secret, "Secret", STORAGE_MESSAGES.secretRequired, STORAGE_MESSAGES.secretMax);
  booleanRule(errors, "usePathStyleEndpoint", body.usePathStyleEndpoint, "Use path-style URLs");
  booleanRule(errors, "skipTlsVerification", body.skipTlsVerification, "Skip TLS certificate verification");
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      type: type as StorageType,
      name: text(body.name),
      description: typeof body.description === "string" ? body.description : null,
      endpoint: endpoint as string,
      bucket: text(body.bucket),
      region: text(body.region ?? "us-east-1"),
      key: text(body.key),
      secret: text(body.secret),
      usePathStyleEndpoint: bool(body.usePathStyleEndpoint, true),
      skipTlsVerification: bool(body.skipTlsVerification, false),
    },
  };
}

/** Form::rules() with messages() and validationAttributes(): a saved secret makes the secret optional. */
export async function validateUpdateStorage(
  body: Record<string, unknown>,
  saved: { endpoint: string | null; hasSavedSecret: boolean },
  resolve: HostResolver,
): Promise<Result<StorageInput & { isUsable: boolean | null }>> {
  const errors: FieldErrors = {};
  booleanRule(errors, "isUsable", body.isUsable, "Is Usable", true);
  nameRules(errors, body.name, false);
  descriptionRules(errors, body.description);
  await endpointRules(errors, body.endpoint, saved.endpoint, resolve);
  bucketRules(errors, body.bucket);
  stringRules(errors, "region", body.region, "Region", STORAGE_MESSAGES.regionRequired, STORAGE_MESSAGES.regionMax);
  stringRules(errors, "key", body.key, "Key", STORAGE_MESSAGES.keyRequired, STORAGE_MESSAGES.keyMax);
  stringRules(errors, "secret", body.secret, "Secret", saved.hasSavedSecret ? null : STORAGE_MESSAGES.secretRequired, STORAGE_MESSAGES.secretMax);
  booleanRule(errors, "usePathStyleEndpoint", body.usePathStyleEndpoint, "Use path-style URLs");
  booleanRule(errors, "skipTlsVerification", body.skipTlsVerification, "Skip TLS certificate verification");
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    input: {
      isUsable: body.isUsable === undefined || body.isUsable === null ? null : bool(body.isUsable, false),
      name: typeof body.name === "string" ? body.name : null,
      description: typeof body.description === "string" ? body.description : null,
      endpoint: text(body.endpoint),
      bucket: text(body.bucket),
      region: text(body.region),
      key: text(body.key),
      secret: text(body.secret),
      usePathStyleEndpoint: bool(body.usePathStyleEndpoint, true),
      skipTlsVerification: bool(body.skipTlsVerification, false),
    },
  };
}
