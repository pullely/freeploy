// Derived from coollabsio/coolify@91b7e3e:app/Services/ServerTransfer/ServerTransferBundle.php (SCHEMA_VERSION, ID_PATTERN,
// MAX_ITEMS, validate, contentErrors, walk, checkId, items, check, checkDomains, checkComposeDomains, checkPath, checkCron,
// checkStorages, checkScheduledTasks, checkScheduledBackups, checkDatabasePorts) and Laravel's data_get() and blank()
// (Apache-2.0 / MIT), modified.
//
// A server transfer bundle (POST /api/v1/servers/import, DP-111) checked as Coolify checks it before an import writes
// anything: the schema and Coolify versions, the parts every bundle has, every id, the size of every list, and each
// imported value with the rule the normal API applies to it. A bundle is the request's JSON after TrimStrings and
// ConvertEmptyStringsToNull, as PHP decodes it (json_decode(…, true)): an object or a list is a PHP array.
import { validateRules, type Rule } from "../api-v1/rules.js";
import type { Errors } from "../api-v1/request.js";
import { isValidDomainUrl, validateApplicationDomains } from "../applications/domains.js";
import { CONTAINER_NAME_PATTERN, PORT_MAPPINGS_PATTERN } from "../applications/validation.js";
import { phpVersionCompare } from "../databases/urls.js";
import { DOCKER_NETWORK_PATTERN } from "../destinations/validation.js";
import { validateCronExpressionStrict } from "../helpers/cron.js";
import { COOLIFY_VERSION } from "../labels/labels.js";
import { validateShellSafePath } from "../services/compose-helpers.js";

export const SCHEMA_VERSION = 1;

/** ServerTransferBundle::ID_PATTERN ('/\A[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\z/'). */
export const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

/** ServerTransferBundle::MAX_ITEMS: the most items a bundle can have for each list key, summed over the whole bundle. */
export const MAX_ITEMS: Readonly<Record<string, number>> = {
  projects: 1000,
  environments: 5000,
  applications: 5000,
  databases: 5000,
  services: 2000,
  previews: 10000,
  environment_variables: 50000,
  environment_variables_preview: 50000,
  shared_environment_variables: 20000,
  persistent_storages: 20000,
  file_storages: 20000,
  scheduled_tasks: 10000,
  scheduled_backups: 10000,
  volume_backups: 10000,
  tags: 20000,
  resource_links: 10000,
  destinations: 1000,
  private_keys: 1000,
  github_apps: 1000,
  gitlab_apps: 1000,
  gitea_apps: 1000,
  s3_storages: 1000,
  cloud_provider_tokens: 1000,
  integration_tokens: 1000,
  dns_zones: 1000,
  managed_dns_records: 10000,
  ssl_certificates: 10000,
  image_scan_policies: 10000,
  image_scan_ignores: 20000,
  warnings: 1000,
  post_transfer_checklist: 1000,
};

/** What PHP throws where Coolify's code meets a value it cannot handle (a warning Laravel turns into an ErrorException, or a TypeError). */
export class PhpRuntimeError extends Error {}

// ── PHP values ──────────────────────────────────────────────────────────────

/** is_array(): a JSON object or list. */
export const isPhpArray = (v: unknown): v is Record<string, unknown> | unknown[] => Array.isArray(v) || (v !== null && typeof v === "object");

/** The array's entries in order, a list's keys as their index. */
export const phpEntries = (v: Record<string, unknown> | unknown[]): Array<[string, unknown]> => (Array.isArray(v) ? v.map((x, i): [string, unknown] => [String(i), x]) : Object.entries(v));

/** A key PHP stores as an integer (a canonical decimal string): never is_string(). */
const isIntegerKey = (k: string): boolean => /^(0|-?[1-9][0-9]*)$/.test(k);

/** array_is_list() */
function isList(v: Record<string, unknown> | unknown[]): boolean {
  if (Array.isArray(v)) return true;
  return Object.keys(v).every((k, i) => k === String(i));
}

const countOf = (v: Record<string, unknown> | unknown[]): number => (Array.isArray(v) ? v.length : Object.keys(v).length);

