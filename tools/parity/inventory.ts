// Parity inventory generator for the freeploy-coolify-parity epic (DP).
//
// Reads a checkout of coollabsio/coolify pinned at COOLIFY_REF and writes one
// machine-readable JSON file per surface, plus a rendered README, into
// specs/epics/freeploy-coolify-parity/parity/. Every row carries: id, Coolify
// source path, target milestone, target Freeploy component, parity test id, the
// Orunbase task key (null until minted) and a status.
//
// The inventory is generated, never hand-edited, except for the `status`,
// `taskKey` and `reason` fields, which later PRs update. Re-running the script
// keeps those three fields for every row whose id still exists (see merge()).
//
// Usage (Node >= 22.6, type stripping; no build step):
//   node tools/parity/inventory.ts --coolify ../ref/coolify \
//     --out specs/epics/freeploy-coolify-parity/parity [--ref 91b7e3e] [--check]
//
// --check exits non-zero when a count drifts more than ±5% from EXPECTED.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { join, relative, basename, extname, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { splitStatements, parseChain, phpString, type Call } from "./chain.ts";
import { expandLoops } from "./expand.ts";

type Status = "planned" | "in_progress" | "ported" | "verified" | "deferred";

interface Row {
  id: string;
  source: string;
  milestone: string;
  component: string;
  parityTest: string;
  taskKey: string | null;
  status: Status;
  reason?: string;
  [extra: string]: unknown;
}

interface Inventory {
  name: string;
  coolifyRef: string;
  generatedFrom: string;
  count: number;
  rows: Row[];
}

// ── arguments ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function flag(name: string, fallback?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return args[i + 1];
}
const COOLIFY = flag("coolify");
const OUT = flag("out", "specs/epics/freeploy-coolify-parity/parity")!;
const CHECK = args.includes("--check");
if (!COOLIFY || !existsSync(join(COOLIFY, "routes", "web.php"))) {
  console.error("usage: node tools/parity/inventory.ts --coolify <coolify checkout> [--out dir] [--check]");
  process.exit(2);
}
function gitRef(): string {
  const explicit = flag("ref");
  if (explicit) return explicit;
  try {
    return execFileSync("git", ["-C", COOLIFY!, "rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
const REF = gitRef();

// Approximate counts at 91b7e3e, from the epic brief (section 3). --check holds
// the generated counts within ±5% of these.
const EXPECTED: Record<string, number> = {
  "routes.web": 282,
  "routes.api": 349,
  livewire: 291,
  "views.livewire": 323,
  "views.components": 145,
  svelte: 22,
  models: 81,
  "migrations.files": 520,
  jobs: 84,
  actions: 109,
  "helpers.files": 23,
  templates: 388,
};

// ── file helpers ─────────────────────────────────────────────────────────────

function walk(dir: string, filter: (p: string) => boolean = () => true): string[] {
  const abs = join(COOLIFY!, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  const stack = [abs];
  while (stack.length) {
    const d = stack.pop()!;
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) stack.push(p);
      else if (filter(p)) out.push(relative(COOLIFY!, p));
    }
  }
  return out.sort();
}
const read = (rel: string) => readFileSync(join(COOLIFY!, rel), "utf8");
const slug = (s: string) =>
  s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();

/** Strip PHP comments so regexes do not match commented-out code. */
function stripPhpComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
}

/** Count braces outside string literals on one line. */
function braceDelta(line: string): number {
  let d = 0;
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
    } else if (c === "'" || c === '"') q = c;
    else if (c === "{") d++;
    else if (c === "}") d--;
  }
  return d;
}

// ── milestone mapping ────────────────────────────────────────────────────────
// One table of rules, first match wins, so the mapping is reviewable in one
// place. The key is a lowercase string describing the row (its path, name and
// source). Rows that match nothing fall to DP9 (platform features) and are
// visible in the README's "unmapped" count so the rules can be tightened.

const MILESTONE_RULES: Array<[RegExp, string, string]> = [
  // [pattern, milestone, Freeploy component]
  [/admin|instance-?settings|settings\/(updates|backup|advanced|oauth|email|index|scheduled-jobs)|update-?coolify|upgrade|coolify-?task|cleanup-?instance|cleanup-?stuck|instance/, "DP12", "apps/deploy-core-worker (platform-admin)"],
  [/canvas|image-?scan|sbom|vulnerab|swarm|transfer|migrat(e|ion)-?to|volume-?(backup|clone|recover)|github-?runner|runner|managed-?dns|dns-?record|log-?drain|traffic|analytics|sysbox|registr(y|ies)|docker-?registr|maintenance|cloudflare-?tunnel|tunnel|hetzner|cloud-?provider|metrics/, "DP11", "apps/deploy-core-worker + apps/ssh-executor"],
  [/subscription|pricing|billing|stripe|team|member|invit|audit|boarding|onboarding|role|permission/, "DP10", "freeploy membership/policy/billing + apps/deploy-web"],
  [/scheduled-?task|shared-?variable|tag|notification|discord|telegram|slack|pushover|webhook-?notif|email-?notif|api-?token|security\/api|\/api\/v1|api\.php|openapi/, "DP9", "apps/deploy-core-worker + freeploy notifications"],
  [/service|template|compose|parser|magic/, "DP8", "apps/deploy-core-worker (catalog)"],
  [/database|postgres|mysql|mariadb|mongo|redis|keydb|dragonfly|clickhouse|backup|s3|storage/, "DP7", "apps/deploy-core-worker + apps/ssh-executor"],
  [/source|github|gitlab|gitea|bitbucket|deploy-?key|preview|pull-?request|webhook/, "DP6", "apps/deploy-core-worker + freeploy integrations"],
  [/application|deployment|build-?pack|nixpacks|dockerfile|docker-?image|rollback|healthcheck|domain|resource-?(limit|operation)|environment-?variable|env/, "DP5", "apps/deploy-core-worker + apps/ssh-executor"],
  [/server|ssh|private-?key|security\/private|proxy|traefik|caddy|destination|sentinel|docker-?cleanup|terminal|remote-?process|validate-?and-?install|docker\.php/, "DP4", "apps/ssh-executor + apps/deploy-core-worker"],
  [/auth|login|register|password|verify|two-?factor|2fa|passkey|profile|appearance|layout|navbar|sidebar|components\/|forms?\/|modal|dropdown|toast|theme|dashboard|^views\.components/, "DP3", "apps/deploy-web + freeploy identity"],
  [/project|environment|resource/, "DP5", "apps/deploy-core-worker"],
];

