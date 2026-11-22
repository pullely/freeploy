// A small structural validator for the subset of JSON Schema / OpenAPI 3.1
// Coolify's openapi.json uses: type (incl. arrays of types), nullable,
// properties, required, items, enum, $ref into components, oneOf/anyOf/allOf.
// It reports paths, not prose, so a report row says exactly what differs.
export interface Schema {
  type?: string | string[];
  nullable?: boolean;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  $ref?: string;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  additionalProperties?: boolean | Schema;
}

function deref(s: Schema, doc: unknown): Schema {
  let cur = s;
  for (let i = 0; cur.$ref && i < 20; i++) {
    const path = cur.$ref.replace(/^#\//, "").split("/");
    cur = path.reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], doc) as Schema;
    if (!cur) return {};
  }
  return cur;
}

const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

export function validate(value: unknown, schema: Schema, doc: unknown, at = "$"): string[] {
  const s = deref(schema, doc);
  if (s.allOf) return s.allOf.flatMap((x) => validate(value, x, doc, at));
  if (s.oneOf || s.anyOf) {
    const alts = (s.oneOf ?? s.anyOf)!;
    return alts.some((x) => validate(value, x, doc, at).length === 0) ? [] : [`${at}: matches none of ${alts.length} alternatives`];
  }
  const t = typeOf(value);
  if (value === null && (s.nullable || (Array.isArray(s.type) && s.type.includes("null")))) return [];
  if (s.type) {
    const allowed = Array.isArray(s.type) ? s.type : [s.type];
    const ok = allowed.includes(t) || (t === "integer" && allowed.includes("number"));
    if (!ok) return [`${at}: expected ${allowed.join("|")}, got ${t}`];
  }
  if (s.enum && !s.enum.includes(value)) return [`${at}: ${JSON.stringify(value)} not in enum`];
  const errs: string[] = [];
  if (t === "object" && s.properties) {
    const obj = value as Record<string, unknown>;
    for (const k of s.required ?? []) if (!(k in obj)) errs.push(`${at}.${k}: required`);
    for (const [k, sub] of Object.entries(s.properties)) if (k in obj) errs.push(...validate(obj[k], sub, doc, `${at}.${k}`));
  }
  if (t === "array" && s.items) (value as unknown[]).slice(0, 5).forEach((v, i) => errs.push(...validate(v, s.items!, doc, `${at}[${i}]`)));
  return errs;
}
