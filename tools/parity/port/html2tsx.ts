// Turn a reference page's rendered markup (tools/parity capture, desktop-light.html)
// into the JSX a deploy-web page starts from (DP3+). The DOM, classes and copy
// are Coolify's; behaviour is re-implemented in React, so Livewire (wire:*) and
// Alpine (x-*, @*, :*) attributes and scripts are dropped, and the brand is
// swapped (design §3.1, risks DP-F).
//
//   node tools/parity/port/html2tsx.ts --html <desktop-light.html> --select "main" \
//     --name LoginPage [--out apps/deploy-web/src/pages/Login.generated.tsx]
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

const esc = (s: string) => s.replace(/[{}<>]/g, (c) => `{"${c}"}`);

function styleObject(css: string): string {
  const entries = css.split(";").map((d) => d.trim()).filter(Boolean).map((d) => {
    const [k, ...v] = d.split(":");
    const key = k!.trim().replace(/^-/, "").replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    return `${JSON.stringify(key)}: ${JSON.stringify(v.join(":").trim())}`;
  });
  return `{{ ${entries.join(", ")} }}`;
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
    else if (a.name === "value" && (n.tagName === "input" || n.tagName === "textarea")) out.push(`defaultValue=${JSON.stringify(a.value)}`);
    else if (a.name === "checked") out.push("defaultChecked");
    else out.push(`${name}=${JSON.stringify(a.name === "alt" || a.name === "title" || a.name === "placeholder" || a.name === "aria-label" ? swapBrand(a.value) : a.value)}`);
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

export function toJsx(n: Node, indent = ""): string {
  if (n.nodeName === "#text") {
    const t = n.value ?? "";
    if (!t.trim()) return /\n/.test(t) ? "" : t ? " " : "";
    return esc(swapBrand(t.replace(/\s+/g, " ")));
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
  for (const [m, prop] of hooks.slots ?? []) {
    if (m(n) && !hooks.used?.has(`s:${prop}`)) {
      slot = `${indent}  {props.${prop}}`;
      hooks.used?.add(`s:${prop}`);
    }
  }
  if (VOID.has(tag)) return `${indent}<${tag}${a} />`;
  const kids = [...(slot ? [slot] : []), ...(n.childNodes ?? []).map((c) => toJsx(c, indent + "  ")).filter((s) => s !== "")];
  if (!kids.length) return `${indent}<${tag}${a} />`;
  const inline = kids.every((k) => !k.startsWith(indent + "  <"));
  if (inline) return `${indent}<${tag}${a}>${kids.join("").trim()}</${tag}>`;
  return `${indent}<${tag}${a}>\n${kids.map((k) => (k.startsWith(indent + "  ") ? k : indent + "  " + k.trim())).join("\n")}\n${indent}</${tag}>`;
}

function find(n: Node, pred: (n: Node) => boolean): Node | null {
  if (pred(n)) return n;
  for (const c of n.childNodes ?? []) {
    const r = find(c, pred);
    if (r) return r;
  }
  return null;
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

export function convert(html: string, select: string, name: string, source: string, opts: { slots?: string[]; handlers?: string[] } = {}): string {
  const doc = parse(html) as unknown as Node;
  const root = find(doc, matcher(select));
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
  const props = [...(opts.slots ?? []), ...(opts.handlers ?? [])].map((x) => x.split("=")[1]!);
  return `// GENERATED by tools/parity/port/html2tsx.ts from the reference's rendered ${source}.
// Derived from coollabsio/coolify@91b7e3e (Apache-2.0): DOM, classes and copy are Coolify's;
// Livewire/Alpine attributes and scripts dropped, brand swapped. Regenerate, do not hand-edit;
// behaviour lives in the page component that renders this.
${props.length ? `import type { ReactNode, FormEventHandler } from "react";\n\n` : ""}${props.length ? `export interface ${name}Props {\n${props.map((p) => `  ${p}?: ${p.startsWith("on") ? "FormEventHandler<HTMLFormElement>" : "ReactNode"};`).join("\n")}\n}\n\n` : ""}export function ${name}(${props.length ? `props: ${name}Props` : ""}) {
  return (
${toJsx(root, "    ")}
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
  const out = convert(readFileSync(opt("html")!, "utf8"), opt("select") ?? "body", opt("name") ?? "Page", opt("source") ?? opt("html")!, { slots: all("slot"), handlers: all("handler") });
  if (opt("out")) writeFileSync(opt("out")!, out);
  else process.stdout.write(out);
}