/** The value's name in PHP's type errors (zend_zval_value_name()). */
export function phpTypeName(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  if (typeof v === "string") return "string";
  return "array";
}

/** count(): a TypeError for anything that is not an array. */
export function phpCount(v: unknown): number {
  if (!isPhpArray(v)) throw new PhpRuntimeError(`count(): Argument #1 ($value) must be of type Countable|array, ${phpTypeName(v)} given`);
  return countOf(v);
}

/** foreach: a warning (an ErrorException in Laravel) for anything that is not an array. */
export function phpForeach(v: unknown): unknown[] {
  if (!isPhpArray(v)) throw new PhpRuntimeError(`foreach() argument must be of type array|object, ${phpTypeName(v)} given`);
  return phpEntries(v).map(([, x]) => x);
}

/** (string) $value, and a string concatenation: an array is "Array to string conversion". */
export function phpString(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (v === true) return "1";
  if (typeof v === "number" || typeof v === "string") return String(v);
  throw new PhpRuntimeError("Array to string conversion");
}

/** (int) $value */
export function phpInt(v: unknown): number {
  if (v === null || v === undefined || v === false) return 0;
  if (v === true) return 1;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v === "string") {
    const m = /^[ \t\n\r\v\f]*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(v);
    return m ? Math.trunc(Number(m[0].trim())) : 0;
  }
  return countOf(v as Record<string, unknown> | unknown[]) > 0 ? 1 : 0;
}

/** (array) $value: null is empty, a scalar is a one-item list. */
export function phpArrayCast(v: unknown): Record<string, unknown> | unknown[] {
  if (v === null || v === undefined) return [];
  return isPhpArray(v) ? v : [v];
}

/** PHP's truthiness. */
export const phpTruthy = (v: unknown): boolean =>
  !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (isPhpArray(v) && countOf(v) === 0));

/** blank() */
export function blank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "") === "";
  if (typeof v === "number" || typeof v === "boolean") return false;
  return countOf(v as Record<string, unknown> | unknown[]) === 0;
}

const has = (v: unknown, key: string): boolean => isPhpArray(v) && (Array.isArray(v) ? /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < v.length : Object.hasOwn(v, key));
const at = (v: unknown, key: string): unknown => (v as Record<string, unknown>)[key];

/** data_get($target, 'a.b', $default): a key that holds null gives null, a missing one the default. */
export function dataGet(target: unknown, path: string, fallback: unknown = null): unknown {
  let current = target;
  for (const segment of path.split(".")) {
    if (!has(current, segment)) return fallback;
    current = at(current, segment);
  }
  return current;
}

/** `$array['key'] ?? null` */
const field = (v: unknown, key: string): unknown => (has(v, key) ? (at(v, key) ?? null) : null);

/** isset($array['key']) */
const isset = (v: unknown, key: string): boolean => has(v, key) && at(v, key) !== null && at(v, key) !== undefined;

/** preg_match() of a pattern anchored with `$`: PHP's `$` also matches before a final newline. */
const pregMatches = (pattern: RegExp, value: string): boolean => pattern.test(value) || (value.endsWith("\n") && pattern.test(value.slice(0, -1)));

// ── validate() ──────────────────────────────────────────────────────────────

