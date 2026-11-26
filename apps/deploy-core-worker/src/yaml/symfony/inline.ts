// Derived from symfony/yaml@v8.1.11:Inline.php (parse, parseScalar, parseQuotedScalar, parseSequence,
// findEmbeddedMappingEnd, parseMapping, evaluateScalar, parseAnchor, parseTag, evaluateBinaryScalar) and Unescaper.php
// (MIT), modified.
//
// Symfony's reader of the inline syntax (flow collections, quoted and plain scalars), as Yaml::parse($yaml) runs it with
// no flags: no custom tags, objects, constants or DateTime values (`!php/object`, `!php/const` and `!php/enum` are null,
// as without PARSE_EXCEPTION_ON_INVALID_TYPE). The dumper is not here (compose/yaml.ts has the one Coolify uses). Strings
// are byte strings (php-string.ts); a plain scalar is typed by compose/yaml.ts's evaluateScalar(), the same rules.
import { PhpArray, PhpFloat, isNumeric, type PhpKey, type PhpValue } from "../../compose/php.js";
import { YamlParseError, evaluateScalar as evaluatePlainScalar } from "../../compose/yaml.js";
import { ParserState, SymfonyYamlParseException } from "./exception.js";
import { pregMatch, pregReplace } from "./pcre.js";
import { strcspn, strspn, substr, trim } from "./php-string.js";

export const REGEX_QUOTED_STRING = "(?:\"((?>[^\"\\\\]*)(?>(?:\\\\.(?>[^\"\\\\]*))*))\"|'((?>[^']*)(?>(?:''(?>[^']*))*))')";

/** Inline's static state: the line of the document being read (Parser sets it). */
export const inlineState = { parsedLineNumber: -1 };

export type References = Map<string, PhpValue>;

const fail = (message: string, snippet: string | null = null, line = inlineState.parsedLineNumber + 1) => new SymfonyYamlParseException(message, line, snippet);
const isCollection = (v: unknown): boolean => v instanceof PhpArray;

/** isset($array[$key]): present and not null. */
const isSet = (a: PhpArray, key: PhpKey): boolean => a.has(key) && a.get(key) !== null;

/** $a += $b: the keys of $b that $a lacks. */
export function arrayUnion(a: PhpArray, b: PhpArray): void {
  for (const [k, v] of b) if (!a.has(k)) a.set(k, v);
}

/** Inline::parse() */
export function inlineParse(input: string, references: References, state: ParserState): PhpValue {
  const value = trim(input);
  if (value === "") return "";
  const i = { at: 0 };
  // A tag: without PARSE_CUSTOM_TAGS parseTag() throws for any but the lone "!" (""), which leaves no TaggedValue.
  parseTag(value, i);
  let result: PhpValue;
  switch (value[i.at]) {
    case "[":
      result = parseSequence(state, value, i, references);
      i.at++;
      break;
    case "{":
      result = parseMapping(state, value, i, references);
      i.at++;
      break;
    default:
      result = parseScalar(value, null, i, true, references, { quoted: null }, state);
  }
  // some comments are allowed at the end
  const rest = substr(value, i.at);
  const left = pregReplace("\\s*#.*$", "A", rest, () => "", 1).result;
  if (phpTruthyString(left)) throw fail(`Unexpected characters near "${rest}".`, value);
  return result;
}

/** A string's truthiness: "" and "0" are false. */
export const phpTruthyString = (s: string): boolean => s !== "" && s !== "0";

