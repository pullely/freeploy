// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/{ExportCells,FindingsExport,FleetExport,SbomDocument,Package}.php
// (Apache-2.0), modified.
//
// What the Security pages export (DP-114): the findings a resource's list shows and the resources the team page shows, as
// a Markdown table or IDs to copy, or a CSV or JSON file; and the SBOM of a current scan, made only from the stored package
// list (CycloneDX 1.6 or SPDX 2.3 JSON), so no image configuration can be in it. JSON is written as PHP's json_encode()
// writes it with the flags Coolify passes (pretty print with four spaces, slashes unescaped, and for every export but the
// team page's, non-ASCII characters as \u escapes; a float with a zero fraction as `7.0`).
import type { Finding } from "./finding.js";
import { iso8601, phpTrim } from "./php.js";
import { advisoryUrl } from "./resource-scans.js";
import type { IgnoreRow } from "./model.js";

// ── ExportCells ─────────────────────────────────────────────────────────────

/** A spreadsheet runs a cell that starts with one of these characters as a formula. */
const FORMULA_PREFIXES = ["=", "+", "-", "@", "\t", "\r"];

export const markdownCell = (value: string): string => phpTrim(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r/g, " ").replace(/\n/g, " ");

export function csvCell(value: string | number | boolean | null): string {
  const v = typeof value === "boolean" ? (value ? "yes" : "no") : value === null ? "" : typeof value === "number" ? phpNumber(value) : value;
  return v !== "" && FORMULA_PREFIXES.includes(v[0]!) ? `'${v}` : v;
}

/** fputcsv($handle, $fields, escape: ''): a field with a delimiter, quote, CR, LF, tab or space is quoted, quotes doubled. */
function fputcsv(fields: readonly string[]): string {
  return `${fields.map((f) => (/[,"\r\n\t ]/.test(f) ? `"${f.replace(/"/g, '""')}"` : f)).join(",")}\n`;
}

export function csvDocument(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null>>): string {
  return fputcsv(header) + rows.map((row) => fputcsv(row.map(csvCell))).join("");
}

export function markdownTable(title: string, header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines = [`**${markdownCell(title)}**`, "", `| ${header.join(" | ")} |`, `|${" --- |".repeat(header.length)}`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return `${lines.join("\n")}\n`;
}

export function markdownLink(text: string, url: string | null): string {
  return url === null || url === "" ? markdownCell(text) : `[${markdownCell(text).replace(/\[/g, "\\[").replace(/\]/g, "\\]")}](${url.replace(/ /g, "%20").replace(/\)/g, "%29")})`;
}

/** (string) of a PHP float or int. */
const phpNumber = (n: number): string => (Number.isInteger(n) ? String(n) : String(n));

// ── json_encode() ───────────────────────────────────────────────────────────

const FLOAT = "\u0000float:";
/** A float that json_encode() writes as a float (`7.0`). */
export const phpFloat = (n: number | null): number | string | null => (n === null ? null : `${FLOAT}${n}`);

/** json_encode($value, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES [| JSON_UNESCAPED_UNICODE]). */
export function phpPrettyJson(value: unknown, unescapedUnicode = false): string {
  let text = JSON.stringify(value, null, 4).replace(/"\\u0000float:([^"]+)"/g, (_all, n: string) => {
    const v = Number(n);
    return Number.isInteger(v) && Math.abs(v) < 1e15 ? `${v}.0` : String(v);
  });
  if (!unescapedUnicode) text = text.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  // PHP's pretty print writes an empty object or array without a line break, as JSON.stringify does.
  return text;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

// ── FindingsExport ──────────────────────────────────────────────────────────

/** One row of a resource's findings list. */
export interface ExportRow {
  finding: Finding;
  state: string;
  ignore: IgnoreRow | null;
  image: string;
  /** DP-116: the ID the page shows, when it is not the finding's id (the host page shows the display ID). */
  id?: string;
}

/** FindingsExport::id(): `$row['id'] ?? $row['finding']->id`. */
const rowId = (row: ExportRow): string => row.id ?? row.finding.id;

const severityLabel = (f: Finding): string => {
  const s = f.severity.toLowerCase();
  return ["critical", "high", "medium", "low"].includes(s) ? s[0]!.toUpperCase() + s.slice(1) : "Unknown";
};

