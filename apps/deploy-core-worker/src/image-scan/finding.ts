// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/Finding.php and app/Services/ImageScan/ScannerText.php
// (clean, looksLikeChangelog, tidyTitle, storedTitle, stripTitlePrefix, fallbackTitle) (Apache-2.0), modified.
//
// One finding of a stored scan (Grype's match as the scanner keeps it), read back with Finding::fromArray()'s casts, and
// the title rules that read a stored title for display. The parser's own title() (from a description) runs when a scan is
// made, which Freeploy does not do yet, so it is not ported.
import { bool, float, isNumeric, isset, list, mbSubstr, phpTrim, record, str } from "./php.js";

export interface Finding {
  id: string;
  aliases: string[];
  severity: string;
  package: string;
  version: string;
  type: string;
  artifactId: string;
  fixedIn: string | null;
  fixState: string;
  kev: boolean;
  epss: number | null;
  risk: number | null;
  summary: string;
  layer: string;
  cvssScore: number | null;
  title: string;
  displayId: string;
  namespace: string;
  matchType: string;
}

/** Finding::fromArray(). */
export function findingFromArray(value: unknown): Finding {
  const data = record(value);
  const id = str(data.id ?? "");
  const aliases = list(data.aliases ?? []).map(str);
  const severity = str(data.severity ?? "unknown");
  const pkg = str(data.package ?? "");
  const version = str(data.version ?? "");
  const displayId = str(data.displayId ?? "");
  return {
    id,
    aliases,
    severity,
    package: pkg,
    version,
    type: str(data.type ?? ""),
    artifactId: str(data.artifactId ?? ""),
    fixedIn: isset(data.fixedIn) ? str(data.fixedIn) : null,
    fixState: str(data.fixState ?? ""),
    kev: bool(data.kev ?? false),
    epss: isset(data.epss) ? float(data.epss) : null,
    risk: isset(data.risk) ? float(data.risk) : null,
    summary: str(data.summary ?? ""),
    layer: str(data.layer ?? "app"),
    cvssScore: isNumeric(data.cvssScore) ? float(data.cvssScore) : null,
    title: storedTitle(str(data.title ?? ""), pkg, version, severity),
    displayId: displayId !== "" ? displayId : displayIdFor(id, aliases),
    namespace: str(data.namespace ?? ""),
    matchType: str(data.matchType ?? ""),
  };
}

/** A CVE ID from the finding ID or its aliases, else the finding ID. */
export function displayIdFor(id: string, aliases: readonly string[]): string {
  for (const candidate of [id, ...aliases]) if (/^CVE-\d{4}-\d{4,}$/i.test(candidate)) return candidate;
  return id;
}

// ── ScannerText ─────────────────────────────────────────────────────────────

/** Control and format characters stripped, cut to $max characters. */
export function clean(value: unknown, max: number): string {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string") return "";
  return mbSubstr(text.replace(/[\p{Cc}\p{Cf}]/gu, ""), 0, max);
}

/** A description that is a package changelog entry rather than a text about the vulnerability. */
export function looksLikeChangelog(description: string | null): boolean {
  const text = (description ?? "").replace(/^[ \t\n\r\0\x0B]+/, "");
  return text.startsWith("[") || text.startsWith("- ") || text.includes("Orabug") || text.includes("Resolves:");
}

/** Leading changelog tokens, "[Orabug: …]" groups and trailing "[CVE-…]" references removed; then stripTitlePrefix(). */
export function tidyTitle(input: string): string {
  let text = phpTrim(input);
  const changelog = /^(?:\[[^\]]*\]\s*[-:]|-)\s+/u.test(text);
  text = text.replace(/^(?:(?:\[[^\]]*\]\s*[-:]|-)\s+)+/u, "");
  text = text.replace(/\s*\[Orabug:[^\]]*\]/giu, "");
  text = text.replace(/(?:\s*\[CVE-\d{4}-\d+\])+(?=\s*[.…]?\s*$)/iu, "");
  text = phpTrim(text.replace(/\s+/gu, " "));
  if (changelog) {
    const match = /^(.+?)\s+-\s+\S/u.exec(text);
    if (match) text = match[1]!;
  }
  return stripTitlePrefix(text);
}

/** A stored title for display: the fallback while it is a changelog entry, else tidyTitle(). */
export function storedTitle(title: string, pkg: string, version: string, severity: string): string {
  const trimmed = phpTrim(title);
  if (trimmed === "" || looksLikeChangelog(trimmed)) return fallbackTitle(pkg, version, severity);
  const tidy = tidyTitle(trimmed);
  return tidy !== "" ? tidy : fallbackTitle(pkg, version, severity);
}

/** The label some advisories start with ("Issue summary:", "Summary:", "Description:", "Vulnerability:") removed. */
export function stripTitlePrefix(text: string): string {
  const stripped = text.replace(/^(?:(?:issue\s+summary|summary|description|vulnerability)\s*:\s*)+/iu, "");
  if (stripped === text) return text;
  return mbSubstr(stripped, 0, 1).toUpperCase() + mbSubstr(stripped, 1);
}

export function fallbackTitle(pkg: string, version: string, severity: string): string {
  const prefix = phpTrim(clean(phpTrim(`${pkg} ${version}`), 80).replace(/\s+/gu, " "));
  const cleaned = phpTrim(clean(severity, 16));
  const label = cleaned !== "" ? cleaned : "unknown";
  return prefix !== "" ? `${prefix}: ${label} vulnerability` : `${label} vulnerability`;
}
