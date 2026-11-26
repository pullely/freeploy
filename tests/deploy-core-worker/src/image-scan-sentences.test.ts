// The security status card's copy (DP-113): the port of SecuritySentences, TeamVulnerabilities' labels and actions and
// VulnerabilityMarkers, compared with what Coolify's own functions say about the same stored statuses —
// fixtures/image-scan/sentences.json, emitted by fixtures/image-scan/emit.php from the stored statuses of the API goldens'
// `after` rows and the scans of their cases (see its README). The clock is the goldens' (2026-01-01T00:00:00Z).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageScanRow } from "@deploy-core-worker/image-scan/model";
import { securityFromArray, primaryOf } from "@deploy-core-worker/image-scan/security-status";
import * as sentences from "@deploy-core-worker/image-scan/security-sentences";
import { action, imagesLine, marker, statusLabel } from "@deploy-core-worker/image-scan/team-vulnerabilities";
import { CASES } from "./api-v1-goldens.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-01-01T00:00:00Z");

interface Emitted {
  uuid: string;
  security: unknown;
  [key: string]: unknown;
}
const FIXTURE = JSON.parse(readFileSync(resolve(HERE, "../fixtures/image-scan/sentences.json"), "utf8")) as { statuses: Emitted[]; extra: Record<string, unknown[]> };

interface ScanDefinition {
  uuid: string;
  image_ref: string;
  findings: unknown;
  candidates: unknown;
  base_image_ref: string | null;
  builds_image: boolean;
}
const SCANS = new Map<string, ScanDefinition>();
for (const c of CASES.cases as Array<{ imageScans?: ScanDefinition[] }>) for (const s of c.imageScans ?? []) SCANS.set(s.uuid, s);

/** An unsaved ImageScan with the case's columns, as emit.php makes it. */
function scanOf(d: ScanDefinition, summary: unknown): ImageScanRow {
  return {
    id: 0,
    uuid: d.uuid,
    serverId: 1,
    imageId: "",
    repoDigest: null,
    resourceType: "",
    resourceId: 0,
    imageRef: d.image_ref,
    deploymentQueueId: null,
    status: null,
    errorCode: null,
    errorContext: null,
    summary: summary as ImageScanRow["summary"],
    findings: d.findings as ImageScanRow["findings"],
    candidates: d.candidates as ImageScanRow["candidates"],
    baseImageRef: d.base_image_ref,
    buildsImage: d.builds_image,
    isBaseline: true,
    grypeDbBuiltAt: null,
    scannedAt: null,
  };
}

describe("the security status copy (DP-113)", () => {
  it("is emitted for every stored status of the goldens", () => {
    expect(FIXTURE.statuses.length).toBe(38);
    expect(new Set(FIXTURE.statuses.map((s) => (s.security as { status: string }).status))).toEqual(new Set(["update_now", "update_available", "no_fix", "check_needed", "ok"]));
  });

  it.each(FIXTURE.statuses.map((s) => [`${s.uuid} ${(s.security as { status: string }).status}`, s] as const))("says what Coolify says about %s", (_name, e) => {
    const s = securityFromArray(e.security);
    const d = SCANS.get(e.uuid)!;
    const scan = scanOf(d, { security: e.security });
    const got = {
      headline: sentences.headline(s, NOW),
      lines: sentences.lines(s),
      badge: sentences.badge(s.status),
      image_sentence: sentences.imageSentence(s, d.image_ref, NOW, scan, null),
      version_check_running: sentences.versionCheckRunning(d.image_ref, scan, null),
      attack_note: sentences.attackNote(s),
      no_fix_advice: sentences.noFixAdvice(s, "this database"),
      why_more: sentences.whyMore(s.moreFixed),
      provenance: sentences.provenance(scan, primaryOf(s), s, NOW, { fixed_in: "1.2.3" }),
      provenance_none: sentences.provenance(scan, null, s, NOW),
      registry: sentences.registryName(d.image_ref),
      status_label: statusLabel(s.status),
      action: action(s, NOW),
      images_line: imagesLine(s, { update: 1, total: 2 }),
      marker: marker(s),
    };
    const want = Object.fromEntries(Object.keys(got).map((k) => [k, e[k]]));
    expect(got).toEqual(want);
  });

  it("says the rest as Coolify does", () => {
    const x = FIXTURE.extra;
    expect([0, 1, 2].map((n) => sentences.imagesNeedingUpdate(n, 3))).toEqual(x.images_needing_update);
    expect([0, 1, 12].map(sentences.knownIssues)).toEqual(x.known_issues);
    expect([null, "nginx@sha256:3f1a2b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081", "abcdef"].map(sentences.shortDigest)).toEqual(x.short_digest);
    expect([sentences.databaseUpdateConfirmation("PostgreSQL", "16.4-alpine", "16.6-alpine"), sentences.databaseUpdateConfirmation("Redis", "latest", "alpine")]).toEqual(x.database_update_confirmation);
    const context = { checked: 1, total: 3, time: "2025-12-20T08:00:00+00:00" };
    expect(["images_unchecked", "truncated", "stale", "db_outdated", "image_changed", "versions_unchecked", "server", "application", "not_scanned", "other"].map((code) => sentences.checkReason(code, context, NOW))).toEqual(x.check_reasons);
  });
});
