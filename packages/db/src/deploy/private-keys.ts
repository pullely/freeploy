// Derived from coollabsio/coolify@91b7e3e:app/Models/PrivateKey.php and
// app/Livewire/Security/PrivateKey/Show.php (usages) (Apache-2.0), modified.
//
// deploy.private_keys queries. Every function takes the transaction of
// withOrg(): row-level security confines each query to that org, which is what
// Coolify's ownedByCurrentTeam() / where('team_id', …) does. The private_key
// column holds an fp1 ciphertext (crypto.ts); these functions never decrypt.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

export interface DeployPrivateKeyRow extends SqlRow {
  id: string | number;
  uuid: string;
  name: string;
  description: string | null;
  is_git_related: boolean;
  fingerprint: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

/** A row with its stored (encrypted) key. */
export interface DeployPrivateKeyWithSecretRow extends DeployPrivateKeyRow {
  private_key: string;
}

export interface DeployPrivateKeyListRow extends DeployPrivateKeyRow {
  in_use: boolean;
}

const COLUMNS = "id, uuid, name, description, is_git_related, fingerprint, created_at, updated_at";

/**
 * PrivateKey::isInUse(): a server, S3 storage, application, GitHub, GitLab or
 * Gitea app refers to the key. `k` is the deploy.private_keys alias.
 */
const IN_USE_SQL = [
  "servers",
  "s3_storages",
  "applications",
  "github_apps",
  "gitlab_apps",
  "gitea_apps",
]
  .map((t) => `EXISTS (SELECT 1 FROM deploy.${t} u WHERE u.private_key_id = k.id)`)
  .join(" OR ");

/** Index: the org's keys (Coolify selects name, uuid, is_git_related, description), with isInUse() per key. */
export async function listPrivateKeys(tx: SqlExecutor): Promise<DeployPrivateKeyListRow[]> {
  const r = await tx.execute<DeployPrivateKeyListRow>(
    `SELECT ${COLUMNS.split(", ").map((c) => `k.${c}`).join(", ")}, (${IN_USE_SQL}) AS in_use FROM deploy.private_keys k ORDER BY k.id`,
  );
  return r.rows;
}

/** ownedByCurrentTeam()->whereUuid($uuid)->first(), with the encrypted key. */
export async function findPrivateKeyByUuid(tx: SqlExecutor, uuid: string): Promise<DeployPrivateKeyWithSecretRow | null> {
  const r = await tx.execute<DeployPrivateKeyWithSecretRow>(`SELECT ${COLUMNS}, private_key FROM deploy.private_keys WHERE uuid = $1`, [uuid]);
  return r.rows[0] ?? null;
}

export interface NewPrivateKey {
  orgId: string;
  uuid: string;
  name: string;
  description: string | null;
  /** The fp1 ciphertext of the formatted key. */
  privateKey: string;
  fingerprint: string | null;
  isGitRelated?: boolean;
}

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

export async function insertPrivateKey(tx: SqlExecutor, key: NewPrivateKey): Promise<DeployPrivateKeyRow> {
  const r = await tx.execute<DeployPrivateKeyRow>(
    `INSERT INTO deploy.private_keys (uuid, name, description, private_key, is_git_related, fingerprint, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, ${NOW}, ${NOW}) RETURNING ${COLUMNS}`,
    [key.uuid, key.name, key.description, key.privateKey, key.isGitRelated ?? false, key.fingerprint, key.orgId],
  );
  return r.rows[0]!;
}

export interface PrivateKeyChanges {
  name: string;
  description: string | null;
  isGitRelated: boolean;
  /** A new key (ciphertext) and its fingerprint; omitted keeps the stored key. */
  privateKey?: { ciphertext: string; fingerprint: string | null };
}

export async function updatePrivateKey(tx: SqlExecutor, id: string | number, changes: PrivateKeyChanges): Promise<DeployPrivateKeyRow | null> {
  const params: unknown[] = [id, changes.name, changes.description, changes.isGitRelated];
  let keySql = "";
  if (changes.privateKey) {
    params.push(changes.privateKey.ciphertext, changes.privateKey.fingerprint);
    keySql = ", private_key = $5, fingerprint = $6";
  }
  const r = await tx.execute<DeployPrivateKeyRow>(
    `UPDATE deploy.private_keys SET name = $2, description = $3, is_git_related = $4${keySql}, updated_at = ${NOW} WHERE id = $1 RETURNING ${COLUMNS}`,
    params,
  );
  return r.rows[0] ?? null;
}

export async function deletePrivateKey(tx: SqlExecutor, id: string | number): Promise<boolean> {
  const r = await tx.execute("DELETE FROM deploy.private_keys WHERE id = $1 RETURNING id", [id]);
  return r.rows.length > 0;
}

/**
 * PrivateKey::fingerprintExists($fingerprint, $excludeId, $teamId): another key
 * of the same org has this fingerprint. The org is the transaction's (RLS).
 */
export async function privateKeyFingerprintExists(tx: SqlExecutor, fingerprint: string | null, excludeId?: string | number | null): Promise<boolean> {
  if (fingerprint === null) return false;
  const r =
    excludeId === undefined || excludeId === null
      ? await tx.execute("SELECT 1 FROM deploy.private_keys WHERE fingerprint = $1 LIMIT 1", [fingerprint])
      : await tx.execute("SELECT 1 FROM deploy.private_keys WHERE fingerprint = $1 AND id <> $2 LIMIT 1", [fingerprint, excludeId]);
  return r.rows.length > 0;
}

export async function privateKeyIsInUse(tx: SqlExecutor, id: string | number): Promise<boolean> {
  const r = await tx.execute<{ in_use: boolean }>(`SELECT (${IN_USE_SQL}) AS in_use FROM deploy.private_keys k WHERE k.id = $1`, [id]);
  return Boolean(r.rows[0]?.in_use);
}

/** The types of Show's "Used by" list, in Coolify's order. */
export const PRIVATE_KEY_USAGE_TYPES = ["Server", "Application", "GitHub App", "GitLab App", "Gitea App"] as const;
export type PrivateKeyUsageType = (typeof PRIVATE_KEY_USAGE_TYPES)[number];

export interface PrivateKeyUsageRow {
  type: PrivateKeyUsageType;
  name: string;
  url: string | null;
}

export interface PrivateKeyUsages {
  /** Count per type; types with none are left out (array_filter). */
  counts: Partial<Record<PrivateKeyUsageType, number>>;
  /** How many rows match the search across all types. */
  matches: number;
  rows: PrivateKeyUsageRow[];
}

interface UsageSource {
  type: PrivateKeyUsageType;
  from: string;
  select: string;
  url: (row: SqlRow) => string | null;
}

const USAGE_SOURCES: UsageSource[] = [
  { type: "Server", from: "deploy.servers t", select: "t.name, t.uuid", url: (r) => `/server/${String(r.uuid)}` },
  {
    type: "Application",
    from: "deploy.applications t LEFT JOIN deploy.environments e ON e.id = t.environment_id LEFT JOIN deploy.projects p ON p.id = e.project_id",
    select: "t.name, t.uuid, e.uuid AS environment_uuid, p.uuid AS project_uuid",
    // Application::link(): null without a project.
    url: (r) => (r.project_uuid ? `/project/${String(r.project_uuid)}/environment/${String(r.environment_uuid ?? "")}/application/${String(r.uuid)}` : null),
  },
  { type: "GitHub App", from: "deploy.github_apps t", select: "t.name, t.uuid", url: (r) => `/source/github/${String(r.uuid)}` },
  { type: "GitLab App", from: "deploy.gitlab_apps t", select: "t.name, t.uuid", url: (r) => `/source/gitlab/${String(r.uuid)}` },
  { type: "Gitea App", from: "deploy.gitea_apps t", select: "t.name, t.uuid", url: (r) => `/source/gitea/${String(r.uuid)}` },
];

/** Show::usages(): a count per type, and the first `limit` rows (by name per type) that match the search. */
export async function privateKeyUsages(tx: SqlExecutor, id: string | number, search = "", limit = 20): Promise<PrivateKeyUsages> {
  const term = search.trim();
  // addcslashes(mb_strtolower($search), '%_\\'), matched with ESCAPE '\'.
  const pattern = `%${term.toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const counts: PrivateKeyUsages["counts"] = {};
  let matches = 0;
  const rows: PrivateKeyUsageRow[] = [];
  for (const source of USAGE_SOURCES) {
    const total = await tx.execute<{ n: string | number }>(`SELECT count(*) AS n FROM ${source.from} WHERE t.private_key_id = $1`, [id]);
    const count = Number(total.rows[0]?.n ?? 0);
    if (count > 0) counts[source.type] = count;
    const filter = term === "" ? "" : " AND LOWER(t.name) LIKE $2 ESCAPE '\\'";
    const params = term === "" ? [id] : [id, pattern];
    let typeMatches = count;
    if (term !== "") {
      const m = await tx.execute<{ n: string | number }>(`SELECT count(*) AS n FROM ${source.from} WHERE t.private_key_id = $1${filter}`, params);
      typeMatches = Number(m.rows[0]?.n ?? 0);
    }
    matches += typeMatches;
    const missing = limit - rows.length;
    if (typeMatches > 0 && missing > 0) {
      const found = await tx.execute(`SELECT ${source.select} FROM ${source.from} WHERE t.private_key_id = $1${filter} ORDER BY t.name LIMIT ${Math.floor(missing)}`, params);
      for (const r of found.rows) rows.push({ type: source.type, name: String(r.name), url: source.url(r) });
    }
  }
  return { counts, matches, rows };
}
