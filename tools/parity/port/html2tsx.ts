// Turn a reference page's rendered markup (tools/parity capture, desktop-light.html)
// into the JSX a deploy-web page starts from (DP3+). The DOM, classes and copy
// are Coolify's; behaviour is re-implemented in React, so Livewire (wire:*) and
// Alpine (x-*, @*, :*) attributes and scripts are dropped, and the brand is
// swapped (design §3.1, risks DP-F).
//
//   node tools/parity/port/html2tsx.ts --html <desktop-light.html> --select "main" \
//     --name LoginPage [--out apps/deploy-web/src/pages/Login.generated.tsx] \
//     [--nth <n>] [--patch tools/parity/port/patches/<name>.json]
//
// --nth picks the n-th element matching --select in document order; --inner
// renders its children as a fragment (--take <n>: only the first n elements)
// and --after <prop> appends a prop.
//
// A patch file binds the reference's fixture values (a user's name, the
// current page) to props: [{ "find": <regex>, "replace": <string>, "props"?: [..] }],
// applied in order to the generated source. Every rule must match, so a
// reference change that moves the markup fails the generator instead of
// silently keeping a fixture value.
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "parse5";

type Node = {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Node[];
  value?: string;
  content?: Node;
};

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const DROP_TAGS = new Set(["script", "noscript", "template", "style"]);
const RENAME: Record<string, string> = {
  class: "className",
  for: "htmlFor",
  tabindex: "tabIndex",
  readonly: "readOnly",
  maxlength: "maxLength",
  minlength: "minLength",
  autocomplete: "autoComplete",
  autofocus: "autoFocus",
  autocapitalize: "autoCapitalize",
  inputmode: "inputMode",
  spellcheck: "spellCheck",
  "stroke-width": "strokeWidth",
  "stroke-linecap": "strokeLinecap",
  "stroke-linejoin": "strokeLinejoin",
  "fill-rule": "fillRule",
  "clip-rule": "clipRule",
  "clip-path": "clipPath",
  "stroke-miterlimit": "strokeMiterlimit",
  "stop-color": "stopColor",
  viewbox: "viewBox",
  "xmlns:xlink": "xmlnsXlink",
  "xlink:href": "xlinkHref",
  "accept-charset": "acceptCharset",
  enctype: "encType",
  novalidate: "noValidate",
  colspan: "colSpan",
  rowspan: "rowSpan",
  srcset: "srcSet",
};
const NUMERIC = new Set(["tabindex", "colspan", "rowspan", "rows", "cols", "maxlength", "minlength", "size", "span", "start"]);
// Attributes React knows; anything else (a Blade prop leaked into the DOM, e.g.
// `ishighlighted`) is passed through a typed spread so the DOM stays identical.
const KNOWN = new Set([
  "id", "class", "style", "title", "lang", "dir", "hidden", "role", "tabindex", "href", "target", "rel", "src", "alt", "width", "height",
  "type", "name", "value", "placeholder", "required", "disabled", "readonly", "checked", "selected", "multiple", "for", "action", "method",
  "autocomplete", "autofocus", "min", "max", "minlength", "maxlength", "step", "pattern", "size", "rows", "cols", "accept", "form",
  "xmlns", "viewbox", "fill", "stroke", "d", "cx", "cy", "r", "x", "y", "x1", "x2", "y1", "y2", "points", "transform", "rx", "ry",
  "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule", "clip-rule", "clip-path", "opacity", "stop-color", "offset",
  "colspan", "rowspan", "srcset", "loading", "decoding", "download", "enctype", "novalidate", "spellcheck", "autocapitalize",
  "inputmode", "list", "open", "label", "span", "start", "datetime", "media", "sizes", "crossorigin", "referrerpolicy", "xmlns:xlink",
  "xlink:href", "preserveaspectratio", "stroke-miterlimit", "accept-charset", "content", "charset", "http-equiv",
]);
const BOOL = new Set(["disabled", "checked", "required", "readonly", "autofocus", "multiple", "selected", "hidden", "novalidate"]);