export interface BundleValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** ServerTransferBundle::validate(). */
export async function validateBundle(bundle: Record<string, unknown> | unknown[]): Promise<BundleValidation> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isset(bundle, "schema_version")) errors.push("Missing schema_version.");
  else if (phpInt(at(bundle, "schema_version")) !== SCHEMA_VERSION) errors.push(`Unsupported schema_version ${phpString(at(bundle, "schema_version"))}. Expected ${SCHEMA_VERSION}.`);

  const bundleVersion = dataGet(bundle, "coolify_version");
  if (typeof bundleVersion !== "string" || bundleVersion === "") {
    errors.push(`Missing coolify_version. Export the server again with Coolify ${COOLIFY_VERSION} or newer.`);
  } else if (phpVersionCompare(bundleVersion, COOLIFY_VERSION) > 0) {
    errors.push(`This bundle was exported from Coolify ${bundleVersion}. Upgrade this instance (Coolify ${COOLIFY_VERSION}) to ${bundleVersion} or newer before you import it.`);
  }

  const exportId = field(bundle, "export_id");
  if (typeof exportId !== "string" || exportId === "") errors.push("Missing export_id.");

  const server = field(bundle, "server");
  if (!isPhpArray(server)) errors.push("Missing server payload.");
  else for (const key of ["uuid", "name", "ip", "port", "user"]) if (!has(server, key)) errors.push(`Missing server.${key}.`);

  if (!isPhpArray(field(bundle, "private_key"))) errors.push("Missing private_key payload.");
  else if (blank(dataGet(bundle, "private_key.private_key"))) errors.push("Missing private_key.private_key material.");

  const destinations = field(bundle, "destinations");
  if (!isPhpArray(destinations)) errors.push("Missing destinations array.");
  else if (countOf(destinations) === 0) warnings.push("Bundle has no destinations; a default destination will be used.");

  if (!isPhpArray(field(bundle, "projects"))) errors.push("Missing projects array.");

  errors.push(...(await contentErrors(bundle)));
  return { valid: errors.length === 0, errors, warnings };
}

/** ServerTransferBundle::contentErrors(): every id and list size, then — when they are fine — each imported value. */
export async function contentErrors(bundle: Record<string, unknown> | unknown[]): Promise<string[]> {
  const errors: string[] = [];
  const counts = new Map<string, number>();
  walk(bundle, "", errors, counts);
  for (const [key, count] of counts) {
    if (count > MAX_ITEMS[key]!) errors.push(`The bundle has ${count} ${key}. A bundle can have at most ${MAX_ITEMS[key]} ${key}.`);
  }
  // Stop before the field checks: a bundle with a bad id or too many items is not imported.
  if (errors.length) return errors;

  for (const [i, destination] of items(dataGet(bundle, "destinations"))) {
    await check(errors, `destinations.${i}.network`, field(destination, "network"), ["nullable", "string", "max:255", { regex: DOCKER_NETWORK_PATTERN }]);
  }

  // Only http and https URLs, as for a git source made with the API (the host is not resolved).
  for (const key of ["github_apps", "gitlab_apps", "gitea_apps"]) {
    for (const [i, source] of items(dataGet(bundle, key))) {
      for (const name of ["html_url", "api_url"]) {
        const attribute = `${key}.${i}.${name}`;
        await check(errors, attribute, field(source, name), ["nullable", "string", "url", { closure: (v) => (typeof v === "string" && !isValidDomainUrl(v) ? [`The ${attribute} must use the http or https scheme.`] : []) }]);
      }
    }
  }

  for (const [i, certificate] of items(dataGet(bundle, "ssl_certificates"))) {
    checkPath(errors, `ssl_certificates.${i}.configuration_dir`, field(certificate, "configuration_dir"));
    checkPath(errors, `ssl_certificates.${i}.mount_path`, field(certificate, "mount_path"));
  }

  for (const [i, backup] of items(dataGet(bundle, "volume_backups"))) checkCron(errors, `volume_backups.${i}.frequency`, field(backup, "frequency"));

  for (const [p, project] of items(dataGet(bundle, "projects"))) {
    for (const [e, environment] of items(field(project, "environments"))) {
      const base = `projects.${p}.environments.${e}`;
      for (const [a, application] of items(field(environment, "applications"))) {
        checkDomains(errors, `${base}.applications.${a}.fqdn`, dataGet(application, "attributes.fqdn"));
        checkComposeDomains(errors, `${base}.applications.${a}.docker_compose_domains`, dataGet(application, "attributes.docker_compose_domains"));
        checkStorages(errors, `${base}.applications.${a}`, application);
        await checkScheduledTasks(errors, `${base}.applications.${a}`, application);
        for (const [r, preview] of items(field(application, "previews"))) {
          checkDomains(errors, `${base}.applications.${a}.previews.${r}.fqdn`, field(preview, "fqdn"));
          checkComposeDomains(errors, `${base}.applications.${a}.previews.${r}.docker_compose_domains`, field(preview, "docker_compose_domains"));
          checkStorages(errors, `${base}.applications.${a}.previews.${r}`, preview);
        }
      }
      for (const [d, database] of items(field(environment, "databases"))) {
        await checkDatabasePorts(errors, `${base}.databases.${d}`, phpArrayCast(field(database, "attributes") ?? []));
        checkStorages(errors, `${base}.databases.${d}`, database);
        checkScheduledBackups(errors, `${base}.databases.${d}`, database);
      }
      for (const [s, service] of items(field(environment, "services"))) {
        await checkScheduledTasks(errors, `${base}.services.${s}`, service);
        for (const [a, serviceApplication] of items(field(service, "applications"))) {
          checkDomains(errors, `${base}.services.${s}.applications.${a}.fqdn`, dataGet(serviceApplication, "attributes.fqdn", field(serviceApplication, "fqdn")));
          checkStorages(errors, `${base}.services.${s}.applications.${a}`, serviceApplication);
        }
        for (const [d, serviceDatabase] of items(field(service, "databases"))) {
          checkStorages(errors, `${base}.services.${s}.databases.${d}`, serviceDatabase);
          checkScheduledBackups(errors, `${base}.services.${s}.databases.${d}`, serviceDatabase);
        }
      }
    }
  }
  return errors;
}

