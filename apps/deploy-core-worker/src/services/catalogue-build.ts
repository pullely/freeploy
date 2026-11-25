// Derived from coollabsio/coolify@91b7e3e:app/Console/Commands/Generate/Services.php (Apache-2.0),
// modified.
//
// Coolify's `php artisan generate:services`: one catalogue entry per file of templates/compose, read from
// the `# key: value` comment lines of the file and from the Compose document itself, which is stored as
// base64 of `Yaml::dump(Yaml::parse($content), 10, 2)` — so a template loses its comments and gets
// Symfony's formatting before any service is created from it. `buildCatalogueJson` returns the text of
// templates/service-templates-latest.json (the file Coolify reads), byte for byte, for the same inputs.
//
// The only input that is not a template file is `template_last_updated_at`: Coolify asks git for the
// last commit that touched the file. The caller passes it (scripts/build-service-catalogue.mjs).
import { dumpYaml, parseYaml } from "../compose/yaml.js";

/** One entry of the catalogue, in the key order Coolify writes. */
export interface CatalogueEntry {
  documentation: string;
  slogan: string;
  compose: string;
  tags: string[] | Record<string, string> | null;
  category: string | null;
  logo: string;
  minversion: string;
  template_last_updated_at: string | null;
  port?: string;
  envs?: string;
  amd_only?: true;
  arm_only?: true;
  outdated?: true;
}

export type Catalogue = Record<string, CatalogueEntry>;

const PHP_TRIM = /^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g;

function trim(value: string): string {
  return value.replace(PHP_TRIM, "");
}

/** `filter_var($value, FILTER_VALIDATE_BOOLEAN)` as `Stringable::toBoolean` uses it. */
function toBoolean(value: string | undefined): boolean {
  return ["1", "true", "on", "yes"].includes(trim(value ?? "").toLowerCase());
}

function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The `# key: value` lines of a template: every line of the file is looked at, the last one wins. */
export function templateHeader(content: string): Map<string, string> {
  const data = new Map<string, string>();
  for (const line of content.split("\n")) {
    // /^#(?<key>.*):(?<value>.*)$/U — ungreedy: the key ends at the first colon. `.` does not match a line
    // feed, and `$` also matches before a final line feed, which a line of explode("\n") never has.
    const match = /^#([^\n]*?):([^\n]*)$/.exec(line);
    if (match) data.set(trim(match[1] ?? ""), trim(match[2] ?? ""));
  }
  return data;
}

/**
 * mb_convert_case($value, MB_CASE_TITLE): a letter is upper case when the character before it — skipping
 * the ones Unicode calls case-ignorable, such as "." and "'" — is not a letter, and lower case otherwise.
 * So "n8n" is "N8N", "x.yaml" is "X.yaml" and "v2.yml" is "V2.Yml".
 */
function titleCase(value: string): string {
  let result = "";
  let afterLetter = false;
  for (const character of value) {
    if (/[\p{Lu}\p{Ll}\p{Lt}]/u.test(character)) {
      result += afterLetter ? character.toLowerCase() : character.toUpperCase();
      afterLetter = true;
    } else {
      result += character;
      if (!/['.:\u00b7\u2019\p{Mn}\p{Me}\p{Cf}\p{Lm}\p{Sk}]/u.test(character)) afterLetter = false;
    }
  }
  return result;
}

/** `Str::headline`: the words of a key or file name, each in title case ("n8n-with-postgresql" is "N8N With Postgresql"). */
export function headline(value: string): string {
  let parts = value.split(/\s+/u);
  // One word is split before each upper case letter (Str::ucsplit).
  if (parts.length <= 1) parts = (parts[0] ?? "").split(/(?=\p{Lu})/u);
  return parts
    .map(titleCase)
    .join("_")
    .replace(/[-_ ]/g, "_")
    .split("_")
    .filter((word) => word !== "" && word !== "0")
    .join(" ");
}

/** `processFile`: the entry and its name, or null for a template marked `# ignore: true`. */
export function processTemplateFile(file: string, content: string, lastUpdatedAt: string | null, envFiles: Record<string, string> = {}): { name: string; entry: CatalogueEntry } | null {
  const data = templateHeader(content);
  if (toBoolean(data.get("ignore"))) return null;
  const documentation = data.get("documentation");
  const compose = base64(dumpYaml(parseYaml(content)));
  const tagList = (data.get("tags") ?? "").toLowerCase().split(",").map(trim);
  // Collection::filter keeps the keys: a list with a gap is written by json_encode as an object.
  const kept = tagList.map((tag, index) => [index, tag] as const).filter(([, tag]) => tag !== "" && tag !== "0");
  let tags: CatalogueEntry["tags"] = null;
  if (kept.length > 0) {
    tags = kept.every(([index], position) => index === position) ? kept.map(([, tag]) => tag) : Object.fromEntries(kept.map(([index, tag]) => [String(index), tag]));
  }
  const entry: CatalogueEntry = {
    // Coolify's link tracking parameter is part of its catalogue; the catalogue is kept as Coolify writes it.
    documentation: documentation ? `${documentation}?utm_source=coolify.io` : "https://coolify.io/docs",
    slogan: data.get("slogan") ?? headline(file),
    compose,
    tags,
    category: data.get("category") ?? null,
    logo: data.get("logo") ?? "svgs/default.webp",
    minversion: data.get("minversion") ?? "0.0.0",
    template_last_updated_at: lastUpdatedAt,
  };
  const port = data.get("port");
  if (port !== undefined && port !== "" && port !== "0") entry.port = port;
  const envFile = data.get("env_file");
  if (envFile !== undefined && envFile !== "" && envFile !== "0") {
    const envContent = envFiles[envFile];
    if (envContent === undefined) throw new Error(`The env file ${envFile} of ${file} was not given.`);
    entry.envs = base64(envContent);
  }
  if (toBoolean(data.get("amd_only"))) entry.amd_only = true;
  if (toBoolean(data.get("arm_only"))) entry.arm_only = true;
  if (toBoolean(data.get("outdated"))) entry.outdated = true;
  const name = file.replace(/\.[^.]*$/, "");
  return { name, entry };
}

/** The order of `array_merge(glob('*.yaml'), glob('*.yml'))`: each group sorted by name. */
export function templateFileOrder(files: string[]): string[] {
  const sorted = (extension: string) => files.filter((file) => file.endsWith(extension)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...sorted(".yaml"), ...sorted(".yml")];
}

/** The catalogue of a set of template files. `lastUpdatedAt` maps a file name to its date. */
export function buildCatalogue(templates: Record<string, string>, lastUpdatedAt: Record<string, string | null>): Catalogue {
  const catalogue: Catalogue = {};
  for (const file of templateFileOrder(Object.keys(templates))) {
    const processed = processTemplateFile(file, templates[file] ?? "", lastUpdatedAt[file] ?? null, templates);
    if (processed) catalogue[processed.name] = processed.entry;
  }
  return catalogue;
}

/** `json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)` followed by PHP_EOL. */
export function catalogueJson(catalogue: Catalogue): string {
  const text = JSON.stringify(catalogue, null, 4);
  let escaped = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    escaped += code > 127 ? `\\u${code.toString(16).padStart(4, "0")}` : text.charAt(index);
  }
  return `${escaped}\n`;
}
