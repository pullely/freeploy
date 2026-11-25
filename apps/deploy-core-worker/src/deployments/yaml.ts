// Derived from symfony/yaml 7 (Dumper.php, Inline.php, Escaper.php; MIT, © Fabien Potencier), modified:
// a TypeScript port of Yaml::dump($value, 10) — what coollabsio/coolify@91b7e3e's
// ApplicationDeploymentJob::generate_compose_file() calls for the compose file — for the values a PHP array of
// scalars holds. Byte-equal to Symfony's output for the cases of
// tests/deploy-core-worker/fixtures/deployments (yaml.* and every run's compose file).
//
// PHP tells an int from a float and a list from a map; JavaScript does not. So:
//   - a `number` that is an integer is a PHP int, any other number a PHP float, and PhpFloat is a float whatever
//     its value ((float) "2" dumps as 2.0);
//   - an Array is a PHP list, a Map a PHP array with keys in insertion order (a plain object would reorder
//     integer-like keys). As in PHP, an empty array of either kind dumps as {}, and a Map whose keys are
//     0, 1, 2, … in order is a list.
import { base64Encode, byteLength, isNumericString, phpFloatToString } from "./php.js";

export class PhpFloat {
  constructor(readonly value: number) {}
}

export type YamlValue = null | boolean | number | string | PhpFloat | YamlValue[] | Map<string, YamlValue>;

/** A Map from [key, value] pairs, for writing a PHP array literal in its order. */
export function ymap(entries: Array<[string, YamlValue]>): Map<string, YamlValue> {
  return new Map(entries);
}

const INDENTATION = 4;

/** A PHP array key: a decimal integer string is an int key, which dumps without quotes. */
const isIntKey = (key: string): boolean => /^(?:0|-?[1-9]\d{0,17})$/.test(key);

/** Inline::isHash(): false when the keys are 0, 1, 2, … in order. */
function isHash(value: YamlValue[] | Map<string, YamlValue>): boolean {
  if (Array.isArray(value)) return false;
  let expected = 0;
  for (const key of value.keys()) {
    if (key !== String(expected++)) return true;
  }
  return false;
}

const isCollection = (value: YamlValue): value is YamlValue[] | Map<string, YamlValue> => Array.isArray(value) || value instanceof Map;
const size = (value: YamlValue[] | Map<string, YamlValue>): number => (Array.isArray(value) ? value.length : value.size);
const entries = (value: YamlValue[] | Map<string, YamlValue>): Array<[string, YamlValue]> =>
  Array.isArray(value) ? value.map((v, i) => [String(i), v] as [string, YamlValue]) : [...value.entries()];

/** Escaper::ESCAPEES and ::ESCAPED, replaced one after the other as str_replace() does with two arrays. */
const ESCAPEES = ["\\", "\\\\", '\\"', '"', ...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)), "\x7f", "\u{85}", "\u{a0}", "\u{2028}", "\u{2029}"];
const ESCAPED = [
  "\\\\", '\\"', "\\\\", '\\"',
  "\\0", "\\x01", "\\x02", "\\x03", "\\x04", "\\x05", "\\x06", "\\a",
  "\\b", "\\t", "\\n", "\\v", "\\f", "\\r", "\\x0e", "\\x0f",
  "\\x10", "\\x11", "\\x12", "\\x13", "\\x14", "\\x15", "\\x16", "\\x17",
  "\\x18", "\\x19", "\\x1a", "\\e", "\\x1c", "\\x1d", "\\x1e", "\\x1f",
  "\\x7f",
  "\\N", "\\_", "\\L", "\\P",
];

/**
 * str_replace($search[], $replace[], $subject) as PHP runs it for Escaper: the subject is scanned once, and at
 * each position the first search string that matches is replaced (php_strtr-like for same-pass semantics would
 * differ; PHP applies each pair to the whole result in turn).
 */
function strReplaceEach(search: readonly string[], replace: readonly string[], subject: string): string {
  let out = subject;
  for (let i = 0; i < search.length; i++) out = out.split(search[i]!).join(replace[i]!);
  return out;
}