/** Inline::parseScalar() */
export function parseScalar(scalar: string, delimiters: string[] | null, i: { at: number }, evaluate: boolean, references: References, isQuoted: { quoted: boolean | null }, state: ParserState): PhpValue {
  let output: string;
  if (scalar[i.at] === '"' || scalar[i.at] === "'") {
    isQuoted.quoted = true;
    output = parseQuotedScalar(scalar, i);
    if (delimiters !== null) {
      const j = i.at + strspn(scalar, " \n", i.at);
      if (j >= scalar.length) throw fail(`Unexpected end of line, expected one of "${delimiters.join("")}".`, scalar);
      if (!delimiters.includes(scalar[j]!)) throw fail(`Unexpected characters (${substr(scalar, i.at)}).`, scalar);
    }
    return output;
  }
  isQuoted.quoted = false;
  if (!delimiters || delimiters.length === 0) {
    output = substr(scalar, i.at);
    i.at += output.length;
    // remove comments
    const m = pregMatch("(?<![ \\t])(?>[ \\t]+)#", output);
    if (m) output = substr(output, 0, m.index);
  } else if (delimiters.join("").length === delimiters.length) {
    // the scalar ends at the first delimiter, which must come before any new line
    const characters = delimiters.join("");
    const length = strcspn(scalar, `${characters}\n`, i.at);
    if (i.at + length >= scalar.length || !characters.includes(scalar[i.at + length]!)) throw fail(`Malformed inline YAML string: "${scalar}".`);
    output = trim(substr(scalar, i.at, length));
    i.at += length;
  } else {
    const m = pregMatch(`(.*?)(${delimiters.join("|")})`, scalar, "A", i.at);
    if (!m) throw fail(`Malformed inline YAML string: "${scalar}".`);
    output = m[1] ?? "";
    i.at += output.length;
    output = trim(output);
  }
  // a non-quoted string cannot start with @ or ` (reserved) nor with a scalar indicator (| or >)
  if (phpTruthyString(output) && "@`|>%".includes(output[0]!)) throw fail(`The reserved indicator "${output[0]}" cannot start a plain scalar; you need to quote the scalar.`, output);
  if (evaluate) return evaluateScalar(state, output, references, isQuoted);
  return output;
}

/** Inline::parseQuotedScalar() */
function parseQuotedScalar(scalar: string, i: { at: number }): string {
  const m = pregMatch(REGEX_QUOTED_STRING, scalar, "A", i.at);
  if (!m) throw fail(`Malformed inline YAML string: "${substr(scalar, i.at)}".`, scalar);
  let output = m[0].slice(1, -1);
  output = scalar[i.at] === '"' ? unescapeDoubleQuotedString(output) : output.replaceAll("''", "'");
  i.at += m[0].length;
  return output;
}

/** Inline::parseSequence() */
function parseSequence(state: ParserState, sequence: string, i: { at: number }, references: References): PhpArray {
  state.enterNestingLevel(inlineState.parsedLineNumber + 1, null);
  const output = new PhpArray();
  const len = sequence.length;
  i.at++;
  try {
    let lastToken: "separator" | "value" | null = null;
    while (i.at < len) {
      const c = sequence[i.at]!;
      if (c === "]") return output;
      if (c === "," || c === " ") {
        if (c === "," && (lastToken === null || lastToken === "separator")) output.push(null);
        else if (c === ",") lastToken = "separator";
        i.at++;
        continue;
      }
      let tag = parseTag(sequence, i);
      const anchorRef = parseAnchor(sequence, i);
      if (anchorRef !== null && tag === null) tag = parseTag(sequence, i);
      if (anchorRef !== null && (i.at >= len || sequence[i.at] === "," || sequence[i.at] === "]")) {
        references.set(anchorRef, null);
        output.push(null);
        lastToken = "value";
        continue;
      }
      if (i.at >= len) break;
      let value: PhpValue;
      switch (sequence[i.at]) {
        case "[":
          value = parseSequence(state, sequence, i, references);
          break;
        case "{":
          value = parseMapping(state, sequence, i, references);
          break;
        default: {
          // a !php/const or !php/enum key of an embedded mapping is evaluated by parseMapping()
          const evaluate = tag === null && !pregMatch("!php\\/(?:const|enum) [^ ,\\]]+?(?<!:): +[^ ,\\]]", substr(sequence, i.at, strcspn(sequence, ",]", i.at)), "A");
          const offset = i.at;
          const quoted = { quoted: null as boolean | null };
          value = parseScalar(sequence, [",", "]"], i, evaluate, references, quoted, state);
          // the value can be an array if a reference has been resolved to an array var
          if (typeof value === "string" && !quoted.quoted && value.includes(": ")) {
            // embedded mapping, whose value can be a collection that spans several scalars
            value = `{${value}`;
            const end = findEmbeddedMappingEnd(sequence, offset);
            if (i.at < end) {
              value += substr(sequence, i.at, end - i.at);
              i.at = end;
            }
            value += "}";
            value = parseMapping(state, value, { at: 0 }, references);
          }
          i.at--;
        }
      }
      if (anchorRef !== null) references.set(anchorRef, value);
      output.push(value);
      lastToken = "value";
      i.at++;
    }
    throw fail(`Malformed inline YAML string: "${sequence}".`);
  } finally {
    state.leaveNestingLevel();
  }
}

