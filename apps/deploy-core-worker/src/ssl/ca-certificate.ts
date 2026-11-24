// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Server/CaCertificate/Show.php,
// app/Helpers/SslHelper.php and app/Models/SslCertificate.php (Apache-2.0), modified.
//
// What the CA Certificate page does with one server's CA certificate, as plain
// operations. The store is the org's deploy.ssl_certificates under row-level
// security; the cipher encrypts ssl_certificate and ssl_private_key, each
// bound to its column. The private key is never part of an answer: Coolify
// hides it on the model and no page shows it.
//
// Coolify changes the database first and then runs commands on the server
// (writeCertificateToServer: SslHelper::caCertificateFileCommands over SSH) and
// queues RegenerateSslCertJob (every database certificate of the server signed
// again with the CA). Both need the SSH executor, which is not available yet:
// the change is stored and `unavailable` says what did not happen.
import type { DeployServerRow, DeploySslCertificateRow, DeploySslCertificateWithSecretRow } from "@saas/db/deploy";
import { utcIso } from "../cloud-tokens/service.js";
import { serverShow, type ServerShow } from "../servers/service.js";
import type { FieldCipher } from "../servers/settings.js";
import { CA_COMMON_NAME, CA_VALIDITY_DAYS, generateSslCertificate, type GeneratedSslCertificate } from "./ssl-helper.js";
import { certificateMatchesPrivateKey, exportCertificatePem, readCertificatePem } from "./x509.js";

export const SSL_CERTIFICATE_COLUMN = "ssl_certificates.ssl_certificate";
export const SSL_PRIVATE_KEY_COLUMN = "ssl_certificates.ssl_private_key";

export interface CaCertificateStore {
  findServer(uuid: string): Promise<DeployServerRow | null>;
  /** $server->sslCertificates()->where('is_ca_certificate', true)->first(). */
  findCa(serverId: string | number): Promise<DeploySslCertificateWithSecretRow | null>;
  /**
   * generateSslCertificate()'s delete and create for a server's own
   * certificate (no resource): the old CA goes, the new one is stored.
   * `sslCertificate` and `sslPrivateKey` are ciphertexts.
   */
  replaceCa(serverId: string | number, certificate: Omit<GeneratedSslCertificate, "sslCertificate" | "sslPrivateKey"> & { sslCertificate: string; sslPrivateKey: string }): Promise<DeploySslCertificateRow>;
  /** $caCertificate->ssl_certificate = …; save(). */
  updateCertificate(id: string | number, sslCertificate: string): Promise<boolean>;
}

export interface CaCertificateContext {
  store: CaCertificateStore;
  cipher: FieldCipher;
}

/** Copy shown to the user: Coolify's, word for word ("Coolify" reads "Freeploy"), then Freeploy's for what needs SSH. */
export const CA_CERTIFICATE_MESSAGES = {
  /** Show::saveCaCertificate() */
  empty: "Certificate content cannot be empty.",
  invalid: "Invalid certificate format.",
  unprocessable: "Failed to process certificate.",
  mismatch: "This certificate does not match the CA private key of this server. Freeploy signs database certificates with that key, so clients would fail with a certificate signature error.",
  saved: "CA Certificate saved successfully.",
  /** Show::regenerateCaCertificate() */
  regenerated: "CA Certificate regenerated successfully.",
  /** writeCertificateToServer(), and RegenerateSslCertJob after it. */
  writeUnavailable: "Writing the CA certificate to the server needs the SSH executor, which is not available yet.",
} as const;

/** A failure Coolify reports through handleError(): the exception's message as the error toast. */
export class CaCertificateError extends Error {}

export interface CaCertificatePage {
  server: ServerShow;
  /** Show::$certificateContent: the PEM certificate, "" while the server has none. */
  certificateContent: string;
  /** Show::$certificateValidUntil: an ISO instant, null while the server has none. */
  certificateValidUntil: string | null;
}

async function page(ctx: CaCertificateContext, server: DeployServerRow, ca: DeploySslCertificateRow | null): Promise<CaCertificatePage> {
  return {
    server: serverShow(server),
    certificateContent: ca ? await ctx.cipher.decrypt(SSL_CERTIFICATE_COLUMN, ca.ssl_certificate) : "",
    certificateValidUntil: ca ? utcIso(ca.valid_until) : null,
  };
}

