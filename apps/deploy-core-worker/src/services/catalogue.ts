// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/shared.php (get_service_templates,
// resolve_service_template_key), bootstrap/helpers/constants.php (NEEDS_TO_CONNECT_TO_PREDEFINED_NETWORK)
// and app/Livewire/Project/New/Select.php (loadServices) (Apache-2.0), modified.
//
// The one-click service catalogue: what Coolify reads from templates/service-templates-latest.json.
// Freeploy ships the catalogue inside the Worker (catalogue-data.ts, generated from Coolify's templates
// by scripts/build-service-catalogue.mjs) instead of fetching it from Coolify's CDN: a Worker has no
// file system to cache it on, and what a service is created from must not change under a deployment.
import { CATALOGUE_JSON } from "./catalogue-data.js";
import type { Catalogue, CatalogueEntry } from "./catalogue-build.js";

export type { Catalogue, CatalogueEntry } from "./catalogue-build.js";

/** Services that must join the destination's network (Coolify's NEEDS_TO_CONNECT_TO_PREDEFINED_NETWORK). */
export const NEEDS_TO_CONNECT_TO_PREDEFINED_NETWORK: readonly string[] = ["pgadmin", "databasus", "redis-insight"];

let cached: Catalogue | undefined;

function byteOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `get_service_templates()`: the catalogue, sorted by key. */
export function serviceTemplates(): Catalogue {
  if (!cached) {
    const parsed = JSON.parse(CATALOGUE_JSON) as Catalogue;
    cached = Object.fromEntries(Object.keys(parsed).sort(byteOrder).map((name) => [name, parsed[name] as CatalogueEntry]));
  }
  return cached;
}

const ALIASES: Record<string, string> = { denoKV: "deno-kv" };

/** `resolve_service_template_key`: a renamed template keeps its old key as an alias. */
export function resolveServiceTemplateKey(type: string, templates: Catalogue = serviceTemplates()): string {
  const alias = ALIASES[type];
  if (type === "" || alias === undefined) return type;
  return Object.hasOwn(templates, type) ? type : alias;
}

/** The template of a `one-click-service-<name>` type, or null when the catalogue has none. */
export function serviceTemplateForType(type: string): { name: string; entry: CatalogueEntry } | null {
  if (!type.startsWith("one-click-service-")) return null;
  const templates = serviceTemplates();
  const name = resolveServiceTemplateKey(type.slice("one-click-service-".length), templates);
  const entry = Object.hasOwn(templates, name) ? templates[name] : undefined;
  if (!entry || !entry.compose) return null;
  return { name, entry };
}

/** base64 to text, as PHP's base64_decode gives the bytes and the parser reads them as UTF-8. */
export function decodeBase64Text(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}