/** Inline::findEmbeddedMappingEnd() */
function findEmbeddedMappingEnd(sequence: string, start0: number): number {
  const closingTags: string[] = [];
  const len = sequence.length;
  let i = start0;
  let start = i;
  while (i < len) {
    switch (sequence[i]) {
      case "[":
        closingTags.push("]");
        start = ++i;
        break;
      case "{":
        closingTags.push("}");
        start = ++i;
        break;
      case ",":
        if (closingTags.length === 0) return i;
        start = ++i;
        break;
      case "]":
      case "}":
        if (sequence[i] !== closingTags.pop()) return i;
        start = ++i;
        break;
      case '"':
      case "'":
      case "&":
      case "*": {
        // a plain scalar can contain quotes, anchors and aliases, so the tokens are split again from $start
        const end = i;
        for (i = start; i <= end && i < len; start = i) {
          const m = pregMatch("(?>(?:(?>[ \\t:]+)|\"(?>[^\"\\\\]*)(?>(?:\\\\.(?>[^\"\\\\]*))*)\"|'(?>[^']*)'|[&*](?>[^ \\t,\\[\\]{}]*)|[^ \\t:\"'&*,\\[\\]{}](?>[^:,\\[\\]{}]*)){1,100})", sequence, "As", i);
          if (m) {
            i += m[0].length;
            continue;
          }
          // an unterminated quoted string
          switch (sequence[i]) {
            case " ":
            case "\t":
            case ":":
              ++i;
              break;
            case '"':
            case "'": {
              const quotation = sequence[i];
              while (++i < len && quotation !== sequence[i]) {
                if (sequence[i] === "\\" && quotation === '"') ++i;
              }
              ++i;
              break;
            }
            case "&":
            case "*":
              i += 1 + strcspn(sequence, " \t,[]{}", i + 1);
              break;
            default:
              i += strcspn(sequence, ",:[]{}", i);
          }
        }
        break;
      }
      default:
        // spaces, colons and plain scalars
        i += strcspn(sequence, ",[]{}\"'&*", i);
    }
  }
  return len;
}

