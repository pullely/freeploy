// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/VulnerabilitiesController.php (index, application,
// service, database, show, findings, finding, security, resourceType, listParameter) (Apache-2.0), modified.
//
// Coolify's /api/v1/vulnerabilities and /api/v1/{applications,services,databases}/{uuid}/vulnerabilities (DP-113): the
// stored image scan results with the same data as the Security pages, answered by the ported security status engine
// (src/image-scan/). Nothing here scans: scanning (Syft and Grype on a server) needs the SSH executor, and no route of
// these four starts one. The list reads only stored statuses; a resource's page computes its images' statuses now from the
// stored findings, version checks, ignores and policies. $this->authorize('view') is policy-worker's deploy.resource.read.
import { COOLIFY_API, obj, phpJsonEncode, type CoolifyAnswer, type PhpValue } from "@saas/contracts/coolify-api";
import { columnCipher } from "../handlers/cloud-tokens.js";
import { findResource, listResources, loadScanData, type DecryptValue } from "../image-scan/data.js";
import type { Finding } from "../image-scan/finding.js";
import { SEVERITY_RANK, type ImageScanRow, type IgnoreRow, type ScanData, type ScanOwner, type ScanResource } from "../image-scan/model.js";
import { bool, dataGet, iso8601, lower, spaceship, str } from "../image-scan/php.js";
import { offState, policyFor } from "../image-scan/policy.js";
import { advisoryUrl, current, findings as findingsOf, key } from "../image-scan/resource-scans.js";
import type { RelevanceRules } from "../image-scan/rules.js";
import { fixStates } from "../image-scan/security-actions.js";
import { forResource, forScan, relevanceRulesFor, type ResourceSecurity } from "../image-scan/security-status.js";
import { action, loadTeamVulnerabilities, severityOf, STATUS_ORDER, statusLabel } from "../image-scan/team-vulnerabilities.js";
import { message, type ApiV1Context } from "./context.js";
import { cleanInput, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rules } from "./rules.js";

const FINDING_STATES = ["fixed", "no_fix", "ignored"] as const;
const SEVERITIES = Object.keys(SEVERITY_RANK);
type ResourceKind = "application" | "service" | "database";

/** A float written as PHP's json_encode() writes one (`7.0`, not `7`): a placeholder replaced after encoding. */
const FLOAT = "\u0000float:";
const float = (n: number | null): PhpValue => (n === null ? null : `${FLOAT}${n}`);
function encode(body: PhpValue): CoolifyAnswer {
  const text = phpJsonEncode(body).replace(/"\\u0000float:([^"]+)"/g, (_all, n: string) => {
    const value = Number(n);
    return Number.isInteger(value) && Math.abs(value) < 1e15 ? `${value}.0` : String(value);
  });
  return { status: 200, body: text, headers: { "content-type": "application/json" } };
}

/** $request->query() as PHP parses a query string (`a[]=x`, `a[k]=x`), through TrimStrings and ConvertEmptyStringsToNull. */
export function phpQuery(url: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  url.searchParams.forEach((value, name) => {
    const m = /^([^[\]]+)\[([^\]]*)\]/.exec(name);
    if (m === null) {
      out[name] = value;
      return;
    }
    const base = m[1]!;
    const sub = m[2]!;
    const current = out[base];
    if (sub === "") {
      if (Array.isArray(current)) current.push(value);
      else out[base] = [value];
    } else {
      const target = current !== null && typeof current === "object" && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
      target[sub] = value;
      out[base] = target;
    }
  });
  return cleanInput(out) as Record<string, unknown>;
}

/** listParameter(): a comma-separated query parameter checked against the allowed values; empty when not sent. */
function listParameter(query: Record<string, unknown>, name: string, allowed: readonly string[]): string[] | CoolifyAnswer {
  const raw = query[name];
  if (raw === null || raw === undefined || raw === "") return [];
  if (typeof raw !== "string") return validationFailed([[name, [`The ${name} must be a comma-separated string.`]]]);
  const values = [...new Set(raw.toLowerCase().split(",").map((v) => v.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "")).filter((v) => v !== "" && v !== "0"))];
  if (values.some((v) => !allowed.includes(v))) return validationFailed([[name, [`Allowed values: ${allowed.join(", ")}.`]]]);
  return values;
}

const isAnswer = (v: unknown): v is CoolifyAnswer => typeof v === "object" && v !== null && "status" in v && "body" in v;

