// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/parsers.php (parseDockerComposeYaml,
// joinComposeAnchorsToTheirKeys) and from symfony/yaml v8.1.11 as Coolify calls it — Inline.php
// (evaluateScalar, dump, isHash, dumpArray, dumpHashArray, the timestamp and hex patterns), Dumper.php
// (doDump), Escaper.php and Parser.php (the merge key and duplicate key rules) — (Apache-2.0 and MIT),
// modified.
//
// Coolify reads a Compose file with Symfony's `Yaml::parse` and writes the one it deploys with
// `Yaml::dump($compose, 10, 2)`. What ends up on a server is that text, so both directions are
// reproduced here:
//
// - `parseYaml` reads the document with the `yaml` package (eemeli/yaml) for the syntax only — every
//   scalar comes back as text (the failsafe schema) — and then gives each plain scalar the value
//   Symfony's `Inline::evaluateScalar` gives it: `0755` and `1.10.0` stay strings, `yes` is a string,
//   `2024-01-01` is a Unix timestamp, `0o755` and `0x1F` are integers, `1_000` is 1000. Anchors, aliases
//   and `<<` merge keys follow Symfony's rules (a merged key keeps the position of the merge; a key
//   written after a merge overwrites in place; a duplicate key is otherwise an error).
// - `dumpYaml` is Symfony's dumper for the one configuration Coolify uses (inline level 10, indentation
//   2, no flags): which strings are quoted and how, `{}` for an empty collection, floats, and the switch
//   to the inline `{ a: b }` / `[a, b]` form from the eleventh level down.
//
// Verified against PHP: tests/deploy-core-worker/fixtures/compose-yaml (see its README).
import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument, type Document, type Node } from "yaml";
import { PhpArray, PhpFloat, isNumericString, phpFloatToString, utf8, type PhpKey, type PhpValue } from "./php.js";

export class YamlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YamlParseError";
  }
}

