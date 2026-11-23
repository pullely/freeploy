// Unroll migration loops of the form
//   foreach (<SOURCE> as $t) { … Schema::table($t, function (…) { … }) … }
//   foreach (<SOURCE> as $t => [$col, $default]) { … }
// into one literal block per table, so the schema fold sees every table a
// migration touches. SOURCE is a literal array, $this->name, self::NAME,
// static::NAME, or a local $name = [...] in the same file.

/** Index just past the bracket that closes the one at `open`. */
function matchClose(src: string, open: number): number {
  const pair: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const opener = src[open]!;
  const close = pair[opener]!;
  let depth = 0;
  let q: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i]!;
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === opener) depth++;
    else if (c === close && --depth === 0) return i + 1;
  }
  return -1;
}

type Entry = { key: string; values: string[] };

/** Parse a PHP array literal of strings, or of 'key' => [v1, v2] / 'key' => v entries. */
export function parsePhpArray(lit: string): Entry[] {
  const body = lit.trim().replace(/^\[/, "").replace(/\]$/, "");
  const out: Entry[] = [];
  let depth = 0;
  let i = 0;
  // Walk top-level entries separated by commas.
  const entries: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (; i < body.length; i++) {
    const c = body[i]!;
    if (q) {
      cur += c;
      if (c === "\\") { cur += body[++i] ?? ""; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "[" || c === "(") depth++;
    if (c === "]" || c === ")") depth--;
    if (c === "," && depth === 0) { entries.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) entries.push(cur.trim());
  for (const e of entries) {
    const m = e.match(/^(['"])([\w.-]+)\1\s*(?:=>\s*([\s\S]+))?$/);
    if (!m) continue;
    const v = m[3]?.trim();
    const values = v ? (v.startsWith("[") ? v.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean) : [v]) : [];
    out.push({ key: m[2]!, values });
  }
  return out;
}

function arraySources(src: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /(?:(?:private|protected|public)\s+(?:static\s+)?(?:array\s+)?\$(\w+)|(?:(?:private|protected|public)\s+)?const\s+(\w+)|\$(\w+))\s*=\s*\[/g;
  for (const m of src.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    const end = matchClose(src, open);
    if (end < 0) continue;
    const lit = src.slice(open, end);
    if (m[1]) map.set(`$this->${m[1]}`, lit);
    if (m[2]) {
      map.set(`self::${m[2]}`, lit);
      map.set(`static::${m[2]}`, lit);
    }
    if (m[3]) map.set(`$${m[3]}`, lit);
  }
  return map;
}

export function expandLoops(src: string): string {
  const sources = arraySources(src);
  let out = "";
  let at = 0;
  const re = /foreach\s*\(/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchClose(src, parenOpen);
    if (parenClose < 0) continue;
    const head = src.slice(parenOpen + 1, parenClose - 1);
    const hm = head.match(/^\s*([\s\S]+?)\s+as\s+\$(\w+)(?:\s*=>\s*\[([^\]]*)\])?\s*$/);
    if (!hm) continue;
    const bodyOpen = src.indexOf("{", parenClose);
    if (bodyOpen < 0) continue;
    const bodyClose = matchClose(src, bodyOpen);
    if (bodyClose < 0) continue;
    const body = src.slice(bodyOpen + 1, bodyClose - 1);
    const varName = hm[2]!;
    if (!new RegExp(`Schema::(?:create|table)\\(\\s*\\$${varName}\\b`).test(body)) continue;
    const srcExpr = hm[1]!.trim();
    const lit = srcExpr.startsWith("[") ? srcExpr : sources.get(srcExpr);
    if (!lit) continue;
    const destructured = (hm[3] ?? "").split(",").map((v) => v.trim().replace(/^\$/, "")).filter(Boolean);
    const copies = parsePhpArray(lit).map((e) => {
      let b = body.replace(new RegExp(`\\$${varName}\\b`, "g"), `'${e.key}'`);
      destructured.forEach((v, k) => {
        const val = e.values[k];
        if (val !== undefined) b = b.replace(new RegExp(`\\$${v}\\b`, "g"), val);
      });
      return b;
    });
    out += src.slice(at, m.index) + copies.join("\n");
    at = bodyClose;
    re.lastIndex = bodyClose;
  }
  return out + src.slice(at);
}
