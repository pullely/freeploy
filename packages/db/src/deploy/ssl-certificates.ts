// Derived from coollabsio/coolify@91b7e3e:app/Models/SslCertificate.php, app/Helpers/SslHelper.php
// (generateSslCertificate: the delete and the create) and
// app/Livewire/Server/CaCertificate/Show.php (Apache-2.0), modified.
//
// deploy.ssl_certificates queries. Every function takes the transaction of
// withOrg(): row-level security confines each query to that org. The
// ssl_certificate and ssl_private_key columns hold fp1 ciphertexts
// (crypto.ts, bound to "ssl_certificates.<column>"); these functions never
// decrypt, and only the *WithSecret row carries the private key.
import type { SqlExecutor, SqlRow } from "../hyperdrive/executor.js";

export interface DeploySslCertificateRow extends SqlRow {
  id: string | number;
  /** The fp1 ciphertext of the PEM certificate. */
  ssl_certificate: string;
  configuration_dir: string | null;
  mount_path: string | null;
  resource_type: string | null;
  resource_id: string | number | null;
  server_id: string | number;
  common_name: string;
  /** JSON: Coolify's `array` cast ("DNS:…", "IP:…" entries). */
  subject_alternative_names: unknown;
  valid_until: string | Date;
  is_ca_certificate: boolean;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

/** A row with its stored (encrypted) private key. Coolify hides it on the model ($hidden). */
export interface DeploySslCertificateWithSecretRow extends DeploySslCertificateRow {
  ssl_private_key: string;
}

const COLUMNS =
  "id, ssl_certificate, configuration_dir, mount_path, resource_type, resource_id, server_id, common_name, subject_alternative_names, valid_until, is_ca_certificate, created_at, updated_at";

/** Laravel's timestamps are UTC wall-clock times in TIMESTAMP(0) WITHOUT TIME ZONE columns. */
const NOW = "date_trunc('second', timezone('UTC', now()))";

/** A Date as the UTC wall-clock text a TIMESTAMP(0) WITHOUT TIME ZONE column takes. */
function utcTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** $server->sslCertificates()->where('is_ca_certificate', true)->first(), with the encrypted private key. */
export async function findServerCaCertificate(tx: SqlExecutor, serverId: string | number): Promise<DeploySslCertificateWithSecretRow | null> {
  const r = await tx.execute<DeploySslCertificateWithSecretRow>(
    `SELECT ${COLUMNS}, ssl_private_key FROM deploy.ssl_certificates WHERE server_id = $1 AND is_ca_certificate = true ORDER BY id LIMIT 1`,
    [serverId],
  );
  return r.rows[0] ?? null;
}

/** The certificates of one resource on one server; a null resource is the server's own (its CA). */
export interface SslCertificateOwner {
  serverId: string | number;
  resourceType: string | null;
  resourceId: string | number | null;
}

/**
 * generateSslCertificate()'s delete before its create:
 * where('resource_type', …)->where('resource_id', …)->where('server_id', …)->delete(),
 * a null matching NULL as Laravel's where() does. Returns how many rows went.
 */
export async function deleteSslCertificates(tx: SqlExecutor, owner: SslCertificateOwner): Promise<number> {
  const r = await tx.execute(
    `DELETE FROM deploy.ssl_certificates
      WHERE server_id = $1 AND resource_type IS NOT DISTINCT FROM $2::varchar AND resource_id IS NOT DISTINCT FROM $3::bigint RETURNING id`,
    [owner.serverId, owner.resourceType, owner.resourceId],
  );
  return r.rows.length;
}

export interface NewSslCertificate extends SslCertificateOwner {
  orgId: string;
  /** The fp1 ciphertexts of the PEM certificate and of the PEM private key. */
  sslCertificate: string;
  sslPrivateKey: string;
  configurationDir: string | null;
  mountPath: string | null;
  commonName: string;
  subjectAlternativeNames: string[];
  validUntil: Date;
  isCaCertificate: boolean;
}

/** SslCertificate::create([...]). */
export async function insertSslCertificate(tx: SqlExecutor, cert: NewSslCertificate): Promise<DeploySslCertificateRow> {
  const r = await tx.execute<DeploySslCertificateRow>(
    `INSERT INTO deploy.ssl_certificates
       (ssl_certificate, ssl_private_key, resource_type, resource_id, server_id, configuration_dir, mount_path,
        valid_until, is_ca_certificate, common_name, subject_alternative_names, org_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamp, $9, $10, $11::json, $12, ${NOW}, ${NOW}) RETURNING ${COLUMNS}`,
    [
      cert.sslCertificate,
      cert.sslPrivateKey,
      cert.resourceType,
      cert.resourceId,
      cert.serverId,
      cert.configurationDir,
      cert.mountPath,
      utcTimestamp(cert.validUntil),
      cert.isCaCertificate,
      cert.commonName,
      JSON.stringify(cert.subjectAlternativeNames),
      cert.orgId,
    ],
  );
  return r.rows[0]!;
}

/**
 * Show::saveCaCertificate(): $caCertificate->ssl_certificate = …; save(). Only
 * the certificate changes; the private key and valid_until stay as stored.
 */
export async function updateSslCertificateContent(tx: SqlExecutor, id: string | number, sslCertificate: string): Promise<boolean> {
  const r = await tx.execute(`UPDATE deploy.ssl_certificates SET ssl_certificate = $2, updated_at = ${NOW} WHERE id = $1 RETURNING id`, [id, sslCertificate]);
  return r.rows.length > 0;
}
