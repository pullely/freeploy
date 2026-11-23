// Behaviour scenarios (DP1). Each scenario drives one system through its
// /api/v1 the way a user would, then reads the resulting state on the server
// that system manages — `docker ps` / `docker inspect` of the resource's
// containers — normalised so two systems can be compared field by field.
//
//   node tools/parity/behaviour/run.ts --system reference --base <url> --token-env REFERENCE_TOKEN \
//     --ids <ids.json> --docker local [--env-file <file>] [--only <regex>] [--out tools/parity/out]
//
// `--docker local` reads Docker on this machine: the reference Coolify manages
// its own host (the CI runner) as the `localhost` server. For Freeploy the
// server is a throwaway test VM (WAITING.md W1), read over SSH:
// `--docker ssh://user@host` with the key in TARGET_SSH_KEY_FILE.
//
// Writes <out>/behaviour/<system>/<scenario>.json; compare.ts diffs the two.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS, type Ctx } from "./scenarios.ts";

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
const system = opt("system", "reference")!;
const base = opt("base")!.replace(/\/$/, "");
const token = process.env[opt("token-env", "REFERENCE_TOKEN")!];
const ids = JSON.parse(readFileSync(opt("ids")!, "utf8"));
const dockerTarget = opt("docker", "local")!;
const only = opt("only") ? new RegExp(opt("only")!) : null;
const outDir = join(opt("out", "tools/parity/out")!, "behaviour", system);
mkdirSync(outDir, { recursive: true });

function docker(argv: string[]): string {
  if (dockerTarget === "local") return execFileSync("docker", argv, { encoding: "utf8" });
  const m = dockerTarget.match(/^ssh:\/\/(.+)$/);
  if (!m) throw new Error(`unknown --docker ${dockerTarget}`);
  const key = process.env.TARGET_SSH_KEY_FILE;
  return execFileSync("ssh", [...(key ? ["-i", key] : []), "-o", "StrictHostKeyChecking=accept-new", m[1], "docker", ...argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`)], { encoding: "utf8" });
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, json: JSON.parse(text) };
  } catch {
    return { status: res.status, json: text };
  }
}

const ctx: Ctx = { ids, api, docker, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
let failed = 0;
for (const s of SCENARIOS.filter((x) => !only || only.test(x.id))) {
  const started = Date.now();
  try {
    const result = await s.run(ctx);
    writeFileSync(join(outDir, `${s.id}.json`), JSON.stringify({ id: s.id, ok: true, seconds: Math.round((Date.now() - started) / 1000), result }, null, 1));
    console.log(`✓ ${s.id} (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (e) {
    failed++;
    writeFileSync(join(outDir, `${s.id}.json`), JSON.stringify({ id: s.id, ok: false, error: (e as Error).message }, null, 1));
    console.log(`✕ ${s.id}: ${(e as Error).message}`);
  }
}
process.exit(failed && system === "reference" ? 1 : 0);
