// Writes cases.json: the fixture and the requests emit.php sends to Coolify's /api/v1 and
// tests/deploy-core-worker/src/api-v1.test.ts replays against Freeploy's (see README.md).
//
//   node cases.mjs > cases.json
import { readFileSync } from "node:fs";

const T1 = 1; // the fixture's team ("Parity Team")
const T2 = 2; // another team, which the tokens of team 1 must never see

const P_ALPHA = "p1alphaprojectuuid000001";
const P_BETA = "p2betaprojectuuid0000002";
const P_OTHER = "p3otherprojectuuid000003";
const E_PROD = "e1alphaproduction0000001";
const E_STAGING = "e2alphastaging0000000002";
const E_BETA = "e3betaproduction00000003";
const E_OTHER = "e4otherproduction0000004";
const K_MAIN = "k1parityprivatekey000001";
const K_FREE = "k2unusedprivatekey000002";
const K_OTHER = "k3otherteamkey0000000003";
const S_MAIN = "s1parityserveruuid000001";
const S_OTHER = "s2otherteamserver0000002";
const D_MAIN = "d1paritydestination00001";
const D_OTHER = "d2otherdestination000002";
const A_IMAGE = "a1parityimageapp00000001";
const A_GIT = "a2paritygitapp0000000002";
const A_OTHER = "a3otherteamapp0000000003";
const V_FOO = "v1parityfoovariable00001";
const V_SECRET = "v2paritysecretvariable02";
const V_MULTI = "v3paritymultilinevar0003";
const V_OTHER = "v4otherteamvariable00004";
// DP-73: the eight standalone engines, their backup schedules, two executions and an S3 storage per team.
const DB_PG = "b1paritypostgres00000001";
const DB_REDIS = "b2parityredis00000000002";
const DB_MONGO = "b3paritymongodb000000003";
const DB_MYSQL = "b4paritymysql00000000004";
const DB_MARIA = "b5paritymariadb000000005";
const DB_KEYDB = "b6paritykeydb00000000006";
const DB_DRAGONFLY = "b7paritydragonfly0000007";
const DB_CLICKHOUSE = "b8parityclickhouse000008";
const DB_OTHER = "b9otherpostgres000000009";
const BK_PG = "c1paritypgbackup00000001";
const BK_PG_S3 = "c2paritypgs3backup000002";
const BK_MYSQL = "c3paritymysqlbackup00003";
const BK_OTHER = "c4otherpgbackup000000004";
const EX_OK = "x1parityexecutionok00001";
const EX_FAIL = "x2parityexecfailed000002";
const S3_MAIN = "s3paritystorage000000001";
const S3_OTHER = "s4otherstorage0000000002";
// DP-74: a service per team (its Compose file, an application and a database, its variables).
const SV_MAIN = "f1parityservice000000001";
const SV_OTHER = "f2otherservice0000000002";
const SA_WEB = "g1paritywebapplication01";
const SA_OTHER = "g2otherwebapplication002";
const SD_DB = "h1paritydatabase00000001";
const SV_V_FOO = "w1parityservicefoo000001";
const SV_V_PASS = "w2parityservicepass00002";
const SV_V_OTHER = "w3otherservicevar0000003";
const SERVICE_COMPOSE = "services:\n  web:\n    image: 'nginx:alpine'\n    environment:\n      - 'FOO=${FOO:-bar}'\n  db:\n    image: 'postgres:16-alpine'\n    environment:\n      - 'POSTGRES_PASSWORD=${DB_PASSWORD}'\n";
// DP-74: deployments of the applications.
const DQ_RUNNING = "q1parityinprogress000001";
const DQ_QUEUED = "q2parityqueued0000000002";
const DQ_FINISHED = "q3parityfinished00000003";
const DQ_OTHER = "q4otherinprogress0000004";
const DQ_FAILED = "q5paritygitfailed0000005";
// DP-81: the teams' tags, attached to an application, a database and a service.
const TG_BACKEND = "t1paritybackendtag000001";
const TG_FRONTEND = "t2parityfrontendtag00002";
const TG_UNUSED = "t3parityunusedtag0000003";
const TG_OTHER = "t4otherteamtag0000000004";
/** The fixture's last tag id: the tags a write made come after it. */
const FIXTURE_TAGS = 4;
// DP-84: the storages of an application, a database and a service's application; scheduled tasks and their executions;
// the team's shared variables.
const PV_APP = "l1parityappvolume0000001";
const PV_SERVICE = "l2parityservicevolume002";
const PV_OTHER = "l3otherappvolume00000003";
const FV_CONFIG = "m1parityappconfigfile001";
const FV_HOST = "m2parityhostfile00000002";
const FV_DIR = "m3paritydirectory0000003";
const FV_PG = "m4paritypgfile0000000004";
const FV_SERVICE = "m5parityservicefile00005";
const FV_OTHER = "m6otherappfile0000000006";
const ST_BACKUP = "n1paritybackuptask000001";
const ST_CLEANUP = "n2paritycleanuptask00002";
const ST_SERVICE = "n3parityservicetask00003";
const ST_OTHER = "n4otherteamtask000000004";
const SX_OK = "o1paritytaskrunok0000001";
const SX_FAIL = "o2paritytaskfailed000002";
const SX_OTHER = "o3otherteamtaskrun000003";
/** A deployment's logs column: one line as ApplicationDeploymentQueue::addLogEntry() writes it. */
const deploymentLog = (output) => JSON.stringify([{ command: null, output, type: "stdout", timestamp: "2025-12-30T10:00:01.000000Z", hidden: false, batch: 1, order: 1 }]);
/** The file the parser generated (fixed text; a locked variable's value in it is redacted for the API). */
const SERVICE_GENERATED = "services:\n  web:\n    image: 'nginx:alpine'\n    environment:\n      FOO: bar\n  db:\n    image: 'postgres:16-alpine'\n    environment:\n      POSTGRES_PASSWORD: dbSecretPass1\n";
/** Fixed manual webhook secrets (Coolify's creating hook makes random ones; both sides are given these). */
const webhookSecrets = (prefix) => Object.fromEntries(["github", "gitlab", "bitbucket", "gitea"].map((p) => [`manual_webhook_secret_${p}`, `${prefix}${p}`.padEnd(40, "x")]));
// DP-86: previews of the applications.
const R_IMAGE = "r1parityimagepreview0001";
const R_GIT_17 = "r2paritygitpreview000002";
const R_GIT_12 = "r3paritygitpreview000003";
const R_OTHER = "r4otherpreview0000000004";

const fixture = {
  teams: [
    { id: T1, name: "Parity Team", description: null, personal_team: false },
    { id: T2, name: "Other Team", description: "Not yours", personal_team: false },
  ],
  users: [
    { id: 1, name: "Parity Owner", email: "owner@example.com", teams: [{ team: T1, role: "owner" }] },
    { id: 2, name: "Parity Member", email: "member@example.com", teams: [{ team: T1, role: "member" }] },
    { id: 3, name: "Other Owner", email: "other@example.com", teams: [{ team: T2, role: "owner" }] },
    { id: 4, name: "Parity Admin", email: "admin@example.com", teams: [{ team: T1, role: "admin" }] },
  ],
  projects: [
    { id: 1, uuid: P_ALPHA, name: "Alpha", description: "The first project", team: T1, environments: [
      { id: 1, uuid: E_PROD, name: "production", description: null },
      { id: 2, uuid: E_STAGING, name: "staging", description: "Before production" },
    ] },
    { id: 2, uuid: P_BETA, name: "Beta", description: null, team: T1, environments: [{ id: 3, uuid: E_BETA, name: "production", description: null }] },
    { id: 3, uuid: P_OTHER, name: "Other", description: null, team: T2, environments: [{ id: 4, uuid: E_OTHER, name: "production", description: null }] },
  ],
  privateKeys: [
    { id: 1, uuid: K_MAIN, name: "Parity Key", description: "The fixture's key", file: "../ssh-keys/ed25519.openssh", team: T1 },
    { id: 2, uuid: K_FREE, name: "Unused Key", description: null, file: "../ssh-keys/ecdsa256.openssh", team: T1 },
    { id: 3, uuid: K_OTHER, name: "Other Key", description: null, file: "../ssh-keys/rsa2048.openssh", team: T2 },
  ],
  servers: [
    { id: 1, uuid: S_MAIN, name: "parity-server", description: "The fixture server", ip: "203.0.113.10", user: "root", port: 22, team: T1, private_key_id: 1 },
    { id: 2, uuid: S_OTHER, name: "other-server", description: null, ip: "203.0.113.20", user: "root", port: 22, team: T2, private_key_id: 3 },
  ],
  // The default destination each server's created hook makes (Coolify gives it a random uuid; the fixture fixes it).
  destinations: [
    { id: 1, uuid: D_MAIN, server_id: 1 },
    { id: 2, uuid: D_OTHER, server_id: 2 },
  ],
  // Applications as Freeploy's creation stores them (insertDockerImageApplication, insertBuiltApplication); Coolify's
  // fixture saves the same columns through its model, so its creating and created hooks run (the settings row, Nixpacks'
  // NIXPACKS_NODE_VERSION).
  applications: [
    { id: 1, uuid: A_IMAGE, team: T1, environment_id: 1, destination_id: 1, name: "parity-image", fqdn: "https://image.example.com",
      columns: { repository_project_id: 0, git_repository: "coollabsio/coolify", git_branch: "main", build_pack: "dockerimage", ports_exposes: "80", docker_registry_image_name: "nginx", docker_registry_image_tag: "alpine", health_check_enabled: false, ...webhookSecrets("image") } },
    { id: 2, uuid: A_GIT, team: T1, environment_id: 1, destination_id: 1, name: "parity-git", fqdn: null,
      columns: { git_repository: "coollabsio/coolify-examples", git_branch: "main", build_pack: "nixpacks", ports_exposes: "3000", base_directory: "/", source_id: 0, source_type: "App\\Models\\GithubApp", ...webhookSecrets("git") } },
    { id: 3, uuid: A_OTHER, team: T2, environment_id: 4, destination_id: 2, name: "other-image", fqdn: null,
      columns: { repository_project_id: 0, git_repository: "coollabsio/coolify", git_branch: "main", build_pack: "dockerimage", ports_exposes: "80", docker_registry_image_name: "redis", docker_registry_image_tag: "7", health_check_enabled: false, ...webhookSecrets("other") } },
  ],
  // Variables made through the model (EnvironmentVariable::create(), whose created hook adds an application's preview copy).
  variables: [
    { uuid: V_FOO, application: 1, key: "FOO", value: "bar", is_literal: false, is_multiline: false, is_shown_once: false, is_runtime: true, is_buildtime: true, comment: null },
    { uuid: V_SECRET, application: 1, key: "SECRET_TOKEN", value: "s3cr3t-value", is_literal: true, is_multiline: false, is_shown_once: true, is_runtime: true, is_buildtime: false, comment: "Shown once" },
    { uuid: V_MULTI, application: 1, key: "MULTI", value: "line one\nline two", is_literal: false, is_multiline: true, is_shown_once: false, is_runtime: false, is_buildtime: true, comment: null },
    { uuid: V_OTHER, application: 3, key: "OTHER", value: "theirs", is_literal: false, is_multiline: false, is_shown_once: false, is_runtime: true, is_buildtime: true, comment: null },
  ],
  // DP-73: an S3 storage per team (S3Storage::forceCreate(); the credentials are encrypted as the cast does).
  s3Storages: [
    { id: 1, uuid: S3_MAIN, team: T1, name: "Parity S3", description: null, region: "us-east-1", key: "AKIAPARITYKEY", secret: "parity-s3-secret", bucket: "parity-backups", endpoint: "https://s3.example.com", is_usable: true },
    { id: 2, uuid: S3_OTHER, team: T2, name: "Other S3", description: null, region: "us-east-1", key: "AKIAOTHERKEY", secret: "other-s3-secret", bucket: "other-backups", endpoint: "https://s3.example.com", is_usable: true },
  ],
  // Databases made by Coolify's create_standalone_<engine>() helpers with these attributes filled (so the created hook
  // makes the data volumes and Redis gets its two variables); Freeploy's by insertDatabase() with the same columns.
  databases: [
    { engine: "postgresql", id: 1, uuid: DB_PG, team: T1, environment_id: 1, destination_id: 1, name: "parity-postgres", columns: { description: "The fixture's PostgreSQL", image: "postgres:16-alpine", postgres_password: "pgSecretPass1", postgres_db: "parity", is_public: true, public_port: 5433 } },
    { engine: "redis", id: 1, uuid: DB_REDIS, team: T1, environment_id: 1, destination_id: 1, name: "parity-redis", columns: { image: "redis:7.2", redis_password: "redisSecretPass1" } },
    { engine: "mongodb", id: 1, uuid: DB_MONGO, team: T1, environment_id: 1, destination_id: 1, name: "parity-mongodb", columns: { image: "mongo:7", mongo_initdb_root_password: "mongoSecretPass1" } },
    { engine: "mysql", id: 1, uuid: DB_MYSQL, team: T1, environment_id: 1, destination_id: 1, name: "parity-mysql", columns: { image: "mysql:8", mysql_root_password: "mysqlRootPass1", mysql_password: "mysqlUserPass1" } },
    { engine: "mariadb", id: 1, uuid: DB_MARIA, team: T1, environment_id: 1, destination_id: 1, name: "parity-mariadb", columns: { image: "mariadb:11", mariadb_root_password: "mariaRootPass1", mariadb_password: "mariaUserPass1" } },
    { engine: "keydb", id: 1, uuid: DB_KEYDB, team: T1, environment_id: 1, destination_id: 1, name: "parity-keydb", columns: { image: "eqalpha/keydb:latest", keydb_password: "keydbSecretPass1" } },
    { engine: "dragonfly", id: 1, uuid: DB_DRAGONFLY, team: T1, environment_id: 1, destination_id: 1, name: "parity-dragonfly", columns: { image: "docker.dragonflydb.io/dragonflydb/dragonfly", dragonfly_password: "dragonflySecretPass1" } },
    { engine: "clickhouse", id: 1, uuid: DB_CLICKHOUSE, team: T1, environment_id: 1, destination_id: 1, name: "parity-clickhouse", columns: { image: "clickhouse/clickhouse-server:25.11", clickhouse_admin_password: "clickhouseSecretPass1" } },
    { engine: "postgresql", id: 2, uuid: DB_OTHER, team: T2, environment_id: 4, destination_id: 2, name: "other-postgres", columns: { image: "postgres:16-alpine", postgres_password: "otherPgPass1" } },
  ],
  // Backup schedules (ScheduledDatabaseBackup::forceCreate() with the team; created_at fixed so that their order is).
  backups: [
    { id: 1, uuid: BK_PG, team: T1, engine: "postgresql", database_id: 1, frequency: "0 0 * * *", save_s3: false, s3: [], databases_to_backup: "parity", created_at: "2025-12-01 00:00:00" },
    { id: 2, uuid: BK_PG_S3, team: T1, engine: "postgresql", database_id: 1, frequency: "@weekly", save_s3: true, s3: [1], databases_to_backup: null, created_at: "2025-12-02 00:00:00" },
    { id: 3, uuid: BK_MYSQL, team: T1, engine: "mysql", database_id: 1, frequency: "30 2 * * *", save_s3: false, s3: [], databases_to_backup: null, created_at: "2025-12-03 00:00:00" },
    { id: 4, uuid: BK_OTHER, team: T2, engine: "postgresql", database_id: 2, frequency: "0 0 * * *", save_s3: false, s3: [], databases_to_backup: null, created_at: "2025-12-04 00:00:00" },
  ],
  // Executions of the first schedule (forceCreate(); the created hook writes the schedule's last_execution_at).
  executions: [
    { id: 1, uuid: EX_OK, backup: 1, status: "success", message: "Backup of parity done.", size: 2048, filename: "/data/coolify/backups/databases/parity-team-1/parity-postgres-b1paritypostgres00000001/pg-dump-parity-1767052800.dmp", database_name: "parity", created_at: "2025-12-30 00:00:00", finished_at: "2025-12-30 00:01:00" },
    { id: 2, uuid: EX_FAIL, backup: 1, status: "failed", message: "pg_dump: error: connection to parity failed: password pgSecretPass1 was refused", size: null, filename: null, database_name: "parity", created_at: "2025-12-31 00:00:00", finished_at: "2025-12-31 00:00:05" },
  ],
  // DP-74: services made with forceCreate() and fixed columns (Coolify's parser would make random uuids), their parts and
  // their variables (EnvironmentVariable::create() on the service).
  services: [
    { id: 1, uuid: SV_MAIN, team: T1, environment_id: 1, server_id: 1, destination_id: 1, name: "parity-service", description: "The fixture's service", docker_compose_raw: SERVICE_COMPOSE, docker_compose: SERVICE_GENERATED, service_type: null },
    { id: 2, uuid: SV_OTHER, team: T2, environment_id: 4, server_id: 2, destination_id: 2, name: "other-service", description: null, docker_compose_raw: "services:\n  web:\n    image: 'nginx:alpine'\n", docker_compose: null, service_type: null },
  ],
  serviceApplications: [
    { id: 1, uuid: SA_WEB, service: 1, name: "web", image: "nginx:alpine", fqdn: "https://web.example.com" },
    { id: 2, uuid: SA_OTHER, service: 2, name: "web", image: "nginx:alpine", fqdn: null },
  ],
  serviceDatabases: [{ id: 1, uuid: SD_DB, service: 1, name: "db", image: "postgres:16-alpine" }],
  serviceVariables: [
    { uuid: SV_V_FOO, service: 1, key: "FOO", value: "bar", is_shown_once: false, comment: null },
    { uuid: SV_V_PASS, service: 1, key: "DB_PASSWORD", value: "dbSecretPass1", is_shown_once: true, comment: "Locked" },
    { uuid: SV_V_OTHER, service: 2, key: "OTHER_SERVICE", value: "theirs", is_shown_once: false, comment: null },
  ],
  // DP-74: deployments in the queue (ApplicationDeploymentQueue::forceCreate(); application_id is a string column).
  deployments: [
    { id: 1, uuid: DQ_RUNNING, application: 1, status: "in_progress", commit: "HEAD", server_id: 1, destination_id: 1, application_name: "parity-image", server_name: "parity-server", logs: deploymentLog("Pulling nginx:alpine."), created_at: "2025-12-31 10:00:00", finished_at: null },
    { id: 2, uuid: DQ_QUEUED, application: 1, status: "queued", commit: "HEAD", server_id: 1, destination_id: 1, application_name: "parity-image", server_name: "parity-server", logs: null, created_at: "2025-12-31 11:00:00", finished_at: null },
    { id: 3, uuid: DQ_FINISHED, application: 1, status: "finished", commit: "HEAD", server_id: 1, destination_id: 1, application_name: "parity-image", server_name: "parity-server", logs: deploymentLog("Deployment finished."), created_at: "2025-12-30 10:00:00", finished_at: "2025-12-30 10:05:00" },
    { id: 4, uuid: DQ_OTHER, application: 3, status: "in_progress", commit: "HEAD", server_id: 2, destination_id: 2, application_name: "other-image", server_name: "other-server", logs: null, created_at: "2025-12-31 12:00:00", finished_at: null },
    { id: 5, uuid: DQ_FAILED, application: 2, status: "failed", commit: "a1b2c3d", server_id: 1, destination_id: 1, application_name: "parity-git", server_name: "parity-server", logs: deploymentLog("Build failed."), created_at: "2025-12-29 10:00:00", finished_at: "2025-12-29 10:01:00" },
  ],
  // DP-81: tags (Tag::forceCreate() with the team, created_at fixed) and what they are attached to (the taggables pivot,
  // in this order).
  tags: [
    { id: 1, uuid: TG_BACKEND, team: T1, name: "backend", created_at: "2025-12-01 00:00:00" },
    { id: 2, uuid: TG_FRONTEND, team: T1, name: "frontend", created_at: "2025-12-02 00:00:00" },
    { id: 3, uuid: TG_UNUSED, team: T1, name: "unused", created_at: "2025-12-03 00:00:00" },
    { id: 4, uuid: TG_OTHER, team: T2, name: "theirs", created_at: "2025-12-04 00:00:00" },
  ],
  taggables: [
    { tag: 1, type: "application", id: 1 },
    { tag: 2, type: "application", id: 1 },
    { tag: 1, type: "redis", id: 1 },
    { tag: 2, type: "service", id: 1 },
    { tag: 4, type: "application", id: 3 },
  ],
  // DP-81: shared variables of projects and environments (SharedEnvironmentVariable::create(), the value encrypted by the
  // cast). Their ids follow the four each server's created hook makes (COOLIFY_SERVER_UUID and COOLIFY_SERVER_NAME).
  sharedVariables: [
    { id: 5, team: T1, type: "project", project_id: 1, environment_id: null, key: "PROJECT_FOO", value: "project-bar", is_literal: false, is_multiline: false, is_shown_once: false, comment: null },
    { id: 6, team: T1, type: "project", project_id: 1, environment_id: null, key: "PROJECT_SECRET", value: "p-secret", is_literal: false, is_multiline: false, is_shown_once: true, comment: "Locked" },
    { id: 7, team: T1, type: "environment", project_id: null, environment_id: 1, key: "ENV_FOO", value: "env-bar", is_literal: true, is_multiline: false, is_shown_once: false, comment: null },
    { id: 8, team: T2, type: "project", project_id: 3, environment_id: null, key: "OTHER_PROJECT", value: "theirs", is_literal: false, is_multiline: false, is_shown_once: false, comment: null },
    { id: 9, team: T1, type: "environment", project_id: null, environment_id: 2, key: "STAGING_ONLY", value: "line one\nline two", is_literal: false, is_multiline: true, is_shown_once: false, comment: "Two lines" },
  ],
  // DP-84: storages (LocalPersistentVolume and LocalFileVolume::forceCreate(): the mutators and the encrypted content; the
  // file's created hook queues its job, which emit.php fakes). The persistent ids follow the databases' data volumes (2–11).
  persistentStorages: [
    { id: 12, uuid: PV_APP, name: `${A_IMAGE}-data`, mount_path: "/data", resource: "application", resource_id: 1 },
    { id: 13, uuid: PV_SERVICE, name: `${SV_MAIN}_web-html`, mount_path: "/usr/share/nginx/html", resource: "serviceApplication", resource_id: 1 },
    { id: 14, uuid: PV_OTHER, name: `${A_OTHER}-data`, mount_path: "/data", resource: "application", resource_id: 3 },
  ],
  fileStorages: [
    { id: 1, uuid: FV_CONFIG, fs_path: `/data/coolify/applications/${A_IMAGE}/config.json`, mount_path: "/app/config.json", content: '{"debug":false}', is_directory: false, is_host_file: false, resource: "application", resource_id: 1 },
    { id: 2, uuid: FV_HOST, fs_path: "/etc/timezone", mount_path: "/etc/timezone", content: null, is_directory: false, is_host_file: true, resource: "application", resource_id: 1 },
    { id: 3, uuid: FV_DIR, fs_path: "/srv/shared", mount_path: "/shared", content: null, is_directory: true, is_host_file: false, resource: "application", resource_id: 1 },
    { id: 4, uuid: FV_PG, fs_path: `/data/coolify/databases/${DB_PG}/init.sql`, mount_path: "/docker-entrypoint-initdb.d/init.sql", content: "select 1;", is_directory: false, is_host_file: false, resource: "postgresql", resource_id: 1 },
    { id: 5, uuid: FV_SERVICE, fs_path: `/data/coolify/services/${SV_MAIN}/default.conf`, mount_path: "/etc/nginx/conf.d/default.conf", content: "server { listen 80; }", is_directory: false, is_host_file: false, resource: "serviceApplication", resource_id: 1 },
    { id: 6, uuid: FV_OTHER, fs_path: "/etc/localtime", mount_path: "/etc/localtime", content: null, is_directory: false, is_host_file: true, resource: "application", resource_id: 3 },
  ],
  // DP-84: scheduled tasks (ScheduledTask::forceCreate() with the team) and executions (forceCreate(); the creating hook's
  // worker_host is hidden).
  scheduledTasks: [
    { id: 1, uuid: ST_BACKUP, team: T1, application_id: 1, service_id: null, name: "backup", command: "php artisan backup:run", frequency: "0 3 * * *", container: null, timeout: 300, use_shell: true, enabled: true, created_at: "2025-12-01 00:00:00" },
    { id: 2, uuid: ST_CLEANUP, team: T1, application_id: 1, service_id: null, name: "cleanup", command: "rm -rf /tmp/cache", frequency: "@daily", container: "app", timeout: 60, use_shell: false, enabled: false, created_at: "2025-12-02 00:00:00" },
    { id: 3, uuid: ST_SERVICE, team: T1, application_id: null, service_id: 1, name: "vacuum", command: "vacuumdb --all", frequency: "*/30 * * * *", container: "db", timeout: 600, use_shell: true, enabled: true, created_at: "2025-12-03 00:00:00" },
    { id: 4, uuid: ST_OTHER, team: T2, application_id: 3, service_id: null, name: "theirs", command: "echo theirs", frequency: "@hourly", container: null, timeout: 300, use_shell: true, enabled: true, created_at: "2025-12-04 00:00:00" },
  ],
  scheduledTaskExecutions: [
    { id: 1, uuid: SX_OK, task: 1, status: "success", message: "Backup done.", started_at: "2025-12-30 03:00:00", finished_at: "2025-12-30 03:00:02", duration: 1.25, retry_count: 0, created_at: "2025-12-30 03:00:00" },
    { id: 2, uuid: SX_FAIL, task: 1, status: "failed", message: "Error: could not reach s3cr3t-host", started_at: "2025-12-31 03:00:00", finished_at: "2025-12-31 03:00:05", duration: 5.5, retry_count: 2, created_at: "2025-12-31 03:00:00" },
    { id: 3, uuid: SX_OTHER, task: 4, status: "success", message: "theirs", started_at: "2025-12-31 04:00:00", finished_at: "2025-12-31 04:00:01", duration: 0.5, retry_count: 0, created_at: "2025-12-31 04:00:00" },
  ],
  // DP-84: the teams' own shared variables (type team), after DP-81's.
  teamVariables: [
    { id: 10, team: T1, key: "TEAM_FOO", value: "team-bar", is_literal: false, is_multiline: false, is_shown_once: false, comment: null },
    { id: 11, team: T1, key: "TEAM_SECRET", value: "t-secret", is_literal: true, is_multiline: false, is_shown_once: true, comment: "Locked" },
    { id: 12, team: T2, key: "OTHER_TEAM", value: "theirs", is_literal: false, is_multiline: false, is_shown_once: false, comment: null },
  ],
  // DP-85: a server's Docker cleanup runs (DockerCleanupExecution::forceCreate(), the timestamps fixed).
  dockerCleanupExecutions: [
    { id: 1, uuid: "y1paritycleanupok0000001", server_id: 1, status: "success", message: "Removed 3 images.", created_at: "2025-12-30 01:00:00", finished_at: "2025-12-30 01:00:30" },
    { id: 2, uuid: "y2paritycleanupfailed002", server_id: 1, status: "failed", message: "Error: docker system prune failed", created_at: "2025-12-31 01:00:00", finished_at: "2025-12-31 01:00:05" },
    { id: 3, uuid: "y3othercleanup0000000003", server_id: 2, status: "running", message: null, created_at: "2025-12-31 02:00:00", finished_at: null },
  ],
  // DP-86: previews of the applications (ApplicationPreview::forceCreate(): the saving hook normalizes the domain; the
  // timestamps and last_online_at fixed).
  previews: [
    { id: 1, uuid: R_IMAGE, application: 1, pull_request_id: 3, pull_request_html_url: "", git_type: null, fqdn: "https://3.image.example.com", docker_registry_image_tag: "pr-3", status: "running:healthy", created_at: "2025-12-20 00:00:00" },
    { id: 2, uuid: R_GIT_17, application: 2, pull_request_id: 17, pull_request_html_url: "https://github.com/coollabsio/coolify-examples/pull/17", git_type: "github", fqdn: null, docker_registry_image_tag: null, status: "exited", created_at: "2025-12-21 00:00:00" },
    { id: 3, uuid: R_GIT_12, application: 2, pull_request_id: 12, pull_request_html_url: "https://github.com/coollabsio/coolify-examples/pull/12", git_type: "github", fqdn: "https://pr-12.example.com:8080", docker_registry_image_tag: null, status: "exited", created_at: "2025-12-22 00:00:00" },
    { id: 4, uuid: R_OTHER, application: 3, pull_request_id: 1, pull_request_html_url: "", git_type: null, fqdn: null, docker_registry_image_tag: "pr-1", status: "exited", created_at: "2025-12-23 00:00:00" },
  ],
  // secret: what follows "<id>|" in the bearer token (Sanctum's 40 random characters and crc32b).
  tokens: [
    { key: "root", id: 1, user: 1, team: T1, name: "Root token", abilities: ["root"], secret: "rootrootrootrootrootrootrootrootrootroot5a1b2c3d" },
    { key: "read", id: 2, user: 1, team: T1, name: "Read token", abilities: ["read"], secret: "readreadreadreadreadreadreadreadreadread0a1b2c3d" },
    { key: "sensitive", id: 3, user: 1, team: T1, name: "Sensitive token", abilities: ["read", "read:sensitive"], secret: "senssenssenssenssenssenssenssenssenssens1a1b2c3d" },
    { key: "write", id: 4, user: 1, team: T1, name: "Write token", abilities: ["read", "write"], secret: "writwritwritwritwritwritwritwritwritwrit2a1b2c3d" },
    { key: "writeOnly", id: 5, user: 1, team: T1, name: "Write only", abilities: ["write"], secret: "wonlwonlwonlwonlwonlwonlwonlwonlwonlwonl3a1b2c3d" },
    { key: "delete", id: 6, user: 1, team: T1, name: "Delete token", abilities: ["read", "delete"], secret: "deledeledeledeledeledeledeledeledeledele4a1b2c3d" },
    { key: "expired", id: 7, user: 1, team: T1, name: "Expired token", abilities: ["root"], secret: "expiexpiexpiexpiexpiexpiexpiexpiexpiexpi5a1b2c3d", expires_at: "2025-12-31 00:00:00" },
    { key: "memberRead", id: 8, user: 2, team: T1, name: "Member read", abilities: ["read"], secret: "mreamreamreamreamreamreamreamreamreamrea6a1b2c3d" },
    { key: "memberWrite", id: 9, user: 2, team: T1, name: "Member write", abilities: ["read", "write"], secret: "mwrimwrimwrimwrimwrimwrimwrimwrimwrimwri7a1b2c3d" },
    { key: "notMember", id: 10, user: 1, team: T2, name: "Not a member", abilities: ["root"], secret: "nmemnmemnmemnmemnmemnmemnmemnmemnmemnmem8a1b2c3d" },
    { key: "memberSensitive", id: 11, user: 2, team: T1, name: "Member sensitive", abilities: ["read", "read:sensitive"], secret: "msenmsenmsenmsenmsenmsenmsenmsenmsenmsen9a1b2c3d" },
    // DP-86: a token that may deploy but not write (a preview's redeploy).
    { key: "deploy", id: 12, user: 1, team: T1, name: "Deploy token", abilities: ["read", "deploy"], secret: "deplodeplodeplodeplodeplodeplodeplodeplo0b1c2d3e" },
  ],
};

const cases = [];
/** A case's bodyFile fields are read into its body here (base64 for those listed in `base64`), so the JSON both sides send is in cases.json. */
const add = (c) => {
  if (c.bodyFile) {
    for (const [field, file] of Object.entries(c.bodyFile)) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      c.body[field] = c.base64?.includes(field) ? Buffer.from(text).toString("base64") : text;
    }
    delete c.bodyFile;
    delete c.base64;
  }
  cases.push(c);
};

// ── authentication, the token's team, abilities, ApiAllowed ──────────────────
add({ name: "auth: no token", method: "GET", path: "/api/v1/projects" });
add({ name: "auth: unknown token", method: "GET", path: "/api/v1/projects", authorization: "Bearer 99|nopenopenopenopenopenopenopenopenopenope00000000" });
add({ name: "auth: secret without id", method: "GET", path: "/api/v1/projects", authorization: `Bearer ${fixture.tokens[0].secret}` });
add({ name: "auth: not a bearer", method: "GET", path: "/api/v1/projects", authorization: "Basic dXNlcjpwYXNz" });
add({ name: "auth: expired", token: "expired", method: "GET", path: "/api/v1/projects" });
add({ name: "auth: team the user left", token: "notMember", method: "GET", path: "/api/v1/projects" });
add({ name: "ability: read token writes", token: "read", method: "POST", path: "/api/v1/projects", body: { name: "Gamma" } });
add({ name: "ability: write-only token reads", token: "writeOnly", method: "GET", path: "/api/v1/projects" });
add({ name: "ability: write token deletes", token: "write", method: "DELETE", path: `/api/v1/projects/${P_BETA}` });
add({ name: "ability: member token beyond the member's access", token: "memberWrite", method: "GET", path: "/api/v1/projects" });
add({ name: "ability: member read token", token: "memberRead", method: "GET", path: "/api/v1/projects" });
add({ name: "allowed: API disabled", token: "root", method: "GET", path: "/api/v1/projects", instance: { is_api_enabled: false } });
add({ name: "allowed: IP not in the allow list", token: "root", method: "GET", path: "/api/v1/projects", instance: { allowed_ips: "198.51.100.0/24,192.0.2.7" } });
add({ name: "allowed: IP in a CIDR of the allow list", token: "root", method: "GET", path: "/api/v1/projects", ip: "198.51.100.23", instance: { allowed_ips: "198.51.100.0/24, 192.0.2.7" } });
add({ name: "allowed: IP exact in the allow list", token: "root", method: "GET", path: "/api/v1/projects", ip: "192.0.2.7", instance: { allowed_ips: "198.51.100.0/24,192.0.2.7" } });
add({ name: "allowed: allow list 0.0.0.0", token: "root", method: "GET", path: "/api/v1/projects", instance: { allowed_ips: "0.0.0.0" } });
add({ name: "route: unknown, with a token", token: "root", method: "GET", path: "/api/v1/nonexistent" });
add({ name: "route: unknown, without a token", method: "GET", path: "/api/v1/nonexistent" });
add({ name: "route: wrong method", token: "root", method: "PUT", path: "/api/v1/projects" });
add({ name: "health", method: "GET", path: "/api/v1/health" });
add({ name: "health: unversioned", method: "GET", path: "/api/health" });
add({ name: "version", token: "read", method: "GET", path: "/api/v1/version" });

// ── the two rate limiters ───────────────────────────────────────────────────
add({ name: "rate limit: API_RATE_LIMIT reached", config: { rate_limit: 3 }, sequence: [
  { token: "read", method: "GET", path: "/api/v1/version" },
  { token: "read", method: "GET", path: "/api/v1/projects" },
  { token: "root", method: "GET", path: "/api/v1/version" },
  { token: "read", method: "GET", path: "/api/v1/version" },
  { method: "GET", path: "/api/v1/version", ip: "203.0.113.51" },
  { advance: 61, token: "read", method: "GET", path: "/api/v1/version" },
] });
add({ name: "failed requests: blocked after the limit", config: { failed_request_rate_limit: 3 }, sequence: [
  { method: "GET", path: "/api/v1/projects" },
  { method: "GET", path: "/api/v1/projects" },
  { method: "GET", path: "/api/v1/projects" },
  { method: "GET", path: "/api/v1/projects" },
  { token: "root", method: "GET", path: "/api/v1/version" },
  { method: "GET", path: "/api/v1/health" },
  { advance: 61, method: "GET", path: "/api/v1/version" },
  { method: "GET", path: "/api/v1/version" },
  { method: "GET", path: "/api/v1/version" },
  { method: "GET", path: "/api/v1/version" },
  { advance: 301, token: "read", method: "GET", path: "/api/v1/version" },
] });
add({ name: "failed requests: per token, and a 404 with a token does not count", config: { failed_request_rate_limit: 2 }, sequence: [
  { token: "read", method: "POST", path: "/api/v1/projects", body: { name: "Gamma" } },
  { token: "read", method: "GET", path: "/api/v1/nonexistent" },
  { token: "read", method: "GET", path: `/api/v1/projects/nonexistentuuid` },
  { token: "read", method: "POST", path: "/api/v1/projects", body: { name: "Gamma" } },
  { token: "read", method: "GET", path: "/api/v1/version" },
  { token: "root", method: "GET", path: "/api/v1/version" },
  { method: "GET", path: "/api/v1/nonexistent" },
] });

// ── teams ───────────────────────────────────────────────────────────────────
for (const [p, label] of [["/api/v1/team", "current team"], ["/api/v1/teams/current", "current team (deprecated alias)"], ["/api/v1/teams", "teams"], [`/api/v1/teams/${T1}`, "team by id"]]) {
  add({ name: `teams: ${label}`, token: "read", method: "GET", path: p });
}
add({ name: "teams: another team by id", token: "read", method: "GET", path: `/api/v1/teams/${T2}` });
add({ name: "teams: members", token: "read", method: "GET", path: "/api/v1/team/members" });
add({ name: "teams: members (deprecated alias)", token: "read", method: "GET", path: "/api/v1/teams/current/members" });
add({ name: "teams: members by id", token: "read", method: "GET", path: `/api/v1/teams/${T1}/members` });
add({ name: "teams: members of another team", token: "read", method: "GET", path: `/api/v1/teams/${T2}/members` });

// ── projects and environments ───────────────────────────────────────────────
add({ name: "projects: list", token: "read", method: "GET", path: "/api/v1/projects" });
add({ name: "projects: show", token: "read", method: "GET", path: `/api/v1/projects/${P_ALPHA}` });
add({ name: "projects: show another team's", token: "read", method: "GET", path: `/api/v1/projects/${P_OTHER}` });
add({ name: "projects: environments", token: "read", method: "GET", path: `/api/v1/projects/${P_ALPHA}/environments` });
add({ name: "projects: environments of an unknown project", token: "read", method: "GET", path: "/api/v1/projects/nonexistentuuid/environments" });
add({ name: "projects: create", token: "write", method: "POST", path: "/api/v1/projects", body: { name: "Gamma", description: "Made by the API" },
  after: { projects: "select name, description, team_id from projects where name = 'Gamma'", environments: "select e.name from environments e join projects p on p.id = e.project_id where p.name = 'Gamma'" } });
add({ name: "projects: create without a description", token: "write", method: "POST", path: "/api/v1/projects", body: { name: "Gamma" }, after: { projects: "select name, description from projects where name = 'Gamma'" } });
add({ name: "projects: create, trimmed", token: "root", method: "POST", path: "/api/v1/projects", body: { name: "  Spaced  ", description: "" }, after: { projects: "select name, description from projects where name like '%Spaced%'" } });
add({ name: "projects: create, name not a string", token: "write", method: "POST", path: "/api/v1/projects", body: { name: 12345, description: ["x"] } });
add({ name: "projects: create, invalid", token: "write", method: "POST", path: "/api/v1/projects", body: { name: "x", description: "<b>", extra: 1 } });
add({ name: "projects: create, no name", token: "write", method: "POST", path: "/api/v1/projects", body: { description: "No name" } });
add({ name: "projects: create, not JSON", token: "write", method: "POST", path: "/api/v1/projects", raw: "name=Gamma", contentType: "application/x-www-form-urlencoded" });
add({ name: "projects: create, invalid JSON", token: "write", method: "POST", path: "/api/v1/projects", raw: "{name" });
add({ name: "projects: create, empty JSON", token: "write", method: "POST", path: "/api/v1/projects", raw: "{}" });
add({ name: "projects: update", token: "write", method: "PATCH", path: `/api/v1/projects/${P_BETA}`, body: { name: "Beta 2" }, after: { projects: `select name, description from projects where uuid = '${P_BETA}'` } });
add({ name: "projects: update the description only", token: "write", method: "PATCH", path: `/api/v1/projects/${P_ALPHA}`, body: { description: "Changed" } });
add({ name: "projects: update, invalid", token: "write", method: "PATCH", path: `/api/v1/projects/${P_ALPHA}`, body: { name: "ab", team_id: 2 } });
add({ name: "projects: update another team's", token: "write", method: "PATCH", path: `/api/v1/projects/${P_OTHER}`, body: { name: "Mine" } });
add({ name: "projects: delete with resources (environments)", token: "delete", method: "DELETE", path: `/api/v1/projects/${P_BETA}`, after: { projects: `select count(*) as n from projects where uuid = '${P_BETA}'` } });
add({ name: "projects: delete unknown", token: "delete", method: "DELETE", path: "/api/v1/projects/nonexistentuuid" });
add({ name: "environments: create", token: "write", method: "POST", path: `/api/v1/projects/${P_ALPHA}/environments`, body: { name: "preview" }, after: { environments: `select name, description from environments where project_id = 1 order by id` } });
add({ name: "environments: create, mixed case", token: "write", method: "POST", path: `/api/v1/projects/${P_ALPHA}/environments`, body: { name: "  Preview Env  " }, after: { environments: `select name from environments where project_id = 1 order by id` } });
add({ name: "environments: create, extra field", token: "write", method: "POST", path: `/api/v1/projects/${P_ALPHA}/environments`, body: { name: "preview", uuid: "x" } });
add({ name: "environments: create, existing name", token: "write", method: "POST", path: `/api/v1/projects/${P_ALPHA}/environments`, body: { name: "staging" } });
add({ name: "environments: create, invalid", token: "write", method: "POST", path: `/api/v1/projects/${P_ALPHA}/environments`, body: { name: "!", description: "x" } });
add({ name: "environments: create in an unknown project", token: "write", method: "POST", path: "/api/v1/projects/nonexistentuuid/environments", body: { name: "preview" } });
add({ name: "environments: update by name", token: "write", method: "PATCH", path: `/api/v1/projects/${P_ALPHA}/environments/staging`, body: { name: "qa-env", description: "Renamed" } });
add({ name: "environments: update by uuid", token: "write", method: "PATCH", path: `/api/v1/projects/${P_ALPHA}/environments/${E_STAGING}`, body: { description: "Only the description" } });
add({ name: "environments: update to an existing name", token: "write", method: "PATCH", path: `/api/v1/projects/${P_ALPHA}/environments/staging`, body: { name: "production" } });
add({ name: "environments: update unknown", token: "write", method: "PATCH", path: `/api/v1/projects/${P_ALPHA}/environments/nope`, body: { name: "qa-env" } });
add({ name: "environments: delete", token: "delete", method: "DELETE", path: `/api/v1/projects/${P_ALPHA}/environments/staging`, after: { environments: "select name from environments where project_id = 1 order by id" } });
add({ name: "environments: delete unknown", token: "delete", method: "DELETE", path: `/api/v1/projects/${P_ALPHA}/environments/nope` });

// ── private keys ────────────────────────────────────────────────────────────
add({ name: "keys: list", token: "read", method: "GET", path: "/api/v1/security/keys" });
add({ name: "keys: list, read:sensitive", token: "sensitive", method: "GET", path: "/api/v1/security/keys" });
add({ name: "keys: list, member with read:sensitive", token: "memberSensitive", method: "GET", path: "/api/v1/security/keys" });
add({ name: "keys: show", token: "read", method: "GET", path: `/api/v1/security/keys/${K_MAIN}` });
add({ name: "keys: show, root", token: "root", method: "GET", path: `/api/v1/security/keys/${K_MAIN}` });
add({ name: "keys: show another team's", token: "read", method: "GET", path: `/api/v1/security/keys/${K_OTHER}` });

add({ name: "keys: create", token: "write", method: "POST", path: "/api/v1/security/keys", bodyFile: { private_key: "../ssh-keys/rsa2048.pkcs1.pem" }, body: { name: "API key", description: "From the API" } });
add({ name: "keys: create base64", token: "write", method: "POST", path: "/api/v1/security/keys", bodyFile: { private_key: "../ssh-keys/ecdsa384.openssh" }, base64: ["private_key"], body: {} });
add({ name: "keys: create, no name or description", token: "write", method: "POST", path: "/api/v1/security/keys", bodyFile: { private_key: "../ssh-keys/ed25519.pkcs8.pem" }, body: {} });
add({ name: "keys: create, existing key", token: "write", method: "POST", path: "/api/v1/security/keys", bodyFile: { private_key: "../ssh-keys/ed25519.openssh" }, body: { name: "Again" } });
add({ name: "keys: create, not a key", token: "write", method: "POST", path: "/api/v1/security/keys", body: { name: "Bad key", private_key: "not a key" } });
add({ name: "keys: create, encrypted key", token: "write", method: "POST", path: "/api/v1/security/keys", bodyFile: { private_key: "../ssh-keys/encrypted.openssh" }, body: { name: "Encrypted" } });
add({ name: "keys: create, invalid", token: "write", method: "POST", path: "/api/v1/security/keys", body: { name: "a", description: "<x>", extra: true } });
add({ name: "keys: update", token: "write", method: "PATCH", path: `/api/v1/security/keys/${K_FREE}`, body: { name: "Renamed Key", description: "Now described" } });
add({ name: "keys: update, invalid", token: "write", method: "PATCH", path: `/api/v1/security/keys/${K_FREE}`, body: { name: "", fingerprint: "x" } });
add({ name: "keys: update, replace the key", token: "write", method: "PATCH", path: `/api/v1/security/keys/${K_FREE}`, bodyFile: { private_key: "../ssh-keys/ecdsa521.openssh" }, body: {} });
add({ name: "keys: update, not a key", token: "write", method: "PATCH", path: `/api/v1/security/keys/${K_FREE}`, body: { private_key: "garbage" } });
add({ name: "keys: update another team's", token: "write", method: "PATCH", path: `/api/v1/security/keys/${K_OTHER}`, body: { name: "Mine now" } });
add({ name: "keys: delete", token: "delete", method: "DELETE", path: `/api/v1/security/keys/${K_FREE}`, after: { keys: "select uuid from private_keys where team_id = 1 order by id" } });
add({ name: "keys: delete, in use", token: "delete", method: "DELETE", path: `/api/v1/security/keys/${K_MAIN}` });
add({ name: "keys: delete unknown", token: "delete", method: "DELETE", path: "/api/v1/security/keys/nonexistentuuid" });

// ── servers ─────────────────────────────────────────────────────────────────
add({ name: "servers: list", token: "read", method: "GET", path: "/api/v1/servers" });
add({ name: "servers: list, read:sensitive", token: "sensitive", method: "GET", path: "/api/v1/servers" });
add({ name: "servers: show", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}` });
add({ name: "servers: show with resources", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}?resources=1` });
add({ name: "servers: show, read:sensitive", token: "sensitive", method: "GET", path: `/api/v1/servers/${S_MAIN}` });
add({ name: "servers: show unknown", token: "read", method: "GET", path: "/api/v1/servers/nonexistentuuid" });
add({ name: "servers: resources", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}/resources` });
add({ name: "servers: domains", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}/domains` });
add({ name: "servers: validate", token: "write", method: "POST", path: `/api/v1/servers/${S_MAIN}/validate` });
add({ name: "servers: validate and install without deploy", token: "write", method: "POST", path: `/api/v1/servers/${S_MAIN}/validate`, body: { install: true } });
add({ name: "servers: validate, install not a boolean", token: "write", method: "POST", path: `/api/v1/servers/${S_MAIN}/validate`, body: { install: "maybe" } });
add({ name: "servers: validate unknown", token: "write", method: "POST", path: "/api/v1/servers/nonexistentuuid/validate" });
add({ name: "servers: validate with a read token", token: "read", method: "POST", path: `/api/v1/servers/${S_MAIN}/validate` });

// ── applications (DP-71) ────────────────────────────────────────────────────
const APP_ENVS_AFTER = { variables: "select key, is_preview, is_literal, is_multiline, is_shown_once, is_runtime, is_buildtime, comment, \"order\", version from environment_variables where resourceable_type = 'App\\Models\\Application' and resourceable_id = 1 order by id" };
add({ name: "applications: list", token: "read", method: "GET", path: "/api/v1/applications" });
add({ name: "applications: list, read:sensitive", token: "sensitive", method: "GET", path: "/api/v1/applications" });
add({ name: "applications: list, root", token: "root", method: "GET", path: "/api/v1/applications" });
add({ name: "applications: list by an unknown tag", token: "read", method: "GET", path: "/api/v1/applications?tag=nope" });
add({ name: "applications: show", token: "read", method: "GET", path: `/api/v1/applications/${A_IMAGE}` });
add({ name: "applications: show, read:sensitive", token: "sensitive", method: "GET", path: `/api/v1/applications/${A_IMAGE}` });
add({ name: "applications: show a git application", token: "read", method: "GET", path: `/api/v1/applications/${A_GIT}` });
add({ name: "applications: show another team's", token: "read", method: "GET", path: `/api/v1/applications/${A_OTHER}` });
add({ name: "applications: show unknown", token: "read", method: "GET", path: "/api/v1/applications/nonexistentuuid" });
add({ name: "applications: logs", token: "sensitive", method: "GET", path: `/api/v1/applications/${A_IMAGE}/logs` });
add({ name: "applications: logs of unknown", token: "sensitive", method: "GET", path: "/api/v1/applications/nonexistentuuid/logs" });
add({ name: "applications: start", token: "root", method: "POST", path: `/api/v1/applications/${A_IMAGE}/start` });
add({ name: "applications: start unknown", token: "root", method: "POST", path: "/api/v1/applications/nonexistentuuid/start" });
add({ name: "applications: start with GET", token: "root", method: "GET", path: `/api/v1/applications/${A_IMAGE}/start` });
add({ name: "applications: restart", token: "root", method: "POST", path: `/api/v1/applications/${A_IMAGE}/restart` });
add({ name: "applications: stop", token: "root", method: "POST", path: `/api/v1/applications/${A_IMAGE}/stop` });
add({ name: "applications: stop unknown", token: "root", method: "POST", path: "/api/v1/applications/nonexistentuuid/stop" });
/** The fixture's deployments (DP-74) removed: an application nothing was deployed of is deleted at once (DP-71's departure). */
const NEVER_DEPLOYED = ["delete from application_deployment_queues where application_id in ('1', '2')"];
add({ name: "applications: delete", token: "delete", method: "DELETE", path: `/api/v1/applications/${A_GIT}`, setup: NEVER_DEPLOYED, after: { applications: "select uuid, deleted_at is not null as deleted from applications where environment_id in (1, 2) order by id" } });
add({ name: "applications: delete with options", token: "delete", method: "DELETE", path: `/api/v1/applications/${A_IMAGE}?delete_volumes=false&docker_cleanup=0`, setup: NEVER_DEPLOYED });
add({ name: "applications: delete unknown", token: "delete", method: "DELETE", path: "/api/v1/applications/nonexistentuuid" });
add({ name: "applications: delete another team's", token: "delete", method: "DELETE", path: `/api/v1/applications/${A_OTHER}` });

add({ name: "application envs: list", token: "read", method: "GET", path: `/api/v1/applications/${A_IMAGE}/envs` });
add({ name: "application envs: list, read:sensitive", token: "sensitive", method: "GET", path: `/api/v1/applications/${A_IMAGE}/envs` });
add({ name: "application envs: list, member with read:sensitive", token: "memberSensitive", method: "GET", path: `/api/v1/applications/${A_IMAGE}/envs` });
add({ name: "application envs: list of a git application", token: "sensitive", method: "GET", path: `/api/v1/applications/${A_GIT}/envs` });
add({ name: "application envs: list of unknown", token: "read", method: "GET", path: "/api/v1/applications/nonexistentuuid/envs" });
add({ name: "application envs: list another team's", token: "read", method: "GET", path: `/api/v1/applications/${A_OTHER}/envs` });
add({ name: "application envs: create", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "NEW_KEY", value: "new value" }, after: APP_ENVS_AFTER });
add({ name: "application envs: create with every field", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: " spaced key ", value: "  kept  ", is_preview: false, is_literal: true, is_multiline: true, is_shown_once: true, is_runtime: false, is_buildtime: false, comment: "A comment" }, after: APP_ENVS_AFTER });
add({ name: "application envs: create a preview variable", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "PREVIEW_ONLY", value: "p", is_preview: true }, after: APP_ENVS_AFTER });
add({ name: "application envs: create an existing key", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "FOO", value: "again" } });
add({ name: "application envs: create an existing preview key", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "FOO", value: "again", is_preview: true } });
add({ name: "application envs: create, invalid", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "1BAD-KEY", value: 5, is_literal: "maybe", comment: "x".repeat(257), extra: 1 } });
add({ name: "application envs: create, no key", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { value: "v" } });
add({ name: "application envs: create, key with a dollar", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "A$B", value: "v" } });
add({ name: "application envs: create, not JSON", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/envs`, raw: "key=A", contentType: "application/x-www-form-urlencoded" });
add({ name: "application envs: create in unknown", token: "write", method: "POST", path: "/api/v1/applications/nonexistentuuid/envs", body: { key: "A", value: "v" } });
add({ name: "application envs: update", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "FOO", value: "changed", is_literal: true, comment: "Changed" }, after: APP_ENVS_AFTER });
add({ name: "application envs: update, read:sensitive answer", token: "root", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "FOO", value: "changed" } });
add({ name: "application envs: update a locked variable", token: "root", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "SECRET_TOKEN", value: "new secret", is_shown_once: false } });
add({ name: "application envs: update the preview copy", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "FOO", value: "preview value", is_preview: true }, after: APP_ENVS_AFTER });
add({ name: "application envs: update unknown key", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { key: "NOPE", value: "x" } });
add({ name: "application envs: update, invalid", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs`, body: { value: ["x"], is_runtime: 2, uuid: "x" } });
add({ name: "application envs: update, empty JSON", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs`, raw: "{}" });
add({ name: "application envs: bulk", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs/bulk`, body: { data: [{ key: "FOO", value: "bulk foo" }, { key: "BULK_NEW", value: "new", is_literal: true, ignored: "x" }, { key: "BULK_PREVIEW", value: "p", is_preview: true }] }, after: APP_ENVS_AFTER });
add({ name: "application envs: bulk, root answer", token: "root", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs/bulk`, body: { data: [{ key: "FOO", is_buildtime: false }, { key: "BULK_TWO", value: null }] } });
add({ name: "application envs: bulk, no data", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs/bulk`, body: { items: [] } });
add({ name: "application envs: bulk, invalid item", token: "write", method: "PATCH", path: `/api/v1/applications/${A_IMAGE}/envs/bulk`, body: { data: [{ key: "GOOD", value: "1" }, { key: "", value: "x" }] }, after: APP_ENVS_AFTER });
add({ name: "application envs: bulk in unknown", token: "write", method: "PATCH", path: "/api/v1/applications/nonexistentuuid/envs/bulk", body: { data: [{ key: "A" }] } });
add({ name: "application envs: delete", token: "delete", method: "DELETE", path: `/api/v1/applications/${A_IMAGE}/envs/${V_FOO}`, after: APP_ENVS_AFTER });
add({ name: "application envs: delete unknown", token: "delete", method: "DELETE", path: `/api/v1/applications/${A_IMAGE}/envs/nonexistentuuid` });
add({ name: "application envs: delete another application's", token: "delete", method: "DELETE", path: `/api/v1/applications/${A_IMAGE}/envs/${V_OTHER}` });
add({ name: "application envs: delete in unknown", token: "delete", method: "DELETE", path: `/api/v1/applications/nonexistentuuid/envs/${V_FOO}` });

// ── databases (DP-73) ───────────────────────────────────────────────────────
const ENGINES = [
  ["postgresql", DB_PG, "standalone_postgresqls", "StandalonePostgresql", "postgres_user, postgres_db, postgres_initdb_args, postgres_host_auth_method, postgres_conf, init_scripts, enable_ssl, ssl_mode"],
  ["redis", DB_REDIS, "standalone_redis", "StandaloneRedis", "redis_conf, enable_ssl"],
  ["mongodb", DB_MONGO, "standalone_mongodbs", "StandaloneMongodb", "mongo_conf, mongo_initdb_root_username, mongo_initdb_database, enable_ssl, ssl_mode"],
  ["mysql", DB_MYSQL, "standalone_mysqls", "StandaloneMysql", "mysql_user, mysql_database, mysql_conf, enable_ssl, ssl_mode"],
  ["mariadb", DB_MARIA, "standalone_mariadbs", "StandaloneMariadb", "mariadb_user, mariadb_database, mariadb_conf, enable_ssl"],
  ["keydb", DB_KEYDB, "standalone_keydbs", "StandaloneKeydb", "keydb_conf, enable_ssl"],
  ["dragonfly", DB_DRAGONFLY, "standalone_dragonflies", "StandaloneDragonfly", "enable_ssl"],
  ["clickhouse", DB_CLICKHOUSE, "standalone_clickhouses", "StandaloneClickhouse", "clickhouse_admin_user, clickhouse_db"],
];
const COMMON_DB_COLUMNS = "description, image, status, is_public, public_port, public_port_timeout, ports_mappings, limits_memory, limits_memory_swap, limits_memory_swappiness, limits_memory_reservation, limits_cpus, limits_cpuset, limits_cpu_shares, environment_id, destination_id, destination_type, is_log_drain_enabled, custom_docker_run_options, health_check_enabled, health_check_interval, health_check_timeout, health_check_retries, health_check_start_period, redact_all_env_values_in_logs, include_coolify_default_variables, restart_count, started_at, deleted_at";
/** The rows a create leaves: the new database (its generated name as a flag: it holds the random uuid), its volumes, its variables and tags. */
const createdAfter = (engine, table, model, extra, last = engine === "postgresql" ? 2 : 1) => ({
  database: `select name = '${engine}-database-' || uuid as default_name, ${COMMON_DB_COLUMNS}, ${extra} from ${table} where id > ${last} order by id`,
  volumes: `select v.name = '${engine === "postgresql" ? "postgres" : engine}-data-' || d.uuid as default_name, v.mount_path, v.host_path from local_persistent_volumes v join ${table} d on d.id = v.resource_id where v.resource_type = 'App\\Models\\${model}' and d.id > ${last} order by v.id`,
  variables: `select e.key, e.is_shared, e.is_runtime, e.is_buildtime from environment_variables e where e.resourceable_type = 'App\\Models\\${model}' and e.resourceable_id > ${last} order by e.id`,
  tags: `select t.name from tags t join taggables tg on tg.tag_id = t.id where tg.taggable_type = 'App\\Models\\${model}' and t.id > ${FIXTURE_TAGS} order by t.name`,
});
const ON = { project_uuid: P_ALPHA, environment_name: "production", server_uuid: S_MAIN };
add({ name: "databases: list", token: "read", method: "GET", path: "/api/v1/databases" });
add({ name: "databases: list, read:sensitive", token: "sensitive", method: "GET", path: "/api/v1/databases" });
add({ name: "databases: list, member with read:sensitive", token: "memberSensitive", method: "GET", path: "/api/v1/databases" });
for (const [engine, uuid] of ENGINES) {
  add({ name: `databases: show ${engine}`, token: "read", method: "GET", path: `/api/v1/databases/${uuid}` });
  add({ name: `databases: show ${engine}, read:sensitive`, token: "sensitive", method: "GET", path: `/api/v1/databases/${uuid}` });
}
add({ name: "databases: show another team's", token: "read", method: "GET", path: `/api/v1/databases/${DB_OTHER}` });
add({ name: "databases: show unknown", token: "read", method: "GET", path: "/api/v1/databases/nonexistentuuid" });

for (const [engine, , table, model, extra] of ENGINES) {
  add({ name: `databases: create ${engine}`, token: "write", method: "POST", path: `/api/v1/databases/${engine}`, body: ON, after: createdAfter(engine, table, model, extra) });
}
add({ name: "databases: create postgresql with every field", token: "root", method: "POST", path: "/api/v1/databases/postgresql",
  body: { project_uuid: P_ALPHA, environment_uuid: E_STAGING, server_uuid: S_MAIN, destination_uuid: D_MAIN, name: "api-postgres", description: "From the API", image: "postgres:17-alpine", is_public: true, public_port: 5544, public_port_timeout: 600, limits_memory: "512m", limits_cpus: 1.5, limits_cpu_shares: 512, postgres_user: "apiuser", postgres_password: "apiPass123", postgres_db: "apidb", postgres_initdb_args: "--data-checksums", postgres_host_auth_method: "scram-sha-256", postgres_conf: Buffer.from("max_connections = 50\n").toString("base64"), tags: [" API ", "databases", "api"] },
  after: createdAfter("postgresql", "standalone_postgresqls", "StandalonePostgresql", ENGINES[0][4]) });
add({ name: "databases: create redis with a password", token: "root", method: "POST", path: "/api/v1/databases/redis", body: { ...ON, redis_password: "apiRedisPass1", redis_conf: Buffer.from("maxmemory 64mb").toString("base64") }, after: createdAfter("redis", "standalone_redis", "StandaloneRedis", ENGINES[1][4]) });
add({ name: "databases: create mysql with its users", token: "root", method: "POST", path: "/api/v1/databases/mysql", body: { ...ON, mysql_user: "apiuser", mysql_password: "apiUserPass1", mysql_root_password: "apiRootPass1", mysql_database: "apidb" } });
add({ name: "databases: create mongodb, read:sensitive", token: "root", method: "POST", path: "/api/v1/databases/mongodb", body: { ...ON, mongo_initdb_root_username: "admin", mongo_initdb_root_password: "apiMongoPass1", mongo_initdb_database: "apidb" } });
add({ name: "databases: create clickhouse with its admin", token: "root", method: "POST", path: "/api/v1/databases/clickhouse", body: { ...ON, clickhouse_admin_user: "admin", clickhouse_admin_password: "apiClickPass1" } });
add({ name: "databases: create public without a port", token: "write", method: "POST", path: "/api/v1/databases/keydb", body: { ...ON, is_public: true }, after: createdAfter("keydb", "standalone_keydbs", "StandaloneKeydb", ENGINES[5][4]) });
add({ name: "databases: create, extra field", token: "write", method: "POST", path: "/api/v1/databases/postgresql", body: { ...ON, foo: 1, bar: "x" } });
add({ name: "databases: create, another engine's field", token: "write", method: "POST", path: "/api/v1/databases/postgresql", body: { ...ON, mysql_user: "x", redis_password: "y" } });
add({ name: "databases: create, no environment", token: "write", method: "POST", path: "/api/v1/databases/postgresql", body: { project_uuid: P_ALPHA, server_uuid: S_MAIN } });
add({ name: "databases: create in an unknown project", token: "write", method: "POST", path: "/api/v1/databases/postgresql", body: { ...ON, project_uuid: "nonexistentuuid" } });
add({ name: "databases: create in an unknown environment", token: "write", method: "POST", path: "/api/v1/databases/postgresql", body: { ...ON, environment_name: "nope" } });
add({ name: "databases: create by environment uuid", token: "write", method: "POST", path: "/api/v1/databases/dragonfly", body: { project_uuid: P_ALPHA, environment_name: "nope", environment_uuid: E_STAGING, server_uuid: S_MAIN }, after: createdAfter("dragonfly", "standalone_dragonflies", "StandaloneDragonfly", ENGINES[6][4]) });
add({ name: "databases: create on an unknown server", token: "write", method: "POST", path: "/api/v1/databases/postgresql", body: { ...ON, server_uuid: "nonexistentuuid" } });
add({ name: "databases: create on another team's server", token: "write", method: "POST", path: "/api/v1/databases/postgresql", body: { ...ON, server_uuid: S_OTHER } });
add({ name: "databases: create, invalid", token: "write", method: "POST", path: "/api/v1/databases/postgresql", body: { ...ON, name: "x", description: "<b>", image: 5, public_port: "abc", limits_memory_swappiness: "lots", limits_cpuset: 3, public_port_timeout: 0, instant_deploy: "no", tags: ["a", "ok"] } });
add({ name: "databases: create, a short tag", token: "write", method: "POST", path: "/api/v1/databases/postgresql", body: { ...ON, tags: ["<b>a</b>"] } });
add({ name: "databases: create, public port out of range", token: "write", method: "POST", path: "/api/v1/databases/postgresql", body: { ...ON, is_public: true, public_port: 80 } });
add({ name: "databases: create, public port taken", token: "write", method: "POST", path: "/api/v1/databases/mysql", body: { ...ON, is_public: true, public_port: 5433 } });
add({ name: "databases: create, configuration not base64", token: "write", method: "POST", path: "/api/v1/databases/postgresql", body: { ...ON, postgres_conf: "not base64!" } });
add({ name: "databases: create, invalid credentials", token: "write", method: "POST", path: "/api/v1/databases/mysql", body: { ...ON, mysql_user: "bad user", mysql_password: "bad'pass", mysql_database: "x".repeat(70), mysql_conf: 5 } });
add({ name: "databases: create, instant deploy without the deploy permission", token: "write", method: "POST", path: "/api/v1/databases/postgresql", body: { ...ON, instant_deploy: true } });
add({ name: "databases: create, instant deploy", token: "root", method: "POST", path: "/api/v1/databases/postgresql", body: { ...ON, instant_deploy: true } });
add({ name: "databases: create, not JSON", token: "write", method: "POST", path: "/api/v1/databases/postgresql", raw: "project_uuid=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "databases: create, empty JSON", token: "write", method: "POST", path: "/api/v1/databases/postgresql", raw: "{}" });

const PG_AFTER = { database: `select name, ${COMMON_DB_COLUMNS}, ${ENGINES[0][4]} from standalone_postgresqls where uuid = '${DB_PG}'` };
add({ name: "databases: update", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}`, body: { name: "renamed-postgres", description: "Renamed" }, after: PG_AFTER });
add({ name: "databases: update the engine's fields", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}`, body: { postgres_user: "parity", postgres_db: "paritydb", postgres_conf: Buffer.from("shared_buffers = 128MB").toString("base64"), postgres_initdb_args: "--locale=C", limits_memory: "1g", limits_memory_swappiness: 10, limits_cpuset: "0-1", health_check_interval: 30, health_check_enabled: false, public_port_timeout: 120 }, after: PG_AFTER });
add({ name: "databases: update the log settings", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}`, body: { redact_all_env_values_in_logs: false, include_coolify_default_variables: false, is_log_drain_enabled: false }, after: PG_AFTER });
add({ name: "databases: update, log drain not on the server", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}`, body: { is_log_drain_enabled: true } });
add({ name: "databases: update a redis password", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_REDIS}`, body: { redis_password: "newRedisPass1", image: "redis:7.4" }, after: { database: `select image from standalone_redis where uuid = '${DB_REDIS}'`, variables: "select key from environment_variables where resourceable_type = 'App\\Models\\StandaloneRedis' order by id" } });
add({ name: "databases: update mongodb", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_MONGO}`, body: { mongo_initdb_root_username: "root2", mongo_initdb_database: "app", mongo_conf: Buffer.from("net:\n  port: 27017\n").toString("base64") }, after: { database: `select mongo_initdb_root_username, mongo_initdb_database, mongo_conf from standalone_mongodbs where uuid = '${DB_MONGO}'` } });
add({ name: "databases: update clickhouse", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_CLICKHOUSE}`, body: { clickhouse_admin_user: "admin2", limits_cpus: "2" }, after: { database: `select clickhouse_admin_user, limits_cpus from standalone_clickhouses where uuid = '${DB_CLICKHOUSE}'` } });
add({ name: "databases: update, invalid", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}`, body: { name: "ab", public_port: 99999, public_port_timeout: 0, health_check_interval: 0, health_check_start_period: -1, postgres_user: "bad user", is_public: "maybe", extra: true } });
add({ name: "databases: update, another engine's field", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_MYSQL}`, body: { postgres_user: "x" } });
add({ name: "databases: update, configuration not base64", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_MYSQL}`, body: { mysql_conf: "%%%" } });
add({ name: "databases: update, made private without the deploy permission", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}`, body: { is_public: false } });
add({ name: "databases: update, made private", token: "root", method: "PATCH", path: `/api/v1/databases/${DB_PG}`, body: { is_public: false } });
add({ name: "databases: update, public as it is", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}`, body: { is_public: true, public_port: 5434 }, after: PG_AFTER });
add({ name: "databases: update, public port taken", token: "root", method: "PATCH", path: `/api/v1/databases/${DB_MYSQL}`, body: { is_public: true, public_port: 5433 } });
add({ name: "databases: update, instant deploy without the deploy permission", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}`, body: { name: "x-postgres", instant_deploy: true } });
add({ name: "databases: update, instant deploy", token: "root", method: "PATCH", path: `/api/v1/databases/${DB_PG}`, body: { name: "x-postgres", instant_deploy: true }, after: PG_AFTER });
add({ name: "databases: update unknown", token: "write", method: "PATCH", path: "/api/v1/databases/nonexistentuuid", body: { name: "nope-db" } });
add({ name: "databases: update another team's", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_OTHER}`, body: { name: "mine-db" } });
add({ name: "databases: update, empty JSON", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}`, raw: "{}" });

const visible = (table, uuid) => ({ database: `select count(*)::int as n from ${table} where uuid = '${uuid}' and deleted_at is null` });
add({ name: "databases: delete", token: "delete", method: "DELETE", path: `/api/v1/databases/${DB_MARIA}`, after: visible("standalone_mariadbs", DB_MARIA) });
add({ name: "databases: delete with options", token: "delete", method: "DELETE", path: `/api/v1/databases/${DB_PG}?delete_volumes=false&delete_backups=true&docker_cleanup=0`, after: visible("standalone_postgresqls", DB_PG) });
add({ name: "databases: delete unknown", token: "delete", method: "DELETE", path: "/api/v1/databases/nonexistentuuid" });
add({ name: "databases: delete another team's", token: "delete", method: "DELETE", path: `/api/v1/databases/${DB_OTHER}` });
for (const action of ["start", "restart", "stop"]) {
  add({ name: `databases: ${action}`, token: "root", method: "POST", path: `/api/v1/databases/${DB_PG}/${action}` });
  add({ name: `databases: ${action} unknown`, token: "root", method: "POST", path: `/api/v1/databases/nonexistentuuid/${action}` });
  add({ name: `databases: ${action} with GET`, token: "root", method: "GET", path: `/api/v1/databases/${DB_PG}/${action}` });
}

// ── database backups (DP-73) ────────────────────────────────────────────────
const BACKUP_COLUMNS = "uuid, description, enabled, save_s3, frequency, database_backup_retention_amount_locally, database_type, database_id, s3_storage_id, databases_to_backup, dump_all, database_backup_retention_days_locally, database_backup_retention_max_storage_locally::float8::text as max_storage_locally, database_backup_retention_amount_s3, database_backup_retention_days_s3, database_backup_retention_max_storage_s3::float8::text as max_storage_s3, timeout, disable_local_backup, missing_backup_notification_days";
const backupsAfter = (where) => ({
  backups: `select ${BACKUP_COLUMNS.replace("uuid, ", "uuid in ('c1paritypgbackup00000001', 'c2paritypgs3backup000002', 'c3paritymysqlbackup00003') as fixture_uuid, ")} from scheduled_database_backups where ${where} order by id`,
  destinations: `select scheduled_database_backup_id <= 4 as fixture_schedule, s3_storage_id from scheduled_database_backup_s3_storage where scheduled_database_backup_id in (select id from scheduled_database_backups where ${where}) order by id`,
  executions: `select uuid, scheduled_database_backup_id from scheduled_database_backup_executions order by id`,
});
const NEW_BACKUPS = backupsAfter("id > 4");
add({ name: "backups: list", token: "read", method: "GET", path: `/api/v1/databases/${DB_PG}/backups` });
add({ name: "backups: list, read:sensitive", token: "sensitive", method: "GET", path: `/api/v1/databases/${DB_PG}/backups` });
add({ name: "backups: list of a database without schedules", token: "read", method: "GET", path: `/api/v1/databases/${DB_REDIS}/backups` });
add({ name: "backups: list of unknown", token: "read", method: "GET", path: "/api/v1/databases/nonexistentuuid/backups" });
add({ name: "backups: list another team's", token: "read", method: "GET", path: `/api/v1/databases/${DB_OTHER}/backups` });
add({ name: "backups: create", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, body: { frequency: "0 3 * * *" }, after: NEW_BACKUPS });
add({ name: "backups: create with every field", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`,
  body: { frequency: "@daily", enabled: false, dump_all: true, databases_to_backup: "parity,other", database_backup_retention_amount_locally: 3, database_backup_retention_days_locally: 7, database_backup_retention_max_storage_locally: 2.5, database_backup_retention_amount_s3: 5, database_backup_retention_days_s3: 30, database_backup_retention_max_storage_s3: 10, timeout: 120, missing_backup_notification_days: 3, save_s3: true, disable_local_backup: true, s3_storage_uuid: S3_MAIN },
  after: NEW_BACKUPS });
add({ name: "backups: create with a list of destinations", token: "write", method: "POST", path: `/api/v1/databases/${DB_MYSQL}/backups`, body: { frequency: "hourly", save_s3: true, s3_storage_uuids: [S3_MAIN] }, after: NEW_BACKUPS });
add({ name: "backups: create, primary not in the list", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, body: { frequency: "@daily", s3_storage_uuid: S3_MAIN, s3_storage_uuids: [] } });
add({ name: "backups: create, another team's storage", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, body: { frequency: "@daily", save_s3: true, s3_storage_uuid: S3_OTHER } });
add({ name: "backups: create, unknown storage", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, body: { frequency: "@daily", s3_storage_uuid: "nonexistentuuid" } });
add({ name: "backups: create, S3 without a storage", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, body: { frequency: "@daily", save_s3: true } });
add({ name: "backups: create, no local copy without S3", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, body: { frequency: "@daily", disable_local_backup: true } });
add({ name: "backups: create for mongodb", token: "write", method: "POST", path: `/api/v1/databases/${DB_MONGO}/backups`, body: { frequency: "0 */6 * * *" }, after: NEW_BACKUPS });
add({ name: "backups: create for clickhouse", token: "write", method: "POST", path: `/api/v1/databases/${DB_CLICKHOUSE}/backups`, body: { frequency: "weekly" }, after: NEW_BACKUPS });
add({ name: "backups: create for redis", token: "write", method: "POST", path: `/api/v1/databases/${DB_REDIS}/backups`, body: { frequency: "@daily" } });
add({ name: "backups: create, no frequency", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, body: { enabled: true } });
add({ name: "backups: create, invalid frequency", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, body: { frequency: "every day" } });
add({ name: "backups: create, invalid", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, body: { frequency: 5, enabled: "maybe", timeout: 10, missing_backup_notification_days: 400, database_backup_retention_amount_locally: -1, database_backup_retention_max_storage_s3: "lots", s3_storage_uuids: "x", databases_to_backup: ["x"] } });
add({ name: "backups: create, duplicate destinations", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, body: { frequency: "@daily", s3_storage_uuids: [S3_MAIN, S3_MAIN] } });
add({ name: "backups: create, extra field", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, body: { frequency: "@daily", foo: 1 } });
add({ name: "backups: create, unsafe database name", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, body: { frequency: "@daily", databases_to_backup: "parity;rm -rf /" } });
add({ name: "backups: create, back up now without the deploy permission", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, body: { frequency: "@daily", backup_now: true } });
add({ name: "backups: create, back up now", token: "root", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, body: { frequency: "@daily", backup_now: true }, after: NEW_BACKUPS });
add({ name: "backups: create in unknown", token: "write", method: "POST", path: "/api/v1/databases/nonexistentuuid/backups", body: { frequency: "@daily" } });
add({ name: "backups: create, empty JSON", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/backups`, raw: "{}" });

const PG_BACKUPS = backupsAfter("database_id = 1 and database_type = 'App\\Models\\StandalonePostgresql'");
add({ name: "backups: update", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}`, body: { frequency: "0 4 * * *", enabled: false, database_backup_retention_amount_locally: 9, database_backup_retention_max_storage_locally: 1.25, timeout: 600 }, after: PG_BACKUPS });
add({ name: "backups: update, to S3", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}`, body: { save_s3: true, s3_storage_uuids: [S3_MAIN], disable_local_backup: true }, after: PG_BACKUPS });
add({ name: "backups: update, off S3", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG_S3}`, body: { save_s3: false, disable_local_backup: false }, after: PG_BACKUPS });
add({ name: "backups: update, the primary destination only", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG_S3}`, body: { s3_storage_uuid: S3_MAIN, dump_all: true }, after: PG_BACKUPS });
add({ name: "backups: update, S3 without a storage", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}`, body: { save_s3: true } });
add({ name: "backups: update, no destinations left", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG_S3}`, body: { s3_storage_uuids: [] } });
add({ name: "backups: update, no local copy without S3", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}`, body: { disable_local_backup: true } });
add({ name: "backups: update, invalid frequency", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}`, body: { frequency: "sometimes" } });
add({ name: "backups: update, invalid", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}`, body: { timeout: 99999, dump_all: "x", s3_storage_uuid: 5 } });
add({ name: "backups: update, extra field", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}`, body: { frequency: "@daily", uuid: "x", database_id: 3 } });
add({ name: "backups: update, unsafe database name", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}`, body: { databases_to_backup: "a|b`c`" } });
add({ name: "backups: update, back up now without the deploy permission", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}`, body: { backup_now: true } });
add({ name: "backups: update, back up now", token: "root", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}`, body: { enabled: false, backup_now: true }, after: PG_BACKUPS });
add({ name: "backups: update unknown", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/nonexistentuuid`, body: { frequency: "@daily" } });
add({ name: "backups: update another database's", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_MYSQL}`, body: { frequency: "@daily" } });
add({ name: "backups: update in unknown", token: "write", method: "PATCH", path: `/api/v1/databases/nonexistentuuid/backups/${BK_PG}`, body: { frequency: "@daily" } });
add({ name: "backups: update, empty JSON", token: "write", method: "PATCH", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}`, raw: "{}" });
add({ name: "backups: delete", token: "delete", method: "DELETE", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}`, after: PG_BACKUPS });
add({ name: "backups: delete with its S3 copies", token: "delete", method: "DELETE", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG_S3}?delete_s3=true`, after: PG_BACKUPS });
add({ name: "backups: delete unknown", token: "delete", method: "DELETE", path: `/api/v1/databases/${DB_PG}/backups/nonexistentuuid` });
add({ name: "backups: delete in unknown", token: "delete", method: "DELETE", path: `/api/v1/databases/nonexistentuuid/backups/${BK_PG}` });
add({ name: "backups: delete another team's", token: "delete", method: "DELETE", path: `/api/v1/databases/${DB_OTHER}/backups/${BK_OTHER}` });
add({ name: "backups: executions", token: "read", method: "GET", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}/executions` });
add({ name: "backups: executions, read:sensitive", token: "sensitive", method: "GET", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}/executions` });
add({ name: "backups: executions of a schedule without any", token: "read", method: "GET", path: `/api/v1/databases/${DB_MYSQL}/backups/${BK_MYSQL}/executions` });
add({ name: "backups: executions of unknown", token: "read", method: "GET", path: `/api/v1/databases/${DB_PG}/backups/nonexistentuuid/executions` });
add({ name: "backups: executions in unknown", token: "read", method: "GET", path: `/api/v1/databases/nonexistentuuid/backups/${BK_PG}/executions` });
add({ name: "backups: delete an execution", token: "delete", method: "DELETE", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}/executions/${EX_OK}`, after: PG_BACKUPS });
add({ name: "backups: delete an execution with its S3 copies", token: "delete", method: "DELETE", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}/executions/${EX_FAIL}?delete_s3=1`, after: PG_BACKUPS });
add({ name: "backups: delete an unknown execution", token: "delete", method: "DELETE", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG}/executions/nonexistentuuid` });
add({ name: "backups: delete an execution of another schedule", token: "delete", method: "DELETE", path: `/api/v1/databases/${DB_PG}/backups/${BK_PG_S3}/executions/${EX_OK}` });

// ── services (DP-74) ────────────────────────────────────────────────────────
/** A uuid made by the request, in a value (a generated name, domain or Compose file), as <uuid>; the random name of a service from a Compose file without one (str()->random(10)) as service-<random>. */
const masked = (column) => `regexp_replace(regexp_replace(${column}, '[a-z0-9]{24}', '<uuid>', 'g'), '(service-)[A-Za-z0-9]{10}([^A-Za-z0-9]|$)', '\\1<random>\\2', 'g')`;
/** The rows a service's write leaves: the service, its parts, its variables (values are each side's ciphertext), volumes and tags. */
// DP-84: the volumes leave out the fixture's volume of the web part (the service storages' cases), as they did before it.
const servicesAfter = (where) => ({
  service: `select case when name ~ '^service-[A-Za-z0-9]{10}$' then 'service-<random>' else ${masked("name")} end as name, description, docker_compose_raw, ${masked("docker_compose")} as docker_compose, connect_to_docker_network, service_type, compose_parsing_version, is_container_label_escape_enabled, redact_all_env_values_in_logs, include_coolify_default_variables, environment_id, server_id, destination_id, destination_type, deleted_at is not null as deleted from services where ${where} order by id`,
  applications: `select a.name, a.human_name, a.image, ${masked("a.fqdn")} as fqdn, a.ports, a.status, a.exclude_from_status, a.is_gzip_enabled, a.is_stripprefix_enabled, a.is_force_https_enabled, a.is_permanent_redirect_enabled, a.redirect, a.is_removed_from_compose, a.deleted_at is not null as deleted from service_applications a join services s on s.id = a.service_id where ${where.replaceAll("id", "s.id")} order by a.id`,
  databases: `select d.name, d.human_name, d.image, d.ports, d.status, d.exclude_from_status, d.is_public, d.is_removed_from_compose, d.deleted_at is not null as deleted from service_databases d join services s on s.id = d.service_id where ${where.replaceAll("id", "s.id")} order by d.id`,
  variables: `select e.key, e.is_preview, e.is_required, e.is_shared, e.is_literal, e.is_multiline, e.is_shown_once, e.is_runtime, e.is_buildtime, e.comment, e.version from environment_variables e join services s on s.id = e.resourceable_id where e.resourceable_type = 'App\\Models\\Service' and ${where.replaceAll("id", "s.id")} order by e.id`,
  volumes: `select ${masked("v.name")} as name, v.mount_path, v.resource_type from local_persistent_volumes v where v.resource_type in ('App\\Models\\ServiceApplication', 'App\\Models\\ServiceDatabase') and v.resource_id in (select a.id from service_applications a join services s on s.id = a.service_id where ${where.replaceAll("id", "s.id")} union select d.id from service_databases d join services s on s.id = d.service_id where ${where.replaceAll("id", "s.id")}) and v.uuid <> '${PV_SERVICE}' order by v.id`,
  tags: `select t.name from tags t join taggables tg on tg.tag_id = t.id where tg.taggable_type = 'App\\Models\\Service' and t.id > ${FIXTURE_TAGS} order by t.name`,
});
const NEW_SERVICES = servicesAfter("id > 2");
const MAIN_SERVICE = servicesAfter("id = 1");
const SERVICE_ON = { project_uuid: P_ALPHA, environment_name: "production", server_uuid: S_MAIN };
const b64 = (text) => Buffer.from(text).toString("base64");
const CUSTOM_COMPOSE = "services:\n  app:\n    image: 'traefik/whoami:latest'\n    environment:\n      - SERVICE_URL_APP_80\n      - 'GREETING=${GREETING:-hello}'\n    volumes:\n      - 'app-data:/data'\n  cache:\n    image: 'redis:7-alpine'\n";
add({ name: "services: list", token: "read", method: "GET", path: "/api/v1/services" });
add({ name: "services: list, read:sensitive", token: "sensitive", method: "GET", path: "/api/v1/services" });
add({ name: "services: list, member with read:sensitive", token: "memberSensitive", method: "GET", path: "/api/v1/services" });
add({ name: "services: show", token: "read", method: "GET", path: `/api/v1/services/${SV_MAIN}` });
add({ name: "services: show, read:sensitive", token: "sensitive", method: "GET", path: `/api/v1/services/${SV_MAIN}` });
add({ name: "services: show another team's", token: "read", method: "GET", path: `/api/v1/services/${SV_OTHER}` });
add({ name: "services: show unknown", token: "read", method: "GET", path: "/api/v1/services/nonexistentuuid" });

add({ name: "services: create from a template", token: "write", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", ...SERVICE_ON }, after: NEW_SERVICES });
add({ name: "services: create from a template with every field", token: "write", method: "POST", path: "/api/v1/services",
  body: { type: "excalidraw", name: "api-excalidraw", description: "From the API", project_uuid: P_ALPHA, environment_uuid: E_STAGING, server_uuid: S_MAIN, destination_uuid: D_MAIN, connect_to_docker_network: true, is_container_label_escape_enabled: false, redact_all_env_values_in_logs: false, urls: [{ name: "excalidraw", url: "https://draw.example.com" }], tags: ["whiteboards", " API "] },
  after: NEW_SERVICES });
add({ name: "services: create a template with prerequisites", token: "write", method: "POST", path: "/api/v1/services", body: { type: "beszel", ...SERVICE_ON }, after: NEW_SERVICES });
add({ name: "services: create a template with a dash in its name", token: "write", method: "POST", path: "/api/v1/services", body: { type: "it-tools", ...SERVICE_ON }, after: NEW_SERVICES });
add({ name: "services: create, unknown type", token: "write", method: "POST", path: "/api/v1/services", body: { type: "nope", ...SERVICE_ON } });
add({ name: "services: create, a type and a Compose file", token: "write", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", docker_compose_raw: b64(CUSTOM_COMPOSE), ...SERVICE_ON } });
add({ name: "services: create, neither a type nor a Compose file", token: "write", method: "POST", path: "/api/v1/services", body: SERVICE_ON });
add({ name: "services: create, invalid", token: "write", method: "POST", path: "/api/v1/services", body: { type: 5, project_uuid: P_ALPHA, server_uuid: [], name: "x", description: "<b>", instant_deploy: "no", connect_to_docker_network: "maybe", urls: [{ name: "excalidraw", url: "https://a.example.com", port: 80 }, { url: "not a url" }], tags: ["a"], extra: 1 } });
add({ name: "services: create, urls not a list", token: "write", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", ...SERVICE_ON, urls: "https://draw.example.com" } });
add({ name: "services: create, a short tag", token: "write", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", ...SERVICE_ON, tags: ["<i>x</i>"] } });
add({ name: "services: create, no environment", token: "write", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", project_uuid: P_ALPHA, server_uuid: S_MAIN } });
add({ name: "services: create in an unknown project", token: "write", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", ...SERVICE_ON, project_uuid: "nonexistentuuid" } });
add({ name: "services: create in an unknown environment", token: "write", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", ...SERVICE_ON, environment_name: "nope" } });
add({ name: "services: create on an unknown server", token: "write", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", ...SERVICE_ON, server_uuid: "nonexistentuuid" } });
add({ name: "services: create on another team's server", token: "write", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", ...SERVICE_ON, server_uuid: S_OTHER } });
add({ name: "services: create, urls of an unknown container", token: "write", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", ...SERVICE_ON, urls: [{ name: "nope", url: "https://draw.example.com" }] }, after: NEW_SERVICES });
add({ name: "services: create, an invalid url", token: "write", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", ...SERVICE_ON, urls: [{ name: "excalidraw", url: "ftp://draw.example.com" }] } });
add({ name: "services: create, a url another resource uses", token: "write", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", ...SERVICE_ON, urls: [{ name: "excalidraw", url: "https://image.example.com" }] }, after: NEW_SERVICES });
add({ name: "services: create, a url another resource uses, forced", token: "write", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", ...SERVICE_ON, urls: [{ name: "excalidraw", url: "https://web.example.com" }], force_domain_override: true }, after: NEW_SERVICES });
add({ name: "services: create, instant deploy without the deploy permission", token: "write", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", ...SERVICE_ON, instant_deploy: true } });
add({ name: "services: create, instant deploy", token: "root", method: "POST", path: "/api/v1/services", body: { type: "excalidraw", ...SERVICE_ON, instant_deploy: true }, after: NEW_SERVICES });
add({ name: "services: create, not JSON", token: "write", method: "POST", path: "/api/v1/services", raw: "type=excalidraw", contentType: "application/x-www-form-urlencoded" });
add({ name: "services: create, empty JSON", token: "write", method: "POST", path: "/api/v1/services", raw: "{}" });
add({ name: "services: create from a Compose file", token: "write", method: "POST", path: "/api/v1/services", body: { docker_compose_raw: b64(CUSTOM_COMPOSE), name: "api-compose", ...SERVICE_ON }, after: NEW_SERVICES });
add({ name: "services: create from a Compose file without a name", token: "write", method: "POST", path: "/api/v1/services", body: { docker_compose_raw: b64("services:\n  hello:\n    image: 'hello-world'\n"), ...SERVICE_ON, connect_to_docker_network: true }, after: NEW_SERVICES });
add({ name: "services: create from a Compose file, not base64", token: "write", method: "POST", path: "/api/v1/services", body: { docker_compose_raw: "services: {}", ...SERVICE_ON } });
add({ name: "services: create from a Compose file, a command in it", token: "write", method: "POST", path: "/api/v1/services", body: { docker_compose_raw: b64("services:\n  app:\n    image: 'alpine'\n    volumes:\n      - '$(touch /tmp/pwned):/data'\n"), ...SERVICE_ON } });
add({ name: "services: create from a Compose file, extra field", token: "write", method: "POST", path: "/api/v1/services", body: { docker_compose_raw: b64(CUSTOM_COMPOSE), ...SERVICE_ON, type: "", foo: 1 } });

add({ name: "services: update", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}`, body: { name: "renamed-service", description: "Renamed" }, after: MAIN_SERVICE });
add({ name: "services: update the flags", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}`, body: { connect_to_docker_network: true, is_container_label_escape_enabled: false, redact_all_env_values_in_logs: false, include_coolify_default_variables: false }, after: MAIN_SERVICE });
add({ name: "services: update the Compose file", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}`, body: { docker_compose_raw: b64(SERVICE_COMPOSE.replace("nginx:alpine", "nginx:1.27-alpine").replace("'FOO=${FOO:-bar}'", "'FOO=${FOO:-bar}'\n      - 'BAZ=${BAZ:-qux}'")) }, after: MAIN_SERVICE });
add({ name: "services: update the urls", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}`, body: { urls: [{ name: "web", url: "https://www.example.com,https://web2.example.com" }] }, after: MAIN_SERVICE });
add({ name: "services: update, a url another resource uses", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}`, body: { urls: [{ name: "web", url: "https://image.example.com" }] }, after: MAIN_SERVICE });
add({ name: "services: update, urls of an unknown container", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}`, body: { name: "kept-service", urls: [{ name: "db", url: "https://db.example.com" }] }, after: MAIN_SERVICE });
add({ name: "services: update, a url removed", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}`, body: { urls: [{ name: "web", url: null }] }, after: MAIN_SERVICE });
add({ name: "services: update, invalid", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}`, body: { name: "", description: 5, docker_compose_raw: 5, include_coolify_default_variables: "x", type: "excalidraw", urls: [{ name: "web" }] } });
add({ name: "services: update, Compose file not base64", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}`, body: { docker_compose_raw: "services:" } });
add({ name: "services: update, instant deploy without the deploy permission", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}`, body: { name: "x-service", instant_deploy: true } });
add({ name: "services: update, instant deploy", token: "root", method: "PATCH", path: `/api/v1/services/${SV_MAIN}`, body: { name: "x-service", instant_deploy: true }, after: MAIN_SERVICE });
add({ name: "services: update unknown", token: "write", method: "PATCH", path: "/api/v1/services/nonexistentuuid", body: { name: "nope-service" } });
add({ name: "services: update another team's", token: "write", method: "PATCH", path: `/api/v1/services/${SV_OTHER}`, body: { name: "mine-service" } });
add({ name: "services: update, empty JSON", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}`, raw: "{}" });

/** Coolify soft-deletes the service and queues DeleteResourceJob; Freeploy removes the rows of a service that never ran (as DP-73 for a database): what both leave is the service no longer visible. */
const SERVICE_VISIBLE = { service: `select count(*)::int as n from services where uuid = '${SV_MAIN}' and deleted_at is null` };
add({ name: "services: delete", token: "delete", method: "DELETE", path: `/api/v1/services/${SV_MAIN}`, after: SERVICE_VISIBLE });
add({ name: "services: delete with options", token: "delete", method: "DELETE", path: `/api/v1/services/${SV_MAIN}?delete_volumes=false&docker_cleanup=0&delete_configurations=false&delete_connected_networks=false`, after: SERVICE_VISIBLE });
add({ name: "services: delete, from Coolify only", token: "delete", method: "DELETE", path: `/api/v1/services/${SV_MAIN}?delete_from_coolify_only=true`, after: SERVICE_VISIBLE });
add({ name: "services: delete unknown", token: "delete", method: "DELETE", path: "/api/v1/services/nonexistentuuid" });
add({ name: "services: delete another team's", token: "delete", method: "DELETE", path: `/api/v1/services/${SV_OTHER}` });
for (const action of ["start", "restart", "stop"]) {
  add({ name: `services: ${action}`, token: "root", method: "POST", path: `/api/v1/services/${SV_MAIN}/${action}` });
  add({ name: `services: ${action} unknown`, token: "root", method: "POST", path: `/api/v1/services/nonexistentuuid/${action}` });
  add({ name: `services: ${action} with GET`, token: "root", method: "GET", path: `/api/v1/services/${SV_MAIN}/${action}` });
}
add({ name: "services: start a running service", token: "root", method: "POST", path: `/api/v1/services/${SV_MAIN}/start`, setup: ["update service_applications set status = 'running:healthy' where id = 1", "update service_databases set status = 'running:healthy' where id = 1"] });
add({ name: "services: stop with a write token", token: "write", method: "POST", path: `/api/v1/services/${SV_MAIN}/stop` });

const SERVICE_ENVS_AFTER = { variables: "select key, is_preview, is_literal, is_multiline, is_shown_once, is_runtime, is_buildtime, is_required, is_shared, comment, \"order\", version from environment_variables where resourceable_type = 'App\\Models\\Service' and resourceable_id = 1 order by id" };
add({ name: "service envs: list", token: "read", method: "GET", path: `/api/v1/services/${SV_MAIN}/envs` });
add({ name: "service envs: list, read:sensitive", token: "sensitive", method: "GET", path: `/api/v1/services/${SV_MAIN}/envs` });
add({ name: "service envs: list, member with read:sensitive", token: "memberSensitive", method: "GET", path: `/api/v1/services/${SV_MAIN}/envs` });
add({ name: "service envs: list of unknown", token: "read", method: "GET", path: "/api/v1/services/nonexistentuuid/envs" });
add({ name: "service envs: list another team's", token: "read", method: "GET", path: `/api/v1/services/${SV_OTHER}/envs` });
add({ name: "service envs: create", token: "write", method: "POST", path: `/api/v1/services/${SV_MAIN}/envs`, body: { key: "NEW_KEY", value: "new value" }, after: SERVICE_ENVS_AFTER });
add({ name: "service envs: create with every field", token: "root", method: "POST", path: `/api/v1/services/${SV_MAIN}/envs`, body: { key: " spaced key ", value: "  kept  ", is_literal: true, is_multiline: true, is_shown_once: false, comment: "A comment" }, after: SERVICE_ENVS_AFTER });
add({ name: "service envs: create a locked variable", token: "root", method: "POST", path: `/api/v1/services/${SV_MAIN}/envs`, body: { key: "LOCKED", value: "hidden", is_shown_once: true }, after: SERVICE_ENVS_AFTER });
add({ name: "service envs: create an existing key", token: "write", method: "POST", path: `/api/v1/services/${SV_MAIN}/envs`, body: { key: "FOO", value: "again" } });
add({ name: "service envs: create, invalid", token: "write", method: "POST", path: `/api/v1/services/${SV_MAIN}/envs`, body: { key: "1BAD-KEY", value: 5, is_literal: "maybe", comment: "x".repeat(257), is_preview: true } });
add({ name: "service envs: create, no key", token: "write", method: "POST", path: `/api/v1/services/${SV_MAIN}/envs`, body: { value: "v" } });
add({ name: "service envs: create in unknown", token: "write", method: "POST", path: "/api/v1/services/nonexistentuuid/envs", body: { key: "A", value: "v" } });
add({ name: "service envs: update", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}/envs`, body: { key: "FOO", value: "changed", is_literal: true, comment: "Changed" }, after: SERVICE_ENVS_AFTER });
add({ name: "service envs: update, read:sensitive answer", token: "root", method: "PATCH", path: `/api/v1/services/${SV_MAIN}/envs`, body: { key: "FOO", value: "changed", is_multiline: true } });
add({ name: "service envs: update a locked variable", token: "root", method: "PATCH", path: `/api/v1/services/${SV_MAIN}/envs`, body: { key: "DB_PASSWORD", value: "newDbPass1" }, after: SERVICE_ENVS_AFTER });
add({ name: "service envs: update unknown key", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}/envs`, body: { key: "NOPE", value: "x" } });
add({ name: "service envs: update, invalid", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}/envs`, body: { value: ["x"], is_shown_once: 2 } });
add({ name: "service envs: bulk", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}/envs/bulk`, body: { data: [{ key: "FOO", value: "bulk foo" }, { key: "BULK_NEW", value: "new", is_literal: true, ignored: "x" }, { key: "BULK_LOCKED", value: "l", is_shown_once: true }] }, after: SERVICE_ENVS_AFTER });
add({ name: "service envs: bulk, root answer", token: "root", method: "PATCH", path: `/api/v1/services/${SV_MAIN}/envs/bulk`, body: { data: [{ key: "FOO", comment: "Bulk" }, { key: "BULK_TWO", value: null }] } });
add({ name: "service envs: bulk, no data", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}/envs/bulk`, body: { data: [] } });
add({ name: "service envs: bulk, invalid item", token: "write", method: "PATCH", path: `/api/v1/services/${SV_MAIN}/envs/bulk`, body: { data: [{ key: "GOOD", value: "1" }, { key: "BAD KEY!", value: "x" }] }, after: SERVICE_ENVS_AFTER });
add({ name: "service envs: bulk in unknown", token: "write", method: "PATCH", path: "/api/v1/services/nonexistentuuid/envs/bulk", body: { data: [{ key: "A" }] } });
add({ name: "service envs: delete", token: "delete", method: "DELETE", path: `/api/v1/services/${SV_MAIN}/envs/${SV_V_FOO}`, after: SERVICE_ENVS_AFTER });
add({ name: "service envs: delete unknown", token: "delete", method: "DELETE", path: `/api/v1/services/${SV_MAIN}/envs/nonexistentuuid` });
add({ name: "service envs: delete another service's", token: "delete", method: "DELETE", path: `/api/v1/services/${SV_MAIN}/envs/${SV_V_OTHER}` });
add({ name: "service envs: delete an application's", token: "delete", method: "DELETE", path: `/api/v1/services/${SV_MAIN}/envs/${V_FOO}` });

// ── deployments (DP-74) ─────────────────────────────────────────────────────
/** Team 1's deployments (another team's rows are not the org's in Freeploy). */
const DEPLOYMENTS_AFTER = { deployments: "select deployment_uuid, application_id, status, finished_at is not null as finished from application_deployment_queues where application_id in ('1', '2') order by id" };
add({ name: "deployments: by application", token: "read", method: "GET", path: `/api/v1/deployments/applications/${A_IMAGE}` });
add({ name: "deployments: by application, read:sensitive", token: "sensitive", method: "GET", path: `/api/v1/deployments/applications/${A_IMAGE}` });
add({ name: "deployments: by application, skip and take", token: "read", method: "GET", path: `/api/v1/deployments/applications/${A_IMAGE}?skip=1&take=1` });
add({ name: "deployments: by application, taken past the end", token: "read", method: "GET", path: `/api/v1/deployments/applications/${A_IMAGE}?skip=5` });
add({ name: "deployments: by application, invalid skip and take", token: "read", method: "GET", path: `/api/v1/deployments/applications/${A_IMAGE}?skip=-1&take=abc` });
add({ name: "deployments: by application, take zero", token: "read", method: "GET", path: `/api/v1/deployments/applications/${A_IMAGE}?take=0` });
add({ name: "deployments: by a git application", token: "read", method: "GET", path: `/api/v1/deployments/applications/${A_GIT}` });
add({ name: "deployments: by another team's application", token: "read", method: "GET", path: `/api/v1/deployments/applications/${A_OTHER}` });
add({ name: "deployments: by an unknown application", token: "read", method: "GET", path: "/api/v1/deployments/applications/nonexistentuuid" });
add({ name: "deployments: cancel a running one", token: "root", method: "POST", path: `/api/v1/deployments/${DQ_RUNNING}/cancel`, after: DEPLOYMENTS_AFTER });
add({ name: "deployments: cancel a queued one", token: "root", method: "POST", path: `/api/v1/deployments/${DQ_QUEUED}/cancel`, after: DEPLOYMENTS_AFTER });
add({ name: "deployments: cancel a finished one", token: "root", method: "POST", path: `/api/v1/deployments/${DQ_FINISHED}/cancel`, after: DEPLOYMENTS_AFTER });
add({ name: "deployments: cancel a failed one", token: "root", method: "POST", path: `/api/v1/deployments/${DQ_FAILED}/cancel` });
add({ name: "deployments: cancel another team's", token: "root", method: "POST", path: `/api/v1/deployments/${DQ_OTHER}/cancel`, after: DEPLOYMENTS_AFTER });
add({ name: "deployments: cancel unknown", token: "root", method: "POST", path: "/api/v1/deployments/nonexistentuuid/cancel" });
add({ name: "deployments: cancel with a write token", token: "write", method: "POST", path: `/api/v1/deployments/${DQ_RUNNING}/cancel` });
add({ name: "deploy: with GET", token: "root", method: "GET", path: `/api/v1/deploy?uuid=${A_IMAGE}` });
add({ name: "deploy: nothing named", token: "root", method: "POST", path: "/api/v1/deploy" });
add({ name: "deploy: uuid and tag", token: "root", method: "POST", path: `/api/v1/deploy?uuid=${A_IMAGE}&tag=web` });
add({ name: "deploy: tag and pull request", token: "root", method: "POST", path: "/api/v1/deploy?tag=web&pr=3" });
add({ name: "deploy: an unknown cancel_previous", token: "root", method: "POST", path: `/api/v1/deploy?uuid=${A_IMAGE}&cancel_previous=all` });
add({ name: "deploy: a pull request too large", token: "root", method: "POST", path: `/api/v1/deploy?uuid=${A_IMAGE}&pull_request_id=2147483648` });
add({ name: "deploy: an invalid docker tag", token: "root", method: "POST", path: `/api/v1/deploy?uuid=${A_IMAGE}&pr=2&docker_tag=bad%20tag` });
add({ name: "deploy: a docker tag without a pull request", token: "root", method: "POST", path: `/api/v1/deploy?uuid=${A_IMAGE}&docker_tag=v2` });
add({ name: "deploy: a docker tag and a tag", token: "root", method: "POST", path: "/api/v1/deploy?tag=web&docker_tag=v2" });
add({ name: "deploy: unknown uuids", token: "root", method: "POST", path: "/api/v1/deploy?uuid=nonexistentuuid,alsonotthere" });
add({ name: "deploy: only commas", token: "root", method: "POST", path: "/api/v1/deploy?uuid=,," });
add({ name: "deploy: another team's application", token: "root", method: "POST", path: `/api/v1/deploy?uuid=${A_OTHER}` });
add({ name: "deploy: an unknown tag", token: "root", method: "POST", path: "/api/v1/deploy?tag=nope" });
add({ name: "deploy: only commas for tags", token: "root", method: "POST", path: "/api/v1/deploy?tag=,," });
add({ name: "deploy: an application", token: "root", method: "POST", path: `/api/v1/deploy?uuid=${A_IMAGE}`, after: DEPLOYMENTS_AFTER });
add({ name: "deploy: an application, in the body", token: "root", method: "POST", path: "/api/v1/deploy", body: { uuid: A_GIT, force: true }, after: DEPLOYMENTS_AFTER });
add({ name: "deploy: a pull request that does not exist", token: "root", method: "POST", path: `/api/v1/deploy?uuid=${A_GIT}&pr=7`, after: DEPLOYMENTS_AFTER });
add({ name: "deploy: a service", token: "root", method: "POST", path: `/api/v1/deploy?uuid=${SV_MAIN}` });
add({ name: "deploy: a database", token: "root", method: "POST", path: `/api/v1/deploy?uuid=${DB_REDIS}` });
add({ name: "deploy: with a read token", token: "read", method: "POST", path: `/api/v1/deploy?uuid=${A_IMAGE}` });

// ── DP-78: the deployments in progress and one deployment ───────────────────
add({ name: "deployments: in progress", token: "read", method: "GET", path: "/api/v1/deployments" });
add({ name: "deployments: in progress, read:sensitive", token: "sensitive", method: "GET", path: "/api/v1/deployments" });
add({ name: "deployments: in progress, member", token: "memberRead", method: "GET", path: "/api/v1/deployments" });
add({ name: "deployments: in progress, none", token: "read", method: "GET", path: "/api/v1/deployments", setup: ["update application_deployment_queues set status = 'finished' where application_id in ('1', '2')"] });
add({ name: "deployments: show", token: "read", method: "GET", path: `/api/v1/deployments/${DQ_FINISHED}` });
add({ name: "deployments: show, read:sensitive", token: "sensitive", method: "GET", path: `/api/v1/deployments/${DQ_RUNNING}` });
add({ name: "deployments: show, root", token: "root", method: "GET", path: `/api/v1/deployments/${DQ_FAILED}` });
add({ name: "deployments: show another team's", token: "read", method: "GET", path: `/api/v1/deployments/${DQ_OTHER}` });
add({ name: "deployments: show unknown", token: "read", method: "GET", path: "/api/v1/deployments/nonexistentuuid" });
add({ name: "deployments: show with a write-only token", token: "writeOnly", method: "GET", path: `/api/v1/deployments/${DQ_FINISHED}` });

// ── DP-78: every resource, an environment's resources ───────────────────────
add({ name: "resources: list", token: "read", method: "GET", path: "/api/v1/resources" });
add({ name: "resources: list, read:sensitive", token: "sensitive", method: "GET", path: "/api/v1/resources" });
add({ name: "resources: list, member", token: "memberRead", method: "GET", path: "/api/v1/resources" });
add({ name: "resources: list with a write-only token", token: "writeOnly", method: "GET", path: "/api/v1/resources" });
add({ name: "environment details: by name", token: "read", method: "GET", path: `/api/v1/projects/${P_ALPHA}/production` });
add({ name: "environment details: by uuid, read:sensitive", token: "sensitive", method: "GET", path: `/api/v1/projects/${P_ALPHA}/${E_PROD}` });
add({ name: "environment details: an empty environment", token: "read", method: "GET", path: `/api/v1/projects/${P_ALPHA}/staging` });
add({ name: "environment details: another project's environment", token: "read", method: "GET", path: `/api/v1/projects/${P_BETA}/${E_STAGING}` });
add({ name: "environment details: unknown environment", token: "read", method: "GET", path: `/api/v1/projects/${P_ALPHA}/nope` });
add({ name: "environment details: unknown project", token: "read", method: "GET", path: "/api/v1/projects/nonexistentuuid/production" });
add({ name: "environment details: another team's project", token: "read", method: "GET", path: `/api/v1/projects/${P_OTHER}/production` });

// ── DP-78: a server's resources and domains, deleting and creating a server ───
add({ name: "server resources: list", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}/resources` });
add({ name: "server resources: another team's server", token: "read", method: "GET", path: `/api/v1/servers/${S_OTHER}/resources` });
add({ name: "server resources: unknown server", token: "read", method: "GET", path: "/api/v1/servers/nonexistentuuid/resources" });
add({ name: "server resources: none left", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}/resources`, setup: ["update applications set deleted_at = '2025-12-31 00:00:00' where destination_id = 1", "update services set deleted_at = '2025-12-31 00:00:00' where server_id = 1", ...["standalone_postgresqls", "standalone_redis", "standalone_mongodbs", "standalone_mysqls", "standalone_mariadbs", "standalone_keydbs", "standalone_dragonflies", "standalone_clickhouses"].map((t) => `update ${t} set deleted_at = '2025-12-31 00:00:00' where destination_id = 1`)] });
add({ name: "servers: show with resources, read:sensitive", token: "sensitive", method: "GET", path: `/api/v1/servers/${S_MAIN}?resources=true` });
add({ name: "server domains: list", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}/domains` });
add({ name: "server domains: several domains and a port", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}/domains`, setup: ["update applications set fqdn = 'https://image.example.com:8443/path,http://www.image.example.com' where id = 1", "update applications set fqdn = 'http://git.example.com' where id = 2", "update service_applications set fqdn = 'https://web.example.com,https://web2.example.com:3000' where id = 1"] });
add({ name: "server domains: of an application", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}/domains?uuid=${A_IMAGE}` });
add({ name: "server domains: of an application without a domain", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}/domains?uuid=${A_GIT}` });
add({ name: "server domains: of an unknown application", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}/domains?uuid=${A_OTHER}` });
add({ name: "server domains: another team's server", token: "read", method: "GET", path: `/api/v1/servers/${S_OTHER}/domains` });
add({ name: "server domains: unknown server", token: "read", method: "GET", path: "/api/v1/servers/nonexistentuuid/domains" });

const RESOURCES_GONE = ["update applications set deleted_at = '2025-12-31 00:00:00' where destination_id = 1", "update services set deleted_at = '2025-12-31 00:00:00' where server_id = 1", ...["standalone_postgresqls", "standalone_redis", "standalone_mongodbs", "standalone_mysqls", "standalone_mariadbs", "standalone_keydbs", "standalone_dragonflies", "standalone_clickhouses"].map((t) => `update ${t} set deleted_at = '2025-12-31 00:00:00' where destination_id = 1`)];
/** Whether team 1's server is still there (Coolify soft-deletes and queues DeleteServer; Freeploy deletes the rows). */
const SERVERS_AFTER = { servers: "select uuid from servers where deleted_at is null and ip <> '203.0.113.20' order by id" };
add({ name: "servers: delete one with resources", token: "delete", method: "DELETE", path: `/api/v1/servers/${S_MAIN}`, after: SERVERS_AFTER });
add({ name: "servers: delete one with resources, forced without deploy", token: "delete", method: "DELETE", path: `/api/v1/servers/${S_MAIN}?force=true`, after: SERVERS_AFTER });
add({ name: "servers: delete one with resources, forced", token: "root", method: "DELETE", path: `/api/v1/servers/${S_MAIN}?force=true`, after: SERVERS_AFTER });
add({ name: "servers: delete", token: "delete", method: "DELETE", path: `/api/v1/servers/${S_MAIN}`, setup: RESOURCES_GONE, after: SERVERS_AFTER });
add({ name: "servers: delete, keeping the resources", token: "delete", method: "DELETE", path: `/api/v1/servers/${S_MAIN}?remove_resources_from_server=false`, setup: RESOURCES_GONE, after: SERVERS_AFTER });
add({ name: "servers: delete with an invalid flag", token: "delete", method: "DELETE", path: `/api/v1/servers/${S_MAIN}?delete_from_provider=maybe` });
add({ name: "servers: delete with an invalid ssh key flag", token: "delete", method: "DELETE", path: `/api/v1/servers/${S_MAIN}?remove_ssh_key=2` });
add({ name: "servers: delete with an invalid resources flag", token: "delete", method: "DELETE", path: `/api/v1/servers/${S_MAIN}?remove_resources_from_server=nope` });
add({ name: "servers: delete from a provider it is not on", token: "root", method: "DELETE", path: `/api/v1/servers/${S_MAIN}?delete_from_provider=true`, setup: RESOURCES_GONE, after: SERVERS_AFTER });
add({ name: "servers: delete, removing the ssh key", token: "root", method: "DELETE", path: `/api/v1/servers/${S_MAIN}?remove_ssh_key=true`, setup: RESOURCES_GONE, after: SERVERS_AFTER });
add({ name: "servers: delete another team's", token: "root", method: "DELETE", path: `/api/v1/servers/${S_OTHER}` });
add({ name: "servers: delete unknown", token: "root", method: "DELETE", path: "/api/v1/servers/nonexistentuuid" });
add({ name: "servers: delete with a read token", token: "read", method: "DELETE", path: `/api/v1/servers/${S_MAIN}` });

/** The server a create made: its columns, settings and default destination (its uuid and a generated name are random). */
const CREATED_SERVER_AFTER = {
  server: "select case when name ~ '^[a-z]+(-[a-z]+)+-[a-z0-9]{24}$' then '<random-name>' else name end as name, description, ip, port, \"user\", private_key_id, proxy::jsonb->>'type' as proxy_type, proxy::jsonb->>'status' as proxy_status, (proxy::jsonb->>'redirect_enabled')::boolean as redirect_enabled from servers where ip = '203.0.113.30'",
  settings: "select ss.server_role, ss.is_build_server, ss.ssh_host_key, ss.ssh_host_key_source, ss.ssh_host_key_trusted_at is not null as trusted from server_settings ss join servers s on s.id = ss.server_id where s.ip = '203.0.113.30'",
  destination: "select d.network from standalone_dockers d join servers s on s.id = d.server_id where s.ip = '203.0.113.30'",
  servers: "select count(*)::int as count from servers where ip <> '203.0.113.20'",
};
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
add({ name: "servers: create", token: "write", method: "POST", path: "/api/v1/servers", body: { ip: "203.0.113.30", private_key_uuid: K_MAIN }, after: CREATED_SERVER_AFTER });
add({ name: "servers: create with every field", token: "write", method: "POST", path: "/api/v1/servers", body: { name: "build-box", description: "Builds things", ip: "203.0.113.30", port: 2222, user: "deploy", private_key_uuid: K_FREE, server_role: "build", proxy_type: "caddy", ssh_host_key: `203.0.113.30 ${HOST_KEY}\n# a comment\n${HOST_KEY}` }, after: CREATED_SERVER_AFTER });
add({ name: "servers: create as a build server (legacy flag)", token: "write", method: "POST", path: "/api/v1/servers", body: { name: "legacy-build", ip: "203.0.113.30", private_key_uuid: K_MAIN, is_build_server: true, proxy_type: "NONE" }, after: CREATED_SERVER_AFTER });
add({ name: "servers: create, the legacy flag against the role", token: "write", method: "POST", path: "/api/v1/servers", body: { ip: "203.0.113.30", private_key_uuid: K_MAIN, is_build_server: true, server_role: "both" }, after: CREATED_SERVER_AFTER });
add({ name: "servers: create, deployments only without a build server", token: "write", method: "POST", path: "/api/v1/servers", body: { ip: "203.0.113.30", private_key_uuid: K_MAIN, server_role: "deployment" }, after: CREATED_SERVER_AFTER });
add({ name: "servers: create, nothing", token: "write", method: "POST", path: "/api/v1/servers", body: { description: "No ip" } });
add({ name: "servers: create, invalid fields", token: "write", method: "POST", path: "/api/v1/servers", body: { name: "a\nb", description: "<bad>", ip: "not an ip!", port: 70000, user: "-root", private_key_uuid: 5, server_role: "worker", is_build_server: "yes", instant_validate: "no", proxy_type: 3, ssh_host_key: 7, extra: 1 } });
add({ name: "servers: create, a short name and a port that is not a number", token: "write", method: "POST", path: "/api/v1/servers", body: { name: "ab", ip: "2001:db8::1", port: "ssh", private_key_uuid: K_MAIN } });
add({ name: "servers: create, an invalid host key", token: "write", method: "POST", path: "/api/v1/servers", body: { ip: "203.0.113.30", private_key_uuid: K_MAIN, ssh_host_key: "not a key" } });
add({ name: "servers: create, an invalid proxy type", token: "write", method: "POST", path: "/api/v1/servers", body: { ip: "203.0.113.30", private_key_uuid: K_MAIN, proxy_type: "apache" } });
add({ name: "servers: create, an unknown private key", token: "write", method: "POST", path: "/api/v1/servers", body: { ip: "203.0.113.30", private_key_uuid: "nonexistentuuid" } });
add({ name: "servers: create, another team's private key", token: "write", method: "POST", path: "/api/v1/servers", body: { ip: "203.0.113.30", private_key_uuid: K_OTHER } });
add({ name: "servers: create, an endpoint in use", token: "write", method: "POST", path: "/api/v1/servers", body: { ip: "203.0.113.10", private_key_uuid: K_MAIN, port: 22 }, after: { servers: "select count(*)::int as count from servers where ip <> '203.0.113.20'" } });
add({ name: "servers: create, the endpoint in use on another port", token: "write", method: "POST", path: "/api/v1/servers", body: { ip: "203.0.113.10", private_key_uuid: K_MAIN, port: 2200, name: "same-host" }, after: { servers: "select name, port from servers where ip = '203.0.113.10' order by port" } });
add({ name: "servers: create, validating at once", token: "write", method: "POST", path: "/api/v1/servers", body: { ip: "203.0.113.30", private_key_uuid: K_MAIN, instant_validate: true }, after: CREATED_SERVER_AFTER });
add({ name: "servers: create, not JSON", token: "write", method: "POST", path: "/api/v1/servers", raw: "ip=203.0.113.30", contentType: "application/x-www-form-urlencoded" });
add({ name: "servers: create with a read token", token: "read", method: "POST", path: "/api/v1/servers", body: { ip: "203.0.113.30", private_key_uuid: K_MAIN } });

// ── DP-81: tags, and the tags of an application, a database and a service ─────
/** Team 1's tags and what they are attached to (the other team's rows are not the org's in Freeploy). */
const TAGS_AFTER = {
  tags: "select name, created_at is not null as dated from tags where uuid <> 't4otherteamtag0000000004' order by name",
  taggables: "select t.name, tg.taggable_type, tg.taggable_id from taggables tg join tags t on t.id = tg.tag_id where t.uuid <> 't4otherteamtag0000000004' order by tg.taggable_type, tg.taggable_id, t.name",
};
add({ name: "tags: list", token: "read", method: "GET", path: "/api/v1/tags" });
add({ name: "tags: list, none", token: "read", method: "GET", path: "/api/v1/tags", setup: ["delete from taggables", "delete from tags"] });
add({ name: "tags: create", token: "write", method: "POST", path: "/api/v1/tags", body: { name: "  New-Tag  " }, after: TAGS_AFTER });
add({ name: "tags: create, markup stripped", token: "write", method: "POST", path: "/api/v1/tags", body: { name: "<b>Ops</b> Team" }, after: TAGS_AFTER });
add({ name: "tags: create, another team's name", token: "write", method: "POST", path: "/api/v1/tags", body: { name: "theirs" }, after: TAGS_AFTER });
add({ name: "tags: create, an existing name", token: "write", method: "POST", path: "/api/v1/tags", body: { name: "Backend" }, after: TAGS_AFTER });
add({ name: "tags: create, too short once sanitized", token: "write", method: "POST", path: "/api/v1/tags", body: { name: "<i>a</i>" } });
add({ name: "tags: create, invalid", token: "write", method: "POST", path: "/api/v1/tags", body: { name: "x", color: "red" } });
add({ name: "tags: create, no name", token: "write", method: "POST", path: "/api/v1/tags", body: { label: "x" } });
add({ name: "tags: create, name not a string", token: "write", method: "POST", path: "/api/v1/tags", body: { name: ["ops"] } });
add({ name: "tags: create, name too long", token: "write", method: "POST", path: "/api/v1/tags", body: { name: "a".repeat(256) } });
add({ name: "tags: create, not JSON", token: "write", method: "POST", path: "/api/v1/tags", raw: "name=ops", contentType: "application/x-www-form-urlencoded" });
add({ name: "tags: create, empty JSON", token: "write", method: "POST", path: "/api/v1/tags", raw: "{}" });
add({ name: "tags: update", token: "write", method: "PATCH", path: `/api/v1/tags/${TG_UNUSED}`, body: { name: "Renamed " }, after: TAGS_AFTER });
add({ name: "tags: update to its own name", token: "write", method: "PATCH", path: `/api/v1/tags/${TG_UNUSED}`, body: { name: "UNUSED" }, after: TAGS_AFTER });
add({ name: "tags: update to an existing name", token: "write", method: "PATCH", path: `/api/v1/tags/${TG_UNUSED}`, body: { name: "frontend" } });
add({ name: "tags: update, invalid", token: "write", method: "PATCH", path: `/api/v1/tags/${TG_UNUSED}`, body: { name: "", uuid: "x" } });
add({ name: "tags: update unknown", token: "write", method: "PATCH", path: "/api/v1/tags/nonexistentuuid", body: { name: "renamed" } });
add({ name: "tags: update unknown, invalid", token: "write", method: "PATCH", path: "/api/v1/tags/nonexistentuuid", body: { name: "a" } });
add({ name: "tags: update another team's", token: "write", method: "PATCH", path: `/api/v1/tags/${TG_OTHER}`, body: { name: "mine" } });
add({ name: "tags: delete", token: "delete", method: "DELETE", path: `/api/v1/tags/${TG_BACKEND}`, after: TAGS_AFTER });
add({ name: "tags: delete unknown", token: "delete", method: "DELETE", path: "/api/v1/tags/nonexistentuuid" });
add({ name: "tags: delete another team's", token: "delete", method: "DELETE", path: `/api/v1/tags/${TG_OTHER}` });
add({ name: "tags: delete with a write token", token: "write", method: "DELETE", path: `/api/v1/tags/${TG_UNUSED}` });

for (const [group, base, uuid, other, empty] of [
  ["application", "applications", A_IMAGE, A_OTHER, A_GIT],
  ["database", "databases", DB_REDIS, DB_OTHER, DB_PG],
  ["service", "services", SV_MAIN, SV_OTHER, null],
]) {
  add({ name: `${group} tags: list`, token: "read", method: "GET", path: `/api/v1/${base}/${uuid}/tags` });
  if (empty) add({ name: `${group} tags: list, none`, token: "read", method: "GET", path: `/api/v1/${base}/${empty}/tags` });
  add({ name: `${group} tags: list another team's`, token: "read", method: "GET", path: `/api/v1/${base}/${other}/tags` });
  add({ name: `${group} tags: list of unknown`, token: "read", method: "GET", path: `/api/v1/${base}/nonexistentuuid/tags` });
  add({ name: `${group} tags: add one`, token: "write", method: "POST", path: `/api/v1/${base}/${uuid}/tags`, body: { tag_name: " Unused " }, after: TAGS_AFTER });
  add({ name: `${group} tags: add several`, token: "write", method: "POST", path: `/api/v1/${base}/${uuid}/tags`, body: { tag_names: ["Zeta", "frontend", "<b>alpha</b>", "zeta", "backend"] }, after: TAGS_AFTER });
  add({ name: `${group} tags: add one already there`, token: "write", method: "POST", path: `/api/v1/${base}/${uuid}/tags`, body: { tag_name: "BACKEND" }, after: TAGS_AFTER });
  add({ name: `${group} tags: delete`, token: "delete", method: "DELETE", path: `/api/v1/${base}/${uuid}/tags/${group === "service" ? TG_FRONTEND : TG_BACKEND}`, after: TAGS_AFTER });
  add({ name: `${group} tags: delete one not there`, token: "delete", method: "DELETE", path: `/api/v1/${base}/${uuid}/tags/${TG_UNUSED}` });
  add({ name: `${group} tags: delete unknown`, token: "delete", method: "DELETE", path: `/api/v1/${base}/${uuid}/tags/nonexistentuuid` });
  add({ name: `${group} tags: delete in unknown`, token: "delete", method: "DELETE", path: `/api/v1/${base}/nonexistentuuid/tags/${TG_BACKEND}` });
  add({ name: `${group} tags: add in unknown`, token: "write", method: "POST", path: `/api/v1/${base}/nonexistentuuid/tags`, body: { tag_name: "ops" } });
}
add({ name: "application tags: add a new one to an untagged application", token: "write", method: "POST", path: `/api/v1/applications/${A_GIT}/tags`, body: { tag_names: ["ops", "unused"] }, after: TAGS_AFTER });
add({ name: "application tags: add, both fields", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/tags`, body: { tag_name: "ops", tag_names: ["dev"] } });
add({ name: "application tags: add, neither field", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/tags`, body: { name: "ops" } });
add({ name: "application tags: add, an empty list", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/tags`, body: { tag_names: [] } });
add({ name: "application tags: add, a list that is not one", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/tags`, body: { tag_names: "ops" } });
add({ name: "application tags: add, a name that is not a string", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/tags`, body: { tag_names: ["ops", 5, null] } });
add({ name: "application tags: add, tag_name not a string", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/tags`, body: { tag_name: 12 } });
add({ name: "application tags: add, too short once sanitized", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/tags`, body: { tag_names: ["ok", "<i>a</i>"] } });
add({ name: "application tags: add, not JSON", token: "write", method: "POST", path: `/api/v1/applications/${A_IMAGE}/tags`, raw: "tag_name=ops", contentType: "application/x-www-form-urlencoded" });
add({ name: "application tags: delete another team's tag", token: "delete", method: "DELETE", path: `/api/v1/applications/${A_IMAGE}/tags/${TG_OTHER}` });
add({ name: "database tags: add to a PostgreSQL", token: "write", method: "POST", path: `/api/v1/databases/${DB_PG}/tags`, body: { tag_name: "postgres" }, after: TAGS_AFTER });

// ── DP-81: the shared variables of a project and of an environment ──────────
/**
 * Team 1's project and environment variables (the value is each side's ciphertext; the other team's row is not the org's).
 * A created row's id is the sequence's, which earlier cases moved (a sequence does not roll back): only a fixture's id is read.
 */
const SHARED_AFTER = { variables: "select case when id <= 9 then id end as fixture_id, key, type, project_id, environment_id, server_id, is_shown_once, is_multiline, is_literal, comment, version from shared_environment_variables where type in ('project', 'environment') and key <> 'OTHER_PROJECT' order by id" };
for (const [scope, base, own, others] of [
  ["project envs", `/api/v1/projects/${P_ALPHA}/envs`, { id: 5, key: "PROJECT_FOO", locked: 6 }, { id: 7, theirs: 8 }],
  ["environment envs", `/api/v1/projects/${P_ALPHA}/environments/production/envs`, { id: 7, key: "ENV_FOO", locked: null }, { id: 5, theirs: 8 }],
]) {
  add({ name: `${scope}: list`, token: "read", method: "GET", path: base });
  add({ name: `${scope}: list, read:sensitive`, token: "sensitive", method: "GET", path: base });
  add({ name: `${scope}: create`, token: "write", method: "POST", path: base, body: { key: " NEW_KEY ", value: "  kept  ", is_literal: true, is_multiline: "1", is_shown_once: false, comment: " A comment " }, after: SHARED_AFTER });
  add({ name: `${scope}: create, the fewest fields`, token: "write", method: "POST", path: base, body: { key: "ONLY_KEY", value: "v" }, after: SHARED_AFTER });
  add({ name: `${scope}: create, an existing key`, token: "write", method: "POST", path: base, body: { key: own.key, value: "again" } });
  add({ name: `${scope}: create, invalid`, token: "write", method: "POST", path: base, body: { key: "1BAD-KEY", value: 5, is_literal: "maybe", comment: "x".repeat(257), is_preview: true } });
  add({ name: `${scope}: create, no key`, token: "write", method: "POST", path: base, body: { value: "v" } });
  add({ name: `${scope}: create, not JSON`, token: "write", method: "POST", path: base, raw: "key=A", contentType: "application/x-www-form-urlencoded" });
  add({ name: `${scope}: update`, token: "write", method: "PATCH", path: `${base}/${own.id}`, body: { value: "changed", comment: "Changed", is_multiline: true }, after: SHARED_AFTER });
  add({ name: `${scope}: update, read:sensitive answer`, token: "root", method: "PATCH", path: `${base}/${own.id}`, body: { key: "RENAMED_KEY", is_literal: false }, after: SHARED_AFTER });
  add({ name: `${scope}: update to its own key`, token: "root", method: "PATCH", path: `${base}/${own.id}`, body: { key: ` ${own.key}` } });
  add({ name: `${scope}: update, invalid`, token: "write", method: "PATCH", path: `${base}/${own.id}`, body: { key: "no spaces allowed", is_shown_once: "yes", type: "team" } });
  add({ name: `${scope}: update unknown`, token: "write", method: "PATCH", path: `${base}/999`, body: { value: "x" } });
  add({ name: `${scope}: update another scope's`, token: "write", method: "PATCH", path: `${base}/${others.id}`, body: { value: "x" } });
  add({ name: `${scope}: update another team's`, token: "write", method: "PATCH", path: `${base}/${others.theirs}`, body: { value: "x" } });
  add({ name: `${scope}: delete`, token: "delete", method: "DELETE", path: `${base}/${own.id}`, after: SHARED_AFTER });
  add({ name: `${scope}: delete unknown`, token: "delete", method: "DELETE", path: `${base}/999` });
  add({ name: `${scope}: delete another scope's`, token: "delete", method: "DELETE", path: `${base}/${others.id}` });
  if (own.locked) {
    add({ name: `${scope}: update a locked variable`, token: "root", method: "PATCH", path: `${base}/${own.locked}`, body: { value: "new secret", is_shown_once: false }, after: SHARED_AFTER });
    add({ name: `${scope}: update to an existing key`, token: "write", method: "PATCH", path: `${base}/${own.id}`, body: { key: "PROJECT_SECRET" } });
  }
}
add({ name: "project envs: create a key an environment has", token: "write", method: "POST", path: `/api/v1/projects/${P_ALPHA}/envs`, body: { key: "ENV_FOO", value: "project-level" }, after: SHARED_AFTER });
add({ name: "project envs: list another team's project", token: "read", method: "GET", path: `/api/v1/projects/${P_OTHER}/envs` });
add({ name: "project envs: list of an unknown project", token: "read", method: "GET", path: "/api/v1/projects/nonexistentuuid/envs" });
add({ name: "project envs: list of a project without any", token: "read", method: "GET", path: `/api/v1/projects/${P_BETA}/envs` });
add({ name: "project envs: create in an unknown project", token: "write", method: "POST", path: "/api/v1/projects/nonexistentuuid/envs", body: { key: "A", value: "v" } });
add({ name: "project envs: delete in another team's project", token: "delete", method: "DELETE", path: `/api/v1/projects/${P_OTHER}/envs/8` });
add({ name: "environment envs: list by uuid", token: "sensitive", method: "GET", path: `/api/v1/projects/${P_ALPHA}/environments/${E_STAGING}/envs` });
add({ name: "environment envs: list of an unknown environment", token: "read", method: "GET", path: `/api/v1/projects/${P_ALPHA}/environments/nope/envs` });
add({ name: "environment envs: list of another project's environment", token: "read", method: "GET", path: `/api/v1/projects/${P_BETA}/environments/${E_STAGING}/envs` });
add({ name: "environment envs: list in an unknown project", token: "read", method: "GET", path: "/api/v1/projects/nonexistentuuid/environments/production/envs" });
add({ name: "environment envs: create a key the project has", token: "write", method: "POST", path: `/api/v1/projects/${P_ALPHA}/environments/production/envs`, body: { key: "PROJECT_FOO", value: "env-level" }, after: SHARED_AFTER });
add({ name: "environment envs: create in an unknown environment", token: "write", method: "POST", path: `/api/v1/projects/${P_ALPHA}/environments/nope/envs`, body: { key: "A", value: "v" } });
add({ name: "environment envs: update the staging variable", token: "root", method: "PATCH", path: `/api/v1/projects/${P_ALPHA}/environments/staging/envs/9`, body: { is_shown_once: true }, after: SHARED_AFTER });
add({ name: "environment envs: delete another environment's", token: "delete", method: "DELETE", path: `/api/v1/projects/${P_ALPHA}/environments/production/envs/9` });
add({ name: "environment envs: list with a write-only token", token: "writeOnly", method: "GET", path: `/api/v1/projects/${P_ALPHA}/environments/production/envs` });

// ── DP-81: S3 storages ──────────────────────────────────────────────────────
/**
 * Team 1's storages (the key and secret are each side's ciphertext: their decrypted length is read instead), the schedules
 * that send to one, and their destinations. Host names resolve as emit.php's SafeWebhookUrl::resolveHostsUsing() table says.
 */
const S3_AFTER = {
  storages: "select uuid = 's3paritystorage000000001' as fixture, name, description, region, bucket, endpoint, is_usable, unusable_email_sent, use_path_style_endpoint, type, private_key_id, sftp_host_key, skip_tls_verification from s3_storages where uuid <> 's4otherstorage0000000002' order by name",
  backups: "select uuid, save_s3, s3_storage_id from scheduled_database_backups where uuid <> 'c4otherpgbackup000000004' order by id",
  destinations: "select scheduled_database_backup_id, s3_storage_id from scheduled_database_backup_s3_storage order by scheduled_database_backup_id, s3_storage_id",
};
const NEW_S3 = { name: "API S3", description: "From the API", endpoint: " https://api-s3.example.com ", bucket: " api-bucket ", region: " eu-west-1 ", key: " AKIAAPI ", secret: " api-secret ", is_usable: true };
add({ name: "s3 storages: list", token: "read", method: "GET", path: "/api/v1/s3-storages" });
add({ name: "s3 storages: list, read:sensitive", token: "sensitive", method: "GET", path: "/api/v1/s3-storages" });
add({ name: "s3 storages: list, none", token: "read", method: "GET", path: "/api/v1/s3-storages", setup: ["update scheduled_database_backups set s3_storage_id = null", "delete from scheduled_database_backup_s3_storage", "delete from s3_storages"] });
add({ name: "s3 storages: show", token: "read", method: "GET", path: `/api/v1/s3-storages/${S3_MAIN}` });
add({ name: "s3 storages: show, root", token: "root", method: "GET", path: `/api/v1/s3-storages/${S3_MAIN}` });
add({ name: "s3 storages: show another team's", token: "read", method: "GET", path: `/api/v1/s3-storages/${S3_OTHER}` });
add({ name: "s3 storages: show unknown", token: "read", method: "GET", path: "/api/v1/s3-storages/nonexistentuuid" });
add({ name: "s3 storages: create", token: "write", method: "POST", path: "/api/v1/s3-storages", body: NEW_S3, after: S3_AFTER });
add({ name: "s3 storages: create, the fewest fields", token: "write", method: "POST", path: "/api/v1/s3-storages", body: { name: "Aliyun", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", bucket: "ali-bucket", region: "oss-cn-hangzhou", key: "k", secret: "s" }, after: S3_AFTER });
add({ name: "s3 storages: create with the URL style and TLS", token: "write", method: "POST", path: "/api/v1/s3-storages", body: { type: "s3", name: "Styled", endpoint: "http://minio.example.com:9000", bucket: "styled", region: "us-east-1", key: "k", secret: "s", use_path_style_endpoint: false, skip_tls_verification: "1", is_usable: 0 }, after: S3_AFTER });
add({ name: "s3 storages: create, invalid", token: "write", method: "POST", path: "/api/v1/s3-storages", body: { type: "ftp", name: "x", description: "<b>", endpoint: "ftp://files.example.com", bucket: "A..b", region: 5, key: ["k"], secret: null, use_path_style_endpoint: "maybe", is_usable: 2, extra: 1 } });
add({ name: "s3 storages: create, only a name", token: "write", method: "POST", path: "/api/v1/s3-storages", body: { name: "Only a name" } });
add({ name: "s3 storages: create, an endpoint with credentials", token: "write", method: "POST", path: "/api/v1/s3-storages", body: { ...NEW_S3, endpoint: "https://user:pass@s3.example.com/a%0Ab" } });
add({ name: "s3 storages: create, an endpoint that does not resolve", token: "write", method: "POST", path: "/api/v1/s3-storages", body: { ...NEW_S3, endpoint: "https://unresolvable.example" } });
add({ name: "s3 storages: create, an endpoint too long", token: "write", method: "POST", path: "/api/v1/s3-storages", body: { ...NEW_S3, endpoint: `https://s3.example.com/${"a".repeat(240)}`, region: "r".repeat(256) } });
add({ name: "s3 storages: create an SFTP storage", token: "write", method: "POST", path: "/api/v1/s3-storages", body: { type: "sftp", name: "SFTP box", endpoint: "sftp://files.example.com", key: "backup", secret: "pw" }, after: S3_AFTER });
add({ name: "s3 storages: create, not JSON", token: "write", method: "POST", path: "/api/v1/s3-storages", raw: "name=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "s3 storages: update", token: "write", method: "PATCH", path: `/api/v1/s3-storages/${S3_MAIN}`, body: { name: "Renamed S3", description: null, region: " us-west-2 ", is_usable: false }, after: S3_AFTER });
add({ name: "s3 storages: update the connection", token: "write", method: "PATCH", path: `/api/v1/s3-storages/${S3_MAIN}`, body: { endpoint: "https://other-s3.example.com", bucket: "new-bucket", key: "NEWKEY", secret: " new-secret ", use_path_style_endpoint: false, skip_tls_verification: true }, after: S3_AFTER });
add({ name: "s3 storages: update, invalid", token: "write", method: "PATCH", path: `/api/v1/s3-storages/${S3_MAIN}`, body: { name: "ab", bucket: "x", endpoint: null, key: "", type: "s3", is_usable: "yes" } });
add({ name: "s3 storages: update another team's", token: "write", method: "PATCH", path: `/api/v1/s3-storages/${S3_OTHER}`, body: { name: "Mine now" } });
add({ name: "s3 storages: update unknown", token: "write", method: "PATCH", path: "/api/v1/s3-storages/nonexistentuuid", body: { name: "Mine now" } });
add({ name: "s3 storages: update, empty JSON", token: "write", method: "PATCH", path: `/api/v1/s3-storages/${S3_MAIN}`, raw: "{}" });
add({ name: "s3 storages: delete", token: "delete", method: "DELETE", path: `/api/v1/s3-storages/${S3_MAIN}`, after: S3_AFTER });
add({ name: "s3 storages: delete another team's", token: "delete", method: "DELETE", path: `/api/v1/s3-storages/${S3_OTHER}` });
add({ name: "s3 storages: delete unknown", token: "delete", method: "DELETE", path: "/api/v1/s3-storages/nonexistentuuid" });
add({ name: "s3 storages: validate, an endpoint that does not resolve", token: "write", method: "POST", path: `/api/v1/s3-storages/${S3_MAIN}/validate`, setup: ["update s3_storages set endpoint = 'https://unresolvable.example' where uuid = 's3paritystorage000000001'"], after: S3_AFTER });
add({ name: "s3 storages: validate, an invalid bucket", token: "write", method: "POST", path: `/api/v1/s3-storages/${S3_MAIN}/validate`, setup: ["update s3_storages set bucket = 'A..b' where uuid = 's3paritystorage000000001'"], after: S3_AFTER });
add({ name: "s3 storages: validate another team's", token: "write", method: "POST", path: `/api/v1/s3-storages/${S3_OTHER}/validate` });
add({ name: "s3 storages: validate unknown", token: "write", method: "POST", path: "/api/v1/s3-storages/nonexistentuuid/validate" });

// ── DP-84: the storages of an application, a database and a service ─────────
/**
 * Team 1's volumes and file mounts (the other team's rows are not the org's in Freeploy; a file's content is each side's
 * ciphertext, so only whether it has one is read). A created row's id is the sequence's: only a fixture's id is read.
 */
const STORAGES_AFTER = {
  persistent: "select case when id <= 14 then id end as fixture_id, name, mount_path, host_path, resource_type, resource_id, is_preview_suffix_enabled, standalone_sqlite_id from local_persistent_volumes where not (resource_type = 'App\\Models\\Application' and resource_id = 3) and not (resource_type = 'App\\Models\\StandalonePostgresql' and resource_id = 2) order by id",
  files: "select case when id <= 6 then id end as fixture_id, fs_path, mount_path, content is not null as has_content, is_directory, is_host_file, is_based_on_git, is_preview_suffix_enabled, resource_type, resource_id from local_file_volumes where not (resource_type = 'App\\Models\\Application' and resource_id = 3) order by id",
};
for (const [group, base, uuid, other, empty, notFound] of [
  ["application", "applications", A_IMAGE, A_OTHER, A_GIT, "Application not found."],
  ["database", "databases", DB_PG, DB_OTHER, DB_MYSQL, "Database not found."],
  ["service", "services", SV_MAIN, null, null, "Service not found."],
]) {
  const path = `/api/v1/${base}/${uuid}/storages`;
  /** A service's storages belong to one of its parts (resource_uuid). */
  const part = group === "service" ? { resource_uuid: SA_WEB } : {};
  add({ name: `${group} storages: list`, token: "read", method: "GET", path });
  add({ name: `${group} storages: list, read:sensitive`, token: "sensitive", method: "GET", path });
  if (other) add({ name: `${group} storages: list another team's`, token: "read", method: "GET", path: `/api/v1/${base}/${other}/storages` });
  if (empty) add({ name: `${group} storages: list, none`, token: "read", method: "GET", path: `/api/v1/${base}/${empty}/storages` });
  add({ name: `${group} storages: list of unknown`, token: "read", method: "GET", path: `/api/v1/${base}/nonexistentuuid/storages` });
  add({ name: `${group} storages: create a volume`, token: "write", method: "POST", path, body: { type: "persistent", ...part, name: "cache", mount_path: " cache " }, after: STORAGES_AFTER });
  add({ name: `${group} storages: create a volume, no name`, token: "write", method: "POST", path, body: { type: "persistent", ...part, mount_path: "/cache" } });
  add({ name: `${group} storages: create a volume, file fields`, token: "write", method: "POST", path, body: { type: "persistent", ...part, name: "cache", mount_path: "/cache", content: "x", fs_path: "/srv" } });
  add({ name: `${group} storages: create, invalid`, token: "write", method: "POST", path, body: { type: "volume", name: "-bad name", is_directory: "maybe", content: 5, color: "red" } });
  add({ name: `${group} storages: create, not JSON`, token: "write", method: "POST", path, raw: "type=persistent", contentType: "application/x-www-form-urlencoded" });
  add({ name: `${group} storages: create a host file`, token: "write", method: "POST", path, body: { type: "file", ...part, is_host_file: true, fs_path: " /etc/hostname ", mount_path: "etc/hostname" }, after: STORAGES_AFTER });
  add({ name: `${group} storages: create a host file, no source`, token: "write", method: "POST", path, body: { type: "file", ...part, is_host_file: "1", mount_path: "/etc/hostname" } });
  add({ name: `${group} storages: create a host file with content`, token: "write", method: "POST", path, body: { type: "file", ...part, is_host_file: true, fs_path: "/etc/hostname", mount_path: "/etc/hostname", content: "x" } });
  add({ name: `${group} storages: create a host file, a relative source`, token: "write", method: "POST", path, body: { type: "file", ...part, is_host_file: true, fs_path: "etc/hostname", mount_path: "/etc/hostname" } });
  add({ name: `${group} storages: create a directory that is a host file`, token: "write", method: "POST", path, body: { type: "file", ...part, is_directory: true, is_host_file: true, fs_path: "/srv", mount_path: "/srv" } });
  add({ name: `${group} storages: create a directory, no source`, token: "write", method: "POST", path, body: { type: "file", ...part, is_directory: true, mount_path: "/srv" } });
  add({ name: `${group} storages: create a directory outside, a write token`, token: "write", method: "POST", path, body: { type: "file", ...part, is_directory: true, fs_path: "/srv/data", mount_path: "/srv" } });
  add({ name: `${group} storages: create a directory inside`, token: "root", method: "POST", path, body: { type: "file", ...part, is_directory: true, fs_path: "./data", mount_path: "/srv" }, after: STORAGES_AFTER });
  add({ name: `${group} storages: create a file, a name`, token: "write", method: "POST", path, body: { type: "file", ...part, name: "x", mount_path: "/app/x.conf" } });
  add({ name: `${group} storages: create a file with content, a write token`, token: "write", method: "POST", path, body: { type: "file", ...part, mount_path: "/app/x.conf", content: "a = 1" } });
  add({ name: `${group} storages: create a file`, token: "write", method: "POST", path, body: { type: "file", ...part, mount_path: "/app/x.conf" }, after: STORAGES_AFTER });
  add({ name: `${group} storages: create a file, a path that leaves`, token: "write", method: "POST", path, body: { type: "file", ...part, mount_path: "/app/../../x.conf" } });
  add({ name: `${group} storages: create in unknown`, token: "write", method: "POST", path: `/api/v1/${base}/nonexistentuuid/storages`, body: { type: "persistent", ...part, name: "cache", mount_path: "/cache" } });
  add({ name: `${group} storages: update, neither uuid nor id`, token: "write", method: "PATCH", path, body: { type: "persistent", mount_path: "/x" } });
  add({ name: `${group} storages: update, invalid`, token: "write", method: "PATCH", path, body: { id: "x", is_preview_suffix_enabled: "maybe", name: "bad name", color: "red" } });
  add({ name: `${group} storages: update unknown`, token: "write", method: "PATCH", path, body: { uuid: "nonexistentuuid", type: "persistent", mount_path: "/x" } });
  add({ name: `${group} storages: update a file as a volume`, token: "write", method: "PATCH", path, body: { uuid: group === "database" ? FV_PG : group === "service" ? FV_SERVICE : FV_HOST, type: "persistent", mount_path: "/x" } });
  add({ name: `${group} storages: update in unknown`, token: "write", method: "PATCH", path: `/api/v1/${base}/nonexistentuuid/storages`, body: { uuid: PV_APP, type: "persistent", mount_path: "/x" } });
  add({ name: `${group} storages: delete unknown`, token: "delete", method: "DELETE", path: `${path}/nonexistentuuid` });
  add({ name: `${group} storages: delete in unknown`, token: "delete", method: "DELETE", path: `/api/v1/${base}/nonexistentuuid/storages/${PV_APP}` });
  add({ name: `${group} storages: delete another team's`, token: "delete", method: "DELETE", path: `${path}/${PV_OTHER}` });
}
// An application's volume and file mounts.
const APP_STORAGES = `/api/v1/applications/${A_IMAGE}/storages`;
add({ name: "application storages: create a volume, a name it has", token: "write", method: "POST", path: APP_STORAGES, body: { type: "persistent", name: "data", mount_path: "/other" } });
add({ name: "application storages: create a file with content", token: "root", method: "POST", path: APP_STORAGES, body: { type: "file", mount_path: "/app/x.conf", content: "a = 1" }, after: STORAGES_AFTER });
add({ name: "application storages: create a file outside, a write token", token: "write", method: "POST", path: APP_STORAGES, body: { type: "file", mount_path: "/app/x.conf", fs_path: "/srv/x.conf" } });
add({ name: "application storages: update a volume", token: "write", method: "PATCH", path: APP_STORAGES, body: { uuid: PV_APP, type: "persistent", name: "renamed", mount_path: " data2 ", is_preview_suffix_enabled: false }, after: STORAGES_AFTER });
add({ name: "application storages: update a volume by id", token: "write", method: "PATCH", path: APP_STORAGES, body: { id: 12, type: "persistent", is_preview_suffix_enabled: "0" }, after: STORAGES_AFTER });
add({ name: "application storages: update a volume, content", token: "write", method: "PATCH", path: APP_STORAGES, body: { uuid: PV_APP, type: "persistent", content: "x" } });
add({ name: "application storages: update a host file", token: "write", method: "PATCH", path: APP_STORAGES, body: { uuid: FV_HOST, type: "file", mount_path: "/etc/tz", is_preview_suffix_enabled: false }, after: STORAGES_AFTER });
add({ name: "application storages: update a host file, read:sensitive answer", token: "root", method: "PATCH", path: APP_STORAGES, body: { uuid: FV_HOST, type: "file", is_preview_suffix_enabled: true }, after: STORAGES_AFTER });
add({ name: "application storages: update a file, a name", token: "write", method: "PATCH", path: APP_STORAGES, body: { uuid: FV_CONFIG, type: "file", name: "x" } });
add({ name: "application storages: update a file's content, a write token", token: "write", method: "PATCH", path: APP_STORAGES, body: { uuid: FV_CONFIG, type: "file", content: "{}" } });
add({ name: "application storages: update a file to its own content", token: "write", method: "PATCH", path: APP_STORAGES, body: { uuid: FV_CONFIG, type: "file", content: '{"debug":false}', mount_path: "/app/settings.json" }, after: STORAGES_AFTER });
add({ name: "application storages: update a file's content", token: "root", method: "PATCH", path: APP_STORAGES, body: { uuid: FV_CONFIG, type: "file", content: '{"debug":true}' }, after: STORAGES_AFTER });
add({ name: "application storages: update a directory", token: "write", method: "PATCH", path: APP_STORAGES, body: { id: 3, type: "file", mount_path: "/data/shared" }, after: STORAGES_AFTER });
add({ name: "application storages: update another team's", token: "write", method: "PATCH", path: APP_STORAGES, body: { uuid: PV_OTHER, type: "persistent", mount_path: "/x" } });
add({ name: "application storages: delete a volume", token: "delete", method: "DELETE", path: `${APP_STORAGES}/${PV_APP}`, after: STORAGES_AFTER });
add({ name: "application storages: delete a host file", token: "delete", method: "DELETE", path: `${APP_STORAGES}/${FV_HOST}`, after: STORAGES_AFTER });
add({ name: "application storages: delete a directory outside", token: "delete", method: "DELETE", path: `${APP_STORAGES}/${FV_DIR}`, after: STORAGES_AFTER });
add({ name: "application storages: delete a file inside", token: "delete", method: "DELETE", path: `${APP_STORAGES}/${FV_CONFIG}`, after: STORAGES_AFTER });
// A database's.
const PG_STORAGES = `/api/v1/databases/${DB_PG}/storages`;
add({ name: "database storages: list a Redis", token: "read", method: "GET", path: `/api/v1/databases/${DB_REDIS}/storages` });
add({ name: "database storages: update the data volume", token: "write", method: "PATCH", path: PG_STORAGES, body: { id: 2, type: "persistent", name: "pgdata", is_preview_suffix_enabled: false }, after: STORAGES_AFTER });
add({ name: "database storages: update a file", token: "write", method: "PATCH", path: PG_STORAGES, body: { uuid: FV_PG, type: "file", mount_path: "/docker-entrypoint-initdb.d/01.sql" }, after: STORAGES_AFTER });
add({ name: "database storages: delete the data volume", token: "delete", method: "DELETE", path: `${PG_STORAGES}/k1paritypgdatavolume0001`, setup: [`update local_persistent_volumes set uuid = 'k1paritypgdatavolume0001' where id = 2`], after: STORAGES_AFTER });
add({ name: "database storages: delete a file inside", token: "delete", method: "DELETE", path: `${PG_STORAGES}/${FV_PG}`, after: STORAGES_AFTER });
// A service's: its parts' volumes are the Compose file's (read-only).
const SV_STORAGES = `/api/v1/services/${SV_MAIN}/storages`;
add({ name: "service storages: create, no part", token: "write", method: "POST", path: SV_STORAGES, body: { type: "persistent", name: "cache", mount_path: "/cache" } });
add({ name: "service storages: create in an unknown part", token: "write", method: "POST", path: SV_STORAGES, body: { type: "persistent", resource_uuid: SA_OTHER, name: "cache", mount_path: "/cache" } });
add({ name: "service storages: create a volume of the database", token: "write", method: "POST", path: SV_STORAGES, body: { type: "persistent", resource_uuid: SD_DB, name: "pg", mount_path: "/var/lib/postgresql/data" }, after: STORAGES_AFTER });
add({ name: "service storages: create a host file of the database", token: "write", method: "POST", path: SV_STORAGES, body: { type: "file", resource_uuid: SD_DB, is_host_file: true, fs_path: "/etc/hostname", mount_path: "/etc/hostname" }, after: STORAGES_AFTER });
add({ name: "service storages: update a volume's name", token: "write", method: "PATCH", path: SV_STORAGES, body: { uuid: PV_SERVICE, type: "persistent", name: "renamed", mount_path: "/x" } });
add({ name: "service storages: update a volume's PR suffix", token: "write", method: "PATCH", path: SV_STORAGES, body: { uuid: PV_SERVICE, type: "persistent", is_preview_suffix_enabled: false }, after: STORAGES_AFTER });
add({ name: "service storages: update a file", token: "write", method: "PATCH", path: SV_STORAGES, body: { id: 5, type: "file", mount_path: "/etc/nginx/nginx.conf" }, after: STORAGES_AFTER });
add({ name: "service storages: delete a volume", token: "delete", method: "DELETE", path: `${SV_STORAGES}/${PV_SERVICE}` });
add({ name: "service storages: delete a file inside", token: "delete", method: "DELETE", path: `${SV_STORAGES}/${FV_SERVICE}`, after: STORAGES_AFTER });
add({ name: "service storages: list another team's", token: "read", method: "GET", path: `/api/v1/services/${SV_OTHER}/storages` });
// With a file mount, the list is Coolify's 500 (setAttribute('resource_type', 'application') breaks the file's morphTo); without one:
add({ name: "service storages: list without file mounts", token: "read", method: "GET", path: SV_STORAGES, setup: ["delete from local_file_volumes where resource_type = 'App\\Models\\ServiceApplication'"] });
add({ name: "service storages: list without file mounts, a volume of the database", token: "read", method: "GET", path: SV_STORAGES, setup: ["delete from local_file_volumes where resource_type = 'App\\Models\\ServiceApplication'", "update local_persistent_volumes set resource_type = 'App\\Models\\ServiceDatabase' where uuid = 'l2parityservicevolume002'"] });

// ── DP-84: the scheduled tasks of an application and of a service ───────────
/** Team 1's tasks and their executions (a created task's uuid and id are new: only a fixture's id is read). */
const TASKS_AFTER = {
  tasks: "select case when id <= 4 then id end as fixture_id, enabled, name, command, frequency, container, application_id, service_id, timeout, consecutive_failures, failing_since, disabled_reason, use_shell from scheduled_tasks where uuid <> 'n4otherteamtask000000004' order by id",
  executions: "select uuid, scheduled_task_id, status from scheduled_task_executions where uuid <> 'o3otherteamtaskrun000003' order by id",
};
for (const [group, base, uuid, other, task, notFound] of [
  ["application", "applications", A_IMAGE, A_OTHER, ST_BACKUP, "Application not found."],
  ["service", "services", SV_MAIN, SV_OTHER, ST_SERVICE, "Service not found."],
]) {
  const path = `/api/v1/${base}/${uuid}/scheduled-tasks`;
  add({ name: `${group} scheduled tasks: list`, token: "read", method: "GET", path });
  add({ name: `${group} scheduled tasks: list, read:sensitive`, token: "sensitive", method: "GET", path });
  add({ name: `${group} scheduled tasks: list another team's`, token: "read", method: "GET", path: `/api/v1/${base}/${other}/scheduled-tasks` });
  add({ name: `${group} scheduled tasks: list of unknown`, token: "read", method: "GET", path: `/api/v1/${base}/nonexistentuuid/scheduled-tasks` });
  add({ name: `${group} scheduled tasks: create`, token: "root", method: "POST", path, body: { name: " <b>Nightly</b> report ", command: "php artisan report", frequency: "0 1 * * *", container: "web", timeout: 120, use_shell: false }, after: TASKS_AFTER });
  add({ name: `${group} scheduled tasks: create disabled, a write token`, token: "write", method: "POST", path, body: { name: "later", command: "echo later", frequency: "@weekly", enabled: false }, after: TASKS_AFTER });
  add({ name: `${group} scheduled tasks: create enabled, a write token`, token: "write", method: "POST", path, body: { name: "now", command: "echo now", frequency: "@weekly" } });
  add({ name: `${group} scheduled tasks: create, invalid`, token: "root", method: "POST", path, body: { command: ["x"], frequency: 5, container: 1, timeout: 0, use_shell: "maybe", enabled: "yes", every: "day" } });
  add({ name: `${group} scheduled tasks: create, a bad frequency`, token: "root", method: "POST", path, body: { name: "bad", command: "echo", frequency: "every day" } });
  add({ name: `${group} scheduled tasks: create, not JSON`, token: "root", method: "POST", path, raw: "name=x", contentType: "application/x-www-form-urlencoded" });
  add({ name: `${group} scheduled tasks: create in unknown`, token: "root", method: "POST", path: `/api/v1/${base}/nonexistentuuid/scheduled-tasks`, body: { name: "x", command: "echo", frequency: "@daily" } });
  add({ name: `${group} scheduled tasks: update`, token: "root", method: "PATCH", path: `${path}/${task}`, body: { name: "renamed", frequency: "@hourly", timeout: "90", container: null }, after: TASKS_AFTER });
  add({ name: `${group} scheduled tasks: update, nothing`, token: "root", method: "PATCH", path: `${path}/${task}`, raw: "{}" });
  add({ name: `${group} scheduled tasks: update, invalid`, token: "root", method: "PATCH", path: `${path}/${task}`, body: { name: "", timeout: 36001, uuid: "x" } });
  add({ name: `${group} scheduled tasks: update, a bad frequency`, token: "root", method: "PATCH", path: `${path}/${task}`, body: { frequency: "61 * * * *" } });
  add({ name: `${group} scheduled tasks: update an enabled task, a write token`, token: "write", method: "PATCH", path: `${path}/${task}`, body: { name: "x" } });
  add({ name: `${group} scheduled tasks: update unknown`, token: "root", method: "PATCH", path: `${path}/nonexistentuuid`, body: { name: "x" } });
  add({ name: `${group} scheduled tasks: update unchanged`, token: "root", method: "PATCH", path: `${path}/${task}`, body: { enabled: true }, after: TASKS_AFTER });
  add({ name: `${group} scheduled tasks: delete`, token: "delete", method: "DELETE", path: `${path}/${task}`, after: TASKS_AFTER });
  add({ name: `${group} scheduled tasks: delete unknown`, token: "delete", method: "DELETE", path: `${path}/nonexistentuuid` });
  add({ name: `${group} scheduled tasks: delete another team's`, token: "delete", method: "DELETE", path: `${path}/${ST_OTHER}` });
  add({ name: `${group} scheduled tasks: executions`, token: "read", method: "GET", path: `${path}/${task}/executions` });
  add({ name: `${group} scheduled tasks: executions, read:sensitive`, token: "sensitive", method: "GET", path: `${path}/${task}/executions` });
  add({ name: `${group} scheduled tasks: executions of unknown`, token: "read", method: "GET", path: `${path}/nonexistentuuid/executions` });
  add({ name: `${group} scheduled tasks: executions in unknown`, token: "read", method: "GET", path: `/api/v1/${base}/nonexistentuuid/scheduled-tasks/${task}/executions` });
}
const APP_TASKS = `/api/v1/applications/${A_IMAGE}/scheduled-tasks`;
add({ name: "application scheduled tasks: update a disabled task, a write token", token: "write", method: "PATCH", path: `${APP_TASKS}/${ST_CLEANUP}`, body: { name: "cleanup-tmp", use_shell: "1" }, after: TASKS_AFTER });
add({ name: "application scheduled tasks: enable a task disabled automatically", token: "root", method: "PATCH", path: `${APP_TASKS}/${ST_CLEANUP}`, setup: ["update scheduled_tasks set consecutive_failures = 12, failing_since = '2025-12-20 00:00:00', disabled_reason = 'Disabled automatically after 12 failed runs in a row since 2025-12-20 00:00:00 UTC.' where id = 2"], body: { enabled: true }, after: TASKS_AFTER });
add({ name: "application scheduled tasks: update another resource's task", token: "root", method: "PATCH", path: `${APP_TASKS}/${ST_SERVICE}`, body: { name: "x" } });
add({ name: "application scheduled tasks: executions of a task that never ran", token: "read", method: "GET", path: `${APP_TASKS}/${ST_CLEANUP}/executions` });
add({ name: "application scheduled tasks: list, none", token: "read", method: "GET", path: `/api/v1/applications/${A_GIT}/scheduled-tasks` });
add({ name: "application scheduled tasks: create with a delete token", token: "delete", method: "POST", path: APP_TASKS, body: { name: "x", command: "echo", frequency: "@daily" } });

// ── DP-84: the environment variables of a standalone database ───────────────
/** Team 1's databases' variables (the value is each side's ciphertext). */
const DB_ENVS_AFTER = { variables: "select key, resourceable_type, resourceable_id, is_preview, is_literal, is_multiline, is_shown_once, is_runtime, is_buildtime, is_required, is_shared, comment, \"order\", version from environment_variables where resourceable_type like 'App\\Models\\Standalone%' order by id" };
const REDIS_ENVS = `/api/v1/databases/${DB_REDIS}/envs`;
const PG_ENVS = `/api/v1/databases/${DB_PG}/envs`;
add({ name: "database envs: list", token: "read", method: "GET", path: REDIS_ENVS });
add({ name: "database envs: list, read:sensitive", token: "sensitive", method: "GET", path: REDIS_ENVS });
add({ name: "database envs: list, none", token: "read", method: "GET", path: PG_ENVS });
add({ name: "database envs: list another team's", token: "read", method: "GET", path: `/api/v1/databases/${DB_OTHER}/envs` });
add({ name: "database envs: list of unknown", token: "read", method: "GET", path: "/api/v1/databases/nonexistentuuid/envs" });
add({ name: "database envs: create", token: "write", method: "POST", path: PG_ENVS, body: { key: " PG_MAX_CONN ", value: "100", is_literal: true, comment: "Pool" }, after: DB_ENVS_AFTER });
add({ name: "database envs: create, read:sensitive answer", token: "root", method: "POST", path: PG_ENVS, body: { key: "LOCKED", value: "hidden", is_shown_once: true, is_multiline: "1" }, after: DB_ENVS_AFTER });
add({ name: "database envs: create a shared reference", token: "root", method: "POST", path: PG_ENVS, body: { key: "FROM_PROJECT", value: "{{ project.PROJECT_FOO }}" }, after: DB_ENVS_AFTER });
add({ name: "database envs: create, an existing key", token: "write", method: "POST", path: REDIS_ENVS, body: { key: "REDIS_USERNAME", value: "admin" } });
add({ name: "database envs: create, invalid", token: "write", method: "POST", path: PG_ENVS, body: { key: "1-bad", value: 5, is_literal: "maybe", comment: "x".repeat(257), is_preview: true } });
add({ name: "database envs: create, no key", token: "write", method: "POST", path: PG_ENVS, body: { value: "v" } });
add({ name: "database envs: create in unknown", token: "write", method: "POST", path: "/api/v1/databases/nonexistentuuid/envs", body: { key: "A", value: "v" } });
add({ name: "database envs: update", token: "write", method: "PATCH", path: REDIS_ENVS, body: { key: "REDIS_USERNAME", value: "admin", is_multiline: false, comment: "Changed" }, after: DB_ENVS_AFTER });
add({ name: "database envs: update, read:sensitive answer", token: "root", method: "PATCH", path: REDIS_ENVS, body: { key: " REDIS_PASSWORD", is_literal: true }, after: DB_ENVS_AFTER });
add({ name: "database envs: update unknown", token: "write", method: "PATCH", path: REDIS_ENVS, body: { key: "NOPE", value: "x" } });
add({ name: "database envs: update, invalid", token: "write", method: "PATCH", path: REDIS_ENVS, body: { key: "", is_shown_once: "yes" } });
add({ name: "database envs: bulk", token: "root", method: "PATCH", path: `${REDIS_ENVS}/bulk`, body: { data: [{ key: "REDIS_USERNAME", value: "bulk-user" }, { key: "NEW_ONE", value: "1", is_literal: true, extra: "dropped" }] }, after: DB_ENVS_AFTER });
add({ name: "database envs: bulk, no data", token: "write", method: "PATCH", path: `${REDIS_ENVS}/bulk`, body: { items: [] } });
add({ name: "database envs: bulk, an invalid item", token: "write", method: "PATCH", path: `${REDIS_ENVS}/bulk`, body: { data: [{ key: "GOOD", value: "1" }, { key: "bad key!", value: "2" }] }, after: DB_ENVS_AFTER });
add({ name: "database envs: delete", token: "delete", method: "DELETE", path: `${REDIS_ENVS}/${DB_REDIS.slice(0, 20)}user`, setup: [`update environment_variables set uuid = '${DB_REDIS.slice(0, 20)}user' where key = 'REDIS_USERNAME' and resourceable_type = 'App\\Models\\StandaloneRedis'`], after: DB_ENVS_AFTER });
add({ name: "database envs: delete unknown", token: "delete", method: "DELETE", path: `${REDIS_ENVS}/nonexistentuuid` });
add({ name: "database envs: delete another resource's", token: "delete", method: "DELETE", path: `${PG_ENVS}/${V_FOO}` });

// ── DP-84: the team's shared variables ──────────────────────────────────────
/** Team 1's own variables (the other team's row is not the org's). A created row's id is the sequence's: only a fixture's id is read. */
const TEAM_ENVS_AFTER = { variables: "select case when id <= 12 then id end as fixture_id, key, type, project_id, environment_id, server_id, is_shown_once, is_multiline, is_literal, comment, version from shared_environment_variables where type = 'team' and key <> 'OTHER_TEAM' order by id" };
add({ name: "team envs: list", token: "read", method: "GET", path: "/api/v1/team/envs" });
add({ name: "team envs: list, read:sensitive", token: "sensitive", method: "GET", path: "/api/v1/team/envs" });
add({ name: "team envs: list, none", token: "read", method: "GET", path: "/api/v1/team/envs", setup: ["delete from shared_environment_variables where type = 'team'"] });
add({ name: "team envs: create", token: "write", method: "POST", path: "/api/v1/team/envs", body: { key: " NEW_TEAM_KEY ", value: "  kept  ", is_literal: "1", is_shown_once: false, comment: " A comment " }, after: TEAM_ENVS_AFTER });
add({ name: "team envs: create, a key a project has", token: "write", method: "POST", path: "/api/v1/team/envs", body: { key: "PROJECT_FOO", value: "team-level" }, after: TEAM_ENVS_AFTER });
add({ name: "team envs: create, another team's key", token: "write", method: "POST", path: "/api/v1/team/envs", body: { key: "OTHER_TEAM", value: "mine" }, after: TEAM_ENVS_AFTER });
add({ name: "team envs: create, an existing key", token: "write", method: "POST", path: "/api/v1/team/envs", body: { key: "TEAM_FOO", value: "again" } });
add({ name: "team envs: create, invalid", token: "write", method: "POST", path: "/api/v1/team/envs", body: { key: "1BAD-KEY", value: ["x"], is_multiline: "maybe", type: "project" } });
add({ name: "team envs: create, no key", token: "write", method: "POST", path: "/api/v1/team/envs", body: { value: "v" } });
add({ name: "team envs: create, not JSON", token: "write", method: "POST", path: "/api/v1/team/envs", raw: "key=A", contentType: "application/x-www-form-urlencoded" });
add({ name: "team envs: update", token: "write", method: "PATCH", path: "/api/v1/team/envs/10", body: { value: "changed", comment: "Changed", is_multiline: true }, after: TEAM_ENVS_AFTER });
add({ name: "team envs: update, read:sensitive answer", token: "root", method: "PATCH", path: "/api/v1/team/envs/10", body: { key: "RENAMED_TEAM", is_literal: true }, after: TEAM_ENVS_AFTER });
add({ name: "team envs: update a locked variable", token: "root", method: "PATCH", path: "/api/v1/team/envs/11", body: { value: "new secret", is_shown_once: false }, after: TEAM_ENVS_AFTER });
add({ name: "team envs: update to an existing key", token: "write", method: "PATCH", path: "/api/v1/team/envs/10", body: { key: "TEAM_SECRET" } });
add({ name: "team envs: update, nothing", token: "write", method: "PATCH", path: "/api/v1/team/envs/10", raw: "{}" });
add({ name: "team envs: update, invalid", token: "write", method: "PATCH", path: "/api/v1/team/envs/10", body: { key: "no spaces allowed", comment: 5 } });
add({ name: "team envs: update unknown", token: "write", method: "PATCH", path: "/api/v1/team/envs/999", body: { value: "x" } });
add({ name: "team envs: update unknown, invalid", token: "write", method: "PATCH", path: "/api/v1/team/envs/999", body: { key: "bad key" } });
add({ name: "team envs: update a project's variable", token: "write", method: "PATCH", path: "/api/v1/team/envs/5", body: { value: "x" } });
add({ name: "team envs: update another team's", token: "write", method: "PATCH", path: "/api/v1/team/envs/12", body: { value: "x" } });
add({ name: "team envs: delete", token: "delete", method: "DELETE", path: "/api/v1/team/envs/11", after: TEAM_ENVS_AFTER });
add({ name: "team envs: delete unknown", token: "delete", method: "DELETE", path: "/api/v1/team/envs/999" });
add({ name: "team envs: delete a server's variable", token: "delete", method: "DELETE", path: "/api/v1/team/envs/1" });
add({ name: "team envs: delete another team's", token: "delete", method: "DELETE", path: "/api/v1/team/envs/12" });

// ── DP-85: the team's notification channels ─────────────────────────────────
/** A channel's columns as both sides store them: the encrypted ones read as whether they are set (their ciphertexts differ). */
const NOTIFICATION_EVENTS = ["deployment_success", "deployment_failure", "status_change", "restart_limit_reached", "backup_success", "backup_failure", "scheduled_task_success", "scheduled_task_failure", "docker_cleanup_success", "docker_cleanup_failure", "server_disk_usage", "server_reachable", "server_unreachable", "server_patch", "traefik_outdated", "image_vulnerabilities"];
const NOTIFICATION_COLUMNS = {
  email: { plain: ["smtp_enabled", "smtp_port", "smtp_encryption", "smtp_timeout", "smtp_ehlo_domain", "smtp_server_name", "resend_enabled", "use_instance_email_settings", "deployment_commit_details_email_notifications"], encrypted: ["smtp_from_address", "smtp_from_name", "smtp_recipients", "smtp_host", "smtp_username", "smtp_password", "resend_api_key", "resend_from_address", "resend_from_name", "smtp_servers"] },
  discord: { plain: ["discord_enabled", "discord_ping_enabled"], encrypted: ["discord_webhook_url"] },
  slack: { plain: ["slack_enabled"], encrypted: ["slack_webhook_url"] },
  telegram: { plain: ["telegram_enabled"], encrypted: ["telegram_token", "telegram_chat_id", ...NOTIFICATION_EVENTS.map((e) => `telegram_notifications_${e}_thread_id`)] },
  pushover: { plain: ["pushover_enabled"], encrypted: ["pushover_user_key", "pushover_api_token"] },
  webhook: { plain: ["webhook_enabled"], encrypted: ["webhook_url"] },
};
/** Team 1's row of a channel (id 1 on both sides: the fixture makes team 1's rows first). */
const notificationAfter = (channel) => {
  const { plain, encrypted } = NOTIFICATION_COLUMNS[channel];
  const columns = ["id", ...plain, ...NOTIFICATION_EVENTS.map((e) => `${e}_${channel}_notifications`), ...encrypted.map((c) => `${c} is not null as has_${c}`), "failure_count"];
  return { settings: `select ${columns.join(", ")} from ${channel}_notification_settings where id = 1` };
};
const NOTIFY = (channel) => `/api/v1/notifications/${channel}`;
/** SafeSmtpHost as on Coolify Cloud (private networks blocked), which Freeploy is: `self_hosted` off for the case. */
const CLOUD = { self_hosted: false };
for (const channel of ["email", "discord", "slack", "telegram", "pushover", "webhook"]) {
  add({ name: `notifications ${channel}: show`, token: "read", method: "GET", path: NOTIFY(channel) });
  add({ name: `notifications ${channel}: show, read:sensitive`, token: "sensitive", method: "GET", path: NOTIFY(channel) });
  add({ name: `notifications ${channel}: show, a member`, token: "memberRead", method: "GET", path: NOTIFY(channel) });
  add({ name: `notifications ${channel}: update, not JSON`, token: "write", method: "PATCH", path: NOTIFY(channel), raw: `${channel}_enabled=1`, contentType: "application/x-www-form-urlencoded" });
  add({ name: `notifications ${channel}: update, empty`, token: "write", method: "PATCH", path: NOTIFY(channel), raw: "{}" });
  add({ name: `notifications ${channel}: update, a field of another channel`, token: "write", method: "PATCH", path: NOTIFY(channel), body: { team_id: 2, [`${channel === "email" ? "discord" : "email"}_enabled`]: true, [`deployment_success_${channel}_notifications`]: "maybe" }, after: notificationAfter(channel) });
  add({ name: `notifications ${channel}: update the events`, token: "write", method: "PATCH", path: NOTIFY(channel), body: { [`deployment_success_${channel}_notifications`]: "1", [`backup_failure_${channel}_notifications`]: 0, [`docker_cleanup_success_${channel}_notifications`]: true, [`image_vulnerabilities_${channel}_notifications`]: false }, after: notificationAfter(channel) });
  add({ name: `notifications ${channel}: update the events, a failure count kept`, token: "write", method: "PATCH", path: NOTIFY(channel), setup: [`update ${channel}_notification_settings set failure_count = 2 where id = 1`], body: { [`backup_failure_${channel}_notifications`]: true, [`docker_cleanup_failure_${channel}_notifications`]: true }, after: notificationAfter(channel) });
  // docker_cleanup_*_notifications has no cast on most channels (the casts name docker_cleanup_<channel>_notifications): "1" is not true.
  add({ name: `notifications ${channel}: update an event to the same value as a string`, token: "write", method: "PATCH", path: NOTIFY(channel), setup: [`update ${channel}_notification_settings set failure_count = 2 where id = 1`], body: { [`docker_cleanup_failure_${channel}_notifications`]: "1", [`backup_failure_${channel}_notifications`]: "1" }, after: notificationAfter(channel) });
}
add({ name: "notifications email: show, a member with read:sensitive", token: "memberSensitive", method: "GET", path: NOTIFY("email") });
add({ name: "notifications email: update", token: "write", config: CLOUD, method: "PATCH", path: NOTIFY("email"), body: { smtp_enabled: true, smtp_from_address: "alerts@example.com", smtp_from_name: " Parity Alerts ", smtp_recipients: "ops@example.com,dev@example.com", smtp_host: "SMTP.Example.com", smtp_port: "587", smtp_encryption: "starttls", smtp_username: "mailer", smtp_password: " secret pass ", smtp_timeout: 30, smtp_ehlo_domain: "mail.example.com" }, after: notificationAfter("email") });
add({ name: "notifications email: update, read:sensitive answer", token: "root", config: CLOUD, method: "PATCH", path: NOTIFY("email"), body: { resend_enabled: true, resend_api_key: "re_parity_key", resend_from_address: "resend@example.com", resend_from_name: "Parity", use_instance_email_settings: "0", smtp_host: "203.0.113.25" }, after: notificationAfter("email") });
add({ name: "notifications email: update to nulls", token: "root", method: "PATCH", path: NOTIFY("email"), setup: ["update email_notification_settings set smtp_port = 25, smtp_timeout = 10, smtp_encryption = 'tls', failure_count = 1 where id = 1"], body: { smtp_port: null, smtp_timeout: "", smtp_encryption: null, smtp_from_address: "", smtp_host: null }, after: notificationAfter("email") });
add({ name: "notifications email: update, invalid", token: "write", config: CLOUD, method: "PATCH", path: NOTIFY("email"), body: { smtp_enabled: "yes", smtp_from_address: "not-an-email", smtp_from_name: "x".repeat(256), smtp_recipients: ["a@example.com"], smtp_host: "bad host!", smtp_port: 70000, smtp_encryption: "ssl", smtp_username: 5, smtp_timeout: -1, smtp_ehlo_domain: "-bad-.example", resend_from_address: "a b@example.com", resend_api_key: false, smtp_server_name: "Main", smtp_servers: [] } });
add({ name: "notifications email: update, a port that is not an integer", token: "write", method: "PATCH", path: NOTIFY("email"), body: { smtp_port: "25.5", smtp_timeout: "ten" } });
for (const [label, host] of [["an unresolvable SMTP host", "unresolvable.example"], ["a private SMTP host", "10.0.0.5"], ["an SMTP host that resolves to a private address", "private.example"], ["a link-local SMTP host", "169.254.169.254"], ["localhost as the SMTP host", "localhost"], ["an internal SMTP host name", "mail.internal"], ["an SMTP host with a trailing dot", "smtp.example.com."], ["an IPv6 SMTP host", "[2001:db8::1]"], ["a public IPv6 SMTP host", "[2606:4700::1111]"]]) {
  add({ name: `notifications email: update, ${label}`, token: "write", config: CLOUD, method: "PATCH", path: NOTIFY("email"), body: { smtp_host: host }, after: notificationAfter("email") });
}
add({ name: "notifications discord: update", token: "write", method: "PATCH", path: NOTIFY("discord"), body: { discord_enabled: true, discord_webhook_url: "https://discord.com/api/webhooks/1/parity", discord_ping_enabled: false, server_patch_discord_notifications: "0" }, after: notificationAfter("discord") });
add({ name: "notifications discord: update, read:sensitive answer", token: "root", method: "PATCH", path: NOTIFY("discord"), body: { discord_webhook_url: "https://discord.com/api/webhooks/2/parity" }, after: notificationAfter("discord") });
add({ name: "notifications discord: update, invalid", token: "write", method: "PATCH", path: NOTIFY("discord"), body: { discord_enabled: "on", discord_webhook_url: 5, discord_ping_enabled: null } });
for (const [label, url] of [["not a URL", "discord webhook"], ["another scheme", "ftp://discord.com/hook"], ["a host that does not resolve", "https://unresolvable.example/hook"], ["a link-local address", "http://169.254.169.254/latest/meta-data"], ["a host with a trailing dot", "https://discord.com./api/webhooks"], ["a URL without a host", "https:///hook"]]) {
  add({ name: `notifications discord: update, ${label}`, token: "write", method: "PATCH", path: NOTIFY("discord"), body: { discord_webhook_url: url }, after: notificationAfter("discord") });
}
add({ name: "notifications discord: update to null", token: "write", method: "PATCH", path: NOTIFY("discord"), body: { discord_webhook_url: null, discord_enabled: false }, after: notificationAfter("discord") });
add({ name: "notifications slack: update", token: "root", method: "PATCH", path: NOTIFY("slack"), body: { slack_enabled: 1, slack_webhook_url: "https://hooks.slack.com/services/T000/B000/parity" }, after: notificationAfter("slack") });
add({ name: "notifications slack: update, invalid", token: "write", method: "PATCH", path: NOTIFY("slack"), body: { slack_enabled: 2, slack_webhook_url: "mailto:ops@example.com", discord_ping_enabled: true } });
add({ name: "notifications telegram: update", token: "root", method: "PATCH", path: NOTIFY("telegram"), body: { telegram_enabled: true, telegram_token: "123456:parity-token", telegram_chat_id: "-100123", telegram_notifications_deployment_success_thread_id: "42", telegram_notifications_image_vulnerabilities_thread_id: "7" }, after: notificationAfter("telegram") });
add({ name: "notifications telegram: update, a write token", token: "write", method: "PATCH", path: NOTIFY("telegram"), body: { telegram_chat_id: "-100999", telegram_notifications_backup_failure_thread_id: null }, after: notificationAfter("telegram") });
add({ name: "notifications telegram: update, invalid", token: "write", method: "PATCH", path: NOTIFY("telegram"), body: { telegram_token: 5, telegram_chat_id: "x".repeat(256), telegram_notifications_server_patch_thread_id: ["1"], telegram_enabled: "true" } });
add({ name: "notifications pushover: update", token: "root", method: "PATCH", path: NOTIFY("pushover"), body: { pushover_enabled: "1", pushover_user_key: "parity-user-key", pushover_api_token: "parity-api-token", status_change_pushover_notifications: true }, after: notificationAfter("pushover") });
add({ name: "notifications pushover: update, invalid", token: "write", method: "PATCH", path: NOTIFY("pushover"), body: { pushover_user_key: "k".repeat(256), pushover_api_token: true } });
add({ name: "notifications webhook: update", token: "root", method: "PATCH", path: NOTIFY("webhook"), body: { webhook_enabled: true, webhook_url: "https://hooks.example.com/coolify?team=1" }, after: notificationAfter("webhook") });
add({ name: "notifications webhook: update, a write token", token: "write", method: "PATCH", path: NOTIFY("webhook"), body: { webhook_url: "http://93.184.216.34/hook", server_patch_webhook_notifications: true }, after: notificationAfter("webhook") });
add({ name: "notifications webhook: update, invalid", token: "write", method: "PATCH", path: NOTIFY("webhook"), body: { webhook_url: "javascript:alert(1)", webhook_enabled: [] } });
add({ name: "notifications: an unknown channel", token: "read", method: "GET", path: "/api/v1/notifications/sms" });
add({ name: "notifications: update with a read token", token: "read", method: "PATCH", path: NOTIFY("email"), body: { smtp_enabled: true } });

// ── DP-85: a service's applications and databases ───────────────────────────
const SVC_APPS = `/api/v1/services/${SV_MAIN}/applications`;
const SVC_DBS = `/api/v1/services/${SV_MAIN}/databases`;
/** isFunctional(): the fixture's server, reachable and usable. */
const FUNCTIONAL = ["update server_settings set is_reachable = true, is_usable = true where server_id = 1"];
/** Team 1's service, its parts and variables as both sides store them. */
const SERVICE_PARTS_AFTER = {
  service: `select docker_compose_raw, docker_compose from services where uuid = '${SV_MAIN}'`,
  applications: `select uuid, name, human_name, description, fqdn, noindex_domains::jsonb::text as noindex_domains, redirect, domain_port_overrides::jsonb::text as domain_port_overrides, image, exclude_from_status, is_log_drain_enabled, is_gzip_enabled, is_stripprefix_enabled, is_force_https_enabled, is_permanent_redirect_enabled, traefik_certificate_resolver, max_restart_count, restart_limit_reached from service_applications where service_id = 1 order by id`,
  databases: `select uuid, name, human_name, description, image, exclude_from_status, is_log_drain_enabled, is_public, public_port, public_port_timeout from service_databases where service_id = 1 order by id`,
  variables: `select key, is_preview, is_shown_once, comment from environment_variables where resourceable_type = 'App\\Models\\Service' and resourceable_id = 1 order by key`,
};
add({ name: "service applications: list", token: "read", method: "GET", path: SVC_APPS });
add({ name: "service applications: list, read:sensitive", token: "sensitive", method: "GET", path: SVC_APPS });
add({ name: "service applications: list of unknown", token: "read", method: "GET", path: "/api/v1/services/nonexistentuuid/applications" });
add({ name: "service applications: list another team's", token: "read", method: "GET", path: `/api/v1/services/${SV_OTHER}/applications` });
add({ name: "service applications: show", token: "read", method: "GET", path: `${SVC_APPS}/${SA_WEB}` });
add({ name: "service applications: show with domains and overrides", token: "read", method: "GET", path: `${SVC_APPS}/${SA_WEB}`, setup: [`update service_applications set fqdn = 'https://web.example.com:8080,http://www.web.example.com', domain_port_overrides = '{"https://web.example.com":8080}', noindex_domains = '["http://www.web.example.com"]', human_name = 'Web' where id = 1`] });
add({ name: "service applications: show unknown", token: "read", method: "GET", path: `${SVC_APPS}/nonexistentuuid` });
add({ name: "service applications: show another service's", token: "read", method: "GET", path: `${SVC_APPS}/${SA_OTHER}` });
add({ name: "service applications: show a database as an application", token: "read", method: "GET", path: `${SVC_APPS}/${SD_DB}` });
add({ name: "service applications: show in unknown", token: "read", method: "GET", path: `/api/v1/services/nonexistentuuid/applications/${SA_WEB}` });
add({ name: "service applications: update", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { human_name: "Web", description: "The web part", exclude_from_status: "1", is_gzip_enabled: false, is_stripprefix_enabled: 0, is_force_https_enabled: false, is_permanent_redirect_enabled: true, traefik_certificate_resolver: "letsencrypt", max_restart_count: 5 }, after: SERVICE_PARTS_AFTER });
add({ name: "service applications: update the url", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { url: ",https://New.example.com, https://www.new.example.com," }, after: SERVICE_PARTS_AFTER });
add({ name: "service applications: update the url with a port", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { url: "https://web.example.com:8443" }, after: SERVICE_PARTS_AFTER });
add({ name: "service applications: update the url and the redirect", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { url: "https://www.web.example.com,https://web.example.com", redirect: "www", noindex_domains: ["https://www.web.example.com", "https://elsewhere.example.com", 5] }, after: SERVICE_PARTS_AFTER });
add({ name: "service applications: update the url, the redirect and the noindex flags", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { url: "https://www.web.example.com,https://web.example.com:8080", redirect: "non-www", noindex_domains: ["HTTPS://WWW.web.example.com", "https://web.example.com:9999", "https://elsewhere.example.com"] }, after: SERVICE_PARTS_AFTER });
add({ name: "service applications: update the url to none", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { url: null, noindex_domains: null }, after: SERVICE_PARTS_AFTER });
add({ name: "service applications: update the url, a conflict", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { url: "https://image.example.com" }, after: SERVICE_PARTS_AFTER });
add({ name: "service applications: update the url, a conflict forced", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}?force_domain_override=true`, body: { url: "https://image.example.com" }, after: SERVICE_PARTS_AFTER });
add({ name: "service applications: update the url, invalid", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { url: "https://bad domain!.example.com" } });
add({ name: "service applications: update the url, duplicates", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { url: "https://a.example.com,https://a.example.com" } });
add({ name: "service applications: update the url, not a string", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { url: 5 } });
add({ name: "service applications: update the redirect without both domains", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { redirect: "non-www" }, after: SERVICE_PARTS_AFTER });
add({ name: "service applications: update the redirect, invalid", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { redirect: "sometimes" } });
add({ name: "service applications: update the image", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { image: "nginx:1.27-alpine" }, after: SERVICE_PARTS_AFTER });
add({ name: "service applications: update the log drain, off on the server", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { human_name: "Before", is_log_drain_enabled: true }, after: SERVICE_PARTS_AFTER });
add({ name: "service applications: update the log drain off", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { is_log_drain_enabled: "0", traefik_certificate_resolver: "" }, after: SERVICE_PARTS_AFTER });
add({ name: "service applications: update, invalid", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, body: { human_name: 5, description: ["x"], image: false, exclude_from_status: "maybe", traefik_certificate_resolver: "bad resolver!", max_restart_count: -1, noindex_domains: "https://web.example.com", name: "renamed", force_domain_override: true } });
add({ name: "service applications: update, empty", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, raw: "{}" });
add({ name: "service applications: update, not JSON", token: "write", method: "PATCH", path: `${SVC_APPS}/${SA_WEB}`, raw: "human_name=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "service applications: update unknown", token: "write", method: "PATCH", path: `${SVC_APPS}/nonexistentuuid`, body: { human_name: "x" } });
add({ name: "service applications: update another team's", token: "write", method: "PATCH", path: `/api/v1/services/${SV_OTHER}/applications/${SA_OTHER}`, body: { human_name: "x" } });
for (const action of ["start", "restart", "stop"]) {
  add({ name: `service applications: ${action}, the server not functional`, token: "root", method: "POST", path: `${SVC_APPS}/${SA_WEB}/${action}` });
  add({ name: `service applications: ${action}`, token: "root", method: "POST", path: `${SVC_APPS}/${SA_WEB}/${action}`, setup: FUNCTIONAL });
  add({ name: `service applications: ${action} unknown`, token: "root", method: "POST", path: `${SVC_APPS}/nonexistentuuid/${action}` });
  add({ name: `service applications: ${action} with GET`, token: "root", method: "GET", path: `${SVC_APPS}/${SA_WEB}/${action}` });
  add({ name: `service databases: ${action}, the server not functional`, token: "root", method: "POST", path: `${SVC_DBS}/${SD_DB}/${action}` });
  add({ name: `service databases: ${action}`, token: "root", method: "POST", path: `${SVC_DBS}/${SD_DB}/${action}`, setup: FUNCTIONAL });
  add({ name: `service databases: ${action} unknown`, token: "root", method: "POST", path: `${SVC_DBS}/nonexistentuuid/${action}` });
}
add({ name: "service applications: start with a write token", token: "write", method: "POST", path: `${SVC_APPS}/${SA_WEB}/start` });
add({ name: "service applications: logs, the server not functional", token: "root", method: "GET", path: `${SVC_APPS}/${SA_WEB}/logs` });
add({ name: "service applications: logs with POST, the server not functional", token: "root", method: "POST", path: `${SVC_APPS}/${SA_WEB}/logs` });
add({ name: "service applications: logs", token: "root", method: "GET", path: `${SVC_APPS}/${SA_WEB}/logs?lines=50`, setup: FUNCTIONAL });
add({ name: "service applications: logs of unknown", token: "root", method: "GET", path: `${SVC_APPS}/nonexistentuuid/logs` });
add({ name: "service applications: logs with a read token", token: "read", method: "GET", path: `${SVC_APPS}/${SA_WEB}/logs` });
add({ name: "service databases: logs, the server not functional", token: "root", method: "GET", path: `${SVC_DBS}/${SD_DB}/logs` });
add({ name: "service databases: logs", token: "root", method: "GET", path: `${SVC_DBS}/${SD_DB}/logs`, setup: FUNCTIONAL });
add({ name: "service databases: logs of unknown", token: "root", method: "GET", path: `${SVC_DBS}/nonexistentuuid/logs` });
add({ name: "service databases: list", token: "read", method: "GET", path: SVC_DBS });
add({ name: "service databases: list, read:sensitive", token: "sensitive", method: "GET", path: SVC_DBS });
add({ name: "service databases: list of unknown", token: "read", method: "GET", path: "/api/v1/services/nonexistentuuid/databases" });
add({ name: "service databases: show", token: "read", method: "GET", path: `${SVC_DBS}/${SD_DB}` });
add({ name: "service databases: show unknown", token: "read", method: "GET", path: `${SVC_DBS}/nonexistentuuid` });
add({ name: "service databases: show an application as a database", token: "read", method: "GET", path: `${SVC_DBS}/${SA_WEB}` });
add({ name: "service databases: update", token: "write", method: "PATCH", path: `${SVC_DBS}/${SD_DB}`, body: { human_name: "Database", description: "The db part", exclude_from_status: true, public_port: 5440, public_port_timeout: "3600" }, after: SERVICE_PARTS_AFTER });
add({ name: "service databases: update the image", token: "write", method: "PATCH", path: `${SVC_DBS}/${SD_DB}`, body: { image: "postgres:17-alpine" }, after: SERVICE_PARTS_AFTER });
add({ name: "service databases: make public, no port", token: "root", method: "PATCH", path: `${SVC_DBS}/${SD_DB}`, body: { is_public: true } });
add({ name: "service databases: make public, a write token", token: "write", method: "PATCH", path: `${SVC_DBS}/${SD_DB}`, body: { is_public: true, public_port: 5440 } });
add({ name: "service databases: make public, a port another database of the same id has", token: "root", method: "PATCH", path: `${SVC_DBS}/${SD_DB}`, body: { is_public: true, public_port: 5433 }, after: SERVICE_PARTS_AFTER });
add({ name: "service databases: make private", token: "root", method: "PATCH", path: `${SVC_DBS}/${SD_DB}`, setup: ["update service_databases set is_public = true, public_port = 5441 where id = 1"], body: { is_public: false }, after: SERVICE_PARTS_AFTER });
add({ name: "service databases: update a public database's port", token: "write", method: "PATCH", path: `${SVC_DBS}/${SD_DB}`, setup: ["update service_databases set is_public = true, public_port = 5441 where id = 1"], body: { public_port: 5442, is_public: "1" }, after: SERVICE_PARTS_AFTER });
add({ name: "service databases: update the log drain, off on the server", token: "write", method: "PATCH", path: `${SVC_DBS}/${SD_DB}`, body: { is_log_drain_enabled: 1 } });
add({ name: "service databases: update, invalid", token: "write", method: "PATCH", path: `${SVC_DBS}/${SD_DB}`, body: { human_name: "x".repeat(256), description: 5, image: null, is_public: "maybe", public_port: 70000, public_port_timeout: 0, name: "renamed" } });
add({ name: "service databases: update, empty", token: "write", method: "PATCH", path: `${SVC_DBS}/${SD_DB}`, raw: "{}" });
add({ name: "service databases: update unknown", token: "write", method: "PATCH", path: `${SVC_DBS}/nonexistentuuid`, body: { human_name: "x" } });
add({ name: "service databases: update in unknown", token: "write", method: "PATCH", path: `/api/v1/services/nonexistentuuid/databases/${SD_DB}`, body: { human_name: "x" } });

// ── DP-85: a server's shared variables ──────────────────────────────────────
/** Team 1's server's variables (its created hook's two first). A created row's id is the sequence's: only a fixture's id is read. */
const SERVER_ENVS_AFTER = { variables: "select case when id <= 12 then id end as fixture_id, key, type, project_id, environment_id, server_id, is_shown_once, is_multiline, is_literal, comment, version from shared_environment_variables where type = 'server' and server_id = 1 order by id" };
const SERVER_ENVS = `/api/v1/servers/${S_MAIN}/envs`;
add({ name: "server envs: list", token: "read", method: "GET", path: SERVER_ENVS });
add({ name: "server envs: list, read:sensitive", token: "sensitive", method: "GET", path: SERVER_ENVS });
add({ name: "server envs: list of unknown", token: "read", method: "GET", path: "/api/v1/servers/nonexistentuuid/envs" });
add({ name: "server envs: list another team's", token: "read", method: "GET", path: `/api/v1/servers/${S_OTHER}/envs` });
add({ name: "server envs: create", token: "write", method: "POST", path: SERVER_ENVS, body: { key: " NEW_SERVER_KEY ", value: "  kept  ", is_multiline: true, is_shown_once: "0", comment: "On the server" }, after: SERVER_ENVS_AFTER });
add({ name: "server envs: create, a key the team has", token: "write", method: "POST", path: SERVER_ENVS, body: { key: "TEAM_FOO", value: "server-level", is_literal: 1 }, after: SERVER_ENVS_AFTER });
add({ name: "server envs: create, a key of the server", token: "write", method: "POST", path: SERVER_ENVS, body: { key: "COOLIFY_SERVER_NAME", value: "again" } });
add({ name: "server envs: create, invalid", token: "write", method: "POST", path: SERVER_ENVS, body: { key: "bad key", value: 5, comment: "x".repeat(257), server_id: 2 } });
add({ name: "server envs: create, not JSON", token: "write", method: "POST", path: SERVER_ENVS, raw: "key=A", contentType: "application/x-www-form-urlencoded" });
add({ name: "server envs: create in unknown", token: "write", method: "POST", path: "/api/v1/servers/nonexistentuuid/envs", body: { key: "A", value: "v" } });
add({ name: "server envs: update", token: "write", method: "PATCH", path: `${SERVER_ENVS}/2`, body: { value: "renamed-server", comment: "Changed" }, after: SERVER_ENVS_AFTER });
add({ name: "server envs: update, read:sensitive answer", token: "root", method: "PATCH", path: `${SERVER_ENVS}/1`, body: { is_shown_once: true, is_literal: "1" }, after: SERVER_ENVS_AFTER });
add({ name: "server envs: update to an existing key", token: "write", method: "PATCH", path: `${SERVER_ENVS}/1`, body: { key: "COOLIFY_SERVER_NAME" } });
add({ name: "server envs: update, nothing", token: "write", method: "PATCH", path: `${SERVER_ENVS}/1`, raw: "{}" });
add({ name: "server envs: update, invalid", token: "write", method: "PATCH", path: `${SERVER_ENVS}/1`, body: { is_literal: "maybe", key: "1-bad" } });
add({ name: "server envs: update unknown", token: "write", method: "PATCH", path: `${SERVER_ENVS}/999`, body: { value: "x" } });
add({ name: "server envs: update the team's variable", token: "write", method: "PATCH", path: `${SERVER_ENVS}/10`, body: { value: "x" } });
add({ name: "server envs: update another server's", token: "write", method: "PATCH", path: `${SERVER_ENVS}/3`, body: { value: "x" } });
add({ name: "server envs: update in unknown", token: "write", method: "PATCH", path: "/api/v1/servers/nonexistentuuid/envs/1", body: { value: "x" } });
add({ name: "server envs: delete", token: "delete", method: "DELETE", path: `${SERVER_ENVS}/2`, after: SERVER_ENVS_AFTER });
add({ name: "server envs: delete unknown", token: "delete", method: "DELETE", path: `${SERVER_ENVS}/999` });
add({ name: "server envs: delete a project's variable", token: "delete", method: "DELETE", path: `${SERVER_ENVS}/5` });
add({ name: "server envs: delete another team's", token: "delete", method: "DELETE", path: `/api/v1/servers/${S_OTHER}/envs/3` });

// ── DP-85: destinations ─────────────────────────────────────────────────────
/** The fixture's default destination is named by each side's product (coolify, freeploy): the cases that show it name it first. */
const NAMED_DESTINATION = ["update standalone_dockers set name = 'parity-destination' where id = 1"];
const SWARM_SERVER = ["update server_settings set is_swarm_manager = true where server_id = 1"];
/** Team 1's destinations (the other team's are not the org's). A created row's uuid is the request's. */
const DESTINATIONS_AFTER = {
  standalone: "select case when uuid = 'd1paritydestination00001' then uuid end as fixture_uuid, case when uuid = 'd1paritydestination00001' and name in ('coolify', 'freeploy') then '<default-destination-name>' else name end as name, network, server_id from standalone_dockers where server_id = 1 order by id",
  swarm: "select name, network, server_id from swarm_dockers where server_id = 1 order by id",
};
add({ name: "destinations: list", token: "read", method: "GET", path: "/api/v1/destinations", setup: NAMED_DESTINATION });
add({ name: "destinations: list of a server", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}/destinations`, setup: NAMED_DESTINATION });
add({ name: "destinations: list of unknown server", token: "read", method: "GET", path: "/api/v1/servers/nonexistentuuid/destinations" });
add({ name: "destinations: list of another team's server", token: "read", method: "GET", path: `/api/v1/servers/${S_OTHER}/destinations` });
add({ name: "destinations: show", token: "read", method: "GET", path: `/api/v1/destinations/${D_MAIN}`, setup: NAMED_DESTINATION });
add({ name: "destinations: show unknown", token: "read", method: "GET", path: "/api/v1/destinations/nonexistentuuid" });
add({ name: "destinations: show another team's", token: "read", method: "GET", path: `/api/v1/destinations/${D_OTHER}` });
const NEW_DESTINATION = `/api/v1/servers/${S_MAIN}/destinations`;
add({ name: "destinations: create, the server not functional", token: "write", method: "POST", path: NEW_DESTINATION, body: { network: "parity-net" }, after: DESTINATIONS_AFTER });
add({ name: "destinations: create", token: "write", method: "POST", path: NEW_DESTINATION, setup: FUNCTIONAL, body: { network: "parity-net", name: "Parity network" }, after: DESTINATIONS_AFTER });
add({ name: "destinations: create on a Swarm server", token: "write", method: "POST", path: NEW_DESTINATION, setup: SWARM_SERVER, body: { network: "parity-swarm", type: "swarm" }, after: DESTINATIONS_AFTER });
add({ name: "destinations: create on a Swarm server, named", token: "root", method: "POST", path: NEW_DESTINATION, setup: SWARM_SERVER, body: { network: "named.swarm-1", name: "Swarm one" }, after: DESTINATIONS_AFTER });
add({ name: "destinations: create on a Swarm server, an existing network", token: "write", method: "POST", path: NEW_DESTINATION, setup: SWARM_SERVER, body: { network: "coolify", type: "swarm" }, after: DESTINATIONS_AFTER });
add({ name: "destinations: create, the wrong type", token: "write", method: "POST", path: NEW_DESTINATION, body: { network: "parity-net", type: "swarm" } });
add({ name: "destinations: create, an existing network", token: "write", method: "POST", path: NEW_DESTINATION, body: { network: "coolify" } });
add({ name: "destinations: create, a reserved network", token: "write", method: "POST", path: NEW_DESTINATION, body: { network: "Bridge" } });
add({ name: "destinations: create, invalid", token: "write", method: "POST", path: NEW_DESTINATION, body: { network: "-bad", type: "overlay", name: 5, server_id: 2 } });
add({ name: "destinations: create, no network", token: "write", method: "POST", path: NEW_DESTINATION, body: { name: "x".repeat(256) } });
add({ name: "destinations: create, not JSON", token: "write", method: "POST", path: NEW_DESTINATION, raw: "network=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "destinations: create on unknown server", token: "write", method: "POST", path: "/api/v1/servers/nonexistentuuid/destinations", body: { network: "x" } });
add({ name: "destinations: create on another team's server", token: "write", method: "POST", path: `/api/v1/servers/${S_OTHER}/destinations`, body: { network: "x" } });
add({ name: "destinations: update", token: "write", method: "PATCH", path: `/api/v1/destinations/${D_MAIN}`, body: { name: " Renamed destination " }, after: DESTINATIONS_AFTER });
add({ name: "destinations: update, invalid", token: "write", method: "PATCH", path: `/api/v1/destinations/${D_MAIN}`, body: { name: "", network: "other" } });
add({ name: "destinations: update, empty", token: "write", method: "PATCH", path: `/api/v1/destinations/${D_MAIN}`, raw: "{}" });
add({ name: "destinations: update unknown", token: "write", method: "PATCH", path: "/api/v1/destinations/nonexistentuuid", body: { name: "x" } });
add({ name: "destinations: update another team's", token: "write", method: "PATCH", path: `/api/v1/destinations/${D_OTHER}`, body: { name: "x" } });
add({ name: "destinations: delete with resources", token: "delete", method: "DELETE", path: `/api/v1/destinations/${D_MAIN}`, after: DESTINATIONS_AFTER });
add({ name: "destinations: delete unknown", token: "delete", method: "DELETE", path: "/api/v1/destinations/nonexistentuuid" });
add({ name: "destinations: delete another team's", token: "delete", method: "DELETE", path: `/api/v1/destinations/${D_OTHER}` });

// ── DP-85: a server's Docker cleanup settings and runs ──────────────────────
const CLEANUP = `/api/v1/servers/${S_MAIN}/docker-cleanup`;
const CLEANUP_AFTER = { settings: "select force_docker_cleanup, docker_cleanup_frequency, docker_cleanup_threshold, delete_unused_volumes, delete_unused_networks, disable_application_image_retention from server_settings where server_id = 1" };
add({ name: "docker cleanup: show", token: "read", method: "GET", path: CLEANUP });
add({ name: "docker cleanup: show of unknown", token: "read", method: "GET", path: "/api/v1/servers/nonexistentuuid/docker-cleanup" });
add({ name: "docker cleanup: show another team's", token: "read", method: "GET", path: `/api/v1/servers/${S_OTHER}/docker-cleanup` });
add({ name: "docker cleanup: update", token: "write", method: "PATCH", path: CLEANUP, body: { docker_cleanup_frequency: "0 4 * * 0", docker_cleanup_threshold: "70", force_docker_cleanup: false, delete_unused_networks: "1", disable_application_image_retention: 1 }, after: CLEANUP_AFTER });
add({ name: "docker cleanup: update to a preset", token: "write", method: "PATCH", path: CLEANUP, body: { docker_cleanup_frequency: "weekly" }, after: CLEANUP_AFTER });
add({ name: "docker cleanup: update, volumes with a write token", token: "write", method: "PATCH", path: CLEANUP, body: { delete_unused_volumes: true }, after: CLEANUP_AFTER });
add({ name: "docker cleanup: update, volumes with a deploy token", token: "root", method: "PATCH", path: CLEANUP, body: { delete_unused_volumes: true, docker_cleanup_threshold: 99 }, after: CLEANUP_AFTER });
add({ name: "docker cleanup: update, volumes off", token: "write", method: "PATCH", path: CLEANUP, setup: ["update server_settings set delete_unused_volumes = true where server_id = 1"], body: { delete_unused_volumes: "0" }, after: CLEANUP_AFTER });
add({ name: "docker cleanup: update, a bad frequency", token: "write", method: "PATCH", path: CLEANUP, body: { docker_cleanup_frequency: "every hour" }, after: CLEANUP_AFTER });
add({ name: "docker cleanup: update, invalid", token: "write", method: "PATCH", path: CLEANUP, body: { docker_cleanup_frequency: 5, docker_cleanup_threshold: 100, force_docker_cleanup: "yes", delete_unused_volumes: [], server_id: 2 } });
add({ name: "docker cleanup: update, a threshold below 1", token: "write", method: "PATCH", path: CLEANUP, body: { docker_cleanup_threshold: 0 } });
add({ name: "docker cleanup: update, empty", token: "write", method: "PATCH", path: CLEANUP, raw: "{}" });
add({ name: "docker cleanup: update, not JSON", token: "write", method: "PATCH", path: CLEANUP, raw: "force_docker_cleanup=1", contentType: "application/x-www-form-urlencoded" });
add({ name: "docker cleanup: update unknown", token: "write", method: "PATCH", path: "/api/v1/servers/nonexistentuuid/docker-cleanup", body: { force_docker_cleanup: true } });
add({ name: "docker cleanup: run", token: "root", method: "POST", path: `${CLEANUP}/run` });
add({ name: "docker cleanup: run, invalid", token: "root", method: "POST", path: `${CLEANUP}/run`, body: { delete_unused_volumes: "maybe", force: true } });
add({ name: "docker cleanup: run unknown", token: "root", method: "POST", path: "/api/v1/servers/nonexistentuuid/docker-cleanup/run" });
add({ name: "docker cleanup: run with a write token", token: "write", method: "POST", path: `${CLEANUP}/run` });
add({ name: "docker cleanup: executions", token: "read", method: "GET", path: `${CLEANUP}/executions` });
add({ name: "docker cleanup: executions, none", token: "read", method: "GET", path: `/api/v1/servers/${S_MAIN}/docker-cleanup/executions`, setup: ["delete from docker_cleanup_executions where server_id = 1"] });
add({ name: "docker cleanup: executions of unknown", token: "read", method: "GET", path: "/api/v1/servers/nonexistentuuid/docker-cleanup/executions" });
add({ name: "docker cleanup: executions of another team's server", token: "read", method: "GET", path: `/api/v1/servers/${S_OTHER}/docker-cleanup/executions` });

// ── DP-86: an application's previews ────────────────────────────────────────
/** The previews of team 1's applications, as rows (a created one's uuid is the request's, its domain may name a random id). */
const PREVIEWS_AFTER = {
  previews:
    "select case when p.uuid like 'r%preview%' then p.uuid end as fixture_uuid, p.application_id, p.pull_request_id, p.pull_request_html_url, p.fqdn, p.status, p.git_type, p.docker_compose_domains, p.docker_registry_image_tag, p.domain_port_overrides::jsonb::text as domain_port_overrides, p.deleted_at is not null as deleted from application_previews p where p.application_id in (1, 2) order by p.id",
};
const PREVIEWS = (app) => `/api/v1/applications/${app}/previews`;
const COMPOSE_GIT_APP = [
  "update applications set build_pack = 'dockercompose', docker_compose_raw = 'services:\n  web:\n    image: nginx:alpine\n  api:\n    image: node:22\n  db:\n    image: postgres:16-alpine\n', docker_compose_domains = '{\"web\":{\"domain\":\"https://web.example.com\"},\"api\":{\"domain\":\"\",\"redirect\":\"www\"}}' where id = 2",
];
add({ name: "previews: list", token: "read", method: "GET", path: PREVIEWS(A_GIT) });
add({ name: "previews: list of an image application", token: "read", method: "GET", path: PREVIEWS(A_IMAGE) });
add({ name: "previews: list, none", token: "read", method: "GET", path: PREVIEWS(A_GIT), setup: ["update application_previews set deleted_at = now() where application_id = 2"] });
add({ name: "previews: list of unknown application", token: "read", method: "GET", path: PREVIEWS("nonexistentuuid") });
add({ name: "previews: list of another team's application", token: "read", method: "GET", path: PREVIEWS(A_OTHER) });
add({ name: "previews: list with compose domains", token: "read", method: "GET", path: PREVIEWS(A_GIT), setup: [...COMPOSE_GIT_APP, "update application_previews set docker_compose_domains = '{\"web\":{\"domain\":\"https://web-17.example.com\"},\"api\":{\"domain\":\"\",\"redirect\":\"both\"}}' where id = 2"] });
add({ name: "previews: show", token: "read", method: "GET", path: `${PREVIEWS(A_GIT)}/17` });
add({ name: "previews: show with a port", token: "read", method: "GET", path: `${PREVIEWS(A_GIT)}/12` });
add({ name: "previews: show of an image application", token: "read", method: "GET", path: `${PREVIEWS(A_IMAGE)}/3` });
add({ name: "previews: show, not a number", token: "read", method: "GET", path: `${PREVIEWS(A_GIT)}/abc` });
add({ name: "previews: show, zero", token: "read", method: "GET", path: `${PREVIEWS(A_GIT)}/0` });
add({ name: "previews: show, too large", token: "read", method: "GET", path: `${PREVIEWS(A_GIT)}/2147483648` });
add({ name: "previews: show, a sign", token: "read", method: "GET", path: `${PREVIEWS(A_GIT)}/+7` });
add({ name: "previews: show unknown", token: "read", method: "GET", path: `${PREVIEWS(A_GIT)}/99` });
add({ name: "previews: show a deleted one", token: "read", method: "GET", path: `${PREVIEWS(A_GIT)}/17`, setup: ["update application_previews set deleted_at = now() where id = 2"] });
add({ name: "previews: show of unknown application", token: "read", method: "GET", path: `${PREVIEWS("nonexistentuuid")}/17` });
add({ name: "previews: show another team's", token: "read", method: "GET", path: `${PREVIEWS(A_OTHER)}/1` });
add({ name: "previews: show the other application's", token: "read", method: "GET", path: `${PREVIEWS(A_IMAGE)}/17` });

// POST …/previews (store): a deployment is queued unless instant_deploy is false.
add({ name: "previews: create, not deployed", token: "root", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 20, pull_request_html_url: "https://github.com/coollabsio/coolify-examples/pull/20", git_type: "github", instant_deploy: false }, after: PREVIEWS_AFTER });
add({ name: "previews: create on an image application, not deployed", token: "root", method: "POST", path: PREVIEWS(A_IMAGE), body: { pull_request_id: 5, docker_tag: " pr-5 ", instant_deploy: false }, after: PREVIEWS_AFTER });
add({ name: "previews: create on an image application with a port, not deployed", token: "root", method: "POST", path: PREVIEWS(A_IMAGE), setup: ["update applications set fqdn = 'https://image.example.com/app,https://www.image.example.com', domain_port_overrides = '{\"https://image.example.com/app\":8080}' where id = 1"], body: { pull_request_id: "6", docker_tag: "pr-6", instant_deploy: "0" }, after: PREVIEWS_AFTER });
add({ name: "previews: create with a template, not deployed", token: "root", method: "POST", path: PREVIEWS(A_IMAGE), setup: ["update applications set preview_url_template = 'http://pr{{pr_id}}-{{domain}}' where id = 1"], body: { pull_request_id: 8, docker_tag: "pr-8", instant_deploy: false }, after: PREVIEWS_AFTER });
add({ name: "previews: create, the source missing", token: "root", method: "POST", path: PREVIEWS(A_GIT), setup: ["update applications set source_id = 999 where id = 2"], body: { pull_request_id: 21, instant_deploy: false }, after: PREVIEWS_AFTER });
add({ name: "previews: create with an empty url, not deployed", token: "root", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 22, git_type: "gitlab", pull_request_html_url: "", instant_deploy: false }, after: PREVIEWS_AFTER });
add({ name: "previews: create a bitbucket one with a commit, not deployed", token: "root", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 23, git_type: "bitbucket", commit: "a1b2c3d", instant_deploy: false }, after: PREVIEWS_AFTER });
add({ name: "previews: create and deploy", token: "root", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 24, git_type: "github" }, after: PREVIEWS_AFTER });
add({ name: "previews: create on a compose application", token: "root", method: "POST", path: PREVIEWS(A_GIT), setup: COMPOSE_GIT_APP, body: { pull_request_id: 25, git_type: "github", instant_deploy: false }, after: PREVIEWS_AFTER });
add({ name: "previews: update an existing one, not deployed", token: "root", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 17, pull_request_html_url: "https://github.com/coollabsio/coolify-examples/pull/77", instant_deploy: false }, after: PREVIEWS_AFTER });
add({ name: "previews: a new docker tag, not deployed", token: "root", method: "POST", path: PREVIEWS(A_IMAGE), body: { pull_request_id: 3, docker_tag: "pr-3b", instant_deploy: false }, after: PREVIEWS_AFTER });
add({ name: "previews: unchanged with a deploy token, not deployed", token: "deploy", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 17, pull_request_html_url: "https://github.com/coollabsio/coolify-examples/pull/17", git_type: "github", instant_deploy: false }, after: PREVIEWS_AFTER });
add({ name: "previews: redeploy with a deploy token", token: "deploy", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 17 }, after: PREVIEWS_AFTER });
add({ name: "previews: redeploy an image preview with a deploy token", token: "deploy", method: "POST", path: PREVIEWS(A_IMAGE), body: { pull_request_id: 3, force: true }, after: PREVIEWS_AFTER });
add({ name: "previews: open one with a deploy token", token: "deploy", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 30, git_type: "github" }, after: PREVIEWS_AFTER });
add({ name: "previews: change the url with a deploy token", token: "deploy", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 17, pull_request_html_url: "https://github.com/coollabsio/coolify-examples/pull/70" } });
add({ name: "previews: choose a commit with a deploy token", token: "deploy", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 17, commit: "abcdef1" } });
add({ name: "previews: a new docker tag with a deploy token", token: "deploy", method: "POST", path: PREVIEWS(A_IMAGE), body: { pull_request_id: 3, docker_tag: "pr-3c" } });
add({ name: "previews: create, validation", token: "root", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: "abc", pull_request_html_url: "not a url", force: "yes", instant_deploy: 2, git_type: "svn", commit: "xyz" } });
add({ name: "previews: create, no pull request id", token: "root", method: "POST", path: PREVIEWS(A_GIT), body: { git_type: "github" } });
add({ name: "previews: create without a body", token: "root", method: "POST", path: PREVIEWS(A_GIT) });
add({ name: "previews: create, the id out of range", token: "root", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 0, git_type: "github", pull_request_html_url: `https://github.com/${"x".repeat(2040)}` } });
add({ name: "previews: create, the id too large", token: "root", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 2147483648, git_type: "github" } });
add({ name: "previews: create, a fraction", token: "root", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 17.5, git_type: "github" } });
add({ name: "previews: create, bitbucket without a commit", token: "root", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 9, git_type: "bitbucket" } });
add({ name: "previews: create, a docker tag on a git application", token: "root", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 9, git_type: "github", docker_tag: "x" } });
add({ name: "previews: create, git fields on an image application", token: "root", method: "POST", path: PREVIEWS(A_IMAGE), body: { pull_request_id: 9, git_type: "github", commit: "abcdef1", docker_tag: "-bad" } });
add({ name: "previews: create, null git fields on an image application", token: "root", method: "POST", path: PREVIEWS(A_IMAGE), body: { pull_request_id: 9, git_type: null, docker_tag: "ok" , instant_deploy: false }, after: PREVIEWS_AFTER });
add({ name: "previews: create, an image preview without a tag", token: "root", method: "POST", path: PREVIEWS(A_IMAGE), body: { pull_request_id: 9 } });
add({ name: "previews: create, an image preview with a blank tag", token: "root", method: "POST", path: PREVIEWS(A_IMAGE), body: { pull_request_id: 9, docker_tag: "  " } });
add({ name: "previews: create, no git type and no source", token: "root", method: "POST", path: PREVIEWS(A_GIT), setup: ["update applications set source_id = null, source_type = null where id = 2"], body: { pull_request_id: 9 } });
add({ name: "previews: create, a dockerfile application", token: "root", method: "POST", path: PREVIEWS(A_GIT), setup: ["update applications set build_pack = 'dockerfile', dockerfile = 'FROM nginx' where id = 2"], body: { pull_request_id: 9 } });
add({ name: "previews: create on unknown application", token: "root", method: "POST", path: PREVIEWS("nonexistentuuid"), body: { pull_request_id: 9 } });
add({ name: "previews: create on another team's application", token: "root", method: "POST", path: PREVIEWS(A_OTHER), body: { pull_request_id: 9 } });
add({ name: "previews: create with a read token", token: "read", method: "POST", path: PREVIEWS(A_GIT), body: { pull_request_id: 9 } });

// PATCH …/previews/{pull_request_id}: the preview's domains.
const PREVIEW_17 = `${PREVIEWS(A_GIT)}/17`;
add({ name: "previews: update the domains", token: "write", method: "PATCH", path: PREVIEW_17, body: { domains: "HTTPS://PR17.Example.com/Path, https://www.pr17.example.com" }, after: PREVIEWS_AFTER });
add({ name: "previews: update the domains with a port", token: "write", method: "PATCH", path: PREVIEW_17, body: { domains: "https://pr17.example.com:3000" }, after: PREVIEWS_AFTER });
add({ name: "previews: update the domains to none", token: "write", method: "PATCH", path: `${PREVIEWS(A_GIT)}/12`, body: { domains: null }, after: PREVIEWS_AFTER });
add({ name: "previews: update the domains to blank", token: "write", method: "PATCH", path: `${PREVIEWS(A_GIT)}/12`, body: { domains: " , " }, after: PREVIEWS_AFTER });
add({ name: "previews: update the domains, missing", token: "write", method: "PATCH", path: PREVIEW_17, body: { force_domain_override: true } });
add({ name: "previews: update the domains, no body", token: "write", method: "PATCH", path: PREVIEW_17 });
add({ name: "previews: update the domains, invalid", token: "write", method: "PATCH", path: PREVIEW_17, body: { domains: "not a url,ftp://x.example.com", force_domain_override: "maybe" } });
add({ name: "previews: update the domains, not a string", token: "write", method: "PATCH", path: PREVIEW_17, body: { domains: ["https://pr17.example.com"] } });
add({ name: "previews: update the domains, compose domains on an image application", token: "write", method: "PATCH", path: PREVIEW_17, body: { domains: "https://pr17.example.com", docker_compose_domains: [] } });
add({ name: "previews: update the domains, twice", token: "write", method: "PATCH", path: PREVIEW_17, body: { domains: "https://pr17.example.com,https://pr17.example.com:8080" } });
add({ name: "previews: update the domains, the application's", token: "write", method: "PATCH", path: PREVIEW_17, body: { domains: "https://image.example.com" }, after: PREVIEWS_AFTER });
add({ name: "previews: update the domains, a service's, forced", token: "write", method: "PATCH", path: PREVIEW_17, body: { domains: "https://web.example.com", force_domain_override: true }, after: PREVIEWS_AFTER });
add({ name: "previews: update the domains, forced in the query", token: "write", method: "PATCH", path: `${PREVIEW_17}?force_domain_override=true`, body: { domains: "https://image.example.com" }, after: PREVIEWS_AFTER });
add({ name: "previews: update the domains, another preview's", token: "write", method: "PATCH", path: PREVIEW_17, body: { domains: "https://3.image.example.com/" }, after: PREVIEWS_AFTER });
add({ name: "previews: update the domains, another preview's with a port", token: "write", method: "PATCH", path: PREVIEW_17, body: { domains: "https://pr-12.example.com:9000" }, after: PREVIEWS_AFTER });
add({ name: "previews: update the domains, another preview's, forced", token: "write", method: "PATCH", path: PREVIEW_17, body: { domains: "https://3.image.example.com", force_domain_override: true } });
add({ name: "previews: update the domains, a near host", token: "write", method: "PATCH", path: PREVIEW_17, body: { domains: "https://3.image.example.co" }, after: PREVIEWS_AFTER });
add({ name: "previews: update the domains, its own", token: "write", method: "PATCH", path: `${PREVIEWS(A_GIT)}/12`, body: { domains: "https://pr-12.example.com" }, after: PREVIEWS_AFTER });
add({ name: "previews: update the domains, not a number", token: "write", method: "PATCH", path: `${PREVIEWS(A_GIT)}/seven`, body: { domains: "https://pr17.example.com" } });
add({ name: "previews: update the domains of unknown", token: "write", method: "PATCH", path: `${PREVIEWS(A_GIT)}/99`, body: { domains: "https://pr17.example.com" } });
add({ name: "previews: update the domains of unknown application", token: "write", method: "PATCH", path: `${PREVIEWS("nonexistentuuid")}/17`, body: { domains: "https://pr17.example.com" } });
add({ name: "previews: update the domains of another team's", token: "write", method: "PATCH", path: `${PREVIEWS(A_OTHER)}/1`, body: { domains: "https://pr17.example.com" } });
add({ name: "previews: update the compose domains", token: "write", method: "PATCH", path: PREVIEW_17, setup: [...COMPOSE_GIT_APP, "update application_previews set docker_compose_domains = '{\"web\":{\"domain\":\"https://web-17.example.com\",\"redirect\":\"non-www\"},\"api\":{\"domain\":\"\",\"redirect\":\"both\"}}' where id = 2"], body: { docker_compose_domains: [{ name: "web", domain: "https://WEB-17.example.com:8443,https://www.web-17.example.com" }, { name: "api", domain: null, redirect: null }] }, after: PREVIEWS_AFTER });
add({ name: "previews: update the compose domains, one service", token: "write", method: "PATCH", path: PREVIEW_17, setup: COMPOSE_GIT_APP, body: { docker_compose_domains: [{ name: "api", domain: "https://api-17.example.com", redirect: "www" }] }, after: PREVIEWS_AFTER });
add({ name: "previews: update the compose domains, none", token: "write", method: "PATCH", path: PREVIEW_17, setup: COMPOSE_GIT_APP, body: { docker_compose_domains: [] }, after: PREVIEWS_AFTER });
add({ name: "previews: update the compose domains, a database service", token: "write", method: "PATCH", path: PREVIEW_17, setup: COMPOSE_GIT_APP, body: { docker_compose_domains: [{ name: "db", domain: "https://db-17.example.com" }] } });
add({ name: "previews: update the compose domains, validation", token: "write", method: "PATCH", path: PREVIEW_17, setup: COMPOSE_GIT_APP, body: { domains: "https://x.example.com", docker_compose_domains: [{ name: "web", domain: "bad", redirect: "nowhere", port: 1 }, { name: "web" }, { domain: "https://y.example.com" }, "web"] } });
add({ name: "previews: update the compose domains, missing", token: "write", method: "PATCH", path: PREVIEW_17, setup: COMPOSE_GIT_APP, body: { force_domain_override: false } });
add({ name: "previews: update the compose domains, not an array", token: "write", method: "PATCH", path: PREVIEW_17, setup: COMPOSE_GIT_APP, body: { docker_compose_domains: "web" } });
add({ name: "previews: update the compose domains, twice", token: "write", method: "PATCH", path: PREVIEW_17, setup: COMPOSE_GIT_APP, body: { docker_compose_domains: [{ name: "web", domain: "https://same.example.com" }, { name: "api", domain: "https://same.example.com:3000" }] } });
add({ name: "previews: update the compose domains, the application's", token: "write", method: "PATCH", path: PREVIEW_17, setup: COMPOSE_GIT_APP, body: { docker_compose_domains: [{ name: "web", domain: "https://image.example.com" }] } });
add({ name: "previews: update the compose domains, an unparsable file", token: "write", method: "PATCH", path: PREVIEW_17, setup: [...COMPOSE_GIT_APP, "update applications set docker_compose_raw = 'services: [' where id = 2"], body: { docker_compose_domains: [] } });
add({ name: "previews: update the compose domains, no services", token: "write", method: "PATCH", path: PREVIEW_17, setup: [...COMPOSE_GIT_APP, "update applications set docker_compose_raw = 'version: \"3\"' where id = 2"], body: { docker_compose_domains: [] } });
add({ name: "previews: update with a read token", token: "read", method: "PATCH", path: PREVIEW_17, body: { domains: "https://pr17.example.com" } });

// DELETE …/previews/{pull_request_id}: soft-deleted, then CleanupPreviewDeployment (nothing on a server that is not functional).
add({ name: "previews: delete", token: "delete", method: "DELETE", path: PREVIEW_17, after: PREVIEWS_AFTER });
add({ name: "previews: delete an image preview", token: "root", method: "DELETE", path: `${PREVIEWS(A_IMAGE)}/3`, after: PREVIEWS_AFTER });
add({ name: "previews: delete on a functional server", token: "root", method: "DELETE", path: PREVIEW_17, setup: FUNCTIONAL, after: PREVIEWS_AFTER });
add({ name: "previews: delete, not a number", token: "delete", method: "DELETE", path: `${PREVIEWS(A_GIT)}/-7` });
add({ name: "previews: delete unknown", token: "delete", method: "DELETE", path: `${PREVIEWS(A_GIT)}/99` });
add({ name: "previews: delete of unknown application", token: "delete", method: "DELETE", path: `${PREVIEWS("nonexistentuuid")}/17` });
add({ name: "previews: delete another team's", token: "root", method: "DELETE", path: `${PREVIEWS(A_OTHER)}/1` });
add({ name: "previews: delete with a write token", token: "write", method: "DELETE", path: PREVIEW_17 });

// GET …/previews/{pull_request_id}/logs: the container's logs on the server.
add({ name: "previews: logs", token: "sensitive", method: "GET", path: `${PREVIEW_17}/logs` });
add({ name: "previews: logs, not a number", token: "sensitive", method: "GET", path: `${PREVIEWS(A_GIT)}/x/logs` });
add({ name: "previews: logs of unknown", token: "sensitive", method: "GET", path: `${PREVIEWS(A_GIT)}/99/logs` });
add({ name: "previews: logs of unknown application", token: "sensitive", method: "GET", path: `${PREVIEWS("nonexistentuuid")}/17/logs` });
add({ name: "previews: logs with a read token", token: "read", method: "GET", path: `${PREVIEW_17}/logs` });

// ── DP-86: an application's additional destinations ─────────────────────────
// A second server of team 1 with its destination, made by the case on each side (Coolify's tables have team_id, Freeploy's
// org_id): `setupCoolify` is emit.php's, `setupFreeploy` the test's, each after the shared `setup`.
const S_SECOND = "s5paritysecondserver0005";
const D_SECOND = "d3seconddestination00003";
const D_SECOND_B = "d5seconddestinationb0005";
const D_MAIN_B = "d4maindestinationb000004";
const PROXY = `'{"redirect_enabled":true}'`;
const SECOND = {
  setupCoolify: [
    `insert into servers (id, uuid, name, ip, team_id, private_key_id, proxy, created_at, updated_at) values (3, '${S_SECOND}', 'second-server', '203.0.113.30', 1, 1, ${PROXY}, now(), now())`,
    "insert into server_settings (server_id, created_at, updated_at) values (3, now(), now())",
    `insert into standalone_dockers (id, uuid, name, network, server_id, created_at, updated_at) values (3, '${D_SECOND}', 'second-destination', 'coolify', 3, now(), now())`,
  ],
  setupFreeploy: [
    `insert into servers (id, uuid, name, ip, private_key_id, proxy, org_id, created_at, updated_at) values (3, '${S_SECOND}', 'second-server', '203.0.113.30', 1, ${PROXY}, deploy.current_org(), now(), now())`,
    "insert into server_settings (server_id, server_role, org_id, created_at, updated_at) values (3, 'both', deploy.current_org(), now(), now())",
    `insert into standalone_dockers (id, uuid, name, network, server_id, org_id, created_at, updated_at) values (3, '${D_SECOND}', 'second-destination', 'coolify', 3, deploy.current_org(), now(), now())`,
  ],
};
/** One more statement on each side (`team` names the tenancy column, `owner` its value). */
const both = (base, coolify, freeploy) => ({ setupCoolify: [...base.setupCoolify, ...coolify], setupFreeploy: [...base.setupFreeploy, ...freeploy] });
const ATTACHED = both(SECOND, ["insert into additional_destinations (application_id, server_id, standalone_docker_id, status) values (2, 3, 3, 'running:healthy')"], ["insert into additional_destinations (application_id, server_id, standalone_docker_id, status, org_id) values (2, 3, 3, 'running:healthy', deploy.current_org())"]);
const destinationOn = (base, id, uuid, name, server) =>
  both(base, [`insert into standalone_dockers (id, uuid, name, network, server_id, created_at, updated_at) values (${id}, '${uuid}', '${name}', '${name}', ${server}, now(), now())`], [`insert into standalone_dockers (id, uuid, name, network, server_id, org_id, created_at, updated_at) values (${id}, '${uuid}', '${name}', '${name}', ${server}, deploy.current_org(), now(), now())`]);
const ADDITIONAL_AFTER = { additional: "select application_id, server_id, standalone_docker_id, status from additional_destinations where application_id in (1, 2) order by application_id, standalone_docker_id" };
const APP_DESTINATIONS = (app) => `/api/v1/applications/${app}/destinations`;
add({ name: "app destinations: list", token: "read", method: "GET", path: APP_DESTINATIONS(A_GIT), setup: NAMED_DESTINATION, ...ATTACHED });
add({ name: "app destinations: list, only the primary", token: "read", method: "GET", path: APP_DESTINATIONS(A_IMAGE), setup: NAMED_DESTINATION });
add({ name: "app destinations: list of unknown application", token: "read", method: "GET", path: APP_DESTINATIONS("nonexistentuuid") });
add({ name: "app destinations: list of another team's application", token: "read", method: "GET", path: APP_DESTINATIONS(A_OTHER) });
add({ name: "app destinations: add", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), body: { destination_uuid: D_SECOND }, ...SECOND, after: ADDITIONAL_AFTER });
add({ name: "app destinations: add, then list", token: "read", method: "GET", path: APP_DESTINATIONS(A_GIT), setup: NAMED_DESTINATION, ...both(ATTACHED, ["insert into additional_destinations (application_id, server_id, standalone_docker_id) values (1, 3, 3)"], ["insert into additional_destinations (application_id, server_id, standalone_docker_id, org_id) values (1, 3, 3, deploy.current_org())"]) });
add({ name: "app destinations: add, no body", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT) });
add({ name: "app destinations: add, not JSON", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), raw: "destination_uuid=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "app destinations: add, empty JSON", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), raw: "{}" });
add({ name: "app destinations: add, validation", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), body: { destination_uuid: 5, server_uuid: S_MAIN } });
add({ name: "app destinations: add, missing", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), body: { destination_uuid: null } });
add({ name: "app destinations: add to unknown application", token: "write", method: "POST", path: APP_DESTINATIONS("nonexistentuuid"), body: { destination_uuid: D_SECOND } });
add({ name: "app destinations: add unknown destination", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), body: { destination_uuid: "nonexistentuuid" } });
add({ name: "app destinations: add another team's destination", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), body: { destination_uuid: D_OTHER } });
add({ name: "app destinations: add the primary", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), body: { destination_uuid: D_MAIN } });
add({ name: "app destinations: add one already attached", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), body: { destination_uuid: D_SECOND }, ...ATTACHED, after: ADDITIONAL_AFTER });
add({ name: "app destinations: add one on the primary's server", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), body: { destination_uuid: D_MAIN_B }, ...destinationOn(SECOND, 4, D_MAIN_B, "main-b", 1) });
add({ name: "app destinations: add a second on a server", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), body: { destination_uuid: D_SECOND_B }, ...destinationOn(ATTACHED, 5, D_SECOND_B, "second-b", 3), after: ADDITIONAL_AFTER });
add({ name: "app destinations: add to an application with storage", token: "write", method: "POST", path: APP_DESTINATIONS(A_IMAGE), body: { destination_uuid: D_SECOND }, ...SECOND, after: ADDITIONAL_AFTER });
add({ name: "app destinations: add to a compose application", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), setup: ["update applications set build_pack = 'dockercompose' where id = 2"], body: { destination_uuid: D_SECOND }, ...SECOND });
add({ name: "app destinations: add on a build server", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), body: { destination_uuid: D_SECOND }, ...both(SECOND, ["update server_settings set server_role = 'build' where server_id = 3"], ["update server_settings set server_role = 'build' where server_id = 3"]) });
add({ name: "app destinations: add, the proxies differ", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), setup: [`update servers set proxy = '{"type":"TRAEFIK"}' where id = 1`], body: { destination_uuid: D_SECOND }, ...both(SECOND, [`update servers set proxy = '{"type":"CADDY"}' where id = 3`], [`update servers set proxy = '{"type":"CADDY"}' where id = 3`]) });
add({ name: "app destinations: add, the same proxy", token: "write", method: "POST", path: APP_DESTINATIONS(A_GIT), setup: [`update servers set proxy = '{"type":"TRAEFIK"}' where id = 1`], body: { destination_uuid: D_SECOND }, ...both(SECOND, [`update servers set proxy = '{"type":"TRAEFIK"}' where id = 3`], [`update servers set proxy = '{"type":"TRAEFIK"}' where id = 3`]), after: ADDITIONAL_AFTER });
add({ name: "app destinations: add, a server without a proxy", token: "root", method: "POST", path: APP_DESTINATIONS(A_GIT), setup: [`update servers set proxy = '{"type":"CADDY"}' where id = 1`], body: { destination_uuid: D_SECOND }, ...both(SECOND, [`update servers set proxy = '{"type":"NONE"}' where id = 3`], [`update servers set proxy = '{"type":"NONE"}' where id = 3`]), after: ADDITIONAL_AFTER });
add({ name: "app destinations: add with a read token", token: "read", method: "POST", path: APP_DESTINATIONS(A_GIT), body: { destination_uuid: D_SECOND } });
add({ name: "app destinations: remove", token: "delete", method: "DELETE", path: `${APP_DESTINATIONS(A_GIT)}/${D_SECOND}`, ...ATTACHED, after: ADDITIONAL_AFTER });
add({ name: "app destinations: remove the primary", token: "delete", method: "DELETE", path: `${APP_DESTINATIONS(A_GIT)}/${D_MAIN}`, ...ATTACHED });
add({ name: "app destinations: remove one not attached", token: "delete", method: "DELETE", path: `${APP_DESTINATIONS(A_GIT)}/${D_SECOND}`, ...SECOND });
add({ name: "app destinations: remove unknown", token: "delete", method: "DELETE", path: `${APP_DESTINATIONS(A_GIT)}/nonexistentuuid` });
add({ name: "app destinations: remove another team's", token: "delete", method: "DELETE", path: `${APP_DESTINATIONS(A_GIT)}/${D_OTHER}` });
add({ name: "app destinations: remove from unknown application", token: "delete", method: "DELETE", path: `${APP_DESTINATIONS("nonexistentuuid")}/${D_SECOND}` });
add({ name: "app destinations: remove with a write token", token: "write", method: "DELETE", path: `${APP_DESTINATIONS(A_GIT)}/${D_SECOND}` });

// ── DP-86: moving, migrating and cloning applications, databases and services ──
const MOVED_AFTER = {
  moved: "select 'application' as kind, uuid, environment_id from applications where id in (1, 2) union all select 'postgresql', uuid, environment_id from standalone_postgresqls where id = 1 union all select 'service', uuid, environment_id from services where id = 1 order by kind, uuid",
};
const MOVE = (group, uuid) => `/api/v1/${group}/${uuid}/move`;
add({ name: "operations: move an application", token: "write", method: "POST", path: MOVE("applications", A_GIT), body: { environment_uuid: E_STAGING }, after: MOVED_AFTER });
add({ name: "operations: move an application to another project", token: "write", method: "POST", path: MOVE("applications", A_IMAGE), body: { environment_uuid: E_BETA }, after: MOVED_AFTER });
add({ name: "operations: move an application, the same environment", token: "write", method: "POST", path: MOVE("applications", A_GIT), body: { environment_uuid: E_PROD }, after: MOVED_AFTER });
add({ name: "operations: move an application, unknown environment", token: "write", method: "POST", path: MOVE("applications", A_GIT), body: { environment_uuid: "nonexistentuuid" } });
add({ name: "operations: move an application to another team's environment", token: "write", method: "POST", path: MOVE("applications", A_GIT), body: { environment_uuid: E_OTHER } });
add({ name: "operations: move an application, no body", token: "write", method: "POST", path: MOVE("applications", A_GIT) });
add({ name: "operations: move an application, validation", token: "write", method: "POST", path: MOVE("applications", A_GIT), body: { environment_uuid: 5, project_uuid: P_ALPHA } });
add({ name: "operations: move an application, fields not allowed", token: "write", method: "POST", path: MOVE("applications", A_GIT), body: { environment_uuid: E_STAGING, project_uuid: P_ALPHA, name: "x" }, after: MOVED_AFTER });
add({ name: "operations: move an application, the query string", token: "write", method: "POST", path: `${MOVE("applications", A_GIT)}?environment_uuid=${E_STAGING}`, after: MOVED_AFTER });
add({ name: "operations: move unknown application", token: "write", method: "POST", path: MOVE("applications", "nonexistentuuid"), body: { environment_uuid: E_STAGING } });
add({ name: "operations: move another team's application", token: "write", method: "POST", path: MOVE("applications", A_OTHER), body: { environment_uuid: E_STAGING } });
add({ name: "operations: move an application with a read token", token: "read", method: "POST", path: MOVE("applications", A_GIT), body: { environment_uuid: E_STAGING } });
add({ name: "operations: move a database", token: "write", method: "POST", path: MOVE("databases", DB_PG), body: { environment_uuid: E_STAGING }, after: MOVED_AFTER });
add({ name: "operations: move a database, the same environment", token: "write", method: "POST", path: MOVE("databases", DB_REDIS), body: { environment_uuid: E_PROD } });
add({ name: "operations: move a database, unknown environment", token: "write", method: "POST", path: MOVE("databases", DB_PG), body: { environment_uuid: "nonexistentuuid" } });
add({ name: "operations: move unknown database", token: "write", method: "POST", path: MOVE("databases", "nonexistentuuid"), body: { environment_uuid: E_STAGING } });
add({ name: "operations: move another team's database", token: "write", method: "POST", path: MOVE("databases", DB_OTHER), body: { environment_uuid: E_STAGING } });
add({ name: "operations: move a service", token: "write", method: "POST", path: MOVE("services", SV_MAIN), body: { environment_uuid: E_BETA }, after: MOVED_AFTER });
add({ name: "operations: move a service, the same environment", token: "write", method: "POST", path: MOVE("services", SV_MAIN), body: { environment_uuid: E_PROD } });
add({ name: "operations: move a service, validation", token: "write", method: "POST", path: MOVE("services", SV_MAIN), body: { environment_uuid: null } });
add({ name: "operations: move unknown service", token: "write", method: "POST", path: MOVE("services", "nonexistentuuid"), body: { environment_uuid: E_STAGING } });
add({ name: "operations: move another team's service", token: "write", method: "POST", path: MOVE("services", SV_OTHER), body: { environment_uuid: E_STAGING } });

// migrate: migrateResourceToDestination() aborts with 404 outside development (isDev()).
const MIGRATE = (group, uuid) => `/api/v1/${group}/${uuid}/migrate`;
add({ name: "operations: migrate an application", token: "write", method: "POST", path: MIGRATE("applications", A_GIT), body: { destination_uuid: D_MAIN } });
add({ name: "operations: migrate an application, no body", token: "write", method: "POST", path: MIGRATE("applications", A_GIT) });
add({ name: "operations: migrate unknown application", token: "write", method: "POST", path: MIGRATE("applications", "nonexistentuuid"), body: { destination_uuid: D_MAIN } });
add({ name: "operations: migrate a database", token: "write", method: "POST", path: MIGRATE("databases", DB_PG), body: { destination_uuid: D_MAIN } });
add({ name: "operations: migrate unknown database", token: "write", method: "POST", path: MIGRATE("databases", "nonexistentuuid"), body: { destination_uuid: D_MAIN } });
add({ name: "operations: migrate a service", token: "write", method: "POST", path: MIGRATE("services", SV_MAIN), body: { destination_uuid: D_MAIN } });
add({ name: "operations: migrate another team's service", token: "write", method: "POST", path: MIGRATE("services", SV_OTHER), body: { destination_uuid: D_MAIN } });

// clone: the copy's rows (its random uuid read as <uuid> in its name and its volumes' names).
const FIXTURE_APPS = `'${A_IMAGE}', '${A_GIT}', '${A_OTHER}'`;
const NEW_APP = `(select id from applications where uuid not in (${FIXTURE_APPS}))`;
const NEW_APP_UUID = `(select uuid from applications where uuid not in (${FIXTURE_APPS}))`;
const APP_CLONE_AFTER = {
  application: `select replace(name, uuid, '<uuid>') as name, replace(fqdn, uuid, '<uuid>') as fqdn, status, environment_id, destination_id, destination_type, git_repository, git_branch, build_pack, ports_exposes, docker_registry_image_name, docker_registry_image_tag, source_id, source_type, health_check_enabled from applications where uuid not in (${FIXTURE_APPS})`,
  settings: `select is_static, is_auto_deploy_enabled, is_force_https_enabled, is_preview_deployments_enabled from application_settings where application_id = ${NEW_APP}`,
  tags: `select tg.tag_id from taggables tg where tg.taggable_type = 'App\\Models\\Application' and tg.taggable_id = ${NEW_APP} order by tg.tag_id`,
  tasks: `select name, command, frequency, container, enabled, uuid in ('${ST_BACKUP}', '${ST_CLEANUP}') as fixture_uuid from scheduled_tasks where application_id = ${NEW_APP} order by name`,
  variables: `select key, is_preview, is_literal, is_multiline, is_shown_once, is_runtime, is_buildtime from environment_variables where resourceable_type = 'App\\Models\\Application' and resourceable_id = ${NEW_APP} order by key, is_preview`,
  volumes: `select replace(name, ${NEW_APP_UUID}, '<uuid>') as name, mount_path, uuid = '${PV_APP}' as fixture_uuid from local_persistent_volumes where resource_type = 'App\\Models\\Application' and resource_id = ${NEW_APP} order by name`,
  files: `select fs_path, mount_path, is_directory, is_host_file from local_file_volumes where resource_type = 'App\\Models\\Application' and resource_id = ${NEW_APP} order by mount_path`,
};
const FIXTURE_PGS = `'${DB_PG}', '${DB_OTHER}'`;
const NEW_PG = `(select id from standalone_postgresqls where uuid not in (${FIXTURE_PGS}))`;
const NEW_PG_UUID = `(select uuid from standalone_postgresqls where uuid not in (${FIXTURE_PGS}))`;
const DB_CLONE_AFTER = {
  database: `select replace(name, uuid, '<uuid>') as name, description, status, started_at, image, postgres_db, is_public, public_port, environment_id, destination_id, destination_type from standalone_postgresqls where uuid not in (${FIXTURE_PGS})`,
  tags: `select tg.tag_id from taggables tg where tg.taggable_type = 'App\\Models\\StandalonePostgresql' and tg.taggable_id = ${NEW_PG} order by tg.tag_id`,
  volumes: `select replace(name, ${NEW_PG_UUID}, '<uuid>') as name, mount_path from local_persistent_volumes where resource_type = 'App\\Models\\StandalonePostgresql' and resource_id = ${NEW_PG} order by name`,
  files: `select fs_path, mount_path, is_directory from local_file_volumes where resource_type = 'App\\Models\\StandalonePostgresql' and resource_id = ${NEW_PG} order by mount_path`,
  backups: `select frequency, save_s3, enabled, databases_to_backup, (select count(*) from scheduled_database_backup_s3_storage p where p.scheduled_database_backup_id = b.id) as s3 from scheduled_database_backups b where database_type = 'App\\Models\\StandalonePostgresql' and database_id = ${NEW_PG} order by frequency`,
  variables: `select key, is_shown_once from environment_variables where resourceable_type = 'App\\Models\\StandalonePostgresql' and resourceable_id = ${NEW_PG} order by key`,
};
const FIXTURE_REDIS = `'${DB_REDIS}'`;
const REDIS_CLONE_AFTER = {
  database: `select replace(name, uuid, '<uuid>') as name, status, image, environment_id from standalone_redis where uuid not in (${FIXTURE_REDIS})`,
  tags: `select tg.tag_id from taggables tg where tg.taggable_type = 'App\\Models\\StandaloneRedis' and tg.taggable_id = (select id from standalone_redis where uuid not in (${FIXTURE_REDIS})) order by tg.tag_id`,
  variables: `select key, is_shown_once from environment_variables where resourceable_type = 'App\\Models\\StandaloneRedis' and resourceable_id = (select id from standalone_redis where uuid not in (${FIXTURE_REDIS})) order by key`,
};
const CLONE = (group, uuid) => `/api/v1/${group}/${uuid}/clone`;
add({ name: "operations: clone an application", token: "write", method: "POST", path: CLONE("applications", A_GIT), body: { destination_uuid: D_MAIN }, after: APP_CLONE_AFTER });
add({ name: "operations: clone an application with its parts", token: "write", method: "POST", path: CLONE("applications", A_IMAGE), body: { destination_uuid: D_MAIN, name: "image-copy" }, after: APP_CLONE_AFTER });
add({ name: "operations: clone an application, a long name", token: "write", method: "POST", path: CLONE("applications", A_GIT), setup: ["update applications set name = 'a-very-long-application-name' where id = 2"], body: { destination_uuid: D_MAIN, clone_volumes: false }, after: APP_CLONE_AFTER });
add({ name: "operations: clone an application, the volumes without deploy", token: "write", method: "POST", path: CLONE("applications", A_GIT), body: { destination_uuid: D_MAIN, clone_volumes: true } });
add({ name: "operations: clone an application, no volumes to copy", token: "root", method: "POST", path: CLONE("applications", A_GIT), body: { destination_uuid: D_MAIN, clone_volumes: "1" }, after: APP_CLONE_AFTER });
add({ name: "operations: clone an application, the volumes", token: "root", method: "POST", path: CLONE("applications", A_IMAGE), body: { destination_uuid: D_MAIN, clone_volumes: true }, after: APP_CLONE_AFTER });
add({ name: "operations: clone an application, no body", token: "write", method: "POST", path: CLONE("applications", A_GIT) });
add({ name: "operations: clone an application, validation", token: "write", method: "POST", path: CLONE("applications", A_GIT), body: { destination_uuid: 1, name: "x!", clone_volumes: "maybe", environment_uuid: E_STAGING } });
add({ name: "operations: clone an application, unknown destination", token: "write", method: "POST", path: CLONE("applications", A_GIT), body: { destination_uuid: "nonexistentuuid" } });
add({ name: "operations: clone an application, another team's destination", token: "write", method: "POST", path: CLONE("applications", A_GIT), body: { destination_uuid: D_OTHER } });
add({ name: "operations: clone an application, a build server", token: "write", method: "POST", path: CLONE("applications", A_GIT), setup: ["update server_settings set server_role = 'build' where server_id = 1"], body: { destination_uuid: D_MAIN } });
add({ name: "operations: clone unknown application", token: "write", method: "POST", path: CLONE("applications", "nonexistentuuid"), body: { destination_uuid: D_MAIN } });
add({ name: "operations: clone an application with a read token", token: "read", method: "POST", path: CLONE("applications", A_GIT), body: { destination_uuid: D_MAIN } });
add({ name: "operations: clone a database", token: "write", method: "POST", path: CLONE("databases", DB_PG), body: { destination_uuid: D_MAIN }, after: DB_CLONE_AFTER });
add({ name: "operations: clone a database with a name", token: "write", method: "POST", path: CLONE("databases", DB_PG), body: { destination_uuid: D_MAIN, name: "pg-copy" }, after: DB_CLONE_AFTER });
add({ name: "operations: clone a database, the volumes", token: "root", method: "POST", path: CLONE("databases", DB_PG), body: { destination_uuid: D_MAIN, clone_volumes: true }, after: DB_CLONE_AFTER });
add({ name: "operations: clone a database, the volumes without deploy", token: "write", method: "POST", path: CLONE("databases", DB_PG), body: { destination_uuid: D_MAIN, clone_volumes: 1 } });
add({ name: "operations: clone a Redis", token: "write", method: "POST", path: CLONE("databases", DB_REDIS), body: { destination_uuid: D_MAIN }, after: REDIS_CLONE_AFTER });
add({ name: "operations: clone a database, unknown destination", token: "write", method: "POST", path: CLONE("databases", DB_PG), body: { destination_uuid: "nonexistentuuid" } });
add({ name: "operations: clone unknown database", token: "write", method: "POST", path: CLONE("databases", "nonexistentuuid"), body: { destination_uuid: D_MAIN } });
add({ name: "operations: clone another team's database", token: "write", method: "POST", path: CLONE("databases", DB_OTHER), body: { destination_uuid: D_MAIN } });
add({ name: "operations: clone a database, validation", token: "write", method: "POST", path: CLONE("databases", DB_PG), body: { name: "ab" } });

// ── DP-87: creating applications (create_application() of the Docker image, Dockerfile, public and deploy key types) ──
// The created application is the one whose uuid is not the fixture's; its random uuid is read as <uuid> inside its name,
// domain and labels, and the random part of a generated name (new_public_id()) as <random>.
const FIXTURE_APP_UUIDS = `'${A_IMAGE}', '${A_GIT}', '${A_OTHER}'`;
const CREATED_APP = `(select id from applications where uuid not in (${FIXTURE_APP_UUIDS}))`;
const CREATED_AFTER = {
  application: `select regexp_replace(replace(name, uuid, '<uuid>'), '[a-z0-9]{24}$', '<random>') as name, description, replace(fqdn, uuid, '<uuid>') as fqdn, domain_port_overrides::jsonb::text as domain_port_overrides, noindex_domains::jsonb::text as noindex_domains, git_repository, git_branch, git_commit_sha, build_pack, static_image, install_command, build_command, start_command, ports_exposes, ports_mappings, base_directory, publish_directory, docker_registry_image_name, docker_registry_image_tag, dockerfile, dockerfile_location, dockerfile_target_build, docker_compose_location, docker_compose_raw, docker_compose_domains::jsonb::text as docker_compose_domains, health_check_enabled, health_check_path, health_check_port, health_check_type, health_check_interval, health_check_retries, limits_memory, limits_cpus, status, environment_id, destination_id, destination_type, source_id, source_type, repository_project_id, private_key_id, redirect, replace(custom_labels, uuid, '<uuid>') as custom_labels, custom_docker_run_options, custom_nginx_configuration, custom_network_aliases, watch_paths, preview_url_template, max_restart_count, compose_parsing_version, is_http_basic_auth_enabled, http_basic_auth_username, http_basic_auth_password is not null as has_basic_auth_password, http_basic_auth_hash_algorithm, http_basic_auth_bcrypt_cost, git_https_username, git_https_password is not null as has_git_https_password, manual_webhook_secret_github is not null and manual_webhook_secret_gitea is not null as has_webhook_secrets, custom_healthcheck_found, post_deployment_command, pre_deployment_command_container from applications where uuid not in (${FIXTURE_APP_UUIDS})`,
  settings: `select is_static, is_spa, is_git_submodules_enabled, is_git_lfs_enabled, is_git_shallow_clone_enabled, is_auto_deploy_enabled, is_force_https_enabled, is_preview_deployments_enabled, is_pr_deployments_public_enabled, is_build_server_enabled, use_build_secrets, connect_to_docker_network, is_container_label_escape_enabled, is_container_label_readonly_enabled, is_preserve_repository_enabled, is_consistent_container_name_enabled, custom_internal_name, custom_container_name_prefix, is_gzip_enabled, is_stripprefix_enabled, is_permanent_redirect_enabled, traefik_certificate_resolver, is_raw_compose_deployment_enabled, is_log_drain_enabled, is_gpu_enabled, gpu_driver, gpu_count, gpu_device_ids, gpu_options, is_env_sorting_enabled, redact_all_env_values_in_logs, include_coolify_default_variables, disable_build_cache, inject_build_args_to_dockerfile, include_source_commit_in_build, include_network_hosts_in_build, stop_grace_period, rolling_update_drain_seconds, docker_images_to_keep, is_image_scan_enabled, is_auto_cancel_queued_deployments_enabled, is_auto_cancel_building_deployments_enabled from application_settings where application_id = ${CREATED_APP}`,
  variables: `select key, is_preview, is_literal, is_multiline, is_shown_once, is_runtime, is_buildtime from environment_variables where resourceable_type = 'App\\Models\\Application' and resourceable_id = ${CREATED_APP} order by key, is_preview`,
  tags: `select t.name, t.id <= ${FIXTURE_TAGS} as fixture_tag from taggables tg join tags t on t.id = tg.tag_id where tg.taggable_type = 'App\\Models\\Application' and tg.taggable_id = ${CREATED_APP} order by t.name`,
};
// Nothing was created (a refusal after the checks).
const NOTHING_CREATED = { applications: `select count(*) as created from applications where uuid not in (${FIXTURE_APP_UUIDS})` };
// Coolify's seeder makes the public GitHub source (GithubApp id 0, team 0) that emit.php's fixture leaves out;
// Freeploy's is the PUBLIC_GITHUB_SOURCE constant.
const PUBLIC_GITHUB = {
  setupCoolify: ["insert into github_apps (id, uuid, name, api_url, html_url, is_public, team_id, created_at, updated_at) values (0, 'githubpublicsource000000', 'Public GitHub', 'https://api.github.com', 'https://github.com', true, 0, now(), now())"],
  setupFreeploy: [],
};
const IMAGE_ON = { project_uuid: P_ALPHA, environment_name: "production", server_uuid: S_MAIN };
const CREATE = (type) => `/api/v1/applications/${type}`;
const IMG = CREATE("dockerimage");

// The shared part of create_application(), through the Docker image type.
add({ name: "app create: a Docker image", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", ports_exposes: "80" }, after: CREATED_AFTER });
add({ name: "app create: a Docker image with its fields", token: "write", method: "POST", path: IMG, body: { project_uuid: P_ALPHA, environment_uuid: E_STAGING, server_uuid: S_MAIN, destination_uuid: D_MAIN, docker_registry_image_name: "ghcr.io/acme/web", docker_registry_image_tag: "1.2.3", ports_exposes: "8080,9090", ports_mappings: "8080:80", name: "My Web", description: "From the API", domains: "https://web.acme.test, http://www.acme.test:8080", redirect: "www", health_check_enabled: true, health_check_path: "/health", health_check_port: 8080, health_check_interval: 15, limits_memory: "512m", limits_cpus: "1.5", custom_docker_run_options: "--cap-add=NET_ADMIN", post_deployment_command: "php artisan migrate", pre_deployment_command_container: "web", custom_network_aliases: "web, api ,web", is_auto_deploy_enabled: false, is_force_https_enabled: false, is_preview_deployments_enabled: true, connect_to_docker_network: true, use_build_server: false, is_container_label_escape_enabled: false, static_image: "nginx:alpine", preview_url_template: "{{pr_id}}.{{domain}}", max_restart_count: 3, tags: ["Backend", "New-Tag", " new-tag "] }, after: CREATED_AFTER });
add({ name: "app create: a Docker image by digest", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: `nginx@sha256:${"a".repeat(64)}`, autogenerate_domain: false }, after: CREATED_AFTER });
add({ name: "app create: a Docker image with a tag in its name", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "registry.acme.test:5000/team/app:v2" }, after: CREATED_AFTER });
add({ name: "app create: a Docker image, a variable tag", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "redis", docker_registry_image_tag: "${REDIS_TAG:-7}" }, after: CREATED_AFTER });
add({ name: "app create: a Docker image without a generated domain", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", autogenerate_domain: false, domains: "" }, after: CREATED_AFTER });
add({ name: "app create: a Docker image with the settings", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", is_gzip_enabled: false, is_stripprefix_enabled: "0", is_permanent_redirect_enabled: 1, traefik_certificate_resolver: "letsencrypt", stop_grace_period: 45, rolling_update_drain_seconds: 10, docker_images_to_keep: 5, gpu_count: "2", gpu_driver: "nvidia", is_gpu_enabled: true, custom_container_name_prefix: "My Prefix", custom_internal_name: "web-internal", is_log_drain_enabled: true, is_env_sorting_enabled: true, include_coolify_default_variables: false, is_image_scan_enabled: true, redact_all_env_values_in_logs: true }, after: CREATED_AFTER });
add({ name: "app create: a Docker image, label management off", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", is_container_label_readonly_enabled: false, custom_labels: b64("traefik.enable=true\ncom.example.team=web") }, after: CREATED_AFTER });
add({ name: "app create: a Docker image, custom labels regenerated", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", custom_labels: b64("com.example.team=web"), domains: "https://labels.acme.test" }, after: CREATED_AFTER });
add({ name: "app create: a Docker image, HTTP basic auth", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", is_container_label_readonly_enabled: false, is_http_basic_auth_enabled: true, http_basic_auth_username: "admin", http_basic_auth_password: "s3cret", http_basic_auth_bcrypt_cost: 5 }, after: CREATED_AFTER });
add({ name: "app create: a Docker image with a custom nginx configuration", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", custom_nginx_configuration: b64("server { listen 80; }") }, after: CREATED_AFTER });
add({ name: "app create: a Docker image, noindex domains", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", domains: "https://a.acme.test,https://b.acme.test", noindex_domains: ["https://b.acme.test"] }, after: CREATED_AFTER });
add({ name: "app create: a Docker image, a domain in use", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", domains: "https://image.example.com/" }, after: NOTHING_CREATED });
add({ name: "app create: a Docker image, a domain in use, forced", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", domains: "https://image.example.com", force_domain_override: true }, after: CREATED_AFTER });
add({ name: "app create: a Docker image, a service's domain in use", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", domains: "http://web.example.com" } });
add({ name: "app create: a Docker image, invalid domains", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", domains: "ftp://x.acme.test,https://ok.acme.test,not a url" } });
add({ name: "app create: instant deploy without the deploy permission", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", instant_deploy: true } });
add({ name: "app create: instant deploy", token: "root", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", instant_deploy: true }, after: NOTHING_CREATED });
add({ name: "app create: instant deploy false", token: "root", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", instant_deploy: false }, after: CREATED_AFTER });
add({ name: "app create: not JSON", token: "write", method: "POST", path: IMG, raw: "project_uuid=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "app create: empty JSON", token: "write", method: "POST", path: IMG, raw: "{}" });
add({ name: "app create: invalid JSON", token: "write", method: "POST", path: IMG, raw: "{nope" });
add({ name: "app create: a read token", token: "read", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx" } });
add({ name: "app create: a member", token: "memberWrite", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx" } });
add({ name: "app create: fields not allowed", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", fqdn: "https://x.acme.test", uuid: "x", status: "running" } });
add({ name: "app create: invalid", token: "write", method: "POST", path: IMG, body: { name: "x", description: "<script>", project_uuid: 5, environment_uuid: 3, server_uuid: null, destination_uuid: 7, is_http_basic_auth_enabled: "yes", http_basic_auth_username: 3, http_basic_auth_password: "p".repeat(73), autogenerate_domain: "no", tags: ["a", 5] } });
add({ name: "app create: a name with characters not allowed", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", name: "web;rm -rf", description: "fine" } });
add({ name: "app create: a null name", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", name: null } });
add({ name: "app create: HTTPS credentials", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", git_https_username: "u" } });
add({ name: "app create: docker_compose_raw not a string", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", docker_compose_raw: ["x"] } });
add({ name: "app create: tags too short after sanitization", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", tags: ["<b>a</b>", "ok"] } });
add({ name: "app create: no environment", token: "write", method: "POST", path: IMG, body: { project_uuid: P_ALPHA, server_uuid: S_MAIN, docker_registry_image_name: "nginx", environment_name: "" } });
add({ name: "app create: raw compose deployment", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", is_raw_compose_deployment_enabled: true } });
add({ name: "app create: nginx configuration not base64", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", custom_nginx_configuration: "server {}" } });
add({ name: "app create: nginx configuration not UTF-8", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", custom_nginx_configuration: Buffer.from([0xff, 0xfe, 0x41]).toString("base64") } });
add({ name: "app create: unknown project", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, project_uuid: "nonexistentuuid", docker_registry_image_name: "nginx" } });
add({ name: "app create: another team's project", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, project_uuid: P_OTHER, docker_registry_image_name: "nginx" } });
add({ name: "app create: unknown environment", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, environment_name: "nope", docker_registry_image_name: "nginx" } });
add({ name: "app create: an environment by uuid of another project", token: "write", method: "POST", path: IMG, body: { project_uuid: P_ALPHA, environment_uuid: E_BETA, server_uuid: S_MAIN, docker_registry_image_name: "nginx" } });
add({ name: "app create: unknown server", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, server_uuid: "nonexistentuuid", docker_registry_image_name: "nginx" } });
add({ name: "app create: another team's server", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, server_uuid: S_OTHER, docker_registry_image_name: "nginx" } });
add({ name: "app create: a build server", token: "write", method: "POST", path: IMG, setup: ["update server_settings set server_role = 'build' where server_id = 1"], body: { ...IMAGE_ON, docker_registry_image_name: "nginx", autogenerate_domain: false } });
const MAIN_SECOND_DESTINATION = destinationOn({ setupCoolify: [], setupFreeploy: [] }, 4, D_MAIN_B, "second-network", 1);
add({ name: "app create: a server with two destinations", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx" }, ...MAIN_SECOND_DESTINATION });
add({ name: "app create: a server with two destinations, another server's destination", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", destination_uuid: D_OTHER }, ...MAIN_SECOND_DESTINATION });
add({ name: "app create: a server with two destinations, the second", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", destination_uuid: D_MAIN_B }, ...MAIN_SECOND_DESTINATION, after: CREATED_AFTER });
add({ name: "app create: a container name prefix that is not a string", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", custom_container_name_prefix: ["x"] } });
add({ name: "app create: a container name prefix in use", token: "write", method: "POST", path: IMG, setup: ["update application_settings set custom_container_name_prefix = 'taken' where application_id = 2"], body: { ...IMAGE_ON, docker_registry_image_name: "nginx", custom_container_name_prefix: "Taken" } });
add({ name: "app create: a custom internal name without consistent names", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", custom_internal_name: "web", is_consistent_container_name_enabled: false } });
add({ name: "app create: a Docker image, no image", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON } });
add({ name: "app create: a Docker image, invalid fields", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx:sha256:abc", docker_registry_image_tag: "bad tag", ports_exposes: "80,abc", ports_mappings: "x", build_pack: "heroku", is_static: "maybe", static_image: "apache", redirect: "both-ways", git_branch: "main branch", git_commit_sha: "-x", health_check_type: "tcp", health_check_method: "PUT", health_check_scheme: "ftp", health_check_return_code: 99, health_check_port: 0, health_check_host: "bad host!", health_check_path: "/a b", health_check_interval: "often", max_restart_count: -1, docker_images_to_keep: 101, stop_grace_period: 0, rolling_update_drain_seconds: 301, http_basic_auth_hash_algorithm: "md5", http_basic_auth_bcrypt_cost: 3, http_basic_auth_argon2id_memory_cost: 10, manual_webhook_secret_github: "short", base_directory: "relative", publish_directory: "/ok", dockerfile_location: "Dockerfile", dockerfile_target_build: "-x", docker_compose_location: "/a b", install_command: "npm i; rm -rf /", custom_docker_run_options: "--x $(id)", pre_deployment_command_container: "-web", gpu_count: "many", gpu_options: "not valid", traefik_certificate_resolver: "bad resolver", custom_container_name_prefix: "p".repeat(31), custom_internal_name: "-x", noindex_domains: "x", health_check_response_text: "a\u0001b", limits_memory_swappiness: "x", preview_url_template: 5 } });
add({ name: "app create: a Docker image, an image name not a string", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: 5 } });
add({ name: "app create: a Docker image, a tag in both places", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx:1.25", docker_registry_image_tag: "alpine" } });
add({ name: "app create: argon2id", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", http_basic_auth_hash_algorithm: "argon2id" } });
add({ name: "app create: a host binding twice", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", ports_mappings: "8080:80,8080:81" } });
add({ name: "app create: a host binding twice, another protocol", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", ports_mappings: "8080:80,8080:80/udp,:90,:91" }, after: CREATED_AFTER });
add({ name: "app create: custom labels not base64", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", custom_labels: "traefik.enable=true" } });
add({ name: "app create: a webhook secret", token: "write", method: "POST", path: IMG, body: { ...IMAGE_ON, docker_registry_image_name: "nginx", manual_webhook_secret_github: "a-long-enough-secret" }, after: CREATED_AFTER });

// The Dockerfile type.
const DFILE = CREATE("dockerfile");
add({ name: "app create: a Dockerfile", token: "write", method: "POST", path: DFILE, body: { ...IMAGE_ON, dockerfile: b64("FROM nginx:alpine\nEXPOSE 3000\n") }, after: CREATED_AFTER });
add({ name: "app create: a Dockerfile with its fields", token: "write", method: "POST", path: DFILE, body: { ...IMAGE_ON, dockerfile: b64("FROM node:22\nCMD node server.js\n"), name: "api", ports_exposes: "3000", domains: "https://api.acme.test", dockerfile_location: "/build/Dockerfile/", base_directory: "/app/", is_static: true, is_auto_deploy_enabled: false }, after: CREATED_AFTER });
add({ name: "app create: a Dockerfile, none", token: "write", method: "POST", path: DFILE, body: { ...IMAGE_ON } });
add({ name: "app create: a Dockerfile not base64", token: "write", method: "POST", path: DFILE, body: { ...IMAGE_ON, dockerfile: "FROM nginx" } });
add({ name: "app create: a Dockerfile not UTF-8", token: "write", method: "POST", path: DFILE, body: { ...IMAGE_ON, dockerfile: Buffer.from([0xc3, 0x28]).toString("base64") } });
add({ name: "app create: a Dockerfile, invalid fields", token: "write", method: "POST", path: DFILE, body: { ...IMAGE_ON, dockerfile: 5, ports_exposes: 80, health_check_enabled: "x" } });
add({ name: "app create: a Dockerfile, a domain in use", token: "write", method: "POST", path: DFILE, body: { ...IMAGE_ON, dockerfile: b64("FROM nginx"), domains: "https://image.example.com" } });

// The public repository type.
const PUB = CREATE("public");
const PUBLIC_REPO = { ...IMAGE_ON, git_repository: "https://github.com/coollabsio/coolify-examples", git_branch: "main", build_pack: "nixpacks", ports_exposes: "3000" };
add({ name: "app create: a public repository", token: "write", method: "POST", path: PUB, body: PUBLIC_REPO, ...PUBLIC_GITHUB, after: CREATED_AFTER });
add({ name: "app create: a public repository with its fields", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, git_repository: "https://github.com/coollabsio/coolify-examples.git", name: "examples", build_pack: "static", is_static: true, is_spa: true, publish_directory: "/dist/", base_directory: "/web/", install_command: " npm ci ", build_command: "npm run build", start_command: "npm start", git_commit_sha: "a1b2c3d", watch_paths: "src/**\n!src/tests/**", is_git_submodules_enabled: true, is_git_lfs_enabled: false, is_preserve_repository_enabled: true, use_build_secrets: true, domains: "https://examples.acme.test" }, ...PUBLIC_GITHUB, after: CREATED_AFTER });
add({ name: "app create: a public repository of another host", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, git_repository: "https://gitlab.com/acme/web.git", build_pack: "dockerfile", dockerfile_location: null }, after: CREATED_AFTER });
add({ name: "app create: a public repository, HTTPS credentials", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, git_repository: "https://git.acme.test/team/web.git", git_https_username: "deploy", git_https_password: "token-123" }, after: CREATED_AFTER });
add({ name: "app create: a public repository, a username without a password", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, git_repository: "https://git.acme.test/team/web.git", git_https_username: "deploy" }, after: NOTHING_CREATED });
add({ name: "app create: a public repository, HTTPS credentials for github.com", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, git_https_password: "token-123" }, ...PUBLIC_GITHUB });
add({ name: "app create: a public repository, an SSH URL", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, git_repository: "git@gitlab.com:acme/web.git" }, after: CREATED_AFTER });
add({ name: "app create: a public repository, an ssh:// URL of github.com", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, git_repository: "ssh://git@github.com/coollabsio/coolify-examples.git" }, ...PUBLIC_GITHUB, after: CREATED_AFTER });
add({ name: "app create: a public repository, a Dockerfile build", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, build_pack: "dockerfile", dockerfile_location: "/docker/Dockerfile", dockerfile_target_build: "prod" }, ...PUBLIC_GITHUB, after: CREATED_AFTER });
add({ name: "app create: a public repository, none", token: "write", method: "POST", path: PUB, body: { ...IMAGE_ON } });
add({ name: "app create: a public repository, invalid", token: "write", method: "POST", path: PUB, body: { ...IMAGE_ON, git_repository: "ftp://example.com/x", git_branch: "-x;y", build_pack: "heroku", ports_exposes: "a" } });
add({ name: "app create: a public repository, an internal host", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, git_repository: "https://localhost/acme/web.git" } });
add({ name: "app create: a public repository, a query string", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, git_repository: "https://example.com/acme/web.git?x=1" } });
add({ name: "app create: a public repository, a branch with a pattern", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, git_branch: "feature..x" } });
add({ name: "app create: a public repository, HEAD", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, git_branch: "HEAD" } });
add({ name: "app create: a public repository, a Docker Compose build with domains", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, build_pack: "dockercompose", domains: "https://x.acme.test" } });
add({ name: "app create: a public repository, Docker Compose domains invalid", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, build_pack: "dockercompose", docker_compose_domains: [{ name: "web", domain: "https://a.acme.test", extra: 1 }, { domain: "x" }, { name: "db", redirect: "sideways" }] } });
add({ name: "app create: a public repository, Docker Compose domains twice", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, build_pack: "dockercompose", docker_compose_domains: [{ name: "web", domain: "https://a.acme.test" }, { name: "api", domain: "https://a.acme.test,https://b.acme.test" }] } });
add({ name: "app create: a public repository, Docker Compose domains in use", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, build_pack: "dockercompose", docker_compose_domains: [{ name: "web", domain: "https://image.example.com" }] } });
add({ name: "app create: a public repository, Docker Compose", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, build_pack: "dockercompose", docker_compose_location: "/compose.yaml", docker_compose_domains: [{ name: "web", domain: "https://web.acme.test", redirect: "www" }] }, ...PUBLIC_GITHUB, after: NOTHING_CREATED });
add({ name: "app create: a public repository, a name", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, git_repository: "https://gitlab.com/acme/My_Web.App.git", git_branch: "release/v1.2" }, after: CREATED_AFTER });

// The deploy key type.
const KEY = CREATE("private-deploy-key");
const KEY_REPO = { ...IMAGE_ON, private_key_uuid: K_MAIN, git_repository: "git@github.com:acme/private.git", git_branch: "main", build_pack: "nixpacks", ports_exposes: "3000" };
add({ name: "app create: a deploy key", token: "write", method: "POST", path: KEY, body: KEY_REPO, after: CREATED_AFTER });
add({ name: "app create: a deploy key, an HTTPS URL", token: "write", method: "POST", path: KEY, body: { ...KEY_REPO, git_repository: "https://gitlab.com/acme/private.git", build_pack: "dockerfile", name: "private-app", watch_paths: "src/**" }, after: CREATED_AFTER });
add({ name: "app create: a deploy key, unknown key", token: "write", method: "POST", path: KEY, body: { ...KEY_REPO, private_key_uuid: "nonexistentuuid" } });
add({ name: "app create: a deploy key of another team", token: "write", method: "POST", path: KEY, body: { ...KEY_REPO, private_key_uuid: K_OTHER } });
add({ name: "app create: a deploy key, no key", token: "write", method: "POST", path: KEY, body: { ...KEY_REPO, private_key_uuid: undefined, watch_paths: 5 } });
add({ name: "app create: a deploy key, HTTPS credentials", token: "write", method: "POST", path: KEY, body: { ...KEY_REPO, git_https_password: "x" } });
add({ name: "app create: a deploy key, a member", token: "memberWrite", method: "POST", path: KEY, body: KEY_REPO });
add({ name: "app create: a deploy key, a domain in use", token: "write", method: "POST", path: KEY, body: { ...KEY_REPO, domains: "https://image.example.com" } });
add({ name: "app create: a deploy key, instant deploy", token: "root", method: "POST", path: KEY, body: { ...KEY_REPO, instant_deploy: true }, after: NOTHING_CREATED });

// A deploy key application that is static: the labels are made before the static port reaches the model.
add({ name: "app create: a deploy key, static", token: "write", method: "POST", path: KEY, body: { ...KEY_REPO, build_pack: "static", is_static: true, ports_exposes: "3000" }, after: CREATED_AFTER });
add({ name: "app create: a public repository, static", token: "write", method: "POST", path: PUB, body: { ...PUBLIC_REPO, git_repository: "https://gitlab.com/acme/site.git", build_pack: "static", is_static: true, ports_exposes: "3000" }, after: CREATED_AFTER });

// ── DP-87: PATCH /applications/{uuid} (update_by_uuid) ──────────────────────
const UPDATED_AFTER = {
  applications: CREATED_AFTER.application.replace(/ from applications where uuid not in \(.*\)$/, " from applications where id in (1, 2) order by id").replace("replace(name, uuid, '<uuid>')", "name").replace("replace(fqdn, uuid, '<uuid>')", "fqdn").replace("replace(custom_labels, uuid, '<uuid>')", "custom_labels").replace("health_check_retries,", "health_check_retries, health_check_timeout, health_check_start_period,"),
  settings: CREATED_AFTER.settings.replace(/ from application_settings where application_id = .*$/, " from application_settings where application_id in (1, 2) order by application_id"),
  variables: "select resourceable_id, key, is_preview from environment_variables where resourceable_type = 'App\\Models\\Application' and resourceable_id in (1, 2) order by resourceable_id, key, is_preview",
};
const NO_LABELS_AFTER = { ...UPDATED_AFTER, applications: UPDATED_AFTER.applications.replace("custom_labels as custom_labels", "custom_labels is not null as has_custom_labels") };
const PATCH_APP = (uuid) => `/api/v1/applications/${uuid}`;
const GIT_OTHER_HOST = ["update applications set source_id = null, source_type = null, git_repository = 'https://git.acme.test/team/web.git' where id = 2"];
const DOCKERFILE_APP = ["update applications set build_pack = 'dockerfile', dockerfile = 'FROM nginx:alpine', dockerfile_location = '/Dockerfile', git_repository = 'coollabsio/coolify' where id = 1"];
const COMPOSE_APP = ["update applications set build_pack = 'dockercompose', docker_compose_raw = 'services:\n  web:\n    image: nginx\n  api:\n    image: node\n', docker_compose_domains = '{\"web\":{\"domain\":\"https://old.acme.test\",\"redirect\":\"www\"}}' where id = 2"];
add({ name: "app update: name and description", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { name: "Renamed image", description: "Changed" }, after: UPDATED_AFTER });
add({ name: "app update: the domains", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { domains: "HTTPS://New.Acme.test:8443, https://www.new.acme.test" }, after: UPDATED_AFTER });
add({ name: "app update: the domains of the Git application", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { domains: "https://git.acme.test", redirect: "non-www", ports_exposes: "3000,3001" }, after: UPDATED_AFTER });
add({ name: "app update: its own domain", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { domains: "https://image.example.com" } });
add({ name: "app update: a domain in use", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { domains: "https://image.example.com" }, after: UPDATED_AFTER });
add({ name: "app update: a domain in use, forced", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { domains: "https://image.example.com", force_domain_override: true }, after: UPDATED_AFTER });
add({ name: "app update: invalid domains", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { domains: "ftp://x.acme.test,nohost" } });
add({ name: "app update: no domains", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { domains: "" }, after: UPDATED_AFTER });
add({ name: "app update: noindex domains", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { noindex_domains: ["https://image.example.com", "https://gone.acme.test"] }, after: UPDATED_AFTER });
add({ name: "app update: the image", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { docker_registry_image_name: "ghcr.io/acme/web", docker_registry_image_tag: "2.0", ports_exposes: "8080" }, after: UPDATED_AFTER });
add({ name: "app update: many fields", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { git_branch: " develop ", git_commit_sha: "abc123", install_command: " npm ci ", build_command: "npm run build", start_command: null, base_directory: "/apps/web", publish_directory: "/dist/", health_check_enabled: true, health_check_path: "/up", health_check_port: 3000, health_check_type: "http", health_check_interval: 30, limits_memory: "1g", limits_cpus: "2", watch_paths: "/src/**\n !/docs", custom_network_aliases: "a,b", custom_docker_run_options: "--init", post_deployment_command: "echo done", pre_deployment_command_container: "web", static_image: "nginx:alpine", preview_url_template: "pr-{{pr_id}}.{{domain}}", max_restart_count: 5, dockerfile_target_build: "prod", dockerfile_location: "/Dockerfile.prod" }, after: UPDATED_AFTER });
add({ name: "app update: the settings", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { is_static: true, is_spa: true, is_auto_deploy_enabled: false, is_force_https_enabled: false, is_preview_deployments_enabled: true, connect_to_docker_network: true, use_build_server: false, use_build_secrets: true, is_container_label_escape_enabled: false, is_preserve_repository_enabled: true, include_source_commit_in_build: true, is_git_lfs_enabled: false, stop_grace_period: 20, docker_images_to_keep: 4, gpu_count: "all", custom_container_name_prefix: "Web App" }, after: UPDATED_AFTER });
add({ name: "app update: a label setting", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { is_gzip_enabled: false, traefik_certificate_resolver: "myresolver" }, after: UPDATED_AFTER });
add({ name: "app update: label management turned on", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), setup: ["update application_settings set is_container_label_readonly_enabled = false where application_id = 1"], body: { is_container_label_readonly_enabled: true }, after: UPDATED_AFTER });
add({ name: "app update: label management turned off", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { is_container_label_readonly_enabled: false, custom_labels: b64("com.example.x=1"), domains: "https://image.example.com/" , force_domain_override: true}, after: UPDATED_AFTER });
add({ name: "app update: custom labels with management on", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { custom_labels: b64("com.example.x=1") }, after: UPDATED_AFTER });
add({ name: "app update: HTTP basic auth without credentials", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { is_http_basic_auth_enabled: true } });
add({ name: "app update: HTTP basic auth without a password", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { is_http_basic_auth_enabled: true, http_basic_auth_username: "admin" } });
add({ name: "app update: HTTP basic auth", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { is_http_basic_auth_enabled: true, http_basic_auth_username: "admin", http_basic_auth_password: "s3cret" }, after: NO_LABELS_AFTER });
add({ name: "app update: ports exposes out of range", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { ports_exposes: "80,0" } });
add({ name: "app update: ports exposes not numbers", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { ports_exposes: "80,abc", name: "x" } });
add({ name: "app update: invalid", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { name: "x", description: "<x>", github_app_uuid: 5, watch_paths: 7, is_http_basic_auth_enabled: "yes", http_basic_auth_username: null, http_basic_auth_password: 5, include_source_commit_in_build: "x", ports_exposes: 80, is_static: "maybe", git_branch: "a b", redirect: "x", manual_webhook_secret_github: "short", health_check_return_code: 600 } });
add({ name: "app update: invalid with fields not allowed", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { redirect: "x", fqdn: "https://x.acme.test", uuid: "y", type: "public" } });
add({ name: "app update: fields not allowed", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { project_uuid: P_ALPHA, environment_name: "staging" } });
add({ name: "app update: a webhook secret", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { manual_webhook_secret_github: "a-new-long-enough-secret" }, after: UPDATED_AFTER });
add({ name: "app update: the current short webhook secret", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { manual_webhook_secret_gitea: "imagegitea".padEnd(40, "x") }, after: UPDATED_AFTER });
add({ name: "app update: a repository that is not a URL", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { git_repository: "not a url" } });
add({ name: "app update: a repository path", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { git_repository: "acme/other-repo" }, after: UPDATED_AFTER });
add({ name: "app update: custom nginx configuration not base64", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { custom_nginx_configuration: "server {}" } });
add({ name: "app update: custom nginx configuration", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { custom_nginx_configuration: b64("server { listen 8080; }") }, after: UPDATED_AFTER });
add({ name: "app update: a Dockerfile of an image application", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { dockerfile: b64("FROM nginx") } });
add({ name: "app update: a Dockerfile not base64", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), setup: DOCKERFILE_APP, body: { dockerfile: "FROM nginx" } });
add({ name: "app update: a Dockerfile with a health check", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), setup: DOCKERFILE_APP, body: { dockerfile: b64("FROM nginx:alpine\nHEALTHCHECK --interval=30s --timeout=3s --retries=4 CMD curl -f http://localhost/\n") }, after: UPDATED_AFTER });
add({ name: "app update: a Dockerfile, the health check removed", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), setup: [...DOCKERFILE_APP, "update applications set custom_healthcheck_found = true, health_check_interval = 30 where id = 1"], body: { dockerfile: b64("FROM nginx:alpine\n") }, after: UPDATED_AFTER });
add({ name: "app update: away from a Dockerfile", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), setup: DOCKERFILE_APP, body: { build_pack: "nixpacks", ports_exposes: "3000" }, after: UPDATED_AFTER });
add({ name: "app update: away from Docker Compose", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), setup: COMPOSE_APP, setupCoolify: ["insert into environment_variables (uuid, key, value, resourceable_type, resourceable_id, is_preview, created_at, updated_at) values ('z1servicefqdnvariable001', 'SERVICE_FQDN_WEB', null, 'App\\Models\\Application', 2, false, now(), now())"], setupFreeploy: ["insert into environment_variables (uuid, key, value, resourceable_type, resourceable_id, is_preview, org_id, created_at, updated_at) values ('z1servicefqdnvariable001', 'SERVICE_FQDN_WEB', null, 'App\\Models\\Application', 2, false, deploy.current_org(), now(), now())"], body: { build_pack: "nixpacks" }, after: UPDATED_AFTER });
add({ name: "app update: domains of a Docker Compose application", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), setup: COMPOSE_APP, body: { domains: "https://x.acme.test" } });
add({ name: "app update: Docker Compose domains without a file", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { docker_compose_domains: [{ name: "web", domain: "https://web.acme.test" }] } });
add({ name: "app update: Docker Compose domains", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), setup: COMPOSE_APP, body: { docker_compose_domains: [{ name: "web", domain: "https://web.acme.test:8080" }, { name: "api", domain: "https://api.acme.test", redirect: "non-www" }, { name: "missing", domain: "https://missing.acme.test" }] }, after: UPDATED_AFTER });
add({ name: "app update: Docker Compose domains, invalid", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), setup: COMPOSE_APP, body: { docker_compose_domains: [{ name: "web", domain: "https://a.acme.test" }, { name: "api", domain: "https://a.acme.test" }] } });
add({ name: "app update: Docker Compose domains in use", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), setup: COMPOSE_APP, body: { docker_compose_domains: [{ name: "web", domain: "https://image.example.com" }] } });
add({ name: "app update: a GitHub App for an image application", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { github_app_uuid: "x" } });
add({ name: "app update: an unknown GitHub App", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { github_app_uuid: "nonexistentuuid" } });
add({ name: "app update: an unknown Gitea App", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { gitea_app_uuid: "nonexistentuuid" } });
add({ name: "app update: both sources", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { github_app_uuid: "a", gitea_app_uuid: "b" } });
add({ name: "app update: HTTPS credentials of a source application", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { git_https_password: "x" }, ...PUBLIC_GITHUB });
add({ name: "app update: HTTPS credentials", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), setup: GIT_OTHER_HOST, body: { git_https_username: "deploy", git_https_password: "token-1" }, after: NO_LABELS_AFTER });
add({ name: "app update: an HTTPS username without a password", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), setup: GIT_OTHER_HOST, body: { git_https_username: "deploy" } });
add({ name: "app update: HTTPS credentials removed", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), setup: [...GIT_OTHER_HOST, "update applications set git_https_username = 'deploy', git_https_password = 'x' where id = 2"], body: { git_https_password: "" }, after: NO_LABELS_AFTER });
add({ name: "app update: a container name prefix in use", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { custom_container_name_prefix: A_GIT } });
add({ name: "app update: its own container name prefix", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { custom_container_name_prefix: A_IMAGE }, after: UPDATED_AFTER });
add({ name: "app update: an image another application builds", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), setup: ["update applications set build_pack = 'dockerfile', docker_registry_image_name = 'acme/shared' where id = 1"], body: { docker_registry_image_name: "acme/shared" } });
add({ name: "app update: a custom internal name without consistent names", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { custom_internal_name: "web", is_consistent_container_name_enabled: false } });
add({ name: "app update: raw compose deployment", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { is_raw_compose_deployment_enabled: true } });
add({ name: "app update: the environment settings", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { redact_all_env_values_in_logs: false, include_coolify_default_variables: false }, after: UPDATED_AFTER });
add({ name: "app update: instant deploy without the deploy permission", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { name: "deployed", instant_deploy: true } });
add({ name: "app update: instant deploy", token: "root", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { name: "deployed", instant_deploy: true }, after: UPDATED_AFTER });
add({ name: "app update: not JSON", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), raw: "name=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "app update: empty JSON", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), raw: "{}" });
add({ name: "app update: unknown application", token: "write", method: "PATCH", path: PATCH_APP("nonexistentuuid"), body: { name: "nope" } });
add({ name: "app update: another team's application", token: "write", method: "PATCH", path: PATCH_APP(A_OTHER), body: { name: "nope" } });
add({ name: "app update: a read token", token: "read", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { name: "nope" } });

// ── DP-88: a database's and a service's container logs ──────────────────────
const DB_LOGS = (uuid) => `/api/v1/databases/${uuid}/logs`;
add({ name: "database logs: the server not functional", token: "sensitive", method: "GET", path: DB_LOGS(DB_PG) });
add({ name: "database logs", token: "root", method: "GET", path: `${DB_LOGS(DB_REDIS)}?lines=20&show_timestamps=true`, setup: FUNCTIONAL });
add({ name: "database logs on a Swarm server", token: "root", method: "GET", path: DB_LOGS(DB_PG), setup: SWARM_SERVER });
add({ name: "database logs of unknown", token: "root", method: "GET", path: DB_LOGS("nonexistentuuid") });
add({ name: "database logs of another team's", token: "root", method: "GET", path: DB_LOGS(DB_OTHER) });
add({ name: "database logs, a member", token: "memberSensitive", method: "GET", path: DB_LOGS(DB_MYSQL), setup: SWARM_SERVER });
add({ name: "database logs with a read token", token: "read", method: "GET", path: DB_LOGS(DB_PG) });
const SV_LOGS = (uuid, query = "?sub_service_name=web") => `/api/v1/services/${uuid}/logs${query}`;
add({ name: "service logs: the server not functional", token: "sensitive", method: "GET", path: SV_LOGS(SV_MAIN) });
add({ name: "service logs", token: "root", method: "GET", path: SV_LOGS(SV_MAIN, "?sub_service_name=db&lines=10"), setup: FUNCTIONAL });
add({ name: "service logs on a Swarm server", token: "root", method: "GET", path: SV_LOGS(SV_MAIN), setup: SWARM_SERVER });
add({ name: "service logs without a sub service", token: "root", method: "GET", path: SV_LOGS(SV_MAIN, "") });
add({ name: "service logs, an empty sub service", token: "root", method: "GET", path: SV_LOGS("nonexistentuuid", "?sub_service_name=") });
add({ name: "service logs of unknown", token: "root", method: "GET", path: SV_LOGS("nonexistentuuid") });
add({ name: "service logs of another team's", token: "root", method: "GET", path: SV_LOGS(SV_OTHER) });
add({ name: "service logs of a deleted service", token: "root", method: "GET", path: SV_LOGS(SV_MAIN), setup: ["update services set deleted_at = '2025-12-31 00:00:00' where id = 1"] });
add({ name: "service logs with a read token", token: "read", method: "GET", path: SV_LOGS(SV_MAIN) });

// ── DP-88: an application's rollback images and rollback ────────────────────
const ROLLBACK_IMAGES = (uuid) => `/api/v1/applications/${uuid}/rollback-images`;
const ROLLBACK = (uuid) => `/api/v1/applications/${uuid}/rollback`;
/** The Git application pushes its builds to a registry, and three of its deployments finished (two of production, one of a pull request; the queue's rows have the team's tenancy column on each side). */
const REGISTRY_BUILDS = {
  setup: [
  "update applications set docker_registry_image_name = 'ghcr.io/parity/git' where id = 2",
  "update application_deployment_queues set status = 'finished', updated_at = '2025-12-29 10:01:00' where id = 5",
  ],
  setupCoolify: [
    "insert into application_deployment_queues (id, application_id, deployment_uuid, pull_request_id, force_rebuild, commit, status, is_webhook, server_id, destination_id, application_name, server_name, rollback, created_at, updated_at) values (6, '2', 'q6paritygitfinished00006', 0, false, 'f00dbabe', 'finished', false, 1, '1', 'parity-git', 'parity-server', false, '2025-12-30 09:00:00', '2025-12-30 09:05:00')",
    "insert into application_deployment_queues (id, application_id, deployment_uuid, pull_request_id, force_rebuild, commit, status, is_webhook, server_id, destination_id, application_name, server_name, rollback, created_at, updated_at) values (7, '2', 'q7paritygitagain00000007', 0, false, 'a1b2c3d', 'finished', false, 1, '1', 'parity-git', 'parity-server', false, '2025-12-31 09:00:00', '2025-12-31 09:05:00')",
    "insert into application_deployment_queues (id, application_id, deployment_uuid, pull_request_id, force_rebuild, commit, status, is_webhook, server_id, destination_id, application_name, server_name, rollback, created_at, updated_at) values (8, '2', 'q8paritygitpullrequest08', 4, false, 'beefcafe', 'finished', false, 1, '1', 'parity-git', 'parity-server', false, '2025-12-31 10:00:00', '2025-12-31 10:05:00')",
    "insert into application_deployment_queues (id, application_id, deployment_uuid, pull_request_id, force_rebuild, commit, status, is_webhook, server_id, destination_id, application_name, server_name, rollback, created_at, updated_at) values (9, '2', 'q9paritygithead000000009', 0, false, 'HEAD', 'finished', false, 1, '1', 'parity-git', 'parity-server', false, '2025-12-31 11:00:00', '2025-12-31 11:05:00')",
  ],
  setupFreeploy: [
    "insert into application_deployment_queues (id, application_id, deployment_uuid, pull_request_id, force_rebuild, commit, status, is_webhook, server_id, destination_id, application_name, server_name, rollback, org_id, created_at, updated_at) values (6, '2', 'q6paritygitfinished00006', 0, false, 'f00dbabe', 'finished', false, 1, '1', 'parity-git', 'parity-server', false, deploy.current_org(), '2025-12-30 09:00:00', '2025-12-30 09:05:00')",
    "insert into application_deployment_queues (id, application_id, deployment_uuid, pull_request_id, force_rebuild, commit, status, is_webhook, server_id, destination_id, application_name, server_name, rollback, org_id, created_at, updated_at) values (7, '2', 'q7paritygitagain00000007', 0, false, 'a1b2c3d', 'finished', false, 1, '1', 'parity-git', 'parity-server', false, deploy.current_org(), '2025-12-31 09:00:00', '2025-12-31 09:05:00')",
    "insert into application_deployment_queues (id, application_id, deployment_uuid, pull_request_id, force_rebuild, commit, status, is_webhook, server_id, destination_id, application_name, server_name, rollback, org_id, created_at, updated_at) values (8, '2', 'q8paritygitpullrequest08', 4, false, 'beefcafe', 'finished', false, 1, '1', 'parity-git', 'parity-server', false, deploy.current_org(), '2025-12-31 10:00:00', '2025-12-31 10:05:00')",
    "insert into application_deployment_queues (id, application_id, deployment_uuid, pull_request_id, force_rebuild, commit, status, is_webhook, server_id, destination_id, application_name, server_name, rollback, org_id, created_at, updated_at) values (9, '2', 'q9paritygithead000000009', 0, false, 'HEAD', 'finished', false, 1, '1', 'parity-git', 'parity-server', false, deploy.current_org(), '2025-12-31 11:00:00', '2025-12-31 11:05:00')",
  ],
};
/** The deployment of f00dbabe was itself a rollback: only the registry's image allows it (after the queue's rows are made). */
const ROLLED_BACK = "update application_deployment_queues set rollback = true where deployment_uuid = 'q6paritygitfinished00006'";
const ROLLBACK_AFTER = { deployments: "select application_id, commit, status, rollback, pull_request_id from application_deployment_queues where application_id in ('1', '2') order by id" };
add({ name: "rollback images: an image application", token: "read", method: "GET", path: ROLLBACK_IMAGES(A_IMAGE) });
add({ name: "rollback images: the registry's builds", token: "read", method: "GET", path: ROLLBACK_IMAGES(A_GIT), ...REGISTRY_BUILDS });
add({ name: "rollback images: without a registry image", token: "read", method: "GET", path: ROLLBACK_IMAGES(A_GIT) });
add({ name: "rollback images: a Dockerfile application", token: "read", method: "GET", path: ROLLBACK_IMAGES(A_GIT), ...REGISTRY_BUILDS, setup: [...REGISTRY_BUILDS.setup, "update applications set dockerfile = 'FROM nginx' where id = 2"] });
add({ name: "rollback images: a Docker Compose application", token: "read", method: "GET", path: ROLLBACK_IMAGES(A_GIT), ...REGISTRY_BUILDS, setup: [...REGISTRY_BUILDS.setup, "update applications set build_pack = 'dockercompose' where id = 2"] });
add({ name: "rollback images: on a functional server", token: "read", method: "GET", path: ROLLBACK_IMAGES(A_GIT), ...REGISTRY_BUILDS, setup: [...REGISTRY_BUILDS.setup, ...FUNCTIONAL] });
add({ name: "rollback images of unknown", token: "read", method: "GET", path: ROLLBACK_IMAGES("nonexistentuuid") });
add({ name: "rollback images of another team's", token: "read", method: "GET", path: ROLLBACK_IMAGES(A_OTHER) });
add({ name: "rollback: a deployed commit", token: "deploy", method: "POST", path: ROLLBACK(A_GIT), ...REGISTRY_BUILDS, body: { commit: "f00dbabe" }, after: ROLLBACK_AFTER });
add({ name: "rollback: the finished HEAD", token: "root", method: "POST", path: ROLLBACK(A_IMAGE), body: { commit: " HEAD " }, after: ROLLBACK_AFTER });
add({ name: "rollback: a registry build", token: "deploy", method: "POST", path: ROLLBACK(A_GIT), ...REGISTRY_BUILDS, setupCoolify: [...REGISTRY_BUILDS.setupCoolify, ROLLED_BACK], setupFreeploy: [...REGISTRY_BUILDS.setupFreeploy, ROLLED_BACK], body: { commit: "f00dbabe" }, after: ROLLBACK_AFTER });
add({ name: "rollback: a pull request's commit", token: "deploy", method: "POST", path: ROLLBACK(A_GIT), ...REGISTRY_BUILDS, body: { commit: "beefcafe" }, after: ROLLBACK_AFTER });
add({ name: "rollback: a failed deployment's commit", token: "deploy", method: "POST", path: ROLLBACK(A_GIT), body: { commit: "a1b2c3d" }, after: ROLLBACK_AFTER });
add({ name: "rollback: an unknown commit on a functional server", token: "deploy", method: "POST", path: ROLLBACK(A_GIT), setup: FUNCTIONAL, body: { commit: "0123abc" }, after: ROLLBACK_AFTER });
add({ name: "rollback: a commit starting with a hyphen", token: "deploy", method: "POST", path: ROLLBACK(A_GIT), body: { commit: "-x" } });
add({ name: "rollback: a commit with spaces", token: "deploy", method: "POST", path: ROLLBACK(A_GIT), body: { commit: "a b" } });
add({ name: "rollback: an empty commit", token: "deploy", method: "POST", path: ROLLBACK(A_GIT), body: { commit: "   " } });
add({ name: "rollback: no commit", token: "deploy", method: "POST", path: ROLLBACK(A_GIT), body: { tag: "v1" } });
add({ name: "rollback: a commit that is not a string", token: "deploy", method: "POST", path: ROLLBACK(A_GIT), body: { commit: 12345 } });
add({ name: "rollback: not JSON", token: "deploy", method: "POST", path: ROLLBACK(A_GIT), raw: "commit=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "rollback: empty JSON", token: "deploy", method: "POST", path: ROLLBACK(A_GIT), raw: "{}" });
add({ name: "rollback of unknown", token: "deploy", method: "POST", path: ROLLBACK("nonexistentuuid"), body: { commit: "HEAD" } });
add({ name: "rollback of another team's", token: "deploy", method: "POST", path: ROLLBACK(A_OTHER), body: { commit: "HEAD" } });
add({ name: "rollback with a write token", token: "write", method: "POST", path: ROLLBACK(A_GIT), body: { commit: "HEAD" } });

// ── DP-88: executing a scheduled task now ───────────────────────────────────
for (const [group, base, uuid, other, task, otherTask] of [
  ["application", "applications", A_IMAGE, A_OTHER, ST_BACKUP, ST_SERVICE],
  ["service", "services", SV_MAIN, SV_OTHER, ST_SERVICE, ST_BACKUP],
]) {
  const path = (owner, t) => `/api/v1/${base}/${owner}/scheduled-tasks/${t}/execute`;
  add({ name: `execute ${group} task`, token: "deploy", method: "POST", path: path(uuid, task), after: TASKS_AFTER });
  add({ name: `execute ${group} task, root`, token: "root", method: "POST", path: path(uuid, task) });
  add({ name: `execute ${group} task: unknown task`, token: "deploy", method: "POST", path: path(uuid, "nonexistentuuid") });
  add({ name: `execute ${group} task: another resource's task`, token: "deploy", method: "POST", path: path(uuid, otherTask) });
  add({ name: `execute ${group} task: unknown ${group}`, token: "deploy", method: "POST", path: path("nonexistentuuid", task) });
  add({ name: `execute ${group} task: another team's ${group}`, token: "deploy", method: "POST", path: path(other, ST_OTHER) });
  add({ name: `execute ${group} task with a write token`, token: "write", method: "POST", path: path(uuid, task) });
}
add({ name: "execute application task: a disabled task", token: "deploy", method: "POST", path: `/api/v1/applications/${A_IMAGE}/scheduled-tasks/${ST_CLEANUP}/execute` });

// ── DP-88: the backup schedule of a storage ─────────────────────────────────
const PG_VOLUME = "l4paritypgdatavolume0004";
/** The PostgreSQL's data volume (its created hook made it with a random uuid): a fixed uuid on both sides. */
const PG_VOLUME_SETUP = [`update local_persistent_volumes set uuid = '${PG_VOLUME}' where resource_type = 'App\\Models\\StandalonePostgresql' and resource_id = 1`];
const VB = (base, owner, storage, run = false) => `/api/v1/${base}/${owner}/storages/${storage}/backups${run ? "/run" : ""}`;
const VB_AFTER = {
  schedules:
    "select case when uuid like 'v%parityschedule%' then uuid end as fixture_uuid, backupable_type, backupable_id, s3_storage_id, frequency, enabled, save_s3, disable_local_backup, stop_during_backup, retention_amount_locally, retention_days_locally, retention_max_storage_locally::float8::text as max_locally, retention_amount_s3, retention_days_s3, retention_max_storage_s3::float8::text as max_s3, timeout, missing_backup_notification_days from scheduled_volume_backups order by backupable_type, backupable_id",
  s3: "select b.backupable_type, b.backupable_id, p.s3_storage_id from scheduled_volume_backup_s3_storage p join scheduled_volume_backups b on b.id = p.scheduled_volume_backup_id order by b.backupable_type, b.backupable_id, p.s3_storage_id",
};
/** A schedule of the application's volume, made by the case on each side (Coolify's table has team_id, Freeploy's org_id). */
const scheduleOf = (uuid, type, id, extra = "") => ({
  setupCoolify: [`insert into scheduled_volume_backups (uuid, backupable_type, backupable_id, team_id, frequency, timeout, created_at, updated_at${extra ? ", s3_storage_id, save_s3" : ""}) values ('${uuid}', '${type}', ${id}, 1, '0 2 * * *', 3600, now(), now()${extra})`],
  setupFreeploy: [`insert into scheduled_volume_backups (uuid, backupable_type, backupable_id, org_id, frequency, timeout, created_at, updated_at${extra ? ", s3_storage_id, save_s3" : ""}) values ('${uuid}', '${type}', ${id}, deploy.current_org(), '0 2 * * *', 3600, now(), now()${extra})`],
});
const VOLUME_TYPE = "App\\Models\\LocalPersistentVolume";
const FILE_TYPE = "App\\Models\\LocalFileVolume";
const APP_SCHEDULE = scheduleOf("v1parityschedule00000001", VOLUME_TYPE, 12);
const APP_SCHEDULE_S3 = scheduleOf("v1parityschedule00000001", VOLUME_TYPE, 12, ", 1, true");
const APP_VB = VB("applications", A_IMAGE, PV_APP);
add({ name: "volume backups: create", token: "root", method: "PUT", path: APP_VB, body: { frequency: "0 3 * * *" }, after: VB_AFTER });
add({ name: "volume backups: create, every field", token: "root", method: "PUT", path: APP_VB, body: { frequency: "@daily", enabled: false, save_s3: true, disable_local_backup: true, stop_during_backup: true, s3_storage_uuid: S3_MAIN, retention_amount_locally: 3, retention_days_locally: 14, retention_max_storage_locally: 2.5, retention_amount_s3: 10, retention_days_s3: 30, retention_max_storage_s3: "12", timeout: 600, missing_backup_notification_days: 2 }, after: VB_AFTER });
add({ name: "volume backups: create with an S3 list", token: "root", method: "PUT", path: APP_VB, body: { frequency: "0 3 * * *", save_s3: true, s3_storage_uuids: [S3_MAIN] }, after: VB_AFTER });
add({ name: "volume backups: create with a write token", token: "write", method: "PUT", path: APP_VB, body: { frequency: "weekly" }, after: VB_AFTER });
add({ name: "volume backups: update", token: "root", method: "PUT", path: APP_VB, ...APP_SCHEDULE, body: { frequency: "*/30 * * * *", retention_amount_locally: 1 }, after: VB_AFTER });
add({ name: "volume backups: update, S3 turned off", token: "root", method: "PUT", path: APP_VB, ...APP_SCHEDULE_S3, body: { frequency: "0 2 * * *" }, after: VB_AFTER });
add({ name: "volume backups: update, the same S3 storage", token: "root", method: "PUT", path: APP_VB, ...APP_SCHEDULE_S3, body: { frequency: "0 2 * * *", save_s3: "1", s3_storage_uuid: S3_MAIN, timeout: "900" }, after: VB_AFTER });
add({ name: "volume backups: a directory", token: "root", method: "PUT", path: VB("applications", A_IMAGE, FV_DIR), body: { frequency: "0 4 * * *" }, after: VB_AFTER });
add({ name: "volume backups: a file", token: "root", method: "PUT", path: VB("applications", A_IMAGE, FV_CONFIG), body: { frequency: "0 4 * * *" } });
add({ name: "volume backups: a host file", token: "root", method: "PUT", path: VB("applications", A_IMAGE, FV_HOST), body: { frequency: "bad", extra: 1 } });
add({ name: "volume backups: invalid", token: "root", method: "PUT", path: APP_VB, body: { frequency: ["x"], enabled: "maybe", save_s3: 2, s3_storage_uuids: "x", retention_amount_locally: -1, retention_days_locally: "x", retention_max_storage_locally: "lots", retention_amount_s3: 10001, timeout: 59, missing_backup_notification_days: 366, every: "day" } });
add({ name: "volume backups: no frequency", token: "root", method: "PUT", path: APP_VB, body: { enabled: true } });
add({ name: "volume backups: a bad frequency", token: "root", method: "PUT", path: APP_VB, body: { frequency: "every day" } });
add({ name: "volume backups: local backups off without S3", token: "root", method: "PUT", path: APP_VB, body: { frequency: "@daily", disable_local_backup: true } });
add({ name: "volume backups: S3 without a storage", token: "root", method: "PUT", path: APP_VB, body: { frequency: "@daily", save_s3: true } });
add({ name: "volume backups: another team's S3 storage", token: "root", method: "PUT", path: APP_VB, body: { frequency: "@daily", save_s3: true, s3_storage_uuid: S3_OTHER } });
add({ name: "volume backups: an S3 storage not in the list", token: "root", method: "PUT", path: APP_VB, body: { frequency: "@daily", save_s3: true, s3_storage_uuid: S3_MAIN, s3_storage_uuids: ["nonexistentuuid"] } });
add({ name: "volume backups: duplicate S3 storages", token: "root", method: "PUT", path: APP_VB, body: { frequency: "@daily", save_s3: true, s3_storage_uuids: [S3_MAIN, S3_MAIN] } });
add({ name: "volume backups: an unusable S3 storage", token: "root", method: "PUT", path: APP_VB, setup: ["update s3_storages set is_usable = false where id = 1"], body: { frequency: "@daily", save_s3: true, s3_storage_uuid: S3_MAIN } });
add({ name: "volume backups: stop during backup without the deploy permission", token: "write", method: "PUT", path: APP_VB, body: { frequency: "@daily", stop_during_backup: true } });
add({ name: "volume backups: stop during backup of unknown storage, a write token", token: "write", method: "PUT", path: VB("applications", A_IMAGE, "nonexistentuuid"), body: { frequency: "@daily", stop_during_backup: true } });
add({ name: "volume backups: unknown storage", token: "root", method: "PUT", path: VB("applications", A_IMAGE, "nonexistentuuid"), body: { frequency: "@daily" } });
add({ name: "volume backups: another application's storage", token: "root", method: "PUT", path: VB("applications", A_GIT, PV_APP), body: { frequency: "@daily" } });
add({ name: "volume backups: unknown application", token: "root", method: "PUT", path: VB("applications", "nonexistentuuid", PV_APP), body: { frequency: "@daily" } });
add({ name: "volume backups: another team's application", token: "root", method: "PUT", path: VB("applications", A_OTHER, PV_OTHER), body: { frequency: "@daily" } });
add({ name: "volume backups: not JSON", token: "root", method: "PUT", path: APP_VB, raw: "frequency=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "volume backups: empty JSON", token: "root", method: "PUT", path: APP_VB, raw: "{}" });
add({ name: "volume backups: a database's volume", token: "root", method: "PUT", path: VB("databases", DB_PG, PG_VOLUME), setup: PG_VOLUME_SETUP, body: { frequency: "0 5 * * *", save_s3: true, s3_storage_uuid: S3_MAIN }, after: VB_AFTER });
add({ name: "volume backups: a database's file", token: "root", method: "PUT", path: VB("databases", DB_PG, FV_PG), body: { frequency: "0 5 * * *" } });
add({ name: "volume backups: unknown database", token: "root", method: "PUT", path: VB("databases", "nonexistentuuid", FV_PG), body: { frequency: "@daily" } });
add({ name: "volume backups: a service's volume", token: "root", method: "PUT", path: VB("services", SV_MAIN, PV_SERVICE), body: { frequency: "0 6 * * *" }, after: VB_AFTER });
add({ name: "volume backups: unknown service", token: "root", method: "PUT", path: VB("services", "nonexistentuuid", PV_SERVICE), body: { frequency: "@daily" } });
add({ name: "volume backups: a service's unknown storage", token: "root", method: "PUT", path: VB("services", SV_MAIN, PV_APP), body: { frequency: "@daily" } });
add({ name: "volume backups: with a read token", token: "read", method: "PUT", path: APP_VB, body: { frequency: "@daily" } });
// DELETE …/backups: DeleteScheduledVolumeBackup (no execution has archives, so nothing runs on the server).
add({ name: "volume backups: delete", token: "delete", method: "DELETE", path: APP_VB, ...APP_SCHEDULE_S3, setupCoolify: [...APP_SCHEDULE_S3.setupCoolify, "insert into scheduled_volume_backup_s3_storage (scheduled_volume_backup_id, s3_storage_id) select id, 1 from scheduled_volume_backups"], setupFreeploy: [...APP_SCHEDULE_S3.setupFreeploy, "insert into scheduled_volume_backup_s3_storage (scheduled_volume_backup_id, s3_storage_id, org_id) select id, 1, deploy.current_org() from scheduled_volume_backups"], after: VB_AFTER });
add({ name: "volume backups: delete, no schedule", token: "delete", method: "DELETE", path: APP_VB });
add({ name: "volume backups: delete, unknown storage", token: "delete", method: "DELETE", path: VB("applications", A_IMAGE, "nonexistentuuid") });
add({ name: "volume backups: delete, unknown application", token: "delete", method: "DELETE", path: VB("applications", "nonexistentuuid", PV_APP) });
add({ name: "volume backups: delete, unknown database", token: "delete", method: "DELETE", path: VB("databases", "nonexistentuuid", PV_APP) });
add({ name: "volume backups: delete, unknown service", token: "delete", method: "DELETE", path: VB("services", "nonexistentuuid", PV_APP) });
add({ name: "volume backups: delete a database's", token: "delete", method: "DELETE", path: VB("databases", DB_PG, PG_VOLUME), setup: PG_VOLUME_SETUP, ...scheduleOf("v2parityschedule00000002", VOLUME_TYPE, 2), after: VB_AFTER });
add({ name: "volume backups: delete a service's", token: "delete", method: "DELETE", path: VB("services", SV_MAIN, PV_SERVICE), ...scheduleOf("v3parityschedule00000003", VOLUME_TYPE, 13), after: VB_AFTER });
add({ name: "volume backups: delete while a backup runs", token: "delete", method: "DELETE", path: APP_VB, setupCoolify: [...APP_SCHEDULE.setupCoolify, "insert into scheduled_volume_backup_executions (uuid, scheduled_volume_backup_id, status, created_at, updated_at) select 'u1parityrunningexecution', id, 'running', now(), now() from scheduled_volume_backups"], setupFreeploy: [...APP_SCHEDULE.setupFreeploy, "insert into scheduled_volume_backup_executions (uuid, scheduled_volume_backup_id, status, org_id, created_at, updated_at) select 'u1parityrunningexecution', id, 'running', deploy.current_org(), now(), now() from scheduled_volume_backups"], after: VB_AFTER });
add({ name: "volume backups: delete with a write token", token: "write", method: "DELETE", path: APP_VB });
// POST …/backups/run: VolumeBackupJob, queued.
add({ name: "volume backups: run", token: "root", method: "POST", path: VB("applications", A_IMAGE, PV_APP, true), ...APP_SCHEDULE, after: VB_AFTER });
add({ name: "volume backups: run a database's", token: "root", method: "POST", path: VB("databases", DB_PG, PG_VOLUME, true), setup: PG_VOLUME_SETUP, ...scheduleOf("v2parityschedule00000002", VOLUME_TYPE, 2) });
add({ name: "volume backups: run a service's", token: "root", method: "POST", path: VB("services", SV_MAIN, PV_SERVICE, true), ...scheduleOf("v3parityschedule00000003", VOLUME_TYPE, 13) });
add({ name: "volume backups: run, no schedule", token: "root", method: "POST", path: VB("applications", A_IMAGE, PV_APP, true) });
add({ name: "volume backups: run, unknown storage", token: "root", method: "POST", path: VB("applications", A_IMAGE, "nonexistentuuid", true) });
add({ name: "volume backups: run, unknown application", token: "root", method: "POST", path: VB("applications", "nonexistentuuid", PV_APP, true) });
add({ name: "volume backups: run, unknown database", token: "root", method: "POST", path: VB("databases", "nonexistentuuid", PV_APP, true) });
add({ name: "volume backups: run, unknown service", token: "root", method: "POST", path: VB("services", "nonexistentuuid", PV_APP, true) });
add({ name: "volume backups: run with a read token", token: "read", method: "POST", path: VB("applications", A_IMAGE, PV_APP, true) });
add({ name: "volume backups: run with a write token", token: "write", method: "POST", path: VB("applications", A_IMAGE, PV_APP, true) });

// ── DP-88: a server's proxy settings ────────────────────────────────────────
const SRV = (sub, uuid = S_MAIN) => `/api/v1/servers/${uuid}/${sub}`;
const PROXY_AFTER = {
  // The proxy as the model reads it: Server's retrieved hook gives redirect_enabled true when it is missing (Freeploy stores it).
  server: "select (case when proxy is null or (proxy::jsonb -> 'redirect_enabled') is null then coalesce(proxy::jsonb, '{}'::jsonb) || '{\"redirect_enabled\": true}'::jsonb else proxy::jsonb end)::text as proxy, proxy_error_page, detected_traefik_version, ip, ip_previous from servers where id = 1",
  settings: "select generate_exact_labels, traefik_certificate_resolver, is_cloudflare_tunnel, ssh_host_key, ssh_host_key_source, ssh_host_key_pending from server_settings where server_id = 1",
};
const TRAEFIK_PROXY = [`update servers set proxy = '{"type":"TRAEFIK","status":"running","redirect_enabled":false,"redirect_url":"https://fallback.example.com","last_saved_proxy_configuration":"services:\\n  traefik:\\n    image: traefik:v3.1\\n"}', proxy_error_page = '<h1>Oops</h1>' where id = 1`];
add({ name: "server proxy: show", token: "read", method: "GET", path: SRV("proxy") });
add({ name: "server proxy: show, read:sensitive", token: "sensitive", method: "GET", path: SRV("proxy") });
add({ name: "server proxy: show Traefik", token: "read", method: "GET", path: SRV("proxy"), setup: TRAEFIK_PROXY });
add({ name: "server proxy: show Traefik, read:sensitive", token: "sensitive", method: "GET", path: SRV("proxy"), setup: [...TRAEFIK_PROXY, "update server_settings set traefik_certificate_resolver = 'none', generate_exact_labels = true where server_id = 1"] });
add({ name: "server proxy: show, a member with read:sensitive", token: "memberSensitive", method: "GET", path: SRV("proxy"), setup: TRAEFIK_PROXY });
add({ name: "server proxy: show unknown", token: "read", method: "GET", path: SRV("proxy", "nonexistentuuid") });
add({ name: "server proxy: show another team's", token: "read", method: "GET", path: SRV("proxy", S_OTHER) });
add({ name: "server proxy: update the redirect", token: "write", method: "PATCH", path: SRV("proxy"), body: { redirect_enabled: false, redirect_url: "https://www.example.com/", proxy_error_page: "<h1>Down</h1>" }, after: PROXY_AFTER });
add({ name: "server proxy: update, the redirect cleared", token: "write", method: "PATCH", path: SRV("proxy"), setup: TRAEFIK_PROXY, body: { redirect_enabled: "1", redirect_url: "", proxy_error_page: null }, after: PROXY_AFTER });
add({ name: "server proxy: update the labels and the resolver", token: "write", method: "PATCH", path: SRV("proxy"), setup: TRAEFIK_PROXY, body: { generate_exact_labels: true, traefik_certificate_resolver: "myresolver" }, after: PROXY_AFTER });
add({ name: "server proxy: update, no resolver", token: "write", method: "PATCH", path: SRV("proxy"), body: { traefik_certificate_resolver: null }, after: PROXY_AFTER });
add({ name: "server proxy: update, the same proxy type", token: "write", method: "PATCH", path: SRV("proxy"), setup: TRAEFIK_PROXY, body: { proxy_type: "traefik" }, after: PROXY_AFTER });
add({ name: "server proxy: update, to no proxy", token: "root", method: "PATCH", path: SRV("proxy"), setup: TRAEFIK_PROXY, body: { proxy_type: "none" }, after: PROXY_AFTER });
add({ name: "server proxy: update, to Caddy", token: "root", method: "PATCH", path: SRV("proxy"), setup: TRAEFIK_PROXY, body: { proxy_type: "CADDY" }, after: PROXY_AFTER });
add({ name: "server proxy: update, a proxy type without the deploy permission", token: "write", method: "PATCH", path: SRV("proxy"), setup: TRAEFIK_PROXY, body: { proxy_type: "caddy" } });
add({ name: "server proxy: update, an unknown proxy type", token: "write", method: "PATCH", path: SRV("proxy"), body: { proxy_type: "haproxy" } });
add({ name: "server proxy: update the redirect on a functional server", token: "write", method: "PATCH", path: SRV("proxy"), setup: FUNCTIONAL, body: { redirect_url: "https://www.example.com" }, after: PROXY_AFTER });
add({ name: "server proxy: update the labels on a functional server", token: "write", method: "PATCH", path: SRV("proxy"), setup: FUNCTIONAL, body: { generate_exact_labels: true }, after: PROXY_AFTER });
add({ name: "server proxy: update, invalid", token: "write", method: "PATCH", path: SRV("proxy"), body: { redirect_enabled: "maybe", redirect_url: "not a url", proxy_error_page: 5, generate_exact_labels: "x", traefik_certificate_resolver: "bad resolver", proxy_type: 3, port: 80 } });
add({ name: "server proxy: update, a private redirect", token: "write", method: "PATCH", path: SRV("proxy"), body: { redirect_url: "http://private.example/" } });
add({ name: "server proxy: update, a loopback redirect", token: "write", method: "PATCH", path: SRV("proxy"), body: { redirect_url: "http://127.0.0.1/" } });
add({ name: "server proxy: update, an error page too large", token: "write", method: "PATCH", path: SRV("proxy"), body: { proxy_error_page: "x".repeat(1048577) } });
add({ name: "server proxy: update, not JSON", token: "write", method: "PATCH", path: SRV("proxy"), raw: "redirect_enabled=1", contentType: "application/x-www-form-urlencoded" });
add({ name: "server proxy: update, empty JSON", token: "write", method: "PATCH", path: SRV("proxy"), raw: "{}" });
add({ name: "server proxy: update unknown", token: "write", method: "PATCH", path: SRV("proxy", "nonexistentuuid"), body: { redirect_enabled: true } });
add({ name: "server proxy: update with a read token", token: "read", method: "PATCH", path: SRV("proxy"), body: { redirect_enabled: true } });
add({ name: "server proxy: restart, not functional", token: "deploy", method: "POST", path: SRV("proxy/restart") });
add({ name: "server proxy: restart", token: "deploy", method: "POST", path: SRV("proxy/restart"), setup: FUNCTIONAL });
add({ name: "server proxy: restart unknown", token: "deploy", method: "POST", path: SRV("proxy/restart", "nonexistentuuid") });
add({ name: "server proxy: restart with a write token", token: "write", method: "POST", path: SRV("proxy/restart") });

// ── DP-88: a server's Sentinel settings ─────────────────────────────────────
const SENTINEL_AFTER = { settings: "select is_metrics_enabled, is_sentinel_debug_enabled, sentinel_metrics_refresh_rate_seconds, sentinel_metrics_history_days, sentinel_push_interval_seconds, sentinel_custom_url, traffic_topn, traffic_sample_threshold, traffic_retention_1h_days, traffic_retention_1d_days, is_geoip_enabled, geoip_refresh_days, geoip_maxmind_license_key is not null as has_geoip_key, traffic_ip_mode from server_settings where server_id = 1" };
const SENTINEL_OFF = ["update server_settings set is_sentinel_enabled = false where server_id = 1"];
add({ name: "server sentinel: show", token: "read", method: "GET", path: SRV("sentinel") });
add({ name: "server sentinel: show, read:sensitive", token: "sensitive", method: "GET", path: SRV("sentinel"), setup: ["update server_settings set sentinel_custom_url = 'http://sentinel.example.com:8888', traffic_ip_mode = 'anonymized', is_metrics_enabled = true where server_id = 1"] });
add({ name: "server sentinel: show a build server", token: "read", method: "GET", path: SRV("sentinel"), setup: ["update server_settings set server_role = 'build', is_build_server = true where server_id = 1"] });
add({ name: "server sentinel: show a Swarm server", token: "read", method: "GET", path: SRV("sentinel"), setup: SWARM_SERVER });
add({ name: "server sentinel: show a transferred server", token: "read", method: "GET", path: SRV("sentinel"), setup: [`update servers set server_metadata = '{"transfer":{"status":"transferred","export_id":"exp-1"}}' where id = 1`] });
add({ name: "server sentinel: show unknown", token: "read", method: "GET", path: SRV("sentinel", "nonexistentuuid") });
add({ name: "server sentinel: update", token: "root", method: "PATCH", path: SRV("sentinel"), setup: SENTINEL_OFF, body: { is_metrics_enabled: true, sentinel_metrics_refresh_rate_seconds: 30, sentinel_metrics_history_days: "14", sentinel_push_interval_seconds: 120, traffic_topn: 100, traffic_sample_threshold: 0, traffic_retention_1h_days: 7, traffic_retention_1d_days: 365, is_geoip_enabled: false, geoip_refresh_days: 7, traffic_ip_mode: "off", sentinel_custom_url: "https://sentinel.example.com" }, after: SENTINEL_AFTER });
add({ name: "server sentinel: update, a token", token: "root", method: "PATCH", path: SRV("sentinel"), setup: SENTINEL_OFF, body: { sentinel_token: "abc.DEF-123+/=", geoip_maxmind_license_key: "lic-1" }, after: SENTINEL_AFTER });
add({ name: "server sentinel: update, Sentinel enabled", token: "root", method: "PATCH", path: SRV("sentinel"), body: { is_metrics_enabled: true }, after: SENTINEL_AFTER });
add({ name: "server sentinel: update, nothing changed", token: "root", method: "PATCH", path: SRV("sentinel"), body: { is_metrics_enabled: false, traffic_topn: 50 }, after: SENTINEL_AFTER });
add({ name: "server sentinel: update, invalid", token: "root", method: "PATCH", path: SRV("sentinel"), body: { is_metrics_enabled: "x", sentinel_token: "a b", sentinel_metrics_refresh_rate_seconds: 0, sentinel_push_interval_seconds: 5, sentinel_custom_url: "nope", traffic_topn: 1001, traffic_sample_threshold: -1, traffic_retention_1h_days: 366, traffic_retention_1d_days: 0, geoip_maxmind_license_key: 5, traffic_ip_mode: "partial", is_sentinel_enabled: true } });
add({ name: "server sentinel: update, a token too long", token: "root", method: "PATCH", path: SRV("sentinel"), body: { sentinel_token: "a".repeat(501) } });
add({ name: "server sentinel: update, a null token", token: "root", method: "PATCH", path: SRV("sentinel"), setup: SENTINEL_OFF, body: { sentinel_token: null } });
add({ name: "server sentinel: update, not JSON", token: "root", method: "PATCH", path: SRV("sentinel"), raw: "x=1", contentType: "application/x-www-form-urlencoded" });
add({ name: "server sentinel: update unknown", token: "root", method: "PATCH", path: SRV("sentinel", "nonexistentuuid"), body: { is_metrics_enabled: true } });
add({ name: "server sentinel: update with a write token", token: "write", method: "PATCH", path: SRV("sentinel"), body: { is_metrics_enabled: true } });

// ── DP-88: a server's log drains ────────────────────────────────────────────
const LOG_DRAINS_AFTER = { settings: "select is_logdrain_newrelic_enabled, logdrain_newrelic_license_key is not null as has_newrelic_key, logdrain_newrelic_base_uri, is_logdrain_axiom_enabled, logdrain_axiom_dataset_name, logdrain_axiom_api_key is not null as has_axiom_key, logdrain_axiom_domain, is_logdrain_custom_enabled, logdrain_custom_config is not null as has_custom_config, logdrain_custom_config_parser, is_logdrain_cloudwatch_enabled, logdrain_cloudwatch_region, logdrain_cloudwatch_group, logdrain_cloudwatch_stream_prefix from server_settings where server_id = 1" };
const AXIOM = ["update server_settings set is_logdrain_axiom_enabled = true, logdrain_axiom_dataset_name = 'parity' where server_id = 1"];
add({ name: "server log drains: show", token: "read", method: "GET", path: SRV("log-drains") });
add({ name: "server log drains: show Axiom, read:sensitive", token: "sensitive", method: "GET", path: SRV("log-drains"), setup: AXIOM });
add({ name: "server log drains: show Axiom", token: "read", method: "GET", path: SRV("log-drains"), setup: AXIOM });
add({ name: "server log drains: show unknown", token: "read", method: "GET", path: SRV("log-drains", "nonexistentuuid") });
add({ name: "server log drains: New Relic", token: "root", method: "PATCH", path: SRV("log-drains"), body: { is_logdrain_newrelic_enabled: true, logdrain_newrelic_license_key: "nr-key_1.2", logdrain_newrelic_base_uri: "https://log-api.newrelic.com/log/v1" }, after: LOG_DRAINS_AFTER });
add({ name: "server log drains: Axiom without a key", token: "root", method: "PATCH", path: SRV("log-drains"), setup: AXIOM, body: { logdrain_axiom_dataset_name: "parity-2" } });
add({ name: "server log drains: Axiom", token: "root", method: "PATCH", path: SRV("log-drains"), body: { is_logdrain_axiom_enabled: true, logdrain_axiom_dataset_name: "parity", logdrain_axiom_api_key: "xaat-123" }, after: LOG_DRAINS_AFTER });
add({ name: "server log drains: Axiom turned off", token: "root", method: "PATCH", path: SRV("log-drains"), setup: AXIOM, body: { is_logdrain_axiom_enabled: false, logdrain_axiom_domain: "eu-central-1.aws.edge.axiom.co" }, after: LOG_DRAINS_AFTER });
add({ name: "server log drains: CloudWatch", token: "root", method: "PATCH", path: SRV("log-drains"), body: { is_logdrain_cloudwatch_enabled: true, logdrain_cloudwatch_region: "eu-west-1", logdrain_cloudwatch_group: "/coolify/parity", logdrain_cloudwatch_stream_prefix: "parity" }, after: LOG_DRAINS_AFTER });
add({ name: "server log drains: CloudWatch beside Axiom", token: "root", method: "PATCH", path: SRV("log-drains"), setup: AXIOM, body: { is_logdrain_cloudwatch_enabled: true, logdrain_cloudwatch_region: "eu-west-1", logdrain_cloudwatch_group: "g" } });
add({ name: "server log drains: CloudWatch without a group", token: "root", method: "PATCH", path: SRV("log-drains"), body: { is_logdrain_cloudwatch_enabled: true } });
add({ name: "server log drains: New Relic without a key", token: "root", method: "PATCH", path: SRV("log-drains"), body: { is_logdrain_newrelic_enabled: true } });
add({ name: "server log drains: Axiom without a dataset", token: "root", method: "PATCH", path: SRV("log-drains"), body: { is_logdrain_axiom_enabled: true, logdrain_axiom_api_key: "k" } });
add({ name: "server log drains: custom without a config", token: "root", method: "PATCH", path: SRV("log-drains"), body: { is_logdrain_custom_enabled: true } });
add({ name: "server log drains: custom", token: "root", method: "PATCH", path: SRV("log-drains"), body: { is_logdrain_custom_enabled: true, logdrain_custom_config: "[OUTPUT]\n    Name stdout\n    Match *\n" }, after: LOG_DRAINS_AFTER });
add({ name: "server log drains: a custom config that is not allowed", token: "root", method: "PATCH", path: SRV("log-drains"), body: { logdrain_custom_config: "[INPUT]\n    Name exec\n    Command id\n" } });
add({ name: "server log drains: invalid", token: "root", method: "PATCH", path: SRV("log-drains"), body: { is_logdrain_newrelic_enabled: "x", logdrain_newrelic_license_key: "a b", logdrain_newrelic_base_uri: "nope", logdrain_axiom_dataset_name: "a/b", logdrain_axiom_domain: "-bad-", logdrain_cloudwatch_region: "europe", logdrain_cloudwatch_group: "a b", logdrain_cloudwatch_stream_prefix: "a b", extra: 1 } });
add({ name: "server log drains: on a functional server", token: "root", method: "PATCH", path: SRV("log-drains"), setup: FUNCTIONAL, body: { logdrain_axiom_domain: "eu-central-1.aws.edge.axiom.co" }, after: LOG_DRAINS_AFTER });
add({ name: "server log drains: not JSON", token: "root", method: "PATCH", path: SRV("log-drains"), raw: "x=1", contentType: "application/x-www-form-urlencoded" });
add({ name: "server log drains: update unknown", token: "root", method: "PATCH", path: SRV("log-drains", "nonexistentuuid"), body: { is_logdrain_axiom_enabled: false } });
add({ name: "server log drains: update with a write token", token: "write", method: "PATCH", path: SRV("log-drains"), body: { is_logdrain_axiom_enabled: false } });

// ── DP-88: a server's image scanning ────────────────────────────────────────
const IMAGE_SCAN_AFTER = { settings: "select is_image_scan_enabled, image_scan_memory_mb, image_scan_syft_timeout, image_scan_grype_timeout, image_scan_cpus::float8::text as cpus from server_settings where server_id = 1" };
add({ name: "server image scanning: show", token: "read", method: "GET", path: SRV("image-scanning") });
add({ name: "server image scanning: show unknown", token: "read", method: "GET", path: SRV("image-scanning", "nonexistentuuid") });
add({ name: "server image scanning: the limits", token: "write", method: "PATCH", path: SRV("image-scanning"), body: { image_scan_memory_mb: 2048, image_scan_syft_timeout: 1200, image_scan_grype_timeout: 300, image_scan_cpus: 2 }, after: IMAGE_SCAN_AFTER });
add({ name: "server image scanning: the limits of a small server", token: "write", method: "PATCH", path: SRV("image-scanning"), setup: [`update servers set server_metadata = '{"memory_bytes":2147483648,"cpus":1}' where id = 1`], body: { image_scan_memory_mb: 4096, image_scan_cpus: 2 } });
add({ name: "server image scanning: turned off", token: "write", method: "PATCH", path: SRV("image-scanning"), setup: ["update server_settings set is_image_scan_enabled = true where server_id = 1"], body: { is_image_scan_enabled: false }, after: IMAGE_SCAN_AFTER });
add({ name: "server image scanning: turned on", token: "write", method: "PATCH", path: SRV("image-scanning"), body: { is_image_scan_enabled: true }, after: IMAGE_SCAN_AFTER });
add({ name: "server image scanning: turned on, a transferred server", token: "write", method: "PATCH", path: SRV("image-scanning"), setup: [`update servers set server_metadata = '{"transfer":{"status":"transferred"}}' where id = 1`], body: { is_image_scan_enabled: true } });
add({ name: "server image scanning: nothing", token: "write", method: "PATCH", path: SRV("image-scanning"), body: { other: 1 } });
add({ name: "server image scanning: invalid", token: "write", method: "PATCH", path: SRV("image-scanning"), body: { is_image_scan_enabled: "x", image_scan_memory_mb: 3000, image_scan_syft_timeout: "long", image_scan_grype_timeout: 7, image_scan_cpus: 1.7 } });
add({ name: "server image scanning: not JSON", token: "write", method: "PATCH", path: SRV("image-scanning"), raw: "x=1", contentType: "application/x-www-form-urlencoded" });
add({ name: "server image scanning: update unknown", token: "write", method: "PATCH", path: SRV("image-scanning", "nonexistentuuid"), body: { is_image_scan_enabled: false } });

// ── DP-88: a server's Cloudflare Tunnel setting ─────────────────────────────
const TUNNEL_HOST_KEY = [`update server_settings set ssh_host_key = '${HOST_KEY}', ssh_host_key_source = 'manual', ssh_host_key_trusted_at = '2025-12-01 00:00:00' where server_id = 1`];
const TUNNEL_ON = ["update server_settings set is_cloudflare_tunnel = true where server_id = 1", "update servers set ip = 'ssh.example.com', ip_previous = '203.0.113.10' where id = 1"];
add({ name: "server cloudflare tunnel: show", token: "read", method: "GET", path: SRV("cloudflare-tunnel") });
add({ name: "server cloudflare tunnel: show unknown", token: "read", method: "GET", path: SRV("cloudflare-tunnel", "nonexistentuuid") });
add({ name: "server cloudflare tunnel: update on", token: "write", method: "PATCH", path: SRV("cloudflare-tunnel"), setup: TUNNEL_HOST_KEY, body: { is_cloudflare_tunnel: true }, after: PROXY_AFTER });
add({ name: "server cloudflare tunnel: update off", token: "write", method: "PATCH", path: SRV("cloudflare-tunnel"), setup: TUNNEL_ON, body: { is_cloudflare_tunnel: "0" }, after: PROXY_AFTER });
add({ name: "server cloudflare tunnel: update, unchanged", token: "write", method: "PATCH", path: SRV("cloudflare-tunnel"), setup: TUNNEL_HOST_KEY, body: { is_cloudflare_tunnel: false }, after: PROXY_AFTER });
add({ name: "server cloudflare tunnel: update, invalid", token: "write", method: "PATCH", path: SRV("cloudflare-tunnel"), body: { is_cloudflare_tunnel: "yes", ip: "x" } });
add({ name: "server cloudflare tunnel: update, nothing", token: "write", method: "PATCH", path: SRV("cloudflare-tunnel"), body: { ip: "x" } });
add({ name: "server cloudflare tunnel: update, not JSON", token: "write", method: "PATCH", path: SRV("cloudflare-tunnel"), raw: "x=1", contentType: "application/x-www-form-urlencoded" });
add({ name: "server cloudflare tunnel: update unknown", token: "write", method: "PATCH", path: SRV("cloudflare-tunnel", "nonexistentuuid"), body: { is_cloudflare_tunnel: true } });
add({ name: "server cloudflare tunnel: enable", token: "write", method: "POST", path: SRV("cloudflare-tunnel/enable"), setup: TUNNEL_HOST_KEY, after: PROXY_AFTER });
add({ name: "server cloudflare tunnel: disable", token: "write", method: "POST", path: SRV("cloudflare-tunnel/disable"), setup: TUNNEL_ON, after: PROXY_AFTER });
add({ name: "server cloudflare tunnel: disable without a previous IP", token: "write", method: "POST", path: SRV("cloudflare-tunnel/disable"), setup: ["update server_settings set is_cloudflare_tunnel = true where server_id = 1"], after: PROXY_AFTER });
add({ name: "server cloudflare tunnel: enable unknown", token: "write", method: "POST", path: SRV("cloudflare-tunnel/enable", "nonexistentuuid") });
add({ name: "server cloudflare tunnel: disable another team's", token: "write", method: "POST", path: SRV("cloudflare-tunnel/disable", S_OTHER) });
add({ name: "server cloudflare tunnel: enable with a read token", token: "read", method: "POST", path: SRV("cloudflare-tunnel/enable") });

// ── DP-88: resetting a server's SSH host key ────────────────────────────────
const HOST_KEY_RESET = SRV("host-key/reset");
add({ name: "server host key: reset", token: "write", method: "POST", path: HOST_KEY_RESET, setup: TUNNEL_HOST_KEY, raw: "", contentType: "application/json", after: PROXY_AFTER });
add({ name: "server host key: reset to a key", token: "write", method: "POST", path: HOST_KEY_RESET, body: { ssh_host_key: `parity.example.com ${HOST_KEY}\n# a comment` }, after: PROXY_AFTER });
add({ name: "server host key: reset to an invalid key", token: "write", method: "POST", path: HOST_KEY_RESET, body: { ssh_host_key: "ssh-ed25519 notbase64" } });
add({ name: "server host key: reset to a key that is not a string", token: "write", method: "POST", path: HOST_KEY_RESET, body: { ssh_host_key: ["x"] } });
add({ name: "server host key: reset a transferred server", token: "write", method: "POST", path: HOST_KEY_RESET, setup: [`update servers set server_metadata = '{"transfer":{"status":"transferred"}}' where id = 1`], body: { ssh_host_key: "x" } });
add({ name: "server host key: reset unknown", token: "write", method: "POST", path: SRV("host-key/reset", "nonexistentuuid") });
add({ name: "server host key: reset with a read token", token: "read", method: "POST", path: HOST_KEY_RESET });

// ── DP-88: a server's Docker registry logins ────────────────────────────────
const REGISTRY_USERS = ["update applications set docker_registry_image_name = 'ghcr.io/parity/git' where id = 2", "update services set docker_compose = 'services:\n  web:\n    image: registry.example.com:5000/team/web:1\n' where id = 1"];
add({ name: "server registries: list", token: "sensitive", method: "GET", path: SRV("registries") });
add({ name: "server registries: list, the images in use", token: "sensitive", method: "GET", path: SRV("registries"), setup: REGISTRY_USERS });
add({ name: "server registries: list on a functional server", token: "sensitive", method: "GET", path: SRV("registries"), setup: FUNCTIONAL });
add({ name: "server registries: list unknown", token: "sensitive", method: "GET", path: SRV("registries", "nonexistentuuid") });
add({ name: "server registries: list with a read token", token: "read", method: "GET", path: SRV("registries") });
add({ name: "server registries: login, not functional", token: "root", method: "POST", path: SRV("registries"), body: { registry: "https://GHCR.io/v2/", username: "parity", password: "secret" } });
add({ name: "server registries: login", token: "root", method: "POST", path: SRV("registries"), setup: FUNCTIONAL, body: { registry: "ghcr.io", username: "parity", password: "secret" } });
add({ name: "server registries: login, invalid", token: "root", method: "POST", path: SRV("registries"), body: { registry: "bad host!", username: "a b", password: 5, email: "x" } });
add({ name: "server registries: login, missing", token: "root", method: "POST", path: SRV("registries"), body: { other: 1 } });
add({ name: "server registries: login, not JSON", token: "root", method: "POST", path: SRV("registries"), raw: "x=1", contentType: "application/x-www-form-urlencoded" });
add({ name: "server registries: login unknown", token: "root", method: "POST", path: SRV("registries", "nonexistentuuid"), body: { registry: "ghcr.io", username: "parity", password: "secret" } });
add({ name: "server registries: login with a write token", token: "write", method: "POST", path: SRV("registries"), body: { registry: "ghcr.io", username: "parity", password: "secret" } });
add({ name: "server registries: check, not functional", token: "root", method: "POST", path: SRV("registries/ghcr.io/check") });
add({ name: "server registries: check", token: "root", method: "POST", path: SRV("registries/docker.io/check"), setup: FUNCTIONAL });
add({ name: "server registries: check an invalid registry", token: "root", method: "POST", path: SRV("registries/bad_host/check") });
add({ name: "server registries: check unknown", token: "root", method: "POST", path: SRV("registries/ghcr.io/check", "nonexistentuuid") });
add({ name: "server registries: logout, not functional", token: "root", method: "DELETE", path: SRV("registries/registry-1.docker.io") });
add({ name: "server registries: logout", token: "root", method: "DELETE", path: SRV("registries/ghcr.io"), setup: FUNCTIONAL });
add({ name: "server registries: logout an invalid registry", token: "root", method: "DELETE", path: SRV("registries/a..b%20c") });
add({ name: "server registries: logout with a write token", token: "write", method: "DELETE", path: SRV("registries/ghcr.io") });

// ── DP-88: a server's transfer to another instance ──────────────────────────
add({ name: "server transfer: status", token: "read", method: "GET", path: SRV("transfer") });
add({ name: "server transfer: status of a migration", token: "write", method: "GET", path: SRV("transfer"), setup: [`update servers set server_metadata = '{"transfer":{"status":"exported","export_id":"exp-1","exported_at":"2025-12-30T00:00:00+00:00","imported_at":null},"migration":{"status":"failed","target_url":"https://target.example.com","log":[{"level":"error","message":"FAILED"}],"error":"1 of 3 checks failed"}}' where id = 1`] });
add({ name: "server transfer: status of a migration, a member", token: "memberRead", method: "GET", path: SRV("transfer"), setup: [`update servers set server_metadata = '{"migration":{"status":"running","log":[],"error":null}}' where id = 1`] });
add({ name: "server transfer: status unknown", token: "read", method: "GET", path: SRV("transfer", "nonexistentuuid") });
add({ name: "server transfer: migrate", token: "root", method: "POST", path: SRV("migrate"), body: { target_url: "https://target.example.com", target_token: "1|abc" }, after: { server: "select server_metadata::jsonb::text as metadata from servers where id = 1" } });
add({ name: "server transfer: migrate, invalid", token: "root", method: "POST", path: SRV("migrate"), body: { target_url: "nope", other: 1 } });
add({ name: "server transfer: migrate, not JSON", token: "root", method: "POST", path: SRV("migrate"), raw: "x=1", contentType: "application/x-www-form-urlencoded" });
add({ name: "server transfer: migrate without read:sensitive", token: "write", method: "POST", path: SRV("migrate"), body: { target_url: "https://target.example.com", target_token: "1|abc" } });
add({ name: "server transfer: migrate to an http URL", token: "root", method: "POST", path: SRV("migrate"), body: { target_url: "http://target.example.com", target_token: "1|abc" } });
add({ name: "server transfer: migrate to a private URL", token: "root", method: "POST", path: SRV("migrate"), body: { target_url: "https://private.example/", target_token: "1|abc" } });
add({ name: "server transfer: migrate with a blank bearer token", token: "root", method: "POST", path: SRV("migrate"), body: { target_url: "https://target.example.com/", target_token: " Bearer   " } });
add({ name: "server transfer: migrate while a migration runs", token: "root", method: "POST", path: SRV("migrate"), setup: [`update servers set server_metadata = '{"migration":{"status":"running","started_at":"2099-01-01T00:00:00+00:00"}}' where id = 1`], body: { target_url: "https://target.example.com", target_token: "1|abc" } });
add({ name: "server transfer: migrate after a stale migration", token: "root", method: "POST", path: SRV("migrate"), setup: [`update servers set server_metadata = '{"migration":{"status":"running","started_at":"2025-01-01T00:00:00+00:00"}}' where id = 1`], body: { target_url: "https://target.example.com", target_token: "1|abc" } });
add({ name: "server transfer: migrate unknown", token: "root", method: "POST", path: SRV("migrate", "nonexistentuuid"), body: { target_url: "https://target.example.com", target_token: "1|abc" } });
add({ name: "server transfer: import check", token: "root", method: "GET", path: `/api/v1/servers/import/check?server_uuid=${S_MAIN}&ip=203.0.113.50&port=22` });
add({ name: "server transfer: import check, invalid", token: "root", method: "GET", path: "/api/v1/servers/import/check?ip=not%20an%20ip&port=70000&schema_version=x" });
add({ name: "server transfer: import check, nothing", token: "root", method: "GET", path: "/api/v1/servers/import/check" });
add({ name: "server transfer: import check with a write token", token: "write", method: "GET", path: `/api/v1/servers/import/check?server_uuid=${S_MAIN}&ip=203.0.113.50` });

// ── DP-88: database imports (a standalone database's and a service database's) ─
const UPLOAD_ID = "6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f";
for (const [group, base, notFound, running] of [
  ["database imports", `/api/v1/databases/${DB_PG}`, `/api/v1/databases/nonexistentuuid`, "update standalone_postgresqls set status = 'running:healthy' where id = 1"],
  ["service database imports", `/api/v1/services/${SV_MAIN}/databases/${SD_DB}`, `/api/v1/services/${SV_MAIN}/databases/nonexistentuuid`, "update service_databases set status = 'running:healthy' where id = 1"],
]) {
  add({ name: `${group}: upload, no file`, token: "write", method: "POST", path: `${base}/imports/uploads`, body: { upload_id: UPLOAD_ID } });
  add({ name: `${group}: upload, a file that is not a file`, token: "write", method: "POST", path: `${base}/imports/uploads`, body: { upload_id: "not-a-uuid", file: "dump.sql" } });
  add({ name: `${group}: upload, nothing`, token: "write", method: "POST", path: `${base}/imports/uploads`, raw: "", contentType: "application/json" });
  add({ name: `${group}: upload to unknown`, token: "write", method: "POST", path: `${notFound}/imports/uploads`, body: { upload_id: UPLOAD_ID } });
  add({ name: `${group}: upload with a read token`, token: "read", method: "POST", path: `${base}/imports/uploads`, body: { upload_id: UPLOAD_ID } });
  add({ name: `${group}: from the server, not running`, token: "root", method: "POST", path: `${base}/imports`, body: { source: "server", path: "/backups/dump.sql" } });
  add({ name: `${group}: from the server`, token: "root", method: "POST", path: `${base}/imports`, setup: [running], body: { source: "server", path: "/backups/dump.sql", replace_existing: true } });
  add({ name: `${group}: from S3`, token: "root", method: "POST", path: `${base}/imports`, setup: [running], body: { source: "s3", s3_storage_uuid: S3_MAIN, path: "backups/dump.sql" } });
  add({ name: `${group}: an upload`, token: "root", method: "POST", path: `${base}/imports`, setup: [running], body: { source: "upload", upload_id: UPLOAD_ID } });
  add({ name: `${group}: on a Swarm server`, token: "root", method: "POST", path: `${base}/imports`, setup: [running, ...SWARM_SERVER], body: { source: "server", path: "/backups/dump.sql" } });
  add({ name: `${group}: invalid`, token: "root", method: "POST", path: `${base}/imports`, body: { source: "ftp", upload_id: "x", dump_all: "maybe", keep_owners: 2, sqlite_database: 5, extra: 1 } });
  add({ name: `${group}: an upload with a path`, token: "root", method: "POST", path: `${base}/imports`, body: { source: "upload", path: "/x", s3_storage_uuid: "y" } });
  add({ name: `${group}: from S3 without a storage`, token: "root", method: "POST", path: `${base}/imports`, body: { source: "s3", upload_id: UPLOAD_ID } });
  add({ name: `${group}: from the server without a path`, token: "root", method: "POST", path: `${base}/imports`, body: { source: "server" } });
  add({ name: `${group}: no source`, token: "root", method: "POST", path: `${base}/imports`, raw: "", contentType: "application/json" });
  add({ name: `${group}: a form body`, token: "root", method: "POST", path: `${base}/imports`, raw: "source=server&path=%2Fbackups%2Fdump.sql", contentType: "application/x-www-form-urlencoded" });
  add({ name: `${group}: without the deploy permission`, token: "write", method: "POST", path: `${base}/imports`, body: { source: "server", path: "/backups/dump.sql" } });
  add({ name: `${group}: into unknown`, token: "root", method: "POST", path: `${notFound}/imports`, body: { source: "server", path: "/x" } });
  add({ name: `${group}: show`, token: "read", method: "GET", path: `${base}/imports/12` });
  add({ name: `${group}: show of unknown`, token: "read", method: "GET", path: `${notFound}/imports/12` });
}
add({ name: "database imports: a Redis", token: "root", method: "POST", path: `/api/v1/databases/${DB_REDIS}/imports`, body: { source: "server", path: "/backups/dump.rdb" } });
add({ name: "database imports: show, not a number", token: "read", method: "GET", path: `/api/v1/databases/${DB_PG}/imports/abc` });
add({ name: "database imports: of another team's", token: "root", method: "POST", path: `/api/v1/databases/${DB_OTHER}/imports`, body: { source: "server", path: "/x" } });
add({ name: "service database imports: of an unknown service", token: "root", method: "POST", path: `/api/v1/services/nonexistentuuid/databases/${SD_DB}/imports`, body: { source: "server", path: "/x" } });

// ── DP-88: GitHub Apps ──────────────────────────────────────────────────────
// Freeploy is a hosted service: the cases run as Coolify Cloud (no system-wide App, private networks refused).
const GH = "/api/v1/github-apps";
const GH_APP = (id) => `${GH}/${id}`;
const GH_AFTER = { apps: "select case when uuid like 'j%parity%' then id end as fixture_id, name, organization, api_url, html_url, custom_user, custom_port, app_id, installation_id, client_id, client_secret is not null as has_client_secret, webhook_secret is not null as has_webhook_secret, private_key_id, is_system_wide, is_public from github_apps where id > 0 order by id" };
const githubApp = (id, uuid, team, name, key) => ({
  coolify: `insert into github_apps (id, uuid, name, organization, api_url, html_url, custom_user, custom_port, app_id, installation_id, client_id, is_system_wide, is_public, private_key_id, team_id, created_at, updated_at) values (${id}, '${uuid}', '${name}', 'parity-org', 'https://api.github.com', 'https://github.com', 'git', 22, 100${id}, 200${id}, 'Iv1.parity${id}', false, false, ${key}, ${team}, '2025-12-0${id} 00:00:00', '2025-12-0${id} 00:00:00')`,
  freeploy: `insert into github_apps (id, uuid, name, organization, api_url, html_url, custom_user, custom_port, app_id, installation_id, client_id, is_system_wide, is_public, private_key_id, org_id, created_at, updated_at) values (${id}, '${uuid}', '${name}', 'parity-org', 'https://api.github.com', 'https://github.com', 'git', 22, 100${id}, 200${id}, 'Iv1.parity${id}', false, false, ${key}, deploy.current_org(), '2025-12-0${id} 00:00:00', '2025-12-0${id} 00:00:00')`,
});
const GH_ROWS = [githubApp(1, "j1paritygithubapp0000001", 1, "Parity App", 1), githubApp(2, "j2paritysecondapp0000002", 1, "Second App", 2)];
const GH_SETUP = { setupCoolify: GH_ROWS.map((r) => r.coolify), setupFreeploy: GH_ROWS.map((r) => r.freeploy) };
const GH_CREATE = { name: "New App", organization: " /acme/ ", html_url: "https://github.com", app_id: 123, installation_id: 456, client_id: "Iv1.abc", client_secret: "cs-1", webhook_secret: "ws-1", private_key_uuid: K_MAIN };
add({ name: "github apps: list", token: "read", method: "GET", path: GH, config: CLOUD, ...GH_SETUP });
add({ name: "github apps: list, read:sensitive", token: "sensitive", method: "GET", path: GH, config: CLOUD, ...GH_SETUP });
add({ name: "github apps: list, none", token: "read", method: "GET", path: GH, config: CLOUD });
add({ name: "github apps: create", token: "write", method: "POST", path: GH, config: CLOUD, body: GH_CREATE, after: GH_AFTER });
add({ name: "github apps: create, every field", token: "write", method: "POST", path: GH, config: CLOUD, body: { ...GH_CREATE, organization: null, api_url: "https://api.github.com", custom_user: "deploy", custom_port: 2222, is_system_wide: true }, after: GH_AFTER });
add({ name: "github apps: create, GitHub Enterprise", token: "write", method: "POST", path: GH, config: CLOUD, body: { ...GH_CREATE, html_url: "https://github.acme-corp.com" }, after: GH_AFTER });
add({ name: "github apps: create, invalid", token: "write", method: "POST", path: GH, config: CLOUD, body: { name: "", organization: "a b", api_url: "nope", html_url: "ftp://x", custom_user: 5, custom_port: 70000, app_id: "x", installation_id: null, client_id: ["x"], client_secret: 5, private_key_uuid: 1, is_system_wide: "maybe", extra: 1 } });
add({ name: "github apps: create, a private host", token: "write", method: "POST", path: GH, config: CLOUD, body: { ...GH_CREATE, html_url: "https://private.example" } });
add({ name: "github apps: create, an unknown key", token: "write", method: "POST", path: GH, config: CLOUD, body: { ...GH_CREATE, private_key_uuid: "nonexistentuuid" } });
add({ name: "github apps: create, another team's key", token: "write", method: "POST", path: GH, config: CLOUD, body: { ...GH_CREATE, private_key_uuid: K_OTHER } });
add({ name: "github apps: create, not JSON", token: "write", method: "POST", path: GH, config: CLOUD, raw: "name=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "github apps: create, empty JSON", token: "write", method: "POST", path: GH, config: CLOUD, raw: "{}" });
add({ name: "github apps: create with a read token", token: "read", method: "POST", path: GH, config: CLOUD, body: GH_CREATE });
add({ name: "github apps: update", token: "write", method: "PATCH", path: GH_APP(1), config: CLOUD, ...GH_SETUP, body: { name: "Renamed App", organization: "/new-org/", custom_port: "2200", client_secret: "cs-2", private_key_uuid: K_FREE }, after: GH_AFTER });
add({ name: "github apps: update the HTML URL", token: "write", method: "PATCH", path: GH_APP(1), config: CLOUD, ...GH_SETUP, body: { html_url: "https://github.acme-corp.com" }, after: GH_AFTER });
add({ name: "github apps: update, nothing", token: "write", method: "PATCH", path: GH_APP(1), config: CLOUD, ...GH_SETUP, body: { is_system_wide: true, other: 1 }, after: GH_AFTER });
add({ name: "github apps: update, invalid", token: "write", method: "PATCH", path: GH_APP(1), config: CLOUD, ...GH_SETUP, body: { name: 5, api_url: "nope", custom_port: 0, app_id: "x", private_key_uuid: [] } });
add({ name: "github apps: update, a private host", token: "write", method: "PATCH", path: GH_APP(1), config: CLOUD, ...GH_SETUP, body: { api_url: "http://10.0.0.8/api/v3" } });
add({ name: "github apps: update, an unknown key", token: "write", method: "PATCH", path: GH_APP(1), config: CLOUD, ...GH_SETUP, body: { private_key_uuid: K_OTHER } });
add({ name: "github apps: update unknown", token: "write", method: "PATCH", path: GH_APP(99), config: CLOUD, ...GH_SETUP, body: { name: "x" } });
add({ name: "github apps: update with a read token", token: "read", method: "PATCH", path: GH_APP(1), config: CLOUD, ...GH_SETUP, body: { name: "x" } });
add({ name: "github apps: delete", token: "delete", method: "DELETE", path: GH_APP(2), config: CLOUD, ...GH_SETUP, after: GH_AFTER });
add({ name: "github apps: delete, in use", token: "delete", method: "DELETE", path: GH_APP(1), config: CLOUD, ...GH_SETUP, setup: ["update applications set source_id = 1 where id = 2"], after: GH_AFTER });
add({ name: "github apps: delete unknown", token: "delete", method: "DELETE", path: GH_APP(99), config: CLOUD, ...GH_SETUP });
add({ name: "github apps: delete with a write token", token: "write", method: "DELETE", path: GH_APP(2), config: CLOUD, ...GH_SETUP });

/** The tables whose column order emit.php writes into the goldens (`columns`): what a nested relation serializes in. */
const columnsOf = ["servers", "server_settings", "standalone_dockers", "application_settings", "applications", "environment_variables", "application_deployment_queues", "scheduled_database_backups", "scheduled_database_backup_executions", "services", "service_applications", "service_databases", "projects", "environments", "standalone_postgresqls", "standalone_redis", "standalone_mongodbs", "standalone_mysqls", "standalone_mariadbs", "standalone_keydbs", "standalone_dragonflies", "standalone_clickhouses", "local_persistent_volumes", "local_file_volumes", "github_apps"];

console.log(JSON.stringify({ fixture, columnsOf, cases }, null, 1));
