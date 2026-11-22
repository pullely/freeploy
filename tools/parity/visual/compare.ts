// Compare the target's captures with the reference's: pixels (pixelmatch) and
// DOM/copy (exact, after brand/id/time normalisation). Writes
// parity/visual-report.json and side-by-side diff images.
//
//   node tools/parity/visual/compare.ts [--out tools/parity/out] \
//     [--report specs/epics/freeploy-coolify-parity/parity/visual-report.json] \
//     [--gate <regex on route id>]
//
// The gate (section 4.4): ≤ 0.5% differing pixels per screenshot AND an exact
// DOM/copy match. With --gate, routes whose id matches the regex must pass or
// the process exits 1. A route the target did not render counts as failing.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

export const PIXEL_GATE = 0.005; // fraction of differing pixels

export interface ShotResult {
  shot: string;
  diffPixels: number;
  totalPixels: number;
  diffRatio: number;
  sizeMismatch: boolean;
  dom: { equal: boolean; missingText: string[]; extraText: string[]; fieldDiff: number };
  pass: boolean;
}

/** Pad an image to w×h with opaque magenta so a size difference counts as difference. */
function pad(img: PNG, w: number, h: number): PNG {
  if (img.width === w && img.height === h) return img;
  const out = new PNG({ width: w, height: h });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255;
    out.data[i + 1] = 0;
    out.data[i + 2] = 255;
    out.data[i + 3] = 255;
  }
  PNG.bitblt(img, out, 0, 0, Math.min(img.width, w), Math.min(img.height, h), 0, 0);
  return out;
}

export function comparePng(refBuf: Buffer, tgtBuf: Buffer): { diffPixels: number; totalPixels: number; sizeMismatch: boolean; diff: PNG } {
  const a = PNG.sync.read(refBuf);
  const b = PNG.sync.read(tgtBuf);
  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);
  const diff = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(pad(a, w, h).data, pad(b, w, h).data, diff.data, w, h, { threshold: 0.1, includeAA: false });
  return { diffPixels, totalPixels: w * h, sizeMismatch: a.width !== b.width || a.height !== b.height, diff };
}

interface Dom { title: string; text: string[]; fields: Array<{ tag: string; type: string | null; name: string | null; label: string }> }

export function compareDom(ref: Dom, tgt: Dom) {
  const tset = new Set(tgt.text);
  const rset = new Set(ref.text);
  const missingText = ref.text.filter((t) => !tset.has(t));
  const extraText = tgt.text.filter((t) => !rset.has(t));
  const key = (f: Dom["fields"][number]) => `${f.tag}|${f.type}|${f.name}|${f.label}`;
  const rf = ref.fields.map(key).sort();
  const tf = tgt.fields.map(key).sort();
  let fieldDiff = Math.abs(rf.length - tf.length);
  for (let i = 0; i < Math.min(rf.length, tf.length); i++) if (rf[i] !== tf[i]) fieldDiff++;
  const equal = ref.title === tgt.title && !missingText.length && !extraText.length && fieldDiff === 0;
  return { equal, missingText: missingText.slice(0, 20), extraText: extraText.slice(0, 20), fieldDiff };
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k: string, d?: string) => {
    const i = args.indexOf(`--${k}`);
    return i === -1 ? d : args[i + 1];
  };
  const out = opt("out", "tools/parity/out")!;
  const reportFile = opt("report", "specs/epics/freeploy-coolify-parity/parity/visual-report.json")!;
  const gate = opt("gate") ? new RegExp(opt("gate")!) : null;
  const refDir = join(out, "reference");
  const tgtDir = join(out, "target");
  const diffDir = join(out, "diff");
  const routes: Array<{ id: string; status: "pass" | "fail" | "missing"; shots: ShotResult[]; worstRatio: number }> = [];
  const target = existsSync(join(tgtDir, "capture.json")) ? JSON.parse(readFileSync(join(tgtDir, "capture.json"), "utf8")) : null;

  for (const id of existsSync(refDir) ? readdirSync(refDir).filter((d) => !d.endsWith(".json")) : []) {
    const shots: ShotResult[] = [];
    let missing = false;
    for (const f of readdirSync(join(refDir, id)).filter((x) => x.endsWith(".png"))) {
      const shot = f.replace(/\.png$/, "");
      const tgtPng = join(tgtDir, id, f);
      if (!existsSync(tgtPng)) {
        missing = true;
        continue;
      }
      const px = comparePng(readFileSync(join(refDir, id, f)), readFileSync(tgtPng));
      const refDom = JSON.parse(readFileSync(join(refDir, id, `${shot}.dom.json`), "utf8"));
      const tgtDom = existsSync(join(tgtDir, id, `${shot}.dom.json`)) ? JSON.parse(readFileSync(join(tgtDir, id, `${shot}.dom.json`), "utf8")) : { title: "", text: [], fields: [] };
      const dom = compareDom(refDom, tgtDom);
      const diffRatio = px.diffPixels / px.totalPixels;
      if (px.diffPixels) {
        mkdirSync(join(diffDir, id), { recursive: true });
        writeFileSync(join(diffDir, id, f), PNG.sync.write(px.diff));
      }
      shots.push({ shot, diffPixels: px.diffPixels, totalPixels: px.totalPixels, diffRatio, sizeMismatch: px.sizeMismatch, dom, pass: diffRatio <= PIXEL_GATE && dom.equal });
    }
    const status = missing || !shots.length ? "missing" : shots.every((s) => s.pass) ? "pass" : "fail";
    routes.push({ id, status, shots, worstRatio: Math.max(0, ...shots.map((s) => s.diffRatio)) });
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    gate: { pixelRatio: PIXEL_GATE, dom: "exact" },
    target: target ? { base: target.base, captured: target.captured.length, skipped: target.skipped.length } : null,
    routes: routes.length,
    pass: routes.filter((r) => r.status === "pass").length,
    fail: routes.filter((r) => r.status === "fail").length,
    missing: routes.filter((r) => r.status === "missing").length,
  };
  writeFileSync(reportFile, JSON.stringify({ summary, routes: routes.sort((a, b) => a.id.localeCompare(b.id)) }, null, 1) + "\n");
  console.log(`visual: ${summary.pass} pass, ${summary.fail} fail, ${summary.missing} missing of ${summary.routes} reference routes`);

  if (gate) {
    const failing = routes.filter((r) => gate.test(r.id) && r.status !== "pass");
    for (const r of failing) console.log(`✕ ${r.id}: ${r.status}${r.status === "fail" ? ` (worst ${(r.worstRatio * 100).toFixed(2)}%)` : ""}`);
    if (failing.length) process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