/** walk(): checks every `uuid`, `*_uuid` and `*_uuids` value and counts the items of every list key of MAX_ITEMS. */
function walk(node: Record<string, unknown> | unknown[], path: string, errors: string[], counts: Map<string, number>): void {
  for (const [key, value] of phpEntries(node)) {
    const here = path === "" ? key : `${path}.${key}`;
    if (!Array.isArray(node) && !isIntegerKey(key)) {
      if (key === "uuid" || key.endsWith("_uuid")) {
        checkId(errors, here, value);
      } else if (key.endsWith("_uuids")) {
        const list = isPhpArray(value) ? phpEntries(value) : [["0", value] as [string, unknown]];
        for (const [i, id] of list) checkId(errors, `${here}.${i}`, id);
        continue;
      }
      if (Object.hasOwn(MAX_ITEMS, key) && isPhpArray(value)) {
        const n = isList(value) ? countOf(value) : phpEntries(value).reduce((sum, [, list]) => sum + (isPhpArray(list) ? countOf(list) : 0), 0);
        counts.set(key, (counts.get(key) ?? 0) + n);
      }
    }
    if (isPhpArray(value)) walk(value, here, errors, counts);
  }
}

function checkId(errors: string[], where: string, value: unknown): void {
  if (value === null || value === undefined || value === "") return;
  if (typeof value !== "string" || !ID_PATTERN.test(value)) errors.push(`${where} is not a valid id. An id may only contain letters, digits, hyphens, and underscores (at most 64 characters).`);
}

/** items(): the array's items that are arrays themselves, with their keys. */
function items(value: unknown): Array<[string, Record<string, unknown> | unknown[]]> {
  if (!isPhpArray(value)) return [];
  return phpEntries(value).filter((e): e is [string, Record<string, unknown> | unknown[]] => isPhpArray(e[1]));
}

/** check(): Validator::make(['value' => $value], ['value' => $rules], [], ['value' => $at]). */
async function check(errors: string[], where: string, value: unknown, rules: readonly Rule[]): Promise<void> {
  const found: Errors = [];
  await validateRules(found, { value }, [["value", rules]], { laravelMessages: true, attributes: { value: where } });
  for (const [, messages] of found) errors.push(...messages);
}

function checkDomains(errors: string[], where: string, value: unknown): void {
  for (const message of validateApplicationDomains(value)) errors.push(`${where}: ${message}`);
}

function checkComposeDomains(errors: string[], where: string, value: unknown): void {
  let decoded = value;
  if (typeof decoded === "string") {
    try {
      decoded = JSON.parse(decoded) as unknown;
    } catch {
      decoded = null;
    }
  }
  if (!isPhpArray(decoded)) return;
  for (const [service, config] of phpEntries(decoded)) checkDomains(errors, `${where}.${service}.domain`, dataGet(config, "domain"));
}