const decryptor = (tx: Parameters<typeof columnCipher>[0], c: ApiV1Context): DecryptValue => {
  const cipher = columnCipher(tx, c.orgId, c.env.DEPLOY_ENCRYPTION_KEY, "environment_variables.value");
  return (stored) => cipher.decrypt(stored);
};

const resourceType = (r: ScanResource): ResourceKind => (r.kind === "application" ? "application" : r.kind === "service" ? "service" : "database");

/** security(): the status without the internal facts and record IDs. */
function securityOf(s: ResourceSecurity, now: Date): PhpValue {
  return obj({
    status: s.status,
    label: statusLabel(s.status),
    action: action(s, now)?.text ?? null,
    check_reason: s.checkReason,
    problem_count: s.problemCount,
    exploited_count: s.exploitedCount,
    any_exploited: s.anyExploited,
    critical_count: s.criticalCount,
    high_count: s.highCount,
    medium_count: s.mediumCount,
    eol: s.eol === null ? null : obj({ name: s.eol.name, version: s.eol.version, fixed: s.eol.fixed }),
    checked_at: s.checkedAt === null ? null : iso8601(s.checkedAt),
    actions: s.actions.map((a) => obj({ type: a.type, sentence: a.sentence, target: a.target, copy: a.copy, image: a.image, ref: a.ref })),
  });
}

