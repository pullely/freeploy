// API contract tests from Coolify's openapi.json (copied verbatim to
// parity/openapi.json), run against the reference and, when given, Freeploy.
//
//   node tools/parity/api/contract.ts --openapi specs/epics/freeploy-coolify-parity/parity/openapi.json \
//     --ref-base <url> --ref-token-env REFERENCE_TOKEN --ref-ids <ids.json> \
//     [--target-base <url> --target-token-env TARGET_TOKEN --target-ids <ids.json>] \
//     [--env-file <file>] [--report parity/api-report.json] [--gate <regex on operationId>]
//
// For every operation:
//   unauth  — called with no token; must answer as the reference does (401
//             for every authenticated route). Safe for every method: the
//             request is refused before any action.
//   read    — GET operations with path parameters filled from the fixture
//             ids; the response must match the documented status and schema,
//             and the target's response must have the same status and the
//             same shape (keys and types) as the reference's after
//             normalising ids and timestamps.
// Mutating operations (POST/PATCH/PUT/DELETE) are exercised by the behaviour
// scenarios that own them (DP5–DP11); here they get the unauth check only,
// and the report lists them as `mutating: pending`.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { validate, type Schema } from "./schema.ts";

type Json = unknown;
interface Op { operationId: string; method: string; path: string; params: string[]; responses: Record<string, { content?: Record<string, { schema?: Schema }>; $ref?: string }> }

export const PARAM_FOR_SEGMENT: Record<string, string> = {
  projects: "project_uuid",
  servers: "server_uuid",
  applications: "application_uuid",
  databases: "database_uuid",
  services: "service_uuid",
  "security/keys": "private_key_uuid",
  keys: "private_key_uuid",
  tags: "tag_uuid",
  deployments: "deployment_uuid",
  teams: "team_id",
  "github-apps": "github_app_id",
  "cloud-tokens": "cloud_token_uuid",
};

/** Map an openapi path's parameters to fixture names: a bare {uuid} takes the resource segment before it. */
export function fillPath(path: string, ids: Record<string, string>): { url: string | null; missing: string[] } {
  const missing: string[] = [];
  const segs = path.split("/");
  const out = segs.map((s, i) => {
    const m = s.match(/^\{(\w+)\}$/);
    if (!m) return s;
    let name = m[1];
    if (name === "uuid" || name === "id") {
      const prev2 = `${segs[i - 2]}/${segs[i - 1]}`;
      name = PARAM_FOR_SEGMENT[prev2] ?? PARAM_FOR_SEGMENT[segs[i - 1]] ?? `${segs[i - 1]}_${name}`;
    } else if (name === "environment_name_or_uuid") name = "environment_uuid";
    if (ids[name]) return ids[name];
    missing.push(name);
    return s;
  });
  return { url: missing.length ? null : out.join("/"), missing };
}

/** Shape of a JSON value: keys and primitive types, ids and times normalised away. */
export function shape(v: Json): Json {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, Json>)[k])]));
  return v === null ? "null" : typeof v;
}

function loadOps(file: string): { ops: Op[]; doc: Record<string, unknown> } {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const ops: Op[] = [];
  for (const [path, item] of Object.entries<Record<string, Op & { parameters?: Array<{ in: string; name: string }> }>>(doc.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      ops.push({
        operationId: op.operationId ?? `${method}${path}`,
        method: method.toUpperCase(),
        path,
        params: (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name),
        responses: op.responses ?? {},
      });
    }
  }
  return { ops, doc };
}

export const THROTTLED = 429;

