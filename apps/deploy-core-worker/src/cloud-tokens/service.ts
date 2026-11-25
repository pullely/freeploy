// Derived from coollabsio/coolify@91b7e3e:app/Models/CloudProviderToken.php,
// app/Livewire/Security/{CloudProviderTokens,CloudProviderTokenForm}.php,
// app/Livewire/Security/CloudProviderToken/Show.php and
// app/Livewire/Server/CloudProviderToken/Show.php (Apache-2.0), modified.
//
// What the Livewire components do with one org's cloud provider tokens, as
// plain operations. The store is that org's deploy.cloud_provider_tokens (and
// its servers, for the server's Cloud Token page) under row-level security;
// the cipher encrypts the token column. The token is never part of an answer:
// Coolify hides it on the model and no page shows it again. Asking the
// provider (providers.ts) is the handler's part, outside the transaction.
import type { DeployCloudProviderTokenRow, DeployCloudProviderTokenWithSecretRow, DeployServerCloudRow, DeployServerRow, CloudProviderTokenChanges } from "@saas/db/deploy";
import { newPublicId } from "../helpers/names.js";
import type { KeyCipher } from "../private-keys/service.js";
import { serverShow, type ServerShow } from "../servers/service.js";
import { providerName, type ServerCloudIds } from "./providers.js";
import type { CreateTokenInput, UpdateTokenInput } from "./validation.js";

export interface CloudTokenStore {
  list(provider?: string): Promise<DeployCloudProviderTokenRow[]>;
  findByUuid(uuid: string): Promise<DeployCloudProviderTokenWithSecretRow | null>;
  findById(id: string | number): Promise<DeployCloudProviderTokenWithSecretRow | null>;
  insert(token: { uuid: string; provider: string; token: string; name: string; description: string | null }): Promise<DeployCloudProviderTokenRow>;
  update(id: string | number, changes: CloudProviderTokenChanges): Promise<DeployCloudProviderTokenRow | null>;
  delete(id: string | number): Promise<boolean>;
  serverCount(id: string | number): Promise<number>;
  /** The server for the page chrome, and its provider ids and token. */
  findServer(uuid: string): Promise<DeployServerRow | null>;
  findServerCloud(uuid: string): Promise<DeployServerCloudRow | null>;
  setServerToken(serverId: string | number, tokenId: string | number): Promise<boolean>;
}

export interface CloudTokenContext {
  store: CloudTokenStore;
  /** Encrypts / decrypts the token column ("cloud_provider_tokens.token"). */
  cipher: KeyCipher;
}

/** Copy shown to the user: Coolify's, word for word. */
export const CLOUD_TOKEN_MESSAGES = {
  /** CloudProviderTokenForm::addToken() */
  invalidToken: "Invalid API token. Please check your token and try again.",
  added: "Cloud provider token added successfully.",
  /** CloudProviderToken\Show::save() */
  updated: "Cloud provider token updated.",
  /** CloudProviderTokens::deleteToken() */
  deleted: "Cloud provider token deleted successfully.",
  inUse: (servers: number) => `Cannot delete this token. It is currently used by ${servers} server(s). Please reassign those servers to a different token first.`,
  /** CloudProviderTokens::validateToken() */
  valid: (provider: string) => `${provider} token is valid.`,
  validationFailed: (provider: string) => `${provider} token validation failed. Please check the token.`,
  unknownProvider: "Unknown provider.",
  /** Server\CloudProviderToken\Show */
  notAllowed: "You are not allowed to use this token.",
  serverTokenUpdated: (provider: string) => `${provider} token updated successfully.`,
  noServerToken: (provider: string) => `No ${provider} token is associated with this server.`,
  serverTokenValid: (provider: string) => `${provider} token is valid and working.`,
  serverTokenInvalid: (provider: string) => `${provider} token is invalid or has insufficient permissions.`,
} as const;

/** A failure Coolify reports through dispatch('error'). */
export class CloudTokenError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

