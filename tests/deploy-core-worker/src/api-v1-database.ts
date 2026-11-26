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
  insertParsedService,
  insertTag,
  attachTag,
  insertSharedVariable,
  APPLICATION_MORPH_CLASS,
  SERVICE_MORPH_CLASS,
  SERVICE_PART_MORPH_CLASS,
  insertPersistentVolume,
  insertFileVolume,
  insertScheduledTask,
  ensureNotificationSettings,
  NOTIFICATION_CHANNELS,
  withOrg,
} from "@saas/db/deploy";
import { columnCipher } from "@deploy-core-worker/handlers/cloud-tokens";
import { ENVIRONMENT_VARIABLE_VERSION } from "@deploy-core-worker/environment-variables/service";
import { defaultVolumes } from "@deploy-core-worker/databases/engines";
import { normalizeDomainPortOverrides } from "@deploy-core-worker/applications/domains";
import { fingerprintSha256, formatPrivateKey } from "@deploy-core-worker/keys/ssh-keys";
import { CASES, fixtureKeyText } from "./api-v1-goldens.js";


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
      // The committed test key itself (DP-93: until then its file's path), so that its public key and fingerprint are real.
      const text = formatPrivateKey(fixtureKeyText(k));
      await insertPrivateKey(tx, { orgId: org(k.team), uuid: k.uuid, name: k.name, description: k.description, privateKey: await encrypt(tx, k.team, "private_keys.private_key", text), fingerprint: (await fingerprintSha256(text))! });
    });
  }
  for (const s of f.servers) {
    const destination = f.destinations.find((d) => d.server_id === s.id)!;
    await withOrg(db, org(s.team), async (tx) => {
      // Coolify's created hook: redirect_enabled (the fixture's server is made with forceCreate()).
      await insertServer(tx, { orgId: org(s.team), uuid: s.uuid, name: s.name, description: s.description, ip: s.ip, user: s.user, port: s.port, privateKeyId: s.private_key_id, proxy: { redirect_enabled: true }, serverRole: "both", imageScanEnabled: false, defaultDestinationUuid: destination.uuid });
      // The created hook's predefined variables, literal (DP-81: they take the first ids of the shared variables, as in Coolify).
      for (const [key, value] of [["COOLIFY_SERVER_UUID", s.uuid], ["COOLIFY_SERVER_NAME", s.name]] as const) {
        await insertSharedVariable(tx, { orgId: org(s.team), owner: { type: "server", id: s.id }, key, value: await encrypt(tx, s.team, "shared_environment_variables.value", value), isLiteral: true });
      }
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
        bucket: s.bucket, endpoint: s.endpoint, usePathStyleEndpoint: true, skipTlsVerification: false, isUsable: s.is_usable, unusableEmailSent: false,
      });
    });
  }
  // emit.php's $advanceSequences() moved the volumes' sequence before the first was made (setval(…, 1)): their ids start at 2 (DP-84).
  await pg.exec("SELECT setval(pg_get_serial_sequence('deploy.local_persistent_volumes', 'id'), 1)");
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
  // DP-74: the services with their fixed columns (insertParsedService() with the parts and variables emit.php made through
  // the models; the description and a variable's lock after it, as the insert does not take them).
  for (const s of f.services) {
    await withOrg(db, org(s.team), async (tx) => {
      const part = (p: { id: number; uuid: string; name: string; image: string }) => ({ localId: p.id, uuid: p.uuid, name: p.name, humanName: null, ports: null, image: p.image, excludeFromStatus: false, isLogDrainEnabled: false, isGzipEnabled: true, isStripprefixEnabled: true, isMigrated: false, isRemovedFromCompose: false });
      const variables = [];
      for (const v of f.serviceVariables.filter((x) => x.service === s.id)) {
        variables.push({ uuid: v.uuid, key: v.key, value: await encrypt(tx, s.team, "environment_variables.value", v.value), isPreview: false, isRequired: false, isShared: false, isLiteral: false, isMultiline: false, comment: v.comment, version: ENVIRONMENT_VARIABLE_VERSION, preserveComposeNull: false });
      }
      const id = await insertParsedService(tx, {
        orgId: org(s.team), uuid: s.uuid, name: s.name, environmentId: s.environment_id, serverId: s.server_id, destinationId: s.destination_id, destinationType: "standalone",
        dockerComposeRaw: s.docker_compose_raw, dockerCompose: s.docker_compose, connectToDockerNetwork: false, serviceType: s.service_type, composeParsingVersion: "5", isContainerLabelEscapeEnabled: true, includeCoolifyDefaultVariables: true,
        applications: f.serviceApplications.filter((a) => a.service === s.id).map((a) => ({ ...part(a), fqdn: a.fqdn, noindexDomains: null, redirect: "both", isForceHttpsEnabled: true, isPermanentRedirectEnabled: false, domainPortOverrides: null, traefikCertificateResolver: null })),
        databases: f.serviceDatabases.filter((d) => d.service === s.id).map(part),
        variables,
        persistentVolumes: [],
        fileVolumes: [],
      });
      await tx.execute("UPDATE deploy.services SET description = $2 WHERE id = $1", [id, s.description]);
      // DP-74: the deployments of team 1's applications are inserted with team 1's service, the other team's with its own.
      for (const q of f.deployments.filter((d) => f.applications.find((a) => a.id === d.application)!.team === s.team)) {
        await tx.execute(
          `INSERT INTO deploy.application_deployment_queues (id, deployment_uuid, application_id, status, commit, server_id, destination_id, application_name, server_name, logs, created_at, updated_at, finished_at, org_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13)`,
          [q.id, q.uuid, String(q.application), q.status, q.commit, q.server_id, String(q.destination_id), q.application_name, q.server_name, q.logs, q.created_at, q.finished_at, org(s.team)],
        );
      }
      for (const v of f.serviceVariables.filter((x) => x.service === s.id && x.is_shown_once)) await tx.execute("UPDATE deploy.environment_variables SET is_shown_once = true WHERE uuid = $1", [v.uuid]);
    });
  }
  // DP-81: the tags in id order (insertTag(), so the identity gives the fixture's ids), then the pivot rows in the fixture's order.
  const MORPH = { application: APPLICATION_MORPH_CLASS, redis: DATABASE_TABLES.redis.morphClass, service: SERVICE_MORPH_CLASS } as const;
  for (const t of f.tags) {
    await withOrg(db, org(t.team), async (tx) => {
      const row = await insertTag(tx, { orgId: org(t.team), uuid: t.uuid, name: t.name });
      await tx.execute("UPDATE deploy.tags SET created_at = $2, updated_at = $2 WHERE id = $1", [row.id, t.created_at]);
    });
  }
  for (const p of f.taggables) {
    const team = f.tags.find((t) => t.id === p.tag)!.team;
    await withOrg(db, org(team), (tx) => attachTag(tx, org(team), { type: MORPH[p.type], id: p.id }, p.tag));
  }
  // DP-81: the shared variables of projects and environments, in id order (the identity gives the fixture's ids).
  for (const v of f.sharedVariables) {
    await withOrg(db, org(v.team), async (tx) => {
      const owner = v.type === "project" ? { type: "project" as const, id: v.project_id } : { type: "environment" as const, id: v.environment_id };
      const row = await insertSharedVariable(tx, { orgId: org(v.team), owner, key: v.key, value: await encrypt(tx, v.team, "shared_environment_variables.value", v.value), comment: v.comment, isLiteral: v.is_literal, isMultiline: v.is_multiline, isShownOnce: v.is_shown_once });
      if (Number(row.id) !== v.id) throw new Error(`shared variable ${v.key}: id ${row.id}, not ${v.id}`);
    });
  }
  // DP-84: the teams' own shared variables, the storages, the scheduled tasks and their executions, each table in id order
  // (the identity gives the fixture's ids, which are checked).
  const same = (what: string, id: unknown, expected: number) => {
    if (Number(id) !== expected) throw new Error(`${what}: id ${String(id)}, not ${expected}`);
  };
  for (const v of f.teamVariables) {
    await withOrg(db, org(v.team), async (tx) => {
      const row = await insertSharedVariable(tx, { orgId: org(v.team), owner: { type: "team", id: null }, key: v.key, value: await encrypt(tx, v.team, "shared_environment_variables.value", v.value), comment: v.comment, isLiteral: v.is_literal, isMultiline: v.is_multiline, isShownOnce: v.is_shown_once });
      same(`team variable ${v.key}`, row.id, v.id);
    });
  }
  const STORAGE_OWNER = { application: APPLICATION_MORPH_CLASS, postgresql: DATABASE_TABLES.postgresql.morphClass, serviceApplication: SERVICE_PART_MORPH_CLASS.application } as const;
  const teamOfStorage = (resource: keyof typeof STORAGE_OWNER, id: number) => (resource === "application" ? f.applications.find((a) => a.id === id)!.team : resource === "postgresql" ? f.databases.find((d) => d.engine === "postgresql" && d.id === id)!.team : f.services.find((s) => s.id === f.serviceApplications.find((a) => a.id === id)!.service)!.team);
  for (const v of f.persistentStorages) {
    const team = teamOfStorage(v.resource, v.resource_id);
    await withOrg(db, org(team), async (tx) => {
      const row = await insertPersistentVolume(tx, { orgId: org(team), owner: { type: STORAGE_OWNER[v.resource], id: v.resource_id }, uuid: v.uuid, name: v.name, mountPath: v.mount_path, hostPath: null });
      same(`volume ${v.name}`, row.id, v.id);
    });
  }
  for (const s of f.fileStorages) {
    const team = teamOfStorage(s.resource, s.resource_id);
    await withOrg(db, org(team), async (tx) => {
      const content = s.content === null ? null : await encrypt(tx, team, "local_file_volumes.content", s.content);
      const row = await insertFileVolume(tx, { orgId: org(team), owner: { type: STORAGE_OWNER[s.resource], id: s.resource_id }, uuid: s.uuid, fsPath: s.fs_path, mountPath: s.mount_path, content, isDirectory: s.is_directory, isHostFile: s.is_host_file });
      same(`file ${s.mount_path}`, row.id, s.id);
    });
  }
  for (const t of f.scheduledTasks) {
    await withOrg(db, org(t.team), async (tx) => {
      const owner = t.application_id !== null ? { kind: "application" as const, id: t.application_id } : { kind: "service" as const, id: t.service_id! };
      const row = await insertScheduledTask(tx, { orgId: org(t.team), owner, uuid: t.uuid, name: t.name, command: t.command, frequency: t.frequency, container: t.container, timeout: t.timeout, useShell: t.use_shell, enabled: t.enabled });
      same(`task ${t.name}`, row.id, t.id);
      await tx.execute("UPDATE deploy.scheduled_tasks SET created_at = $2, updated_at = $2 WHERE id = $1", [row.id, t.created_at]);
    });
  }
  for (const x of f.scheduledTaskExecutions) {
    const team = f.scheduledTasks.find((t) => t.id === x.task)!.team;
    await withOrg(db, org(team), async (tx) => {
      await tx.execute(
        `INSERT INTO deploy.scheduled_task_executions (id, uuid, scheduled_task_id, status, message, started_at, finished_at, duration, retry_count, created_at, updated_at, org_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11)`,
        [x.id, x.uuid, x.task, x.status, x.message, x.started_at, x.finished_at, x.duration, x.retry_count, x.created_at, org(team)],
      );
    });
  }
  // DP-85: a server's Docker cleanup runs.
  for (const x of f.dockerCleanupExecutions) {
    const team = f.servers.find((s) => s.id === x.server_id)!.team;
    await withOrg(db, org(team), (tx) =>
      tx.execute(
        `INSERT INTO deploy.docker_cleanup_executions (id, uuid, server_id, status, message, created_at, updated_at, finished_at, org_id) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)`,
        [x.id, x.uuid, x.server_id, x.status, x.message, x.created_at, x.finished_at, org(team)],
      ),
    );
  }
  // DP-85: the six notification channels' rows, team 1's first (Team's created hook made them in Coolify, so team 1's are id 1).
  for (const team of [1, 2]) {
    await withOrg(db, org(team), async (tx) => {
      for (const channel of NOTIFICATION_CHANNELS) same(`${channel} settings`, (await ensureNotificationSettings(tx, channel, org(team))).id, team);
    });
  }
  // DP-86: the applications' previews (Coolify's saving hook moves a domain's port to domain_port_overrides, and sets
  // last_online_at to the clock's now as the status is set).
  for (const p of f.previews) {
    const team = f.applications.find((a) => a.id === p.application)!.team;
    const domain = normalizeDomainPortOverrides(p.fqdn, null);
    await withOrg(db, org(team), (tx) =>
      tx.execute(
        `INSERT INTO deploy.application_previews (id, uuid, application_id, pull_request_id, pull_request_html_url, git_type, fqdn, domain_port_overrides, docker_registry_image_tag, status, last_online_at, created_at, updated_at, org_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::json, $9, $10, '2026-01-01 00:00:00', $11, $11, $12)`,
        [p.id, p.uuid, p.application, p.pull_request_id, p.pull_request_html_url, p.git_type, domain.fqdn, domain.overrides === null ? null : JSON.stringify(domain.overrides), p.docker_registry_image_tag, p.status, p.created_at, org(team)],
      ),
    );
  }
  await db.execute("SELECT setval(pg_get_serial_sequence('deploy.application_previews', 'id'), $1)", [Math.max(...f.previews.map((p) => p.id))]);
  // DP-90: the cloud provider tokens, encrypted with the org's key as the console stores them.
  for (const t of f.cloudTokens) {
    await withOrg(db, org(t.team), async (tx) =>
      tx.execute(
        `INSERT INTO deploy.cloud_provider_tokens (id, uuid, provider, token, name, description, org_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
        [t.id, t.uuid, t.provider, await encrypt(tx, t.team, "cloud_provider_tokens.token", t.token), t.name, t.description, org(t.team)],
      ),
    );
  }
  await db.execute("SELECT setval(pg_get_serial_sequence('deploy.cloud_provider_tokens', 'id'), $1)", [Math.max(...f.cloudTokens.map((t) => t.id))]);
  // DP-104: the integration tokens (the token encrypted with the org's key, the JSON columns as Coolify's casts write them)
  // and the Cloudflare tokens' zones.
  for (const t of f.integrationTokens) {
    await withOrg(db, org(t.team), async (tx) =>
      tx.execute(
        `INSERT INTO deploy.integration_tokens (id, uuid, provider, name, token, capabilities, metadata, org_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6::json, $7::json, $8, $9, $9)`,
        [t.id, t.uuid, t.provider, t.name, await encrypt(tx, t.team, "integration_tokens.token", t.token), JSON.stringify(t.capabilities), t.metadata === null ? null : JSON.stringify(t.metadata), org(t.team), t.created_at],
      ),
    );
  }
  await db.execute("SELECT setval(pg_get_serial_sequence('deploy.integration_tokens', 'id'), $1)", [Math.max(...f.integrationTokens.map((t) => t.id))]);
  for (const z of f.dnsZones) {
    const team = f.integrationTokens.find((t) => t.id === z.token)!.team;
    await withOrg(db, org(team), (tx) =>
      tx.execute(
        `INSERT INTO deploy.dns_provider_zones (id, uuid, integration_token_id, provider_zone_id, name, account_id, account_name, org_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [z.id, z.uuid, z.token, z.provider_zone_id, z.name, z.account_id, z.account_name, org(team), z.created_at],
      ),
    );
  }
  await db.execute("SELECT setval(pg_get_serial_sequence('deploy.dns_provider_zones', 'id'), $1)", [Math.max(...f.dnsZones.map((z) => z.id))]);
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