/** GET /vulnerabilities */
export async function listVulnerabilities(c: ApiV1Context, now: Date): Promise<CoolifyAnswer> {
  const statuses = listParameter(phpQuery(c.url), "status", STATUS_ORDER);
  if (isAnswer(statuses)) return statuses;
  const rank = (status: string) => {
    const i = (STATUS_ORDER as readonly string[]).indexOf(status);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return c.sql(c.env, c.orgId, async (tx) => {
    const resources = await listResources(tx, decryptor(tx, c));
    const data = await loadScanData(tx, resources, now, false);
    const entries = loadTeamVulnerabilities(resources, data)
      .filter((e) => statuses.length === 0 || statuses.includes(e.security.status))
      .map((e, index) => ({ e, index }))
      .sort((a, b) => spaceship([rank(a.e.security.status), str(a.e.resource.name)], [rank(b.e.security.status), str(b.e.resource.name)]) || a.index - b.index)
      .map(({ e }) =>
        obj({
          uuid: e.resource.uuid,
          name: str(e.resource.name),
          type: resourceType(e.resource),
          project_uuid: e.resource.environment?.projectUuid ?? null,
          environment_uuid: e.resource.environment?.uuid ?? null,
          server_uuid: e.server?.uuid ?? null,
          images: obj({ update: e.images.update, total: e.images.total }),
          security: securityOf(e.security, now),
        }),
      );
    return encode(obj({ resources: entries }));
  });
}

const SHOW_RULES: Rules = [
  ["state", ["nullable", "string"]],
  ["severity", ["nullable", "string"]],
  ["image", ["nullable", "string", "max:1000"]],
  ["search", ["nullable", "string", "max:200"]],
  ["page", ["nullable", "integer", "min:1"]],
  ["per_page", ["nullable", "integer", "min:1", "max:200"]],
];

interface FindingRow {
  body: PhpValue;
  state: string;
  severity: string;
  kev: boolean;
  risk: number | null;
  id: string;
  aliases: string[];
  package: string;
  version: string;
  imageRef: string;
}

/** findings(): the findings of the current scans, worst first, in the fix states of the UI. */
function findingRows(scans: readonly ImageScanRow[], rulesFor: (owner: ScanOwner) => RelevanceRules, data: ScanData): FindingRow[] {
  const rows: FindingRow[] = [];
  for (const scan of scans) {
    const owner = data.owners.get(scan.id)!;
    const rules = rulesFor(owner);
    const classify = fixStates(scan, rules, data);
    for (const finding of findingsOf(scan)) {
      const ignore = rules.ignores.matches(finding);
      const state = ignore === null ? classify(finding) : "ignored";
      rows.push({ ...findingRow(finding, state, ignore, scan.imageRef, owner.uuid), state, severity: severityOf(finding), kev: finding.kev, risk: finding.risk, id: finding.id, aliases: finding.aliases, package: finding.package, version: finding.version, imageRef: scan.imageRef });
    }
  }
  const sortKey = (r: FindingRow) => [r.kev, SEVERITY_RANK[r.severity], r.risk ?? 0.0];
  return rows.map((r, i) => ({ r, i })).sort((a, b) => spaceship(sortKey(b.r), sortKey(a.r)) || a.i - b.i).map(({ r }) => r);
}

function findingRow(f: Finding, state: string, ignore: IgnoreRow | null, imageRef: string, ownerUuid: string): { body: PhpValue } {
  return {
    body: obj({
      id: f.id,
      display_id: f.displayId,
      aliases: f.aliases,
      title: f.title,
      severity: severityOf(f),
      package: f.package,
      version: f.version,
      package_type: f.type,
      fixed_in: f.fixedIn,
      state,
      ignore: ignore === null ? null : obj({ reason: ignore.reason, expires_at: ignore.expiresAt === null ? null : iso8601(ignore.expiresAt), team_wide: ignore.resourceType === null }),
      kev: f.kev,
      epss: float(f.epss),
      risk: float(f.risk),
      cvss_score: float(f.cvssScore),
      advisory_url: advisoryUrl(f.displayId),
      image_ref: imageRef,
      owner_uuid: ownerUuid,
    }),
  };
}

const NOT_FOUND: Record<ResourceKind, string> = { application: "Application not found.", service: "Service not found.", database: "Database not found." };

/** GET /{applications,services,databases}/{uuid}/vulnerabilities (show()). */
export async function resourceVulnerabilities(c: ApiV1Context, type: ResourceKind, uuid: string, now: Date): Promise<CoolifyAnswer> {
  const query = phpQuery(c.url);
  const errors: Errors = [];
  await validateRules(errors, query, SHOW_RULES);
  if (errors.length > 0) return validationFailed(errors);
  const states = listParameter(query, "state", FINDING_STATES);
  if (isAnswer(states)) return states;
  const severities = listParameter(query, "severity", SEVERITIES);
  if (isAnswer(severities)) return severities;

  return c.sql(c.env, c.orgId, async (tx) => {
    const resource = await findResource(tx, type, uuid, decryptor(tx, c));
    if (resource === null) return message(NOT_FOUND[type], 404);
    if (!(await c.allows(false))) return COOLIFY_API.unauthorized();

    const data = await loadScanData(tx, [resource], now, true);
    const off = offState(resource, policyFor(resource, data).scanServer);
    const scans = off === null ? current(resource, data) : [];
    const rules = new Map<string, RelevanceRules>();
    const rulesFor = (owner: ScanOwner): RelevanceRules => {
      let r = rules.get(key(owner));
      if (r === undefined) {
        r = relevanceRulesFor(owner, data);
        rules.set(key(owner), r);
      }
      return r;
    };
    const imageStatuses = new Map(scans.map((s) => [s.uuid, forScan(s, data, rulesFor(data.owners.get(s.id)!))]));
    const image = str(query.image ?? "").replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");
    const search = lower(str(query.search ?? "").replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, ""));
    const all = findingRows(scans, rulesFor, data).filter(
      (r) =>
        (states.length === 0 || states.includes(r.state)) &&
        (severities.length === 0 || severities.includes(r.severity)) &&
        (image === "" || r.imageRef === image) &&
        (search === "" || lower([r.id, ...r.aliases, r.package, r.version].join(" ")).includes(search)),
    );
    const perPage = query.per_page === null || query.per_page === undefined ? 50 : Math.trunc(Number(query.per_page));
    const page = query.page === null || query.page === undefined ? 1 : Math.trunc(Number(query.page));
    const start = (page - 1) * perPage;
    return encode(
      obj({
        uuid: resource.uuid,
        type,
        off_reason: off,
        security: scans.length === 0 ? null : securityOf(forResource(resource, data, scans, imageStatuses), now),
        images: scans.map((s) =>
          obj({
            scan_uuid: s.uuid,
            owner_uuid: data.owners.get(s.id)?.uuid ?? "",
            image_ref: s.imageRef,
            scan_status: s.status,
            error_code: s.errorCode,
            scanned_at: s.scannedAt === null ? null : iso8601(s.scannedAt),
            truncated: bool(dataGet(s.summary, "truncated", false)),
            security_status: imageStatuses.get(s.uuid)!.status,
          }),
        ),
        findings: all.slice(start, start + perPage).map((r) => r.body),
        pagination: obj({ page, per_page: perPage, total: all.length }),
      }),
    );
  });
}