async function call(base: string, method: string, path: string, token?: string): Promise<{ status: number; body: Json }> {
  let res: Response;
  // A 429 is never a contract answer: wait as told and retry, up to 5 times.
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(`${base.replace(/\/$/, "")}/api/v1${path}`, {
        method,
        headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      });
    } catch (e) {
      // A reset or refused connection is not a contract answer either: retry,
      // then record it as status 0 ("unreachable") and keep measuring.
      if (attempt >= 3) return { status: 0, body: `unreachable: ${(e as Error).message}` };
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.status !== THROTTLED || attempt >= 5) break;
    const wait = Math.min(60, Number(res.headers.get("retry-after")) || 2 ** attempt);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k: string, d?: string) => {
    const i = args.indexOf(`--${k}`);
    return i === -1 ? d : args[i + 1];
  };
  const envFile = opt("env-file");
  if (envFile && existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^'(.*)'$/, "$1");
    }
  }
  const { ops, doc } = loadOps(opt("openapi", "specs/epics/freeploy-coolify-parity/parity/openapi.json")!);
  const ref = { base: opt("ref-base")!, token: process.env[opt("ref-token-env", "REFERENCE_TOKEN")!], ids: JSON.parse(readFileSync(opt("ref-ids")!, "utf8")) };
  const tgt = opt("target-base")
    ? { base: opt("target-base")!, token: process.env[opt("target-token-env", "TARGET_TOKEN")!], ids: JSON.parse(readFileSync(opt("target-ids")!, "utf8")) }
    : null;
  const gate = opt("gate") ? new RegExp(opt("gate")!) : null;
  const rows: Array<Record<string, unknown>> = [];

  for (const op of ops) {
    const row: Record<string, unknown> = { operationId: op.operationId, method: op.method, path: op.path };
    const placeholder = op.path.replace(/\{\w+\}/g, "parity-nonexistent");
    // unauth
    const ru = await call(ref.base, op.method, placeholder);
    row.unauth = { reference: ru.status };
    if (tgt) {
      const tu = await call(tgt.base, op.method, placeholder);
      (row.unauth as Record<string, unknown>).target = tu.status;
      (row.unauth as Record<string, unknown>).pass = tu.status === ru.status;
    }
    // read
    if (op.method === "GET") {
      const { url, missing } = fillPath(op.path, ref.ids);
      if (!url) row.read = { status: "needs-fixture", missing };
      else {
        const r = await call(ref.base, "GET", url, ref.token);
        const declared = op.responses[String(r.status)];
        const schema = declared?.content?.["application/json"]?.schema;
        const errors = schema ? validate(r.body, schema, doc) : [];
        const read: Record<string, unknown> = { reference: r.status, documented: Boolean(declared), schemaErrors: errors.slice(0, 5) };
        if (tgt) {
          const tf = fillPath(op.path, tgt.ids);
          if (!tf.url) read.target = "needs-fixture";
          else {
            const t = await call(tgt.base, "GET", tf.url, tgt.token);
            read.target = t.status;
            read.shapeEqual = JSON.stringify(shape(t.body)) === JSON.stringify(shape(r.body));
            read.pass = t.status === r.status && read.shapeEqual === true;
          }
        }
        row.read = read;
      }
    } else row.mutating = "pending";
    row.pass = tgt ? Boolean((row.unauth as { pass?: boolean }).pass) && (op.method !== "GET" || (row.read as { pass?: boolean })?.pass === true) : null;
    rows.push(row);
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    operations: rows.length,
    target: tgt ? tgt.base : null,
    pass: rows.filter((r) => r.pass === true).length,
    referenceUndocumentedStatus: rows.filter((r) => (r.read as { documented?: boolean })?.documented === false).length,
    referenceSchemaErrors: rows.filter((r) => ((r.read as { schemaErrors?: string[] })?.schemaErrors ?? []).length).length,
    needsFixture: rows.filter((r) => (r.read as { status?: string })?.status === "needs-fixture").length,
    // Only the reference's answers decide whether the run measured anything;
    // a target that answers 429 is a target behaviour, reported, not fatal.
    throttled: rows.filter((r) => (r.unauth as { reference?: number })?.reference === THROTTLED || (r.read as { reference?: number })?.reference === THROTTLED).length,
    targetThrottled: rows.filter((r) => (r.unauth as { target?: number })?.target === THROTTLED || (r.read as { target?: unknown })?.target === THROTTLED).length,
    targetUnreachable: rows.filter((r) => (r.unauth as { target?: number })?.target === 0).length,
  };
  writeFileSync(opt("report", "specs/epics/freeploy-coolify-parity/parity/api-report.json")!, JSON.stringify({ summary, operations: rows }, null, 1) + "\n");
  console.log(`api: ${summary.operations} operations; target ${tgt ? `${summary.pass} pass` : "not set"}; ${summary.needsFixture} need fixtures`);
  // A throttled answer means the run measured the rate limiter, not the API.
  if (summary.throttled) {
    console.log(`✕ ${summary.throttled} operations were still answered 429 after retries; the run is not a measurement`);
    process.exit(1);
  }
  if (gate && tgt) {
    const failing = rows.filter((r) => gate.test(String(r.operationId)) && r.pass !== true);
    for (const r of failing) console.log(`✕ ${r.operationId}`);
    if (failing.length) process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