/** Inline::parseMapping() */
function parseMapping(state: ParserState, mapping: string, i: { at: number }, references: References): PhpArray {
  state.enterNestingLevel(inlineState.parsedLineNumber + 1, null);
  const output = new PhpArray();
  const len = mapping.length;
  i.at++;
  let allowOverwrite = false;
  try {
    outer: while (i.at < len) {
      switch (mapping[i.at]) {
        case " ":
        case ",":
        case "\n":
          i.at++;
          continue outer;
        case "}":
          return output;
      }
      // key
      const offsetBeforeKeyParsing = i.at;
      const isKeyQuoted = mapping[i.at] === '"' || mapping[i.at] === "'";
      let key = parseScalar(mapping, [":", " "], i, false, references, { quoted: null }, state) as string;
      if (offsetBeforeKeyParsing === i.at) throw fail("Missing mapping key.", mapping);
      const isKeyEvaluated = key === "!php/const" || key === "!php/enum";
      if (isKeyEvaluated) {
        key += ` ${parseScalar(mapping, ["(?<!:):(?!:)"], i, false, references, { quoted: null }, state) as string}`;
        const evaluated = evaluateScalar(state, key, references, { quoted: null });
        // Without PARSE_CONSTANT a constant is null.
        if (typeof evaluated !== "string" && typeof evaluated !== "number") throw fail(`${isNumeric(evaluated) ? "Numeric" : "Non-string"} keys are not supported. Quote your evaluable mapping keys instead.`, mapping);
        key = String(evaluated);
      }
      const colon = mapping.indexOf(":", i.at);
      if (colon === -1) break;
      i.at = colon;
      if (!isKeyQuoted && !isKeyEvaluated) {
        const evaluatedKey = evaluateScalar(state, key, references, { quoted: null });
        if (key !== "" && evaluatedKey !== key && (typeof evaluatedKey !== "string" || key[0] === "!") && !isInt(evaluatedKey)) {
          throw fail("Implicit casting of incompatible mapping keys to strings is not supported. Quote your evaluable mapping keys instead.", mapping);
        }
      }
      if (!isKeyQuoted && (i.at + 1 >= len || ![" ", ",", "[", "]", "{", "}", "\n"].includes(mapping[i.at + 1]!))) {
        throw fail('Colons must be followed by a space or an indication character (i.e. " ", ",", "[", "]", "{", "}").', mapping);
      }
      const isMergeKey = !isKeyQuoted && !isKeyEvaluated && key === "<<";
      if (isMergeKey) allowOverwrite = true;
      while (i.at < len) {
        if (mapping[i.at] === ":" || mapping[i.at] === " " || mapping[i.at] === "\n") {
          i.at++;
          continue;
        }
        let tag = parseTag(mapping, i);
        const anchorRef = parseAnchor(mapping, i);
        if (anchorRef !== null && tag === null) tag = parseTag(mapping, i);
        if (anchorRef !== null && (i.at >= len || [",", "}", "\n"].includes(mapping[i.at]!))) {
          references.set(anchorRef, null);
          if (!isMergeKey) {
            if (allowOverwrite || !isSet(output, key)) output.set(key, null);
            else throw fail(`Duplicate key "${String(key)}" detected.`, mapping);
          }
          continue outer;
        }
        if (i.at >= len) break;
        let value: PhpValue;
        switch (mapping[i.at]) {
          case "[":
            value = parseSequence(state, mapping, i, references);
            if (anchorRef !== null) references.set(anchorRef, value);
            if (isMergeKey) {
              for (const parsedValue of value.values()) {
                if (!(parsedValue instanceof PhpArray)) throw fail("Merge items must be arrays.", mapping);
                arrayUnion(output, parsedValue);
              }
            } else if (allowOverwrite || !isSet(output, key)) output.set(key, value);
            else throw fail(`Duplicate key "${key}" detected.`, mapping);
            break;
          case "{":
            value = parseMapping(state, mapping, i, references);
            if (anchorRef !== null) references.set(anchorRef, value);
            if (isMergeKey) arrayUnion(output, value);
            else if (allowOverwrite || !isSet(output, key)) output.set(key, value);
            else throw fail(`Duplicate key "${key}" detected.`, mapping);
            break;
          default:
            value = parseScalar(mapping, [",", "}", "\n"], i, tag === null, references, { quoted: null }, state);
            if (anchorRef !== null) references.set(anchorRef, value);
            if (isMergeKey) {
              if (!(value instanceof PhpArray)) throw fail("YAML merge keys used with a scalar value instead of an array.", mapping);
              arrayUnion(output, value);
            } else if (allowOverwrite || !isSet(output, key)) output.set(key, value);
            else throw fail(`Duplicate key "${key}" detected.`, mapping);
            i.at--;
        }
        i.at++;
        continue outer;
      }
    }
    throw fail(`Malformed inline YAML string: "${mapping}".`);
  } finally {
    state.leaveNestingLevel();
  }
}

const isInt = (v: PhpValue): boolean => (typeof v === "number" && Number.isInteger(v)) || typeof v === "bigint";

