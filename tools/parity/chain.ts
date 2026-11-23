// Parse one Blueprint statement such as
//   $table->string('name', 100)->nullable()->default('x')->change();
// into { method, args, chain: [{ method, args }] }, respecting quotes and
// nested parentheses. Args are kept as PHP source text (trimmed), so a
// default of `false`, `'running'` or `DB::raw('now()')` survives verbatim.
export interface Call { method: string; args: string[] }
export interface Statement extends Call { chain: Call[] }

export function splitStatements(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    cur += c;
    if (q) {
      if (c === "\\") { cur += body[++i] ?? ""; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') q = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth <= 0) { out.push(cur.trim()); cur = ""; depth = 0; }
  }
  return out.filter((s) => s.startsWith("$table->"));
}

function splitArgs(src: string): string[] {
  const args: string[] = [];
  let cur = "";
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      cur += c;
      if (c === "\\") { cur += src[++i] ?? ""; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) { args.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

/** Parse "$table->a(x)->b(y)…" into calls. Returns null if it is not a call chain. */
export function parseChain(stmt: string): Statement | null {
  let s = stmt.replace(/;\s*$/, "").trim();
  if (!s.startsWith("$table")) return null;
  s = s.slice("$table".length);
  const calls: Call[] = [];
  while (s.startsWith("->")) {
    const m = s.match(/^->(\w+)\s*\(/);
    if (!m) return null;
    let i = m[0].length;
    let depth = 1;
    let q: string | null = null;
    for (; i < s.length && depth > 0; i++) {
      const c = s[i];
      if (q) {
        if (c === "\\") { i++; continue; }
        if (c === q) q = null;
        continue;
      }
      if (c === "'" || c === '"') q = c;
      else if (c === "(") depth++;
      else if (c === ")") depth--;
    }
    calls.push({ method: m[1], args: splitArgs(s.slice(m[0].length, i - 1)) });
    s = s.slice(i).trim();
  }
  if (!calls.length) return null;
  const [head, ...chain] = calls;
  return { ...head, chain };
}

/** A PHP string literal's value, or null if the arg is not a plain string literal. */
export function phpString(arg: string | undefined): string | null {
  const m = arg?.match(/^(['"])(.*)\1$/s);
  return m ? m[2].replace(/\\(['"\\])/g, "$1") : null;
}