/** A TIMESTAMP(0) WITHOUT TIME ZONE (UTC wall clock) as an ISO instant. */
export function utcIso(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = value.trim().replace(" ", "T");
  const date = new Date(/(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export interface CloudTokenItem {
  uuid: string;
  name: string;
  description: string | null;
  provider: string;
  /** 'DigitalOcean', or ucfirst($provider). */
  providerName: string;
  createdAt: string | null;
}

/** The list's provider badge: $provider === 'digitalocean' ? 'DigitalOcean' : ucfirst($provider). */
const badge = (provider: string): string => (provider === "digitalocean" ? "DigitalOcean" : provider.charAt(0).toUpperCase() + provider.slice(1));

function item(row: DeployCloudProviderTokenRow, name: (provider: string) => string): CloudTokenItem {
  return { uuid: row.uuid ?? "", name: row.name ?? "", description: row.description, provider: row.provider, providerName: name(row.provider), createdAt: utcIso(row.created_at) };
}

/** CloudProviderTokens::loadTokens(). */
export async function listCloudTokens(ctx: CloudTokenContext): Promise<CloudTokenItem[]> {
  return (await ctx.store.list()).map((row) => item(row, badge));
}

/** CloudProviderTokenForm::addToken(), once the provider has accepted the token. */
export async function storeCloudToken(ctx: CloudTokenContext, input: CreateTokenInput): Promise<DeployCloudProviderTokenRow> {
  return ctx.store.insert({
    uuid: newPublicId(),
    provider: input.provider,
    token: await ctx.cipher.encrypt(input.token),
    name: input.name,
    description: input.description,
  });
}

/** CloudProviderToken\Show::mount(): the name, description, provider ($this->providerName()) and created time. */
export async function showCloudToken(ctx: CloudTokenContext, uuid: string): Promise<CloudTokenItem | null> {
  const row = await ctx.store.findByUuid(uuid);
  return row ? item(row, providerName) : null;
}

/** CloudProviderToken\Show::save(). */
export async function updateCloudToken(ctx: CloudTokenContext, uuid: string, input: UpdateTokenInput): Promise<DeployCloudProviderTokenRow | null> {
  const row = await ctx.store.findByUuid(uuid);
  if (!row) return null;
  return ctx.store.update(row.id, { name: input.name, description: input.description });
}

/** deleteToken() / Show::delete(): refused while a server uses the token. */
export async function deleteCloudToken(ctx: CloudTokenContext, uuid: string): Promise<boolean> {
  const row = await ctx.store.findByUuid(uuid);
  if (!row) return false;
  const servers = await ctx.store.serverCount(row.id);
  if (servers > 0) throw new CloudTokenError(CLOUD_TOKEN_MESSAGES.inUse(servers), 409);
  return ctx.store.delete(row.id);
}

/** A stored token in the clear, for asking its provider. Never part of an answer. */
export interface TokenSecret {
  provider: string;
  token: string;
}

/** validateToken(): the stored token of the org, decrypted. */
export async function cloudTokenSecret(ctx: CloudTokenContext, uuid: string): Promise<TokenSecret | null> {
  const row = await ctx.store.findByUuid(uuid);
  return row ? { provider: row.provider, token: await ctx.cipher.decrypt(row.token) } : null;
}

/** validateToken()'s toast for what the provider answered (null: a provider Coolify does not know). */
export function validationResult(provider: string, valid: boolean | null): { valid: boolean; message: string } {
  if (valid === null) return { valid: false, message: CLOUD_TOKEN_MESSAGES.unknownProvider };
  const name = providerName(provider);
  return { valid, message: valid ? CLOUD_TOKEN_MESSAGES.valid(name) : CLOUD_TOKEN_MESSAGES.validationFailed(name) };
}

// ---------------------------------------------------------------- a server's Cloud Token page

/**
 * loadTokens(): the provider follows the server's provider id (Vultr, then
 * Hostinger, else Hetzner). Coolify also looks at digitalocean_droplet_id,
 * a column deploy.servers does not have.
 */
export function serverProvider(server: Pick<DeployServerCloudRow, "vultr_instance_id" | "hostinger_virtual_machine_id">): string {
  if (filled(server.vultr_instance_id)) return "vultr";
  if (filled(server.hostinger_virtual_machine_id)) return "hostinger";
  return "hetzner";
}

const filled = (v: unknown): boolean => v !== null && v !== undefined && String(v).trim() !== "";
/** A provider id that PHP treats as true ($server->hetzner_server_id as a condition). */
const truthyId = (v: string | number | null): string | null => (v === null || v === undefined || String(v) === "" || String(v) === "0" ? null : String(v));

function cloudIds(server: DeployServerCloudRow): ServerCloudIds {
  return {
    hetznerServerId: truthyId(server.hetzner_server_id),
    vultrInstanceId: truthyId(server.vultr_instance_id),
    hostingerVirtualMachineId: truthyId(server.hostinger_virtual_machine_id),
  };
}

export interface ServerCloudTokenPage {
  server: ServerShow;
  provider: string;
  providerName: string;
  /** The server was created through a provider (the page's @if). */
  hasCloudProvider: boolean;
  tokens: Array<{ uuid: string; name: string; description: string | null; createdAt: string | null; active: boolean }>;
}

/** Server\CloudProviderToken\Show::mount() + loadTokens(): the org's tokens of the server's provider. */
export async function serverCloudTokenPage(ctx: CloudTokenContext, uuid: string): Promise<ServerCloudTokenPage | null> {
  const [server, cloud] = await Promise.all([ctx.store.findServer(uuid), ctx.store.findServerCloud(uuid)]);
  if (!server || !cloud) return null;
  const provider = serverProvider(cloud);
  const ids = cloudIds(cloud);
  const tokens = await ctx.store.list(provider);
  return {
    server: serverShow(server),
    provider,
    providerName: providerName(provider),
    hasCloudProvider: Boolean(ids.hetznerServerId || ids.vultrInstanceId || ids.hostingerVirtualMachineId),
    tokens: tokens.map((t) => ({
      uuid: t.uuid ?? "",
      name: t.name ?? "",
      description: t.description,
      createdAt: utcIso(t.created_at),
      active: cloud.cloud_provider_token_id !== null && String(cloud.cloud_provider_token_id) === String(t.id),
    })),
  };
}

export interface ServerTokenChoice {
  serverId: string | number;
  providerName: string;
  ids: ServerCloudIds;
  tokenId: string | number;
  secret: TokenSecret;
}

/**
 * setCloudProviderToken(), before the provider is asked: the server, and a
 * token of the org ('You are not allowed to use this token.' otherwise).
 */
export async function chooseServerToken(ctx: CloudTokenContext, serverUuid: string, tokenUuid: unknown): Promise<ServerTokenChoice | null> {
  const cloud = await ctx.store.findServerCloud(serverUuid);
  if (!cloud) return null;
  const token = typeof tokenUuid === "string" && tokenUuid !== "" ? await ctx.store.findByUuid(tokenUuid) : null;
  if (!token) throw new CloudTokenError(CLOUD_TOKEN_MESSAGES.notAllowed);
  return {
    serverId: cloud.id,
    providerName: providerName(serverProvider(cloud)),
    ids: cloudIds(cloud),
    tokenId: token.id,
    secret: { provider: token.provider, token: await ctx.cipher.decrypt(token.token) },
  };
}

/** setCloudProviderToken(), once the provider has accepted the token for this server. */
export function assignServerToken(ctx: CloudTokenContext, choice: Pick<ServerTokenChoice, "serverId" | "tokenId">): Promise<boolean> {
  return ctx.store.setServerToken(choice.serverId, choice.tokenId);
}

/** validateToken() on the server page: the server's own token, or none. */
export async function serverTokenSecret(ctx: CloudTokenContext, serverUuid: string): Promise<{ providerName: string; secret: TokenSecret | null } | null> {
  const cloud = await ctx.store.findServerCloud(serverUuid);
  if (!cloud) return null;
  const token = cloud.cloud_provider_token_id === null ? null : await ctx.store.findById(cloud.cloud_provider_token_id);
  return {
    providerName: providerName(serverProvider(cloud)),
    secret: token ? { provider: token.provider, token: await ctx.cipher.decrypt(token.token) } : null,
  };
}
