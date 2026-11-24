// How many of <body>'s element children are the layout's, not a page's: the
// shortest prefix the first page's capture shares (by tag, class and id) with
// each of the others. Two pages can share a page-level overlay by chance, so
// pass three or more.
//   node tools/parity/port/layout-take.ts <a.html> <b.html> [<c.html> ...]
import { readFileSync } from "node:fs";
import { parse } from "parse5";

type N = { tagName?: string; attrs?: Array<{ name: string; value: string }>; childNodes?: N[] };

function bodyKids(file: string): string[] {
  const doc = parse(readFileSync(file, "utf8")) as unknown as N;
  const html = doc.childNodes!.find((n) => n.tagName === "html")!;
  const body = html.childNodes!.find((n) => n.tagName === "body")!;
  return body.childNodes!.filter((n) => n.tagName).map((n) => `${n.tagName}.${n.attrs?.find((a) => a.name === "class")?.value ?? ""}#${n.attrs?.find((a) => a.name === "id")?.value ?? ""}`);
}

export function sharedPrefix(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [first, ...rest] = process.argv.slice(2).map(bodyKids);
  console.log(Math.min(...rest.map((k) => sharedPrefix(first!, k))));
}
