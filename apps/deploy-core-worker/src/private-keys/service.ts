// Derived from coollabsio/coolify@91b7e3e:app/Models/PrivateKey.php (createAndStore, the
// saving hook, generateNewKeyPair, isInUse, cleanupUnusedKeys) and
// app/Livewire/Security/PrivateKey/{Index,Create,Show,Rotate}.php (Apache-2.0), modified.
//
// What the Livewire components do, as plain operations on one org's keys. The
// store is that org's deploy.private_keys (row-level security, withOrg); the
// cipher encrypts the private_key column. Coolify's filesystem copy of the key
// (storeInFileSystem) has no counterpart: the ssh-executor reads the column.
import type {
  DeployPrivateKeyListRow,
  DeployPrivateKeyRow,
  DeployPrivateKeyWithSecretRow,
  PrivateKeyChanges,
  PrivateKeyUsages,
} from "@saas/db/deploy";
import { fingerprintSha256, formatPrivateKey, generateSSHKey, publicKeyOpenSSH, validationError } from "../keys/ssh-keys.js";
import { generateRandomName, newPublicId } from "../helpers/names.js";
import type { CreateInput, UpdateInput } from "./validation.js";

export interface PrivateKeyStore {
  list(): Promise<DeployPrivateKeyListRow[]>;
  findByUuid(uuid: string): Promise<DeployPrivateKeyWithSecretRow | null>;
  insert(key: { uuid: string; name: string; description: string | null; privateKey: string; fingerprint: string | null }): Promise<DeployPrivateKeyRow>;
  update(id: string | number, changes: PrivateKeyChanges): Promise<DeployPrivateKeyRow | null>;
  delete(id: string | number): Promise<boolean>;
  fingerprintExists(fingerprint: string | null, excludeId?: string | number | null): Promise<boolean>;
  isInUse(id: string | number): Promise<boolean>;
  usages(id: string | number, search: string): Promise<PrivateKeyUsages>;
}

/** Encrypts / decrypts the private_key column ("private_keys.private_key"). */
export interface KeyCipher {
  encrypt(plaintext: string): Promise<string>;
  decrypt(stored: string): Promise<string>;
}

export interface OrgContext {
  store: PrivateKeyStore;
  cipher: KeyCipher;
}

/** Copy shown to the user. Coolify's, with the brand swapped where it names the product. */
export const PRIVATE_KEY_MESSAGES = {
  alreadyExists: "This private key already exists.",
  invalidType: "Invalid private key type.",
  generated: "Private key generated successfully.",
  created: "Private key created successfully.",
  updated: "Private key updated.",
  cleanedUp: "Unused keys have been cleaned up.",
  deleteDisabled: "This private key is currently used by a server, application, or Git app and cannot be deleted.",
  /** generateNewKeyPair(): 'Created by Coolify'. */
  generatedDescription: "Created by Freeploy",
  publicKeyError: "Error loading private key",
  rotateUnavailable: "Key rotation needs the SSH executor, which is not available yet.",
  revealUnavailable: "Revealing the private key needs a password confirmation, which is not available yet.",
} as const;

/** A failure Coolify reports through ValidationException or dispatch('error'). */
export class PrivateKeyError extends Error {
  constructor(
    message: string,
    /** The field of a ValidationException (private_key), or null for a plain error toast. */
    readonly field: string | null = null,
    readonly status = 422,
  ) {
    super(message);
  }
}

/** The saving hook for a new or replaced key: format, check strictly, fingerprint, uniqueness in the org. */
async function prepareKey(store: PrivateKeyStore, key: string, excludeId: string | number | null): Promise<{ formatted: string; fingerprint: string | null }> {
  const formatted = formatPrivateKey(key);
  const error = validationError(formatted, true);
  if (error) throw new PrivateKeyError(error, "private_key");
  const fingerprint = await fingerprintSha256(formatted);
  if (await store.fingerprintExists(fingerprint, excludeId)) throw new PrivateKeyError(PRIVATE_KEY_MESSAGES.alreadyExists, "private_key");
  return { formatted, fingerprint };
}

/** PrivateKey::createAndStore(). */
export async function createAndStore(ctx: OrgContext, data: { name: string; description: string | null; privateKey: string }): Promise<DeployPrivateKeyRow> {
  const { formatted, fingerprint } = await prepareKey(ctx.store, data.privateKey, null);
  return ctx.store.insert({
    uuid: newPublicId(),
    name: data.name,
    description: data.description,
    privateKey: await ctx.cipher.encrypt(formatted),
    fingerprint,
  });
}

/** Create::createPrivateKey(): the key as trim($value)."\n". */
export function createPrivateKey(ctx: OrgContext, input: CreateInput): Promise<DeployPrivateKeyRow> {
  return createAndStore(ctx, { name: input.name, description: input.description, privateKey: `${input.value.trim()}\n` });
}