const HEX = /^0x[0-9a-fA-F_]+$/;
const TIMESTAMP =
  /^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:(?:[Tt]|[ \t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\.([0-9]*))?(?:[ \t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?)?$/;
const PHP_TRIM = /^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g;

function integer(text: string, radix: number): PhpValue {
  const digits = text === "" ? "0" : text;
  const value = Number.parseInt(digits, radix);
  if (Number.isSafeInteger(value)) return value;
  const prefix = radix === 16 ? "0x" : "0o";
  const big = BigInt(prefix + digits);
  // PHP's hexdec/octdec return a float beyond PHP_INT_MAX.
  return big > 9223372036854775807n ? new PhpFloat(Number(big)) : big;
}

function timestamp(scalar: string, match: RegExpExecArray): PhpValue {
  const [, year, month, day, hour, minute, second, fraction, zone, zoneSign, zoneHour, zoneMinute] = match;
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (monthNumber < 1 || monthNumber > 12 || dayNumber < 1 || dayNumber > 31 || Number(hour ?? 0) > 24 || Number(minute ?? 0) > 59 || Number(second ?? 0) > 59) {
    throw new YamlParseError(`The date "${scalar}" could not be parsed as it is an invalid date.`);
  }
  let millis = Date.UTC(Number(year), monthNumber - 1, dayNumber, Number(hour ?? 0), Number(minute ?? 0), Number(second ?? 0));
  if (zone !== undefined && zone !== "Z") {
    const offset = (Number(zoneHour) * 60 + Number(zoneMinute ?? 0)) * 60_000;
    millis += zoneSign === "-" ? offset : -offset;
  }
  const seconds = millis / 1000;
  const micros = (fraction ?? "").slice(0, 6).replace(/0+$/, "");
  if (micros !== "") return new PhpFloat(seconds + Number(`0.${micros}`));
  return seconds;
}

/** `Inline::evaluateScalar`: the PHP value of a plain (unquoted) scalar. */
export function evaluateScalar(text: string): PhpValue {
  let scalar = text.replace(PHP_TRIM, "");
  const lower = scalar.toLowerCase();
  if (lower === "null" || scalar === "" || scalar === "~") return null;
  if (lower === "true") return true;
  if (lower === "false") return false;
  const first = scalar[0] ?? "";
  const octal = /^(?:\+|-)?0o([0-7_]+)$/.exec(scalar);
  if (octal) {
    const value = integer((octal[1] ?? "").replaceAll("_", ""), 8);
    if (first !== "-") return value;
    if (typeof value === "number") return -value;
    return typeof value === "bigint" ? -value : new PhpFloat(-(value as PhpFloat).value);
  }
  if (first === "+" || first === "-" || first === "." || (first >= "0" && first <= "9")) {
    if (/^[+-]?[0-9][0-9_]*$/.test(scalar)) {
      scalar = scalar.replaceAll("_", "");
      if (scalar.startsWith("+")) scalar = scalar.slice(1);
    }
    if (/^-?[0-9]+$/.test(scalar)) {
      // PHP casts to int and keeps the text when the cast does not print the same: "0755", "-0", and
      // anything beyond a 64-bit integer.
      const big = BigInt(scalar);
      if (big < -9223372036854775808n || big > 9223372036854775807n) return scalar;
      if (big.toString() !== scalar) return scalar;
      const value = Number(scalar);
      return Number.isSafeInteger(value) ? value : big;
    }
    if (isNumericString(scalar) || HEX.test(scalar)) {
      scalar = scalar.replaceAll("_", "");
      if (scalar.startsWith("0x")) return integer(scalar.slice(2), 16);
      return new PhpFloat(Number.parseFloat(scalar));
    }
    if (lower === ".inf") return new PhpFloat(Infinity);
    if (lower === ".nan") return new PhpFloat(NaN);
    if (lower === "-.inf") return new PhpFloat(-Infinity);
    if (/^(-|\+)?[0-9][0-9_]*(\.[0-9_]+)?$/.test(scalar)) return new PhpFloat(Number.parseFloat(scalar.replaceAll("_", "")));
    const date = TIMESTAMP.exec(scalar);
    if (date) return timestamp(scalar, date);
  }
  return scalar;
}

interface Context {
  document: Document.Parsed;
  aliases: number;
  maxAliases: number;
  /** The text the document was read from, line breaks normalised. */
  text: string;
  /** Symfony's "last line of the document" by its own count: see `losesFinalLineBreak`. */
  lastLine: number;
}

function keyOf(node: unknown, context: Context): { key: PhpKey; merge: boolean } {
  if (isScalar(node)) {
    const text = typeof node.value === "string" ? node.value : "";
    if (node.type !== "PLAIN") return { key: text, merge: false };
    if (text === "<<") return { key: text, merge: true };
    const key = evaluateScalar(text);
    if (typeof key === "string" || typeof key === "number") return { key, merge: false };
    const numeric = key instanceof PhpFloat || typeof key === "bigint";
    throw new YamlParseError(`${numeric ? "Numeric" : "Non-string"} keys are not supported. Quote your evaluable mapping keys instead.`);
  }
  if (isAlias(node)) {
    const value = convert(node, context);
    if (typeof value === "string" || typeof value === "number") return { key: value, merge: false };
  }
  throw new YamlParseError("Non-string keys are not supported. Quote your evaluable mapping keys instead.");
}

function union(target: PhpArray, source: PhpArray): void {
  for (const [key, value] of source) if (!target.has(key)) target.set(key, value);
}

function lineBreaks(text: string): number {
  return text.split("\n").length - 1;
}

/**
 * Symfony compares line numbers of the whole file with a line count taken after the comments and empty
 * lines above the content were removed. The value: how many lines it believes the document has, minus one.
 */
function lastLineThreshold(text: string): number {
  let rest = text;
  const header = /^(?:[ \t]*(?:#[^\n]*)?\n)*(?:%YAML[: ][\d.]+[^\n]*\n(?:[ \t]*(?:#[^\n]*)?\n)*)?/.exec(rest)?.[0] ?? "";
  let removed = lineBreaks(header);
  rest = rest.slice(header.length);
  if (/^---(?=[ \t\n]|$)/.test(rest)) {
    rest = rest.replace(/^---[ \t]*/, "");
    removed += lineBreaks(/^(?:[ \t]*(?:#[^\n]*)?\n)+/.exec(rest)?.[0] ?? "");
  }
  return lineBreaks(text) - removed;
}

/**
 * A block scalar (`|`, `>`) keeps the line break after its last line only if Symfony's parser sees
 * something after it. When the scalar is the last entry of its collection, the next line already belongs
 * to an outer collection (or the file ends without a line break), and the scalar's last line is — by the
 * count described above — at or past the "last line of the document", Symfony drops that line break.
 * In practice: a `content: |` or `- |` near the end of a template that starts with a comment header.
 */
function losesFinalLineBreak(node: { range?: [number, number, number] | null | undefined }, context: Context): boolean {
  const range = node.range;
  if (!range) return false;
  const header = /^[^\n]*/.exec(context.text.slice(range[0]))?.[0] ?? "";
  const keep = header.replace(/#.*$/, "").includes("+");
  const end = range[0] + context.text.slice(range[0], range[1]).replace(/[ \t\n]+$/, "").length;
  const lineEnd = context.text.indexOf("\n", end);
  if (lineEnd === -1) return true;
  // The empty lines after the scalar belong to it; what counts is the line after them.
  const lines = context.text.slice(lineEnd + 1).split("\n");
  let blank = 0;
  while (blank < lines.length && (lines[blank] ?? "").replaceAll(" ", "") === "") blank += 1;
  const next = lines[blank];
  // The end of the file: Symfony and the YAML specification agree there.
  if (next === undefined) return false;
  if (blank > 0 && !keep) return false;
  if (lineBreaks(context.text.slice(0, end)) + blank < context.lastLine) return false;
  return !next.replace(/^ +/, "").startsWith("#");
}

function convert(node: unknown, context: Context, lastInCollection = false): PhpValue {
  if (node === null || node === undefined) return null;
  if (isAlias(node)) {
    const target = node.resolve(context.document);
    if (!target) throw new YamlParseError(`Reference "${node.source}" does not exist.`);
    if (isMap(target) || isSeq(target)) {
      context.aliases += 1;
      if (context.aliases > context.maxAliases) throw new YamlParseError("Too many aliases to collections.");
    }
    return convert(target, context);
  }
  if (isScalar(node)) {
    const text = typeof node.value === "string" ? node.value : "";
    const tag = node.tag;
    if (tag !== undefined && tag !== "?" && tag !== "!" && tag !== "tag:yaml.org,2002:str") {
      if (tag === "tag:yaml.org,2002:float") return new PhpFloat(Number.parseFloat(text));
      throw new YamlParseError(`The string "${text}" could not be parsed as it uses an unsupported built-in tag.`);
    }
    if (tag === "tag:yaml.org,2002:str" || tag === "!") return text;
    if (node.type === "PLAIN") {
      // Symfony does not read a plain scalar that continues after an empty line.
      if (text.includes("\n")) throw new YamlParseError("Unable to parse.");
      return evaluateScalar(text);
    }
    if ((node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED") && lastInCollection && text.endsWith("\n") && losesFinalLineBreak(node, context)) {
      return text.slice(0, -1);
    }
    return text;
  }
  if (isSeq(node)) {
    const list = new PhpArray();
    node.items.forEach((item, index) => list.push(convert(item, context, index === node.items.length - 1)));
    return list;
  }
  if (isMap(node)) {
    const data = new PhpArray();
    let allowOverwrite = false;
    for (const [index, pair] of node.items.entries()) {
      if (!isPair(pair)) continue;
      const { key, merge } = keyOf(pair.key, context);
      if (merge) {
        allowOverwrite = true;
        const merged = convert(pair.value, context);
        if (!(merged instanceof PhpArray)) throw new YamlParseError("YAML merge keys used with a scalar value instead of an array.");
        if (isSeq(pair.value)) {
          for (const item of merged.values()) {
            if (!(item instanceof PhpArray)) throw new YamlParseError("Merge items must be arrays.");
            union(data, item);
          }
        } else {
          union(data, merged);
        }
        continue;
      }
      if (data.has(key) && !allowOverwrite) throw new YamlParseError(`Duplicate key "${String(key)}" detected.`);
      data.set(key, convert(pair.value, context, index === node.items.length - 1));
    }
    return data;
  }
  throw new YamlParseError("Unsupported YAML node.");
}

function parseOnce(input: string, maxAliases: number): PhpValue {
  const source = input.replace(/\r\n|\r/g, "\n");
  const document = parseDocument(source, { schema: "failsafe", merge: false, uniqueKeys: false, version: "1.2", logLevel: "silent", prettyErrors: false });
  const error = document.errors[0];
  if (error) throw new YamlParseError(error.message);
  return convert(document.contents as Node | null, { document, aliases: 0, maxAliases, text: source, lastLine: lastLineThreshold(source) });
}

/** `joinComposeAnchorsToTheirKeys`: "key:\n  &name" becomes "key: &name". Only used after a failed parse. */
export function joinComposeAnchorsToTheirKeys(compose: string): string {
  return compose.replace(
    /^([ \t]*)((?:- )?[^\s#][^\n]*?:)[ \t]*(?:#[^\n]*)?\r?\n([ \t]+)(&[^\s#]+)[ \t]*(?:#[^\n]*)?\r?$/gm,
    (match: string, indent: string, key: string, anchorIndent: string, anchor: string) => (anchorIndent.length > indent.length ? `${indent}${key} ${anchor}` : match),
  );
}

/** Symfony's default alias limit, and the one Coolify allows for a Compose file. */
export const DEFAULT_MAX_ALIASES = 128;
export const MAX_DOCKER_COMPOSE_COLLECTION_ALIASES = 256;

/** `Yaml::parse`. Throws `YamlParseError`. */
export function parseYaml(source: string, maxAliases: number = DEFAULT_MAX_ALIASES): PhpValue {
  return parseOnce(source, maxAliases);
}

/** `parseDockerComposeYaml`. Throws `YamlParseError`. */
export function parseDockerComposeYaml(compose: string): PhpValue {
  const text = compose.replace(/^\ufeff/, "");
  try {
    return parseOnce(text, MAX_DOCKER_COMPOSE_COLLECTION_ALIASES);
  } catch (error) {
    const joined = joinComposeAnchorsToTheirKeys(text);
    if (joined === text) throw error;
    try {
      return parseOnce(joined, MAX_DOCKER_COMPOSE_COLLECTION_ALIASES);
    } catch {
      throw error;
    }
  }
}

// ---- dumping ----

const ESCAPEES = ["\\", "\\\\", '\\"', '"', ...Array.from({ length: 32 }, (_, code) => String.fromCharCode(code)), "\x7f", "\u0085", "\u00a0", "\u2028", "\u2029"];
const ESCAPED = [
  "\\\\", '\\"', "\\\\", '\\"',
  "\\0", "\\x01", "\\x02", "\\x03", "\\x04", "\\x05", "\\x06", "\\a",
  "\\b", "\\t", "\\n", "\\v", "\\f", "\\r", "\\x0e", "\\x0f",
  "\\x10", "\\x11", "\\x12", "\\x13", "\\x14", "\\x15", "\\x16", "\\x17",
  "\\x18", "\\x19", "\\x1a", "\\e", "\\x1c", "\\x1d", "\\x1e", "\\x1f",
  "\\x7f",
  "\\N", "\\_", "\\L", "\\P",
];
 
const REQUIRES_DOUBLE = /[\x00-\x1f]|\x7f|\u0085|\u00a0|\u2028|\u2029/;
const SINGLE_WORDS = new Set(["null", "~", "true", "false", "y", "n", "yes", "no", "on", "off", ".inf", ".nan", "..."]);
// PHP compiles a /u pattern with PCRE2_UCP, so its \s is Unicode white space: the separators (Z*), the
// control characters \t \n \v \f \r, U+0085 and U+180E - but not U+FEFF, which JavaScript's \s adds.
const REQUIRES_SINGLE = /[\t\n\v\f\r\u0085\u180e\p{Z}'":{}[\],&*#?]|^[-?|<>=!%@`\p{Zs}\ufeff]/u;

function escapeWithDoubleQuotes(value: string): string {
  let escaped = value;
  // PHP's str_replace with arrays replaces one pair after the other, each over the previous result.
  ESCAPEES.forEach((search, index) => {
    escaped = escaped.replaceAll(search, ESCAPED[index] ?? "");
  });
  return `"${escaped}"`;
}

function escapeWithSingleQuotes(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function isBinaryString(value: string): boolean {
  for (const byte of utf8(value)) {
    if (!(byte === 0x00 || (byte >= 0x07 && byte <= 0x0d) || byte === 0x1b || byte >= 0x20)) return true;
  }
  return false;
}

function base64(value: string): string {
  let binary = "";
  for (const byte of utf8(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function dumpFloat(value: number): string {
  if (Number.isNaN(value)) return ".NaN";
  let repr = phpFloatToString(value);
  if (!Number.isFinite(value)) return repr.replace("INF", ".Inf");
  if (Math.floor(value) === value && Number(repr) === value && !repr.includes("E")) repr += ".0";
  return repr;
}

function dumpString(value: string): string {
  if (isNumericString(value) && !/[\f\n\r\t\v]/.test(value)) return `'${value}'`;
  if (value === "") return "''";
  if (isBinaryString(value)) return `!!binary ${base64(value)}`;
  if (REQUIRES_DOUBLE.test(value)) return escapeWithDoubleQuotes(value);
  if (SINGLE_WORDS.has(value.toLowerCase()) || REQUIRES_SINGLE.test(value)) {
    const single = escapeWithSingleQuotes(value);
    if (!value.includes("'")) return single;
    const double = escapeWithDoubleQuotes(value);
    return utf8(double).length < utf8(single).length ? double : single;
  }
  if (/^[+-]?[0-9][0-9_]*(\.[0-9_]+)?$/.test(value) || /^[+-]?0o[0-7_]+$/.test(value) || HEX.test(value) || TIMESTAMP.test(value)) {
    return escapeWithSingleQuotes(value);
  }
  return value;
}

/** `Inline::dump`. */
export function dumpInline(value: PhpValue): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value instanceof PhpFloat) return dumpFloat(value.value);
  if (typeof value === "string") return dumpString(value);
  if (value.size > 0 && value.isList()) return `[${value.values().map(dumpInline).join(", ")}]`;
  if (value.size === 0) return "{}";
  return `{ ${value.entries().map(([key, item]) => `${dumpInline(key)}: ${dumpInline(item)}`).join(", ")} }`;
}

function doDump(input: PhpValue, inline: number, indent: number, indentation: number): string {
  const prefix = " ".repeat(indent);
  if (inline <= 0 || !(input instanceof PhpArray) || input.size === 0) return prefix + dumpInline(input);
  const asMap = !input.isList();
  let output = "";
  for (const [key, value] of input) {
    if (output !== "" && !output.endsWith("\n")) output += "\n";
    const willBeInlined = inline - 1 <= 0 || !(value instanceof PhpArray) || value.size === 0;
    output += `${prefix}${asMap ? `${dumpInline(key)}:` : "-"}${willBeInlined ? " " : "\n"}${doDump(value, inline - 1, willBeInlined ? 0 : indent + indentation, indentation)}${willBeInlined ? "\n" : ""}`;
  }
  return output;
}

/** `Yaml::dump($input, $inline, $indentation)` without flags. Coolify calls it with 10 and 2. */
export function dumpYaml(input: PhpValue, inline = 10, indentation = 2): string {
  return doDump(input, inline, 0, indentation);
}