/** Replace brand words in copy; keep Coolify only where the license or a URL needs it. */
export function swapBrand(text: string): string {
  return text.replace(/Coolify Cloud/g, "Freeploy").replace(/\bCoolify\b/g, "Freeploy");
}

function dropAttr(name: string): boolean {
  return name.startsWith("wire:") || name.startsWith("x-") || name.startsWith("@") || name.startsWith(":") || name.startsWith("ax-") || name === "data-navigate-once" || name.startsWith("data-livewire");
}

/** A JSX attribute value: a plain string literal unless it holds a quote or backslash (JSX strings have no escapes). */
const jsxString = (v: string) => (/["\\\n]/.test(v) ? `{${JSON.stringify(v)}}` : JSON.stringify(v));
const esc = (s: string) => s.replace(/[{}<>]/g, (c) => `{"${c}"}`);

function styleObject(css: string): string {
  let custom = false;
  const entries = css.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const [k, ...v] = d.split(":");
    const raw = k!.trim();
    // Custom properties stay as written; vendor prefixes are capitalised (WebkitMask).
    const key = raw.startsWith("--")
      ? raw
      : raw.replace(/^-(webkit|moz|ms)-/, (_, p: string) => `${p[0]!.toUpperCase()}${p.slice(1)}-`).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (raw.startsWith("--")) custom = true;
    return `${JSON.stringify(key)}: ${JSON.stringify(v.join(":").trim())}`;
  });
  return custom ? `{{ ${entries.join(", ")} } as Record<string, string>}` : `{{ ${entries.join(", ")} }}`;
}

function attrs(n: Node): string {
  const out: string[] = [];
  const isToken = (n.attrs ?? []).some((a) => a.name === "name" && a.value === "_token");
  for (const a of n.attrs ?? []) {
    if (dropAttr(a.name)) continue;
    // Empty presentational or numeric attributes carry nothing and do not type in React.
    if (a.value === "" && ["style", "min", "max", "minlength", "maxlength", "step", "pattern", "size"].includes(a.name)) continue;
    // A per-session secret (Laravel's CSRF token) never goes into source; the field stays, empty.
    if (isToken && a.name === "value") {
      out.push('defaultValue=""');
      continue;
    }
    const name = RENAME[a.name] ?? a.name;
    if (!KNOWN.has(a.name) && !a.name.startsWith("data-") && !a.name.startsWith("aria-")) {
      out.push(`{...({ ${JSON.stringify(a.name)}: ${JSON.stringify(a.value)} } as object)}`);
      continue;
    }
    if (NUMERIC.has(a.name) && /^-?\d+$/.test(a.value)) {
      out.push(`${name}={${a.value}}`);
      continue;
    }
    if (a.name === "style") out.push(`style=${styleObject(a.value)}`);
    else if (BOOL.has(a.name)) out.push(name);
    else if (a.name === "value" && (n.tagName === "input" || n.tagName === "textarea")) out.push(`defaultValue=${jsxString(a.value)}`);
    else if (a.name === "checked") out.push("defaultChecked");
    else out.push(`${name}=${jsxString(a.name === "alt" || a.name === "title" || a.name === "placeholder" || a.name === "aria-label" ? swapBrand(a.value) : a.value)}`);
  }
  return out.length ? " " + out.join(" ") : "";
}

/** Hooks a page needs into generated markup: props rendered as an element's first child, and event handlers. */
export interface Hooks {
  /** selector → prop name rendered as the first child of the first matching element */
  slots?: Array<[(n: Node) => boolean, string]>;
  /** selector → [attribute, prop name], e.g. form → onSubmit */
  handlers?: Array<[(n: Node) => boolean, string, string]>;
  used?: Set<string>;
}
let hooks: Hooks = {};

// Parents where a whitespace text node is not allowed (React warns) or never renders.
const NO_WHITESPACE = new Set(["html", "head", "table", "thead", "tbody", "tfoot", "tr", "colgroup", "select", "optgroup", "svg", "g", "defs"]);

