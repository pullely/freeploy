// The port of symfony/yaml's Parser and Inline (DP-110, apps/deploy-core-worker/src/yaml/symfony) against PHP:
// fixtures/symfony-yaml/goldens.json is what Yaml::parse() of symfony/yaml v8.1.11 — coollabsio/coolify@91b7e3e's
// composer.lock — and Coolify's ValidCloudInitYaml return for every document of cases.json (emit.php, see the README
// there): the hand-written cases and 3000 generated ones. Every parsed value must be equal in type and key order, every
// ParseException message equal byte for byte (its line and snippet included), and every failure of the rule the same
// message. The 390 Compose templates of fixtures/compose-yaml must also come out of this parser and compose/yaml.ts's
// dumper with the hash PHP got.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { PhpArray, PhpFloat } from "@deploy-core-worker/compose/php";
import { TaggedValue, dumpYaml } from "@deploy-core-worker/compose/yaml";
import { SymfonyYamlParseException, symfonyYamlParse, type YamlValue } from "@deploy-core-worker/yaml/symfony/index";
import { cloudInitYamlError, validCloudInitYaml } from "@deploy-core-worker/cloud-init-scripts/validation";

// Jest runs from tests/deploy-core-worker (its rootDir).
const dir = join(process.cwd(), "fixtures", "symfony-yaml");

type Typed = null | boolean | number | string | { $float: string } | { $map: [number | string, Typed][] } | { $tagged: [string, Typed] };
interface Golden {
  parse: { ok: true; value: Typed } | { ok: false; error: string; line: number; snippet: string | null };
  rule: string | null;
}
const cases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as { cases: { id: string; yaml: string }[]; fuzz: { id: string; yaml: string }[] };
const goldens = JSON.parse(readFileSync(join(dir, "goldens.json"), "utf8")) as { "symfony/yaml": string; cases: Record<string, Golden> };
const all = [...cases.cases, ...cases.fuzz];

/** A parsed value as emit.php's encodeTyped() writes it; floats compared by value (var_export's text is PHP's). */
function typed(v: YamlValue): unknown {
  if (v instanceof PhpFloat) return { $float: Number.isNaN(v.value) ? "NAN" : v.value === Infinity ? "INF" : v.value === -Infinity ? "-INF" : v.value };
  if (v instanceof TaggedValue) return { $tagged: [v.tag, typed(v.value)] };
  if (v instanceof PhpArray) return { $map: v.entries().map(([k, x]) => [k, typed(x as YamlValue)]) };
  if (typeof v === "bigint") return Number(v);
  return v;
}
const normal = (t: Typed): unknown =>
  JSON.parse(JSON.stringify(t), (_k, x: unknown) => (x && typeof x === "object" && "$float" in x && !["NAN", "INF", "-INF"].includes((x as { $float: string }).$float) ? { $float: Number((x as { $float: string }).$float) } : x));

describe("symfony/yaml's goldens", () => {
  it("are PHP's v8.1.11, for every case", () => {
    expect(goldens["symfony/yaml"]).toBe("v8.1.11");
    expect(cases.fuzz.length).toBe(3000);
    expect(Object.keys(goldens.cases).sort()).toEqual(all.map((c) => c.id).sort());
    // Both outcomes are well represented.
    expect(all.filter((c) => goldens.cases[c.id]!.parse.ok).length).toBeGreaterThan(1000);
    expect(all.filter((c) => !goldens.cases[c.id]!.parse.ok).length).toBeGreaterThan(1000);
  });
});

describe("Yaml::parse() as Symfony does it", () => {
  it.each(all.map((c) => [c.id, c] as const))("%s", (id, c) => {
    const g = goldens.cases[id]!;
    if (g.parse.ok) {
      expect(typed(symfonyYamlParse(c.yaml))).toEqual(normal(g.parse.value));
      return;
    }
    let error: unknown = null;
    try {
      symfonyYamlParse(c.yaml);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SymfonyYamlParseException);
    expect((error as SymfonyYamlParseException).message).toBe(g.parse.error);
    expect((error as SymfonyYamlParseException).parsedLine).toBe(g.parse.line);
  });
});

describe("ValidCloudInitYaml as Coolify runs it", () => {
  it("fails with Coolify's message, or passes, for every case", () => {
    const different = all.filter((c) => validCloudInitYaml(c.yaml) !== goldens.cases[c.id]!.rule).map((c) => c.id);
    expect(different).toEqual([]);
  });

  it("names the console's field", () => {
    expect(cloudInitYamlError("a: 1\na: 2\n")).toBe('The script must be either a valid bash script (starting with #!) or valid cloud-config YAML. YAML parse error: Duplicate key "a" detected at line 2 (near "a: 2").');
    // The header is taken off first, so the lines are counted from the one after it (the "cloud-config unclosed" case).
    expect(cloudInitYamlError("#cloud-config\nruncmd: [ls,\n")).toBe('The script must be valid YAML format. Error: Malformed inline YAML string at line 1 (near "runcmd: [ls,").');
  });
});

describe("Coolify's Compose templates through this parser", () => {
  it("give the hashes of Yaml::dump(Yaml::parse()) that PHP got (fixtures/compose-yaml)", () => {
    const composeDir = join(process.cwd(), "fixtures", "compose-yaml");
    const templates = JSON.parse(gunzipSync(readFileSync(join(composeDir, "templates.json.gz"))).toString("utf8")) as Record<string, string>;
    const hashes = (JSON.parse(readFileSync(join(composeDir, "goldens.json"), "utf8")) as { templates: Record<string, string> }).templates;
    expect(Object.keys(templates).length).toBe(390);
    const different = Object.entries(templates).filter(([file, raw]) => createHash("sha256").update(dumpYaml(symfonyYamlParse(raw) as never), "utf8").digest("hex") !== hashes[file]);
    expect(different.map(([file]) => file)).toEqual([]);
  });
});
