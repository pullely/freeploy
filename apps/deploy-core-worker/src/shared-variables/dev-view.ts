// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/shared.php (parseEnvFormatToArray,
// formatEnvValueForDevView, formatEnvVariableForDevView, parseEnvDevView) and
// app/Models/SharedEnvironmentVariable.php (DEV_VIEW_FLAG_DEFAULTS) (Apache-2.0), modified.
//
// The developer view: a scope's variables as KEY=value lines, and that text
// read back. PHP's string functions are reproduced where they decide the
// result: trim()'s character list, PCRE's \s without UCP, and an array that
// keeps a key at the place it first appeared when a later line sets it again.
// The "# coolify:" directive is the file format's token, kept as Coolify
// writes it so a developer view copied from Coolify reads the same here.

/** SharedEnvironmentVariable::DEV_VIEW_FLAG_DEFAULTS: shared variables have no buildtime or runtime flags. */
export const SHARED_DEV_VIEW_FLAG_DEFAULTS: Readonly<Record<string, boolean>> = { literal: false };

const DIRECTIVE = "# coolify:";
/** PHP's trim() without a character list. */
const PHP_TRIM = " \t\n\r\0\x0B";
/** PCRE's \s without UCP: space, \t, \n, \v, \f, \r. */
const WS = " \\t\\n\\x0B\\f\\r";
const WS_THEN_HASH = new RegExp(`[${WS}]+#`);
const WS_HASH = new RegExp(`[${WS}]#`);
const WS_RUN = new RegExp(`[${WS}]+`);

export function phpTrim(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && PHP_TRIM.includes(value[start]!)) start++;
  while (end > start && PHP_TRIM.includes(value[end - 1]!)) end--;
  return value.slice(start, end);
}

export interface EnvLine {
  value: string;
  comment: string | null;
}

/**
 * parseEnvFormatToArray(): KEY=value lines, keyed by what stands before the
 * first "=" (not trimmed). A quoted value keeps its spaces and a "#" inside
 * it; an unquoted one is trimmed and ends at the first "#" that follows
 * whitespace. What follows that "#" (or a "#" after the closing quote) is the
 * comment. Blank lines, "#" lines and lines without "=" are skipped.
 */
export function parseEnvFormatToArray(contents: string): Map<string, EnvLine> {
  const env = new Map<string, EnvLine>();
  for (const line of contents.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    const key = line.slice(0, equals);
    const valueAndComment = line.slice(equals + 1);
    let value: string;
    let remainder = "";

    const first = valueAndComment[0] ?? "";
    if (first === '"' || first === "'") {
      const closing = valueAndComment.indexOf(first, 1);
      if (closing !== -1) {
        value = valueAndComment.slice(1, closing);
        remainder = valueAndComment.slice(closing + 1);
      } else {
        // No closing quote - treat as unquoted
        value = valueAndComment.slice(1);
      }
    } else {
      // Only treat # as comment if preceded by whitespace
      const match = WS_THEN_HASH.exec(valueAndComment);
      if (match) {
        remainder = valueAndComment.slice(match.index);
        value = valueAndComment.slice(0, match.index);
      } else {
        value = valueAndComment;
      }
      // Like a .env file, an unquoted value loses its edge whitespace. Quotes keep it.
      value = phpTrim(value);
    }

    let comment: string | null = null;
    const hash = remainder.indexOf("#");
    if (hash !== -1) {
      const text = phpTrim(remainder.slice(hash + 1));
      comment = text === "" ? null : text;
    }
    env.set(key, { value, comment });
  }
  return env;
}

/**
 * formatEnvValueForDevView(): the value as a KEY=value line holds it, so that
 * parseEnvFormatToArray() reads it back unchanged; null when the format cannot
 * hold it (a line break, or it needs quotes and has both quote types).
 */
export function formatEnvValueForDevView(value: string | null): string | null {
  const v = value ?? "";
  if (v.includes("\n")) return null;
  const needsQuotes = v.startsWith('"') || v.startsWith("'") || WS_HASH.test(v) || v !== phpTrim(v);
  if (!needsQuotes) return v;
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"')) return `"${v}"`;
  return null;
}