/** A Markdown table for an issue, a pull request, or a chat. The image column shows only for more than one image. */
export function findingsMarkdown(title: string, rows: readonly ExportRow[], withImage: boolean, ignored: boolean): string {
  const header = ["ID", "Severity", "Package", "Version", "Fixed in"];
  if (withImage) header.push("Image");
  if (ignored) header.push("Ignored because");
  return markdownTable(
    title,
    header,
    rows.map((row) => {
      const f = row.finding;
      const id = rowId(row);
      const cells = [markdownLink(id, advisoryUrl(id)), severityLabel(f) + (f.kev ? ", known exploited" : ""), markdownCell(f.package), markdownCell(f.version), markdownCell(f.fixedIn ?? "")];
      if (withImage) cells.push(markdownCell(row.image));
      if (ignored) cells.push(markdownCell(row.ignore?.reason ?? ""));
      return cells;
    }),
  );
}

/** The finding IDs, once each, one per line. */
export function findingsIds(rows: readonly ExportRow[]): string {
  const ids = [...new Set(rows.map(rowId))];
  return ids.length === 0 ? "" : `${ids.join("\n")}\n`;
}

function findingEntries(rows: readonly ExportRow[], stateLabels: Record<string, string>) {
  return rows.map((row) => {
    const f = row.finding;
    const id = rowId(row);
    return {
      id,
      aliases: [...new Set([f.id, ...f.aliases])].filter((alias) => alias !== id),
      severity: severityLabel(f),
      known_exploited: f.kev,
      package: f.package,
      version: f.version,
      fixed_in: f.fixedIn === "" ? null : f.fixedIn,
      package_type: f.type,
      image: row.image,
      fix_state: stateLabels[row.state] ?? row.state,
      epss: f.epss,
      cvss: f.cvssScore,
      url: advisoryUrl(id),
      summary: f.summary,
      ignored: row.ignore === null ? null : { reason: row.ignore.reason, until: row.ignore.expiresAt === null ? null : isoDate(row.ignore.expiresAt) },
    };
  });
}

export function findingsCsv(rows: readonly ExportRow[], stateLabels: Record<string, string>): string {
  return csvDocument(
    ["id", "severity", "known_exploited", "package", "version", "fixed_in", "package_type", "image", "fix_state", "epss", "cvss", "aliases", "ignored_reason", "ignored_until", "url", "summary"],
    findingEntries(rows, stateLabels).map((e) => [e.id, e.severity, e.known_exploited, e.package, e.version, e.fixed_in, e.package_type, e.image, e.fix_state, e.epss, e.cvss, e.aliases.join(" "), e.ignored?.reason ?? null, e.ignored?.until ?? null, e.url, e.summary]),
  );
}

export function findingsJson(resource: { type: string; name: string; uuid: string }, rows: readonly ExportRow[], stateLabels: Record<string, string>, now: Date): string {
  const entries = findingEntries(rows, stateLabels).map((e) => ({ ...e, epss: phpFloat(e.epss), cvss: phpFloat(e.cvss) }));
  return `${phpPrettyJson({ resource, exported_at: iso8601(now), count: rows.length, findings: entries })}\n`;
}

// ── FleetExport ─────────────────────────────────────────────────────────────

export interface FleetExportEntry {
  resource: string;
  type: string;
  project: string | null;
  environment: string | null;
  server: string | null;
  status: string;
  match_id?: string;
  severity?: string;
  package?: string;
  version?: string;
  state?: string;
  fixed_in?: string | null;
  other_matches?: number;
  action?: string | null;
  images?: string | null;
  checked_at: string | null;
  url: string | null;
}

export function fleetMarkdown(title: string, entries: readonly FleetExportEntry[], searching: boolean): string {
  const header = searching ? ["Resource", "Project / Environment", "Server", "Match", "State"] : ["Resource", "Project / Environment", "Server", "Status", "Action"];
  return markdownTable(
    title,
    header,
    entries.map((e) => [
      markdownLink(e.resource, e.url),
      markdownCell(`${e.project ?? ""} / ${e.environment ?? ""}`.replace(/^[ /]+|[ /]+$/g, "")),
      markdownCell(e.server ?? ""),
      ...(searching
        ? [markdownCell(`${e.match_id} (${e.severity}) ${e.package} ${e.version}${(e.other_matches ?? 0) > 0 ? `, +${e.other_matches} more` : ""}`), markdownCell(`${e.state}${e.fixed_in !== null && e.fixed_in !== undefined ? ` → ${e.fixed_in}` : ""}`)]
        : [markdownCell(e.status), markdownCell(e.action ?? "")]),
    ]),
  );
}

