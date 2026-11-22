// Capture every visual route of one system — the reference Coolify or
// Freeploy — as screenshots and a DOM/copy extract.
//
//   node tools/parity/visual/capture.ts --system reference|target --base <url> \
//     --env-file <file> --user-env <VAR> --password-env <VAR> --ids <ids.json> \
//     [--routes specs/epics/freeploy-coolify-parity/parity/routes.web.json] \
//     [--only <regex on route id>] [--out tools/parity/out]
//
// For each GET route that renders a page (routes.web.json `visual: true`), at
// desktop 1440×900 and mobile 390×844, light and dark, it writes
//   <out>/<system>/<route-id>/<viewport>-<theme>.png
//   <out>/<system>/<route-id>/<viewport>-<theme>.dom.json
// and <out>/<system>/capture.json listing what was captured and what was
// skipped (an unresolved path parameter is a missing fixture, not a pass).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { prepareMasks, MASK_SELECTOR } from "./masks.ts";
import { resolvePath, safeId } from "./paths.ts";

const args = process.argv.slice(2);
const opt = (k: string, d?: string) => {
  const i = args.indexOf(`--${k}`);
  return i === -1 ? d : args[i + 1];
};
const envFile = opt("env-file");
if (envFile) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^'(.*)'$/, "$1");
  }
}
const system = opt("system", "reference")!;
const base = opt("base")!.replace(/\/$/, "");
const email = process.env[opt("user-env", "REFERENCE_EMAIL")!];
const password = process.env[opt("password-env", "REFERENCE_PASSWORD")!];
const ids: Record<string, string> = opt("ids") ? JSON.parse(readFileSync(opt("ids")!, "utf8")) : {};
const routesFile = opt("routes", "specs/epics/freeploy-coolify-parity/parity/routes.web.json")!;
const only = opt("only") ? new RegExp(opt("only")!) : null;
const outDir = join(opt("out", "tools/parity/out")!, system);

export const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } } as const;
export const THEMES = ["light", "dark"] as const;

interface RouteRow { id: string; path: string; method: string; visual: boolean; name: string | null; middleware: string[] }

async function login(page: Page) {
  if (!email || !password) throw new Error("no credentials for " + system);
  await page.goto(`${base}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 }), page.click('button[type="submit"]')]);
}

async function domExtract(page: Page) {
  return page.evaluate(() => {
    const norm = (s: string) =>
      s
        .replace(/\b(Coolify Cloud|Coolify|Freeploy)\b/g, "PRODUCT")
        .replace(/\b[a-z0-9]{20,32}\b/g, "<id>")
        .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
        .replace(/\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?\S*/g, "<time>")
        .replace(/\b\d+ (seconds?|minutes?|hours?|days?) ago\b/g, "<ago>");
    const text = (document.body.innerText || "").split("\n").map((l) => norm(l.trim())).filter(Boolean);
    const fields = [...document.querySelectorAll("input, select, textarea, button")].map((el) => {
      const e = el as HTMLInputElement;
      return {
        tag: e.tagName.toLowerCase(),
        type: e.getAttribute("type") ?? null,
        name: e.getAttribute("name") ?? e.getAttribute("wire:model") ?? e.getAttribute("wire:model.live") ?? e.id ?? null,
        label: norm((e.labels?.[0]?.innerText ?? e.getAttribute("aria-label") ?? e.getAttribute("placeholder") ?? "").trim()),
        disabled: e.disabled ?? false,
      };
    });
    return { title: norm(document.title), text, fields };
  });
}

async function main() {
  const routes: RouteRow[] = JSON.parse(readFileSync(routesFile, "utf8")).rows;
  const targets = routes.filter((r) => r.visual && r.method === "GET" && (!only || only.test(r.id)));
  const browser = await chromium.launch();
  const captured: Array<{ id: string; dir: string; url: string; shots: string[]; status: number | null }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  try {
    for (const theme of THEMES) {
      for (const [vp, size] of Object.entries(VIEWPORTS)) {
        const ctx = await browser.newContext({ viewport: size, deviceScaleFactor: 1, reducedMotion: "reduce", timezoneId: "UTC", locale: "en-US" });
        await ctx.addInitScript((t) => {
          try {
            localStorage.setItem("theme", t);
          } catch {
            /* storage blocked */
          }
        }, theme);
        const page = await ctx.newPage();
        await login(page);
        for (const r of targets) {
          const { url, missing } = resolvePath(r.path, ids);
          if (!url) {
            if (theme === "light" && vp === "desktop") skipped.push({ id: r.id, reason: `missing fixture: ${missing.join(", ")}` });
            continue;
          }
          const dir = join(outDir, safeId(r.id));
          mkdirSync(dir, { recursive: true });
          let status: number | null = null;
          try {
            const res = await page.goto(base + url, { waitUntil: "networkidle", timeout: 45_000 });
            status = res?.status() ?? null;
            await page.waitForTimeout(400);
            await prepareMasks(page);
            const file = join(dir, `${vp}-${theme}.png`);
            await page.screenshot({ path: file, fullPage: true, animations: "disabled", mask: [page.locator(MASK_SELECTOR)], maskColor: "#ff00ff" });
            writeFileSync(join(dir, `${vp}-${theme}.dom.json`), JSON.stringify(await domExtract(page), null, 1));
            const entry = captured.find((c) => c.id === r.id) ?? captured[captured.push({ id: r.id, dir: safeId(r.id), url, shots: [], status }) - 1];
            entry.shots.push(`${vp}-${theme}`);
          } catch (e) {
            if (theme === "light" && vp === "desktop") skipped.push({ id: r.id, reason: `error: ${(e as Error).message.split("\n")[0]}` });
          }
        }
        await ctx.close();
      }
    }
  } finally {
    await browser.close();
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "capture.json"), JSON.stringify({ system, base, captured, skipped }, null, 1));
  console.log(`${system}: ${captured.length} routes captured, ${skipped.length} skipped`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
