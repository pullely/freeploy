// DP-63: the `deploy` schema the feature tests run on is the one stage and prod
// run — every migration of the deploy bounded context in the manifest, in
// manifest order. A suite that names its own list of migration files tests an
// older schema than the one its SQL will meet; only a test whose subject is one
// migration step does that, through deployDatabaseAfter().
//
// The migrations create everything the suites share: the schema, the role
// `deploy_app` and the forced row-level security withOrg() relies on. Nothing
// else is set up here, so a suite sees what a fresh database sees.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { manifest } from "@saas/db";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";

/** The repository root. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// The cipher of @saas/db/deploy uses Web Crypto.
if (!globalThis.crypto) (globalThis as { crypto: unknown }).crypto = webcrypto;

/** A platform KEK for tests (DEPLOY_ENCRYPTION_KEY's format: 32 bytes, base64). */
export const TEST_KEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

/** The deploy migrations of the manifest, in order. */
export function deployMigrationIds(): string[] {
  return manifest.migrations.filter((m) => m.context === "deploy").map((m) => m.id);
}

/** The deploy migrations that come before `id` in the manifest. */
export function deployMigrationsBefore(id: string): string[] {
  const ids = deployMigrationIds();
  const at = ids.indexOf(id);
  if (at < 0) throw new Error(`no deploy migration ${id} in the manifest`);
  return ids.slice(0, at);
}

export function migrationSql(id: string): string {
  const entry = manifest.migrations.find((m) => m.id === id);
  if (!entry) throw new Error(`no migration ${id} in the manifest`);
  return readFileSync(resolve(REPO_ROOT, "packages/db/src/migrations", entry.path), "utf8");
}

/** A fresh database after exactly these migrations — for a test about one migration step. */
export async function deployDatabaseAfter(ids: readonly string[]): Promise<PGlite> {
  const db = new PGlite();
  for (const id of ids) await db.exec(migrationSql(id));
  return db;
}

/** A fresh database with the deploy schema at head. */
export function deployDatabase(): Promise<PGlite> {
  return deployDatabaseAfter(deployMigrationIds());
}

/** PGlite as the executor deploy-core-worker hands to withOrg(). */
export function executor(db: PGlite): TransactionalSqlExecutor {
  const wrap = (q: { query: PGlite["query"] }): SqlExecutor => ({
    async execute(text, params) {
      const r = await q.query(text, params ?? []);
      return { rows: r.rows as never[], rowCount: r.rows.length };
    },
  });
  return { ...wrap(db), transaction: (fn) => db.transaction((tx) => fn(wrap(tx as never))) };
}

/** The SQLSTATE of a rejected statement, or null when it succeeded. */
export async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}
