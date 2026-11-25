// The API goldens' fixture in Freeploy's own database (DP-71): PGlite with every migration of the deploy bounded
// context (the schema stage and prod run), the fixture's rows made by Freeploy's insert functions in Coolify's
// order (so the ids are the same), and an executor whose transactions are savepoints of one outer transaction,
// which each case rolls back — the way fixtures/api/emit.php runs each case in a transaction it rolls back.
//
// PGlite is tests/db's dependency (the same version, from its node_modules), mapped here by jest and tsconfig.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { manifest } from "@saas/db";
import type { SqlExecutor, TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import {
  APPLICATION_WEBHOOK_SECRET_COLUMNS,
  DATABASE_TABLES,
  databaseOwner,
  insertDatabase,
  insertDatabaseBackup,
  insertDatabaseVariable,
  insertS3Storage,
  syncScheduleS3Storages,
  type DatabaseEngine,
  PUBLIC_GITHUB_SOURCE,
  insertBuiltApplication,
  insertDockerImageApplication,
  insertEnvironment,
  insertEnvironmentVariable,
  insertPrivateKey,
  insertProject,
  insertServer,
  withOrg,
} from "@saas/db/deploy";
import { columnCipher } from "@deploy-core-worker/handlers/cloud-tokens";
import { ENVIRONMENT_VARIABLE_VERSION } from "@deploy-core-worker/environment-variables/service";
import { defaultVolumes } from "@deploy-core-worker/databases/engines";
import { CASES } from "./api-v1-goldens.js";


const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** A platform KEK for tests (DEPLOY_ENCRYPTION_KEY: 32 bytes, base64). */
export const TEST_KEK = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
/** The fixture's teams as orgs: team 1 and team 2. */
export const ORG_UUID: Record<number, string> = { 1: "00000000-0000-4000-8000-00000000000a", 2: "00000000-0000-4000-8000-00000000000b" };

/** A fresh database with the deploy schema at head. */
async function deployDatabase(): Promise<PGlite> {
  const db = new PGlite();
  for (const m of manifest.migrations.filter((x) => x.context === "deploy")) await db.exec(readFileSync(resolve(REPO_ROOT, "packages/db/src/migrations", m.path), "utf8"));
  return db;
}

const wrap = (pg: PGlite): SqlExecutor => ({
  async execute(text, params) {
    const r = await pg.query(text, params ?? []);
    return { rows: r.rows as never[], rowCount: r.rows.length };
  },
});

/** Transactions as PGlite runs them (the fixture's, committed). */
function committing(pg: PGlite): TransactionalSqlExecutor {
  return { ...wrap(pg), transaction: (fn) => pg.transaction((tx) => fn(wrap(tx as never))) };
}

let savepoint = 0;
/** Transactions as savepoints of the case's outer transaction. */
function nested(pg: PGlite): TransactionalSqlExecutor {
  const ex = wrap(pg);
  return {
    ...ex,
    async transaction(fn) {
      const name = `sp${++savepoint}`;
      await pg.exec(`SAVEPOINT ${name}`);
      try {
        const out = await fn(ex);
        await pg.exec(`RELEASE SAVEPOINT ${name}`);
        return out;
      } catch (e) {
        await pg.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        throw e;
      }
    },
  };
}

export interface FixtureDatabase {
  pg: PGlite;
  /** Runs one case: fn gets an executor whose work is rolled back afterwards. */
  inCase<T>(fn: (db: TransactionalSqlExecutor) => Promise<T>): Promise<T>;
}

/** The fixture of cases.json, made by Freeploy's insert functions. */
export async function fixtureDatabase(): Promise<FixtureDatabase> {
  const pg = await deployDatabase();
  const db = committing(pg);
  const f = CASES.fixture;
  const org = (team: number) => ORG_UUID[team]!;
  const encrypt = (tx: SqlExecutor, team: number, column: string, plaintext: string) => columnCipher(tx, org(team), TEST_KEK, column).encrypt(plaintext);
  // Coolify's order (emit.php), so every serial id is the fixture's.
  for (const p of f.projects) {
    await withOrg(db, org(p.team), async (tx) => {
      const [first, ...more] = p.environments;
      await insertProject(tx, { orgId: org(p.team), uuid: p.uuid, name: p.name, description: p.description, productionEnvironmentUuid: first!.uuid });
      for (const e of more) await insertEnvironment(tx, { orgId: org(p.team), projectId: p.id, uuid: e.uuid, name: e.name, description: e.description });
    });
  }
  for (const k of f.privateKeys) {
    await withOrg(db, org(k.team), async (tx) => {
      await insertPrivateKey(tx, { orgId: org(k.team), uuid: k.uuid, name: k.name, description: k.description, privateKey: await encrypt(tx, k.team, "private_keys.private_key", k.file), fingerprint: `fp-${k.uuid}` });
    });
  }
  for (const s of f.servers) {
    const destination = f.destinations.find((d) => d.server_id === s.id)!;
    await withOrg(db, org(s.team), async (tx) => {
      // Coolify's created hook: redirect_enabled (the fixture's server is made with forceCreate()).
      await insertServer(tx, { orgId: org(s.team), uuid: s.uuid, name: s.name, description: s.description, ip: s.ip, user: s.user, port: s.port, privateKeyId: s.private_key_id, proxy: { redirect_enabled: true }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: destination.uuid });
    });
  }
  for (const a of f.applications) {
    await withOrg(db, org(a.team), async (tx) => {
      const secrets = Object.fromEntries(await Promise.all(APPLICATION_WEBHOOK_SECRET_COLUMNS.map(async (c) => [c, await encrypt(tx, a.team, `applications.${c}`, String(a.columns[c]))]))) as Record<(typeof APPLICATION_WEBHOOK_SECRET_COLUMNS)[number], string>;
      const common = { orgId: org(a.team), uuid: a.uuid, name: a.name, fqdn: a.fqdn, domainPortOverrides: null, environmentId: a.environment_id, destinationId: a.destination_id, destinationType: "standalone" as const, webhookSecrets: secrets };
      if (a.columns.build_pack === "dockerimage") {
        await insertDockerImageApplication(tx, { ...common, dockerRegistryImageName: String(a.columns.docker_registry_image_name), dockerRegistryImageTag: String(a.columns.docker_registry_image_tag) });
        return;
      }
      // A public repository's Nixpacks application: the created hook's NIXPACKS_NODE_VERSION and its preview copy.
      const variable = async (isPreview: boolean) => ({ uuid: `nixpacks${isPreview ? "preview" : "product"}${a.id}`.padEnd(24, "0"), key: "NIXPACKS_NODE_VERSION", value: await encrypt(tx, a.team, "environment_variables.value", "22"), isMultiline: false, isLiteral: false, isBuildtime: true, isRuntime: false, isPreview, version: ENVIRONMENT_VARIABLE_VERSION });
      await insertBuiltApplication(tx, {
        ...common,
        repositoryProjectId: null,
        gitRepository: String(a.columns.git_repository),
        gitBranch: String(a.columns.git_branch),
        buildPack: String(a.columns.build_pack),
        portsExposes: String(a.columns.ports_exposes),
        baseDirectory: String(a.columns.base_directory),
        publishDirectory: null,
        dockerfile: null,
        dockerfileLocation: null,
        dockerComposeLocation: null,
        healthCheckEnabled: null,
        dockerfileHealthcheck: null,
        sourceId: PUBLIC_GITHUB_SOURCE.id,
        sourceType: PUBLIC_GITHUB_SOURCE.type,
        isStatic: false,
        variables: [await variable(false), await variable(true)],
      });
    });
  }
  for (const v of f.variables) {
    const team = f.applications.find((a) => a.id === v.application)!.team;
    await withOrg(db, org(team), async (tx) => {
      const value = await encrypt(tx, team, "environment_variables.value", v.value);
      const row = { orgId: org(team), key: v.key, value, comment: v.comment, order: null, isMultiline: v.is_multiline, isLiteral: v.is_literal, isRuntime: v.is_runtime, isBuildtime: v.is_buildtime, isRequired: false, isShownOnce: v.is_shown_once, isShared: false, version: ENVIRONMENT_VARIABLE_VERSION };
      await insertEnvironmentVariable(tx, "application", v.application, { ...row, uuid: v.uuid, isPreview: false });
      // EnvironmentVariable's created hook: the application's preview copy.
      await insertEnvironmentVariable(tx, "application", v.application, { ...row, uuid: `${v.uuid.slice(0, 20)}prev`, isPreview: true });
    });
  }
  // DP-73: an S3 storage per team, the databases (insertDatabase() with the columns Coolify's create_standalone_*()
  // filled, the created hook's volumes, Redis's two variables), their backup schedules and two executions.
  for (const s of f.s3Storages) {
    await withOrg(db, org(s.team), async (tx) => {
      await insertS3Storage(tx, {
        orgId: org(s.team), uuid: s.uuid, type: "s3", name: s.name, description: s.description, region: s.region,
        key: await encrypt(tx, s.team, "s3_storages.key", s.key), secret: await encrypt(tx, s.team, "s3_storages.secret", s.secret),
        bucket: s.bucket, endpoint: s.endpoint, usePathStyleEndpoint: false, skipTlsVerification: false, isUsable: s.is_usable, unusableEmailSent: false,
      });
    });
  }
  for (const d of f.databases) {
    const engine = d.engine as DatabaseEngine;
    await withOrg(db, org(d.team), async (tx) => {
      const values: Record<string, string | number | boolean> = {};
      for (const [column, value] of Object.entries(d.columns)) {
        if (column === "redis_password") continue;
        values[column] = DATABASE_TABLES[engine].encrypted.includes(column) ? await encrypt(tx, d.team, `${DATABASE_TABLES[engine].table}.${column}`, String(value)) : value;
      }
      const volumes = defaultVolumes(engine, d.uuid, String(d.columns.image)).map((v, i) => ({ uuid: `${d.uuid.slice(0, 20)}vol${i}`, name: v.name, mountPath: v.mountPath }));
      const row = await insertDatabase(tx, engine, { orgId: org(d.team), uuid: d.uuid, name: d.name, environmentId: d.environment_id, destinationId: d.destination_id, destinationType: "standalone", values, volumes });
      if (engine === "redis") {
        for (const [key, value] of [["REDIS_PASSWORD", String(d.columns.redis_password)], ["REDIS_USERNAME", "default"]] as const) {
          await insertDatabaseVariable(tx, databaseOwner(engine, row.id), { orgId: org(d.team), uuid: `${d.uuid.slice(0, 20)}${key === "REDIS_PASSWORD" ? "pass" : "user"}`, key, value: await encrypt(tx, d.team, "environment_variables.value", value), isShared: false, version: ENVIRONMENT_VARIABLE_VERSION });
        }
      }
    });
  }
  for (const b of f.backups) {
    const engine = b.engine as DatabaseEngine;
    await withOrg(db, org(b.team), async (tx) => {
      const created = await insertDatabaseBackup(tx, { orgId: org(b.team), uuid: b.uuid, frequency: b.frequency, databaseType: DATABASE_TABLES[engine].morphClass, databaseId: b.database_id, databasesToBackup: b.databases_to_backup });
      if (b.save_s3) {
        await tx.execute("UPDATE deploy.scheduled_database_backups SET save_s3 = true WHERE id = $1", [created.id]);
        await syncScheduleS3Storages(tx, "database", created.id, b.s3, org(b.team));
      }
      await tx.execute("UPDATE deploy.scheduled_database_backups SET created_at = $2 WHERE id = $1", [created.id, b.created_at]);
    });
  }
  for (const x of f.executions) {
    const team = f.backups.find((b) => b.id === x.backup)!.team;
    await withOrg(db, org(team), async (tx) => {
      await tx.execute(
        `INSERT INTO deploy.scheduled_database_backup_executions (id, uuid, scheduled_database_backup_id, status, message, size, filename, database_name, created_at, updated_at, finished_at, org_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10, $11)`,
        [x.id, x.uuid, x.backup, x.status, x.message, x.size === null ? null : String(x.size), x.filename, x.database_name, x.created_at, x.finished_at, org(team)],
      );
      // The created hook: the schedule's last_execution_at.
      await tx.execute("UPDATE deploy.scheduled_database_backups SET last_execution_at = $2 WHERE id = $1", [x.backup, x.created_at]);
    });
  }
  return {
    pg,
    async inCase(fn) {
      await pg.exec("BEGIN");
      try {
        return await fn(nested(pg));
      } finally {
        await pg.exec("ROLLBACK");
      }
    },
  };
}