/** Index::generatePrivateKey($type) with PrivateKey::generateNewKeyPair(). */
export async function generatePrivateKey(ctx: OrgContext, type: unknown): Promise<DeployPrivateKeyRow> {
  if (type !== "ed25519" && type !== "rsa") throw new PrivateKeyError(PRIVATE_KEY_MESSAGES.invalidType);
  let pair;
  try {
    pair = await generateSSHKey(type);
  } catch (e) {
    throw new PrivateKeyError(`Failed to generate new ${type} key: ${(e as Error).message}`, null, 500);
  }
  return createAndStore(ctx, { name: generateRandomName(), description: PRIVATE_KEY_MESSAGES.generatedDescription, privateKey: pair.private });
}

/** Create::validatePrivateKey() (on every change of the key field): the error, or the public key. */
export async function inspectPrivateKey(value: string): Promise<{ error: string | null; publicKey: string }> {
  const error = validationError(value, true);
  if (error) return { error, publicKey: "" };
  try {
    return { error: null, publicKey: await publicKeyOpenSSH(value) };
  } catch {
    // extractPublicKeyFromPrivate() returns null.
    return { error: null, publicKey: "" };
  }
}

/** PrivateKey::getPublicKey(): 'Error loading private key' when the key does not load. */
async function publicKeyOf(ctx: OrgContext, stored: string): Promise<string> {
  try {
    return await publicKeyOpenSSH(await ctx.cipher.decrypt(stored));
  } catch {
    return PRIVATE_KEY_MESSAGES.publicKeyError;
  }
}

export interface PrivateKeyShow {
  uuid: string;
  name: string;
  description: string | null;
  publicKey: string;
  fingerprint: string | null;
  isGitRelated: boolean;
  isInUse: boolean;
  /** Rotate: servers use the key (the dialog's trigger shows), and other resources stay on it. */
  hasServers: boolean;
  usedByOthers: boolean;
  usages: PrivateKeyUsages;
}

/** Show::mount() + render(). Never the private key itself: Coolify sends it only through revealPrivateKey(). */
export async function showPrivateKey(ctx: OrgContext, uuid: string, usageSearch: string): Promise<PrivateKeyShow | null> {
  const key = await ctx.store.findByUuid(uuid);
  if (!key) return null;
  const publicKey = await publicKeyOf(ctx, key.private_key);
  const isInUse = await ctx.store.isInUse(key.id);
  // The counts always cover everything; the rows follow the search.
  const usages = await ctx.store.usages(key.id, usageSearch);
  const counts = usages.counts;
  return {
    uuid: key.uuid,
    name: key.name,
    description: key.description,
    publicKey,
    fingerprint: key.fingerprint,
    isGitRelated: Boolean(key.is_git_related),
    isInUse,
    hasServers: (counts.Server ?? 0) > 0,
    usedByOthers: (counts.Application ?? 0) + (counts["GitHub App"] ?? 0) + (counts["GitLab App"] ?? 0) + (counts["Gitea App"] ?? 0) > 0,
    usages,
  };
}

/** Show::changePrivateKey(): syncData(true), save (the saving hook), syncData(false). */
export async function updatePrivateKey(ctx: OrgContext, uuid: string, input: UpdateInput): Promise<DeployPrivateKeyRow | null> {
  const key = await ctx.store.findByUuid(uuid);
  if (!key) return null;
  const changes: PrivateKeyChanges = { name: input.name, description: input.description, isGitRelated: Boolean(key.is_git_related) };
  // Only a new or changed key is checked, so older keys can still be renamed.
  const normalize = (k: string) => formatPrivateKey(k).replace(/\r\n/g, "\n");
  const stored = input.newPrivateKey !== null || key.fingerprint === null ? await ctx.cipher.decrypt(key.private_key) : null;
  if (input.newPrivateKey !== null && stored !== null && normalize(input.newPrivateKey) !== normalize(stored)) {
    const { formatted, fingerprint } = await prepareKey(ctx.store, input.newPrivateKey, key.id);
    changes.privateKey = { ciphertext: await ctx.cipher.encrypt(formatted), fingerprint };
  } else {
    // The hook recomputes the fingerprint of the unchanged key and checks it again.
    const fingerprint = key.fingerprint ?? (stored !== null ? await fingerprintSha256(formatPrivateKey(stored)) : null);
    if (await ctx.store.fingerprintExists(fingerprint, key.id)) throw new PrivateKeyError(PRIVATE_KEY_MESSAGES.alreadyExists, "private_key");
    if (key.fingerprint === null && stored !== null) changes.privateKey = { ciphertext: key.private_key, fingerprint };
  }
  return ctx.store.update(key.id, changes);
}

/** Show::delete(): refused while the key is in use. */
export async function deletePrivateKey(ctx: OrgContext, uuid: string): Promise<boolean> {
  const key = await ctx.store.findByUuid(uuid);
  if (!key) return false;
  if (await ctx.store.isInUse(key.id)) throw new PrivateKeyError(PRIVATE_KEY_MESSAGES.deleteDisabled, null, 409);
  return ctx.store.delete(key.id);
}

/** PrivateKey::cleanupUnusedKeys(): safeDelete() every key of the org; returns how many went. */
export async function cleanupUnusedKeys(ctx: OrgContext): Promise<number> {
  let deleted = 0;
  for (const key of await ctx.store.list()) {
    if (!key.in_use && (await ctx.store.delete(key.id))) deleted++;
  }
  return deleted;
}
