// Command goldens (DP1). Compares:
//   1. the reference's fresh output ($OUT/goldens.reference.json, from emit.sh)
//      with the committed goldens.json — a difference means the reference is not
//      deterministic or the cases changed, and fails the run;
//   2. every registered TypeScript port (ports.ts) with the committed golden,
//      byte for byte for strings, structurally for arrays and objects.
//
//   node tools/parity/commands/check.ts [--reference $OUT/goldens.reference.json] \
//     [--goldens tools/parity/commands/goldens.json] [--report <file>] [--gate <regex>] [--write]
//
// --write replaces goldens.json with the reference's output (used once, when
// a case is added, in the PR that adds it).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PORTS, type Port } from "./ports.ts";

interface Golden { ok: boolean; type?: string; value?: unknown; error?: string }
interface Case { id: string; fn: string; args: unknown[] }

export function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function checkPorts(cases: Case[], goldens: Record<string, Golden>, ports: Record<string, Port>) {
  return cases.map((c) => {
    const g = goldens[c.id];
    const port = ports[c.fn];
    if (!g) return { id: c.id, fn: c.fn, status: "no-golden" as const };
    if (!port) return { id: c.id, fn: c.fn, status: "pending" as const };
    try {
      const got = (port as (...a: unknown[]) => unknown)(...c.args);
      if (!g.ok) return { id: c.id, fn: c.fn, status: "fail" as const, detail: `reference threw (${g.error}); port returned` };
      return equal(got, g.value)
        ? { id: c.id, fn: c.fn, status: "verified" as const }
        : { id: c.id, fn: c.fn, status: "fail" as const, detail: `expected ${JSON.stringify(g.value).slice(0, 200)} got ${JSON.stringify(got).slice(0, 200)}` };
    } catch (e) {
      return g.ok
        ? { id: c.id, fn: c.fn, status: "fail" as const, detail: `port threw ${(e as Error).message}` }
        : { id: c.id, fn: c.fn, status: "verified" as const };
    }
  });
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k: string, d?: string) => {
    const i = args.indexOf(`--${k}`);
    return i === -1 ? d : args[i + 1];
  };
  const dir = new URL(".", import.meta.url).pathname;
  const goldensFile = opt("goldens", `${dir}goldens.json`)!;
  const refFile = opt("reference");
  const cases: Case[] = JSON.parse(readFileSync(`${dir}cases.json`, "utf8")).cases;
  let failed = false;

  if (refFile && existsSync(refFile)) {
    const fresh: Record<string, Golden> = JSON.parse(readFileSync(refFile, "utf8"));
    if (args.includes("--write")) {
      writeFileSync(goldensFile, JSON.stringify(fresh, null, 2) + "\n");
      console.log(`wrote ${Object.keys(fresh).length} goldens`);
    } else if (existsSync(goldensFile)) {
      const committed: Record<string, Golden> = JSON.parse(readFileSync(goldensFile, "utf8"));
      const drift = cases.map((c) => c.id).filter((id) => !equal(fresh[id], committed[id]));
      if (drift.length) {
        failed = true;
        for (const id of drift) console.log(`✕ reference output differs from the committed golden: ${id}`);
      } else console.log(`reference reproduces all ${cases.length} committed goldens`);
    }
  }
  if (!existsSync(goldensFile)) {
    console.log("no committed goldens yet");
    process.exit(failed ? 1 : 0);
  }
  const goldens: Record<string, Golden> = JSON.parse(readFileSync(goldensFile, "utf8"));
  const missing = cases.filter((c) => !goldens[c.id]);
  if (missing.length) {
    failed = true;
    console.log(`✕ ${missing.length} cases have no committed golden`);
  }
  const rows = checkPorts(cases, goldens, PORTS);
  const count = (s: string) => rows.filter((r) => r.status === s).length;
  const summary = { cases: rows.length, verified: count("verified"), fail: count("fail"), pending: count("pending"), referenceErrors: Object.values(goldens).filter((g) => !g.ok).length };
  writeFileSync(opt("report", "specs/epics/freeploy-coolify-parity/parity/commands-report.json")!, JSON.stringify({ summary, rows }, null, 1) + "\n");
  console.log(`commands: ${summary.verified} verified, ${summary.fail} fail, ${summary.pending} pending of ${summary.cases}`);
  for (const r of rows.filter((x) => x.status === "fail")) console.log(`✕ ${r.id}: ${"detail" in r ? r.detail : ""}`);
  const gate = opt("gate") ? new RegExp(opt("gate")!) : null;
  if (rows.some((r) => r.status === "fail")) failed = true;
  if (gate && rows.some((r) => gate.test(r.id) && r.status !== "verified")) failed = true;
  process.exit(failed ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
