// Derived from coollabsio/coolify@91b7e3e:app/Models/Service.php (extraFields, isGrafanaServerImage,
// saveExtraFields), app/Livewire/Project/Service/StackForm.php (mount, lockedFieldKeys, rules, messages,
// validationAttributes) and app/Models/EnvironmentVariable.php (the value mutator and the saving hook)
// (Apache-2.0), modified.
//
// The "Service configuration" section of a service's General page: the values a template exposes as form
// fields (an admin password, a database name, a public URL …), found by the images of the service's parts
// and the keys of its environment variables, exactly as Service::extraFields() finds them — including its
// quirks: the Supabase (kong) case falls through into MinIO's, Vaultwarden's fields are a collection and so
// never resolve a "$SERVICE_…" reference, and a field whose variable does not exist has no key. Over the
// parser's in-memory rows (store.ts), so that a save runs it on the same rows the parser reads.
import { parseDockerImage } from "../applications/docker-image.js";
import { isSharedReference } from "../environment-variables/references.js";
import { withoutEdgeLineBreaks } from "../environment-variables/env-format.js";
import { ENVIRONMENT_VARIABLE_VERSION } from "../environment-variables/service.js";
import { normalizeEnvironmentVariableKey, validatedEnvironmentVariableKey } from "../environment-variables/validation.js";
import { isUrl } from "../servers/validation.js";
import type { FieldErrors } from "../private-keys/validation.js";
import type { ServiceEnvironmentVariableRow, ServiceStore } from "./store.js";

/** One field as extraFields() builds it. */
export interface ExtraField {
  key: string | null;
  value: string | null;
  rules?: string;
  isPassword?: boolean;
  customHelper?: string;
  sortOrder?: number;
  isLocked?: boolean;
}

/** One template's fields by label; `collection` marks Vaultwarden's, which extraFields() leaves as a Collection. */
interface Group {
  fields: Map<string, ExtraField>;
  collection: boolean;
}

/** The value accessor: '' and null read as null; a single-line value loses its edge line breaks. */
const readValue = (row: ServiceEnvironmentVariableRow | undefined): string | null => (row && row.value !== null && row.value !== "" ? withoutEdgeLineBreaks(row.value) : null);

/** Str::before(':') */
const beforeColon = (image: string | null): string => {
  const value = image ?? "";
  const index = value.indexOf(":");
  return index === -1 ? value : value.slice(0, index);
};

/** isGrafanaServerImage() */
function isGrafanaServerImage(image: string | null): boolean {
  const parsed = parseDockerImage(image ?? "");
  let name = parsed.imageName;
  // The parser recognizes registry hosts with dots or ports, but not bare localhost.
  if (parsed.registryUrl === "" && name.startsWith("localhost/")) name = name.slice("localhost/".length);
  return ["grafana/grafana", "grafana/grafana-oss", "grafana/grafana-enterprise"].includes(name);
}

