// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/shared.php (parseEnvFormatToArray,
// formatEnvValueForDevView, formatEnvVariableForDevView, parseEnvDevView), app/Models/EnvironmentVariable.php
// (DEV_VIEW_FLAG_DEFAULTS, withoutEdgeLineBreaks) and app/Traits/EnvironmentVariableProtection.php
// (isProtectedEnvironmentVariable) (Apache-2.0), modified.
//
// The developer view's text format, as Coolify reads and writes it: one
// KEY=value per line, a value quoted when it must be, an inline comment after
// whitespace and "#", and a "# coolify:" line above a variable to set its
// flags. It is not a shell or dotenv parser: there are no escapes, no
// `export`, no values over several lines. The PHP functions work on bytes with
// ASCII delimiters, so the same code on UTF-16 strings gives the same result.
// tests/deploy-core-worker/fixtures/environment-variables/expected.json holds
// what the PHP functions answer.

/** PHP's trim() default characters: space, \n, \r, \t, \v and NUL (no form feed). */
const PHP_TRIM = " \n\r\t\v\0";

/** PHP's trim($value) or trim($value, $characters). */
export function phpTrim(value: string, characters = PHP_TRIM): string {
  let start = 0;
  let end = value.length;
  while (start < end && characters.includes(value[start]!)) start++;
  while (end > start && characters.includes(value[end - 1]!)) end--;
  return value.slice(start, end);
}

/** PCRE's \s without the u modifier: space, \t, \n, \v, \f, \r. JavaScript's \s also matches Unicode spaces. */
const PCRE_SPACE = " \\t\\n\\v\\f\\r";
const SPACE_THEN_HASH = new RegExp(`[${PCRE_SPACE}]+#`);
const SPACE_HASH = new RegExp(`[${PCRE_SPACE}]#`);
const SPACES = new RegExp(`[${PCRE_SPACE}]+`);

/** Laravel's blank() for a nullable string: null, or nothing but trim()'s whitespace. */
export const blankString = (value: string | null | undefined): boolean => value === null || value === undefined || phpTrim(value) === "";

export interface ParsedEnvValue {
  value: string;
  comment: string | null;
}

/**
 * parseEnvFormatToArray(): KEY => { value, comment }, in the order the keys
 * first appear (a repeated key keeps its place and takes the last value, as a
 * PHP array does).
 */
export function parseEnvFormatToArray(contents: string): Map<string, ParsedEnvValue> {
  const env = new Map<string, ParsedEnvValue>();
  for (const line of contents.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals);
    const valueAndComment = line.slice(equals + 1);
    let value: string;
    let remainder = "";
    const quote = valueAndComment[0] === '"' || valueAndComment[0] === "'" ? valueAndComment[0] : null;
    if (quote) {
      // To the closing quote; without one the rest of the line is the value.
      const closing = valueAndComment.indexOf(quote, 1);
      if (closing !== -1) {
        value = valueAndComment.slice(1, closing);
        remainder = valueAndComment.slice(closing + 1);
      } else {
        value = valueAndComment.slice(1);
      }
    } else {
      // Unquoted: "#" starts a comment only after whitespace, and the value loses its edge whitespace.
      const hash = SPACE_THEN_HASH.exec(valueAndComment);
      if (hash) {
        remainder = valueAndComment.slice(hash.index);
        value = valueAndComment.slice(0, hash.index);
      } else {
        value = valueAndComment;
      }
      value = phpTrim(value);
    }
    let comment: string | null = null;
    const hashAt = remainder.indexOf("#");
    if (hashAt !== -1) comment = phpTrim(remainder.slice(hashAt + 1)) || null;
    env.set(key, { value, comment });
  }
  return env;
}

/**
 * formatEnvValueForDevView(): the value as a KEY=VALUE line holds it, so that
 * parseEnvFormatToArray() reads it back unchanged; null when the format cannot
 * hold it (a line break, or quotes needed and both kinds inside).
 */
export function formatEnvValueForDevView(value: string | null): string | null {
  const v = value ?? "";
  if (v.includes("\n")) return null;
  const needsQuotes = v.startsWith('"') || v.startsWith("'") || SPACE_HASH.test(v) || v !== phpTrim(v);
  if (!needsQuotes) return v;
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"')) return `"${v}"`;
  return null;
}

/** The flags a "# coolify:" line can set, with their defaults; the model attribute is is_<flag>. */
export type DevViewFlagDefaults = Readonly<Record<string, boolean>>;

/** EnvironmentVariable::DEV_VIEW_FLAG_DEFAULTS */
export const ENVIRONMENT_VARIABLE_DEV_VIEW_FLAGS = { literal: false, buildtime: true, runtime: true } as const satisfies DevViewFlagDefaults;

export const DEV_VIEW_PLACEHOLDERS = {
  hidden: "(Hidden, only admins can view)",
  locked: "(Locked Secret, delete and add again to change)",
  multiline: "(Multiline environment variable, edit in normal view)",
  unshowable: "(Value cannot be shown in this view, edit in normal view)",
} as const;

/** What the developer view needs of a variable: its key, value and flags (flags.literal is is_literal, …). */
export interface DevViewVariable {
  key: string;
  value: string | null;
  isShownOnce: boolean;
  isMultiline: boolean;
  flags: Readonly<Record<string, boolean>>;
}

