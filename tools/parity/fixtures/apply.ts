// Apply tools/parity/fixtures/*.json to one system (the reference Coolify or
// Freeploy stage) through its /api/v1, and write the captured ids.
//
//   node tools/parity/fixtures/apply.ts --base <url> --token-env <VAR> \
//     [--env-file <file>] --fixtures <json> --out <ids.json>
//
// The token is read from the environment (or the 0600 env file), never from
// the command line.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i === -1 ? undefined : args[i + 1];
};
const envFile = opt("env-file");
if (envFile) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const base = opt("base")!.replace(/\/$/, "");
const token = process.env[opt("token-env") ?? "PARITY_TOKEN"];
if (!token) throw new Error("no API token in the named environment variable");
const fixtures = JSON.parse(readFileSync(opt("fixtures")!, "utf8"));
const out = opt("out")!;

interface Step {
  name: string;
  method?: string;
  path?: string;
  body?: unknown;
  find?: { path: string; where: Record<string, unknown> };
  capture?: Record<string, string>;
  optional?: boolean;
}

// Literal route parameters that name a kind rather than an object
// (`/servers/new/{type}`, `/settings/oauth/{provider}`) come from `constants`.
const ids: Record<string, string> = { ...(fixtures.constants ?? {}) };

function generatedKey(): string {
  const dir = mkdtempSync(join(tmpdir(), "parity-key-"));
  try {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "parity@example.com", "-f", join(dir, "k")]);
    return readFileSync(join(dir, "k"), "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function subst<T>(v: T): T {
  const s = JSON.stringify(v).replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (k === "generated_ed25519") return JSON.stringify(generatedKey()).slice(1, -1);
    if (!(k in ids)) throw new Error(`fixture value {{${k}}} is not captured yet`);
    return ids[k];
  });
  return JSON.parse(s);
}

const pick = (obj: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, json };
}

for (const raw of fixtures.steps as Step[]) {
  const step = subst(raw);
  let result: unknown;
  if (step.find) {
    const { status, json } = await call("GET", step.find.path);
    if (status >= 400) throw new Error(`${step.name}: GET ${step.find.path} → ${status}`);
    const list = Array.isArray(json) ? json : ((json as { data?: unknown[] }).data ?? []);
    // An empty `where` takes the first element.
    result = list.find((o) => Object.entries(step.find!.where).every(([k, v]) => (o as Record<string, unknown>)[k] === v));
    if (!result) throw new Error(`${step.name}: nothing in ${step.find.path} matches ${JSON.stringify(step.find.where)}`);
  } else {
    const { status, json } = await call(step.method ?? "POST", step.path!, step.body);
    if (status >= 400) {
      if (step.optional) {
        console.log(`· ${step.name}: ${status} (optional, skipped)`);
        continue;
      }
      throw new Error(`${step.name}: ${step.method} ${step.path} → ${status} ${JSON.stringify(json).slice(0, 300)}`);
    }
    result = json;
  }
  for (const [k, path] of Object.entries(step.capture ?? {})) {
    const v = pick(result, path);
    if (typeof v !== "string" && typeof v !== "number") throw new Error(`${step.name}: no ${path} in the response`);
    ids[k] = String(v);
  }
  console.log(`✓ ${step.name}`);
}
writeFileSync(out, JSON.stringify(ids, null, 2) + "\n", { mode: 0o600 });
