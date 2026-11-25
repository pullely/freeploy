// The one-click service catalogue (DP-59). fixtures/services/catalogue-golden.json is what Coolify's own
// `php artisan generate:services` writes for the templates of coollabsio/coolify@91b7e3e (emit-catalogue.php,
// see the README there), with the Compose text replaced by its sha256 and without the date git supplies.
// The TypeScript generator must give the same entries, in the same order, from the same template files
// (fixtures/compose-yaml/templates.json.gz), and the catalogue the Worker ships must be exactly that.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { buildCatalogue, catalogueJson, processTemplateFile, templateHeader, type CatalogueEntry } from "@deploy-core-worker/services/catalogue-build";
import { CATALOGUE_JSON } from "@deploy-core-worker/services/catalogue-data";
import { NEEDS_TO_CONNECT_TO_PREDEFINED_NETWORK, decodeBase64Text, resolveServiceTemplateKey, serviceTemplateForType, serviceTemplates } from "@deploy-core-worker/services/catalogue";

// Jest runs from tests/deploy-core-worker (its rootDir).
const fixtures = join(process.cwd(), "fixtures");
const templates = JSON.parse(gunzipSync(readFileSync(join(fixtures, "compose-yaml", "templates.json.gz"))).toString("utf8")) as Record<string, string>;
const golden = JSON.parse(readFileSync(join(fixtures, "services", "catalogue-golden.json"), "utf8")) as Record<string, Record<string, unknown>>;
const shipped = JSON.parse(CATALOGUE_JSON) as Record<string, CatalogueEntry>;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("the catalogue generator against Coolify's generate:services", () => {
  const dates = Object.fromEntries(Object.keys(templates).map((file) => [file, shipped[file.replace(/\.[^.]*$/, "")]?.template_last_updated_at ?? null]));
  const built = buildCatalogue(templates, dates);

  it("has Coolify's entries in Coolify's order: 359 of the 390 templates, 31 are marked ignore", () => {
    expect(Object.keys(templates)).toHaveLength(390);
    expect(Object.keys(built)).toEqual(Object.keys(golden));
    expect(Object.keys(built)).toHaveLength(359);
    const ignored = Object.keys(templates).filter((file) => processTemplateFile(file, templates[file] ?? "", null, templates) === null);
    expect(ignored).toHaveLength(31);
  });

  it("gives every field of every entry as PHP does, the Compose text by its sha256", () => {
    const different: string[] = [];
    for (const [name, entry] of Object.entries(built)) {
      const comparable: Record<string, unknown> = { ...entry, compose: sha256(entry.compose) };
      delete comparable.template_last_updated_at;
      if (entry.envs !== undefined) comparable.envs = sha256(entry.envs);
      if (JSON.stringify(comparable) !== JSON.stringify(golden[name])) different.push(name);
    }
    expect(different).toEqual([]);
  });

  it("is, as JSON text, exactly the catalogue the Worker ships", () => {
    expect(catalogueJson(built)).toBe(CATALOGUE_JSON);
  });

  it("writes JSON as PHP's JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES does", () => {
    const entry: CatalogueEntry = { documentation: "https://a/b", slogan: "caf\u00e9 \u2014 \"x\"", compose: "", tags: null, category: null, logo: "l", minversion: "0.0.0", template_last_updated_at: null };
    expect(catalogueJson({ a: entry })).toBe(
      '{\n    "a": {\n        "documentation": "https://a/b",\n        "slogan": "caf\\u00e9 \\u2014 \\"x\\"",\n        "compose": "",\n        "tags": null,\n        "category": null,\n        "logo": "l",\n        "minversion": "0.0.0",\n        "template_last_updated_at": null\n    }\n}\n',
    );
  });

  it("reads the header comments as Coolify does", () => {
    const header = templateHeader("# documentation: https://example.com/docs\n# slogan: A: B\n#tags: A, b ,,c\n# port: 80\nservices:\n  a:\n    image: x # not: a header\n# ignore: false\n");
    expect(Object.fromEntries(header)).toEqual({ documentation: "https://example.com/docs", slogan: "A: B", tags: "A, b ,,c", port: "80", ignore: "false" });
    const processed = processTemplateFile("x.yaml", "# tags: A, b ,,c\n# amd_only: true\nservices:\n  a:\n    image: x\n", "2026-01-01T00:00:00+00:00");
    // Collection::filter keeps the keys, so a list with a gap is an object in JSON.
    expect(processed?.entry.tags).toEqual({ "0": "a", "1": "b", "3": "c" });
    expect(processed?.entry.amd_only).toBe(true);
    expect(processed?.entry.documentation).toBe("https://coolify.io/docs");
    expect(processed?.entry.slogan).toBe("X.yaml");
    expect(processTemplateFile("x.yaml", "# ignore: true\nservices: {}\n", null)).toBeNull();
  });
});

describe("the shipped catalogue", () => {
  it("is sorted by key and decodes to the Compose text PHP dumped", () => {
    const names = Object.keys(serviceTemplates());
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(names).toHaveLength(359);
    for (const name of names) expect(sha256(serviceTemplates()[name]?.compose ?? "")).toBe(golden[name]?.compose);
    const appwrite = serviceTemplateForType("one-click-service-appwrite");
    expect(decodeBase64Text(appwrite?.entry.compose ?? "").startsWith("services:\n  appwrite:\n")).toBe(true);
  });

  it("resolves a type as Coolify does", () => {
    expect(serviceTemplateForType("one-click-service-does-not-exist")).toBeNull();
    expect(serviceTemplateForType("postgresql")).toBeNull();
    expect(resolveServiceTemplateKey("denoKV", { "deno-kv": shipped.appwrite as CatalogueEntry })).toBe("deno-kv");
    expect(resolveServiceTemplateKey("denoKV", { denoKV: shipped.appwrite as CatalogueEntry })).toBe("denoKV");
    expect(resolveServiceTemplateKey("appwrite")).toBe("appwrite");
    expect(NEEDS_TO_CONNECT_TO_PREDEFINED_NETWORK).toEqual(["pgadmin", "databasus", "redis-insight"]);
  });
});