function checkPath(errors: string[], where: string, value: unknown): void {
  if (value === null || value === undefined || value === "") return;
  if (typeof value !== "string") {
    errors.push(`${where} must be a string.`);
    return;
  }
  try {
    validateShellSafePath(value, where);
  } catch (e) {
    errors.push((e as Error).message);
  }
}

function checkCron(errors: string[], where: string, value: unknown): void {
  if (value === null || value === undefined) return;
  let valid: boolean;
  try {
    valid = typeof value === "string" && validateCronExpressionStrict(value);
  } catch {
    valid = false;
  }
  if (!valid) errors.push(`${where} is not a valid cron expression or frequency.`);
}

function checkStorages(errors: string[], where: string, resource: unknown): void {
  for (const [i, volume] of items(field(resource, "persistent_storages"))) {
    checkPath(errors, `${where}.persistent_storages.${i}.mount_path`, field(volume, "mount_path"));
    checkPath(errors, `${where}.persistent_storages.${i}.host_path`, field(volume, "host_path"));
  }
  for (const [i, storage] of items(field(resource, "file_storages"))) {
    checkPath(errors, `${where}.file_storages.${i}.fs_path`, field(storage, "fs_path"));
    checkPath(errors, `${where}.file_storages.${i}.mount_path`, field(storage, "mount_path"));
  }
}

/** The same checks as the scheduled task API. */
async function checkScheduledTasks(errors: string[], where: string, resource: unknown): Promise<void> {
  for (const [i, task] of items(field(resource, "scheduled_tasks"))) {
    await check(errors, `${where}.scheduled_tasks.${i}.command`, field(task, "command"), ["required", "string"]);
    // ValidationPatterns::containerNameRules()
    await check(errors, `${where}.scheduled_tasks.${i}.container`, field(task, "container"), ["nullable", "string", "max:255", { regex: CONTAINER_NAME_PATTERN }]);
    checkCron(errors, `${where}.scheduled_tasks.${i}.frequency`, field(task, "frequency") ?? "");
    await check(errors, `${where}.scheduled_tasks.${i}.disabled_reason`, field(task, "disabled_reason"), ["nullable", "string", "max:1000"]);
  }
}

function checkScheduledBackups(errors: string[], where: string, database: unknown): void {
  for (const [i, backup] of items(field(database, "scheduled_backups"))) {
    checkCron(errors, `${where}.scheduled_backups.${i}.frequency`, field(backup, "frequency"));
    checkPath(errors, `${where}.scheduled_backups.${i}.databases_to_backup`, field(backup, "databases_to_backup"));
  }
}

const SINGLE_PORT = /^\d+(?:-\d+)?(?:\/(?:tcp|udp|sctp))?$/;

/** checkDatabasePorts(): any public port in 1-65535, and port mappings that are ports (spaces, empty entries and container-only ports allowed). */
async function checkDatabasePorts(errors: string[], where: string, attributes: Record<string, unknown> | unknown[]): Promise<void> {
  if (has(attributes, "public_port")) await check(errors, `${where}.public_port`, at(attributes, "public_port"), ["nullable", "integer", "between:1,65535"]);
  if (!has(attributes, "ports_mappings") || at(attributes, "ports_mappings") === null) return;
  const mappings = at(attributes, "ports_mappings");
  if (typeof mappings !== "string") {
    errors.push(`${where}.ports_mappings must be a string.`);
    return;
  }
  for (const raw of mappings.split(",")) {
    const mapping = raw.replace(/^[ \t]+|[ \t]+$/g, "");
    if (mapping === "" || pregMatches(SINGLE_PORT, mapping) || pregMatches(PORT_MAPPINGS_PATTERN, mapping)) continue;
    errors.push(`${where}.ports_mappings must be a comma-separated list of port mappings (e.g. 5432:5432,127.0.0.1:8080:80/udp).`);
    return;
  }
}