const REQUIRES_DOUBLE = /[\x00-\x1f]|\x7f|\u{85}|\u{a0}|\u{2028}|\u{2029}/u;
const SINGLE_WORDS = ["null", "~", "true", "false", "y", "n", "yes", "no", "on", "off", ".inf", ".nan", "..."];
/** PCRE's \s with /u (UCP): the separators and \t \n \v \f \r. */
const REQUIRES_SINGLE = /[\t\n\v\f\r\p{Z}'":{}[\],&*#?]|^[-?|<>=!%@`\p{Zs}\u{feff}]/u;
/** Controls that make Inline::isBinaryString() true (everything below 0x20 but \0, \x07-\x0d and \x1b). */
const BINARY = /[\x01-\x06\x0e-\x1a\x1c-\x1f]/;
const NUMBER_LIKE = /^[+-]?[0-9][0-9_]*(\.[0-9_]+)?$/;
const OCTAL = /^[+-]?0o[0-7_]+$/;
const HEX = /^0x[0-9a-fA-F_]+$/;
const TIMESTAMP = /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)?$/;

const escapeWithDoubleQuotes = (value: string): string => `"${strReplaceEach(ESCAPEES, ESCAPED, value)}"`;
const escapeWithSingleQuotes = (value: string): string => `'${value.split("'").join("''")}'`;

/** Inline::dump() for a string. */
function dumpString(value: string): string {
  if (isNumericString(value) && !/[\f\n\r\t\v]/.test(value)) return `'${value}'`;
  if (value === "") return "''";
  if (BINARY.test(value)) return "!!binary " + base64Encode(value);
  if (REQUIRES_DOUBLE.test(value)) return escapeWithDoubleQuotes(value);
  if (SINGLE_WORDS.includes(value.toLowerCase()) || REQUIRES_SINGLE.test(value)) {
    const single = escapeWithSingleQuotes(value);
    if (!value.includes("'")) return single;
    const double = escapeWithDoubleQuotes(value);
    return byteLength(double) < byteLength(single) ? double : single;
  }
  if (NUMBER_LIKE.test(value) || OCTAL.test(value) || HEX.test(value) || TIMESTAMP.test(value)) return escapeWithSingleQuotes(value);
  return value;
}

function dumpFloat(value: number): string {
  if (Number.isNaN(value)) return ".NaN";
  if (!Number.isFinite(value)) return value > 0 ? ".Inf" : "-.Inf";
  let repr = phpFloatToString(value);
  // "Preserve float data type since storing a whole number will result in integer value."
  if (Math.floor(value) === value && Number(repr) === value && !repr.includes("E")) repr += ".0";
  return repr;
}

/** Inline::dump(): a value on one line. */
function dumpInline(value: YamlValue): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (value instanceof PhpFloat) return dumpFloat(value.value);
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : dumpFloat(value);
  if (typeof value === "string") return dumpString(value);
  if (size(value) > 0 && !isHash(value)) return `[${entries(value).map(([, v]) => dumpInline(v)).join(", ")}]`;
  const pairs = entries(value).map(([k, v]) => `${dumpKey(k)}: ${dumpInline(v)}`);
  return pairs.length ? `{ ${pairs.join(", ")} }` : "{}";
}

const dumpKey = (key: string): string => (isIntKey(key) ? key : dumpString(key));

/** Dumper::doDump(). */
function doDump(input: YamlValue, inline: number, indent: number): string {
  const prefix = " ".repeat(indent);
  if (inline <= 0 || !isCollection(input) || size(input) === 0) return prefix + dumpInline(input);
  const asMap = isHash(input);
  let output = "";
  for (const [key, value] of entries(input)) {
    if (output !== "" && !output.endsWith("\n")) output += "\n";
    const willBeInlined = inline - 1 <= 0 || !isCollection(value) || size(value) === 0;
    output += prefix + (asMap ? dumpKey(key) + ":" : "-") + (willBeInlined ? " " : "\n") + doDump(value, inline - 1, willBeInlined ? 0 : indent + INDENTATION) + (willBeInlined ? "\n" : "");
  }
  return output;
}

/** Yaml::dump($value, $inline): block style down to `inline` levels, 4 spaces a level. */
export function yamlDump(value: YamlValue, inline = 10): string {
  return doDump(value, inline, 0);
}