/** Service::extraFields(): the template fields of every application, then of every database, by label. */
export function serviceExtraFields(store: ServiceStore): Map<string, Group> {
  const variables = store.environmentVariables();
  /** $this->environment_variables()->where('key', …)->first() (and whereIn: the first of any of the keys). */
  const env = (...keys: string[]): ServiceEnvironmentVariableRow | undefined => variables.find((row) => keys.includes(row.key));
  /** [key, value] of a field from a variable that may not exist: data_get() answers null (or the default). */
  const of = (row: ServiceEnvironmentVariableRow | undefined, fallback: string | null = null): { key: string | null; value: string | null } => ({ key: row?.key ?? null, value: row ? (readValue(row) ?? fallback) : fallback });
  const fields = new Map<string, Group>();
  const put = (label: string, data: Map<string, ExtraField>, collection = false) => fields.set(label, { fields: data, collection });
  const required = (row: ServiceEnvironmentVariableRow | undefined, extra: Partial<ExtraField> = {}): ExtraField => ({ ...of(row), rules: "required", ...extra });
  const password = (row: ServiceEnvironmentVariableRow | undefined): ExtraField => ({ ...of(row), rules: "required", isPassword: true });
  /** Fields that exist only when their variable does: [label, variable, field]. */
  const optional = (data: Map<string, ExtraField>, entries: [string, ServiceEnvironmentVariableRow | undefined, (row: ServiceEnvironmentVariableRow) => ExtraField][]) => {
    for (const [label, row, field] of entries) if (row) data.set(label, field(row));
    return data;
  };

  for (const application of store.applications()) {
    const image = beforeColon(application.image);
    if (image === "") continue;
    const data = new Map<string, ExtraField>();
    const which = applicationCase(image, application.image);
    if (which === "drizzle-team/gateway") {
      data.set("Master Password", password(env("SERVICE_PASSWORD_DRIZZLE")));
      put("Drizzle", data);
    } else if (which === "castopod") {
      const disable = env("CP_DISABLE_HTTPS");
      if (disable) data.set("Disable HTTPS", { key: "CP_DISABLE_HTTPS", value: readValue(disable), rules: "required", customHelper: "If you want to use https, set this to 0. Variable name: CP_DISABLE_HTTPS" });
      put("Castopod", data);
    } else if (which === "label-studio") {
      const username = env("LABEL_STUDIO_USERNAME");
      if (username) data.set("Username", { key: "LABEL_STUDIO_USERNAME", value: readValue(username), rules: "required" });
      optional(data, [["Password", env("SERVICE_PASSWORD_LABELSTUDIO"), password]]);
      put("Label Studio", data);
    } else if (which === "litellm") {
      optional(data, [
        ["Username", env("SERVICE_USER_UI"), (row) => required(row)],
        ["Password", env("SERVICE_PASSWORD_UI"), password],
      ]);
      put("Litellm", data);
    } else if (which === "langfuse") {
      optional(data, [
        ["Admin Email", env("LANGFUSE_INIT_USER_EMAIL"), (row) => ({ ...of(row), rules: "required|email" })],
        ["Admin Password", env("SERVICE_PASSWORD_LANGFUSE"), password],
      ]);
      put("Langfuse", data);
    } else if (which === "invoiceninja") {
      data.set("Email", { ...of(env("IN_USER_EMAIL")), rules: "required|email" });
      data.set("Password", password(env("SERVICE_PASSWORD_INVOICENINJAUSER")));
      put("Invoice Ninja", data);
    } else if (which === "argilla") {
      const apiKey = env("SERVICE_PASSWORD_APIKEY");
      data.set("API Key", { ...of(apiKey), isPassword: true, rules: "required" });
      data.set("Username", required(env("ARGILLA_USERNAME")));
      data.set("Password", password(env("SERVICE_PASSWORD_ARGILLA")));
      put("Argilla", data);
    } else if (which === "rabbitmq") {
      optional(data, [
        ["Host Port Binding", env("PORT"), (row) => required(row)],
        ["Username", env("SERVICE_USER_RABBITMQ"), (row) => required(row)],
        ["Password", env("SERVICE_PASSWORD_RABBITMQ"), password],
      ]);
      put("RabbitMQ", data);
    } else if (which === "registry") {
      optional(data, [
        ["Registry User", env("SERVICE_USER_REGISTRY"), (row) => required(row)],
        ["Registry Password", env("SERVICE_PASSWORD_REGISTRY"), password],
      ]);
      put("Docker Registry", data);
    } else if (which === "tolgee") {
      data.set("Admin User", { key: "TOLGEE_AUTHENTICATION_INITIAL_USERNAME", value: "admin", rules: "required" });
      optional(data, [["Admin Password", env("SERVICE_PASSWORD_TOLGEE"), password]]);
      put("Tolgee", data);
    } else if (which === "logto") {
      optional(data, [
        ["Endpoint", env("LOGTO_ENDPOINT"), (row) => ({ ...of(row), rules: "required|url" })],
        ["Admin Endpoint", env("LOGTO_ADMIN_ENDPOINT"), (row) => ({ ...of(row), rules: "required|url" })],
      ]);
      put("Logto", data);
    } else if (which === "unleash-server") {
      data.set("Admin User", { key: "SERVICE_USER_UNLEASH", value: "admin", rules: "required" });
      optional(data, [["Admin Password", env("SERVICE_PASSWORD_UNLEASH"), password]]);
      put("Unleash", data);
    } else if (which === "grafana") {
      data.set("Admin User", { key: "GF_SECURITY_ADMIN_USER", value: "admin", rules: "required" });
      optional(data, [["Admin Password", env("SERVICE_PASSWORD_GRAFANA"), password]]);
      put("Grafana", data);
    } else if (which === "elasticsearch") {
      optional(data, [["Password (default user: elastic)", env("SERVICE_PASSWORD_ELASTICSEARCH"), password]]);
      put("Elasticsearch", data);
    } else if (which === "directus") {
      optional(data, [
        ["Admin Email", env("ADMIN_EMAIL"), (row) => ({ ...of(row), rules: "required|email" })],
        ["Admin Password", env("SERVICE_PASSWORD_ADMIN"), password],
      ]);
      put("Directus", data);
    } else if (which === "kong") {
      optional(data, [
        ["Dashboard User", env("SERVICE_USER_ADMIN"), (row) => required(row)],
        ["Dashboard Password", env("SERVICE_PASSWORD_ADMIN"), password],
      ]);
      put("Supabase", data);
    }
    // The kong case has no `break`: MinIO's case runs after it.
    if (which === "kong" || which === "minio") {
      const minio = new Map<string, ExtraField>();
      optional(minio, [
        ["Console URL", env("MINIO_BROWSER_REDIRECT_URL"), (row) => ({ ...of(row), rules: "required|url" })],
        ["S3 API URL", env("MINIO_SERVER_URL"), (row) => ({ ...of(row), rules: "required|url" })],
        ["Admin User", env("SERVICE_USER_MINIO") ?? env("MINIO_ROOT_USER"), (row) => required(row)],
        ["Admin Password", env("SERVICE_PASSWORD_MINIO") ?? env("MINIO_ROOT_PASSWORD"), password],
      ]);
      put("MinIO", minio);
    } else if (which === "garage") {
      optional(data, [
        ["S3 API URL", env("GARAGE_S3_API_URL"), (row) => ({ ...of(row), rules: "required|url" })],
        ["Web URL", env("GARAGE_WEB_URL"), (row) => ({ ...of(row), rules: "required|url" })],
        ["Admin URL", env("GARAGE_ADMIN_URL"), (row) => ({ ...of(row), rules: "required|url" })],
        ["Admin Token", env("GARAGE_ADMIN_TOKEN") ?? env("SERVICE_PASSWORD_GARAGE"), password],
        ["RPC Secret", env("GARAGE_RPC_SECRET") ?? env("SERVICE_HEX_64_RPCSECRET") ?? env("SERVICE_HEX_32_RPCSECRET"), password],
        ["Metrics Token", env("GARAGE_METRICS_TOKEN") ?? env("SERVICE_PASSWORD_GARAGEMETRICS"), password],
      ]);
      put("Garage", data);
    } else if (which === "weblate") {
      optional(data, [
        ["Admin Email", env("WEBLATE_ADMIN_EMAIL"), (row) => ({ ...of(row), rules: "required|email" })],
        ["Admin Password", env("SERVICE_PASSWORD_WEBLATE"), password],
      ]);
      put("Weblate", data);
    } else if (which === "meilisearch") {
      optional(data, [["API Key", env("SERVICE_PASSWORD_MEILISEARCH"), (row) => ({ ...of(row), isPassword: true })]]);
      put("Meilisearch", data);
    } else if (which === "linkding") {
      optional(data, [
        ["Superuser Name", env("SERVICE_USER_LINKDING"), (row) => of(row)],
        ["Superuser Password", env("SERVICE_PASSWORD_LINKDING"), (row) => ({ ...of(row), isPassword: true })],
      ]);
      put("Linkding", data);
    } else if (which === "ghost") {
      optional(data, [
        ["Mail Password", env("MAIL_OPTIONS_AUTH_PASS"), (row) => ({ ...of(row), isPassword: true })],
        ["Mail User", env("MAIL_OPTIONS_AUTH_USER"), (row) => of(row)],
        ["Mail Secure", env("MAIL_OPTIONS_SECURE"), (row) => of(row)],
        ["Mail Port", env("MAIL_OPTIONS_PORT"), (row) => of(row)],
        ["Mail Service", env("MAIL_OPTIONS_SERVICE"), (row) => of(row)],
        ["Mail Host", env("MAIL_OPTIONS_HOST"), (row) => of(row)],
      ]);
      put("Ghost", data);
    } else if (which === "vaultwarden") {
      optional(data, [
        ["Database URL", env("DATABASE_URL"), (row) => of(row)],
        ["Admin Password", env("SERVICE_PASSWORD_64_ADMIN"), (row) => ({ ...of(row), isPassword: true })],
        ["Signup Allowed", env("SIGNUP_ALLOWED"), (row) => ({ ...of(row), rules: "required|string|in:true,false" })],
        ["Push Enabled", env("PUSH_ENABLED"), (row) => ({ ...of(row), rules: "required|string|in:true,false" })],
        ["Push Installation ID", env("PUSH_SERVICE_ID"), (row) => of(row)],
        ["Push Installation Key", env("PUSH_SERVICE_KEY"), (row) => ({ ...of(row), isPassword: true })],
      ]);
      // put('Vaultwarden', $data): a Collection, not an array.
      put("Vaultwarden", data, true);
    } else if (which === "gitlab/gitlab") {
      optional(data, [["Root Password", env("SERVICE_PASSWORD_GITLAB"), password]]);
      data.set("Root User", { key: "GITLAB_ROOT_USER", value: "root", rules: "required", isPassword: true });
      put("GitLab", data);
    } else if (which === "code-server") {
      optional(data, [
        ["Password", env("SERVICE_PASSWORD_64_PASSWORDCODESERVER"), password],
        ["Sudo Password", env("SERVICE_PASSWORD_SUDOCODESERVER"), password],
      ]);
      put("Code Server", data);
    } else if (which === "elestio/strapi") {
      optional(data, [
        ["License", env("STRAPI_LICENSE"), (row) => of(row)],
        ["Node Environment", env("NODE_ENV"), (row) => of(row)],
      ]);
      put("Strapi", data);
    } else if (which === "marckohlbrugge/sessy") {
      optional(data, [
        ["HTTP Auth Username", env("SERVICE_USER_SESSY"), (row) => required(row)],
        ["HTTP Auth Password", env("SERVICE_PASSWORD_SESSY"), password],
      ]);
      put("Sessy", data);
    } else if (which === "coollabsio/openclaw") {
      optional(data, [
        ["Username", env("SERVICE_USER_OPENCLAW"), (row) => of(row)],
        ["Password", env("SERVICE_PASSWORD_OPENCLAW"), (row) => ({ ...of(row), isPassword: true })],
        ["Gateway Token", env("SERVICE_PASSWORD_64_GATEWAYTOKEN"), (row) => ({ ...of(row), isPassword: true })],
      ]);
      put("Openclaw", data);
    } else if (which === "coollabsio/jean-server") {
      const settings: [string, Omit<ExtraField, "value">][] = [
        ["Token", { key: "SERVICE_PASSWORD_64_JEAN", rules: "required", isPassword: true, sortOrder: 1, customHelper: "Token required to access Jean Server. Variable name: SERVICE_PASSWORD_64_JEAN" }],
        ["Allowed Origins", { key: "JEAN_ALLOWED_ORIGINS", rules: "nullable|string", sortOrder: 2, customHelper: "Comma-separated additional browser origins. Same-origin access is always allowed. Variable name: JEAN_ALLOWED_ORIGINS" }],
      ];
      for (const [label, setting] of settings) {
        const variable = env(setting.key ?? "");
        if (variable) data.set(label, { ...setting, value: readValue(variable) });
      }
      put("", data);
    } else if (which === "default") {
      // default: — Chaskiq's ADMIN_EMAIL among them.
      optional(data, [
        ["User", env("SERVICE_USER_ADMIN"), (row) => ({ ...of(row, "admin"), rules: "required" })],
        ["Password", env("SERVICE_PASSWORD_ADMIN"), password],
        ["Email", env("ADMIN_EMAIL"), (row) => ({ ...of(row), rules: "required|email" })],
      ]);
      put("Admin", data);
    }
  }

  for (const database of store.databases()) {
    const image = beforeColon(database.image);
    if (image === "") continue;
    const data = new Map<string, ExtraField>();
    if (image.includes("postgres")) {
      optional(data, [
        ["User", env("SERVICE_USER_POSTGRES", "SERVICE_USER_POSTGRESQL"), (row) => required(row)],
        ["Password", env("SERVICE_PASSWORD_POSTGRES", "SERVICE_PASSWORD_POSTGRESQL"), password],
        ["Database Name", env("POSTGRESQL_DATABASE", "POSTGRES_DB"), (row) => required(row)],
      ]);
      put("PostgreSQL", data);
    } else if (image.includes("mysql")) {
      optional(data, [
        ["User", env("SERVICE_USER_MYSQL", "SERVICE_USER_WORDPRESS", "MYSQL_USER"), (row) => required(row)],
        ["Password", env("SERVICE_PASSWORD_MYSQL", "SERVICE_PASSWORD_WORDPRESS", "MYSQL_PASSWORD", "SERVICE_PASSWORD_64_MYSQL"), password],
        ["Root Password", env("SERVICE_PASSWORD_MYSQLROOT", "SERVICE_PASSWORD_ROOT", "SERVICE_PASSWORD_64_MYSQLROOT"), password],
        ["Database Name", env("MYSQL_DATABASE"), (row) => required(row)],
      ]);
      put("MySQL", data);
    } else if (image.includes("mariadb")) {
      optional(data, [
        ["User", env("SERVICE_USER_MARIADB", "SERVICE_USER_WORDPRESS", "SERVICE_USER_MYSQL", "MYSQL_USER"), (row) => required(row)],
        ["Password", env("SERVICE_PASSWORD_MARIADB", "SERVICE_PASSWORD_WORDPRESS", "_APP_DB_PASS", "MYSQL_PASSWORD"), password],
        ["Root Password", env("SERVICE_PASSWORD_MARIADBROOT", "SERVICE_PASSWORD_ROOT", "_APP_DB_ROOT_PASS", "MYSQL_ROOT_PASSWORD"), password],
        ["Database Name", env("SERVICE_DATABASE_MARIADB", "SERVICE_DATABASE_WORDPRESS", "_APP_DB_SCHEMA", "MYSQL_DATABASE"), (row) => required(row)],
      ]);
      put("MariaDB", data);
    }
  }

  // A field whose value is a "$SERVICE_…" reference shows the referenced variable's value, or nothing and
  // locked when that one is locked — for the groups that are arrays.
  for (const group of fields.values()) {
    if (group.collection) continue;
    for (const field of group.fields.values()) {
      if (field.value === null || field.value.trim() === "" || !field.value.startsWith("$SERVICE_")) continue;
      const found = env(field.value.slice(1));
      if (found?.is_shown_once) {
        field.value = null;
        field.isLocked = true;
      } else if (found) {
        field.value = readValue(found);
      }
    }
  }
  return fields;
}

