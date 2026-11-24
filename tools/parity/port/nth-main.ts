// Which match of `div.w-full.mx-auto` (1-based, document order) is the page
// wrapper inside <main>: overlays before it use the same classes.
//   node tools/parity/port/nth-main.ts <page.html>
import { readFileSync } from "node:fs";
import { parse } from "parse5";

type N = { tagName?: string; attrs?: Array<{ name: string; value: string }>; childNodes?: N[] };
const has = (n: N) => {
  const cls = (n.attrs?.find((a) => a.name === "class")?.value ?? "").split(/\s+/);
  return n.tagName === "div" && cls.includes("w-full") && cls.includes("mx-auto");
};
let count = 0;
let found = 0;
function walk(n: N, inMain: boolean): void {
  if (found) return;
  if (has(n)) {
    count++;
    if (inMain) found = count;
  }
  for (const c of n.childNodes ?? []) walk(c, inMain || n.tagName === "main");
}
walk(parse(readFileSync(process.argv[2]!, "utf8")) as unknown as N, false);
if (!found) throw new Error("no page wrapper inside <main>");
console.log(found);
