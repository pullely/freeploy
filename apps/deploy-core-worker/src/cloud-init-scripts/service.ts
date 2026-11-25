// Derived from coollabsio/coolify@91b7e3e:app/Models/CloudInitScript.php,
// app/Livewire/Security/{CloudInitScripts,CloudInitScriptForm}.php and
// app/Livewire/Security/CloudInitScript/Show.php (Apache-2.0), modified.
//
// What the Livewire components do with one org's cloud-init scripts, as plain
// operations. The store is that org's deploy.cloud_init_scripts under
// row-level security; the cipher encrypts the script column.
import type { CloudInitScriptChanges, DeployCloudInitScriptRow, DeployCloudInitScriptWithSecretRow } from "@saas/db/deploy";
import { utcIso } from "../cloud-tokens/service.js";
import { newPublicId } from "../helpers/names.js";
import type { KeyCipher } from "../private-keys/service.js";
import type { ScriptInput } from "./validation.js";

export interface CloudInitScriptStore {
  list(): Promise<DeployCloudInitScriptRow[]>;
  findByUuid(uuid: string): Promise<DeployCloudInitScriptWithSecretRow | null>;
  insert(script: { uuid: string; name: string; script: string }): Promise<DeployCloudInitScriptRow>;
  update(id: string | number, changes: CloudInitScriptChanges): Promise<DeployCloudInitScriptRow | null>;
  delete(id: string | number): Promise<boolean>;
}

export interface CloudInitScriptContext {
  store: CloudInitScriptStore;
  /** Encrypts / decrypts the script column ("cloud_init_scripts.script"). */
  cipher: KeyCipher;
}

/** Copy shown to the user: Coolify's, word for word. */
export const CLOUD_INIT_MESSAGES = {
  /** CloudInitScriptForm::save() */
  created: "Cloud-init script created successfully.",
  /** CloudInitScriptForm::save() and Show::save() */
  updated: "Cloud-init script updated successfully.",
  /** CloudInitScripts::deleteScript() */
  deleted: "Cloud-init script deleted successfully.",
} as const;

export interface CloudInitScriptItem {
  uuid: string;
  name: string;
  updatedAt: string | null;
}

/** CloudInitScripts::loadScripts(): newest first, never the script. */
export async function listCloudInitScripts(ctx: CloudInitScriptContext): Promise<CloudInitScriptItem[]> {
  return (await ctx.store.list()).map((row) => ({ uuid: row.uuid ?? "", name: row.name, updatedAt: utcIso(row.updated_at) }));
}

/** CloudInitScriptForm::save() for a new script. */
export async function createCloudInitScript(ctx: CloudInitScriptContext, input: ScriptInput): Promise<DeployCloudInitScriptRow> {
  return ctx.store.insert({ uuid: newPublicId(), name: input.name, script: await ctx.cipher.encrypt(input.script) });
}

export interface CloudInitScriptShow {
  uuid: string;
  name: string;
  /** The script in the clear, for who may update it; null otherwise, or when it does not decrypt. */
  script: string | null;
}

/**
 * Show::mount(): the name and the script. Coolify shows the page to team
 * admins only; here the script itself goes to who may write.
 */
export async function showCloudInitScript(ctx: CloudInitScriptContext, uuid: string, withScript: boolean): Promise<CloudInitScriptShow | null> {
  const row = await ctx.store.findByUuid(uuid);
  if (!row) return null;
  let script: string | null = null;
  if (withScript) {
    try {
      script = await ctx.cipher.decrypt(row.script);
    } catch {
      script = null;
    }
  }
  return { uuid: row.uuid ?? "", name: row.name, script };
}

/** Show::save() / CloudInitScriptForm::save() for an existing script. */
export async function updateCloudInitScript(ctx: CloudInitScriptContext, uuid: string, input: ScriptInput): Promise<DeployCloudInitScriptRow | null> {
  const row = await ctx.store.findByUuid(uuid);
  if (!row) return null;
  return ctx.store.update(row.id, { name: input.name, script: await ctx.cipher.encrypt(input.script) });
}

/** Show::delete() / deleteScript(). */
export async function deleteCloudInitScript(ctx: CloudInitScriptContext, uuid: string): Promise<boolean> {
  const row = await ctx.store.findByUuid(uuid);
  if (!row) return false;
  return ctx.store.delete(row.id);
}