/** `case $image->contains(…)` for one needle. */
const containing = (image: string, ...needles: string[]) => (): boolean => needles.some((needle) => image.includes(needle));

/**
 * Which case of extraFields()'s `switch ($image)` an application's image takes: each case compares the
 * image with a boolean, so the first case that holds wins; "default" when none does.
 */
function applicationCase(image: string, fullImage: string | null): string {
  const cases: [string, () => boolean][] = [
    ...["drizzle-team/gateway", "castopod", "label-studio", "litellm", "langfuse", "invoiceninja", "argilla", "rabbitmq"].map((needle): [string, () => boolean] => [needle, containing(image, needle)]),
    // $image->is('registry')
    ["registry", () => image === "registry"],
    ...["tolgee", "logto", "unleash-server"].map((needle): [string, () => boolean] => [needle, containing(image, needle)]),
    ["grafana", () => isGrafanaServerImage(fullImage)],
    ...["elasticsearch", "directus", "kong"].map((needle): [string, () => boolean] => [needle, containing(image, needle)]),
    ["minio", containing(image, "minio", "pgsty/silo")],
    ...["garage", "weblate", "meilisearch", "linkding", "ghost", "vaultwarden", "gitlab/gitlab", "code-server", "elestio/strapi", "marckohlbrugge/sessy", "coollabsio/openclaw", "coollabsio/jean-server"].map(
      (needle): [string, () => boolean] => [needle, containing(image, needle)],
    ),
  ];
  return cases.find(([, test]) => test())?.[0] ?? "default";
}

