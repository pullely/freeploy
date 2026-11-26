// Derived from symfony/yaml@v8.1.11:Parser.php (MIT), modified — the preg_* calls of Parser.php and Inline.php.
//
// Symfony's patterns are PCRE; JavaScript's RegExp lacks possessive quantifiers and atomic groups, and differs in `$`,
// `\s` and `.`. The ported patterns are written as PCRE with possessive quantifiers spelled as atomic groups
// (`X++` as `(?>X+)`), and `pcre()` turns one into a RegExp that matches the same:
//
// - `(?>X)` becomes `(?=(X))\N`: a lookahead does not give back what it matched, so the group is atomic;
// - `$` (no /m) is PCRE's: the end of the subject or before a final "\n" (`(?=\n?(?![\s\S]))`); `\z` the very end;
// - `\s` is PCRE's ASCII class `[\t\n\v\f\r ]` (JavaScript's also takes U+00A0, a byte of UTF-8 text here);
// - `.` is any byte but "\n" (`[\s\S]` under /s);
// - `(?P<name>` is `(?<name>`.
//
// Subjects are byte strings (php-string.ts), so every class is a class of bytes, as PHP's preg_* without /u gives; the
// /u patterns of Symfony only use ASCII classes, whose match boundaries are the same over bytes.

const cache = new Map<string, RegExp>();

/** PCRE pattern (no delimiters) and flags ("m", "s", "i", "A" for anchored at the offset) → RegExp. */
export function pcre(source: string, flags = ""): RegExp {
  const key = `${flags}/${source}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const multiline = flags.includes("m");
  const dotAll = flags.includes("s");
  let out = "";
  // The capturing groups opened in `out` so far, to number the backreference of an atomic group.
  let groups = 0;
  const countGroup = (text: string, at: number): boolean => {
    if (text[at] !== "(") return false;
    if (text[at + 1] !== "?") return true;
    return text[at + 2] === "<" && text[at + 3] !== "=" && text[at + 3] !== "!";
  };

  function translate(src: string, start: number, stopAtClose: boolean): number {
    let i = start;
    // Groups opened inside an atomic group, so that their ")" does not end it.
    let depth = 0;
    while (i < src.length) {
      const c = src[i]!;
      if (c === "\\") {
        const n = src[i + 1]!;
        if (n === "s") out += "[\\t\\n\\v\\f\\r ]";
        else if (n === "S") out += "[^\\t\\n\\v\\f\\r ]";
        else if (n === "z") out += "(?![\\s\\S])";
        else out += c + n;
        i += 2;
        continue;
      }
      if (c === "[") {
        // A character class, copied with \s spelled out inside it.
        let j = i + 1;
        let cls = "[";
        if (src[j] === "^") {
          cls += "^";
          j++;
        }
        if (src[j] === "]") {
          cls += "\\]";
          j++;
        }
        while (j < src.length && src[j] !== "]") {
          if (src[j] === "\\") {
            const n = src[j + 1]!;
            cls += n === "s" ? "\\t\\n\\v\\f\\r " : `\\${n}`;
            j += 2;
          } else {
            cls += src[j];
            j++;
          }
        }
        out += `${cls}]`;
        i = j + 1;
        continue;
      }
      if (c === "(" && src.startsWith("(?>", i)) {
        const number = ++groups;
        out += "(?=(";
        i = translate(src, i + 3, true);
        out += `))\\${number}`;
        continue;
      }
      if (c === "(") {
        depth++;
        if (src.startsWith("(?P<", i)) {
          out += "(?<";
          groups++;
          i += 4;
          continue;
        }
        if (countGroup(src, i)) groups++;
        out += c;
        i++;
        continue;
      }
      if (c === ")") {
        if (stopAtClose && depth === 0) return i + 1;
        depth--;
        out += c;
        i++;
        continue;
      }
      if (c === "$") {
        out += multiline ? "(?=\\n|(?![\\s\\S]))" : "(?=\\n?(?![\\s\\S]))";
        i++;
        continue;
      }
      if (c === ".") {
        out += dotAll ? "[\\s\\S]" : "[^\\n]";
        i++;
        continue;
      }
      out += c;
      i++;
    }
    return i;
  }

  translate(source, 0, false);
  const re = new RegExp(out, `${multiline ? "m" : ""}${flags.includes("i") ? "i" : ""}${flags.includes("A") ? "y" : ""}${flags.includes("g") ? "g" : ""}`);
  cache.set(key, re);
  return re;
}

export interface PcreMatch {
  /** The whole match. */
  0: string;
  index: number;
  /** A group's text; undefined when it did not take part (PHP leaves out trailing groups that did not, and gives "" for others). */
  groups: Record<string, string | undefined>;
  [n: number]: string | undefined;
}

/** preg_match(): the first match from `offset`, or null. */
export function pregMatch(source: string, subject: string, flags = "", offset = 0): PcreMatch | null {
  const re = pcre(source, flags);
  re.lastIndex = offset;
  let m: RegExpExecArray | null;
  if (flags.includes("A")) m = re.exec(subject);
  else {
    // An unanchored search from an offset: a sticky-less RegExp searches from lastIndex only with /g.
    const g = pcre(source, `${flags}g`);
    g.lastIndex = offset;
    m = g.exec(subject);
  }
  if (!m) return null;
  const out = m as unknown as PcreMatch;
  out.groups = m.groups ?? {};
  return out;
}

/** preg_replace() of every match (or of the first `limit`). */
export function pregReplace(source: string, flags: string, subject: string, replacement: (m: RegExpExecArray) => string, limit = -1): { result: string; count: number } {
  const re = pcre(source, `${flags}g`);
  re.lastIndex = 0;
  let result = "";
  let last = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((limit < 0 || count < limit) && (m = re.exec(subject)) !== null) {
    result += subject.slice(last, m.index) + replacement(m);
    last = m.index + m[0].length;
    count++;
    if (m[0].length === 0) {
      if (re.lastIndex >= subject.length) break;
      // PCRE retries an empty match at the same place as non-empty first; Symfony's patterns never match empty twice in a row.
      result += subject[re.lastIndex] ?? "";
      last = re.lastIndex + 1;
      re.lastIndex++;
    }
  }
  return { result: result + subject.slice(last), count };
}
