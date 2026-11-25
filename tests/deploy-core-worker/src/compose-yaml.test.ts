// The Compose YAML reader and writer (DP-59) against Symfony YAML as Coolify calls it:
// fixtures/compose-yaml/goldens.json is what coollabsio/coolify@91b7e3e's PHP returns for cases.json and
// for every file of templates/compose (emit.php, see the README there). Every dump must be byte-equal,
// every parsed value equal in type and order, and every one of the 390 templates must come out of
// parse + dump with the hash PHP got.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { PhpArray, PhpFloat, phpFloatToString, type PhpValue } from "@deploy-core-worker/compose/php";
import { YamlParseError, dumpYaml, parseDockerComposeYaml, parseYaml } from "@deploy-core-worker/compose/yaml";

// Jest runs from tests/deploy-core-worker (its rootDir).
const dir = join(process.cwd(), "fixtures", "compose-yaml");

type Typed = null | boolean | number | string | Typed[] | { $float: string } | { $map: [number | string, Typed][] };
interface Cases {
  dump: { id: string; value: Typed }[];
  parse: { id: string; yaml: string; compose?: boolean }[];
}
interface Goldens {
  dump: Record<string, string>;
  parse: Record<string, { ok: true; value: Typed; dump: string } | { ok: false; error: string }>;
  templates: Record<string, string>;
}

const cases = JSON.parse(readFileSync(join(dir, "cases.json"), "utf8")) as Cases;
const goldens = JSON.parse(readFileSync(join(dir, "goldens.json"), "utf8")) as Goldens;
const templates = JSON.parse(gunzipSync(readFileSync(join(dir, "templates.json.gz"))).toString("utf8")) as Record<string, string>;

function decode(value: Typed): PhpValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return PhpArray.list(value.map(decode));
  if ("$float" in value) {
    const text = value.$float;
    return new PhpFloat(text === "INF" ? Infinity : text === "-INF" ? -Infinity : text === "NAN" ? NaN : Number(text));
  }
  return PhpArray.from(value.$map.map(([key, item]) => [key, decode(item)] as const));
}

function encode(value: PhpValue): Typed {
  if (value instanceof PhpFloat) return { $float: phpFloatToString(value.value) };
  if (value instanceof PhpArray) return { $map: value.entries().map(([key, item]) => [key, encode(item)]) };
  if (typeof value === "bigint") return Number(value);
  return value;
}

describe("dumpYaml against Symfony's Yaml::dump($value, 10, 2)", () => {
  it.each(cases.dump.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    expect(dumpYaml(decode(c.value))).toBe(goldens.dump[c.id]);
  });
});

describe("parseYaml against Symfony's Yaml::parse", () => {
  it.each(cases.parse.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const golden = goldens.parse[c.id];
    if (!golden) throw new Error(`no golden for ${c.id}`);
    const parse = c.compose ? parseDockerComposeYaml : parseYaml;
    if (!golden.ok) {
      // Symfony's messages carry a line and a snippet; the port only has to refuse the same documents.
      expect(() => parse(c.yaml)).toThrow(YamlParseError);
      return;
    }
    const value = parse(c.yaml);
    expect(encode(value)).toEqual(golden.value);
    expect(dumpYaml(value)).toBe(golden.dump);
  });
});

describe("Coolify's templates through parse and dump", () => {
  const files = Object.keys(goldens.templates);

  it("covers every file of templates/compose", () => {
    expect(files).toHaveLength(390);
    expect(Object.keys(templates).sort()).toEqual([...files].sort());
  });

  it("gives PHP's bytes for each of them", () => {
    const different: string[] = [];
    for (const file of files) {
      let hash: string;
      try {
        hash = createHash("sha256").update(dumpYaml(parseYaml(templates[file] ?? "")), "utf8").digest("hex");
      } catch (error) {
        hash = `threw ${String(error)}`;
      }
      if (hash !== goldens.templates[file]) different.push(file);
    }
    expect(different).toEqual([]);
  });
});