/** Inline::evaluateScalar() */
export function evaluateScalar(state: ParserState, input: string, references: References, isQuoted: { quoted: boolean | null }): PhpValue {
  isQuoted.quoted = false;
  const scalar = trim(input);
  if (scalar.startsWith("*")) {
    let value = scalar.slice(1);
    // remove comments
    const m = pregMatch("(?<![ \\t])(?>[ \\t]+)#", value);
    if (m) value = substr(value, 0, m.index);
    // an unquoted *
    if (value === "") throw fail("A reference must contain at least one character.", value);
    if (!references.has(value)) throw fail(`Reference "${value}" does not exist.`, value);
    state.countAlias(references.get(value), inlineState.parsedLineNumber + 1, null, isCollection);
    return references.get(value)!;
  }
  const lower = scalar.toLowerCase();
  if (lower === "null" || scalar === "" || scalar === "~") return null;
  if (lower === "true") return true;
  if (lower === "false") return false;
  if (scalar[0] === "!") {
    if (scalar === "!!str" || scalar === "!!binary") return "";
    if (scalar.startsWith("!!str ")) {
      let s = scalar.slice(6);
      if (s[0] === '"' || s[0] === "'") {
        isQuoted.quoted = true;
        s = parseQuotedScalar(s, { at: 0 });
      }
      return s;
    }
    if (scalar.startsWith("! ")) return scalar.slice(2);
    // !php/object, !php/const, !php/enum: no PARSE_OBJECT, PARSE_CONSTANT nor PARSE_EXCEPTION_ON_INVALID_TYPE.
    if (scalar.startsWith("!php/object") || scalar.startsWith("!php/const") || scalar.startsWith("!php/enum")) return null;
    if (scalar.startsWith("!!float ")) return new PhpFloat(phpFloatCast(scalar.slice(8)));
    if (scalar.startsWith("!!binary ")) return evaluateBinaryScalar(scalar.slice(9), references, state);
    throw new SymfonyYamlParseException(`The string "${scalar}" could not be parsed as it uses an unsupported built-in tag.`, inlineState.parsedLineNumber, scalar);
  }
  try {
    return evaluatePlainScalar(scalar);
  } catch (e) {
    if (e instanceof YamlParseError) throw fail(e.message, scalar);
    throw e;
  }
}