function mapMilestone(key: string, fallback = "DP9"): { milestone: string; component: string } {
  // Drop the path roots so "resources/" does not read as "source" (DP6).
  const k = key.toLowerCase().replace(/resources\/(views|js|css)\//g, "").replace(/\bapp\/(livewire|models|jobs|actions|notifications|events)\//g, "$1/");
  for (const [re, ms, comp] of MILESTONE_RULES) if (re.test(k)) return { milestone: ms, component: comp };
  return { milestone: fallback, component: "apps/deploy-core-worker" };
}

function row(kind: string, id: string, source: string, mapKey: string, extra: Record<string, unknown> = {}, fallback?: string): Row {
  const { milestone, component } = mapMilestone(mapKey, fallback);
  return {
    id: `${kind}:${id}`,
    source,
    milestone,
    component,
    parityTest: `parity/${kind}/${id}`,
    taskKey: null,
    status: "planned",
    ...extra,
  };
}

// ── routes ───────────────────────────────────────────────────────────────────

interface PhpRoute {
  method: string;
  path: string;
  name: string | null;
  handler: string;
  middleware: string[];
  line: number;
}

function parseRoutes(rel: string): PhpRoute[] {
  const lines = stripPhpComments(read(rel)).split("\n");
  const routes: PhpRoute[] = [];
  const stack: Array<{ prefix: string; depth: number; middleware: string[] }> = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A statement may continue over several lines; join until a ';' at depth.
    const start = line.match(/Route::(get|post|put|patch|delete|any|match|view|redirect)\s*\(/);
    const group = line.match(/Route::(?:prefix\(\s*['"]([^'"]*)['"]\s*\)|middleware\(([^)]*)\))[^;]*->group\s*\(/) ||
      line.match(/Route::prefix\(\s*['"]([^'"]*)['"]\s*\)[^;]*group\(/);
    const before = depth;
    depth += braceDelta(line);
    if (group && /function/.test(line)) {
      const prefix = (line.match(/prefix\(\s*['"]([^'"]*)['"]/)?.[1] ?? "").replace(/^\/|\/$/g, "");
      const mw = [...line.matchAll(/middleware\(\s*\[?([^)\]]*)\]?\s*\)/g)].flatMap((m) =>
        m[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean));
      stack.push({ prefix, depth: before, middleware: mw });
    } else if (start && !/->group\s*\(/.test(line)) {
      let stmt = line;
      let j = i;
      let d = braceDelta(line);
      while (!/;\s*$/.test(stmt.trimEnd()) || d > 0) {
        j++;
        if (j >= lines.length || j - i > 40) break;
        stmt += "\n" + lines[j];
        d += braceDelta(lines[j]);
      }
      const method = start[1];
      const path = stmt.match(/Route::\w+\s*\(\s*(?:\[[^\]]*\]\s*,\s*)?['"]([^'"]*)['"]/)?.[1] ?? "";
      const name = stmt.match(/->name\(\s*['"]([^'"]+)['"]/)?.[1] ?? null;
      const handler =
        stmt.match(/\[\s*([A-Za-z\\]+)::class\s*,\s*['"](\w+)['"]\s*\]/)?.slice(1, 3).join("@") ??
        stmt.match(/,\s*([A-Za-z\\]+)::class/)?.[1] ??
        (/function\s*\(|fn\s*\(/.test(stmt) ? "closure" : "unknown");
      const mw = [
        ...stack.flatMap((s) => s.middleware),
        ...[...stmt.matchAll(/->middleware\(\s*\[?([^)\]]*)\]?\s*\)/g)].flatMap((m) =>
          m[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean)),
      ];
      const full = "/" + [...stack.map((s) => s.prefix), path.replace(/^\/|\/$/g, "")].filter(Boolean).join("/");
      routes.push({ method: method.toUpperCase(), path: full, name, handler, middleware: mw, line: i + 1 });
      // The statement's own braces (an inline closure) are already counted in
      // `depth` for line i; account for the continuation lines too.
      for (let k = i + 1; k <= j; k++) depth += braceDelta(lines[k]);
      i = j;
    }
    while (stack.length && depth <= stack[stack.length - 1].depth) stack.pop();
  }
  return routes;
}

function webRoutes(): Inventory {
  const rows = parseRoutes("routes/web.php").map((r) => {
    const id = r.name ?? `${r.method.toLowerCase()}${r.path.replace(/[{}?]/g, "").replace(/\//g, "-")}`;
    return row("routes.web", id, `routes/web.php:${r.line}`, `${r.path} ${r.name ?? ""} ${r.handler}`, {
      method: r.method,
      path: r.path,
      name: r.name,
      handler: r.handler,
      middleware: r.middleware,
      visual: r.method === "GET" && /^[A-Z]/.test(r.handler.split("\\").pop() ?? "") && !/Controller/.test(r.handler),
    });
  });
  // Fortify registers the auth pages itself (app/Providers/FortifyServiceProvider.php,
  // config/fortify.php features), so routes/web.php never lists them. `guest`
  // pages are captured signed out.
  const fortify = (name: string, path: string, view: string, guest: boolean) =>
    row("routes.web", name, `app/Providers/FortifyServiceProvider.php (${view})`, `${path} ${name} auth`, {
      method: "GET",
      path,
      name,
      handler: `Fortify:${view}`,
      middleware: guest ? ["guest"] : ["auth"],
      visual: true,
      guest,
    });
  rows.push(
    fortify("login", "/login", "auth.login", true),
    fortify("register", "/register", "auth.register", true),
    fortify("password.request", "/forgot-password", "auth.forgot-password", true),
    fortify("password.reset", "/reset-password/{token}", "auth.reset-password", true),
    fortify("password.confirm", "/user/confirm-password", "auth.confirm-password", false),
  );
  return inv("routes.web", "routes/web.php + Fortify views", dedupe(rows));
}

function apiRoutes(): Inventory {
  const php = parseRoutes("routes/api.php");
  let openapi: Record<string, Record<string, { operationId?: string; summary?: string; tags?: string[] }>> = {};
  if (existsSync(join(COOLIFY!, "openapi.json"))) openapi = JSON.parse(read("openapi.json")).paths ?? {};
  const opFor = (method: string, path: string) => {
    const p = path.replace(/^\/api/, "");
    return openapi[p]?.[method.toLowerCase()] ?? openapi[`/v1${p.replace(/^\/v1/, "")}`]?.[method.toLowerCase()];
  };
  const rows = php.map((r) => {
    const op = opFor(r.method, r.path);
    const id = op?.operationId ?? `${r.method.toLowerCase()}${r.path.replace(/[{}?]/g, "").replace(/\//g, "-")}`;
    return row("routes.api", id, `routes/api.php:${r.line}`, `/api/v1 ${r.path} ${r.handler}`, {
      method: r.method,
      path: "/api" + r.path,
      handler: r.handler,
      middleware: r.middleware,
      openapi: op ? { operationId: op.operationId ?? null, summary: op.summary ?? null, tags: op.tags ?? [] } : null,
    }, "DP9");
  });
  // Every API route is contract-tested in DP9 unless its feature lands earlier;
  // the contract gate for an area runs in that area's milestone (section 6).
  return inv("routes.api", "routes/api.php + openapi.json", dedupe(rows));
}

function openapiOperations(): Inventory {
  if (!existsSync(join(COOLIFY!, "openapi.json"))) return inv("openapi.operations", "openapi.json", []);
  const doc = JSON.parse(read("openapi.json"));
  const rows: Row[] = [];
  for (const [path, ops] of Object.entries<Record<string, { operationId?: string; summary?: string; responses?: Record<string, unknown> }>>(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(ops)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const id = op.operationId ?? `${method}${path.replace(/[{}]/g, "").replace(/\//g, "-")}`;
      rows.push(row("openapi", id, `openapi.json#/paths/${path}/${method}`, `/api/v1 ${path}`, {
        method: method.toUpperCase(),
        path: `/api/v1${path}`,
        summary: op.summary ?? null,
        statusCodes: Object.keys(op.responses ?? {}),
      }, "DP9"));
    }
  }
  return inv("openapi.operations", "openapi.json", dedupe(rows));
}

// ── livewire, views, svelte ──────────────────────────────────────────────────

function livewire(): Inventory {
  const files = walk("app/Livewire", (p) => p.endsWith(".php"));
  const rows = files.map((f) => {
    const src = stripPhpComments(read(f));
    const cls = f.replace(/^app\//, "App/").replace(/\.php$/, "").replace(/\//g, "\\");
    const kebab = (p: string) => p.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    const conventional = "livewire." + f.replace(/^app\/Livewire\//, "").replace(/\.php$/, "").split("/").map(kebab).join(".");
    const isTrait = /^\s*trait\s+\w+/m.test(src) || /\/Concerns\//.test(f);
    const explicitView = src.match(/view\(\s*['"](livewire\.[^'"]+)['"]/)?.[1] ?? null;
    const view = explicitView ?? (!isTrait && existsSync(join(COOLIFY!, `resources/views/${conventional.replace(/\./g, "/")}.blade.php`)) ? conventional : null);
    const props = [...src.matchAll(/public\s+(?:\??[\w\\|]+\s+)?\$(\w+)/g)].map((m) => m[1]);
    const skip = new Set(["render", "mount", "boot", "booted", "rules", "messages", "getListeners", "hydrate", "dehydrate", "updated", "updating", "validationAttributes"]);
    const actions = [...src.matchAll(/public\s+function\s+(\w+)\s*\(/g)].map((m) => m[1]).filter((n) => !skip.has(n) && !n.startsWith("__"));
    const rulesBlock =
      src.match(/protected\s+(?:array\s+)?\$rules\s*=\s*\[([\s\S]*?)\];/)?.[1] ??
      src.match(/function\s+rules\s*\(\)\s*(?::\s*array)?\s*\{[\s\S]*?return\s*\[([\s\S]*?)\];/)?.[1] ??
      "";
    const rules = Object.fromEntries(
      [...rulesBlock.matchAll(/['"]([\w.*]+)['"]\s*=>\s*([^\n]+?),?\s*$/gm)].map((m) => [m[1], m[2].trim().replace(/,$/, "")]),
    );
    const messagesBlock = src.match(/function\s+messages\s*\(\)\s*(?::\s*array)?\s*\{[\s\S]*?return\s*(?:array_merge\([\s\S]*?)?\[([\s\S]*?)\]/)?.[1] ?? "";
    const messages = [...messagesBlock.matchAll(/['"]([\w.*]+)['"]\s*=>/g)].map((m) => m[1]);
    const viewFile = view ? `resources/views/${view.replace(/\./g, "/")}.blade.php` : null;
    const viewSrc = viewFile && existsSync(join(COOLIFY!, viewFile)) ? read(viewFile) : "";
    const polling = [...viewSrc.matchAll(/wire:poll(?:\.([\w.]+))?(?:=["']([^"']*)["'])?/g)].map((m) => ({ modifier: m[1] ?? null, action: m[2] ?? null }));
    const listeners = [...src.matchAll(/#\[On\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    return row("livewire", slug(cls.replace(/^App\\Livewire\\/, "")), f, `${f} ${view ?? ""}`, {
      class: cls,
      kind: isTrait ? "trait" : "component",
      view,
      publicProps: props,
      actions,
      rules,
      customMessages: messages,
      polling,
      listeners,
    });
  });
  return inv("livewire", "app/Livewire/**", rows);
}

function views(): { livewire: Inventory; components: Inventory; all: Inventory } {
  const lw = walk("resources/views/livewire", (p) => p.endsWith(".blade.php")).map((f) => {
    const src = read(f);
    return row("views.livewire", slug(f.replace(/^resources\/views\/livewire\//, "").replace(/\.blade\.php$/, "")), f, f, {
      wireModels: [...new Set([...src.matchAll(/wire:model(?:\.[\w.]+)?=["']([^"']+)["']/g)].map((m) => m[1]))],
      components: [...new Set([...src.matchAll(/<x-([\w.-]+)/g)].map((m) => m[1]))],
      alpine: /x-data|x-show|x-on:|@click/.test(src),
      confirm: /wire:confirm|x-modal-confirmation|modal-confirmation/.test(src),
    });
  });
  const comp = walk("resources/views/components", (p) => p.endsWith(".blade.php")).map((f) => {
    const src = read(f);
    const props = src.match(/@props\(\s*\[([\s\S]*?)\]\s*\)/)?.[1] ?? "";
    return row("views.components", slug(f.replace(/^resources\/views\/components\//, "").replace(/\.blade\.php$/, "")), f, `views.components ${f}`, {
      props: [...props.matchAll(/['"](\w[\w-]*)['"]\s*(?:=>|,|$)/g)].map((m) => m[1]),
      slots: [...new Set([...src.matchAll(/\{\{\s*\$(\w+)\s*\}\}/g)].map((m) => m[1]).filter((n) => n === "slot" || /^[a-z]/.test(n)))],
      alpine: /x-data|x-show|x-on:|@click/.test(src),
    });
  });
  // Components are the UI shell: they all land in DP3 with the gallery route.
  for (const r of comp) {
    r.milestone = "DP3";
    r.component = "apps/deploy-web (components)";
  }
  return {
    livewire: inv("views.livewire", "resources/views/livewire/**", lw),
    components: inv("views.components", "resources/views/components/**", comp),
    all: inv("views", "resources/views/livewire/** + resources/views/components/**", [...lw, ...comp]),
  };
}

function svelte(): Inventory {
  const rows = walk("resources/js", (p) => p.endsWith(".svelte")).map((f) =>
    row("svelte", slug(f.replace(/^resources\/js\//, "").replace(/\.svelte$/, "")), f, `canvas ${f}`, {
      lines: read(f).split("\n").length,
    }),
  );
  return inv("svelte", "resources/js/**/*.svelte", rows);
}

// ── models and the folded schema ─────────────────────────────────────────────

function models(): Inventory {
  const rows = walk("app/Models", (p) => p.endsWith(".php")).map((f) => {
    const src = stripPhpComments(read(f));
    const cls = basename(f, ".php");
    const arr = (re: RegExp) => [...(src.match(re)?.[1] ?? "").matchAll(/['"](\w+)['"]/g)].map((m) => m[1]);
    const casts = Object.fromEntries(
      [...(src.match(/(?:protected\s+\$casts\s*=\s*\[|function\s+casts\s*\(\)\s*(?::\s*array)?\s*\{\s*return\s*\[)([\s\S]*?)\]/)?.[1] ?? "").matchAll(/['"](\w+)['"]\s*=>\s*([^,\n]+)/g)]
        .map((m) => [m[1], m[2].trim().replace(/^['"]|['"]$/g, "")]),
    );
    const relations = [...src.matchAll(/public\s+function\s+(\w+)\s*\([^)]*\)[^{]*\{\s*return\s+\$this->(hasMany|hasOne|belongsTo|belongsToMany|morphTo|morphMany|morphOne|morphToMany|morphedByMany|hasManyThrough|hasOneThrough)\(\s*([\w\\]+)?/g)]
      .map((m) => ({ name: m[1], type: m[2], related: m[3]?.replace(/::class$/, "") ?? null }));
    return row("models", slug(cls), f, `model ${cls}`, {
      class: cls,
      table: src.match(/protected\s+\$table\s*=\s*['"](\w+)['"]/)?.[1] ?? null,
      fillable: arr(/protected\s+\$fillable\s*=\s*\[([\s\S]*?)\]/),
      guarded: arr(/protected\s+\$guarded\s*=\s*\[([\s\S]*?)\]/),
      hidden: arr(/protected\s+\$hidden\s*=\s*\[([\s\S]*?)\]/),
      casts,
      relations,
      teamScoped: /team_id|ownedByCurrentTeam|->team\(/.test(src),
    });
  });
  return inv("models", "app/Models/**", rows);
}

interface Column { name: string; type: string; args: string[]; chain: Call[]; modifiers: string[] }

/**
 * Fold every migration, in filename order, into the final schema: create adds a
 * table, table() adds/drops/renames columns, drop removes the table. Raw SQL
 * (DB::statement) is recorded per table as `raw` so a reviewer can see what
 * the fold could not interpret.
 */
function migrations(): { files: Inventory; tables: Inventory } {
  const files = walk("database/migrations", (p) => p.endsWith(".php"));
  const tables = new Map<string, { columns: Map<string, Column>; createdIn: string; touchedBy: string[]; raw: string[] }>();
  for (const f of files) {
    // Loops over table lists (foreach ([...] as $t) Schema::table($t, …)) are
    // unrolled first so every table they touch is folded.
    const src = expandLoops(stripPhpComments(read(f)));
    const up = src.match(/function\s+up\s*\(\)\s*(?::\s*void)?\s*\{([\s\S]*?)\n\s{4}\}/)?.[1] ?? src;
    for (const m of up.matchAll(/Schema::(create|table)\(\s*['"](\w+)['"]\s*,\s*function\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?\{([\s\S]*?)\n\s*\}\s*\);/g)) {
      const [, op, name, body] = m;
      if (op === "create" || !tables.has(name)) tables.set(name, { columns: new Map(), createdIn: f, touchedBy: [], raw: [] });
      const t = tables.get(name)!;
      if (op === "table") t.touchedBy.push(f);
      for (const stmt of splitStatements(body)) {
        const p = parseChain(stmt);
        if (!p) continue;
        const type = p.method;
        const col = phpString(p.args[0]) ?? undefined;
        const modifiers = p.chain.map((x) => x.method);
        const column = (name: string, t = type, args = p.args): Column => ({ name, type: t, args, chain: p.chain, modifiers });
        if (type === "dropColumn" || type === "dropColumnIfExists") {
          for (const a of p.args) for (const d of a.matchAll(/['"](\w+)['"]/g)) t.columns.delete(d[1]);
        } else if (type === "renameColumn") {
          const [from, to] = [phpString(p.args[0]), phpString(p.args[1])];
          const old = from ? t.columns.get(from) : undefined;
          if (old && to) {
            t.columns.delete(from!);
            t.columns.set(to, { ...old, name: to });
          }
        } else if (type === "id" || type === "bigIncrements" || type === "increments") {
          t.columns.set(col ?? "id", column(col ?? "id"));
        } else if (type === "timestamps" || type === "timestampsTz") {
          const ts = type === "timestampsTz" ? "timestampTz" : "timestamp";
          t.columns.set("created_at", { name: "created_at", type: ts, args: [], chain: [{ method: "nullable", args: [] }], modifiers: ["nullable"] });
          t.columns.set("updated_at", { name: "updated_at", type: ts, args: [], chain: [{ method: "nullable", args: [] }], modifiers: ["nullable"] });
        } else if (type === "softDeletes" || type === "softDeletesTz") {
          t.columns.set("deleted_at", { name: "deleted_at", type: "timestamp", args: [], chain: [{ method: "nullable", args: [] }], modifiers: ["nullable"] });
        } else if (type === "morphs" || type === "nullableMorphs" || type === "uuidMorphs") {
          const nullable = type === "nullableMorphs" ? [{ method: "nullable", args: [] }] : [];
          t.columns.set(`${col}_id`, { name: `${col}_id`, type: type === "uuidMorphs" ? "uuid" : "unsignedBigInteger", args: [], chain: nullable, modifiers: nullable.map((x) => x.method) });
          t.columns.set(`${col}_type`, { name: `${col}_type`, type: "string", args: [], chain: nullable, modifiers: nullable.map((x) => x.method) });
        } else if (type === "dropMorphs") {
          if (col) { t.columns.delete(`${col}_id`); t.columns.delete(`${col}_type`); }
        } else if (type === "rememberToken") {
          t.columns.set("remember_token", { name: "remember_token", type: "string", args: ["'remember_token'", "100"], chain: [{ method: "nullable", args: [] }], modifiers: ["nullable"] });
        } else if (col && !/^(index|unique|primary|foreign|dropForeign|dropIndex|dropUnique|dropPrimary|dropIfExists|renameIndex|fullText|spatialIndex)$/.test(type)) {
          t.columns.set(col, column(col));
        }
      }
    }
    for (const m of up.matchAll(/Schema::(?:drop|dropIfExists)\(\s*['"](\w+)['"]/g)) tables.delete(m[1]);
    for (const m of up.matchAll(/Schema::rename\(\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]/g)) {
      const t = tables.get(m[1]);
      if (t) {
        tables.delete(m[1]);
        tables.set(m[2], t);
      }
    }
    for (const m of up.matchAll(/DB::statement\(\s*["']([^"']+)["']/g)) {
      const name = m[1].match(/(?:table|on)\s+"?(\w+)"?/i)?.[1];
      if (name && tables.has(name)) tables.get(name)!.raw.push(m[1].slice(0, 200));
    }
  }
  const fileRows = files.map((f) => row("migrations.files", basename(f, ".php"), f, "schema", {}, "DP2"));
  for (const r of fileRows) {
    r.milestone = "DP2";
    r.component = "packages/db (deploy schema)";
  }
  const tableRows = [...tables.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, t]) => {
    const cols = [...t.columns.values()];
    const r = row("migrations.tables", name, t.createdIn, "schema", {
      table: name,
      columns: cols,
      hasTeamId: t.columns.has("team_id"),
      touchedBy: t.touchedBy,
      raw: t.raw,
    }, "DP2");
    r.milestone = "DP2";
    r.component = "packages/db (deploy schema, team_id → org_id)";
    return r;
  });
  return { files: inv("migrations.files", "database/migrations/**", fileRows), tables: inv("migrations.tables", "database/migrations/** (folded final schema)", tableRows) };
}

// ── jobs, actions, notifications, helpers, events ────────────────────────────

function schedules(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const sources = ["routes/console.php", "app/Console/Kernel.php", ...walk("app/Jobs", (p) => /Schedul/i.test(p))];
  for (const f of sources) {
    if (!existsSync(join(COOLIFY!, f))) continue;
    const src = stripPhpComments(read(f));
    for (const m of src.matchAll(/(?:job|dispatch)\(\s*new\s+(\w+)[^;]*?((?:->\w+\([^;]*?\))+)\s*;/g)) {
      const freq = [...m[2].matchAll(/->(\w+)\(([^)]*)\)/g)].map((x) => `${x[1]}(${x[2].trim()})`).filter((x) => !/^(onOneServer|withoutOverlapping|timezone)/.test(x));
      (out[m[1]] ??= []).push(`${f}: ${freq.join(" ")}`);
    }
  }
  return out;
}

function jobs(): Inventory {
  const sched = schedules();
  const rows = walk("app/Jobs", (p) => p.endsWith(".php")).map((f) => {
    const src = stripPhpComments(read(f));
    const cls = basename(f, ".php");
    const num = (re: RegExp) => {
      const v = src.match(re)?.[1];
      return v ? Number(v) : null;
    };
    return row("jobs", slug(cls), f, `job ${cls} ${f}`, {
      class: cls,
      queued: /implements[^{]*ShouldQueue/.test(src),
      unique: /ShouldBeUnique/.test(src),
      queue: src.match(/onQueue\(\s*['"](\w+)['"]/)?.[1] ?? null,
      tries: num(/\$tries\s*=\s*(\d+)/),
      timeout: num(/\$timeout\s*=\s*(\d+)/),
      backoff: src.match(/\$backoff\s*=\s*([^;]+);/)?.[1]?.trim() ?? src.match(/function\s+backoff\s*\(\)[^{]*\{\s*return\s*([^;]+);/)?.[1]?.trim() ?? null,
      maxExceptions: num(/\$maxExceptions\s*=\s*(\d+)/),
      schedule: sched[cls] ?? [],
      target: /DeploymentJob|BackupJob|ValidateAndInstall|Transfer|Migrat/.test(cls) ? "workflow" : sched[cls] ? "cron+queue" : "queue",
    });
  });
  return inv("jobs", "app/Jobs/**", rows);
}

function actions(): Inventory {
  const rows = walk("app/Actions", (p) => p.endsWith(".php")).map((f) => {
    const src = stripPhpComments(read(f));
    const cls = f.replace(/^app\/Actions\//, "").replace(/\.php$/, "");
    return row("actions", slug(cls), f, `action ${cls}`, {
      class: cls.replace(/\//g, "\\"),
      handle: src.match(/public\s+function\s+handle\s*\(([^)]*)\)/)?.[1]?.replace(/\s+/g, " ").trim() ?? null,
      runsRemote: /instant_remote_process|remote_process|execute_remote_command/.test(src),
    });
  });
  return inv("actions", "app/Actions/**", rows);
}

const CHANNELS = ["Mail", "Discord", "Telegram", "Slack", "Pushover", "Webhook"] as const;
function notifications(): Inventory {
  const rows: Row[] = [];
  for (const f of walk("app/Notifications", (p) => p.endsWith(".php") && !/\/(Channels|Dto)\//.test(p))) {
    const src = stripPhpComments(read(f));
    if (!/extends\s+(?:CustomEmailNotification|Notification)\b/.test(src) && !/function\s+via\s*\(/.test(src)) continue;
    const cls = f.replace(/^app\/Notifications\//, "").replace(/\.php$/, "");
    const event = src.match(/getEnabledChannels\(\s*['"]([\w_]+)['"]/)?.[1] ?? null;
    for (const ch of CHANNELS) {
      const method = `to${ch}`;
      if (!new RegExp(`function\\s+${method}\\s*\\(`).test(src)) continue;
      rows.push(row("notifications", `${slug(cls)}.${ch.toLowerCase()}`, f, `notification ${cls}`, {
        class: cls.replace(/\//g, "\\"),
        channel: ch === "Mail" ? "email" : ch.toLowerCase(),
        event,
        payloadTest: `parity/notifications/${slug(cls)}.${ch.toLowerCase()}.golden`,
      }, "DP9"));
    }
  }
  // Notification payloads are a DP9 gate regardless of which area emits them.
  for (const r of rows) {
    r.milestone = "DP9";
    r.component = "freeploy notifications + apps/deploy-core-worker";
  }
  return inv("notifications", "app/Notifications/** × channels", rows);
}

function helpers(): { files: Inventory; functions: Inventory } {
  const files = walk("bootstrap/helpers", (p) => p.endsWith(".php"));
  const fileRows = files.map((f) => row("helpers.files", basename(f, ".php"), f, `helpers ${basename(f)}`));
  const fnRows = files.flatMap((f) =>
    [...stripPhpComments(read(f)).matchAll(/^function\s+(\w+)\s*\(([^)]*)\)/gm)].map((m) =>
      row("helpers", `${basename(f, ".php")}.${m[1]}`, f, `helpers ${basename(f)} ${m[1]}`, {
        function: m[1],
        signature: m[2].replace(/\s+/g, " ").trim(),
        golden: /remoteProcess|docker|proxy|databases|services|parsers|shared/.test(f),
      }),
    ),
  );
  return { files: inv("helpers.files", "bootstrap/helpers/*.php", fileRows), functions: inv("helpers", "bootstrap/helpers/*.php (functions)", fnRows) };
}

function events(): Inventory {
  const rows = walk("app/Events", (p) => p.endsWith(".php")).map((f) => {
    const src = stripPhpComments(read(f));
    const cls = basename(f, ".php");
    return row("events", slug(cls), f, `event ${cls}`, {
      class: cls,
      broadcastAs: src.match(/function\s+broadcastAs\s*\(\)[^{]*\{\s*return\s*['"]([^'"]+)['"]/)?.[1] ?? null,
      channel: src.match(/new\s+(Private|Presence)?Channel\(\s*['"]([^'"]+)/)?.[2] ?? null,
      broadcasts: /ShouldBroadcast/.test(src),
      target: "OrgRealtime durable object",
    });
  });
  return inv("events", "app/Events/**", rows);
}

// ── service templates ────────────────────────────────────────────────────────

function templates(): Inventory {
  const rows = walk("templates/compose", (p) => /\.ya?ml$/.test(p)).map((f) => {
    const src = read(f);
    const meta = (k: string) => src.match(new RegExp(`^#\\s*${k}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? null;
    const name = basename(f, extname(f));
    const r = row("templates", name, f, "service template", {
      documentation: meta("documentation"),
      slogan: meta("slogan"),
      category: meta("category"),
      tags: (meta("tags") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
      logo: meta("logo"),
      port: meta("port"),
      minversion: meta("minversion"),
      magicVariables: [...new Set([...src.matchAll(/\$\{?(SERVICE_[A-Z0-9_]+)/g)].map((m) => m[1]))],
      golden: `parity/templates/${name}.golden.json`,
    });
    r.milestone = "DP8";
    r.component = "apps/deploy-core-worker (catalog)";
    return r;
  });
  return inv("templates", "templates/compose/*.yaml", rows);
}

// ── strings ──────────────────────────────────────────────────────────────────

const BRAND = /\bCoolify(?:\s+Cloud)?\b/;
function strings(): Inventory {
  const rows: Row[] = [];
  // lang/<locale>.json and lang/<locale>/*.php
  for (const f of walk("lang")) {
    const locale = f.split("/")[1].replace(/\.json$/, "");
    if (f.endsWith(".json")) {
      for (const [k, v] of Object.entries<string>(JSON.parse(read(f)))) {
        rows.push(row("strings", `lang.${locale}.${k}`, f, `strings ${k}`, { locale, key: k, value: v, brand: BRAND.test(String(v)) }, "DP3"));
      }
    } else if (f.endsWith(".php")) {
      const group = basename(f, ".php");
      for (const m of stripPhpComments(read(f)).matchAll(/['"]([\w.-]+)['"]\s*=>\s*(['"])((?:\\.|(?!\2).)*)\2/g)) {
        rows.push(row("strings", `lang.${locale}.${group}.${m[1]}`, f, `strings ${group} ${m[1]}`, { locale, key: `${group}.${m[1]}`, value: m[3], brand: BRAND.test(m[3]) }, "DP3"));
      }
    }
  }
  // Literal UI text in Blade: text between tags and common attributes
  // (label=, placeholder=, helper=, title=, description=). Interpolations are
  // left out; each literal is attributed to the view that renders it.
  for (const f of walk("resources/views", (p) => p.endsWith(".blade.php"))) {
    const src = read(f).replace(/\{\{[\s\S]*?\}\}|\{!![\s\S]*?!!\}|@\w+(\([^)]*\))?/g, " ");
    const seen = new Set<string>();
    const add = (text: string, where: string) => {
      const t = text.replace(/\s+/g, " ").trim();
      if (t.length < 2 || !/[A-Za-z]{2}/.test(t) || seen.has(t) || /^[\w-]+$/.test(t) && t === t.toLowerCase() && t.length < 4) return;
      seen.add(t);
      rows.push(row("strings", `view.${slug(f.replace(/^resources\/views\//, "").replace(/\.blade\.php$/, ""))}.${seen.size}`, f, f, { where, value: t, brand: BRAND.test(t) }));
    };
    for (const m of src.matchAll(/>([^<>{}@]+)</g)) add(m[1], "text");
    for (const m of src.matchAll(/\b(label|placeholder|helper|title|description|buttonTitle|submitAction|confirmationText)=["']([^"']+)["']/g)) add(m[2], m[1]);
  }
  return inv("strings", "lang/** + literal UI strings in Blade", rows);
}

// ── settings ─────────────────────────────────────────────────────────────────

function settings(tables: Inventory): Inventory {
  const scopes: Array<[RegExp, string, string]> = [
    [/^instance_settings$/, "instance", "DP12"],
    [/^teams$|_notification_settings$|^team_/, "team", "DP10"],
    [/^server_settings$/, "server", "DP4"],
    [/^application_settings$/, "application", "DP5"],
    [/^standalone_\w+$/, "database", "DP7"],
    [/^service_(applications|databases)$|^services$/, "service", "DP8"],
  ];
  const rows: Row[] = [];
  for (const t of tables.rows) {
    const name = String(t.table);
    const hit = scopes.find(([re]) => re.test(name));
    if (!hit) continue;
    for (const c of t.columns as Column[]) {
      if (["id", "created_at", "updated_at", "deleted_at", "uuid"].includes(c.name)) continue;
      const r = row("settings", `${name}.${c.name}`, String(t.source), `settings ${name}`, { scope: hit[1], table: name, column: c.name, type: c.type, modifiers: c.modifiers });
      r.milestone = /_notification_settings$/.test(name) ? "DP9" : hit[2];
      rows.push(r);
    }
  }
  return inv("settings", "instance/team/server/application/database/service settings (folded schema)", rows);
}

// ── assembly ─────────────────────────────────────────────────────────────────

function inv(name: string, generatedFrom: string, rows: Row[]): Inventory {
  return { name, coolifyRef: REF, generatedFrom, count: rows.length, rows };
}

function dedupe(rows: Row[]): Row[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const n = seen.get(r.id) ?? 0;
    seen.set(r.id, n + 1);
    return n ? { ...r, id: `${r.id}~${n + 1}`, parityTest: `${r.parityTest}~${n + 1}` } : r;
  });
}

/** Keep the hand-updated fields (status, taskKey, reason) across regenerations. */
function merge(file: string, next: Inventory): Inventory {
  if (!existsSync(file)) return next;
  try {
    const prev: Inventory = JSON.parse(readFileSync(file, "utf8"));
    const by = new Map(prev.rows.map((r) => [r.id, r]));
    for (const r of next.rows) {
      const p = by.get(r.id);
      if (!p) continue;
      r.status = p.status;
      r.taskKey = p.taskKey;
      if (p.reason) r.reason = p.reason;
    }
  } catch {
    /* a corrupt previous file is replaced */
  }
  return next;
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const v = views();
  const m = migrations();
  const h = helpers();
  const outputs: Record<string, Inventory> = {
    "routes.web": webRoutes(),
    "routes.api": apiRoutes(),
    "openapi.operations": openapiOperations(),
    livewire: livewire(),
    views: v.all,
    svelte: svelte(),
    models: models(),
    migrations: m.tables,
    "migrations.files": m.files,
    jobs: jobs(),
    actions: actions(),
    notifications: notifications(),
    helpers: h.functions,
    "helpers.files": h.files,
    events: events(),
    templates: templates(),
    strings: strings(),
  };
  outputs.settings = settings(m.tables);

  for (const [name, data] of Object.entries(outputs)) {
    const file = join(OUT, `${name}.json`);
    writeFileSync(file, JSON.stringify(merge(file, data), null, 1) + "\n");
  }
  if (existsSync(join(COOLIFY!, "openapi.json"))) copyFileSync(join(COOLIFY!, "openapi.json"), join(OUT, "openapi.json"));

  const counts: Record<string, number> = {
    "routes.web": outputs["routes.web"].count,
    "routes.api": outputs["routes.api"].count,
    livewire: outputs.livewire.count,
    "views.livewire": v.livewire.count,
    "views.components": v.components.count,
    svelte: outputs.svelte.count,
    models: outputs.models.count,
    "migrations.files": m.files.count,
    jobs: outputs.jobs.count,
    actions: outputs.actions.count,
    "helpers.files": h.files.count,
    templates: outputs.templates.count,
  };
  const drift = Object.entries(EXPECTED).map(([k, exp]) => {
    const got = counts[k] ?? 0;
    const pct = exp ? ((got - exp) / exp) * 100 : 0;
    return { k, exp, got, pct, ok: Math.abs(pct) <= 5 };
  });

  writeFileSync(join(OUT, "README.md"), render(outputs, drift));
  for (const d of drift) console.log(`${d.ok ? "✓" : "✕"} ${d.k.padEnd(18)} ${String(d.got).padStart(5)} (expected ~${d.exp}, ${d.pct >= 0 ? "+" : ""}${d.pct.toFixed(1)}%)`);
  if (CHECK && drift.some((d) => !d.ok)) process.exit(1);
}

function render(outputs: Record<string, Inventory>, drift: Array<{ k: string; exp: number; got: number; pct: number; ok: boolean }>): string {
  const milestones = Array.from({ length: 14 }, (_, i) => `DP${i}`);
  const statuses: Status[] = ["planned", "in_progress", "ported", "verified", "deferred"];
  const all = Object.values(outputs).flatMap((o) => o.rows.map((r) => ({ ...r, file: o.name })));
  const lines: string[] = [];
  lines.push("# Parity inventory — Freeploy ↔ Coolify");
  lines.push("");
  lines.push(`Generated by \`tools/parity/inventory.ts\` from coollabsio/coolify@\`${REF}\` (Apache-2.0). Do not edit by hand:`);
  lines.push("re-run the script; only `status`, `taskKey` and `reason` in the JSON are hand-maintained and survive a regeneration.");
  lines.push("");
  lines.push("Every row is one unit of parity: a route, a Livewire component, a view, a model, a table, a job, an action,");
  lines.push("a helper function, a notification × channel, a service template, a string or a setting. A row is `verified`");
  lines.push("only when its parity test (`parityTest`) is green in CI against the reference instance.");
  lines.push("");
  lines.push("Harness results (visual and DOM/copy, per route) are in [HARNESS.md](HARNESS.md) and `visual-report.json`,");
  lines.push("regenerated by the `parity` workflow.");
  lines.push("");
  lines.push("## Counts against the brief (±5%)");
  lines.push("");
  lines.push("| Surface | Count | Expected | Drift | |");
  lines.push("|---|---:|---:|---:|---|");
  for (const d of drift) lines.push(`| \`${d.k}\` | ${d.got} | ~${d.exp} | ${d.pct >= 0 ? "+" : ""}${d.pct.toFixed(1)}% | ${d.ok ? "✓" : "✕"} |`);
  lines.push("");
  lines.push("## Files");
  lines.push("");
  lines.push("| File | Rows | Source |");
  lines.push("|---|---:|---|");
  for (const o of Object.values(outputs)) lines.push(`| \`${o.name}.json\` | ${o.count} | ${o.generatedFrom} |`);
  lines.push("| `openapi.json` | — | verbatim copy of Coolify's `openapi.json`, the API contract |");
  lines.push("");
  lines.push("## Rows by milestone");
  lines.push("");
  lines.push(`| Milestone | ${Object.keys(outputs).map((k) => `\`${k}\``).join(" | ")} | Total |`);
  lines.push(`|---|${Object.keys(outputs).map(() => "---:").join("|")}|---:|`);
  for (const ms of milestones) {
    const cells = Object.values(outputs).map((o) => o.rows.filter((r) => r.milestone === ms).length);
    const total = cells.reduce((a, b) => a + b, 0);
    lines.push(`| ${ms} | ${cells.join(" | ")} | ${total} |`);
  }
  lines.push("");
  lines.push("## Status");
  lines.push("");
  lines.push(`| Status | Rows | % |`);
  lines.push("|---|---:|---:|");
  for (const s of statuses) {
    const n = all.filter((r) => r.status === s).length;
    lines.push(`| ${s} | ${n} | ${all.length ? ((n / all.length) * 100).toFixed(1) : "0.0"}% |`);
  }
  lines.push("");
  const deferred = all.filter((r) => r.status === "deferred");
  lines.push("## Deferred");
  lines.push("");
  if (!deferred.length) lines.push("None.");
  for (const r of deferred) lines.push(`- \`${r.id}\` — ${r.reason ?? "(no reason recorded — CI fails this)"}`);
  lines.push("");
  const brand = outputs.strings.rows.filter((r) => r.brand).length;
  lines.push("## Brand words");
  lines.push("");
  lines.push(`${brand} string rows contain "Coolify" or "Coolify Cloud". Each is replaced with \`PRODUCTNAME\` (Freeploy) in the port;`);
  lines.push("the DOM/copy parity check normalises brand words before comparing.");
  lines.push("");
  return lines.join("\n");
}

main();