export function toJsx(n: Node, indent = "", parent = ""): string {
  if (n.nodeName === "#text") {
    const t = n.value ?? "";
    // JSX drops whitespace at line breaks, but the browser renders it between
    // inline elements ("Visit <a>notifications</a> to"), so it is kept explicitly.
    if (!t.trim()) return t && !NO_WHITESPACE.has(parent) ? '{" "}' : "";
    const lead = /^\s/.test(t) ? '{" "}' : "";
    const trail = /\s$/.test(t) ? '{" "}' : "";
    return lead + esc(swapBrand(t.trim().replace(/\s+/g, " "))) + trail;
  }
  if (n.nodeName === "#comment" || !n.tagName || DROP_TAGS.has(n.tagName)) return "";
  const tag = n.tagName;
  let a = attrs(n);
  for (const [m, attr, prop] of hooks.handlers ?? []) {
    if (m(n) && !hooks.used?.has(`h:${prop}`)) {
      a += ` ${attr}={props.${prop}}`;
      hooks.used?.add(`h:${prop}`);
    }
  }
  let slot = "";
  let replace = false;
  for (const [m, prop] of hooks.slots ?? []) {
    // "!prop" replaces the element's children instead of preceding them.
    const name = prop.replace(/^!/, "");
    if (m(n) && !hooks.used?.has(`s:${name}`)) {
      slot = `${indent}  {props.${name}}`;
      replace = prop.startsWith("!");
      hooks.used?.add(`s:${name}`);
    }
  }
  if (VOID.has(tag)) return `${indent}<${tag}${a} />`;
  const kids = [...(slot ? [slot] : []), ...(replace ? [] : trimEnds(n.childNodes ?? []).map((c) => toJsx(c, indent + "  ", tag)).filter((s) => s !== ""))];
  if (!kids.length) return `${indent}<${tag}${a} />`;
  const inline = kids.every((k) => !k.startsWith(indent + "  <"));
  if (inline) return `${indent}<${tag}${a}>${kids.join("").trim()}</${tag}>`;
  return `${indent}<${tag}${a}>\n${kids.map((k) => (k.startsWith(indent + "  ") ? k : indent + "  " + k.trim())).join("\n")}\n${indent}</${tag}>`;
}

/** An element's leading and trailing whitespace-only text never renders; drop it. */
function trimEnds(kids: Node[]): Node[] {
  const blank = (k: Node | undefined) => k?.nodeName === "#text" && !(k.value ?? "").trim();
  let a = 0;
  let b = kids.length;
  while (a < b && blank(kids[a])) a++;
  while (b > a && blank(kids[b - 1])) b--;
  return kids.slice(a, b);
}

function findAll(n: Node, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (pred(n)) out.push(n);
  for (const c of n.childNodes ?? []) findAll(c, pred, out);
  return out;
}