export function fleetCsv(entries: readonly FleetExportEntry[], searching: boolean): string {
  const header = searching
    ? ["resource", "type", "project", "environment", "server", "status", "match_id", "severity", "package", "version", "state", "fixed_in", "other_matches", "checked_at", "url"]
    : ["resource", "type", "project", "environment", "server", "status", "action", "images", "checked_at", "url"];
  return csvDocument(
    header,
    entries.map((e) => header.map((column) => ((e as unknown as Record<string, string | number | boolean | null | undefined>)[column] ?? null) as string | number | boolean | null)),
  );
}

export function fleetJson(meta: { team: string; search: string | null }, entries: readonly FleetExportEntry[], now: Date): string {
  return `${phpPrettyJson({ ...meta, exported_at: iso8601(now), count: entries.length, resources: entries }, true)}\n`;
}

// ── SbomDocument ────────────────────────────────────────────────────────────

export const SBOM_FORMATS = ["cyclonedx", "spdx"] as const;

interface SbomPackage {
  id: string;
  name: string;
  version: string;
  type: string;
  licenses: string[];
  purl: string;
}

const s = (v: unknown): string => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "1" : "") : String(v));

/** Package::fromArray() of each stored row that is an array. */
export function sbomPackages(stored: unknown): SbomPackage[] {
  const rows = Array.isArray(stored) ? stored : stored !== null && typeof stored === "object" ? Object.values(stored) : [];
  return rows
    .filter((row): row is Record<string, unknown> => row !== null && typeof row === "object")
    .map((row) => ({
      id: s(row.id),
      name: s(row.name),
      version: s(row.version),
      type: s(row.type),
      licenses: (Array.isArray(row.licenses) ? row.licenses : row.licenses === null || row.licenses === undefined ? [] : [row.licenses]).map(s),
      purl: s(row.purl),
    }));
}

/** now()->toIso8601ZuluString() */
const zulu = (d: Date): string => `${d.toISOString().slice(0, 19)}Z`;
const withoutNulls = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));

/** CycloneDX 1.6 JSON. */
export function cycloneDx(imageRef: string, stored: unknown, now: Date, uuid: string): Record<string, unknown> {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${uuid}`,
    version: 1,
    metadata: { timestamp: zulu(now), tools: { components: [{ type: "application", name: "Coolify" }] }, component: { type: "container", "bom-ref": "image", name: imageRef } },
    components: sbomPackages(stored).map((p) =>
      withoutNulls({
        type: "library",
        "bom-ref": `package-${p.id}`,
        name: p.name,
        version: p.version !== "" ? p.version : null,
        purl: p.purl !== "" ? p.purl : null,
        licenses: p.licenses.length === 0 ? null : p.licenses.map((license) => ({ license: { name: license } })),
      }),
    ),
  };
}

/** An SPDX expression only when every license is a plain identifier, else NOASSERTION. */
function licenseExpression(licenses: readonly string[]): string {
  if (licenses.length === 0) return "NOASSERTION";
  if (licenses.some((l) => !/^[A-Za-z0-9.+-]{1,64}$/.test(l))) return "NOASSERTION";
  return [...new Set(licenses)].join(" AND ");
}

/** SPDX 2.3 JSON. */
export function spdx(imageRef: string, stored: unknown, now: Date, uuid: string): Record<string, unknown> {
  const packages: unknown[] = [];
  const relationships: unknown[] = [];
  sbomPackages(stored).forEach((p, index) => {
    const spdxId = `SPDXRef-Package-${index + 1}`;
    packages.push(
      withoutNulls({
        name: p.name,
        SPDXID: spdxId,
        versionInfo: p.version !== "" ? p.version : null,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: licenseExpression(p.licenses),
        copyrightText: "NOASSERTION",
        externalRefs: p.purl === "" ? null : [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: p.purl }],
      }),
    );
    relationships.push({ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: spdxId });
  });
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: imageRef,
    documentNamespace: `https://coolify.io/spdx/${uuid}`,
    creationInfo: { created: zulu(now), creators: ["Tool: Coolify"] },
    packages,
    relationships,
  };
}