/** Show::mount() + loadCaCertificate(). */
export async function showCaCertificate(ctx: CaCertificateContext, uuid: string): Promise<CaCertificatePage | null> {
  const server = await ctx.store.findServer(uuid);
  if (!server) return null;
  return page(ctx, server, await ctx.store.findCa(server.id));
}

export interface CaCertificateSaved extends CaCertificatePage {
  message: string;
  /** What Coolify does on the server next and Freeploy cannot yet; null when there is nothing to do there. */
  unavailable: string | null;
  /** False where Coolify answers its success toast without storing anything: the server has no CA certificate. */
  stored: boolean;
}

/**
 * Show::saveCaCertificate(): the pasted certificate read and exported again
 * (normalized PEM), checked against the CA private key, then stored. A server
 * without a CA certificate has no key to check and nothing to replace: Coolify
 * keeps the normalized text on the page and still answers its success toast.
 */
export async function saveCaCertificate(ctx: CaCertificateContext, uuid: string, content: unknown): Promise<CaCertificateSaved | null> {
  const server = await ctx.store.findServer(uuid);
  if (!server) return null;
  // `! $this->certificateContent`: PHP's falsy strings are "" and "0".
  if (typeof content !== "string" || content === "" || content === "0") throw new CaCertificateError(CA_CERTIFICATE_MESSAGES.empty);
  const der = readCertificatePem(content);
  if (!der) throw new CaCertificateError(CA_CERTIFICATE_MESSAGES.invalid);
  let cleaned: string;
  try {
    cleaned = exportCertificatePem(der);
  } catch {
    throw new CaCertificateError(CA_CERTIFICATE_MESSAGES.unprocessable);
  }
  const ca = await ctx.store.findCa(server.id);
  if (!ca) {
    return { server: serverShow(server), certificateContent: cleaned, certificateValidUntil: null, message: CA_CERTIFICATE_MESSAGES.saved, unavailable: null, stored: false };
  }
  const privateKey = await ctx.cipher.decrypt(SSL_PRIVATE_KEY_COLUMN, ca.ssl_private_key);
  if (!(await certificateMatchesPrivateKey(der, privateKey))) throw new CaCertificateError(CA_CERTIFICATE_MESSAGES.mismatch);
  await ctx.store.updateCertificate(ca.id, await ctx.cipher.encrypt(SSL_CERTIFICATE_COLUMN, cleaned));
  // Only the certificate changes: valid_until stays what the generated certificate had.
  return {
    server: serverShow(server),
    certificateContent: cleaned,
    certificateValidUntil: utcIso(ca.valid_until),
    message: CA_CERTIFICATE_MESSAGES.saved,
    unavailable: CA_CERTIFICATE_MESSAGES.writeUnavailable,
    stored: true,
  };
}

/**
 * Show::regenerateCaCertificate(): a new key and a new self-signed CA
 * certificate for ten years, replacing the server's own certificate. This is
 * also how a server gets its first one: Coolify creates it while installing
 * Docker (validation) or when a database first needs it, neither of which
 * runs here yet.
 */
export async function regenerateCaCertificate(ctx: CaCertificateContext, uuid: string, now?: Date): Promise<CaCertificateSaved | null> {
  const server = await ctx.store.findServer(uuid);
  if (!server) return null;
  const generated = await generateSslCertificate({ commonName: CA_COMMON_NAME, isCaCertificate: true, validityDays: CA_VALIDITY_DAYS, ...(now ? { now } : {}) });
  const row = await ctx.store.replaceCa(server.id, {
    ...generated,
    sslCertificate: await ctx.cipher.encrypt(SSL_CERTIFICATE_COLUMN, generated.sslCertificate),
    sslPrivateKey: await ctx.cipher.encrypt(SSL_PRIVATE_KEY_COLUMN, generated.sslPrivateKey),
  });
  return {
    server: serverShow(server),
    certificateContent: generated.sslCertificate,
    certificateValidUntil: utcIso(row.valid_until),
    message: CA_CERTIFICATE_MESSAGES.regenerated,
    unavailable: CA_CERTIFICATE_MESSAGES.writeUnavailable,
    stored: true,
  };
}