// ---------------------------------------------------------------- the form

/** One field of StackForm::$fields. */
export interface StackFormField {
  serviceName: string;
  key: string;
  name: string;
  value: string | null;
  isPassword: boolean;
  rules: string;
  customHelper: string | null;
  sortOrder: number | null;
  isLocked: boolean;
}

/** StackForm::lockedFieldKeys(): the locked variables' keys and the fields that reference a locked variable. */
export function lockedFieldKeys(store: ServiceStore, extra: Map<string, Group> = serviceExtraFields(store)): string[] {
  const referencing = [...extra.values()].flatMap((group) => [...group.fields.values()].filter((field) => field.isLocked).map((field) => field.key ?? ""));
  return [...store.environmentVariables().filter((row) => row.is_shown_once === true).map((row) => row.key), ...referencing];
}

/**
 * StackForm::mount(): the fields keyed by variable, each template's group sorted by sortOrder (else
 * passwords last), locked fields and — for who may not manage the environment — every field without its value.
 */
export function stackFormFields(store: ServiceStore, isPasswordHiddenForMember: boolean): StackFormField[] {
  const extra = serviceExtraFields(store);
  // $this->fields->put($key, …): one field per key, the last one written in the first one's place.
  const byKey = new Map<string, StackFormField>();
  for (const [serviceName, group] of extra) {
    for (const [name, field] of group.fields) {
      const key = field.key ?? "";
      byKey.set(key, {
        serviceName,
        key,
        name,
        value: field.value,
        isPassword: field.isPassword === true,
        rules: field.rules ?? "nullable",
        customHelper: field.customHelper ?? null,
        sortOrder: field.sortOrder ?? null,
        isLocked: false,
      });
    }
  }
  // groupBy('serviceName') -> sortBy(sortOrder ?? (isPassword ? 1 : 0)) -> mapWithKeys -> flatMap.
  const groups = new Map<string, StackFormField[]>();
  for (const field of byKey.values()) {
    const group = groups.get(field.serviceName) ?? [];
    group.push(field);
    groups.set(field.serviceName, group);
  }
  const ordered = new Map<string, StackFormField>();
  for (const group of groups.values()) {
    const sorted = group.map((field, index) => ({ field, index })).sort((a, b) => rank(a.field) - rank(b.field) || a.index - b.index);
    for (const { field } of sorted) ordered.set(field.key, field);
  }
  const locked = lockedFieldKeys(store, extra);
  return [...ordered.values()].map((field) => {
    const isLocked = locked.includes(field.key);
    return { ...field, isLocked, value: isLocked || isPasswordHiddenForMember ? null : field.value };
  });
}