/** A tiny selector: tag, #id, .class, or tag.class. */
export function matcher(sel: string): (n: Node) => boolean {
  const m = sel.match(/^([a-z0-9-]*)(?:#([\w-]+))?((?:\.[\w-]+)*)$/i);
  if (!m) throw new Error(`unsupported selector ${sel}`);
  const [, tag, id, classes] = m;
  const want = (classes ?? "").split(".").filter(Boolean);
  return (n) => {
    if (!n.tagName) return false;
    if (tag && n.tagName !== tag) return false;
    const attr = (k: string) => n.attrs?.find((x) => x.name === k)?.value ?? "";
    if (id && attr("id") !== id) return false;
    const cls = attr("class").split(/\s+/);
    return want.every((c) => cls.includes(c));
  };
}

export interface Patch {
  find: string;
  replace: string;
  /** Props the replacement reads, as "name: type". */
  props?: string[];
}

function reactImports(props: string[], extra: string[]): string {
  const names = [
    ...(props.some((p) => !p.startsWith("on")) || extra.some((p) => p.includes("ReactNode")) ? ["ReactNode"] : []),
    ...(props.some((p) => p.startsWith("on")) || extra.some((p) => p.includes("FormEventHandler")) ? ["FormEventHandler"] : []),
  ];
  return names.length ? `import type { ${names.join(", ")} } from "react";\n\n` : "";
}

export function applyPatches(src: string, patches: Patch[]): string {
  for (const p of patches) {
    const re = new RegExp(p.find, "g");
    if (!re.test(src)) throw new Error(`patch did not match: ${p.find}`);
    src = src.replace(new RegExp(p.find, "g"), p.replace);
  }
  return src;
}

export function convert(
  html: string,
  select: string,
  name: string,
  source: string,
  opts: { slots?: string[]; handlers?: string[]; extraProps?: string[]; nth?: number; inner?: boolean; after?: string; take?: number } = {},
): string {
  const doc = parse(html) as unknown as Node;
  const root = findAll(doc, matcher(select))[(opts.nth ?? 1) - 1] ?? null;
  if (!root) throw new Error(`no element matches ${select}`);
  // "selector=prop" for slots, "selector:attr=prop" for handlers.
  hooks = {
    used: new Set(),
    slots: (opts.slots ?? []).map((x) => {
      const [sel, prop] = x.split("=");
      return [matcher(sel!), prop!] as [(n: Node) => boolean, string];
    }),
    handlers: (opts.handlers ?? []).map((x) => {
      const [selAttr, prop] = x.split("=");
      const [sel, attr] = selAttr!.split(":");
      return [matcher(sel!), attr!, prop!] as [(n: Node) => boolean, string, string];
    }),
  };
  const props = [...(opts.slots ?? []), ...(opts.handlers ?? [])].map((x) => x.split("=")[1]!.replace(/^!/, ""));
  const extra = [...new Set(opts.extraProps ?? [])];
  if (opts.after) props.push(opts.after);
  const anyProps = props.length + extra.length > 0;
  // --inner renders the element's children (e.g. everything in <body>) as a
  // fragment; --after appends a prop after them (a page's teleported overlays).
  const body = opts.inner
    ? `    <>\n${(root.childNodes ?? [])
        .filter((c) => c.tagName)
        .slice(0, opts.take ?? Infinity)
        .map((c) => toJsx(c, "      ")).filter((x) => x.trim() !== "").join("\n")}${opts.after ? `\n      {props.${opts.after}}` : ""}\n    </>`
    : toJsx(root, "    ");
  return `// GENERATED by tools/parity/port/html2tsx.ts from the reference's rendered ${source}.
// Derived from coollabsio/coolify@91b7e3e (Apache-2.0): DOM, classes and copy are Coolify's;
// Livewire/Alpine attributes and scripts dropped, brand swapped. Regenerate, do not hand-edit;
// behaviour lives in the page component that renders this.
${reactImports(props, extra)}${anyProps ? `export interface ${name}Props {\n${[...props.map((p) => `  ${p}?: ${p.startsWith("on") ? "FormEventHandler<HTMLFormElement>" : "ReactNode"};`), ...extra.map((p) => `  ${p};`)].join("\n")}\n}\n\n` : ""}export function ${name}(${anyProps ? `props: ${name}Props` : ""}) {
  return (
${body}
  );
}
`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const opt = (k: string) => {
    const i = args.indexOf(`--${k}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const all = (k: string) => args.flatMap((a, i) => (a === `--${k}` ? [args[i + 1]!] : []));
  const patchFile = opt("patch");
  const patches: Patch[] = patchFile ? JSON.parse(readFileSync(patchFile, "utf8")) : [];
  const out = applyPatches(
    convert(readFileSync(opt("html")!, "utf8"), opt("select") ?? "body", opt("name") ?? "Page", opt("source") ?? opt("html")!, {
      slots: all("slot"),
      handlers: all("handler"),
      extraProps: patches.flatMap((x) => x.props ?? []),
      nth: opt("nth") ? Number(opt("nth")) : 1,
      inner: args.includes("--inner"),
      ...(opt("take") ? { take: Number(opt("take")) } : {}),
      ...(opt("after") ? { after: opt("after")! } : {}),
    }),
    patches,
  );
  if (opt("out")) writeFileSync(opt("out")!, out);
  else process.stdout.write(out);
}