/** (float) $string: the leading number, 0 when there is none. */
function phpFloatCast(s: string): number {
  const m = /^[ \t\n\r\v\f]*([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/.exec(s);
  return m ? Number(m[1]) : 0;
}

/** Inline::parseAnchor() */
function parseAnchor(value: string, i: { at: number }): string | null {
  if (value[i.at] !== "&") return null;
  const m = pregMatch("&(?<ref>(?>[^ \\t,\\[\\]\\{\\}\\n]+))(?>\\s*)", value, "A", i.at);
  if (!m) return null;
  i.at += m[0].length;
  return m.groups.ref!;
}

/** Inline::parseTag() without PARSE_CUSTOM_TAGS: "" for a lone "!" before a value, null for a built-in tag left to evaluateScalar(). */
function parseTag(value: string, i: { at: number }): string | null {
  if (value[i.at] !== "!") return null;
  const tagLength = strcspn(value, " \t\n[]{},", i.at + 1);
  const tag = substr(value, i.at + 1, tagLength);
  let nextOffset = i.at + tagLength + 1;
  nextOffset += strspn(value, " ", nextOffset);
  if (tag === "" && (nextOffset >= value.length || ["]", "}", ","].includes(value[nextOffset]!))) {
    throw fail('Using the unquoted scalar value "!" is not supported. You must quote it.', value);
  }
  // Is followed by a scalar and is a built-in tag
  if (tag !== "" && (nextOffset >= value.length || !["[", "{"].includes(value[nextOffset]!)) && (tag[0] === "!" || ["str", "php/const", "php/enum", "php/object"].includes(tag))) {
    return null;
  }
  i.at = nextOffset;
  if (tag !== "" && tag[0] === "!") throw fail(`The built-in tag "!${tag}" is not implemented.`, value);
  if (tag === "") return tag;
  throw fail(`Tags support is not enabled. Enable the "Yaml::PARSE_CUSTOM_TAGS" flag to use "!${tag}".`, value);
}

/** Inline::evaluateBinaryScalar() */
export function evaluateBinaryScalar(scalar: string, references: References, state: ParserState): string {
  let data = pregReplace("\\s", "", scalar, () => "").result;
  if (data === "") return "";
  const parsed = parseScalar(data, null, { at: 0 }, true, references, { quoted: null }, state);
  if (parsed === "") return "";
  if (parsed instanceof PhpArray) throw fail('The "!!binary" tag only supports a base64 encoded string, got "array".', scalar);
  data = scalarToString(parsed);
  if (data.length % 4 !== 0) throw fail(`The normalized base64 encoded data (data without whitespace characters) length must be a multiple of four (${data.length} bytes given).`, scalar);
  if (!/^[A-Z0-9+/]+={0,2}$/i.test(data)) throw fail(`The base64 encoded data (${data}) contains invalid characters.`, scalar);
  return atob(data);
}

/** (string) of a scalar. */
function scalarToString(v: PhpValue): string {
  if (v === null || v === false) return "";
  if (v === true) return "1";
  if (v instanceof PhpFloat) return String(v.value);
  return String(v);
}

// ── Unescaper ──────────────────────────────────────────────────────────────

/** Unescaper::unescapeDoubleQuotedString(): `\\(x..|u....|U........|.)` with /u, so "." is a whole UTF-8 character. */
function unescapeDoubleQuotedString(value: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const c = value[i]!;
    if (c !== "\\" || i + 1 >= value.length) {
      out += c;
      i++;
      continue;
    }
    const rest = value.slice(i + 1);
    const hex = /^(?:x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/.exec(rest);
    let escape: string;
    if (hex) escape = `\\${hex[0]}`;
    else {
      const n = value.charCodeAt(i + 1);
      // "." does not match "\n".
      if (n === 0x0a) {
        out += c;
        i++;
        continue;
      }
      const width = n < 0x80 ? 1 : n >= 0xf0 ? 4 : n >= 0xe0 ? 3 : n >= 0xc0 ? 2 : 1;
      escape = value.slice(i, i + 1 + width);
    }
    out += unescapeCharacter(escape);
    i += escape.length;
  }
  return out;
}

function unescapeCharacter(value: string): string {
  switch (value[1]) {
    case "0":
      return "\0";
    case "a":
      return "\x07";
    case "b":
      return "\x08";
    case "t":
    case "\t":
      return "\t";
    case "n":
      return "\n";
    case "v":
      return "\x0b";
    case "f":
      return "\x0c";
    case "r":
      return "\r";
    case "e":
      return "\x1b";
    case " ":
      return " ";
    case '"':
      return '"';
    case "/":
      return "/";
    case "\\":
      return "\\";
    case "N":
      return "\xc2\x85";
    case "_":
      return "\xc2\xa0";
    case "L":
      return "\xe2\x80\xa8";
    case "P":
      return "\xe2\x80\xa9";
    case "x":
      return utf8chr(Number.parseInt(value.slice(2, 4), 16));
    case "u":
      return utf8chr(Number.parseInt(value.slice(2, 6), 16));
    case "U":
      return utf8chr(Number.parseInt(value.slice(2, 10), 16));
    default:
      throw new SymfonyYamlParseException(`Found unknown escape character "${value}".`);
  }
}

/** Unescaper::utf8chr(): the UTF-8 bytes of a code point. */
function utf8chr(code: number): string {
  const c = code % 0x200000;
  const ch = String.fromCharCode;
  if (c < 0x80) return ch(c);
  if (c < 0x800) return ch(0xc0 | (c >> 6)) + ch(0x80 | (c & 0x3f));
  if (c < 0x10000) return ch(0xe0 | (c >> 12)) + ch(0x80 | ((c >> 6) & 0x3f)) + ch(0x80 | (c & 0x3f));
  return ch(0xf0 | (c >> 18)) + ch(0x80 | ((c >> 12) & 0x3f)) + ch(0x80 | ((c >> 6) & 0x3f)) + ch(0x80 | (c & 0x3f));
}