const rank = (field: StackFormField): number => field.sortOrder ?? (field.isPassword ? 1 : 0);

/** Laravel's messages for the rules extraFields() uses, with the field's label as its attribute. */
export const FIELD_MESSAGES = {
  required: (attribute: string) => `The ${attribute} field is required.`,
  string: (attribute: string) => `The ${attribute} field must be a string.`,
  email: (attribute: string) => `The ${attribute} field must be a valid email address.`,
  url: (attribute: string) => `The ${attribute} field must be a valid URL.`,
  in: (attribute: string) => `The selected ${attribute} is invalid.`,
} as const;

/** Laravel's `email` rule, approximately: one "@" with something on either side and no white space. */
const isEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+$/.test(value);

/** The rules of one field (`fields.<key>.value`), with Laravel's order and its skipping of empty values. */
export function validateField(errors: FieldErrors, field: Pick<StackFormField, "key" | "name" | "rules">, value: unknown): void {
  const rules = field.rules.split("|");
  const attribute = field.name;
  const at = `fields.${field.key}.value`;
  const push = (message: string) => (errors[at] ??= []).push(message);
  const empty = value === null || value === undefined || (typeof value === "string" && value.trim() === "");
  if (empty) {
    if (rules.includes("required")) push(FIELD_MESSAGES.required(attribute));
    return;
  }
  for (const rule of rules) {
    const [name, parameters] = rule.split(":", 2) as [string, string | undefined];
    if (name === "string" && typeof value !== "string") push(FIELD_MESSAGES.string(attribute));
    else if (name === "email" && !(typeof value === "string" && isEmail(value))) push(FIELD_MESSAGES.email(attribute));
    else if (name === "url" && !(typeof value === "string" && isUrl(value))) push(FIELD_MESSAGES.url(attribute));
    else if (name === "in" && !(parameters ?? "").split(",").includes(String(value))) push(FIELD_MESSAGES.in(attribute));
  }
}

/**
 * Service::saveExtraFields(): each field's value on its variable (the value mutator and the saving hook:
 * the edge line breaks dropped, preserve_compose_null cleared by a value, is_shared recomputed), or a new
 * variable when the key has none.
 */
export function saveExtraFields(store: ServiceStore, fields: readonly { key: string; value: string | null }[]): void {
  for (const field of fields) {
    const value = field.value === null ? null : withoutEdgeLineBreaks(field.value);
    const found = store.environmentVariables().find((row) => row.key === field.key);
    if (found) {
      found.value = value;
      // The mutator encrypts, so the value is always dirty.
      if (found.preserve_compose_null && value !== null) found.preserve_compose_null = false;
      found.is_shared = isSharedReference(value);
    } else {
      store.createEnvironmentVariable({
        key: validatedEnvironmentVariableKey(normalizeEnvironmentVariableKey(field.key)),
        value,
        is_preview: false,
        is_required: false,
        is_shared: isSharedReference(value),
        is_literal: false,
        is_multiline: false,
        comment: null,
        version: ENVIRONMENT_VARIABLE_VERSION,
        preserve_compose_null: false,
      });
    }
  }
}