/**
 * formatEnvVariableForDevView(): the KEY=value line, with a "# coolify:" line
 * above it when a flag is not its default; a variable the view cannot edit
 * gets a placeholder and no directive.
 */
export function formatEnvVariableForDevView(variable: DevViewVariable, canViewValue: boolean, flagDefaults: DevViewFlagDefaults = ENVIRONMENT_VARIABLE_DEV_VIEW_FLAGS): string {
  if (!canViewValue) return `${variable.key}=${DEV_VIEW_PLACEHOLDERS.hidden}`;
  if (variable.isShownOnce) return `${variable.key}=${DEV_VIEW_PLACEHOLDERS.locked}`;
  if (variable.isMultiline) return `${variable.key}=${DEV_VIEW_PLACEHOLDERS.multiline}`;
  const value = formatEnvValueForDevView(variable.value);
  if (value === null) return `${variable.key}=${DEV_VIEW_PLACEHOLDERS.unshowable}`;
  const flags: string[] = [];
  for (const [flag, fallback] of Object.entries(flagDefaults)) {
    if (Boolean(variable.flags[flag]) !== fallback) flags.push(fallback ? `${flag}=false` : flag);
  }
  const line = `${variable.key}=${value}`;
  return flags.length === 0 ? line : `# coolify: ${flags.join(" ")}\n${line}`;
}

export interface DevViewEntry extends ParsedEnvValue {
  /** The flags of the "# coolify:" line directly above the key, as model attributes (is_literal, …); empty without one. */
  settings: Record<string, boolean>;
}

/** PHP's InvalidArgumentException of parseEnvDevView() and of the key normalization. */
export class EnvFormatError extends Error {}

const DIRECTIVE = "# coolify:";
const DIRECTIVE_PLACEMENT = (line: number) => `Line ${line}: a "# coolify:" line must be directly above a KEY=value line.`;

/**
 * parseEnvDevView(): parseEnvFormatToArray() with the settings of each key.
 * Throws EnvFormatError for a directive that is not directly above a
 * KEY=value line, or that has no flags, an unknown flag or a value other than
 * true or false.
 */
export function parseEnvDevView(contents: string | null, flagDefaults: DevViewFlagDefaults = ENVIRONMENT_VARIABLE_DEV_VIEW_FLAGS): Map<string, DevViewEntry> {
  const text = contents ?? "";
  const settingsByKey = new Map<string, Record<string, boolean>>();
  let directive: Record<string, boolean> | null = null;
  let directiveLine = 0;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const isKeyLine = line !== "" && !line.startsWith("#") && line.includes("=");
    if (directive !== null && !isKeyLine) throw new EnvFormatError(DIRECTIVE_PLACEMENT(directiveLine));
    if (isKeyLine) {
      settingsByKey.set(line.slice(0, line.indexOf("=")), directive ?? {});
      directive = null;
    } else if (line.startsWith(DIRECTIVE)) {
      directiveLine = index + 1;
      const flags = phpTrim(line.slice(DIRECTIVE.length)).split(SPACES).filter((flag) => flag !== "");
      if (flags.length === 0) throw new EnvFormatError(`Line ${directiveLine}: the "# coolify:" line has no flags.`);
      const parsed: Record<string, boolean> = {};
      for (const flag of flags) {
        const equals = flag.indexOf("=");
        const name = equals === -1 ? flag : flag.slice(0, equals);
        const value = equals === -1 ? "true" : flag.slice(equals + 1);
        if (!Object.hasOwn(flagDefaults, name)) {
          throw new EnvFormatError(`Line ${directiveLine}: unknown flag "${name}". Allowed flags: ${Object.keys(flagDefaults).join(", ")}.`);
        }
        if (value !== "true" && value !== "false") throw new EnvFormatError(`Line ${directiveLine}: the value of "${name}" must be true or false.`);
        parsed[`is_${name}`] = value === "true";
      }
      directive = parsed;
    }
  }
  if (directive !== null) throw new EnvFormatError(DIRECTIVE_PLACEMENT(directiveLine));

  const variables = new Map<string, DevViewEntry>();
  for (const [key, data] of parseEnvFormatToArray(text)) variables.set(key, { ...data, settings: settingsByKey.get(key) ?? {} });
  return variables;
}

/**
 * EnvironmentVariable::withoutEdgeLineBreaks(): a single-line value loses the
 * line breaks at its edges (a paste often adds them; spaces and tabs stay);
 * multiline content is kept as it is.
 */
export function withoutEdgeLineBreaks(value: string): string {
  const trimmed = phpTrim(value, "\r\n");
  return trimmed.includes("\n") ? value : trimmed;
}

/** EnvironmentVariableProtection::isProtectedEnvironmentVariable(): the generated Compose variables. */
export function isProtectedEnvironmentVariable(key: string): boolean {
  return key.startsWith("SERVICE_FQDN_") || key.startsWith("SERVICE_URL_") || key.startsWith("SERVICE_NAME_");
}

/** Show::checkEnvs() and All::updateOrCreateVariables(): a magic variable (no underscore after the prefix). */
export function isMagicEnvironmentVariable(key: string): boolean {
  return key.startsWith("SERVICE_FQDN") || key.startsWith("SERVICE_URL") || key.startsWith("SERVICE_NAME");
}