/** What the developer view reads of a variable. `value` is its plaintext (unused when it cannot be viewed). */
export interface DevViewVariable {
  key: string;
  value: string | null;
  isShownOnce: boolean;
  isMultiline: boolean;
  isLiteral: boolean;
}

/**
 * formatEnvVariableForDevView(): the KEY=value line, with a "# coolify:"
 * directive line above it when a flag is not its default. A variable the view
 * cannot edit gets a placeholder line and no directive.
 */
export function formatEnvVariableForDevView(variable: DevViewVariable, canViewValue: boolean): string {
  if (!canViewValue) return `${variable.key}=(Hidden, only admins can view)`;
  if (variable.isShownOnce) return `${variable.key}=(Locked Secret, delete and add again to change)`;
  if (variable.isMultiline) return `${variable.key}=(Multiline environment variable, edit in normal view)`;
  const value = formatEnvValueForDevView(variable.value);
  if (value === null) return `${variable.key}=(Value cannot be shown in this view, edit in normal view)`;

  const flags: string[] = [];
  const current: Record<string, boolean> = { literal: variable.isLiteral };
  for (const [flag, fallback] of Object.entries(SHARED_DEV_VIEW_FLAG_DEFAULTS)) {
    if (Boolean(current[flag]) !== fallback) flags.push(fallback ? `${flag}=false` : flag);
  }
  const line = `${variable.key}=${value}`;
  return flags.length === 0 ? line : `${DIRECTIVE} ${flags.join(" ")}\n${line}`;
}

/** parseEnvDevView()'s InvalidArgumentException: the message is the error toast. */
export class DevViewError extends Error {}

export interface DevViewLine extends EnvLine {
  /** The flags of the directive above the key line, as model attributes ({ is_literal: true }); empty without one. */
  settings: Record<string, boolean>;
}

/**
 * parseEnvDevView(): parseEnvFormatToArray() with, per key, the flags of the
 * "# coolify:" line directly above its line. A key without a directive gets
 * empty settings, so its flags stay. Throws when a directive is not directly
 * above a KEY=value line, or has an unknown flag or value.
 */
export function parseEnvDevView(contents: string | null, flagDefaults: Readonly<Record<string, boolean>> = SHARED_DEV_VIEW_FLAG_DEFAULTS): Map<string, DevViewLine> {
  const text = contents ?? "";
  const settingsByKey = new Map<string, Record<string, boolean>>();
  let directive: Record<string, boolean> | null = null;
  let directiveLine = 0;
  const misplaced = () => new DevViewError(`Line ${directiveLine}: a "${DIRECTIVE}" line must be directly above a KEY=value line.`);

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const isKeyLine = line !== "" && !line.startsWith("#") && line.includes("=");
    if (directive !== null && !isKeyLine) throw misplaced();

    if (isKeyLine) {
      settingsByKey.set(line.slice(0, line.indexOf("=")), directive ?? {});
      directive = null;
    } else if (line.startsWith(DIRECTIVE)) {
      directiveLine = index + 1;
      const flags = phpTrim(line.slice(DIRECTIVE.length))
        .split(WS_RUN)
        .filter((flag) => flag !== "");
      if (flags.length === 0) throw new DevViewError(`Line ${directiveLine}: the "${DIRECTIVE}" line has no flags.`);

      const parsed: Record<string, boolean> = {};
      for (const flag of flags) {
        const equals = flag.indexOf("=");
        const name = equals === -1 ? flag : flag.slice(0, equals);
        const value = equals === -1 ? "true" : flag.slice(equals + 1);
        if (!Object.hasOwn(flagDefaults, name)) {
          throw new DevViewError(`Line ${directiveLine}: unknown flag "${name}". Allowed flags: ${Object.keys(flagDefaults).join(", ")}.`);
        }
        if (value !== "true" && value !== "false") throw new DevViewError(`Line ${directiveLine}: the value of "${name}" must be true or false.`);
        parsed[`is_${name}`] = value === "true";
      }
      directive = parsed;
    }
  }
  if (directive !== null) throw misplaced();

  const variables = new Map<string, DevViewLine>();
  for (const [key, data] of parseEnvFormatToArray(text)) variables.set(key, { ...data, settings: settingsByKey.get(key) ?? {} });
  return variables;
}
