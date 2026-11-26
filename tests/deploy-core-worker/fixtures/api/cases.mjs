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
// DP-93: an RSA key of team 1 for a GitHub App: DP-72's test key, read from fixtures/sources/cases.json (never inlined).
const K_GITHUB = "k4paritygithubappkey0004";
const SOURCE_CASES = JSON.parse(readFileSync(new URL("../sources/cases.json", import.meta.url), "utf8"));
const GITHUB_APP_KEY = ["webhooks", SOURCE_CASES.webhooks.findIndex((w) => w.setup?.githubApp?.privateKey), "setup", "githubApp", "privateKey"];
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

// DP-90: the cloud provider tokens
const CT_HETZNER = "c1paritycloudhetzner0001";
const CT_DO = "c2paritycloudocean000002";
const CT_VULTR = "c3paritycloudvultr000003";
const CT_HOSTINGER = "c4paritycloudhostinger04";
const CT_OTHER = "c5paritycloudother000005";
// DP-104: the integration tokens and the DNS zones of the Cloudflare ones
const IT_CF = "i1paritycloudflaredns001";
const IT_CF_TUNNEL = "i2paritycloudflaretun002";
const IT_DOPPLER = "i3paritydoppler000000003";
const IT_INFISICAL = "i4parityinfisical0000004";
const IT_VAULT = "i5parityvault00000000005";
const IT_OTHER = "i6othercloudflare0000006";
// DP-103: GitLab and Gitea Apps.
const GL_MAIN = "y1paritygitlabapp0000001";
const GL_SELF = "y2paritygitlabapp0000002";
const GL_OTHER = "y3othergitlabapp00000003";
const GT_MAIN = "z1paritygiteaapp00000001";
const GT_CODEBERG = "z2paritygiteaapp00000002";
const GT_OTHER = "z3othergiteaapp000000003";

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
    { id: 4, uuid: K_GITHUB, name: "GitHub App Key", description: "The RSA key of a GitHub App", file: "../sources/cases.json", json: GITHUB_APP_KEY, team: T1 },
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
  // DP-90: cloud provider tokens, one per provider for team 1 and a Hetzner token of team 2 (the token encrypted on each side).
  cloudTokens: [
    { id: 1, uuid: CT_HETZNER, team: T1, provider: "hetzner", token: "hz-team1-token", name: "Parity Hetzner", description: "The main Hetzner project" },
    { id: 2, uuid: CT_DO, team: T1, provider: "digitalocean", token: "do-team1-token", name: "Parity DigitalOcean", description: null },
    { id: 3, uuid: CT_VULTR, team: T1, provider: "vultr", token: "vu-team1-token", name: "Parity Vultr", description: null },
    { id: 4, uuid: CT_HOSTINGER, team: T1, provider: "hostinger", token: "ho-team1-token", name: "Parity Hostinger", description: null },
    { id: 5, uuid: CT_OTHER, team: T2, provider: "hetzner", token: "hz-team2-token", name: "Other Hetzner", description: null },
  ],
  // DP-104: integration tokens, one per provider for team 1 (two Cloudflare ones) and a Cloudflare token of team 2 (the token
  // encrypted on each side), and the DNS zones of the Cloudflare tokens.
  integrationTokens: [
    { id: 1, uuid: IT_CF, team: T1, provider: "cloudflare", name: "Parity Cloudflare", token: "cf-team1-token", capabilities: ["dns"], metadata: { zones_synced_at: "2025-12-30T00:00:00+00:00" }, created_at: "2025-12-20 00:00:00" },
    { id: 2, uuid: IT_CF_TUNNEL, team: T1, provider: "cloudflare", name: "Parity Tunnel", token: "cf-team1-tunnel", capabilities: ["dns", "tunnel"], metadata: { automatic_dns: false, proxied_dns: true }, created_at: "2025-12-21 00:00:00" },
    { id: 3, uuid: IT_DOPPLER, team: T1, provider: "doppler", name: "Parity Doppler", token: "dp.st.team1token", capabilities: ["secrets"], metadata: null, created_at: "2025-12-22 00:00:00" },
    { id: 4, uuid: IT_INFISICAL, team: T1, provider: "infisical", name: "Parity Infisical", token: "inf-team1-secret", capabilities: ["secrets"], metadata: { base_url: "https://app.infisical.com", client_id: "client-team1" }, created_at: "2025-12-23 00:00:00" },
    { id: 5, uuid: IT_VAULT, team: T1, provider: "vault", name: "Parity Vault", token: "hvs.team1token", capabilities: ["secrets"], metadata: { base_url: "https://vault.example.com:8200", namespace: "admin/team-a", timeout: 15 }, created_at: "2025-12-24 00:00:00" },
    { id: 6, uuid: IT_OTHER, team: T2, provider: "cloudflare", name: "Other Cloudflare", token: "cf-team2-token", capabilities: ["dns"], metadata: null, created_at: "2025-12-25 00:00:00" },
  ],
  dnsZones: [
    { id: 1, uuid: "z1parityzoneexamplecom01", token: 1, provider_zone_id: "zone-com", name: "example.com", account_id: "acc-1", account_name: "Parity Account", created_at: "2025-12-20 00:00:00" },
    { id: 2, uuid: "z2parityzoneexampleorg02", token: 1, provider_zone_id: "zone-org", name: "example.org", account_id: "acc-1", account_name: "Parity Account", created_at: "2025-12-20 00:00:00" },
    { id: 3, uuid: "z3parityzoneexamplenet03", token: 2, provider_zone_id: "zone-net", name: "example.net", account_id: "acc-1", account_name: null, created_at: "2025-12-21 00:00:00" },
    { id: 4, uuid: "z4otherzoneotherexample4", token: 6, provider_zone_id: "zone-other", name: "other.example", account_id: "acc-9", account_name: "Other Account", created_at: "2025-12-25 00:00:00" },
  ],
  // DP-103: GitLab and Gitea Apps, made through Coolify's models (the encrypted casts, GitLab's webhookToken() mutator) and
  // stored encrypted with the org's key on Freeploy's side. The first of each is connected; its token expires in 2038
  // (refreshGiteaToken() compares expires_at with PHP's time(), the real clock, which Carbon::setTestNow() does not fix).
  gitlabApps: [
    { id: 1, uuid: GL_MAIN, team: T1, name: "Parity GitLab", html_url: "https://gitlab.com", api_url: "https://gitlab.com/api/v4", custom_user: "git", custom_port: 22, group_name: "parity-group", client_id: "gl-client-1", client_secret: "gl-secret-1", webhook_token: "gl-webhook-token-1", access_token: "gl-access-1", refresh_token: "gl-refresh-1", expires_at: 2145916800, redirect_uri: "http://localhost/webhooks/source/gitlab/redirect", created_at: "2025-12-05 00:00:00" },
    { id: 2, uuid: GL_SELF, team: T1, name: "Self-hosted GitLab", html_url: "https://gitlab.acme.test", api_url: "https://gitlab.acme.test/api/v4", custom_user: "git", custom_port: 2222, group_name: null, client_id: null, client_secret: null, webhook_token: "gl-webhook-token-2", access_token: null, refresh_token: null, expires_at: null, redirect_uri: null, created_at: "2025-12-06 00:00:00" },
    { id: 3, uuid: GL_OTHER, team: T2, name: "Other GitLab", html_url: "https://gitlab.com", api_url: "https://gitlab.com/api/v4", custom_user: "git", custom_port: 22, group_name: null, client_id: "gl-client-3", client_secret: "gl-secret-3", webhook_token: "gl-webhook-token-3", access_token: "gl-access-3", refresh_token: "gl-refresh-3", expires_at: 2145916800, redirect_uri: null, created_at: "2025-12-07 00:00:00" },
  ],
  giteaApps: [
    { id: 1, uuid: GT_MAIN, team: T1, name: "Parity Gitea", html_url: "https://gitea.com", api_url: "https://gitea.com/api/v1", custom_user: "git", custom_port: 22, organization: "acme, Parity", client_id: "gt-client-1", client_secret: "gt-secret-1", webhook_secret: "gt-webhook-secret-1", access_token: "gt-access-1", refresh_token: "gt-refresh-1", expires_at: 2145916800, redirect_uri: "http://localhost/webhooks/source/gitea/redirect", created_at: "2025-12-05 00:00:00" },
    { id: 2, uuid: GT_CODEBERG, team: T1, name: "Codeberg", html_url: "https://codeberg.org", api_url: "https://codeberg.org/api/v1", custom_user: "git", custom_port: 22, organization: null, client_id: "gt-client-2", client_secret: null, webhook_secret: "gt-webhook-secret-2", access_token: null, refresh_token: null, expires_at: null, redirect_uri: null, created_at: "2025-12-06 00:00:00" },
    { id: 3, uuid: GT_OTHER, team: T2, name: "Other Gitea", html_url: "https://gitea.com", api_url: "https://gitea.com/api/v1", custom_user: "git", custom_port: 22, organization: null, client_id: "gt-client-3", client_secret: "gt-secret-3", webhook_secret: "gt-webhook-secret-3", access_token: "gt-access-3", refresh_token: "gt-refresh-3", expires_at: 2145916800, redirect_uri: null, created_at: "2025-12-07 00:00:00" },
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
    // DP-93: a member's tokens that may deploy or delete (most policy denials need a member whose stored levels allow them).
    { key: "memberDeploy", id: 13, user: 2, team: T1, name: "Member deploy", abilities: ["read", "deploy"], secret: "mdepmdepmdepmdepmdepmdepmdepmdepmdepmdep1b1c2d3e" },
    { key: "memberDelete", id: 14, user: 2, team: T1, name: "Member delete", abilities: ["read", "delete"], secret: "mdelmdelmdelmdelmdelmdelmdelmdelmdelmdel2b1c2d3e" },
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

// ── DP-90: cloud provider tokens ────────────────────────────────────────────
// A provider's API is Http::fake() (emit.php): `http` lists its answers, the first whose `match` fits "METHOD URL".
const CT = "/api/v1/cloud-tokens";
const CT_AFTER = { tokens: `select case when id <= 5 then id end as fixture_id, provider, name, description, token is not null as has_token from cloud_provider_tokens where uuid <> '${CT_OTHER}' order by id` };
const TOKEN_IN_USE = "update servers set cloud_provider_token_id = 1 where id = 1";
const answer = (match, body, status = 200, headers = undefined) => ({ match, body, status, ...(headers && { headers }) });
const VALIDATE_URL = {
  hetzner: "^GET https://api\\.hetzner\\.cloud/v1/servers$",
  digitalocean: "^GET https://api\\.digitalocean\\.com/v2/account$",
  vultr: "^GET https://api\\.vultr\\.com/v2/account$",
  hostinger: "^GET https://developers\\.hostinger\\.com/api/vps/v1/virtual-machines$",
};
add({ name: "cloud tokens: list", token: "read", method: "GET", path: CT });
add({ name: "cloud tokens: list, read:sensitive", token: "sensitive", method: "GET", path: CT });
add({ name: "cloud tokens: list, one used by a server", token: "read", method: "GET", path: CT, setup: [TOKEN_IN_USE] });
add({ name: "cloud tokens: list by a member", token: "memberRead", method: "GET", path: CT });
add({ name: "cloud tokens: show", token: "read", method: "GET", path: `${CT}/${CT_HETZNER}` });
add({ name: "cloud tokens: show, read:sensitive", token: "sensitive", method: "GET", path: `${CT}/${CT_VULTR}` });
add({ name: "cloud tokens: show unknown", token: "read", method: "GET", path: `${CT}/nonexistentuuid` });
add({ name: "cloud tokens: show another team's", token: "read", method: "GET", path: `${CT}/${CT_OTHER}` });
add({ name: "cloud tokens: show by a member", token: "memberRead", method: "GET", path: `${CT}/${CT_HETZNER}` });
// `$request->uuid`: the input before the route parameter (show, delete, validate; update reads the route's).
add({ name: "cloud tokens: show, a uuid in the query", token: "read", method: "GET", path: `${CT}/${CT_HETZNER}?uuid=${CT_VULTR}` });
add({ name: "cloud tokens: show, an empty uuid in the query", token: "read", method: "GET", path: `${CT}/${CT_HETZNER}?uuid=` });
add({ name: "cloud tokens: delete, an empty uuid in the query", token: "delete", method: "DELETE", path: `${CT}/${CT_VULTR}?uuid=`, after: CT_AFTER });
add({ name: "cloud tokens: delete, a uuid in the query", token: "delete", method: "DELETE", path: `${CT}/${CT_VULTR}?uuid=${CT_HOSTINGER}`, after: CT_AFTER });
add({ name: "cloud tokens: validate, a uuid in the body", token: "write", method: "POST", path: `${CT}/${CT_HETZNER}/validate`, body: { uuid: CT_VULTR }, http: [answer(VALIDATE_URL.vultr, { ok: true })] });
add({ name: "cloud tokens: update, a uuid in the query", token: "write", method: "PATCH", path: `${CT}/${CT_DO}?uuid=${CT_VULTR}`, body: { name: "Renamed by route" }, after: CT_AFTER });
for (const provider of ["hetzner", "digitalocean", "vultr", "hostinger"]) {
  add({ name: `cloud tokens: create a ${provider} token`, token: "write", method: "POST", path: CT, body: { provider, token: `${provider}-new-token`, name: `New ${provider}` }, http: [answer(VALIDATE_URL[provider], { ok: true })], after: CT_AFTER });
}
add({ name: "cloud tokens: create, the provider refuses the token", token: "write", method: "POST", path: CT, body: { provider: "hetzner", token: "bad-token", name: "Refused" }, http: [answer(VALIDATE_URL.hetzner, { error: { code: "unauthorized", message: "unable to authenticate" } }, 401)], after: CT_AFTER });
add({ name: "cloud tokens: create, the provider answers 404", token: "write", method: "POST", path: CT, body: { provider: "vultr", token: "vu-x", name: "Nowhere" }, http: [], after: CT_AFTER });
add({ name: "cloud tokens: create, invalid", token: "write", method: "POST", path: CT, body: { provider: "aws", token: 5, name: "x".repeat(256), description: "not allowed" }, http: [] });
add({ name: "cloud tokens: create, nothing required", token: "write", method: "POST", path: CT, body: { other: 1 }, http: [] });
add({ name: "cloud tokens: create, a provider that is not a string", token: "write", method: "POST", path: CT, body: { provider: ["hetzner"], token: "t", name: "n" }, http: [] });
add({ name: "cloud tokens: create, not JSON", token: "write", method: "POST", path: CT, raw: "provider=hetzner", contentType: "application/x-www-form-urlencoded", http: [] });
add({ name: "cloud tokens: create, empty JSON", token: "write", method: "POST", path: CT, raw: "{}", http: [] });
add({ name: "cloud tokens: create with a read token", token: "read", method: "POST", path: CT, body: { provider: "hetzner", token: "t", name: "n" }, http: [] });
add({ name: "cloud tokens: update", token: "write", method: "PATCH", path: `${CT}/${CT_DO}`, body: { name: "Renamed DigitalOcean" }, after: CT_AFTER });
add({ name: "cloud tokens: update to the same name", token: "write", method: "PATCH", path: `${CT}/${CT_DO}`, body: { name: "Parity DigitalOcean" }, after: { ...CT_AFTER, touched: `select updated_at = created_at as untouched from cloud_provider_tokens where id = 2` } });
add({ name: "cloud tokens: update, invalid", token: "write", method: "PATCH", path: `${CT}/${CT_DO}`, body: { name: 7, description: "x", provider: "vultr" } });
add({ name: "cloud tokens: update, no name", token: "write", method: "PATCH", path: `${CT}/${CT_DO}`, body: { description: "x" } });
add({ name: "cloud tokens: update, not JSON", token: "write", method: "PATCH", path: `${CT}/${CT_DO}`, raw: "name=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "cloud tokens: update unknown", token: "write", method: "PATCH", path: `${CT}/nonexistentuuid`, body: { name: "x" } });
add({ name: "cloud tokens: update another team's", token: "write", method: "PATCH", path: `${CT}/${CT_OTHER}`, body: { name: "x" } });
add({ name: "cloud tokens: delete", token: "delete", method: "DELETE", path: `${CT}/${CT_VULTR}`, after: CT_AFTER });
add({ name: "cloud tokens: delete, used by a server", token: "delete", method: "DELETE", path: `${CT}/${CT_HETZNER}`, setup: [TOKEN_IN_USE], after: CT_AFTER });
add({ name: "cloud tokens: delete, used by a deleted server", token: "delete", method: "DELETE", path: `${CT}/${CT_HETZNER}`, setup: [`${TOKEN_IN_USE}`, "update servers set deleted_at = '2025-12-31 00:00:00' where id = 1"], after: CT_AFTER });
add({ name: "cloud tokens: delete unknown", token: "delete", method: "DELETE", path: `${CT}/nonexistentuuid` });
add({ name: "cloud tokens: delete another team's", token: "delete", method: "DELETE", path: `${CT}/${CT_OTHER}` });
add({ name: "cloud tokens: delete with a write token", token: "write", method: "DELETE", path: `${CT}/${CT_VULTR}` });
for (const [provider, uuid] of [["hetzner", CT_HETZNER], ["digitalocean", CT_DO], ["vultr", CT_VULTR], ["hostinger", CT_HOSTINGER]]) {
  add({ name: `cloud tokens: validate a ${provider} token`, token: "write", method: "POST", path: `${CT}/${uuid}/validate`, http: [answer(VALIDATE_URL[provider], { ok: true })] });
}
add({ name: "cloud tokens: validate, the provider refuses it", token: "write", method: "POST", path: `${CT}/${CT_HETZNER}/validate`, http: [answer(VALIDATE_URL.hetzner, { error: { code: "forbidden" } }, 403)] });
add({ name: "cloud tokens: validate, the provider fails", token: "write", method: "POST", path: `${CT}/${CT_DO}/validate`, http: [answer(VALIDATE_URL.digitalocean, { id: "server_error" }, 500)] });
add({ name: "cloud tokens: validate unknown", token: "write", method: "POST", path: `${CT}/nonexistentuuid/validate`, http: [] });
add({ name: "cloud tokens: validate another team's", token: "write", method: "POST", path: `${CT}/${CT_OTHER}/validate`, http: [] });
add({ name: "cloud tokens: validate with a read token", token: "read", method: "POST", path: `${CT}/${CT_HETZNER}/validate`, http: [] });

// ── DP-90: what each cloud provider offers, through a cloud provider token ──
const HZ = (what, uuid = CT_HETZNER) => `/api/v1/hetzner/${what}?cloud_provider_token_uuid=${uuid}`;
const HZ_API = (path) => `^GET https://api\\.hetzner\\.cloud/v1/${path}`;
const page = (next) => ({ pagination: { page: next === null ? 2 : 1, per_page: 50, previous_page: null, next_page: next, last_page: 2, total_entries: 2 } });
const LOCATIONS = [
  answer(`${HZ_API("locations")}\\?page=1&per_page=50$`, { locations: [{ id: 1, name: "fsn1", description: "Falkenstein DC Park 1", country: "DE", city: "Falkenstein", latitude: 50.47612, longitude: 12.370071, network_zone: "eu-central" }], meta: page(2) }),
  answer(`${HZ_API("locations")}\\?page=2&per_page=50$`, { locations: [{ id: 2, name: "nbg1", description: "Nuremberg 1 DC 3", country: "DE", city: "Nürnberg", latitude: 49.452102, longitude: 11.076665, network_zone: "eu-central" }], meta: page(null) }),
];
const hzError = (status, error, headers) => [answer(`${HZ_API("locations")}`, { error }, status, headers)];
add({ name: "hetzner locations", token: "read", method: "GET", path: HZ("locations"), http: LOCATIONS });
add({ name: "hetzner locations: the deprecated token id", token: "read", method: "GET", path: `/api/v1/hetzner/locations?cloud_provider_token_id=${CT_HETZNER}`, http: LOCATIONS });
add({ name: "hetzner locations: no token", token: "read", method: "GET", path: "/api/v1/hetzner/locations", http: LOCATIONS });
add({ name: "hetzner locations: an empty token", token: "read", method: "GET", path: "/api/v1/hetzner/locations?cloud_provider_token_uuid=", http: LOCATIONS });
add({ name: "hetzner locations: unknown token", token: "read", method: "GET", path: HZ("locations", "nonexistentuuid"), http: LOCATIONS });
add({ name: "hetzner locations: another provider's token", token: "read", method: "GET", path: HZ("locations", CT_DO), http: LOCATIONS });
add({ name: "hetzner locations: another team's token", token: "read", method: "GET", path: HZ("locations", CT_OTHER), http: LOCATIONS });
add({ name: "hetzner locations: by a member", token: "memberRead", method: "GET", path: HZ("locations"), http: LOCATIONS });
add({ name: "hetzner locations: the token is refused", token: "read", method: "GET", path: HZ("locations"), http: hzError(401, { code: "unauthorized", message: "unable to authenticate", details: null }) });
add({ name: "hetzner locations: no permission", token: "read", method: "GET", path: HZ("locations"), http: hzError(403, { code: "forbidden", message: "insufficient permissions" }) });
add({ name: "hetzner locations: not found", token: "read", method: "GET", path: HZ("locations"), http: hzError(404, { code: "not_found", message: "not found" }) });
add({ name: "hetzner locations: a conflict", token: "read", method: "GET", path: HZ("locations"), http: hzError(409, { code: "Conflict-Weird", message: "conflict" }) });
add({ name: "hetzner locations: invalid input", token: "read", method: "GET", path: HZ("locations"), http: hzError(422, { code: "invalid_input", message: "invalid", details: { fields: [{ name: "per_page", messages: ["too big"] }, { name: "bad field!" }, { messages: [] }, { name: "page" }] } }) });
add({ name: "hetzner locations: locked", token: "read", method: "GET", path: HZ("locations"), http: hzError(423, { code: "locked", message: "locked" }) });
add({ name: "hetzner locations: a resource limit", token: "read", method: "GET", path: HZ("locations"), http: hzError(403, { code: "RESOURCE_LIMIT_EXCEEDED", message: "limit" }) });
add({ name: "hetzner locations: unavailable", token: "read", method: "GET", path: HZ("locations"), http: hzError(412, { code: "resource_unavailable" }) });
add({ name: "hetzner locations: not unique", token: "read", method: "GET", path: HZ("locations"), http: hzError(409, { code: "uniqueness_error" }) });
add({ name: "hetzner locations: a server error, sent three times", token: "read", method: "GET", path: HZ("locations"), http: hzError(500, { code: "server_error", message: "boom" }) });
add({ name: "hetzner locations: in maintenance", token: "read", method: "GET", path: HZ("locations"), http: hzError(400, { code: "maintenance" }) });
add({ name: "hetzner locations: another status", token: "read", method: "GET", path: HZ("locations"), http: hzError(418, { code: "teapot" }) });
add({ name: "hetzner locations: another status without a code", token: "read", method: "GET", path: HZ("locations"), http: [{ match: HZ_API("locations"), raw: "nope", status: 418 }] });
add({ name: "hetzner locations: rate limited", token: "read", method: "GET", path: HZ("locations"), http: hzError(429, { code: "rate_limit_exceeded" }, { "Retry-After": "7" }) });
add({ name: "hetzner locations: not JSON", token: "read", method: "GET", path: HZ("locations"), http: [{ match: HZ_API("locations"), raw: "<html>ok</html>" }] });
const SERVER_TYPES = [
  answer(`${HZ_API("server_types")}\\?page=1&per_page=50$`, {
    server_types: [
      { id: 1, name: "cx22", description: "CX22", cores: 2, memory: 4, disk: 40, deprecated: false, prices: [{ location: "fsn1", price_hourly: { net: "0.0060", gross: "0.0071" } }], locations: [{ id: 1, name: "fsn1", deprecation: null, available: true }, { id: 2, name: "nbg1", deprecation: { announced: "2025-01-01T00:00:00+00:00", unavailable_after: "2025-04-01T00:00:00+00:00" } }, { id: 3, name: "hel1", available: false }], architecture: "x86" },
      { id: 2, name: "cx11", description: "CX11", cores: 1, memory: 2, deprecated: true, locations: [{ id: 1, name: "fsn1" }] },
      { id: 3, name: "cax11", description: "CAX11", cores: 2, memory: 4, deprecated: null, architecture: "arm", locations: [{ id: 2, name: "nbg1", deprecation: null }] },
      { id: 4, name: "ccx13", description: "CCX13", cores: 2, memory: 8, locations: [{ id: 3, name: "hel1", available: false }] },
      { id: 5, name: "cpx11", description: "CPX11", cores: 2, memory: 2 },
    ],
    meta: page(null),
  }),
];
add({ name: "hetzner server types", token: "read", method: "GET", path: HZ("server-types"), http: SERVER_TYPES });
add({ name: "hetzner server types: in a location", token: "read", method: "GET", path: `${HZ("server-types")}&location=nbg1`, http: SERVER_TYPES });
add({ name: "hetzner server types: in a location without any", token: "read", method: "GET", path: `${HZ("server-types")}&location=ash`, http: SERVER_TYPES });
add({ name: "hetzner server types: an empty location", token: "read", method: "GET", path: `${HZ("server-types")}&location=`, http: SERVER_TYPES });
add({ name: "hetzner server types: not a list of types", token: "read", method: "GET", path: HZ("server-types"), http: [answer(HZ_API("server_types"), { server_types: ["cx22"], meta: page(null) })] });
add({ name: "hetzner images", token: "read", method: "GET", path: HZ("images"), http: [
  answer(`${HZ_API("images")}\\?type=system&page=1&per_page=50$`, { images: [
    { id: 114690387, type: "system", status: "available", name: "debian-12", description: "Debian 12", os_flavor: "debian", os_version: "12", deprecated: null, architecture: "x86" },
    { id: 2, type: "snapshot", name: "my-snap", deprecated: null },
    { id: 3, type: "system", name: "ubuntu-18.04", deprecated: true },
    { id: 4, name: "untyped", deprecated: "2024-01-01T00:00:00+00:00" },
    { id: 5, type: null, name: "null type" },
  ], meta: page(null) }),
] });
add({ name: "hetzner ssh keys", token: "read", method: "GET", path: HZ("ssh-keys"), http: [answer(`${HZ_API("ssh_keys")}\\?page=1&per_page=50$`, { ssh_keys: [{ id: 2323, name: "My ssh key", fingerprint: "b7:2f:30:a0:2f:6c:58:6c:21:04:58:61:ba:06:3b:2f", public_key: "ssh-rsa AAAjjk76kgf== my@host", labels: {}, created: "2016-01-30T23:50:00+00:00" }], meta: page(null) })] });
add({ name: "hetzner firewalls", token: "read", method: "GET", path: HZ("firewalls"), http: [answer(`${HZ_API("firewalls")}\\?page=1&per_page=50$`, { firewalls: [{ id: 38, name: "Corporate Intranet Protection", labels: { env: "prod" }, rules: [{ direction: "in", protocol: "tcp", port: "80", source_ips: ["28.239.13.1/32", "2001:db8::/32"] }], applied_to: [] }], meta: page(null) })] });
add({ name: "hetzner networks", token: "read", method: "GET", path: HZ("networks"), http: [answer(`${HZ_API("networks")}\\?page=1&per_page=50$`, { networks: [{ id: 4711, name: "mynet", ip_range: "10.0.0.0/16", subnets: [{ type: "cloud", ip_range: "10.0.1.0/24", network_zone: "eu-central", gateway: "10.0.0.1" }], servers: [42] }], meta: { pagination: { next_page: null } } })] });
add({ name: "hetzner networks: no resources key", token: "read", method: "GET", path: HZ("networks"), http: [answer(HZ_API("networks"), { meta: { pagination: { next_page: null } } })] });
add({ name: "hetzner: an unknown catalog", token: "read", method: "GET", path: HZ("volumes"), http: [] });
add({ name: "hetzner locations: POST", token: "write", method: "POST", path: HZ("locations"), body: { x: 1 }, http: [] });

const DO = (what, uuid = CT_DO) => `/api/v1/digitalocean/${what}?cloud_provider_token_uuid=${uuid}`;
const DO_API = (path) => `^GET https://api\\.digitalocean\\.com/v2/${path}`;
add({ name: "digitalocean regions", token: "read", method: "GET", path: DO("regions"), http: [
  answer(`${DO_API("regions")}\\?page=1&per_page=50$`, { regions: [{ name: "New York 3", slug: "nyc3", features: ["backups", "ipv6"], available: true, sizes: ["s-1vcpu-1gb"] }, { name: "Old", slug: "old1", available: false }], links: { pages: { next: "https://api.digitalocean.com/v2/regions?page=2&per_page=50" } }, meta: { total: 3 } }),
  answer(`${DO_API("regions")}\\?page=2&per_page=50$`, { regions: [{ name: "Amsterdam 3", slug: "ams3", available: null }], links: {}, meta: { total: 3 } }),
] });
add({ name: "digitalocean regions: the deprecated token id", token: "read", method: "GET", path: `/api/v1/digitalocean/regions?cloud_provider_token_id=${CT_DO}`, http: [answer(DO_API("regions"), { regions: [], links: { pages: { next: "" } } })] });
add({ name: "digitalocean regions: no token", token: "read", method: "GET", path: "/api/v1/digitalocean/regions", http: [] });
add({ name: "digitalocean regions: a Hetzner token", token: "read", method: "GET", path: DO("regions", CT_HETZNER), http: [] });
add({ name: "digitalocean regions: by a member", token: "memberRead", method: "GET", path: DO("regions"), http: [] });
add({ name: "digitalocean regions: the token is refused, sent three times", token: "read", method: "GET", path: DO("regions"), http: [answer(DO_API("regions"), { id: "Unauthorized", message: "Unable to authenticate you" }, 401)] });
add({ name: "digitalocean regions: rate limited", token: "read", method: "GET", path: DO("regions"), http: [answer(DO_API("regions"), { id: "too_many_requests" }, 429, { "Retry-After": "3" })] });
add({ name: "digitalocean regions: not a list of regions", token: "read", method: "GET", path: DO("regions"), http: [answer(DO_API("regions"), { regions: ["nyc3"] })] });
add({ name: "digitalocean sizes", token: "read", method: "GET", path: DO("sizes"), http: [answer(`${DO_API("sizes")}\\?page=1&per_page=50$`, { sizes: [{ slug: "s-1vcpu-1gb", memory: 1024, vcpus: 1, disk: 25, price_monthly: 6, price_hourly: 0.00893, regions: ["nyc3"], available: true, description: "Basic" }, { slug: "gone", available: false }] })] });
add({ name: "digitalocean images", token: "read", method: "GET", path: DO("images"), http: [answer(`${DO_API("images")}\\?type=distribution&page=1&per_page=50$`, { images: [{ id: 129211873, name: "24.04 (LTS) x64", distribution: "Ubuntu", slug: "ubuntu-24-04-x64", public: true, regions: ["nyc3"] }, { id: 2, name: "private", public: false }, { id: 3, name: "no flag" }] })] });
add({ name: "digitalocean ssh keys", token: "read", method: "GET", path: DO("ssh-keys"), http: [answer(`${DO_API("account/keys")}\\?page=1&per_page=50$`, { ssh_keys: [{ id: 512189, fingerprint: "3b:16:bf:e4:8b:00:8b:b8:59:8c:a9:d3:f0:19:45:fa", public_key: "ssh-rsa AEXAMPLEaWEE= example", name: "My SSH Public Key" }], links: {}, meta: { total: 1 } })] });

const VU = (what, uuid = CT_VULTR) => `/api/v1/vultr/${what}?cloud_provider_token_uuid=${uuid}`;
const VU_API = (path) => `^GET https://api\\.vultr\\.com/v2/${path}`;
add({ name: "vultr regions", token: "read", method: "GET", path: VU("regions"), http: [
  answer(`${VU_API("regions")}\\?per_page=100$`, { regions: [{ id: "ams", city: "Amsterdam", country: "NL", continent: "Europe", options: ["ddos_protection"] }], meta: { total: 2, links: { next: "https://api.vultr.com/v2/regions?per_page=100&cursor=bmV4dF9fQU1T", prev: "" } } }),
  answer(`${VU_API("regions")}\\?per_page=100&cursor=bmV4dF9fQU1T$`, { regions: [{ id: "atl", city: "Atlanta", country: "US", continent: "North America", options: [] }], meta: { total: 2, links: { next: "", prev: "" } } }),
] });
add({ name: "vultr regions: a bare cursor", token: "read", method: "GET", path: VU("regions"), http: [answer(VU_API("regions"), { regions: [{ id: "ams" }], meta: { links: { next: "bmV4dF9fQU1T" } } })] });
add({ name: "vultr regions: no token", token: "read", method: "GET", path: "/api/v1/vultr/regions", http: [] });
add({ name: "vultr regions: a Hostinger token", token: "read", method: "GET", path: VU("regions", CT_HOSTINGER), http: [] });
add({ name: "vultr regions: the provider fails, sent three times", token: "read", method: "GET", path: VU("regions"), http: [answer(VU_API("regions"), { error: "boom", status: 500 }, 500)] });
add({ name: "vultr plans", token: "read", method: "GET", path: VU("plans"), http: [answer(`${VU_API("plans")}\\?per_page=100$`, { plans: [{ id: "vc2-1c-1gb", vcpu_count: 1, ram: 1024, disk: 25, monthly_cost: 5, type: "vc2", locations: ["ams"] }], meta: { links: { next: "" } } })] });
add({ name: "vultr operating systems", token: "read", method: "GET", path: VU("os"), http: [answer(`${VU_API("os")}\\?per_page=100$`, { os: [{ id: 2284, name: "Ubuntu 24.04 LTS x64", arch: "x64", family: "ubuntu" }], meta: { links: { next: null } } })] });
add({ name: "vultr ssh keys", token: "read", method: "GET", path: VU("ssh-keys"), http: [answer(`${VU_API("ssh-keys")}\\?per_page=100$`, { ssh_keys: [{ id: "cb676a46-66fd-4dfb-b839-443f2e6c0b60", date_created: "2020-10-10T01:56:20+00:00", name: "Example SSH Key", ssh_key: "ssh-rsa AA... user@example.com" }], meta: {} })] });

const HO = (what, uuid = CT_HOSTINGER) => `/api/v1/hostinger/${what}?cloud_provider_token_uuid=${uuid}`;
const HO_API = (path) => `^GET https://developers\\.hostinger\\.com/api/${path}`;
add({ name: "hostinger data centers", token: "read", method: "GET", path: HO("data-centers"), http: [answer(`${HO_API("vps/v1/data-centers")}$`, [{ id: 9, name: "phx", location: "us", city: "Phoenix", continent: "North America" }, { id: 11, name: "bnk", location: "lt", city: "Vilnius", continent: "Europe" }])] });
add({ name: "hostinger data centers: no token", token: "read", method: "GET", path: "/api/v1/hostinger/data-centers", http: [] });
add({ name: "hostinger data centers: a Vultr token", token: "read", method: "GET", path: HO("data-centers", CT_VULTR), http: [] });
add({ name: "hostinger data centers: by a member", token: "memberRead", method: "GET", path: HO("data-centers"), http: [] });
add({ name: "hostinger data centers: the token is refused", token: "read", method: "GET", path: HO("data-centers"), http: [answer(HO_API("vps/v1/data-centers"), { message: "Unauthenticated.", correlation_id: "abc" }, 401)] });
add({ name: "hostinger data centers: refused without a message", token: "read", method: "GET", path: HO("data-centers"), http: [{ match: HO_API("vps/v1/data-centers"), raw: "", status: 401 }] });
add({ name: "hostinger ssh keys: forbidden", token: "read", method: "GET", path: HO("ssh-keys"), http: [answer(HO_API("vps/v1/public-keys"), { error: "Forbidden" }, 403)] });
add({ name: "hostinger catalog: rate limited", token: "read", method: "GET", path: HO("catalog"), http: [answer(HO_API("billing/v1/catalog"), { message: "Too Many Attempts." }, 429, { "Retry-After": "30" })] });
add({ name: "hostinger catalog: rate limited without Retry-After", token: "read", method: "GET", path: HO("catalog"), http: [answer(HO_API("billing/v1/catalog"), { message: "Too Many Attempts." }, 429)] });
add({ name: "hostinger catalog: a server error, sent three times", token: "read", method: "GET", path: HO("catalog"), http: [answer(HO_API("billing/v1/catalog"), { message: "Server Error" }, 500)] });
add({ name: "hostinger catalog: not found", token: "read", method: "GET", path: HO("catalog"), http: [answer(HO_API("billing/v1/catalog"), { message: "Not found" }, 404)] });
add({ name: "hostinger catalog", token: "read", method: "GET", path: HO("catalog"), http: [answer(`${HO_API("billing/v1/catalog")}\\?category=VPS$`, [
  { id: "hostingercom-vps-kvm2", name: "KVM 2", category: "VPS", metadata: { cpus: "2", memory: "8192" }, prices: [{ id: "hostingercom-vps-kvm2-usd-1m", name: "KVM 2 (billed every month)", currency: "USD", price: 1399, first_period_price: 899, period: 1, period_unit: "month" }] },
  { id: "hostingercom-vps-game-panel-kvm2x", name: "Game Panel", category: "VPS" },
  { id: "hostingercom-vps-kvm8", name: "KVM 8", category: "VPS", metadata: null },
  "not an item",
  { name: "no id" },
])] });
add({ name: "hostinger templates", token: "read", method: "GET", path: HO("templates"), http: [answer(`${HO_API("vps/v1/templates")}$`, [{ id: 1002, name: "Ubuntu 24.04 LTS", description: "Ubuntu 24.04 LTS", documentation: null }])] });
add({ name: "hostinger ssh keys", token: "read", method: "GET", path: HO("ssh-keys"), http: [answer(`${HO_API("vps/v1/public-keys")}$`, { data: [{ id: 325, name: "My public key", key: "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ..." }], meta: { current_page: 1, per_page: 15, total: 1 } })] });
add({ name: "hostinger post-install scripts", token: "read", method: "GET", path: HO("post-install-scripts"), http: [answer(`${HO_API("vps/v1/post-install-scripts")}$`, { data: [{ id: 325, name: "My setup script", content: "#!/bin/bash\napt-get update", created_at: "2025-02-27T11:54:22Z", updated_at: "2025-02-27T11:54:22Z" }], meta: { current_page: 1 } })] });
add({ name: "hostinger post-install scripts: no data", token: "read", method: "GET", path: HO("post-install-scripts"), http: [answer(HO_API("vps/v1/post-install-scripts"), { meta: {} })] });

// ── DP-90: a server's proxy configuration ───────────────────────────────────
// Coolify writes the file on the server over SSH after saving the configuration into the proxy: the emitter has no SSH.
const CFG = SRV("proxy/configuration");
const CFG_AFTER = { server: PROXY_AFTER.server };
const TRAEFIK_COMPOSE = "name: coolify-proxy\nnetworks:\n  coolify:\n    external: true\nservices:\n  traefik:\n    container_name: coolify-proxy\n    image: 'traefik:v3.6'\n    restart: unless-stopped\n    networks:\n      - coolify\n    ports:\n      - '80:80'\n      - '443:443'\n      - '443:443/udp'\n      - '8080:8080'\n    labels:\n      - coolify.managed=true\n";
const withPorts = (ports, service = "traefik", name = "coolify-proxy") => `services:\n  ${service}:\n    container_name: ${name}\n    image: traefik:v3.6\n    ports:\n${ports.map((p) => `      - ${p}`).join("\n")}\n`;
const cfg = (name, configuration, extra = {}) => add({ name: `proxy configuration: ${name}`, token: "root", method: "PUT", path: CFG, setup: FUNCTIONAL, body: { configuration }, after: CFG_AFTER, ...extra });
cfg("save", TRAEFIK_COMPOSE);
cfg("save over a saved one", TRAEFIK_COMPOSE.replace("v3.6", "v3.5"), { setup: [...FUNCTIONAL, ...TRAEFIK_PROXY] });
cfg("save, base64", Buffer.from(TRAEFIK_COMPOSE).toString("base64"));
cfg("save, base64 that is not UTF-8", Buffer.from([0xff, 0xfe, 0x41, 0x42]).toString("base64"));
cfg("save, base64 of blanks", Buffer.from("   \n  ").toString("base64"));
cfg("save, Caddy", "services:\n  caddy:\n    container_name: coolify-proxy\n    image: lucaslorentz/caddy-docker-proxy:2.8-alpine\n    ports:\n      - 80:80\n      - 443:443\n");
cfg("save, no proxy service", "services:\n  other:\n    image: nginx\n    ports:\n      - 99999:80\n");
cfg("save, not a map", "just text");
cfg("save, invalid YAML", "services:\n  traefik:\n    image: [unclosed\n");
cfg("save, a tab", "services:\n\ttraefik: {}\n");
cfg("save, a duplicate key", "services:\n  traefik:\n    image: a\n    image: b\n");
cfg("save, the traefik service unnamed", "services:\n  traefik:\n    image: traefik:v3.6\n    ports:\n      - 80:80\n");
cfg("save, the caddy service renamed", withPorts(["80:80"], "caddy", "my-caddy"));
cfg("save, a renamed proxy on a Swarm server", withPorts(["80:80"], "traefik", "my-proxy"), { setup: [...FUNCTIONAL, "update server_settings set is_swarm_manager = true where server_id = 1"] });
cfg("save, a tagged container name", "services:\n  traefik:\n    container_name: !override coolify-proxy\n    ports: !reset\n      - 80:80\n");
cfg("save, a tagged services map", "services: !foo\n  traefik:\n    container_name: other\n    ports:\n      - 80:80\n");
cfg("save, a tagged port", withPorts(["!tag 80:80", "!tag 99999"]));
cfg("ports: an integer port", withPorts(["80", "443"]));
cfg("ports: out of range", withPorts(["70000:80"]));
cfg("ports: zero", withPorts(["0"]));
cfg("ports: a float", withPorts(["80.5"]));
cfg("ports: a boolean", withPorts(["true"]));
cfg("ports: a range", withPorts(["'8000-8010:8000-8010'"]));
cfg("ports: a reversed range", withPorts(["'8010-8000:80'"]));
cfg("ports: a host IP", withPorts(["'127.0.0.1:8080:80'", "'[::1]:8443:443'", "'0.0.0.0::80'"]));
cfg("ports: a bad host IP", withPorts(["'300.0.0.1:8080:80'"]));
cfg("ports: a bad bracketed IP", withPorts(["'[nope]:80:80'"]));
cfg("ports: too many parts", withPorts(["'1:2:3:4'"]));
cfg("ports: an empty host", withPorts(["':80'"]));
cfg("ports: a protocol", withPorts(["'53:53/UDP'", "'54:54/sctp'"]));
cfg("ports: a bad protocol", withPorts(["'80:80/http'"]));
cfg("ports: variables with defaults", withPorts(["'${HTTP_PORT:-80}:80'", "'${HTTPS_PORT-443}:443'"]));
cfg("ports: an unresolved variable", withPorts(["'${HTTP_PORT}:80'"]));
cfg("ports: a variable with a bad default", withPorts(["'${HTTP_PORT:-99999}:80'"]));
cfg("ports: a variable with unsafe text", withPorts(["'${HTTP_PORT:-80}:80 ;rm'"]));
cfg("ports: long syntax", "services:\n  traefik:\n    container_name: coolify-proxy\n    ports:\n      - target: 80\n        published: '8080'\n        protocol: tcp\n        host_ip: 127.0.0.1\n      - target: '443'\n");
cfg("ports: long syntax without a target", "services:\n  traefik:\n    container_name: coolify-proxy\n    ports:\n      - published: 8080\n");
cfg("ports: long syntax with variables", "services:\n  traefik:\n    container_name: coolify-proxy\n    ports:\n      - target: 80\n        published: ${PORT:-8080}\n        host_ip: ${HOST_IP}\n        protocol: ${PROTO:-tcp}\n      - target: ${TARGET}\n        published: ${OTHER:-99999}\n");
cfg("ports: long syntax with a bad protocol", "services:\n  traefik:\n    container_name: coolify-proxy\n    ports:\n      - target: 80\n        protocol: icmp\n");
cfg("ports: not a list", "services:\n  traefik:\n    container_name: coolify-proxy\n    ports:\n      http: 80\n");
cfg("ports: a list of lists", withPorts(["[80, 80]"]));
add({ name: "proxy configuration: not functional", token: "root", method: "PUT", path: CFG, body: { configuration: TRAEFIK_COMPOSE }, after: CFG_AFTER });
add({ name: "proxy configuration: not functional, invalid ports", token: "root", method: "PUT", path: CFG, body: { configuration: withPorts(["99999"]) } });
add({ name: "proxy configuration: blank", token: "root", method: "PUT", path: CFG, setup: FUNCTIONAL, body: { configuration: "   " } });
add({ name: "proxy configuration: not a string", token: "root", method: "PUT", path: CFG, setup: FUNCTIONAL, body: { configuration: ["services"], extra: true } });
add({ name: "proxy configuration: nothing", token: "root", method: "PUT", path: CFG, raw: "{}" });
add({ name: "proxy configuration: not JSON", token: "root", method: "PUT", path: CFG, raw: "configuration=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "proxy configuration: without the deploy permission", token: "write", method: "PUT", path: CFG, setup: FUNCTIONAL, body: { configuration: TRAEFIK_COMPOSE } });
add({ name: "proxy configuration: with a read token", token: "read", method: "PUT", path: CFG, body: { configuration: TRAEFIK_COMPOSE } });
add({ name: "proxy configuration: unknown server", token: "root", method: "PUT", path: SRV("proxy/configuration", "nonexistentuuid"), body: { configuration: TRAEFIK_COMPOSE } });
add({ name: "proxy configuration: another team's server", token: "root", method: "PUT", path: SRV("proxy/configuration", S_OTHER), body: { configuration: TRAEFIK_COMPOSE } });
add({ name: "proxy configuration: GET", token: "root", method: "GET", path: CFG });

// ── DP-93: policy denials ──
// A request that Coolify's policy refuses ($this->authorize(): an AuthorizationException, which app/Exceptions/Handler.php
// answers under api/* as {"message": the policy's message or "You are not authorized to perform this action.", "error":
// "Unauthorized"} with 403). A member's token may hold only the levels the member holds (EnsureTokenBelongsToCurrentTeamMember):
// a default member (team-wide read) reaches only the read routes whose policy asks for more (a service's variables, image
// scanning); the other denials are made by the member with team-wide levels stored on its membership (team_user.access,
// Coolify's member grants, given by setupCoolify only: Freeploy has no member grants, and its member — builder or viewer —
// holds deploy.resource.read alone), with a token of those levels: read, read:sensitive, deploy and delete, so that what
// needs Write is refused (a variable's change, an update), or read, write and delete, so that what needs a team admin is
// refused (a server, a private key, an S3 storage, a notification channel, a GitHub App, a destination, a team variable).
// Each case is the earlier case of the same request with a member's token: `denied: <the earlier case>, <who>`.
const MEMBER_ACCESS = (levels) => `update team_user set access = '${JSON.stringify([{ scope: "team", levels }])}' where user_id = 2 and team_id = ${T1}`;
const DEPLOY_DELETE = ["read", "read:sensitive", "deploy", "delete"];
const WRITE_DELETE = ["read", "write", "delete"];
const denial = (base, token, levels, who) => {
  const c = cases.find((x) => x.name === base);
  if (!c) throw new Error(`no case ${base}`);
  const copy = JSON.parse(JSON.stringify(c));
  delete copy.name;
  delete copy.token;
  add({ name: `denied: ${base}, ${who}`, token, ...copy, ...(levels && { setupCoolify: [...(copy.setupCoolify ?? []), MEMBER_ACCESS(levels)] }) });
};
const MEMBER = "a member";
const DEPLOYER = "a member with read:sensitive, deploy and delete";
const WRITER = "a member with write and delete";
// A default member's read token.
denial("service envs: list", "memberRead", null, MEMBER);
denial("server image scanning: show", "memberRead", null, MEMBER);
// What needs Write, for a member without it.
denial("application envs: delete", "memberDelete", DEPLOY_DELETE, DEPLOYER);
denial("service envs: delete", "memberDelete", DEPLOY_DELETE, DEPLOYER);
denial("database envs: delete", "memberDelete", DEPLOY_DELETE, DEPLOYER);
denial("tags: delete", "memberDelete", DEPLOY_DELETE, DEPLOYER);
denial("project envs: delete", "memberDelete", DEPLOY_DELETE, DEPLOYER);
denial("server envs: delete", "memberDelete", DEPLOY_DELETE, DEPLOYER);
denial("app destinations: remove", "memberDelete", DEPLOY_DELETE, DEPLOYER);
denial("databases: start", "memberDeploy", DEPLOY_DELETE, DEPLOYER);
denial("execute application task", "memberDeploy", DEPLOY_DELETE, DEPLOYER);
denial("server proxy: restart", "memberDeploy", DEPLOY_DELETE, DEPLOYER);
denial("server registries: list", "memberSensitive", DEPLOY_DELETE, DEPLOYER);
// What needs a team admin, for a member with write.
denial("keys: create", "memberWrite", WRITE_DELETE, WRITER);
denial("keys: update", "memberWrite", WRITE_DELETE, WRITER);
denial("keys: delete", "memberDelete", WRITE_DELETE, WRITER);
denial("servers: validate", "memberWrite", WRITE_DELETE, WRITER);
denial("servers: create", "memberWrite", WRITE_DELETE, WRITER);
denial("servers: delete", "memberDelete", WRITE_DELETE, WRITER);
denial("s3 storages: create", "memberWrite", WRITE_DELETE, WRITER);
denial("s3 storages: delete", "memberDelete", WRITE_DELETE, WRITER);
denial("team envs: create", "memberWrite", WRITE_DELETE, WRITER);
denial("notifications email: update", "memberWrite", WRITE_DELETE, WRITER);
denial("destinations: create", "memberWrite", WRITE_DELETE, WRITER);
denial("docker cleanup: update", "memberWrite", WRITE_DELETE, WRITER);
denial("server image scanning: turned on", "memberWrite", WRITE_DELETE, WRITER);
denial("server cloudflare tunnel: update on", "memberWrite", WRITE_DELETE, WRITER);
denial("server host key: reset", "memberWrite", WRITE_DELETE, WRITER);
denial("github apps: create", "memberWrite", WRITE_DELETE, WRITER);
denial("cloud tokens: create a hetzner token", "memberWrite", WRITE_DELETE, WRITER);

// ── DP-93: through a GitHub App: its repositories and branches, and an application from a private repository ──
// The App (id 3) signs its JWT with the fixture's RSA key (K_GITHUB, private key 4); GitHub is faked per case (`http`):
// the installation token, then the repositories, the branches or the repository. The clock is emit.php's, so the JWT,
// and the Authorization of the token request, are the same on both sides.
const GH_RSA = githubApp(3, "j3parityrsaapp0000000003", 1, "RSA App", 4);
const GH_RSA_SETUP = { setupCoolify: [GH_RSA.coolify], setupFreeploy: [GH_RSA.freeploy] };
const GH_TOKEN_URL = "^POST https://api\\.github\\.com/app/installations/2003/access_tokens$";
const GH_TOKEN = answer(GH_TOKEN_URL, { token: "ghs_paritytoken", expires_at: "2026-01-01T01:00:00Z" }, 201);
const ghRepo = (id, name, extra = {}) => ({ id, node_id: `R_${id}`, name, full_name: `acme/${name}`, private: true, owner: { login: "acme", id: 77 }, html_url: `https://github.com/acme/${name}`, default_branch: "main", ...extra });
const REPOS_PAGE = (page) => `^GET https://api\\.github\\.com/installation/repositories\\?per_page=100&page=${page}$`;
const GH_REPOS = `${GH}/3/repositories`;
const GH_BRANCHES = (owner, repo) => `${GH}/3/repositories/${owner}/${repo}/branches`;
const BRANCHES_URL = (owner, repo) => `^GET https://api\\.github\\.com/repos/${owner}/${repo}/branches$`;
const BRANCHES = [{ name: "main", commit: { sha: "a".repeat(40), url: "https://api.github.com/repos/acme/web/commits/main" }, protected: true }, { name: "feature/x", commit: { sha: "b".repeat(40), url: "https://api.github.com/repos/acme/web/commits/feature" }, protected: false }];
add({ name: "github repositories: list", token: "read", method: "GET", path: GH_REPOS, config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN, answer(REPOS_PAGE(1), { total_count: 3, repositories: [ghRepo(11, "zeta"), ghRepo(12, "Alpha", { description: "Ünïcode / slashes", stargazers_count: 0, score: 1.5, topics: [], license: null, permissions: {} }), ghRepo(13, "alpha")] }), answer(REPOS_PAGE(2), { total_count: 3, repositories: [] })] });
add({ name: "github repositories: list, two pages", token: "read", method: "GET", path: GH_REPOS, config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN, answer(REPOS_PAGE(1), { repositories: [ghRepo(21, "web")] }), answer(REPOS_PAGE(2), { repositories: [ghRepo(22, "api")] }), answer(REPOS_PAGE(3), { repositories: [] })] });
add({ name: "github repositories: list, none", token: "read", method: "GET", path: GH_REPOS, config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN, answer(REPOS_PAGE(1), { total_count: 0, repositories: [] })] });
add({ name: "github repositories: list by a member", token: "memberRead", method: "GET", path: GH_REPOS, config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN, answer(REPOS_PAGE(1), { repositories: [] })] });
add({ name: "github repositories: GitHub refuses the token", token: "read", method: "GET", path: GH_REPOS, config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN, answer(REPOS_PAGE(1), { message: "Bad credentials", documentation_url: "https://docs.github.com/rest" }, 401)] });
add({ name: "github repositories: GitHub fails three times", token: "read", method: "GET", path: GH_REPOS, config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN, answer(REPOS_PAGE(1), { message: "Server Error" }, 502)] });
add({ name: "github repositories: a failure without a message", token: "read", method: "GET", path: GH_REPOS, config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN, answer(REPOS_PAGE(1), { error: "nope" }, 404)] });
add({ name: "github repositories: no installation token", token: "read", method: "GET", path: GH_REPOS, config: CLOUD, ...GH_RSA_SETUP, http: [answer(GH_TOKEN_URL, { message: "Not Found" }, 404)] });
const GH_NO_KEY = githubApp(3, "j3parityrsaapp0000000003", 1, "RSA App", "null");
add({ name: "github repositories: the App has no key", token: "read", method: "GET", path: GH_REPOS, config: CLOUD, setupCoolify: [GH_NO_KEY.coolify], setupFreeploy: [GH_NO_KEY.freeploy], http: [GH_TOKEN] });
add({ name: "github repositories: unknown App", token: "read", method: "GET", path: `${GH}/99/repositories`, config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN] });
add({ name: "github repositories: with a write-only token", token: "writeOnly", method: "GET", path: GH_REPOS, config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN] });
add({ name: "github branches: list", token: "read", method: "GET", path: GH_BRANCHES("acme", "web"), config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN, answer(BRANCHES_URL("acme", "web"), BRANCHES)] });
add({ name: "github branches: list, none", token: "read", method: "GET", path: GH_BRANCHES("acme", "web"), config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN, answer(BRANCHES_URL("acme", "web"), [])] });
add({ name: "github branches: a dotted owner and repository", token: "read", method: "GET", path: GH_BRANCHES("acme.inc", "web_app-1.x"), config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN, answer(BRANCHES_URL("acme\\.inc", "web_app-1\\.x"), BRANCHES.slice(0, 1))] });
add({ name: "github branches: an invalid owner and repository", token: "read", method: "GET", path: GH_BRANCHES("acme%20inc", "web%24app"), config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN] });
add({ name: "github branches: an invalid repository", token: "read", method: "GET", path: GH_BRANCHES("acme", "..."), config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN, answer(BRANCHES_URL("acme", "\\.\\.\\."), [])] });
add({ name: "github branches: GitHub does not know the repository", token: "read", method: "GET", path: GH_BRANCHES("acme", "gone"), config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN, answer(BRANCHES_URL("acme", "gone"), { message: "Not Found", documentation_url: "https://docs.github.com/rest" }, 404)] });
add({ name: "github branches: unknown App", token: "read", method: "GET", path: `${GH}/99/repositories/acme/web/branches`, config: CLOUD, ...GH_RSA_SETUP, http: [GH_TOKEN] });
add({ name: "github branches: no installation token", token: "read", method: "GET", path: GH_BRANCHES("acme", "web"), config: CLOUD, ...GH_RSA_SETUP, http: [answer(GH_TOKEN_URL, { message: "Bad credentials" }, 401)] });

// POST /applications/private-github-app: create_application($request, 'private-gh-app').
const GHA = CREATE("private-github-app");
const GHA_REPO = { ...IMAGE_ON, github_app_uuid: "j3parityrsaapp0000000003", git_repository: "acme/private", git_branch: "main", build_pack: "nixpacks", ports_exposes: "3000" };
const REPO_URL = (slug) => `^GET https://api\\.github\\.com/repos/${slug}$`;
const GH_REPO_OK = (slug = "acme/private") => answer(REPO_URL(slug.replace(/\./g, "\\.")), ghRepo(4242, slug.split("/")[1]));
add({ name: "github app create: a GitHub App", token: "write", method: "POST", path: GHA, ...GH_RSA_SETUP, body: GHA_REPO, http: [GH_TOKEN, GH_REPO_OK()], after: CREATED_AFTER });
add({ name: "github app create: a GitHub App, a repository URL", token: "write", method: "POST", path: GHA, ...GH_RSA_SETUP, body: { ...GHA_REPO, git_repository: "https://github.com/acme/private.git", build_pack: "dockerfile", name: "from-github", domains: "https://gh.acme.test" }, http: [GH_TOKEN, GH_REPO_OK()], after: CREATED_AFTER });
add({ name: "github app create: a GitHub App, an SSH URL", token: "write", method: "POST", path: GHA, ...GH_RSA_SETUP, body: { ...GHA_REPO, git_repository: "git@github.com:acme/private.git", build_pack: "static", is_static: true }, http: [GH_TOKEN, GH_REPO_OK()], after: CREATED_AFTER });
add({ name: "github app create: a GitHub App, Docker Compose", token: "write", method: "POST", path: GHA, ...GH_RSA_SETUP, body: { ...GHA_REPO, build_pack: "dockercompose", docker_compose_location: "/compose.yaml", docker_compose_domains: [{ name: "web", domain: "https://web.acme.test" }] }, http: [GH_TOKEN, GH_REPO_OK()], after: CREATED_AFTER });
add({ name: "github app create: a GitHub App, the repository not accessible", token: "write", method: "POST", path: GHA, ...GH_RSA_SETUP, body: GHA_REPO, http: [GH_TOKEN, answer(REPO_URL("acme/private"), { message: "Not Found" }, 404)], after: NOTHING_CREATED });
add({ name: "github app create: a GitHub App, GitHub fails", token: "write", method: "POST", path: GHA, ...GH_RSA_SETUP, body: GHA_REPO, http: [GH_TOKEN, answer(REPO_URL("acme/private"), { message: "Unavailable" }, 503)], after: NOTHING_CREATED });
add({ name: "github app create: a GitHub App, GitHub refuses", token: "write", method: "POST", path: GHA, ...GH_RSA_SETUP, body: GHA_REPO, http: [GH_TOKEN, answer(REPO_URL("acme/private"), { message: "Moved" }, 400)], after: NOTHING_CREATED });
add({ name: "github app create: a GitHub App, rate limited", token: "write", method: "POST", path: GHA, ...GH_RSA_SETUP, body: GHA_REPO, http: [GH_TOKEN, answer(REPO_URL("acme/private"), { message: "API rate limit exceeded" }, 403, { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1767229200" })], after: NOTHING_CREATED });
add({ name: "github app create: a GitHub App, no installation token", token: "write", method: "POST", path: GHA, ...GH_RSA_SETUP, body: GHA_REPO, http: [answer(GH_TOKEN_URL, { message: "Not Found" }, 404)], after: NOTHING_CREATED });
add({ name: "github app create: a GitHub App, unknown App", token: "write", method: "POST", path: GHA, ...GH_RSA_SETUP, body: { ...GHA_REPO, github_app_uuid: "nonexistentuuid" }, http: [GH_TOKEN] });
add({ name: "github app create: a GitHub App, invalid", token: "write", method: "POST", path: GHA, ...GH_RSA_SETUP, body: { ...IMAGE_ON, git_repository: 5, git_branch: "a..b", build_pack: "heroku", ports_exposes: "80,x", watch_paths: [], docker_compose_domains: "x" }, http: [GH_TOKEN] });
add({ name: "github app create: a GitHub App, domains for Docker Compose", token: "write", method: "POST", path: GHA, ...GH_RSA_SETUP, body: { ...GHA_REPO, build_pack: "dockercompose", domains: "https://x.acme.test" }, http: [GH_TOKEN] });
add({ name: "github app create: a GitHub App, a domain in use", token: "write", method: "POST", path: GHA, ...GH_RSA_SETUP, body: { ...GHA_REPO, domains: "https://image.example.com" }, http: [GH_TOKEN, GH_REPO_OK()] });
add({ name: "github app create: a GitHub App, a member", token: "memberWrite", method: "POST", path: GHA, ...GH_RSA_SETUP, body: GHA_REPO, http: [GH_TOKEN, GH_REPO_OK()] });
add({ name: "github app create: a GitHub App, with a read token", token: "read", method: "POST", path: GHA, ...GH_RSA_SETUP, body: GHA_REPO, http: [GH_TOKEN, GH_REPO_OK()] });
add({ name: "github app create: a GitHub App, instant deploy", token: "root", method: "POST", path: GHA, ...GH_RSA_SETUP, body: { ...GHA_REPO, instant_deploy: true }, http: [GH_TOKEN, GH_REPO_OK()], after: NOTHING_CREATED });

// ── DP-93: POST /servers/hostinger (HostingerController::createServer) ──
// Hostinger is faked per case (`http`): the account's virtual machines, the purchase, the public keys' attachment and a
// machine's state. The new server is the one whose name is not the fixture's; its public key is the fixture key's real one
// (K_MAIN, ed25519), sent in the purchase's setup. ValidateNewCloudServerJob is queued (faked) after the server is stored.
const HOS = "/api/v1/servers/hostinger";
const HOS_VMS = "^GET https://developers\\.hostinger\\.com/api/vps/v1/virtual-machines$";
const HOS_BUY = "^POST https://developers\\.hostinger\\.com/api/vps/v1/virtual-machines$";
const HOS_VM = (id) => `^GET https://developers\\.hostinger\\.com/api/vps/v1/virtual-machines/${id}$`;
const HOS_ATTACH = (id) => `^POST https://developers\\.hostinger\\.com/api/vps/v1/public-keys/attach/${id}$`;
const vm = (id, state, ip) => ({ id, firewall_group_id: null, subscription_id: `sub-${id}`, plan: "KVM 2", hostname: "srv.example.com", state, actions_lock: "unlocked", cpus: 2, memory: 8192, disk: 102400, bandwidth: 8192000, ns1: "1.1.1.1", ns2: "8.8.8.8", ipv4: ip ? [{ id: 11, address: ip, ptr: null }] : [], ipv6: [], template: { id: 1121, name: "Ubuntu 24.04" }, created_at: "2026-01-01T00:00:00Z" });
const HOS_BODY = { cloud_provider_token_uuid: CT_HOSTINGER, item_id: "hostingercom-vps-kvm2-usd-1m", data_center_id: 9, template_id: 1121, name: "VPS1.Example.com", private_key_uuid: K_MAIN };
const HOS_BOUGHT = (state = "installing", ip = "198.51.100.7") => answer(HOS_BUY, { order: { id: 777, status: "completed" }, virtual_machine: vm(5001, state, ip) });
const HOS_AFTER = {
  server: "select case when name ~ '^[a-z]+(-[a-z]+)+-[a-z0-9]{24}$' then '<random-name>' else name end as name, description, ip, port, \"user\", private_key_id, cloud_provider_token_id, hostinger_virtual_machine_id, hostinger_virtual_machine_status, proxy::jsonb->>'type' as proxy_type, proxy::jsonb->>'status' as proxy_status, (proxy::jsonb->>'redirect_enabled')::boolean as redirect_enabled from servers where id > 2 order by id",
  settings: "select ss.server_role, ss.is_build_server from server_settings ss join servers s on s.id = ss.server_id where s.id > 2",
  destination: "select d.network from standalone_dockers d join servers s on s.id = d.server_id where s.id > 2",
};
add({ name: "server via Hostinger: create", token: "write", method: "POST", path: HOS, body: HOS_BODY, http: [answer(HOS_VMS, []), HOS_BOUGHT()], after: HOS_AFTER });
add({ name: "server via Hostinger: create, the deprecated token id", token: "write", method: "POST", path: HOS, body: { ...HOS_BODY, cloud_provider_token_uuid: undefined, cloud_provider_token_id: CT_HOSTINGER, enable_backups: true }, http: [answer(HOS_VMS, [vm(4001, "running", "198.51.100.1")]), HOS_BOUGHT()], after: HOS_AFTER });
add({ name: "server via Hostinger: create, a name without a dot", token: "write", method: "POST", path: HOS, body: { ...HOS_BODY, name: " vps1 " }, http: [answer(HOS_VMS, []), HOS_BOUGHT()], after: HOS_AFTER });
add({ name: "server via Hostinger: create, a generated name", token: "write", method: "POST", path: HOS, body: { ...HOS_BODY, name: undefined }, http: [answer(HOS_VMS, []), HOS_BOUGHT()], after: HOS_AFTER });
add({ name: "server via Hostinger: create, the IP after a wait", token: "write", method: "POST", path: HOS, body: HOS_BODY, http: [answer(HOS_VMS, []), HOS_BOUGHT("initial", null), answer(HOS_VM(5001), vm(5001, "running", "198.51.100.8"))], after: HOS_AFTER });
add({ name: "server via Hostinger: create, no IP yet", token: "write", method: "POST", path: HOS, body: HOS_BODY, http: [answer(HOS_VMS, []), HOS_BOUGHT("installing", null), answer(HOS_VM(5001), vm(5001, "installing", null))], after: HOS_AFTER });
add({ name: "server via Hostinger: create with public keys and a script, without validating", token: "root", method: "POST", path: HOS, body: { ...HOS_BODY, public_key_ids: [31, "32"], post_install_script_id: 41, instant_validate: false }, http: [answer(HOS_VMS, []), HOS_BOUGHT(), answer(HOS_ATTACH(5001), { data: [] })], after: HOS_AFTER });
add({ name: "server via Hostinger: create, the keys not attached", token: "root", method: "POST", path: HOS, body: { ...HOS_BODY, public_key_ids: [31], instant_validate: false }, http: [answer(HOS_VMS, []), HOS_BOUGHT(), answer(HOS_ATTACH(5001), { message: "Key not found" }, 422)], after: HOS_AFTER });
add({ name: "server via Hostinger: create and validate", token: "root", method: "POST", path: HOS, body: HOS_BODY, http: [answer(HOS_VMS, []), HOS_BOUGHT()], after: HOS_AFTER });
add({ name: "server via Hostinger: create, waiting for payment", token: "write", method: "POST", path: HOS, body: HOS_BODY, http: [answer(HOS_VMS, []), answer(HOS_BUY, { id: 778, subscription_id: null, status: "pending", message: "Awaiting payment" })], after: HOS_AFTER });
add({ name: "server via Hostinger: create, the purchase refused", token: "write", method: "POST", path: HOS, body: HOS_BODY, http: [answer(HOS_VMS, []), answer(HOS_BUY, { message: "The selected item is invalid." }, 422)], after: HOS_AFTER });
add({ name: "server via Hostinger: create, rate limited", token: "write", method: "POST", path: HOS, body: HOS_BODY, http: [answer(HOS_VMS, { message: "Too many requests" }, 429, { "Retry-After": "30" })], after: HOS_AFTER });
add({ name: "server via Hostinger: create, Hostinger fails", token: "write", method: "POST", path: HOS, body: HOS_BODY, http: [answer(HOS_VMS, { error: "Upstream" }, 503)], after: HOS_AFTER });
add({ name: "server via Hostinger: create, invalid", token: "write", method: "POST", path: HOS, body: { cloud_provider_token_uuid: 5, data_center_id: "x", template_id: 1.5, name: "bad name!", enable_backups: "maybe", public_key_ids: "31", post_install_script_id: "x", instant_validate: "no", extra: 1 } });
add({ name: "server via Hostinger: create, invalid public keys", token: "write", method: "POST", path: HOS, body: { ...HOS_BODY, public_key_ids: [1, "x", null], name: "-vps.example.com" } });
add({ name: "server via Hostinger: create, no token", token: "write", method: "POST", path: HOS, body: { ...HOS_BODY, cloud_provider_token_uuid: undefined } });
add({ name: "server via Hostinger: create, unknown token", token: "write", method: "POST", path: HOS, body: { ...HOS_BODY, cloud_provider_token_uuid: "nonexistentuuid" } });
add({ name: "server via Hostinger: create, another provider's token", token: "write", method: "POST", path: HOS, body: { ...HOS_BODY, cloud_provider_token_uuid: CT_HETZNER } });
add({ name: "server via Hostinger: create, unknown private key", token: "write", method: "POST", path: HOS, body: { ...HOS_BODY, private_key_uuid: "nonexistentuuid" } });
add({ name: "server via Hostinger: create, another team's private key", token: "write", method: "POST", path: HOS, body: { ...HOS_BODY, private_key_uuid: K_OTHER } });
add({ name: "server via Hostinger: create, a script without deploy", token: "write", method: "POST", path: HOS, body: { ...HOS_BODY, post_install_script_id: 41 } });
add({ name: "server via Hostinger: create, validating without deploy", token: "write", method: "POST", path: HOS, body: { ...HOS_BODY, instant_validate: true } });
add({ name: "server via Hostinger: create, not JSON", token: "write", method: "POST", path: HOS, raw: "item_id=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "server via Hostinger: create with a read token", token: "read", method: "POST", path: HOS, body: HOS_BODY });
add({ name: "server via Hostinger: create, a member", token: "memberRead", method: "POST", path: HOS, body: HOS_BODY });
denial("server via Hostinger: create", "memberWrite", WRITE_DELETE, WRITER);

// ── DP-104: integration tokens (IntegrationTokensController) ────────────────
// The providers' APIs are Http::fake() (`http`): Cloudflare's token verification, zones, DNS records and tunnels, Doppler's
// /v3/me, Infisical's universal-auth login and Vault's lookup-self. A Cloudflare token's zones are read again when it is
// stored (syncZones()); `failedConnection` is a transfer that fails (Laravel's ConnectionException).
const IT = "/api/v1/security/integration-tokens";
const IT_AFTER = {
  tokens: `select case when id <= 6 then id end as fixture_id, provider, name, capabilities::jsonb::text as capabilities, (metadata::jsonb - 'zones_synced_at')::text as metadata, (metadata::jsonb->>'zones_synced_at') is not null as zones_synced, token is not null as has_token from integration_tokens where uuid <> '${IT_OTHER}' order by id`,
  zones: `select case when z.id <= 4 then z.id end as fixture_id, z.integration_token_id <= 6 as fixture_token, z.provider_zone_id, z.name, z.account_id, z.account_name from dns_provider_zones z join integration_tokens t on t.id = z.integration_token_id where t.uuid <> '${IT_OTHER}' order by z.provider_zone_id, z.id`,
};
const CF = "https://api\\.cloudflare\\.com/client/v4";
const cfZone = (id, name, account = { id: "acc-1", name: "Parity Account" }) => ({ id, name, status: "active", account });
const CF_VERIFY = (status = "active", code = 200) => answer(`^GET ${CF}/user/tokens/verify$`, code === 200 ? { success: true, result: { id: "tok-1", status } } : { success: false, errors: [{ code: 1000, message: "Invalid API Token" }] }, code);
const CF_ZONE_PROBE = (zones = [cfZone("zone-com", "example.com")], code = 200) => answer(`^GET ${CF}/zones\\?per_page=1$`, { success: code === 200, result: zones }, code);
const CF_RECORDS = (zone = "zone-com", code = 200) => answer(`^GET ${CF}/zones/${zone}/dns_records\\?per_page=1$`, { success: code === 200, result: [] }, code);
const CF_TUNNELS = (account = "acc-1", code = 200) => answer(`^GET ${CF}/accounts/${account}/cfd_tunnel\\?per_page=1&is_deleted=false$`, { success: code === 200, result: [] }, code);
const CF_ZONES = (page, zones, totalPages = 1, code = 200, success = code === 200) => answer(`^GET ${CF}/zones\\?page=${page}&per_page=50$`, { success, result: zones, result_info: { page, per_page: 50, total_pages: totalPages, count: zones.length } }, code);
const CF_OK = (zones = [cfZone("zone-com", "Example.com"), cfZone("zone-new", "new.example", { id: "acc-2", name: null })]) => [CF_VERIFY(), CF_ZONE_PROBE(), CF_RECORDS(), CF_ZONES(1, zones)];
const DOPPLER_ME = (code = 200) => answer("^GET https://api\\.doppler\\.com/v3/me$", code === 200 ? { workplace: { name: "Parity" }, type: "service_token" } : { messages: ["Invalid Auth token"], success: false }, code);
const INFISICAL_LOGIN = (base = "https://app\\.infisical\\.com", code = 200) => answer(`^POST ${base}/api/v1/auth/universal-auth/login$`, code === 200 ? { accessToken: "inf-access-token", expiresIn: 7200, tokenType: "Bearer" } : { message: "Invalid credentials" }, code);
const VAULT_LOOKUP = (base = "https://vault\\.example\\.com:8200", code = 200) => answer(`^GET ${base}/v1/auth/token/lookup-self$`, code === 200 ? { data: { policies: ["default"] } } : { errors: ["permission denied"] }, code);
const FAILED = (match) => ({ match, failedConnection: true });
/** A secret manager link of the Doppler token (Coolify's table has no team), a managed record in a zone of the first Cloudflare token (each side's tenancy column). */
const SECRET_LINK = (tenancy) => `insert into secret_manager_links (uuid, resourceable_type, resourceable_id, integration_token_id, settings, ${tenancy ? `${tenancy[0]}, ` : ""}created_at, updated_at) values ('l1paritysecretlink000001', 'App\\Models\\Application', 1, 3, null, ${tenancy ? `${tenancy[1]}, ` : ""}'2025-12-30 00:00:00', '2025-12-30 00:00:00')`;
const MANAGED_RECORD = (tenancy, zone = 1) => `insert into managed_dns_records (uuid, integration_token_id, dns_provider_zone_id, provider_record_id, type, name, content, owned, ${tenancy[0]}, created_at, updated_at) values ('m1paritymanagedrecord001', 1, ${zone}, 'rec-1', 'A', 'app.example.org', '203.0.113.10', true, ${tenancy[1]}, '2025-12-30 00:00:00', '2025-12-30 00:00:00')`;
const COOLIFY_TENANCY = ["team_id", T1];
const FREEPLOY_TENANCY = ["org_id", "deploy.current_org()"];
const WITH_LINK = { setupCoolify: [SECRET_LINK(null)], setupFreeploy: [SECRET_LINK(FREEPLOY_TENANCY)] };
const WITH_RECORD = (zone = 1) => ({ setupCoolify: [MANAGED_RECORD(COOLIFY_TENANCY, zone)], setupFreeploy: [MANAGED_RECORD(FREEPLOY_TENANCY, zone)] });

// list and show
add({ name: "integration tokens: list", token: "read", method: "GET", path: IT });
add({ name: "integration tokens: list, read:sensitive", token: "sensitive", method: "GET", path: IT });
add({ name: "integration tokens: list by a member", token: "memberRead", method: "GET", path: IT });
add({ name: "integration tokens: show a cloudflare token", token: "read", method: "GET", path: `${IT}/${IT_CF}` });
add({ name: "integration tokens: show a cloudflare token without automatic DNS", token: "read", method: "GET", path: `${IT}/${IT_CF_TUNNEL}` });
add({ name: "integration tokens: show a doppler token", token: "read", method: "GET", path: `${IT}/${IT_DOPPLER}` });
add({ name: "integration tokens: show a vault token", token: "sensitive", method: "GET", path: `${IT}/${IT_VAULT}` });
add({ name: "integration tokens: show unknown", token: "read", method: "GET", path: `${IT}/nonexistentuuid` });
add({ name: "integration tokens: show another team's", token: "read", method: "GET", path: `${IT}/${IT_OTHER}` });
add({ name: "integration tokens: show by a member", token: "memberRead", method: "GET", path: `${IT}/${IT_CF}` });
add({ name: "integration tokens: show unknown by a member", token: "memberRead", method: "GET", path: `${IT}/nonexistentuuid` });

// create: Cloudflare
add({ name: "integration tokens: create a cloudflare token", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "New Cloudflare", token: "cf-new-token", capabilities: ["dns"] }, http: CF_OK(), after: IT_AFTER });
add({ name: "integration tokens: create a cloudflare token, the default capability", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "Default DNS", token: "cf-new-token" }, http: CF_OK(), after: IT_AFTER });
add({ name: "integration tokens: create a cloudflare token with a tunnel, no automatic DNS, proxied", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "With tunnel", token: "cf-tunnel-token", capabilities: ["tunnel", "dns", "dns"], automatic_dns: false, proxied_dns: true }, http: [...CF_OK(), CF_TUNNELS()], after: IT_AFTER });
add({ name: "integration tokens: create a cloudflare token, zones on two pages", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "Two pages", token: "cf-new-token" }, http: [CF_VERIFY(), CF_ZONE_PROBE(), CF_RECORDS(), CF_ZONES(1, [cfZone("zone-a", "A.example")], 2), CF_ZONES(2, [cfZone("zone-b", "b.example", null)], 2)], after: IT_AFTER });
add({ name: "integration tokens: create a cloudflare token, not active", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "Disabled", token: "cf-disabled" }, http: [CF_VERIFY("disabled")], after: IT_AFTER });
add({ name: "integration tokens: create a cloudflare token, refused", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "Refused", token: "cf-bad" }, http: [CF_VERIFY("active", 401)], after: IT_AFTER });
add({ name: "integration tokens: create a cloudflare token, no zone", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "No zone", token: "cf-new-token" }, http: [CF_VERIFY(), CF_ZONE_PROBE([])], after: IT_AFTER });
add({ name: "integration tokens: create a cloudflare token, no DNS access", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "No records", token: "cf-new-token" }, http: [CF_VERIFY(), CF_ZONE_PROBE(), CF_RECORDS("zone-com", 403)], after: IT_AFTER });
add({ name: "integration tokens: create a cloudflare token, no tunnel access", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "No tunnel", token: "cf-new-token", capabilities: ["dns", "tunnel"] }, http: [CF_VERIFY(), CF_ZONE_PROBE(), CF_RECORDS(), CF_TUNNELS("acc-1", 403)], after: IT_AFTER });
add({ name: "integration tokens: create a cloudflare token, a tunnel and a zone without an account", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "No account", token: "cf-new-token", capabilities: ["dns", "tunnel"] }, http: [CF_VERIFY(), CF_ZONE_PROBE([cfZone("zone-com", "example.com", null)]), CF_RECORDS()], after: IT_AFTER });
add({ name: "integration tokens: create a cloudflare token, the zones refused", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "Zones refused", token: "cf-new-token" }, http: [CF_VERIFY(), CF_ZONE_PROBE(), CF_RECORDS(), CF_ZONES(1, [], 1, 403)], after: IT_AFTER });
add({ name: "integration tokens: create a cloudflare token, the zones not synchronized", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "Zones failed", token: "cf-new-token" }, http: [CF_VERIFY(), CF_ZONE_PROBE(), CF_RECORDS(), CF_ZONES(1, [], 1, 200, false)], after: IT_AFTER });
add({ name: "integration tokens: create a cloudflare token, Cloudflare unreachable", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "Offline", token: "cf-new-token" }, http: [FAILED(`^GET ${CF}/user/tokens/verify$`)], after: IT_AFTER });
add({ name: "integration tokens: create a cloudflare token, a tunnel without DNS", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "Tunnel only", token: "cf-new-token", capabilities: ["tunnel"] }, http: [] });
add({ name: "integration tokens: create a cloudflare token, the secrets capability and metadata", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "Wrong", token: "cf-new-token", capabilities: ["dns", "secrets", 7], metadata: { base_url: "https://x.example" }, automatic_dns: "maybe" }, http: [] });
add({ name: "integration tokens: create a cloudflare token, no capabilities", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "None", token: "cf-new-token", capabilities: [] }, http: [] });
add({ name: "integration tokens: create a cloudflare token, capabilities not a list", token: "write", method: "POST", path: IT, body: { provider: "cloudflare", name: "String", token: "cf-new-token", capabilities: "dns", proxied_dns: 2 }, http: [] });
// create: the secret managers
add({ name: "integration tokens: create a doppler token", token: "write", method: "POST", path: IT, body: { provider: "doppler", name: "New Doppler", token: "dp.sa.newtoken" }, http: [DOPPLER_ME()], after: IT_AFTER });
add({ name: "integration tokens: create a doppler token, refused", token: "write", method: "POST", path: IT, body: { provider: "doppler", name: "Refused", token: "dp.st.bad" }, http: [DOPPLER_ME(401)], after: IT_AFTER });
add({ name: "integration tokens: create a doppler token, Doppler unreachable", token: "write", method: "POST", path: IT, body: { provider: "doppler", name: "Offline", token: "dp.st.offline" }, http: [FAILED("^GET https://api\\.doppler\\.com/v3/me$")], after: IT_AFTER });
add({ name: "integration tokens: create a doppler token, not a service token", token: "write", method: "POST", path: IT, body: { provider: "doppler", name: "Personal", token: "dp.pt.personal", automatic_dns: true, capabilities: ["dns"] }, http: [] });
add({ name: "integration tokens: create an infisical token", token: "write", method: "POST", path: IT, body: { provider: "infisical", name: "New Infisical", token: "inf-new-secret", metadata: { base_url: "https://app.infisical.com/", client_id: "client-new", timeout: 30, extra: "" } }, http: [INFISICAL_LOGIN()], after: IT_AFTER });
add({ name: "integration tokens: create an infisical token, the login refused", token: "write", method: "POST", path: IT, body: { provider: "infisical", name: "Refused", token: "inf-bad", metadata: { base_url: "https://app.infisical.com", client_id: "client-bad" } }, http: [INFISICAL_LOGIN("https://app\\.infisical\\.com", 401)], after: IT_AFTER });
add({ name: "integration tokens: create an infisical token, no access token", token: "write", method: "POST", path: IT, body: { provider: "infisical", name: "No token", token: "inf-x", metadata: { base_url: "https://app.infisical.com", client_id: "client-x" } }, http: [answer("^POST https://app\\.infisical\\.com/api/v1/auth/universal-auth/login$", { accessToken: "" })], after: IT_AFTER });
add({ name: "integration tokens: create an infisical token, no settings", token: "write", method: "POST", path: IT, body: { provider: "infisical", name: "Missing", token: "inf-x" }, http: [] });
add({ name: "integration tokens: create an infisical token, invalid settings", token: "write", method: "POST", path: IT, body: { provider: "infisical", name: "Invalid", token: "inf-x", metadata: { base_url: "ftp://files.example.com", client_id: 12, timeout: 0 } }, http: [] });
add({ name: "integration tokens: create an infisical token, a timeout too long", token: "write", method: "POST", path: IT, body: { provider: "infisical", name: "Slow", token: "inf-x", metadata: { base_url: "https://app.infisical.com", client_id: "c", timeout: "abc" } }, http: [] });
add({ name: "integration tokens: create an infisical token, a private address", token: "write", method: "POST", path: IT, body: { provider: "infisical", name: "Private", token: "inf-x", metadata: { base_url: "https://private.example", client_id: "c" } }, http: [], after: IT_AFTER });
add({ name: "integration tokens: create an infisical token, an unresolvable host", token: "write", method: "POST", path: IT, body: { provider: "infisical", name: "Nowhere", token: "inf-x", metadata: { base_url: "https://unresolvable.example", client_id: "c" } }, http: [] });
add({ name: "integration tokens: create a vault token", token: "write", method: "POST", path: IT, body: { provider: "vault", name: "New Vault", token: "hvs.newtoken", capabilities: ["secrets"], metadata: { base_url: "https://vault.example.com:8200", namespace: "admin/new", timeout: "20" } }, http: [VAULT_LOOKUP()], after: IT_AFTER });
add({ name: "integration tokens: create a vault token without a namespace", token: "write", method: "POST", path: IT, body: { provider: "vault", name: "Plain Vault", token: "hvs.plain", metadata: { base_url: "https://vault.example.com:8200" } }, http: [VAULT_LOOKUP()], after: IT_AFTER });
add({ name: "integration tokens: create a vault token, refused", token: "write", method: "POST", path: IT, body: { provider: "vault", name: "Refused", token: "hvs.bad", metadata: { base_url: "https://vault.example.com:8200" } }, http: [VAULT_LOOKUP("https://vault\\.example\\.com:8200", 403)], after: IT_AFTER });
add({ name: "integration tokens: create a vault token, metadata not an object", token: "write", method: "POST", path: IT, body: { provider: "vault", name: "Bad", token: "hvs.x", metadata: "https://vault.example.com" }, http: [] });
// create: the request
add({ name: "integration tokens: create, invalid", token: "write", method: "POST", path: IT, body: { provider: "aws", name: "x".repeat(256), token: 5, description: "not allowed", capabilities: ["secrets"] }, http: [] });
add({ name: "integration tokens: create, nothing required", token: "write", method: "POST", path: IT, body: { other: 1 }, http: [] });
add({ name: "integration tokens: create, a provider that is not a string", token: "write", method: "POST", path: IT, body: { provider: ["cloudflare"], name: "n", token: "t" }, http: [] });
add({ name: "integration tokens: create, not JSON", token: "write", method: "POST", path: IT, raw: "provider=doppler", contentType: "application/x-www-form-urlencoded", http: [] });
add({ name: "integration tokens: create, empty JSON", token: "write", method: "POST", path: IT, raw: "{}", http: [] });
add({ name: "integration tokens: create with a read token", token: "read", method: "POST", path: IT, body: { provider: "doppler", name: "n", token: "dp.st.x" }, http: [] });

// update
add({ name: "integration tokens: update, a new name", token: "write", method: "PATCH", path: `${IT}/${IT_CF}`, body: { name: "Renamed Cloudflare" }, http: [], after: IT_AFTER });
add({ name: "integration tokens: update, the same name", token: "write", method: "PATCH", path: `${IT}/${IT_CF}`, body: { name: "Parity Cloudflare" }, http: [], after: { ...IT_AFTER, touched: "select updated_at = created_at as untouched from integration_tokens where id = 1" } });
add({ name: "integration tokens: update, automatic DNS off", token: "write", method: "PATCH", path: `${IT}/${IT_CF}`, body: { automatic_dns: false, proxied_dns: true }, http: [CF_VERIFY(), CF_ZONE_PROBE(), CF_RECORDS()], after: IT_AFTER });
add({ name: "integration tokens: update, the flags as they are", token: "write", method: "PATCH", path: `${IT}/${IT_CF_TUNNEL}`, body: { automatic_dns: false, proxied_dns: 1 }, http: [], after: IT_AFTER });
add({ name: "integration tokens: update, a new cloudflare token", token: "write", method: "PATCH", path: `${IT}/${IT_CF}`, body: { token: "cf-rotated" }, http: [CF_VERIFY(), CF_ZONE_PROBE(), CF_RECORDS(), CF_ZONES(1, [cfZone("zone-com", "EXAMPLE.com", { id: "acc-1", name: "Renamed Account" }), cfZone("zone-io", "example.io")])], after: IT_AFTER });
add({ name: "integration tokens: update, a new cloudflare token, a zone with a managed record kept", token: "write", method: "PATCH", path: `${IT}/${IT_CF}`, body: { token: "cf-rotated" }, ...WITH_RECORD(2), http: [CF_VERIFY(), CF_ZONE_PROBE(), CF_RECORDS(), CF_ZONES(1, [cfZone("zone-com", "example.com")])], after: IT_AFTER });
add({ name: "integration tokens: update, the tunnel capability", token: "write", method: "PATCH", path: `${IT}/${IT_CF}`, body: { capabilities: ["dns", "tunnel"] }, http: [CF_VERIFY(), CF_ZONE_PROBE(), CF_RECORDS(), CF_TUNNELS(), CF_ZONES(1, [cfZone("zone-com", "example.com")])], after: IT_AFTER });
add({ name: "integration tokens: update, the capabilities in another order", token: "write", method: "PATCH", path: `${IT}/${IT_CF_TUNNEL}`, body: { capabilities: ["tunnel", "dns"] }, http: [], after: IT_AFTER });
add({ name: "integration tokens: update, the new cloudflare token refused", token: "write", method: "PATCH", path: `${IT}/${IT_CF}`, body: { token: "cf-bad", name: "Never saved" }, http: [CF_VERIFY("expired")], after: IT_AFTER });
add({ name: "integration tokens: update, the zones refused", token: "write", method: "PATCH", path: `${IT}/${IT_CF}`, body: { token: "cf-rotated", name: "Never saved" }, http: [CF_VERIFY(), CF_ZONE_PROBE(), CF_RECORDS(), CF_ZONES(1, [], 1, 403)], after: IT_AFTER });
add({ name: "integration tokens: update, Cloudflare unreachable", token: "write", method: "PATCH", path: `${IT}/${IT_CF}`, body: { token: "cf-rotated" }, http: [CF_VERIFY(), FAILED(`^GET ${CF}/zones\\?per_page=1$`)], after: IT_AFTER });
add({ name: "integration tokens: update a cloudflare token, invalid", token: "write", method: "PATCH", path: `${IT}/${IT_CF}`, body: { name: 7, capabilities: ["tunnel"], metadata: { a: 1 }, automatic_dns: "x", provider: "doppler" }, http: [] });
add({ name: "integration tokens: update a cloudflare token, no capabilities", token: "write", method: "PATCH", path: `${IT}/${IT_CF}`, body: { capabilities: [], name: "" }, http: [] });
add({ name: "integration tokens: update a doppler token, a new name", token: "write", method: "PATCH", path: `${IT}/${IT_DOPPLER}`, body: { name: "Renamed Doppler", metadata: {} }, http: [], after: IT_AFTER });
add({ name: "integration tokens: update a doppler token, a new token", token: "write", method: "PATCH", path: `${IT}/${IT_DOPPLER}`, body: { token: "dp.sa.rotated" }, http: [DOPPLER_ME()], after: IT_AFTER });
add({ name: "integration tokens: update a doppler token, not a service token", token: "write", method: "PATCH", path: `${IT}/${IT_DOPPLER}`, body: { token: "dp.pt.personal", automatic_dns: true }, http: [] });
add({ name: "integration tokens: update an infisical token, the base URL without the secret", token: "write", method: "PATCH", path: `${IT}/${IT_INFISICAL}`, body: { metadata: { base_url: "https://infisical.example.com" } }, http: [], after: IT_AFTER });
add({ name: "integration tokens: update an infisical token, the base URL with the secret", token: "write", method: "PATCH", path: `${IT}/${IT_INFISICAL}`, body: { token: "inf-rotated", metadata: { base_url: "https://infisical.example.com" } }, http: [INFISICAL_LOGIN("https://infisical\\.example\\.com")], after: IT_AFTER });
add({ name: "integration tokens: update an infisical token, a timeout", token: "write", method: "PATCH", path: `${IT}/${IT_INFISICAL}`, body: { metadata: { timeout: 45 } }, http: [INFISICAL_LOGIN()], after: IT_AFTER });
add({ name: "integration tokens: update an infisical token, the timeout removed", token: "write", method: "PATCH", path: `${IT}/${IT_INFISICAL}`, body: { metadata: { timeout: "" } }, http: [], after: IT_AFTER });
add({ name: "integration tokens: update an infisical token, the client ID removed", token: "write", method: "PATCH", path: `${IT}/${IT_INFISICAL}`, body: { metadata: { client_id: "" } }, http: [] });
add({ name: "integration tokens: update an infisical token, the login refused", token: "write", method: "PATCH", path: `${IT}/${IT_INFISICAL}`, body: { metadata: { timeout: 5 } }, http: [INFISICAL_LOGIN("https://app\\.infisical\\.com", 401)], after: IT_AFTER });
add({ name: "integration tokens: update a vault token, the namespace without the token", token: "write", method: "PATCH", path: `${IT}/${IT_VAULT}`, body: { metadata: { namespace: "admin/team-b" } }, http: [] });
add({ name: "integration tokens: update a vault token, a private address", token: "write", method: "PATCH", path: `${IT}/${IT_VAULT}`, body: { token: "hvs.rotated", metadata: { base_url: "https://private.example" } }, http: [], after: IT_AFTER });
add({ name: "integration tokens: update a vault token, a new token", token: "write", method: "PATCH", path: `${IT}/${IT_VAULT}`, body: { token: "hvs.rotated", name: "Rotated Vault" }, http: [VAULT_LOOKUP()], after: IT_AFTER });
add({ name: "integration tokens: update a vault token, the namespace removed", token: "write", method: "PATCH", path: `${IT}/${IT_VAULT}`, body: { token: "hvs.rotated", metadata: { namespace: null } }, http: [VAULT_LOOKUP()], after: IT_AFTER });
add({ name: "integration tokens: update, not JSON", token: "write", method: "PATCH", path: `${IT}/${IT_CF}`, raw: "name=x", contentType: "application/x-www-form-urlencoded", http: [] });
add({ name: "integration tokens: update, empty JSON", token: "write", method: "PATCH", path: `${IT}/${IT_CF}`, raw: "{}", http: [] });
add({ name: "integration tokens: update unknown", token: "write", method: "PATCH", path: `${IT}/nonexistentuuid`, body: { name: "x" }, http: [] });
add({ name: "integration tokens: update another team's", token: "write", method: "PATCH", path: `${IT}/${IT_OTHER}`, body: { name: "x" }, http: [] });

// delete
add({ name: "integration tokens: delete a doppler token", token: "delete", method: "DELETE", path: `${IT}/${IT_DOPPLER}`, after: IT_AFTER });
add({ name: "integration tokens: delete a cloudflare token and its zones", token: "delete", method: "DELETE", path: `${IT}/${IT_CF}`, after: IT_AFTER });
add({ name: "integration tokens: delete, a secret manager source", token: "delete", method: "DELETE", path: `${IT}/${IT_DOPPLER}`, ...WITH_LINK, after: IT_AFTER });
add({ name: "integration tokens: delete, it manages DNS records", token: "delete", method: "DELETE", path: `${IT}/${IT_CF}`, ...WITH_RECORD(), after: IT_AFTER });
add({ name: "integration tokens: delete unknown", token: "delete", method: "DELETE", path: `${IT}/nonexistentuuid` });
add({ name: "integration tokens: delete another team's", token: "delete", method: "DELETE", path: `${IT}/${IT_OTHER}` });
add({ name: "integration tokens: delete with a write token", token: "write", method: "DELETE", path: `${IT}/${IT_DOPPLER}` });

// sync zones
const SZ = (uuid) => `${IT}/${uuid}/sync-zones`;
add({ name: "integration tokens: sync zones", token: "write", method: "POST", path: SZ(IT_CF), http: [CF_ZONES(1, [cfZone("zone-com", "example.com"), cfZone("zone-dev", "Example.DEV", { id: "acc-3", name: "Dev" })])], after: IT_AFTER });
add({ name: "integration tokens: sync zones, a zone with a managed record kept", token: "write", method: "POST", path: SZ(IT_CF), ...WITH_RECORD(2), http: [CF_ZONES(1, [])], after: IT_AFTER });
add({ name: "integration tokens: sync zones, three pages", token: "write", method: "POST", path: SZ(IT_CF_TUNNEL), http: [CF_ZONES(1, [cfZone("zone-net", "example.net")], 3), CF_ZONES(2, [cfZone("zone-p2", "p2.example")], 3), CF_ZONES(3, [cfZone("zone-p3", "p3.example")], 3)], after: IT_AFTER });
add({ name: "integration tokens: sync zones, refused", token: "write", method: "POST", path: SZ(IT_CF), http: [CF_ZONES(1, [], 1, 403)], after: IT_AFTER });
add({ name: "integration tokens: sync zones, Cloudflare fails", token: "write", method: "POST", path: SZ(IT_CF), http: [CF_ZONES(1, [], 1, 500)], after: IT_AFTER });
add({ name: "integration tokens: sync zones, Cloudflare unreachable", token: "write", method: "POST", path: SZ(IT_CF), http: [FAILED(`^GET ${CF}/zones`)], after: IT_AFTER });
add({ name: "integration tokens: sync zones of a doppler token", token: "write", method: "POST", path: SZ(IT_DOPPLER), http: [] });
add({ name: "integration tokens: sync zones, unknown", token: "write", method: "POST", path: SZ("nonexistentuuid"), http: [] });
add({ name: "integration tokens: sync zones, another team's", token: "write", method: "POST", path: SZ(IT_OTHER), http: [] });
add({ name: "integration tokens: sync zones with a read token", token: "read", method: "POST", path: SZ(IT_CF), http: [] });
add({ name: "integration tokens: GET sync zones", token: "write", method: "GET", path: SZ(IT_CF) });

// a member with write and delete levels: IntegrationTokenPolicy wants a team admin
denial("integration tokens: create a doppler token", "memberWrite", WRITE_DELETE, WRITER);
denial("integration tokens: update, a new name", "memberWrite", WRITE_DELETE, WRITER);
denial("integration tokens: delete a doppler token", "memberDelete", WRITE_DELETE, WRITER);
denial("integration tokens: sync zones", "memberWrite", WRITE_DELETE, WRITER);
denial("integration tokens: list", "memberWrite", WRITE_DELETE, WRITER);
// ── DP-103: GitLab Apps, Gitea Apps and POST /applications/private-gitea-app ──────────────────────────────────────
// Freeploy is a hosted service: the cases run as Coolify Cloud (no system-wide source, private networks refused). The
// fixture's sources are made through the models (encrypted secrets); a source a case makes is the one whose uuid is not
// the fixture's.
const GL = "/api/v1/gitlab-apps";
const GL_APP = (id) => `${GL}/${id}`;
const GL_AFTER = { apps: `select case when uuid like 'y%' then id end as fixture_id, name, organization, api_url, html_url, custom_user, custom_port, group_name, client_id, client_secret is not null as has_client_secret, webhook_token is not null as has_webhook_token, access_token is not null as has_access_token, refresh_token is not null as has_refresh_token, expires_at, redirect_uri, private_key_id, is_system_wide, is_public from gitlab_apps where uuid <> '${GL_OTHER}' order by fixture_id nulls last, name` };
const GL_CREATE = { name: "New GitLab", html_url: "https://gitlab.acme.test/", group_name: "acme,acme/platform", client_id: "gl-new-client", client_secret: "gl-new-secret", redirect_uri: "https://app.example.test/webhooks/source/gitlab/redirect" };
add({ name: "gitlab apps: list", token: "read", method: "GET", path: GL, config: CLOUD });
add({ name: "gitlab apps: list, read:sensitive", token: "sensitive", method: "GET", path: GL, config: CLOUD });
add({ name: "gitlab apps: list by a member", token: "memberRead", method: "GET", path: GL, config: CLOUD });
add({ name: "gitlab apps: list, a member with read:sensitive", token: "memberSensitive", method: "GET", path: GL, config: CLOUD });
add({ name: "gitlab apps: list, none", token: "read", method: "GET", path: GL, config: CLOUD, setup: ["delete from gitlab_apps where id in (1, 2)"] });
add({ name: "gitlab apps: create", token: "write", method: "POST", path: GL, config: CLOUD, body: GL_CREATE, after: GL_AFTER });
add({ name: "gitlab apps: create, the defaults", token: "write", method: "POST", path: GL, config: CLOUD, body: { name: "Plain GitLab", html_url: "https://gitlab.com" }, after: GL_AFTER });
add({ name: "gitlab apps: create, every field, read:sensitive", token: "root", method: "POST", path: GL, config: CLOUD, body: { ...GL_CREATE, api_url: "https://gitlab.acme.test/api/v4/", custom_user: "deploy", custom_port: "2222", webhook_token: "gl-given-webhook-token", is_system_wide: true }, after: GL_AFTER });
add({ name: "gitlab apps: create, invalid", token: "write", method: "POST", path: GL, config: CLOUD, body: { name: "", html_url: "ftp://x", api_url: "nope", custom_user: 5, custom_port: 70000, group_name: ["x"], client_id: 5, client_secret: 5, webhook_token: 5, redirect_uri: "nope", is_system_wide: "maybe", extra: 1 } });
add({ name: "gitlab apps: create, a private host", token: "write", method: "POST", path: GL, config: CLOUD, body: { ...GL_CREATE, html_url: "https://private.example" } });
add({ name: "gitlab apps: create, a private API URL and a private redirect", token: "write", method: "POST", path: GL, config: CLOUD, body: { ...GL_CREATE, api_url: "http://10.0.0.8/api/v4", redirect_uri: "http://10.0.0.9/webhooks/source/gitlab/redirect" }, after: GL_AFTER });
add({ name: "gitlab apps: create, not JSON", token: "write", method: "POST", path: GL, config: CLOUD, raw: "name=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "gitlab apps: create, empty JSON", token: "write", method: "POST", path: GL, config: CLOUD, raw: "{}" });
add({ name: "gitlab apps: create with a read token", token: "read", method: "POST", path: GL, config: CLOUD, body: GL_CREATE });
add({ name: "gitlab apps: update", token: "write", method: "PATCH", path: GL_APP(1), config: CLOUD, body: { name: "Renamed GitLab", group_name: null, custom_port: "2200", client_secret: "gl-secret-2", webhook_token: "gl-webhook-token-new", redirect_uri: "https://app.example.test/webhooks/source/gitlab/redirect" }, after: GL_AFTER });
add({ name: "gitlab apps: update the HTML URL", token: "write", method: "PATCH", path: GL_APP(2), config: CLOUD, body: { html_url: "https://git.acme.test/" }, after: GL_AFTER });
add({ name: "gitlab apps: update the HTML and API URLs", token: "write", method: "PATCH", path: GL_APP(2), config: CLOUD, body: { html_url: "https://git.acme.test", api_url: "https://git.acme.test/api/v4/" }, after: GL_AFTER });
add({ name: "gitlab apps: update, nothing", token: "write", method: "PATCH", path: GL_APP(1), config: CLOUD, body: { is_system_wide: true, other: 1 }, after: GL_AFTER });
add({ name: "gitlab apps: update, clearing the secrets, read:sensitive", token: "root", method: "PATCH", path: GL_APP(1), config: CLOUD, body: { client_id: null, client_secret: null, webhook_token: null }, after: GL_AFTER });
add({ name: "gitlab apps: update, invalid", token: "write", method: "PATCH", path: GL_APP(1), config: CLOUD, body: { name: 5, html_url: "nope", api_url: "ftp://x", custom_user: [], custom_port: 0, group_name: 7, client_id: ["x"], client_secret: 5, redirect_uri: "x" } });
add({ name: "gitlab apps: update, a private host", token: "write", method: "PATCH", path: GL_APP(1), config: CLOUD, body: { api_url: "http://10.0.0.8/api/v4" } });
add({ name: "gitlab apps: update unknown", token: "write", method: "PATCH", path: GL_APP(99), config: CLOUD, body: { name: "x" } });
add({ name: "gitlab apps: update another team's", token: "write", method: "PATCH", path: GL_APP(3), config: CLOUD, body: { name: "x" } });
add({ name: "gitlab apps: update with a read token", token: "read", method: "PATCH", path: GL_APP(1), config: CLOUD, body: { name: "x" } });
add({ name: "gitlab apps: delete", token: "delete", method: "DELETE", path: GL_APP(2), config: CLOUD, after: GL_AFTER });
add({ name: "gitlab apps: delete, in use", token: "delete", method: "DELETE", path: GL_APP(2), config: CLOUD, setup: ["update applications set source_type = 'App\\Models\\GitlabApp', source_id = 2 where id = 2"], after: GL_AFTER });
add({ name: "gitlab apps: delete unknown", token: "delete", method: "DELETE", path: GL_APP(99), config: CLOUD });
add({ name: "gitlab apps: delete another team's", token: "delete", method: "DELETE", path: GL_APP(3), config: CLOUD });
add({ name: "gitlab apps: delete with a write token", token: "write", method: "DELETE", path: GL_APP(2), config: CLOUD });

const GT = "/api/v1/gitea-apps";
add({ name: "gitea apps: list", token: "read", method: "GET", path: GT, config: CLOUD });
add({ name: "gitea apps: list, read:sensitive", token: "sensitive", method: "GET", path: GT, config: CLOUD });
add({ name: "gitea apps: list by a member", token: "memberRead", method: "GET", path: GT, config: CLOUD });
add({ name: "gitea apps: list, none", token: "read", method: "GET", path: GT, config: CLOUD, setup: ["delete from gitea_apps where id in (1, 2)"] });
add({ name: "gitea apps: list with a write-only token", token: "writeOnly", method: "GET", path: GT, config: CLOUD });

// POST /applications/private-gitea-app: create_application($request, 'private-gitea-app'). The Gitea instance is faked
// (`http`): the repository, and the token's refresh where a case lets the fixture's token expire.
const GTA = CREATE("private-gitea-app");
const GTA_REPO = { ...IMAGE_ON, gitea_app_uuid: GT_MAIN, git_repository: "acme/private", git_branch: "main", build_pack: "nixpacks", ports_exposes: "3000" };
const GITEA_REPO_URL = (slug) => `^GET https://gitea\\.com/api/v1/repos/${slug.replace(/\./g, "\\.")}$`;
const giteaRepo = (owner, name) => ({ id: 5151, owner: { id: 9, login: owner, full_name: "" }, name, full_name: `${owner}/${name}`, private: true, html_url: `https://gitea.com/${owner}/${name}`, default_branch: "main" });
const GITEA_REPO_OK = (owner = "acme", name = "private", slug = `${owner}/${name}`) => answer(GITEA_REPO_URL(slug), giteaRepo(owner, name));
const GITEA_TOKEN_URL = "^POST https://gitea\\.com/login/oauth/access_token$";
const GITEA_EXPIRED = ["update gitea_apps set expires_at = 1767225000 where id = 1"];
// A refreshed token expires an hour after time() — the real clock on Coolify's side, emit.php's on Freeploy's: read as later.
const GITEA_AFTER = { source: "select access_token is not null as has_access_token, refresh_token is not null as has_refresh_token, expires_at > 1767225000 as expires_later from gitea_apps where id = 1" };
add({ name: "gitea app create: a Gitea App", token: "write", method: "POST", path: GTA, body: GTA_REPO, http: [GITEA_REPO_OK()], after: CREATED_AFTER });
add({ name: "gitea app create: a Gitea App, a repository URL", token: "write", method: "POST", path: GTA, body: { ...GTA_REPO, git_repository: "https://gitea.com/acme/private.git", build_pack: "dockerfile", name: "from-gitea", domains: "https://gt.acme.test" }, http: [GITEA_REPO_OK()], after: CREATED_AFTER });
add({ name: "gitea app create: a Gitea App, an SSH URL", token: "write", method: "POST", path: GTA, body: { ...GTA_REPO, git_repository: "git@gitea.com:acme/private.git", build_pack: "static", is_static: true }, http: [GITEA_REPO_OK()], after: CREATED_AFTER });
add({ name: "gitea app create: a Gitea App, an owner of the organization field", token: "write", method: "POST", path: GTA, body: { ...GTA_REPO, git_repository: "PARITY/tools" }, http: [GITEA_REPO_OK("parity", "tools", "PARITY/tools")], after: CREATED_AFTER });
add({ name: "gitea app create: a Gitea App, another owner", token: "write", method: "POST", path: GTA, body: { ...GTA_REPO, git_repository: "someone/private" }, http: [GITEA_REPO_OK("someone", "private")], after: NOTHING_CREATED });
add({ name: "gitea app create: a Gitea App, another host's URL", token: "write", method: "POST", path: GTA, body: { ...GTA_REPO, git_repository: "https://github.com/acme/private" }, http: [GITEA_REPO_OK()], after: NOTHING_CREATED });
add({ name: "gitea app create: a Gitea App, not a repository path", token: "write", method: "POST", path: GTA, body: { ...GTA_REPO, git_repository: "acme/.." }, http: [GITEA_REPO_OK()], after: NOTHING_CREATED });
add({ name: "gitea app create: a Gitea App, the repository not accessible", token: "write", method: "POST", path: GTA, body: GTA_REPO, http: [answer(GITEA_REPO_URL("acme/private"), { message: "Not Found" }, 404)], after: NOTHING_CREATED });
add({ name: "gitea app create: a Gitea App, the instance fails", token: "write", method: "POST", path: GTA, body: GTA_REPO, http: [answer(GITEA_REPO_URL("acme/private"), { message: "Unavailable" }, 503)], after: NOTHING_CREATED });
add({ name: "gitea app create: a Gitea App, a failure without a message", token: "write", method: "POST", path: GTA, body: GTA_REPO, http: [answer(GITEA_REPO_URL("acme/private"), { error: "nope" }, 500)], after: NOTHING_CREATED });
add({ name: "gitea app create: a Gitea App, the token refreshed", token: "write", method: "POST", path: GTA, setup: GITEA_EXPIRED, body: GTA_REPO, http: [answer(GITEA_TOKEN_URL, { access_token: "gt-access-new", token_type: "bearer", expires_in: 3600, refresh_token: "gt-refresh-new" }), GITEA_REPO_OK()], after: { ...CREATED_AFTER, ...GITEA_AFTER } });
add({ name: "gitea app create: a Gitea App, the refresh refused", token: "write", method: "POST", path: GTA, setup: GITEA_EXPIRED, body: GTA_REPO, http: [answer(GITEA_TOKEN_URL, { error: "invalid_grant", error_description: "The refresh token is invalid." }, 400), GITEA_REPO_OK()], after: { ...NOTHING_CREATED, ...GITEA_AFTER } });
add({ name: "gitea app create: a Gitea App, a source not connected", token: "write", method: "POST", path: GTA, body: { ...GTA_REPO, gitea_app_uuid: GT_CODEBERG }, http: [GITEA_REPO_OK()] });
add({ name: "gitea app create: a Gitea App, another team's source", token: "write", method: "POST", path: GTA, body: { ...GTA_REPO, gitea_app_uuid: GT_OTHER }, http: [GITEA_REPO_OK()] });
add({ name: "gitea app create: a Gitea App, unknown source", token: "write", method: "POST", path: GTA, body: { ...GTA_REPO, gitea_app_uuid: "nonexistentuuid" }, http: [GITEA_REPO_OK()] });
add({ name: "gitea app create: a Gitea App, invalid", token: "write", method: "POST", path: GTA, body: { ...IMAGE_ON, git_repository: 5, git_branch: "a..b", build_pack: "heroku", ports_exposes: "80,x", watch_paths: [], docker_compose_domains: "x" }, http: [GITEA_REPO_OK()] });
add({ name: "gitea app create: a Gitea App, a domain in use", token: "write", method: "POST", path: GTA, body: { ...GTA_REPO, domains: "https://image.example.com" }, http: [GITEA_REPO_OK()] });
add({ name: "gitea app create: a Gitea App, Docker Compose", token: "write", method: "POST", path: GTA, body: { ...GTA_REPO, build_pack: "dockercompose", docker_compose_location: "/compose.yaml" }, http: [GITEA_REPO_OK()], after: NOTHING_CREATED });
add({ name: "gitea app create: a Gitea App, instant deploy", token: "root", method: "POST", path: GTA, body: { ...GTA_REPO, instant_deploy: true }, http: [GITEA_REPO_OK()], after: NOTHING_CREATED });
add({ name: "gitea app create: a Gitea App, with a read token", token: "read", method: "POST", path: GTA, body: GTA_REPO, http: [GITEA_REPO_OK()] });
add({ name: "gitea app create: a Gitea App, a member", token: "memberWrite", method: "POST", path: GTA, body: GTA_REPO, http: [GITEA_REPO_OK()] });
// PATCH /applications/{uuid} with gitea_app_uuid: the source changed, the repository checked with the instance.
const GITEA_UPDATE_AFTER = { application: "select git_repository, source_type, source_id, repository_project_id from applications where id = 2" };
add({ name: "gitea app update: a Gitea App as the source", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { gitea_app_uuid: GT_MAIN, git_repository: "https://gitea.com/acme/private.git" }, http: [GITEA_REPO_OK()], after: GITEA_UPDATE_AFTER });
add({ name: "gitea app update: a Gitea App, the application's repository", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), setup: ["update applications set git_repository = 'acme/private' where id = 2"], body: { gitea_app_uuid: GT_MAIN }, http: [GITEA_REPO_OK()], after: GITEA_UPDATE_AFTER });
add({ name: "gitea app update: a Gitea App, the repository not accessible", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { gitea_app_uuid: GT_MAIN, git_repository: "acme/private" }, http: [answer(GITEA_REPO_URL("acme/private"), { message: "Not Found" }, 404)], after: GITEA_UPDATE_AFTER });
add({ name: "gitea app update: a Gitea App, not on its instance", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { gitea_app_uuid: GT_MAIN }, http: [GITEA_REPO_OK()], after: GITEA_UPDATE_AFTER });
add({ name: "gitea app update: a Gitea App not connected", token: "write", method: "PATCH", path: PATCH_APP(A_GIT), body: { gitea_app_uuid: GT_CODEBERG, git_repository: "acme/private" }, http: [GITEA_REPO_OK()] });
add({ name: "gitea app update: a Gitea App for an image application", token: "write", method: "PATCH", path: PATCH_APP(A_IMAGE), body: { gitea_app_uuid: GT_MAIN }, http: [GITEA_REPO_OK()] });
denial("gitlab apps: create", "memberWrite", WRITE_DELETE, WRITER);
denial("gitlab apps: update", "memberWrite", WRITE_DELETE, WRITER);
denial("gitlab apps: delete", "memberDelete", WRITE_DELETE, WRITER);

// ── DP-106: a resource's secret manager source (SecretManagerController) ────
// The source of an application, a service or a database: a link to a Doppler, Infisical or Vault token of the team
// (secret_manager_links: Coolify's has no team, Freeploy's has org_id), its settings, the key names of its secrets and the
// {{vault.KEY}} variables made from them. The secret managers' APIs are Http::fake() (`http`). A link of a case is a row of
// `setupCoolify` and `setupFreeploy`; `tokenSecrets` replaces a token's secret through the model (a Doppler service
// account, `dp.sa.`, which the fixture has none of).
const SM_TYPES = { applications: "Application", services: "Service", databases: "StandalonePostgresql" };
const SM_PATH = (type, uuid, sub = "") => `/api/v1/${type}/${uuid}/secret-manager${sub}`;
const SM_LINK = (tenancy, { uuid, model, id, token, settings = null }) =>
  `insert into secret_manager_links (uuid, resourceable_type, resourceable_id, integration_token_id, settings, ${tenancy ? `${tenancy[0]}, ` : ""}created_at, updated_at) values ('${uuid}', 'App\\Models\\${model}', ${id}, ${token}, ${settings === null ? "null" : `'${JSON.stringify(settings)}'`}, ${tenancy ? `${tenancy[1]}, ` : ""}'2025-12-30 00:00:00', '2025-12-30 00:00:00')`;
const DOPPLER_LINK = { uuid: "u1paritydopplerlink00001", model: "Application", id: 1, token: 3 };
const INFISICAL_SETTINGS = { project_id: "proj-1", environment: "prod", secret_path: "/app" };
const INFISICAL_LINK = { uuid: "u2parityinfisicallink002", model: "Service", id: 1, token: 4, settings: INFISICAL_SETTINGS };
const VAULT_SETTINGS = { mount: "secret", path: "apps/web" };
const VAULT_LINK = { uuid: "u3parityvaultlink0000003", model: "StandalonePostgresql", id: 1, token: 5, settings: VAULT_SETTINGS };
const LINKED = (...links) => ({ setupCoolify: links.map((l) => SM_LINK(null, l)), setupFreeploy: links.map((l) => SM_LINK(FREEPLOY_TENANCY, l)) });
const DOPPLER_ACCOUNT = { tokenSecrets: [{ id: 3, token: "dp.sa.team1account" }] };
const SM_LINKS_AFTER = {
  links: "select resourceable_type, resourceable_id, integration_token_id, settings::jsonb::text as settings, uuid like 'u_parity%' as fixture_link, updated_at = '2025-12-30 00:00:00' as untouched from secret_manager_links order by resourceable_type, resourceable_id",
};
const SM_VARS_AFTER = (model, id) => ({
  variables: `select key, is_preview, is_literal, is_multiline, is_shown_once, is_runtime, is_buildtime, is_required, is_shared, comment, "order", version, value is not null as has_value from environment_variables where resourceable_type = 'App\\Models\\${model}' and resourceable_id = ${id} order by id`,
});
const DOPPLER_DOWNLOAD = (query = "format=json", body = { API_KEY: "a", DATABASE_URL: "postgres://x", FOO: "bar", "db-password": "p", "10": "ten", "9": "nine", B_KEY: "b" }, status = 200) =>
  answer(`^GET https://api\\.doppler\\.com/v3/configs/config/secrets/download\\?${query.replace(/\./g, "\\.")}$`, body, status);
const INF = "https://app\\.infisical\\.com";
const INF_SECRETS_V4 = (body = { secrets: [{ secretKey: "API_KEY", secretValue: "a" }, { secretKey: "SHARED", secretValue: "own" }], imports: [{ secretPath: "/shared", environment: "prod", secrets: [{ secretKey: "SHARED", secretValue: "imported" }, { secretKey: "IMPORTED_KEY", secretValue: "i" }] }] }, status = 200) =>
  answer(`^GET ${INF}/api/v4/secrets\\?`, body, status);
const INF_SECRETS_V3 = (body = { secrets: [{ secretKey: "LEGACY_KEY", secretValue: "l" }] }, status = 200) => answer(`^GET ${INF}/api/v3/secrets/raw\\?`, body, status);
const VAULT_BASE = "https://vault\\.example\\.com:8200";
const VAULT_READ = (path = "secret/data/apps/web", body = { data: { data: { API_KEY: "v", PORT: 5432, NESTED: { a: 1 }, "bad key": "x" }, metadata: { version: 3 } } }, status = 200) =>
  answer(`^GET ${VAULT_BASE}/v1/${path}$`, body, status);

// GET: the source and the tokens that can be linked
add({ name: "secret manager: show, an application without a source", token: "read", method: "GET", path: SM_PATH("applications", A_IMAGE) });
add({ name: "secret manager: show, an application's Doppler source", token: "read", method: "GET", path: SM_PATH("applications", A_IMAGE), ...LINKED(DOPPLER_LINK) });
add({ name: "secret manager: show, a service's Infisical source", token: "sensitive", method: "GET", path: SM_PATH("services", SV_MAIN), ...LINKED(INFISICAL_LINK) });
add({ name: "secret manager: show, a database's Vault source", token: "read", method: "GET", path: SM_PATH("databases", DB_PG), ...LINKED(VAULT_LINK) });
add({ name: "secret manager: show, a redis database", token: "read", method: "GET", path: SM_PATH("databases", DB_REDIS) });
add({ name: "secret manager: show by a member, the linked token only", token: "memberRead", method: "GET", path: SM_PATH("applications", A_IMAGE), ...LINKED(DOPPLER_LINK) });
add({ name: "secret manager: show by a member, no source", token: "memberRead", method: "GET", path: SM_PATH("services", SV_MAIN) });
add({ name: "secret manager: show, a token without the secrets capability", token: "read", method: "GET", path: SM_PATH("applications", A_GIT), setup: ["update integration_tokens set capabilities = '[]' where id = 4"] });
add({ name: "secret manager: show, unknown application", token: "read", method: "GET", path: SM_PATH("applications", "nonexistentuuid") });
add({ name: "secret manager: show, another team's application", token: "read", method: "GET", path: SM_PATH("applications", A_OTHER) });
add({ name: "secret manager: show, unknown service", token: "read", method: "GET", path: SM_PATH("services", "nonexistentuuid") });
add({ name: "secret manager: show, another team's database", token: "read", method: "GET", path: SM_PATH("databases", DB_OTHER) });
add({ name: "secret manager: show, not a resource type", token: "read", method: "GET", path: SM_PATH("servers", S_MAIN) });
add({ name: "secret manager: show with a write-only token", token: "writeOnly", method: "GET", path: SM_PATH("applications", A_IMAGE) });

// PATCH: link a token, or change the link's token or settings
const SET = (type, uuid) => ({ method: "PATCH", path: SM_PATH(type, uuid) });
add({ name: "secret manager: set, a Doppler service token", token: "write", ...SET("applications", A_IMAGE), body: { integration_token_uuid: IT_DOPPLER }, after: SM_LINKS_AFTER });
add({ name: "secret manager: set, a Doppler service token ignores the settings", token: "write", ...SET("applications", A_IMAGE), body: { integration_token_uuid: IT_DOPPLER, settings: { project: "web", config: "prd" } }, after: SM_LINKS_AFTER });
add({ name: "secret manager: set, a Doppler service account without settings", token: "write", ...SET("applications", A_IMAGE), ...DOPPLER_ACCOUNT, body: { integration_token_uuid: IT_DOPPLER }, after: SM_LINKS_AFTER });
add({ name: "secret manager: set, a Doppler service account", token: "write", ...SET("applications", A_GIT), ...DOPPLER_ACCOUNT, body: { integration_token_uuid: IT_DOPPLER, settings: { config: "prd", project: "web", extra: "dropped" } }, after: SM_LINKS_AFTER });
add({ name: "secret manager: set, an Infisical token for a service", token: "write", ...SET("services", SV_MAIN), body: { integration_token_uuid: IT_INFISICAL, settings: INFISICAL_SETTINGS }, after: SM_LINKS_AFTER });
add({ name: "secret manager: set, an Infisical token without a secret path", token: "write", ...SET("services", SV_MAIN), body: { integration_token_uuid: IT_INFISICAL, settings: { environment: "dev", project_id: "proj-2", secret_path: "" } }, after: SM_LINKS_AFTER });
add({ name: "secret manager: set, an Infisical token without settings", token: "write", ...SET("services", SV_MAIN), body: { integration_token_uuid: IT_INFISICAL }, after: SM_LINKS_AFTER });
add({ name: "secret manager: set, an Infisical token, invalid settings", token: "write", ...SET("services", SV_MAIN), body: { integration_token_uuid: IT_INFISICAL, settings: { project_id: 7, environment: ["prod"], secret_path: 5 } } });
add({ name: "secret manager: set, a Vault token for a database", token: "write", ...SET("databases", DB_PG), body: { integration_token_uuid: IT_VAULT, settings: VAULT_SETTINGS }, after: SM_LINKS_AFTER });
add({ name: "secret manager: set, a Vault token for a redis database", token: "root", ...SET("databases", DB_REDIS), body: { integration_token_uuid: IT_VAULT, settings: { path: "cache", mount: "kv" } }, after: SM_LINKS_AFTER });
add({ name: "secret manager: set, a Vault token, invalid settings", token: "write", ...SET("databases", DB_PG), body: { integration_token_uuid: IT_VAULT, settings: { mount: "" } } });
add({ name: "secret manager: set, another token for a linked application", token: "write", ...SET("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), body: { integration_token_uuid: IT_VAULT, settings: { mount: "secret", path: "apps/image" } }, after: SM_LINKS_AFTER });
add({ name: "secret manager: set, the link as it is", token: "write", ...SET("services", SV_MAIN), ...LINKED(INFISICAL_LINK), body: { integration_token_uuid: IT_INFISICAL, settings: INFISICAL_SETTINGS }, after: SM_LINKS_AFTER });
add({ name: "secret manager: set, other settings of the link", token: "write", ...SET("services", SV_MAIN), ...LINKED(INFISICAL_LINK), body: { integration_token_uuid: IT_INFISICAL, settings: { project_id: "proj-1", environment: "staging" } }, after: SM_LINKS_AFTER });
add({ name: "secret manager: set, unknown token", token: "write", ...SET("applications", A_IMAGE), body: { integration_token_uuid: "nonexistentuuid" } });
add({ name: "secret manager: set, a Cloudflare token", token: "write", ...SET("applications", A_IMAGE), body: { integration_token_uuid: IT_CF } });
add({ name: "secret manager: set, another team's token", token: "write", ...SET("applications", A_IMAGE), body: { integration_token_uuid: IT_OTHER } });
add({ name: "secret manager: set, a token without the secrets capability", token: "write", ...SET("applications", A_IMAGE), setup: ["update integration_tokens set capabilities = '[]' where id = 3"], body: { integration_token_uuid: IT_DOPPLER } });
add({ name: "secret manager: set, a token uuid that is not a string", token: "write", ...SET("applications", A_IMAGE), body: { integration_token_uuid: 3 } });
add({ name: "secret manager: set, no token", token: "write", ...SET("applications", A_IMAGE), body: { settings: { project: "web" } } });
add({ name: "secret manager: set, a field that is not allowed", token: "write", ...SET("applications", A_IMAGE), body: { integration_token_uuid: IT_DOPPLER, provider: "doppler", name: "x" }, after: SM_LINKS_AFTER });
add({ name: "secret manager: set, settings that are not an object", token: "write", ...SET("applications", A_IMAGE), body: { integration_token_uuid: IT_DOPPLER, settings: "web/prd" } });
add({ name: "secret manager: set, not JSON", token: "write", ...SET("applications", A_IMAGE), raw: `integration_token_uuid=${IT_DOPPLER}`, contentType: "application/x-www-form-urlencoded" });
add({ name: "secret manager: set, empty JSON", token: "write", ...SET("applications", A_IMAGE), raw: "{}" });
add({ name: "secret manager: set, unknown application", token: "write", ...SET("applications", "nonexistentuuid"), raw: "not json", contentType: "text/plain" });
add({ name: "secret manager: set, unknown database", token: "write", ...SET("databases", "nonexistentuuid"), body: { integration_token_uuid: IT_VAULT } });
add({ name: "secret manager: set with a read token", token: "read", ...SET("applications", A_IMAGE), body: { integration_token_uuid: IT_DOPPLER } });

// DELETE: remove the source
const REMOVE = (type, uuid) => ({ method: "DELETE", path: SM_PATH(type, uuid) });
add({ name: "secret manager: remove, an application's source", token: "delete", ...REMOVE("applications", A_IMAGE), ...LINKED(DOPPLER_LINK, INFISICAL_LINK), after: SM_LINKS_AFTER });
add({ name: "secret manager: remove, a service's source", token: "delete", ...REMOVE("services", SV_MAIN), ...LINKED(INFISICAL_LINK), after: SM_LINKS_AFTER });
add({ name: "secret manager: remove, a database's source", token: "root", ...REMOVE("databases", DB_PG), ...LINKED(VAULT_LINK), after: SM_LINKS_AFTER });
add({ name: "secret manager: remove, no source", token: "delete", ...REMOVE("applications", A_GIT), ...LINKED(DOPPLER_LINK), after: SM_LINKS_AFTER });
add({ name: "secret manager: remove, unknown service", token: "delete", ...REMOVE("services", "nonexistentuuid") });
add({ name: "secret manager: remove with a write token", token: "write", ...REMOVE("applications", A_IMAGE), ...LINKED(DOPPLER_LINK) });

// GET …/keys: the key names of the source's secrets, asked of the secret manager
const KEYS = (type, uuid) => ({ method: "GET", path: SM_PATH(type, uuid, "/keys") });
add({ name: "secret manager: keys, a Doppler service token", token: "write", ...KEYS("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), http: [DOPPLER_DOWNLOAD()] });
add({ name: "secret manager: keys, a Doppler service account", token: "write", ...KEYS("applications", A_IMAGE), ...DOPPLER_ACCOUNT, ...LINKED({ ...DOPPLER_LINK, settings: { project: "web", config: "prd" } }), http: [DOPPLER_DOWNLOAD("format=json&project=web&config=prd", { ZED: "z", ALPHA: "a" })] });
add({ name: "secret manager: keys, Doppler refuses the token", token: "write", ...KEYS("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), http: [DOPPLER_DOWNLOAD("format=json", { messages: ["Invalid Service token"], success: false }, 401)] });
add({ name: "secret manager: keys, a Doppler failure without a message", token: "write", ...KEYS("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), http: [DOPPLER_DOWNLOAD("format=json", { error: "unavailable" }, 503)] });
add({ name: "secret manager: keys, Doppler has none", token: "write", ...KEYS("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), http: [DOPPLER_DOWNLOAD("format=json", {})] });
add({ name: "secret manager: keys, an Infisical source with imports", token: "write", ...KEYS("services", SV_MAIN), ...LINKED(INFISICAL_LINK), http: [INFISICAL_LOGIN(), INF_SECRETS_V4()] });
add({ name: "secret manager: keys, an older Infisical", token: "write", ...KEYS("services", SV_MAIN), ...LINKED({ ...INFISICAL_LINK, settings: { project_id: "proj-1", environment: "prod" } }), http: [INFISICAL_LOGIN(), INF_SECRETS_V4({ message: "Not Found" }, 404), INF_SECRETS_V3()] });
add({ name: "secret manager: keys, the Infisical login refused", token: "write", ...KEYS("services", SV_MAIN), ...LINKED(INFISICAL_LINK), http: [INFISICAL_LOGIN(INF, 401)] });
add({ name: "secret manager: keys, Infisical refuses the secrets", token: "write", ...KEYS("services", SV_MAIN), ...LINKED(INFISICAL_LINK), http: [INFISICAL_LOGIN(), INF_SECRETS_V4({ message: "You are not allowed to read secrets in this environment" }, 403)] });
add({ name: "secret manager: keys, an Infisical base URL on a private address", token: "write", ...KEYS("services", SV_MAIN), ...LINKED(INFISICAL_LINK), setup: [`update integration_tokens set metadata = '{"base_url":"https://private.example","client_id":"client-team1"}' where id = 4`], http: [] });
add({ name: "secret manager: keys, a Vault source", token: "write", ...KEYS("databases", DB_PG), ...LINKED(VAULT_LINK), http: [VAULT_READ()] });
add({ name: "secret manager: keys, a Vault mount and path with slashes", token: "write", ...KEYS("databases", DB_PG), ...LINKED({ ...VAULT_LINK, settings: { mount: "/kv/", path: "/team/app/" } }), http: [VAULT_READ("kv/data/team/app", { data: { data: { ONE: "1" } } })] });
add({ name: "secret manager: keys, Vault refuses the token", token: "write", ...KEYS("databases", DB_PG), ...LINKED(VAULT_LINK), http: [VAULT_READ(undefined, { errors: ["permission denied"] }, 403)] });
add({ name: "secret manager: keys, a Vault path without secrets", token: "write", ...KEYS("databases", DB_PG), ...LINKED(VAULT_LINK), http: [VAULT_READ(undefined, { errors: [] }, 404)] });
add({ name: "secret manager: keys, no source", token: "write", ...KEYS("applications", A_IMAGE), http: [] });
add({ name: "secret manager: keys, unknown application", token: "write", ...KEYS("applications", "nonexistentuuid"), http: [] });
add({ name: "secret manager: keys with a read token", token: "read", ...KEYS("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), http: [] });

// POST …/references: a {{vault.KEY}} variable for one key of the source
const REFERENCE = (type, uuid) => ({ method: "POST", path: SM_PATH(type, uuid, "/references") });
add({ name: "secret manager: reference, an application's key", token: "write", ...REFERENCE("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), body: { key: "API_KEY" }, http: [DOPPLER_DOWNLOAD()], after: SM_VARS_AFTER("Application", 1) });
add({ name: "secret manager: reference, a service's key", token: "write", ...REFERENCE("services", SV_MAIN), ...LINKED(INFISICAL_LINK), body: { key: "IMPORTED_KEY" }, http: [INFISICAL_LOGIN(), INF_SECRETS_V4()], after: SM_VARS_AFTER("Service", 1) });
add({ name: "secret manager: reference, a database's key", token: "write", ...REFERENCE("databases", DB_PG), ...LINKED(VAULT_LINK), body: { key: "PORT" }, http: [VAULT_READ()], after: SM_VARS_AFTER("StandalonePostgresql", 1) });
add({ name: "secret manager: reference, not a key of the source", token: "write", ...REFERENCE("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), body: { key: "MISSING" }, http: [DOPPLER_DOWNLOAD()], after: SM_VARS_AFTER("Application", 1) });
add({ name: "secret manager: reference, not a valid variable name", token: "write", ...REFERENCE("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), body: { key: "db-password" }, http: [DOPPLER_DOWNLOAD()] });
add({ name: "secret manager: reference, a numeric key", token: "write", ...REFERENCE("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), body: { key: "10" }, http: [DOPPLER_DOWNLOAD()] });
add({ name: "secret manager: reference, a variable with the key exists", token: "write", ...REFERENCE("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), body: { key: "FOO" }, http: [DOPPLER_DOWNLOAD()], after: SM_VARS_AFTER("Application", 1) });
add({ name: "secret manager: reference, a service variable with the key exists", token: "write", ...REFERENCE("services", SV_MAIN), ...LINKED(INFISICAL_LINK), body: { key: "FOO" }, http: [INFISICAL_LOGIN(), INF_SECRETS_V4({ secrets: [{ secretKey: "FOO", secretValue: "x" }] })] });
add({ name: "secret manager: reference, no key", token: "write", ...REFERENCE("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), body: { name: "API_KEY" }, http: [DOPPLER_DOWNLOAD()] });
add({ name: "secret manager: reference, a key that is not a string", token: "write", ...REFERENCE("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), body: { key: ["API_KEY"] }, http: [DOPPLER_DOWNLOAD()] });
add({ name: "secret manager: reference, a key too long", token: "write", ...REFERENCE("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), body: { key: "K".repeat(256) }, http: [DOPPLER_DOWNLOAD()] });
add({ name: "secret manager: reference, not JSON", token: "write", ...REFERENCE("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), raw: "key=API_KEY", contentType: "application/x-www-form-urlencoded", http: [DOPPLER_DOWNLOAD()] });
add({ name: "secret manager: reference, no source", token: "write", ...REFERENCE("applications", A_IMAGE), raw: "key=API_KEY", contentType: "application/x-www-form-urlencoded", http: [] });
add({ name: "secret manager: reference, the secret manager fails", token: "write", ...REFERENCE("databases", DB_PG), ...LINKED(VAULT_LINK), body: { key: "PORT" }, http: [VAULT_READ(undefined, { errors: ["internal error"] }, 500)], after: SM_VARS_AFTER("StandalonePostgresql", 1) });
add({ name: "secret manager: reference with a read token", token: "read", ...REFERENCE("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), body: { key: "API_KEY" }, http: [] });

// POST …/import: a {{vault.KEY}} variable for every key of the source without one
const IMPORT = (type, uuid) => ({ method: "POST", path: SM_PATH(type, uuid, "/import") });
add({ name: "secret manager: import, an application's keys", token: "write", ...IMPORT("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), http: [DOPPLER_DOWNLOAD()], after: SM_VARS_AFTER("Application", 1) });
add({ name: "secret manager: import, a service's keys", token: "write", ...IMPORT("services", SV_MAIN), ...LINKED(INFISICAL_LINK), http: [INFISICAL_LOGIN(), INF_SECRETS_V4({ secrets: [{ secretKey: "FOO", secretValue: "x" }, { secretKey: "NEW_ONE", secretValue: "n" }, { secretKey: "my.dotted", secretValue: "d" }] })], after: SM_VARS_AFTER("Service", 1) });
add({ name: "secret manager: import, a database's keys", token: "write", ...IMPORT("databases", DB_PG), ...LINKED(VAULT_LINK), http: [VAULT_READ()], after: SM_VARS_AFTER("StandalonePostgresql", 1) });
add({ name: "secret manager: import, nothing new", token: "write", ...IMPORT("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), http: [DOPPLER_DOWNLOAD("format=json", { FOO: "x", MULTI: "y" })], after: SM_VARS_AFTER("Application", 1) });
add({ name: "secret manager: import, the secret manager fails", token: "write", ...IMPORT("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), http: [DOPPLER_DOWNLOAD("format=json", { messages: ["Could not find requested config"] }, 404)], after: SM_VARS_AFTER("Application", 1) });
add({ name: "secret manager: import, no source", token: "write", ...IMPORT("services", SV_MAIN), http: [] });
add({ name: "secret manager: import, another team's service", token: "write", ...IMPORT("services", SV_OTHER), http: [] });
add({ name: "secret manager: import with a delete token", token: "delete", ...IMPORT("applications", A_IMAGE), ...LINKED(DOPPLER_LINK), http: [] });

// A member whose stored levels allow delete but not write: DELETE asks authorize('update').
denial("secret manager: remove, an application's source", "memberDelete", DEPLOY_DELETE, DEPLOYER);
denial("secret manager: remove, a service's source", "memberDelete", DEPLOY_DELETE, DEPLOYER);
denial("secret manager: remove, a database's source", "memberDelete", DEPLOY_DELETE, DEPLOYER);

// ── DP-106: the instance's email settings (InstanceEmailSettingsController) ──
// A root-team token (team 0) of a root-team owner or admin: Coolify's instance admin. The fixture has no root team, so
// `setupCoolify` makes it — the team, the owner's membership and the owner's tokens — and a case names its token in
// `rootTeamToken` (Freeploy: a token of the platform operator, whose org is any). The settings are row 0 of
// instance_settings; `after` reads its encrypted columns as whether they are set.
const ROOT_TEAM_TOKENS = {
  root: { id: 51, abilities: ["root"], secret: "rtrtrtrtrtrtrtrtrtrtrtrtrtrtrtrtrtrtrtrt0c1d2e3f" },
  read: { id: 52, abilities: ["read"], secret: "rtrdrtrdrtrdrtrdrtrdrtrdrtrdrtrdrtrdrtrd1c1d2e3f" },
  sensitive: { id: 53, abilities: ["read", "read:sensitive"], secret: "rtsnrtsnrtsnrtsnrtsnrtsnrtsnrtsnrtsnrtsn2c1d2e3f" },
  write: { id: 54, abilities: ["read", "write"], secret: "rtwrrtwrrtwrrtwrrtwrrtwrrtwrrtwrrtwrrtwr3c1d2e3f" },
  writeSensitive: { id: 55, abilities: ["read", "write:sensitive"], secret: "rtwsrtwsrtwsrtwsrtwsrtwsrtwsrtwsrtwsrtws4c1d2e3f" },
};
const ROOT_TEAM_SETUP = [
  "insert into teams (id, name, description, personal_team, created_at, updated_at) values (0, 'Root Team', null, false, '2025-12-01 00:00:00', '2025-12-01 00:00:00')",
  "insert into team_user (team_id, user_id, role, created_at, updated_at) values (0, 1, 'owner', '2025-12-01 00:00:00', '2025-12-01 00:00:00')",
  ...Object.entries(ROOT_TEAM_TOKENS).map(
    ([key, t]) => `insert into personal_access_tokens (id, tokenable_type, tokenable_id, name, token, abilities, team_id, created_at, updated_at) values (${t.id}, 'App\\Models\\User', 1, 'Root team ${key}', encode(sha256('${t.secret}'::bytea), 'hex'), '${JSON.stringify(t.abilities)}', 0, '2025-12-01 00:00:00', '2025-12-01 00:00:00')`,
  ),
];
const AS_ROOT_TEAM = (key) => ({ authorization: `Bearer ${ROOT_TEAM_TOKENS[key].id}|${ROOT_TEAM_TOKENS[key].secret}`, rootTeamToken: { key, user: 1, ...ROOT_TEAM_TOKENS[key] }, setupCoolify: ROOT_TEAM_SETUP });
const SE = "/api/v1/settings/email";
const SE_AFTER = {
  settings:
    "select smtp_enabled, smtp_port, smtp_encryption, smtp_timeout, smtp_ehlo_domain, resend_enabled, smtp_from_address is not null as has_smtp_from_address, smtp_from_name is not null as has_smtp_from_name, notification_from_address is not null as has_notification_from_address, notification_from_name is not null as has_notification_from_name, smtp_host is not null as has_smtp_host, smtp_username is not null as has_smtp_username, smtp_password is not null as has_smtp_password, resend_api_key is not null as has_resend_api_key, resend_from_address is not null as has_resend_from_address, resend_from_name is not null as has_resend_from_name from instance_settings where id = 0",
};
const SMTP_ALL = {
  smtp_enabled: true,
  smtp_from_address: "noreply@example.com",
  smtp_from_name: "Freeploy",
  notification_from_address: "alerts@example.com",
  notification_from_name: "Alerts",
  smtp_host: "smtp.example.com",
  smtp_port: 587,
  smtp_encryption: "starttls",
  smtp_username: "mailer",
  smtp_password: "smtp-secret",
  smtp_timeout: 30,
  smtp_ehlo_domain: "mail.example.com",
  resend_enabled: false,
  resend_api_key: "re_parity_key",
  resend_from_address: "resend@example.com",
  resend_from_name: "Resend Sender",
};
add({ name: "settings email: show, a root-team token", method: "GET", path: SE, ...AS_ROOT_TEAM("root") });
add({ name: "settings email: show, a root-team read token", method: "GET", path: SE, ...AS_ROOT_TEAM("read") });
add({ name: "settings email: show, a root-team read:sensitive token", method: "GET", path: SE, ...AS_ROOT_TEAM("sensitive") });
add({ name: "settings email: show, a team token", token: "root", method: "GET", path: SE });
add({ name: "settings email: show, a team read token", token: "read", method: "GET", path: SE });
add({ name: "settings email: show with a write-only token", token: "writeOnly", method: "GET", path: SE });
add({ name: "settings email: update, every setting", method: "PATCH", path: SE, ...AS_ROOT_TEAM("root"), body: SMTP_ALL, after: SE_AFTER });
add({ name: "settings email: update with write:sensitive", method: "PATCH", path: SE, ...AS_ROOT_TEAM("writeSensitive"), body: { smtp_enabled: "1", smtp_host: "smtp.example.org", smtp_port: "2525", smtp_encryption: "tls", smtp_password: "pw" }, after: SE_AFTER });
add({ name: "settings email: update, Resend", method: "PATCH", path: SE, ...AS_ROOT_TEAM("root"), body: { resend_enabled: 1, resend_api_key: "re_123", resend_from_address: "noreply@example.com", resend_from_name: "Freeploy", smtp_encryption: "none", smtp_timeout: 0 }, after: SE_AFTER });
add({ name: "settings email: update, values cleared", method: "PATCH", path: SE, ...AS_ROOT_TEAM("root"), body: { smtp_host: null, smtp_password: "", smtp_port: null, smtp_ehlo_domain: "", smtp_from_name: null }, after: SE_AFTER });
add({ name: "settings email: update, fields that are not settings", method: "PATCH", path: SE, ...AS_ROOT_TEAM("root"), body: { smtp_recipients: "a@example.com", is_api_enabled: false, foo: 1, smtp_from_name: "Only this" }, after: SE_AFTER });
add({
  name: "settings email: update, invalid",
  method: "PATCH",
  path: SE,
  ...AS_ROOT_TEAM("root"),
  body: {
    smtp_enabled: "yes",
    smtp_from_address: "not-an-email",
    smtp_from_name: "n".repeat(256),
    notification_from_address: 5,
    notification_from_name: ["x"],
    smtp_host: 25,
    smtp_port: 70000,
    smtp_encryption: "ssl",
    smtp_username: "u".repeat(256),
    smtp_password: true,
    smtp_timeout: -1,
    smtp_ehlo_domain: "bad domain!",
    resend_enabled: 2,
    resend_api_key: 7,
    resend_from_address: "@example.com",
    resend_from_name: false,
  },
  after: SE_AFTER,
});
add({ name: "settings email: update, a port that is not a number", method: "PATCH", path: SE, ...AS_ROOT_TEAM("root"), body: { smtp_port: "abc", smtp_timeout: "1.5" }, after: SE_AFTER });
add({ name: "settings email: update, a port of zero", method: "PATCH", path: SE, ...AS_ROOT_TEAM("root"), body: { smtp_port: 0, smtp_ehlo_domain: "-bad.example.com" } });
add({ name: "settings email: update, not JSON", method: "PATCH", path: SE, ...AS_ROOT_TEAM("root"), raw: "smtp_enabled=1", contentType: "application/x-www-form-urlencoded", after: SE_AFTER });
add({ name: "settings email: update, empty JSON", method: "PATCH", path: SE, ...AS_ROOT_TEAM("root"), raw: "{}", after: SE_AFTER });
add({ name: "settings email: update with a write token", method: "PATCH", path: SE, ...AS_ROOT_TEAM("write"), body: { smtp_enabled: true } });
add({ name: "settings email: update, a team token", token: "root", method: "PATCH", path: SE, body: { smtp_enabled: true }, after: SE_AFTER });
add({
  name: "settings email: update, then show",
  setupCoolify: ROOT_TEAM_SETUP,
  rootTeamToken: { key: "root", user: 1, ...ROOT_TEAM_TOKENS.root },
  method: "PATCH",
  path: SE,
  sequence: [
    { method: "PATCH", path: SE, authorization: AS_ROOT_TEAM("root").authorization, body: SMTP_ALL },
    { method: "GET", path: SE, authorization: AS_ROOT_TEAM("read").authorization },
    { method: "GET", path: SE, authorization: AS_ROOT_TEAM("sensitive").authorization },
  ],
});
// ── DP-105: managed DNS (DnsController) ─────────────────────────────────────
// The team's Cloudflare zones (DP-104's fixture: example.com and example.org of the first Cloudflare token, example.net of
// the second, whose records are proxied), and the records of an application's and a service's domains: image.example.com
// (the image application) and web.example.com (the service's application) are in example.com, and the server's address
// 203.0.113.10 is public to PHP's filter. Cloudflare is faked per case (`http`); a fake record's comment written
// `{{ownership:<uuid>}}` is the ownership comment each side writes for that record (emit.php: ManagedDnsRecord::
// ownershipCommentFor(), Freeploy's own). A managed record and its references are rows of `setupCoolify` (team_id; the
// references have no team) and `setupFreeploy` (org_id).
const DNS_APP = `/api/v1/applications/${A_IMAGE}/dns`;
const DNS_SVC = `/api/v1/services/${SV_MAIN}/dns`;
const DNS_ZONES = "/api/v1/dns/zones";
const MORPH = { app: "App\\Models\\Application", serviceApp: "App\\Models\\ServiceApplication", preview: "App\\Models\\ApplicationPreview" };
const DR_IMAGE = "m2paritydnsimage00000002";
const DR_OLD = "m3paritydnsold0000000003";
const DR_OLD_WEB = "m4paritydnsoldweb0000004";
const DNS_RECORD = (tenancy, r) =>
  `insert into managed_dns_records (uuid, integration_token_id, dns_provider_zone_id, provider_record_id, type, name, content, owned, ${tenancy[0]}, created_at, updated_at) values ('${r.uuid}', ${r.token ?? 1}, ${r.zone ?? 1}, '${r.rec}', '${r.type ?? "A"}', '${r.name}', '${r.content ?? "203.0.113.10"}', ${r.owned ?? true}, ${tenancy[1]}, '2025-12-30 00:00:00', '2025-12-30 00:00:00')`;
const DNS_REF = (tenancy, uuid, [type, id]) =>
  `insert into managed_dns_record_references (managed_dns_record_id, resource_type, resource_id, ${tenancy ? `${tenancy[0]}, ` : ""}created_at, updated_at) select id, '${type}', ${id}, ${tenancy ? `${tenancy[1]}, ` : ""}'2025-12-30 00:00:00', '2025-12-30 00:00:00' from managed_dns_records where uuid = '${uuid}'`;
/** Managed records (each with its references, `refs`: [morph, id]) on both sides, after the case's own setupCoolify/setupFreeploy. */
const withDns = (records, more = {}) => ({
  setupCoolify: [...(more.setupCoolify ?? []), ...records.flatMap((r) => [DNS_RECORD(COOLIFY_TENANCY, r), ...(r.refs ?? []).map((k) => DNS_REF(null, r.uuid, k))])],
  setupFreeploy: [...(more.setupFreeploy ?? []), ...records.flatMap((r) => [DNS_RECORD(FREEPLOY_TENANCY, r), ...(r.refs ?? []).map((k) => DNS_REF(FREEPLOY_TENANCY, r.uuid, k))])],
});
const REC_IMAGE = { uuid: DR_IMAGE, rec: "rec-image", name: "image.example.com", refs: [[MORPH.app, 1]] };
const REC_OLD = { uuid: DR_OLD, rec: "rec-old", name: "old.example.com", refs: [[MORPH.app, 1]] };
const REC_OLD_WEB = { uuid: DR_OLD_WEB, rec: "rec-oldweb", name: "old-web.example.com", refs: [[MORPH.serviceApp, 1]] };
/** A zone of another token of team 1 (the second Cloudflare token) on both sides. */
const DNS_ZONE = (tenancy, uuid, token, providerZoneId, name) =>
  `insert into dns_provider_zones (uuid, integration_token_id, provider_zone_id, name, account_id, account_name, ${tenancy ? `${tenancy[0]}, ` : ""}created_at, updated_at) values ('${uuid}', ${token}, '${providerZoneId}', '${name}', 'acc-1', 'Parity Account', ${tenancy ? `${tenancy[1]}, ` : ""}'2025-12-29 00:00:00', '2025-12-29 00:00:00')`;
const withZone = (uuid, token, providerZoneId, name) => ({ setupCoolify: [DNS_ZONE(null, uuid, token, providerZoneId, name)], setupFreeploy: [DNS_ZONE(FREEPLOY_TENANCY, uuid, token, providerZoneId, name)] });
const DNS_AFTER = {
  records: "select case when r.uuid like 'm_paritydns%' then r.uuid end as fixture_uuid, t.uuid as token, z.provider_zone_id as zone, r.provider_record_id, r.type, r.name, r.content, r.owned from managed_dns_records r join integration_tokens t on t.id = r.integration_token_id join dns_provider_zones z on z.id = r.dns_provider_zone_id order by r.name, r.provider_record_id",
  references: "select r.name, f.resource_type, f.resource_id from managed_dns_record_references f join managed_dns_records r on r.id = f.managed_dns_record_id order by r.name, f.resource_type, f.resource_id",
};
const APP_DOMAINS = (fqdn) => `update applications set fqdn = '${fqdn}' where id = 1`;
const SERVER_SETTINGS = (v4, v6 = null) => `update server_settings set public_ipv4 = ${v4 === null ? "null" : `'${v4}'`}, public_ipv6 = ${v6 === null ? "null" : `'${v6}'`} where server_id = 1`;
const SERVER_IP = (ip) => `update servers set ip = '${ip}' where id = 1`;
const TRANSFERRED = `update servers set server_metadata = '{"transfer":{"status":"transferred"}}' where id = 1`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cfRecord = (id, name, content, extra = {}) => ({ id, type: "A", name, content, proxied: false, ttl: 1, comment: null, ...extra });
const CF_FAIL = { success: false, errors: [{ code: 10000, message: "Authentication error" }] };
const CF_LIST = (name, result = [], { type = "A", zone = "zone-com", status = 200 } = {}) => answer(`^GET ${CF}/zones/${zone}/dns_records\\?type=${type}&name=${esc(name)}&per_page=100$`, status === 200 ? { success: true, result } : CF_FAIL, status);
const CF_CREATE = ({ zone = "zone-com", id = "rec-new", status = 200, result } = {}) => answer(`^POST ${CF}/zones/${zone}/dns_records$`, status === 200 ? { success: true, result: result === undefined ? { id } : result } : CF_FAIL, status);
const CF_PATCH = (rec, { zone = "zone-com", status = 200 } = {}) => answer(`^PATCH ${CF}/zones/${zone}/dns_records/${rec}$`, status === 200 ? { success: true, result: { id: rec } } : CF_FAIL, status);
const CF_GET = (rec, result, { zone = "zone-com", status = 200 } = {}) => answer(`^GET ${CF}/zones/${zone}/dns_records/${rec}$`, status === 200 ? { success: true, result } : CF_FAIL, status);
const CF_DELETE = (rec, { zone = "zone-com", status = 200 } = {}) => answer(`^DELETE ${CF}/zones/${zone}/dns_records/${rec}$`, status === 200 ? { success: true, result: { id: rec } } : CF_FAIL, status);
const OWNED = (uuid) => `{{ownership:${uuid}}}`;
const CF_OWNED = (rec, name, uuid, extra = {}) => CF_GET(rec, cfRecord(rec, name, "203.0.113.10", { comment: OWNED(uuid), ...extra }));

// GET /dns/zones (IntegrationToken viewAny: a team admin)
add({ name: "dns zones: list", token: "read", method: "GET", path: DNS_ZONES });
add({ name: "dns zones: list with managed records", token: "read", method: "GET", path: DNS_ZONES, ...withDns([REC_IMAGE, REC_OLD, { uuid: "m5paritydnsnet0000000005", rec: "rec-net", name: "app.example.net", token: 2, zone: 3 }]) });
add({ name: "dns zones: list, a token that is not Cloudflare's", token: "read", method: "GET", path: DNS_ZONES, setup: ["update integration_tokens set provider = 'doppler' where id = 2"] });
add({ name: "dns zones: list, none", token: "read", method: "GET", path: DNS_ZONES, setup: ["delete from dns_provider_zones"] });
add({ name: "dns zones: list with a write-only token", token: "writeOnly", method: "GET", path: DNS_ZONES });

// GET /applications/{uuid}/dns and /services/{uuid}/dns
add({ name: "dns application: status", token: "read", method: "GET", path: DNS_APP });
add({ name: "dns application: status with several domains and records", token: "read", method: "GET", path: DNS_APP, setup: [APP_DOMAINS("https://image.example.com/app,http://WWW.Image.example.com:8080,https://api.example.org,https://nozone.test,https://app.example.net,https://image.example.com:8443")], ...withDns([REC_IMAGE, { uuid: "m6paritydnswww0000000006", rec: "rec-www", name: "www.image.example.com", owned: false }, { uuid: "m7paritydnsorg0000000007", rec: "rec-api", name: "api.example.org", zone: 2, content: "2606:4700::6810:84e5", type: "AAAA", refs: [[MORPH.app, 1]] }]) });
add({ name: "dns application: status, two tokens manage the zone", token: "read", method: "GET", path: DNS_APP, ...withZone("z5paritydupexamplecom005", 2, "zone-com-2", "example.com") });
add({ name: "dns application: status, the longest zone", token: "read", method: "GET", path: DNS_APP, ...withZone("z6parityimageexample0006", 2, "zone-image", "image.example.com") });
add({ name: "dns application: status, public IPv4 and IPv6", token: "read", method: "GET", path: DNS_APP, setup: [SERVER_SETTINGS("93.184.216.34", "2606:4700::6810:84e5")] });
add({ name: "dns application: status, a public IPv6 only", token: "read", method: "GET", path: DNS_APP, setup: [SERVER_SETTINGS(null, "2606:4700::6810:84e5")] });
add({ name: "dns application: status, a private server", token: "read", method: "GET", path: DNS_APP, setup: [SERVER_IP("10.0.0.5")] });
add({ name: "dns application: status, a CGNAT public IPv4", token: "read", method: "GET", path: DNS_APP, setup: [SERVER_SETTINGS("100.64.0.1")] });
add({ name: "dns application: status, an IPv6 server", token: "read", method: "GET", path: DNS_APP, setup: [SERVER_IP("2606:4700::1")] });
add({ name: "dns application: status, compose domains", token: "read", method: "GET", path: DNS_APP, setup: [`update applications set fqdn = null, build_pack = 'dockercompose', docker_compose_domains = '{"web":{"domain":"https://web.example.org,https://Image.example.com"},"api":{"domain":""},"db":"x"}' where id = 1`] });
add({ name: "dns application: status, no domains", token: "read", method: "GET", path: `/api/v1/applications/${A_GIT}/dns` });
add({ name: "dns application: status, unknown", token: "read", method: "GET", path: "/api/v1/applications/nonexistentuuid/dns" });
add({ name: "dns application: status, another team's", token: "read", method: "GET", path: `/api/v1/applications/${A_OTHER}/dns` });
add({ name: "dns service: status", token: "read", method: "GET", path: DNS_SVC });
add({ name: "dns service: status with several domains and a record", token: "read", method: "GET", path: DNS_SVC, setup: ["update service_applications set fqdn = 'https://web.example.com:8080,https://web2.example.org' where id = 1"], ...withDns([{ uuid: "m8paritydnsweb0000000008", rec: "rec-web", name: "web.example.com", refs: [[MORPH.serviceApp, 1]] }]) });
add({ name: "dns service: status, a private server", token: "read", method: "GET", path: DNS_SVC, setup: [SERVER_IP("192.168.1.10")] });
add({ name: "dns service: status, unknown", token: "read", method: "GET", path: "/api/v1/services/nonexistentuuid/dns" });
add({ name: "dns service: status, another team's", token: "read", method: "GET", path: `/api/v1/services/${SV_OTHER}/dns` });

// POST /applications/{uuid}/dns
const NEW_IMAGE = { hostname: "image.example.com" };
add({ name: "dns application: create a record", token: "write", method: "POST", path: DNS_APP, body: NEW_IMAGE, http: [CF_LIST("image.example.com"), CF_CREATE()], after: DNS_AFTER });
add({ name: "dns application: create a record, the hostname as written", token: "write", method: "POST", path: DNS_APP, body: { hostname: " IMAGE.Example.com.. " }, http: [CF_LIST("image.example.com"), CF_CREATE()], after: DNS_AFTER });
add({ name: "dns application: create a proxied record", token: "write", method: "POST", path: DNS_APP, setup: [APP_DOMAINS("https://app.example.net")], body: { hostname: "app.example.net" }, http: [CF_LIST("app.example.net", [], { zone: "zone-net" }), CF_CREATE({ zone: "zone-net", id: "rec-net-new" })], after: DNS_AFTER });
add({ name: "dns application: create an AAAA record", token: "write", method: "POST", path: DNS_APP, setup: [SERVER_SETTINGS("93.184.216.34", "2606:4700::6810:84e5")], body: { hostname: "image.example.com", address: "2606:4700:0::6810:84E5" }, http: [CF_LIST("image.example.com", [], { type: "AAAA" }), CF_CREATE({ id: "rec-v6" })], after: DNS_AFTER });
add({ name: "dns application: create a record of the public IPv4", token: "write", method: "POST", path: DNS_APP, setup: [SERVER_SETTINGS("93.184.216.34")], body: { hostname: "image.example.com", address: "93.184.216.34", integration_token_uuid: IT_CF }, http: [CF_LIST("image.example.com"), CF_CREATE()], after: DNS_AFTER });
add({ name: "dns application: create, a record of the address exists", token: "write", method: "POST", path: DNS_APP, body: NEW_IMAGE, http: [CF_LIST("image.example.com", [cfRecord("rec-existing", "Image.Example.com", "203.0.113.10", { comment: "made by hand" })])], after: DNS_AFTER });
add({ name: "dns application: create, the tracked record", token: "write", method: "POST", path: DNS_APP, body: NEW_IMAGE, ...withDns([{ ...REC_IMAGE, refs: [] }]), http: [CF_LIST("image.example.com", [cfRecord("rec-image", "image.example.com", "203.0.113.10", { comment: OWNED(DR_IMAGE) })])], after: DNS_AFTER });
add({ name: "dns application: create, the tracked record changed its comment", token: "write", method: "POST", path: DNS_APP, body: NEW_IMAGE, ...withDns([REC_IMAGE]), http: [CF_LIST("image.example.com", [cfRecord("rec-image", "image.example.com", "203.0.113.10", { comment: "edited" })])], after: DNS_AFTER });
add({ name: "dns application: create, a conflict", token: "write", method: "POST", path: DNS_APP, body: NEW_IMAGE, http: [CF_LIST("image.example.com", [cfRecord("rec-other", "image.example.com", "198.51.100.7")])], after: DNS_AFTER });
add({ name: "dns application: create, several records", token: "write", method: "POST", path: DNS_APP, body: NEW_IMAGE, http: [CF_LIST("image.example.com", [cfRecord("rec-a", "image.example.com", "198.51.100.7"), cfRecord("rec-b", "image.example.com", "198.51.100.8")])] });
add({ name: "dns application: create, the matching record has no id", token: "write", method: "POST", path: DNS_APP, body: NEW_IMAGE, http: [CF_LIST("image.example.com", [{ type: "A", name: "image.example.com", content: "203.0.113.10" }, "not a record"])] });
add({ name: "dns application: create, no DNS permission", token: "write", method: "POST", path: DNS_APP, body: NEW_IMAGE, http: [CF_LIST("image.example.com", [], { status: 403 })], after: DNS_AFTER });
add({ name: "dns application: create, the records not checked", token: "write", method: "POST", path: DNS_APP, body: NEW_IMAGE, http: [CF_LIST("image.example.com", [], { status: 500 })] });
add({ name: "dns application: create, Cloudflare unreachable", token: "write", method: "POST", path: DNS_APP, body: NEW_IMAGE, http: [FAILED(`^GET ${CF}/zones/zone-com/dns_records`)], after: DNS_AFTER });
add({ name: "dns application: create, the create refused", token: "write", method: "POST", path: DNS_APP, body: NEW_IMAGE, http: [CF_LIST("image.example.com"), CF_CREATE({ status: 403 })], after: DNS_AFTER });
add({ name: "dns application: create, the create failed", token: "write", method: "POST", path: DNS_APP, body: NEW_IMAGE, http: [CF_LIST("image.example.com"), CF_CREATE({ status: 500 })] });
add({ name: "dns application: create, no record id", token: "write", method: "POST", path: DNS_APP, body: NEW_IMAGE, http: [CF_LIST("image.example.com"), CF_CREATE({ result: { id: 7 } })], after: DNS_AFTER });
add({ name: "dns application: create, not a domain of the application", token: "write", method: "POST", path: DNS_APP, body: { hostname: "other.example.com" }, http: [] });
add({ name: "dns application: create, the validation", token: "write", method: "POST", path: DNS_APP, body: { address: 7, integration_token_uuid: ["x"], proxied: true, hostname: "x".repeat(256) }, http: [] });
add({ name: "dns application: create, no hostname", token: "write", method: "POST", path: DNS_APP, body: { address: null }, http: [] });
add({ name: "dns application: create, not JSON", token: "write", method: "POST", path: DNS_APP, raw: "hostname=image.example.com", contentType: "application/x-www-form-urlencoded", http: [] });
add({ name: "dns application: create, an empty body", token: "write", method: "POST", path: DNS_APP, raw: "{}", http: [] });
add({ name: "dns application: create, a private server", token: "write", method: "POST", path: DNS_APP, setup: [SERVER_IP("10.0.0.5")], body: NEW_IMAGE, http: [] });
add({ name: "dns application: create, an address not of the server", token: "write", method: "POST", path: DNS_APP, setup: [SERVER_SETTINGS("93.184.216.34", "2606:4700::6810:84e5")], body: { hostname: "image.example.com", address: "203.0.113.10" }, http: [] });
add({ name: "dns application: create, no zone", token: "write", method: "POST", path: DNS_APP, setup: [APP_DOMAINS("https://nozone.test")], body: { hostname: "nozone.test" }, http: [] });
add({ name: "dns application: create, two tokens manage the zone", token: "write", method: "POST", path: DNS_APP, body: NEW_IMAGE, ...withZone("z5paritydupexamplecom005", 2, "zone-com-2", "example.com"), http: [] });
add({ name: "dns application: create, the token chosen", token: "write", method: "POST", path: DNS_APP, body: { hostname: "image.example.com", integration_token_uuid: IT_CF_TUNNEL }, ...withZone("z5paritydupexamplecom005", 2, "zone-com-2", "example.com"), http: [CF_LIST("image.example.com", [], { zone: "zone-com-2" }), CF_CREATE({ zone: "zone-com-2", id: "rec-dup" })], after: DNS_AFTER });
add({ name: "dns application: create, a token that does not manage it", token: "write", method: "POST", path: DNS_APP, body: { hostname: "image.example.com", integration_token_uuid: IT_CF_TUNNEL }, http: [] });
add({ name: "dns application: create, a transferred server", token: "write", method: "POST", path: DNS_APP, setup: [TRANSFERRED], body: NEW_IMAGE, http: [] });
add({ name: "dns application: create, unknown", token: "write", method: "POST", path: "/api/v1/applications/nonexistentuuid/dns", body: NEW_IMAGE });
add({ name: "dns application: create with a read token", token: "read", method: "POST", path: DNS_APP, body: NEW_IMAGE });
// POST /services/{uuid}/dns
add({ name: "dns service: create a record", token: "write", method: "POST", path: DNS_SVC, body: { hostname: "web.example.com" }, http: [CF_LIST("web.example.com"), CF_CREATE({ id: "rec-web" })], after: DNS_AFTER });
add({ name: "dns service: create, not a domain of the service", token: "write", method: "POST", path: DNS_SVC, body: { hostname: "image.example.com" }, http: [] });
add({ name: "dns service: create, unknown", token: "write", method: "POST", path: "/api/v1/services/nonexistentuuid/dns", body: { hostname: "web.example.com" } });

// POST /applications/{uuid}/dns/replace
const REPLACE = { hostname: "image.example.com", record_id: "rec-other", current: "198.51.100.7" };
const OTHER_RECORD = [cfRecord("rec-other", "image.example.com", "198.51.100.7")];
add({ name: "dns application: replace a record", token: "write", method: "POST", path: `${DNS_APP}/replace`, body: REPLACE, http: [CF_LIST("image.example.com", OTHER_RECORD), CF_PATCH("rec-other")], after: DNS_AFTER });
add({ name: "dns application: replace, the tracked record", token: "write", method: "POST", path: `${DNS_APP}/replace`, body: REPLACE, ...withDns([{ ...REC_IMAGE, rec: "rec-other", content: "198.51.100.7", refs: [] }]), http: [CF_LIST("image.example.com", [cfRecord("rec-other", "image.example.com", "198.51.100.7", { comment: OWNED(DR_IMAGE) })]), CF_PATCH("rec-other")], after: DNS_AFTER });
add({ name: "dns application: replace, the conflict is gone", token: "write", method: "POST", path: `${DNS_APP}/replace`, body: REPLACE, http: [CF_LIST("image.example.com")], after: DNS_AFTER });
add({ name: "dns application: replace, another record", token: "write", method: "POST", path: `${DNS_APP}/replace`, body: { ...REPLACE, record_id: "rec-x" }, http: [CF_LIST("image.example.com", OTHER_RECORD)] });
add({ name: "dns application: replace, the record changed", token: "write", method: "POST", path: `${DNS_APP}/replace`, body: { ...REPLACE, current: "198.51.100.9" }, http: [CF_LIST("image.example.com", OTHER_RECORD)] });
add({ name: "dns application: replace, several records", token: "write", method: "POST", path: `${DNS_APP}/replace`, body: REPLACE, http: [CF_LIST("image.example.com", [...OTHER_RECORD, cfRecord("rec-b", "image.example.com", "198.51.100.8")])] });
add({ name: "dns application: replace, refused", token: "write", method: "POST", path: `${DNS_APP}/replace`, body: REPLACE, http: [CF_LIST("image.example.com", OTHER_RECORD), CF_PATCH("rec-other", { status: 403 })], after: DNS_AFTER });
add({ name: "dns application: replace, failed", token: "write", method: "POST", path: `${DNS_APP}/replace`, body: REPLACE, http: [CF_LIST("image.example.com", OTHER_RECORD), CF_PATCH("rec-other", { status: 500 })] });
add({ name: "dns application: replace, the validation", token: "write", method: "POST", path: `${DNS_APP}/replace`, body: { hostname: "image.example.com", current: 5, extra: 1 }, http: [] });
add({ name: "dns application: replace, not a domain of the application", token: "write", method: "POST", path: `${DNS_APP}/replace`, body: { ...REPLACE, hostname: "nope.example.com" }, http: [] });
add({ name: "dns service: replace a record", token: "write", method: "POST", path: `${DNS_SVC}/replace`, body: { hostname: "web.example.com", record_id: "rec-w", current: "198.51.100.7" }, http: [CF_LIST("web.example.com", [cfRecord("rec-w", "web.example.com", "198.51.100.7")]), CF_PATCH("rec-w")], after: DNS_AFTER });

// DELETE /applications/{uuid}/dns/{hostname}
const RELEASE_OLD = `${DNS_APP}/old.example.com`;
add({ name: "dns application: release, deleted", token: "delete", method: "DELETE", path: RELEASE_OLD, ...withDns([REC_OLD]), http: [CF_OWNED("rec-old", "old.example.com", DR_OLD), CF_DELETE("rec-old")], after: DNS_AFTER });
add({ name: "dns application: release, the hostname as written", token: "delete", method: "DELETE", path: `${DNS_APP}/OLD.Example.com.`, ...withDns([REC_OLD]), http: [CF_OWNED("rec-old", "old.example.com", DR_OLD), CF_DELETE("rec-old")], after: DNS_AFTER });
add({ name: "dns application: release, already gone", token: "delete", method: "DELETE", path: RELEASE_OLD, ...withDns([REC_OLD]), http: [CF_GET("rec-old", null, { status: 404 })], after: DNS_AFTER });
add({ name: "dns application: release, gone while deleting", token: "delete", method: "DELETE", path: RELEASE_OLD, ...withDns([REC_OLD]), http: [CF_OWNED("rec-old", "old.example.com", DR_OLD), CF_DELETE("rec-old", { status: 404 })], after: DNS_AFTER });
add({ name: "dns application: release, changed outside", token: "delete", method: "DELETE", path: RELEASE_OLD, ...withDns([REC_OLD]), http: [CF_OWNED("rec-old", "old.example.com", DR_OLD, { content: "198.51.100.7" })], after: DNS_AFTER });
add({ name: "dns application: release, another comment", token: "delete", method: "DELETE", path: RELEASE_OLD, ...withDns([REC_OLD]), http: [CF_GET("rec-old", cfRecord("rec-old", "OLD.example.com", "203.0.113.10", { comment: OWNED(DR_IMAGE) }))], after: DNS_AFTER });
add({ name: "dns application: release, Cloudflare failed", token: "delete", method: "DELETE", path: RELEASE_OLD, ...withDns([REC_OLD]), http: [CF_GET("rec-old", null, { status: 500 })], after: DNS_AFTER });
add({ name: "dns application: release, the delete failed", token: "delete", method: "DELETE", path: RELEASE_OLD, ...withDns([REC_OLD]), http: [CF_OWNED("rec-old", "old.example.com", DR_OLD), CF_DELETE("rec-old", { status: 500 })], after: DNS_AFTER });
add({ name: "dns application: release, Cloudflare unreachable", token: "delete", method: "DELETE", path: RELEASE_OLD, ...withDns([REC_OLD]), http: [FAILED(`^GET ${CF}/zones/zone-com/dns_records/rec-old$`)], after: DNS_AFTER });
add({ name: "dns application: release, not owned", token: "delete", method: "DELETE", path: RELEASE_OLD, ...withDns([{ ...REC_OLD, owned: false }]), http: [], after: DNS_AFTER });
add({ name: "dns application: release, kept on request", token: "delete", method: "DELETE", path: `${RELEASE_OLD}?delete_record=false`, ...withDns([REC_OLD]), http: [], after: DNS_AFTER });
add({ name: "dns application: release, another application references it", token: "delete", method: "DELETE", path: RELEASE_OLD, ...withDns([{ ...REC_OLD, refs: [[MORPH.app, 1], [MORPH.app, 2]] }]), http: [], after: DNS_AFTER });
add({ name: "dns application: release, a dead reference", token: "delete", method: "DELETE", path: RELEASE_OLD, ...withDns([{ ...REC_OLD, refs: [[MORPH.app, 1], [MORPH.preview, 99]] }]), http: [CF_OWNED("rec-old", "old.example.com", DR_OLD), CF_DELETE("rec-old")], after: DNS_AFTER });
add({ name: "dns application: release, another application uses the hostname", token: "delete", method: "DELETE", path: RELEASE_OLD, setup: ["update applications set fqdn = 'https://old.example.com:3000' where id = 2"], ...withDns([REC_OLD]), http: [], after: DNS_AFTER });
add({ name: "dns application: release, a preview uses the hostname", token: "delete", method: "DELETE", path: RELEASE_OLD, setup: ["update application_previews set fqdn = 'http://OLD.example.com' where id = 3"], ...withDns([REC_OLD]), http: [], after: DNS_AFTER });
add({ name: "dns application: release, still a domain", token: "delete", method: "DELETE", path: `${DNS_APP}/Image.example.com`, ...withDns([REC_IMAGE]), http: [], after: DNS_AFTER });
add({ name: "dns application: release, no record", token: "delete", method: "DELETE", path: `${DNS_APP}/Nothing.example.com`, http: [] });
add({ name: "dns application: release, a record of another resource", token: "delete", method: "DELETE", path: RELEASE_OLD, ...withDns([{ ...REC_OLD, refs: [[MORPH.app, 2]] }]), http: [], after: DNS_AFTER });
add({ name: "dns application: release, unknown", token: "delete", method: "DELETE", path: "/api/v1/applications/nonexistentuuid/dns/old.example.com" });
add({ name: "dns application: release with a write token", token: "write", method: "DELETE", path: RELEASE_OLD });
// DELETE /services/{uuid}/dns/{hostname}
add({ name: "dns service: release, deleted", token: "delete", method: "DELETE", path: `${DNS_SVC}/old-web.example.com`, ...withDns([REC_OLD_WEB]), http: [CF_OWNED("rec-oldweb", "old-web.example.com", DR_OLD_WEB), CF_DELETE("rec-oldweb")], after: DNS_AFTER });
add({ name: "dns service: release, still a domain", token: "delete", method: "DELETE", path: `${DNS_SVC}/web.example.com`, http: [] });
add({ name: "dns service: release, no record", token: "delete", method: "DELETE", path: `${DNS_SVC}/old-web.example.com`, http: [] });
// A default member does not administer the team (the zones); a member without Write releases nothing (a create or a
// replace needs a token with write, which such a member may not hold: api.token.team refuses it before the policy).
denial("dns zones: list", "memberRead", null, MEMBER);
denial("dns application: release, deleted", "memberDelete", DEPLOY_DELETE, DEPLOYER);
denial("dns service: release, deleted", "memberDelete", DEPLOY_DELETE, DEPLOYER);
// ── DP-108: POST /services/{uuid}/clone (clone_service()) ───────────────────
// The clone is the service's row replicated, its tags, scheduled tasks, variables and secret manager link copied, then
// Service::parse() on it (its applications, databases, volumes and files made again), and the backup schedules of its
// databases. `after` reads the clone (the service whose uuid is not the fixture's), its random uuid as <uuid> inside its
// name, its generated Compose file (its parts' random uuids as <part-uuid>), its parts' domains and its volume and file
// paths.
const FIXTURE_SERVICES = `'${SV_MAIN}', '${SV_OTHER}'`;
const NEW_SERVICE = `(select id from services where uuid not in (${FIXTURE_SERVICES}))`;
const NEW_SERVICE_UUID = `(select uuid from services where uuid not in (${FIXTURE_SERVICES}))`;
const SERVICE_PART_IDS = (table) => `(select id from ${table} where service_id = ${NEW_SERVICE})`;
const SERVICE_CLONE_AFTER = {
  service: `select replace(name, uuid, '<uuid>') as name, description, docker_compose_raw, regexp_replace(replace(docker_compose, uuid, '<uuid>'), 'subUuid=[a-z0-9]+', 'subUuid=<part-uuid>', 'g') as docker_compose, environment_id, server_id, destination_id, destination_type, connect_to_docker_network, service_type, is_container_label_escape_enabled, compose_parsing_version, include_coolify_default_variables, redact_all_env_values_in_logs, config_hash from services where uuid not in (${FIXTURE_SERVICES})`,
  applications: `select a.name, a.human_name, replace(a.fqdn, s.uuid, '<uuid>') as fqdn, a.image, a.status, a.exclude_from_status, a.is_log_drain_enabled, a.is_gzip_enabled, a.is_stripprefix_enabled, a.is_migrated, a.is_removed_from_compose, a.ports, a.redirect, a.is_force_https_enabled, a.uuid = '${SA_WEB}' as fixture_uuid from service_applications a join services s on s.id = a.service_id where s.uuid not in (${FIXTURE_SERVICES}) order by a.name`,
  databases: `select d.name, d.human_name, d.image, d.status, d.exclude_from_status, d.is_log_drain_enabled, d.is_public, d.public_port, d.is_migrated, d.is_removed_from_compose, d.uuid = '${SD_DB}' as fixture_uuid from service_databases d join services s on s.id = d.service_id where s.uuid not in (${FIXTURE_SERVICES}) order by d.name`,
  tags: `select tg.tag_id from taggables tg where tg.taggable_type = 'App\\Models\\Service' and tg.taggable_id = ${NEW_SERVICE} order by tg.tag_id`,
  tasks: `select name, command, frequency, container, timeout, use_shell, enabled, uuid = '${ST_SERVICE}' as fixture_uuid from scheduled_tasks where service_id = ${NEW_SERVICE} order by name`,
  variables: `select key, is_preview, is_required, is_shared, is_literal, is_multiline, is_shown_once, comment, version, value is not null as has_value from environment_variables where resourceable_type = 'App\\Models\\Service' and resourceable_id = ${NEW_SERVICE} order by key`,
  volumes: `select replace(name, ${NEW_SERVICE_UUID}, '<uuid>') as name, mount_path, resource_type, uuid = '${PV_SERVICE}' as fixture_uuid from local_persistent_volumes where (resource_type = 'App\\Models\\ServiceApplication' and resource_id in ${SERVICE_PART_IDS("service_applications")}) or (resource_type = 'App\\Models\\ServiceDatabase' and resource_id in ${SERVICE_PART_IDS("service_databases")}) order by name`,
  files: `select replace(fs_path, ${NEW_SERVICE_UUID}, '<uuid>') as fs_path, mount_path, is_directory, is_host_file, content is not null as has_content, resource_type from local_file_volumes where (resource_type = 'App\\Models\\ServiceApplication' and resource_id in ${SERVICE_PART_IDS("service_applications")}) or (resource_type = 'App\\Models\\ServiceDatabase' and resource_id in ${SERVICE_PART_IDS("service_databases")}) order by mount_path`,
  backups: `select frequency, save_s3, enabled, databases_to_backup, (select count(*) from scheduled_database_backup_s3_storage p where p.scheduled_database_backup_id = b.id) as s3 from scheduled_database_backups b where database_type = 'App\\Models\\ServiceDatabase' and database_id in ${SERVICE_PART_IDS("service_databases")} order by frequency`,
  links: `select resourceable_type, integration_token_id, settings::jsonb::text as settings from secret_manager_links where resourceable_type = 'App\\Models\\Service' and resourceable_id = ${NEW_SERVICE}`,
  count: `select count(*) as services from services where uuid <> '${SV_OTHER}'`,
};
const SVC_CLONE = (uuid = SV_MAIN) => `/api/v1/services/${uuid}/clone`;
const SVC_COMPOSE = (compose) => [`update services set docker_compose_raw = '${compose.replace(/'/g, "''")}' where id = 1`];
const NAMED_VOLUME_COMPOSE = "services:\n  web:\n    image: 'nginx:alpine'\n    volumes:\n      - 'web-html:/usr/share/nginx/html'\n    environment:\n      - 'FOO=${FOO:-bar}'\n  db:\n    image: 'postgres:16-alpine'\n    volumes:\n      - 'db-data:/var/lib/postgresql/data'\n    environment:\n      - 'POSTGRES_PASSWORD=${DB_PASSWORD}'\n";
const BIND_COMPOSE = "services:\n  web:\n    image: 'nginx:alpine'\n    volumes:\n      - './default.conf:/etc/nginx/conf.d/default.conf'\n    environment:\n      - 'FOO=${FOO:-bar}'\n";
const HOST_COMPOSE = "services:\n  web:\n    image: 'nginx:alpine'\n    volumes:\n      - '/etc/timezone:/etc/timezone:ro'\n    environment:\n      - 'FOO=${FOO:-bar}'\n";
const MAGIC_COMPOSE = "services:\n  web:\n    image: 'nginx:alpine'\n    environment:\n      - SERVICE_URL_WEB_80\n      - 'FOO=${FOO:-bar}'\n      - 'ADMIN_PASSWORD=${SERVICE_PASSWORD_ADMIN}'\n";
const SERVICE_BACKUP = ["update scheduled_database_backups set database_type = 'App\\Models\\ServiceDatabase', database_id = 1 where id = 2"];
add({ name: "service clone: clone", token: "write", method: "POST", path: SVC_CLONE(), body: { destination_uuid: D_MAIN }, after: SERVICE_CLONE_AFTER });
add({ name: "service clone: with a name", token: "write", method: "POST", path: SVC_CLONE(), body: { destination_uuid: D_MAIN, name: "service-copy" }, after: SERVICE_CLONE_AFTER });
add({ name: "service clone: a blank name", token: "write", method: "POST", path: SVC_CLONE(), body: { destination_uuid: D_MAIN, name: "   ", clone_volumes: false }, after: SERVICE_CLONE_AFTER });
add({ name: "service clone: a clone of a clone", token: "write", method: "POST", path: SVC_CLONE(), setup: ["update services set name = 'parity-service-clone-abcdefgh1-clone-zyxwvut9' where id = 1"], body: { destination_uuid: D_MAIN }, after: SERVICE_CLONE_AFTER });
add({ name: "service clone: a long name", token: "write", method: "POST", path: SVC_CLONE(), setup: [`update services set name = '${"s".repeat(250)}' where id = 1`], body: { destination_uuid: D_MAIN }, after: SERVICE_CLONE_AFTER });
add({ name: "service clone: no volumes to copy", token: "root", method: "POST", path: SVC_CLONE(), body: { destination_uuid: D_MAIN, clone_volumes: true }, after: SERVICE_CLONE_AFTER });
add({ name: "service clone: the volumes without deploy", token: "write", method: "POST", path: SVC_CLONE(), body: { destination_uuid: D_MAIN, clone_volumes: "1" }, after: { count: SERVICE_CLONE_AFTER.count } });
add({ name: "service clone: named volumes", token: "write", method: "POST", path: SVC_CLONE(), setup: SVC_COMPOSE(NAMED_VOLUME_COMPOSE), body: { destination_uuid: D_MAIN }, after: SERVICE_CLONE_AFTER });
add({ name: "service clone: named volumes, the volumes", token: "root", method: "POST", path: SVC_CLONE(), setup: SVC_COMPOSE(NAMED_VOLUME_COMPOSE), body: { destination_uuid: D_MAIN, clone_volumes: true }, after: SERVICE_CLONE_AFTER });
add({ name: "service clone: a file mount", token: "write", method: "POST", path: SVC_CLONE(), setup: SVC_COMPOSE(BIND_COMPOSE), body: { destination_uuid: D_MAIN }, after: SERVICE_CLONE_AFTER });
add({ name: "service clone: a host path", token: "write", method: "POST", path: SVC_CLONE(), setup: SVC_COMPOSE(HOST_COMPOSE), body: { destination_uuid: D_MAIN }, after: SERVICE_CLONE_AFTER });
add({ name: "service clone: generated values", token: "write", method: "POST", path: SVC_CLONE(), setup: SVC_COMPOSE(MAGIC_COMPOSE), body: { destination_uuid: D_MAIN }, after: SERVICE_CLONE_AFTER });
add({ name: "service clone: a database's backup schedule", token: "write", method: "POST", path: SVC_CLONE(), setup: SERVICE_BACKUP, body: { destination_uuid: D_MAIN }, after: SERVICE_CLONE_AFTER });
add({ name: "service clone: its secret manager", token: "write", method: "POST", path: SVC_CLONE(), ...LINKED(INFISICAL_LINK), body: { destination_uuid: D_MAIN }, after: SERVICE_CLONE_AFTER });
add({ name: "service clone: to another server", token: "write", method: "POST", path: SVC_CLONE(), ...SECOND, body: { destination_uuid: D_SECOND }, after: SERVICE_CLONE_AFTER });
add({ name: "service clone: no body", token: "write", method: "POST", path: SVC_CLONE() });
add({ name: "service clone: not JSON", token: "write", method: "POST", path: SVC_CLONE(), raw: "destination_uuid=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "service clone: validation", token: "write", method: "POST", path: SVC_CLONE(), body: { destination_uuid: 1, name: "x!", clone_volumes: "maybe", environment_uuid: E_STAGING } });
add({ name: "service clone: a short name", token: "write", method: "POST", path: SVC_CLONE(), body: { destination_uuid: D_MAIN, name: "ab" } });
add({ name: "service clone: unknown destination", token: "write", method: "POST", path: SVC_CLONE(), body: { destination_uuid: "nonexistentuuid" } });
add({ name: "service clone: another team's destination", token: "write", method: "POST", path: SVC_CLONE(), body: { destination_uuid: D_OTHER } });
add({ name: "service clone: a build server", token: "write", method: "POST", path: SVC_CLONE(), setup: ["update server_settings set server_role = 'build' where server_id = 1"], body: { destination_uuid: D_MAIN } });
add({ name: "service clone: unknown service", token: "write", method: "POST", path: SVC_CLONE("nonexistentuuid"), body: { destination_uuid: D_MAIN } });
add({ name: "service clone: another team's service", token: "write", method: "POST", path: SVC_CLONE(SV_OTHER), body: { destination_uuid: D_MAIN } });
add({ name: "service clone: unknown service, empty JSON", token: "write", method: "POST", path: SVC_CLONE("nonexistentuuid"), raw: "{}" });
add({ name: "service clone: unknown service, validation first", token: "write", method: "POST", path: SVC_CLONE("nonexistentuuid"), body: { name: "x" } });
add({ name: "service clone: with a read token", token: "read", method: "POST", path: SVC_CLONE(), body: { destination_uuid: D_MAIN } });

// ── DP-107: the instance's API and MCP switches (OtherController), the token's team (TeamController::update_current_team)
// and a server's update (ServersController::update_server) ──
// POST /disable, /mcp/enable and /mcp/disable are routes/api.php's first group: api.ip.allowed, auth:sanctum, api.token.team
// and api.ability:write, without ApiAllowed and api.sensitive. Each asks for a root-team token of the instance admin
// (DP-106's `rootTeamToken`: the platform operator in Freeploy); `after` reads row 0 of instance_settings.
const INSTANCE_AFTER = { settings: "select is_api_enabled, is_mcp_server_enabled from instance_settings where id = 0" };
const MCP_ON = "update instance_settings set is_mcp_server_enabled = true where id = 0";
add({ name: "instance: disable the API, a team token", token: "root", method: "POST", path: "/api/v1/disable", after: INSTANCE_AFTER });
add({ name: "instance: disable the API, a root-team token", method: "POST", path: "/api/v1/disable", ...AS_ROOT_TEAM("root"), after: INSTANCE_AFTER });
add({ name: "instance: disable the API, a root-team write token", method: "POST", path: "/api/v1/disable", ...AS_ROOT_TEAM("write"), after: INSTANCE_AFTER });
add({ name: "instance: disable the API, a root-team read token", method: "POST", path: "/api/v1/disable", ...AS_ROOT_TEAM("read"), after: INSTANCE_AFTER });
add({ name: "instance: disable the API, a team write token", token: "write", method: "POST", path: "/api/v1/disable", after: INSTANCE_AFTER });
add({ name: "instance: disable the API while it is disabled", token: "root", instance: { is_api_enabled: false }, method: "POST", path: "/api/v1/disable" });
add({ name: "instance: disable the API with GET", token: "root", method: "GET", path: "/api/v1/disable" });
add({ name: "instance: disable the API with GET, a read token", token: "read", method: "GET", path: "/api/v1/disable" });
add({ name: "instance: disable the API, no token", method: "POST", path: "/api/v1/disable" });
add({ name: "allowed: the instance routes refuse an address not allowed", token: "root", instance: { allowed_ips: "198.51.100.1" }, method: "POST", path: "/api/v1/mcp/enable" });
add({ name: "allowed: the instance routes refuse an address not allowed, no token", instance: { allowed_ips: "198.51.100.1" }, method: "POST", path: "/api/v1/mcp/enable" });
add({ name: "allowed: the instance routes refuse an address not allowed, a read token", token: "read", instance: { allowed_ips: "198.51.100.1" }, method: "POST", path: "/api/v1/mcp/enable" });
add({ name: "allowed: the instance routes take an allowed address", token: "root", ip: "198.51.100.1", instance: { allowed_ips: "198.51.100.1" }, method: "POST", path: "/api/v1/mcp/enable" });
add({ name: "instance: enable the MCP server, a root-team token", method: "POST", path: "/api/v1/mcp/enable", ...AS_ROOT_TEAM("root"), after: INSTANCE_AFTER });
add({ name: "instance: enable the MCP server, a root-team write token", method: "POST", path: "/api/v1/mcp/enable", ...AS_ROOT_TEAM("write"), after: INSTANCE_AFTER });
add({ name: "instance: enable the MCP server, a root-team read token", method: "POST", path: "/api/v1/mcp/enable", ...AS_ROOT_TEAM("read"), after: INSTANCE_AFTER });
add({ name: "instance: enable the MCP server, a team token", token: "root", method: "POST", path: "/api/v1/mcp/enable", after: INSTANCE_AFTER });
add({ name: "instance: enable the MCP server while the API is disabled", instance: { is_api_enabled: false }, method: "POST", path: "/api/v1/mcp/enable", ...AS_ROOT_TEAM("root"), after: INSTANCE_AFTER });
add({ name: "instance: enable the MCP server, already enabled", method: "POST", path: "/api/v1/mcp/enable", ...AS_ROOT_TEAM("root"), setupCoolify: [...ROOT_TEAM_SETUP, MCP_ON], after: INSTANCE_AFTER });
add({ name: "instance: disable the MCP server, a root-team token", method: "POST", path: "/api/v1/mcp/disable", ...AS_ROOT_TEAM("root"), setupCoolify: [...ROOT_TEAM_SETUP, MCP_ON], after: INSTANCE_AFTER });
add({ name: "instance: disable the MCP server, already disabled", method: "POST", path: "/api/v1/mcp/disable", ...AS_ROOT_TEAM("write"), after: INSTANCE_AFTER });
add({ name: "instance: disable the MCP server, a team token", token: "root", method: "POST", path: "/api/v1/mcp/disable", setupCoolify: [MCP_ON], after: INSTANCE_AFTER });
add({ name: "instance: disable the MCP server, a member", token: "memberRead", method: "POST", path: "/api/v1/mcp/disable" });
add({ name: "instance: enable the MCP server with GET", token: "root", method: "GET", path: "/api/v1/mcp/enable" });
add({ name: "instance: enable the MCP server with a body", method: "POST", path: "/api/v1/mcp/enable", ...AS_ROOT_TEAM("root"), body: { enabled: false }, after: INSTANCE_AFTER });

// PATCH /team: the token's team's two settings (Freeploy: the org's, membership-worker's). `after` reads team 1.
const TEAM_AFTER = { team: "select name, description, is_build_server_fallback_enabled, scan_images_on_new_servers from teams where id = 1" };
add({ name: "team: update both settings", token: "write", method: "PATCH", path: "/api/v1/team", body: { is_build_server_fallback_enabled: false, scan_images_on_new_servers: true }, after: TEAM_AFTER });
add({ name: "team: update the build server fallback", token: "root", method: "PATCH", path: "/api/v1/team", body: { is_build_server_fallback_enabled: "0" }, after: TEAM_AFTER });
add({ name: "team: update image scanning of new servers", token: "write", method: "PATCH", path: "/api/v1/team", body: { scan_images_on_new_servers: 1 }, after: TEAM_AFTER });
add({ name: "team: update, the same values", token: "write", method: "PATCH", path: "/api/v1/team", body: { is_build_server_fallback_enabled: true, scan_images_on_new_servers: false }, after: TEAM_AFTER });
add({ name: "team: update, nothing", token: "write", method: "PATCH", path: "/api/v1/team", raw: "{}", after: TEAM_AFTER });
add({ name: "team: update, no body", token: "write", method: "PATCH", path: "/api/v1/team", after: TEAM_AFTER });
add({ name: "team: update, values that are not booleans", token: "write", method: "PATCH", path: "/api/v1/team", body: { is_build_server_fallback_enabled: "yes", scan_images_on_new_servers: 2 }, after: TEAM_AFTER });
add({ name: "team: update, null values", token: "write", method: "PATCH", path: "/api/v1/team", body: { is_build_server_fallback_enabled: null, scan_images_on_new_servers: null }, after: TEAM_AFTER });
add({ name: "team: update, one null value", token: "write", method: "PATCH", path: "/api/v1/team", body: { is_build_server_fallback_enabled: null, scan_images_on_new_servers: true }, after: TEAM_AFTER });
add({ name: "team: update, the name and description", token: "write", method: "PATCH", path: "/api/v1/team", body: { name: "Renamed", description: "New", scan_images_on_new_servers: true }, after: TEAM_AFTER });
add({ name: "team: update, only fields that are not allowed", token: "write", method: "PATCH", path: "/api/v1/team", body: { name: "Renamed" }, after: TEAM_AFTER });
add({ name: "team: update, a field in the query", token: "write", method: "PATCH", path: "/api/v1/team?scan_images_on_new_servers=1", body: { is_build_server_fallback_enabled: false }, after: TEAM_AFTER });
add({ name: "team: update with a read token", token: "read", method: "PATCH", path: "/api/v1/team", body: { scan_images_on_new_servers: true } });
add({
  name: "team: update, then show",
  token: "write",
  method: "PATCH",
  path: "/api/v1/team",
  sequence: [
    { token: "write", method: "PATCH", path: "/api/v1/team", body: { is_build_server_fallback_enabled: false, scan_images_on_new_servers: true } },
    { token: "read", method: "GET", path: "/api/v1/team" },
  ],
});

// PATCH /servers/{uuid}: the fixture's server of team 1 (203.0.113.10:22, root, key 1). `after` reads its row and settings.
const SERVER_UPDATE_AFTER = {
  server: "select name, description, ip, ip_previous, port, \"user\", private_key_id, proxy::jsonb->>'type' as proxy_type, proxy::jsonb->>'status' as proxy_status from servers where id = 1",
  settings:
    "select server_role, is_build_server, is_terminal_enabled, concurrent_builds, dynamic_timeout, deployment_queue_limit, server_disk_usage_notification_threshold, server_disk_usage_check_frequency, server_disk_usage_notification_interval_hours, connection_timeout, server_timezone, backup_compression_cpu_percentage, wildcard_domain, public_ipv4, public_ipv6, ssh_host_key, ssh_host_key_source, ssh_host_key_trusted_at is not null as host_key_trusted from server_settings where server_id = 1",
};
const SU = (uuid = S_MAIN) => `/api/v1/servers/${uuid}`;
const TRUSTED_KEY = `update server_settings set ssh_host_key = '${HOST_KEY}', ssh_host_key_source = 'api', ssh_host_key_trusted_at = '2025-12-31 00:00:00' where server_id = 1`;
const BUILD_ONLY = "update server_settings set server_role = 'build', is_build_server = true where server_id = 1";
add({ name: "servers: update, the name and description", token: "write", method: "PATCH", path: SU(), body: { name: "renamed-server", description: "Renamed" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, the connection", token: "write", method: "PATCH", path: SU(), setup: [TRUSTED_KEY], body: { ip: "203.0.113.40", port: 2222, user: "deploy", private_key_uuid: K_FREE }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, the same connection", token: "write", method: "PATCH", path: SU(), setup: [TRUSTED_KEY], body: { ip: "203.0.113.10", port: "22", user: "root", private_key_uuid: K_MAIN }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, the user only", token: "write", method: "PATCH", path: SU(), setup: [TRUSTED_KEY], body: { user: " admin " }, after: SERVER_UPDATE_AFTER });
add({
  name: "servers: update, every setting",
  token: "write",
  method: "PATCH",
  path: SU(),
  body: {
    concurrent_builds: 4,
    dynamic_timeout: "7200",
    deployment_queue_limit: 10,
    server_disk_usage_notification_threshold: 90,
    server_disk_usage_check_frequency: "0 * * * *",
    server_disk_usage_notification_interval_hours: 24,
    connection_timeout: 30,
    server_timezone: "Europe/Berlin",
    backup_compression_cpu_percentage: 50,
    is_terminal_enabled: false,
    wildcard_domain: "https://apps.example.com",
    public_ipv4: "203.0.113.11",
    public_ipv6: "2001:db8::11",
  },
  after: SERVER_UPDATE_AFTER,
});
add({ name: "servers: update, a human frequency", token: "write", method: "PATCH", path: SU(), body: { server_disk_usage_check_frequency: "daily", is_terminal_enabled: "1" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, settings cleared", token: "write", method: "PATCH", path: SU(), setup: ["update server_settings set wildcard_domain = 'https://old.example.com', public_ipv4 = '203.0.113.11' where server_id = 1"], body: { wildcard_domain: null, public_ipv4: null, public_ipv6: null, is_terminal_enabled: null, concurrent_builds: null, description: null }, after: SERVER_UPDATE_AFTER });
add({
  name: "servers: update, invalid fields",
  token: "write",
  method: "PATCH",
  path: SU(),
  body: {
    name: "a\nb",
    description: "<bad>",
    ip: "not an ip!",
    port: 70000,
    user: "-root",
    private_key_uuid: 5,
    server_role: "worker",
    is_build_server: "yes",
    instant_validate: "no",
    proxy_type: 3,
    concurrent_builds: 0,
    dynamic_timeout: "x",
    deployment_queue_limit: 0,
    server_disk_usage_notification_threshold: 101,
    server_disk_usage_check_frequency: 5,
    server_disk_usage_notification_interval_hours: 721,
    connection_timeout: 301,
    is_terminal_enabled: "maybe",
    wildcard_domain: "not a url",
    public_ipv4: "1.2.3",
    public_ipv6: "zz::1",
    server_timezone: "Mars/Base",
    backup_compression_cpu_percentage: 30,
    ssh_host_key: "x",
    extra: 1,
  },
  after: SERVER_UPDATE_AFTER,
});
add({ name: "servers: update, a short name and a port that is not a number", token: "write", method: "PATCH", path: SU(), body: { name: "ab", port: "ssh", public_ipv4: "2001:db8::1", public_ipv6: "203.0.113.11", backup_compression_cpu_percentage: "abc" } });
add({ name: "servers: update, an empty timezone", token: "write", method: "PATCH", path: SU(), body: { server_timezone: "" } });
add({ name: "servers: update, a timezone that is not a string", token: "write", method: "PATCH", path: SU(), body: { server_timezone: 5 } });
add({ name: "servers: update, a null timezone", token: "write", method: "PATCH", path: SU(), body: { server_timezone: null } });
add({ name: "servers: update, an empty name", token: "write", method: "PATCH", path: SU(), body: { name: "", user: "" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, an invalid frequency", token: "write", method: "PATCH", path: SU(), body: { server_disk_usage_check_frequency: "every now and then", name: "kept-out" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, unknown", token: "write", method: "PATCH", path: SU("nonexistentuuid"), body: { name: "renamed-server" } });
add({ name: "servers: update, unknown and invalid", token: "write", method: "PATCH", path: SU("nonexistentuuid"), body: { port: 0 } });
add({ name: "servers: update another team's", token: "root", method: "PATCH", path: SU(S_OTHER), body: { name: "mine-now" } });
add({ name: "servers: update, an endpoint in use", token: "write", method: "PATCH", path: SU(), ...SECOND, body: { ip: "203.0.113.30" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, the endpoint in use on another port", token: "write", method: "PATCH", path: SU(), ...SECOND, body: { ip: "203.0.113.30", port: 2200 }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, an invalid proxy type", token: "write", method: "PATCH", path: SU(), body: { proxy_type: "apache", name: "kept-out" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, an unknown private key", token: "write", method: "PATCH", path: SU(), body: { private_key_uuid: "nonexistentuuid" } });
add({ name: "servers: update, another team's private key", token: "write", method: "PATCH", path: SU(), body: { private_key_uuid: K_OTHER } });
add({ name: "servers: update, the legacy flag against the role", token: "write", method: "PATCH", path: SU(), body: { is_build_server: true, server_role: "both" } });
add({ name: "servers: update, build only with resources", token: "write", method: "PATCH", path: SU(), body: { server_role: "build" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, build only with the legacy flag and resources", token: "write", method: "PATCH", path: SU(), body: { is_build_server: true } });
add({ name: "servers: update, build only", token: "write", method: "PATCH", path: SU(), setup: RESOURCES_GONE, body: { server_role: "build" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, a build server back with the legacy flag", token: "write", method: "PATCH", path: SU(), setup: [...RESOURCES_GONE, BUILD_ONLY], body: { is_build_server: false }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, the legacy flag off on a regular server", token: "write", method: "PATCH", path: SU(), body: { is_build_server: false }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, deployments only without a build server", token: "write", method: "PATCH", path: SU(), body: { server_role: "deployment" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, the same role", token: "write", method: "PATCH", path: SU(), body: { server_role: "both" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, the proxy type without deploy", token: "write", method: "PATCH", path: SU(), body: { proxy_type: "caddy", name: "kept-out" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, the proxy type", token: "root", method: "PATCH", path: SU(), body: { proxy_type: "caddy" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, the same proxy type", token: "write", method: "PATCH", path: SU(), body: { proxy_type: "Traefik" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, validating at once", token: "write", method: "PATCH", path: SU(), body: { instant_validate: true, name: "kept-out" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, not validating", token: "write", method: "PATCH", path: SU(), body: { instant_validate: false, name: "validated-later" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, a transferred server's connection", token: "write", method: "PATCH", path: SU(), setup: [TRANSFERRED], body: { ip: "203.0.113.40", user: "root", port: 2222, private_key_uuid: K_FREE }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, a transferred server's name", token: "write", method: "PATCH", path: SU(), setup: [TRANSFERRED], body: { name: "renamed-server", ip: "203.0.113.10" }, after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, nothing", token: "write", method: "PATCH", path: SU(), raw: "{}", after: SERVER_UPDATE_AFTER });
add({ name: "servers: update, not JSON", token: "write", method: "PATCH", path: SU(), raw: "name=renamed", contentType: "application/x-www-form-urlencoded" });
add({ name: "servers: update with a read token", token: "read", method: "PATCH", path: SU(), body: { name: "renamed-server" } });
// A member with write may not update a server (ServerPolicy::update is a team admin's).
denial("servers: update, the name and description", "memberWrite", WRITE_DELETE, WRITER);
// GET /audit-events: the team's audit events (AuditEventsController), a team admin's. The fixture has none (a case's
// transaction is rolled back, so no request leaves one: AuditEvent writes after the commit), so `setupCoolify` makes them —
// three of team 1 that Freeploy records too (the team renamed, an invitation, a role changed: DP-75's TEAM_EVENTS), one of
// team 2 and one of the instance (team_id null) — and the Freeploy test gives events-worker the same three entries.
const AUDIT_ROWS = [
  "insert into audit_events (id, team_id, event, source, action, level, actor_type, actor_id, actor_name, actor_email, resource_type, resource_uuid, resource_name, description, created_at) values (1, 1, 'ui.team.updated', 'ui', 'updated', 'info', 'user', 1, 'Parity Owner', 'owner@example.com', 'team', null, 'Parity Team', 'Parity Team Updated', '2025-12-20 10:00:00')",
  "insert into audit_events (id, team_id, event, source, action, level, actor_type, actor_id, actor_name, actor_email, resource_type, resource_uuid, resource_name, description, created_at) values (2, 1, 'ui.team_invitation.created', 'ui', 'created', 'info', 'user', 1, 'Parity Owner', 'owner@example.com', 'team_invitation', null, null, 'Team Invitation Created', '2025-12-21 10:00:00')",
  "insert into audit_events (id, team_id, event, source, action, level, actor_type, actor_id, actor_name, actor_email, resource_type, resource_uuid, resource_name, description, created_at) values (3, 1, 'ui.team_member.role_updated', 'ui', 'role_updated', 'info', 'user', 4, 'Parity Admin', 'admin@example.com', 'team_member', null, 'Parity Member', 'Parity Member Role Updated', '2025-12-22 10:00:00')",
  "insert into audit_events (id, team_id, event, source, action, level, actor_type, actor_id, actor_name, actor_email, resource_type, resource_uuid, resource_name, description, created_at) values (4, 2, 'ui.team.updated', 'ui', 'updated', 'info', 'user', 3, 'Other Owner', 'other@example.com', 'team', null, 'Other Team', 'Other Team Updated', '2025-12-23 10:00:00')",
  "insert into audit_events (id, team_id, event, source, action, level, actor_type, actor_id, actor_name, actor_email, resource_type, resource_uuid, resource_name, description, created_at) values (5, null, 'system.instance.updated', 'system', 'updated', 'info', 'system', null, null, null, 'instance', null, null, 'Instance Updated', '2025-12-24 10:00:00')",
];
const AE = "/api/v1/audit-events";
const AUDITED = { setupCoolify: AUDIT_ROWS };
add({ name: "audit events: list", token: "root", method: "GET", path: AE, ...AUDITED });
add({ name: "audit events: list with a read token", token: "read", method: "GET", path: AE, ...AUDITED });
add({ name: "audit events: list with read:sensitive", token: "sensitive", method: "GET", path: AE, ...AUDITED });
add({ name: "audit events: none", token: "read", method: "GET", path: AE });
add({ name: "audit events: a page", token: "read", method: "GET", path: `${AE}?per_page=1&page=2`, ...AUDITED });
add({ name: "audit events: the last page", token: "read", method: "GET", path: `${AE}?per_page=2&page=2`, ...AUDITED });
add({ name: "audit events: past the last page", token: "read", method: "GET", path: `${AE}?page=9`, ...AUDITED });
add({ name: "audit events: searched", token: "read", method: "GET", path: `${AE}?search=Member`, ...AUDITED });
add({ name: "audit events: searched by email, without read:sensitive", token: "read", method: "GET", path: `${AE}?search=admin%40example.com`, ...AUDITED });
add({ name: "audit events: searched by email", token: "root", method: "GET", path: `${AE}?search=admin%40example.com`, ...AUDITED });
add({ name: "audit events: searched, case-sensitive", token: "read", method: "GET", path: `${AE}?search=member`, ...AUDITED });
add({ name: "audit events: an empty search", token: "read", method: "GET", path: `${AE}?search=&action=&source=`, ...AUDITED });
add({ name: "audit events: by action", token: "read", method: "GET", path: `${AE}?action=created`, ...AUDITED });
add({ name: "audit events: by source", token: "read", method: "GET", path: `${AE}?source=api`, ...AUDITED });
add({ name: "audit events: by every source", token: "read", method: "GET", path: `${AE}?source=all&action=all`, ...AUDITED });
add({ name: "audit events: invalid parameters", token: "read", method: "GET", path: `${AE}?per_page=0&page=abc&source=cli&search=${"s".repeat(256)}&action=${"a".repeat(256)}` });
add({ name: "audit events: too many a page", token: "read", method: "GET", path: `${AE}?per_page=101&page=0` });
add({ name: "audit events: a page that is not a number", token: "read", method: "GET", path: `${AE}?per_page=ten` });
add({ name: "audit events: a member", token: "memberRead", method: "GET", path: AE, ...AUDITED });
add({ name: "audit events with a write-only token", token: "writeOnly", method: "GET", path: AE });
add({ name: "audit events: POST", token: "root", method: "POST", path: AE, body: { x: 1 } });
// Forty events of team 1 (a minute apart), two a page: Laravel's UrlWindow puts '...' between the pages.
const MANY_AUDIT_ROWS = [
  "insert into audit_events (team_id, event, source, action, level, actor_type, actor_id, actor_name, actor_email, resource_type, resource_uuid, resource_name, description, created_at) select 1, 'ui.team.updated', 'ui', 'updated', 'info', 'user', 1, 'Parity Owner', 'owner@example.com', 'team', null, 'Parity Team', 'Parity Team Updated', timestamp '2025-12-01 00:00:00' + make_interval(mins => g) from generate_series(0, 39) g",
];
for (const page of [1, 10, 18, 25]) add({ name: `audit events: many pages, page ${page}`, token: "read", method: "GET", path: `${AE}?per_page=2&page=${page}`, setupCoolify: MANY_AUDIT_ROWS });

// ── DP-110: cloud-init scripts (CloudInitScriptsController) ─────────────────
// A case's scripts are `cloudInitScripts`: emit.php makes them through the model (the encrypted cast), the test with
// Freeploy's insert and the org's key. ValidCloudInitYaml's messages are Symfony YAML's ParseException messages.
const CIS = "/api/v1/cloud-init-scripts";
const CIS_BASE = "i1parityinitscript000001";
const CIS_BASH = "i2parityinitscript000002";
const CIS_OTHER = "i3otherinitscript0000003";
const CIS_ROWS = [
  { uuid: CIS_BASE, team: T1, name: "Base packages", script: "#cloud-config\npackages:\n  - curl\n  - git\n", created_at: "2025-12-01 10:00:00" },
  { uuid: CIS_BASH, team: T1, name: "Bash setup", script: "#!/bin/bash\napt-get update -y\n", created_at: "2025-12-02 10:00:00" },
  { uuid: CIS_OTHER, team: T2, name: "Other team's script", script: "#cloud-config\nruncmd: [ls]\n", created_at: "2025-12-03 10:00:00" },
];
const SCRIPTS = { cloudInitScripts: CIS_ROWS };
const CIS_AFTER = {
  scripts: `select case when uuid in ('${CIS_BASE}', '${CIS_BASH}') then uuid end as fixture_uuid, uuid ~ '^[a-z0-9]{24}$' as public_id, name, script is not null as has_script, updated_at > created_at as updated from cloud_init_scripts where uuid <> '${CIS_OTHER}' order by name`,
};
const CLOUD_CONFIG = "#cloud-config\npackage_update: true\npackages:\n  - nginx\nruncmd:\n  - systemctl enable --now nginx\n";
add({ name: "cloud-init scripts: list", token: "root", method: "GET", path: CIS, ...SCRIPTS });
add({ name: "cloud-init scripts: list with a read token", token: "read", method: "GET", path: CIS, ...SCRIPTS });
add({ name: "cloud-init scripts: list with read:sensitive", token: "sensitive", method: "GET", path: CIS, ...SCRIPTS });
add({ name: "cloud-init scripts: none", token: "read", method: "GET", path: CIS });
add({ name: "cloud-init scripts: list, a member", token: "memberRead", method: "GET", path: CIS, ...SCRIPTS });
add({ name: "cloud-init scripts: list with a write-only token", token: "writeOnly", method: "GET", path: CIS, ...SCRIPTS });
add({ name: "cloud-init scripts: show", token: "read", method: "GET", path: `${CIS}/${CIS_BASE}`, ...SCRIPTS });
add({ name: "cloud-init scripts: show with read:sensitive", token: "sensitive", method: "GET", path: `${CIS}/${CIS_BASE}`, ...SCRIPTS });
add({ name: "cloud-init scripts: show, unknown", token: "read", method: "GET", path: `${CIS}/nonexistentuuid`, ...SCRIPTS });
add({ name: "cloud-init scripts: show, another team's", token: "read", method: "GET", path: `${CIS}/${CIS_OTHER}`, ...SCRIPTS });
add({ name: "cloud-init scripts: show, a member", token: "memberRead", method: "GET", path: `${CIS}/${CIS_BASE}`, ...SCRIPTS });
add({ name: "cloud-init scripts: create", token: "write", method: "POST", path: CIS, body: { name: "Web server", script: CLOUD_CONFIG }, after: CIS_AFTER });
add({ name: "cloud-init scripts: create next to the others", token: "write", method: "POST", path: CIS, body: { name: "Web server", script: CLOUD_CONFIG }, ...SCRIPTS, after: CIS_AFTER });
add({ name: "cloud-init scripts: create with the root token", token: "root", method: "POST", path: CIS, body: { name: "Web server", script: CLOUD_CONFIG }, after: CIS_AFTER });
add({ name: "cloud-init scripts: create, a bash script", token: "write", method: "POST", path: CIS, body: { name: "  Bash  ", script: "#!/bin/sh\n\techo tabs are fine here: yes\n" }, after: CIS_AFTER });
add({ name: "cloud-init scripts: create, YAML without its header", token: "write", method: "POST", path: CIS, body: { name: "No header", script: "packages:\n  - htop\nruncmd:\n  - [ls, -l, /]\n" }, after: CIS_AFTER });
add({ name: "cloud-init scripts: create, a plain line", token: "write", method: "POST", path: CIS, body: { name: "Plain", script: "echo hello" }, after: CIS_AFTER });
const BAD_YAML = [
  ["a duplicate key", "#cloud-config\npackages: [a]\npackages: [b]\n"],
  ["a tab", "#cloud-config\npackages:\n\t- curl\n"],
  ["an unclosed flow", "#cloud-config\nruncmd: [ls, -l\n"],
  ["an unclosed quote", "#cloud-config\nwrite_files:\n  - path: \"/etc/x\n"],
  ["a colon in a value", "#cloud-config\nhostname: web: 1\n"],
  ["a sequence in a mapping", "#cloud-config\npackages: [a]\n- b\n"],
  ["a missing reference", "#cloud-config\nruncmd: *steps\n"],
  ["an indentation problem", "#cloud-config\nusers:\n    - name: a\n  - name: b\n"],
  ["two documents", "#cloud-config\na: 1\n---\nb: 2\n"],
  ["a custom tag", "#cloud-config\na: !include x.yaml\n"],
  ["a reserved indicator", "#cloud-config\na: @b\n"],
  ["mapping values in a plain multi-line", "apt-get update\napt-get install: nginx\n"],
  ["a mapping in a sequence, without the header", "- ls\nkey: value\n"],
  ["an unquoted mapping value over lines", "a: one\n  b: two\n"],
];
for (const [what, script] of BAD_YAML) add({ name: `cloud-init scripts: create, invalid YAML, ${what}`, token: "write", method: "POST", path: CIS, body: { name: "Bad", script }, after: CIS_AFTER });
add({ name: "cloud-init scripts: create, invalid", token: "write", method: "POST", path: CIS, body: { name: "x".repeat(256), script: 5, extra: true } });
add({ name: "cloud-init scripts: create, the script a number", token: "write", method: "POST", path: CIS, body: { name: 7, script: 123 } });
add({ name: "cloud-init scripts: create, the script an array", token: "write", method: "POST", path: CIS, body: { name: "Array", script: ["a"] } });
add({ name: "cloud-init scripts: create, nothing", token: "write", method: "POST", path: CIS, body: { name: "", script: "  " } });
add({ name: "cloud-init scripts: create, an empty object", token: "write", method: "POST", path: CIS, raw: "{}" });
add({ name: "cloud-init scripts: create, not JSON", token: "write", method: "POST", path: CIS, raw: "name=x", contentType: "application/x-www-form-urlencoded" });
add({ name: "cloud-init scripts: create with a read token", token: "read", method: "POST", path: CIS, body: { name: "Web server", script: CLOUD_CONFIG } });
add({ name: "cloud-init scripts: update the name", token: "write", method: "PATCH", path: `${CIS}/${CIS_BASE}`, body: { name: "Renamed" }, ...SCRIPTS, after: CIS_AFTER });
add({ name: "cloud-init scripts: update the script", token: "root", method: "PATCH", path: `${CIS}/${CIS_BASE}`, body: { script: CLOUD_CONFIG }, ...SCRIPTS, after: CIS_AFTER });
add({ name: "cloud-init scripts: update the script with write", token: "write", method: "PATCH", path: `${CIS}/${CIS_BASH}`, body: { script: "#!/bin/bash\necho changed\n", name: "Bash setup" }, ...SCRIPTS, after: CIS_AFTER });
add({ name: "cloud-init scripts: update, nothing changes", token: "write", method: "PATCH", path: `${CIS}/${CIS_BASE}`, body: { name: "Base packages" }, ...SCRIPTS, after: CIS_AFTER });
add({ name: "cloud-init scripts: update, invalid YAML", token: "write", method: "PATCH", path: `${CIS}/${CIS_BASE}`, body: { script: "#cloud-config\npackages: [a]\npackages: [b]\n" }, ...SCRIPTS, after: CIS_AFTER });
add({ name: "cloud-init scripts: update, invalid", token: "write", method: "PATCH", path: `${CIS}/${CIS_BASE}`, body: { name: null, script: null, uuid: "x" }, ...SCRIPTS, after: CIS_AFTER });
add({ name: "cloud-init scripts: update, an empty object", token: "write", method: "PATCH", path: `${CIS}/${CIS_BASE}`, raw: "{}", ...SCRIPTS });
add({ name: "cloud-init scripts: update, unknown", token: "write", method: "PATCH", path: `${CIS}/nonexistentuuid`, body: { name: "x" }, ...SCRIPTS });
add({ name: "cloud-init scripts: update, another team's", token: "write", method: "PATCH", path: `${CIS}/${CIS_OTHER}`, body: { name: "x" }, ...SCRIPTS });
add({ name: "cloud-init scripts: update, not JSON", token: "write", method: "PATCH", path: `${CIS}/${CIS_BASE}`, raw: "name=x", contentType: "application/x-www-form-urlencoded", ...SCRIPTS });
add({ name: "cloud-init scripts: update with a read token", token: "read", method: "PATCH", path: `${CIS}/${CIS_BASE}`, body: { name: "x" }, ...SCRIPTS });
add({ name: "cloud-init scripts: delete", token: "delete", method: "DELETE", path: `${CIS}/${CIS_BASE}`, ...SCRIPTS, after: CIS_AFTER });
add({ name: "cloud-init scripts: delete, unknown", token: "delete", method: "DELETE", path: `${CIS}/nonexistentuuid`, ...SCRIPTS, after: CIS_AFTER });
add({ name: "cloud-init scripts: delete, another team's", token: "delete", method: "DELETE", path: `${CIS}/${CIS_OTHER}`, ...SCRIPTS, after: CIS_AFTER });
add({ name: "cloud-init scripts: delete with a write token", token: "write", method: "DELETE", path: `${CIS}/${CIS_BASE}`, ...SCRIPTS });
add({ name: "cloud-init scripts: delete, a member", token: "memberDelete", method: "DELETE", path: `${CIS}/${CIS_BASE}`, ...SCRIPTS, after: CIS_AFTER });
add({ name: "cloud-init scripts: PUT", token: "root", method: "PUT", path: `${CIS}/${CIS_BASE}`, body: { name: "x" }, ...SCRIPTS });
// A member with write may not create a script (CloudInitScriptPolicy::create is a team admin's).
denial("cloud-init scripts: create", "memberWrite", WRITE_DELETE, WRITER);

// ── DP-110: POST /servers/hetzner, /servers/vultr, /servers/digitalocean ─────
// The providers are faked per case (`http`): the account's SSH keys (the fixture key K_MAIN, ed25519, is found by its MD5
// fingerprint at Hetzner and DigitalOcean and by its text at Vultr, or uploaded), the server's creation and its address.
// The new server is the one after the fixture's; ValidateNewCloudServerJob is queued (faked) after it is stored.
const KEY_FACTS = JSON.parse(readFileSync(new URL("../ssh-keys/expected.json", import.meta.url), "utf8"))["ed25519.openssh"];
const CLOUD_AFTER = {
  server: "select case when name ~ '^[a-z]+(-[a-z]+)+-[a-z0-9]{24}$' then '<random-name>' else name end as name, description, ip, port, \"user\", private_key_id, cloud_provider_token_id, hetzner_server_id, hetzner_server_status, vultr_instance_id, vultr_instance_status, digitalocean_droplet_id, digitalocean_droplet_status, proxy::jsonb->>'type' as proxy_type, proxy::jsonb->>'status' as proxy_status, (proxy::jsonb->>'redirect_enabled')::boolean as redirect_enabled from servers where id > 2 order by id",
  settings: "select ss.server_role, ss.is_build_server from server_settings ss join servers s on s.id = ss.server_id where s.id > 2",
  destination: "select d.network from standalone_dockers d join servers s on s.id = d.server_id where s.id > 2",
};
const OTHER_PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherOtherOtherOtherOtherOtherOtherOtherOther other@host";

// Hetzner
const HZ_BASE = "https://api\\.hetzner\\.cloud/v1";
const HZS = "/api/v1/servers/hetzner";
const HZ_BODY = { cloud_provider_token_uuid: CT_HETZNER, location: "nbg1", server_type: "cx22", image: 67794396, name: "Web-1", private_key_uuid: K_MAIN };
const HZ_KEYS = (keys) => answer(`^GET ${HZ_BASE}/ssh_keys\\?page=1&per_page=50$`, { ssh_keys: keys, meta: { pagination: { page: 1, next_page: null } } });
const HZ_KNOWN = HZ_KEYS([{ id: 11, name: "laptop", fingerprint: "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99", public_key: OTHER_PUBLIC_KEY }, { id: 12, name: "Parity Key", fingerprint: KEY_FACTS.md5, public_key: KEY_FACTS.public }]);
const HZ_UPLOAD = answer(`^POST ${HZ_BASE}/ssh_keys$`, { ssh_key: { id: 13, name: "Parity Key", fingerprint: KEY_FACTS.md5, public_key: KEY_FACTS.public } }, 201);
const hzServer = (net = { ipv4: { ip: "198.51.100.21" }, ipv6: { ip: "2001:db8:21::/64" } }, id = 9001) => ({ server: { id, name: "web-1", status: "initializing", public_net: net } });
const HZ_CREATE = (body = hzServer(), status = 201) => answer(`^POST ${HZ_BASE}/servers$`, body, status);
const HZ_BACKUP = (status = 201) => answer(`^POST ${HZ_BASE}/servers/9001/actions/enable_backup$`, status < 300 ? { action: { id: 5, command: "enable_backup", status: "running" } } : { error: { code: "server_error", message: "Boom" } }, status);
const HZ_DELETE = answer(`^DELETE ${HZ_BASE}/servers/9001$`, { action: { id: 6, command: "delete_server" } });
add({ name: "server via Hetzner: create", token: "write", method: "POST", path: HZS, body: HZ_BODY, http: [HZ_KNOWN, HZ_CREATE()], after: CLOUD_AFTER });
add({ name: "server via Hetzner: create, the key uploaded", token: "write", method: "POST", path: HZS, body: HZ_BODY, http: [HZ_KEYS([]), HZ_UPLOAD, HZ_CREATE()], after: CLOUD_AFTER });
add({ name: "server via Hetzner: create, the deprecated token id and a generated name", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, cloud_provider_token_uuid: undefined, cloud_provider_token_id: CT_HETZNER, name: undefined }, http: [HZ_KNOWN, HZ_CREATE()], after: CLOUD_AFTER });
add({ name: "server via Hetzner: create, IPv6 only", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, enable_ipv4: false }, http: [HZ_KNOWN, HZ_CREATE(hzServer({ ipv4: null, ipv6: { ip: "2001:db8:21::/64" } }))], after: CLOUD_AFTER });
add({ name: "server via Hetzner: create, IPv6 without a prefix", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, enable_ipv4: "0", enable_ipv6: 1 }, http: [HZ_KNOWN, HZ_CREATE(hzServer({ ipv6: { ip: "2a01:4f8:c17:b8f::2" } }))], after: CLOUD_AFTER });
add({ name: "server via Hetzner: create, no protocol", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, enable_ipv4: false, enable_ipv6: "0" }, http: [] });
add({ name: "server via Hetzner: create, no address", token: "write", method: "POST", path: HZS, body: HZ_BODY, http: [HZ_KNOWN, HZ_CREATE(hzServer({ ipv4: null, ipv6: null })), HZ_DELETE], after: CLOUD_AFTER });
add({ name: "server via Hetzner: create with backups", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, enable_backups: true }, http: [HZ_KNOWN, HZ_CREATE(), HZ_BACKUP()], after: CLOUD_AFTER });
add({ name: "server via Hetzner: create, backups refused", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, enable_backups: 1 }, http: [HZ_KNOWN, HZ_CREATE(), HZ_BACKUP(500)], after: CLOUD_AFTER });
add({ name: "server via Hetzner: create with keys, firewalls, networks and a script, without validating", token: "root", method: "POST", path: HZS, body: { ...HZ_BODY, hetzner_ssh_key_ids: [12, 31, "31", 32], hetzner_firewall_ids: [7, "7", 8], hetzner_network_ids: ["41", 42], cloud_init_script: CLOUD_CONFIG, instant_validate: false }, http: [HZ_KNOWN, HZ_CREATE()], after: CLOUD_AFTER });
add({ name: "server via Hetzner: create and validate", token: "root", method: "POST", path: HZS, body: HZ_BODY, http: [HZ_KNOWN, HZ_CREATE()], after: CLOUD_AFTER });
add({ name: "server via Hetzner: create with a deploy token and a bash script", token: "root", method: "POST", path: HZS, body: { ...HZ_BODY, cloud_init_script: "#!/bin/bash\necho hi\n", instant_validate: "0" }, http: [HZ_KNOWN, HZ_CREATE()], after: CLOUD_AFTER });
for (const [what, script] of BAD_YAML.slice(0, 8)) add({ name: `server via Hetzner: create, invalid cloud-init YAML, ${what}`, token: "root", method: "POST", path: HZS, body: { ...HZ_BODY, cloud_init_script: script }, http: [] });
add({ name: "server via Hetzner: create, a script without deploy", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, cloud_init_script: CLOUD_CONFIG }, http: [] });
add({ name: "server via Hetzner: create, extra keys without deploy", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, hetzner_ssh_key_ids: [31] }, http: [] });
add({ name: "server via Hetzner: create, validating without deploy", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, instant_validate: true }, http: [] });
add({ name: "server via Hetzner: create, Hetzner refuses", token: "write", method: "POST", path: HZS, body: HZ_BODY, http: [HZ_KNOWN, HZ_CREATE({ error: { code: "invalid_input", message: "invalid input in field 'server_type'", details: { fields: [{ name: "server_type", messages: ["unknown"] }] } } }, 422)], after: CLOUD_AFTER });
add({ name: "server via Hetzner: create, rate limited", token: "write", method: "POST", path: HZS, body: HZ_BODY, http: [answer(`^GET ${HZ_BASE}/ssh_keys`, { error: { code: "rate_limit_exceeded", message: "limit" } }, 429, { "Retry-After": "12" })], after: CLOUD_AFTER });
add({ name: "server via Hetzner: create, a key without a fingerprint", token: "write", method: "POST", path: HZS, body: HZ_BODY, http: [HZ_KEYS([{ id: 11, name: "odd" }])], after: CLOUD_AFTER });
add({ name: "server via Hetzner: create, the upload answers no key", token: "write", method: "POST", path: HZS, body: HZ_BODY, http: [HZ_KEYS([]), answer(`^POST ${HZ_BASE}/ssh_keys$`, {}, 201)], after: CLOUD_AFTER });
add({ name: "server via Hetzner: create, invalid", token: "write", method: "POST", path: HZS, body: { cloud_provider_token_uuid: 5, location: 1, image: "ubuntu", name: "bad name!", enable_ipv4: "maybe", enable_backups: [], hetzner_ssh_key_ids: "31", hetzner_firewall_ids: [1, "x"], hetzner_network_ids: [null], cloud_init_script: 5, instant_validate: "no", extra: 1 }, http: [] });
add({ name: "server via Hetzner: create, no token", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, cloud_provider_token_uuid: undefined }, http: [] });
add({ name: "server via Hetzner: create, unknown token", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, cloud_provider_token_uuid: "nonexistentuuid" }, http: [] });
add({ name: "server via Hetzner: create, another provider's token", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, cloud_provider_token_uuid: CT_VULTR }, http: [] });
add({ name: "server via Hetzner: create, another team's token", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, cloud_provider_token_uuid: CT_OTHER }, http: [] });
add({ name: "server via Hetzner: create, unknown private key", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, private_key_uuid: "nonexistentuuid" }, http: [] });
add({ name: "server via Hetzner: create, another team's private key", token: "write", method: "POST", path: HZS, body: { ...HZ_BODY, private_key_uuid: K_OTHER }, http: [] });
add({ name: "server via Hetzner: create, not JSON", token: "write", method: "POST", path: HZS, raw: "location=nbg1", contentType: "application/x-www-form-urlencoded", http: [] });
add({ name: "server via Hetzner: create with a read token", token: "read", method: "POST", path: HZS, body: HZ_BODY, http: [] });
denial("server via Hetzner: create", "memberWrite", WRITE_DELETE, WRITER);

// Vultr
const VU_BASE = "https://api\\.vultr\\.com/v2";
const VUS = "/api/v1/servers/vultr";
const VU_BODY = { cloud_provider_token_uuid: CT_VULTR, region: "ams", plan: "vc2-1c-1gb", os_id: 2284, name: "Edge-1", private_key_uuid: K_MAIN };
const VU_KEYS = (keys) => answer(`^GET ${VU_BASE}/ssh-keys\\?per_page=100$`, { ssh_keys: keys, meta: { total: keys.length, links: { next: "", prev: "" } } });
const VU_KNOWN = VU_KEYS([{ id: "key-other", name: "laptop", ssh_key: OTHER_PUBLIC_KEY }, { id: "key-parity", name: "Parity Key", ssh_key: `${KEY_FACTS.public} parity@host` }]);
const VU_UPLOAD = answer(`^POST ${VU_BASE}/ssh-keys$`, { ssh_key: { id: "key-new", name: "Parity Key", ssh_key: KEY_FACTS.public } }, 201);
const vuInstance = (main = "198.51.100.31", v6 = "2001:db8:31::1", status = "pending") => ({ instance: { id: "inst-31", label: "edge-1", status, main_ip: main, v6_main_ip: v6 } });
const VU_CREATE = (body = vuInstance(), status = 202) => answer(`^POST ${VU_BASE}/instances$`, body, status);
const VU_GET = (body) => answer(`^GET ${VU_BASE}/instances/inst-31$`, body);
add({ name: "server via Vultr: create", token: "write", method: "POST", path: VUS, body: VU_BODY, http: [VU_KNOWN, VU_CREATE()], after: CLOUD_AFTER });
add({ name: "server via Vultr: create, the key uploaded", token: "write", method: "POST", path: VUS, body: { ...VU_BODY, name: undefined }, http: [VU_KEYS([]), VU_UPLOAD, VU_CREATE()], after: CLOUD_AFTER });
add({ name: "server via Vultr: create, the address after a wait", token: "write", method: "POST", path: VUS, body: VU_BODY, http: [VU_KNOWN, VU_CREATE(vuInstance("0.0.0.0", "")), VU_GET(vuInstance("198.51.100.32", "", "active"))], after: CLOUD_AFTER });
add({ name: "server via Vultr: create, no address yet", token: "write", method: "POST", path: VUS, body: VU_BODY, http: [VU_KNOWN, VU_CREATE(vuInstance("0.0.0.0", "::")), VU_GET(vuInstance("0.0.0.0", "::"))], after: CLOUD_AFTER });
add({ name: "server via Vultr: create, IPv6 only", token: "write", method: "POST", path: VUS, body: { ...VU_BODY, disable_public_ipv4: true }, http: [VU_KNOWN, VU_CREATE()], after: CLOUD_AFTER });
add({ name: "server via Vultr: create, no public address enabled", token: "write", method: "POST", path: VUS, body: { ...VU_BODY, disable_public_ipv4: 1, enable_ipv6: false }, http: [] });
add({ name: "server via Vultr: create with keys and a script, without validating", token: "root", method: "POST", path: VUS, body: { ...VU_BODY, vultr_ssh_key_ids: ["key-parity", "key-2", "key-2"], cloud_init_script: CLOUD_CONFIG, instant_validate: false }, http: [VU_KNOWN, VU_CREATE()], after: CLOUD_AFTER });
add({ name: "server via Vultr: create and validate", token: "root", method: "POST", path: VUS, body: VU_BODY, http: [VU_KNOWN, VU_CREATE()], after: CLOUD_AFTER });
for (const [what, script] of BAD_YAML.slice(8)) add({ name: `server via Vultr: create, invalid cloud-init YAML, ${what}`, token: "root", method: "POST", path: VUS, body: { ...VU_BODY, cloud_init_script: script }, http: [] });
add({ name: "server via Vultr: create, a script without deploy", token: "write", method: "POST", path: VUS, body: { ...VU_BODY, cloud_init_script: "#!/bin/bash\nls\n" }, http: [] });
add({ name: "server via Vultr: create, Vultr refuses", token: "write", method: "POST", path: VUS, body: VU_BODY, http: [VU_KNOWN, VU_CREATE({ error: "Invalid plan", status: 400 }, 400)], after: CLOUD_AFTER });
add({ name: "server via Vultr: create, rate limited", token: "write", method: "POST", path: VUS, body: VU_BODY, http: [VU_KNOWN, VU_CREATE({ error: "Rate limit" }, 429)], after: CLOUD_AFTER });
add({ name: "server via Vultr: create, no instance id", token: "write", method: "POST", path: VUS, body: VU_BODY, http: [VU_KNOWN, VU_CREATE({ instance: { label: "edge-1" } })], after: CLOUD_AFTER });
add({ name: "server via Vultr: create, invalid", token: "write", method: "POST", path: VUS, body: { cloud_provider_token_uuid: CT_VULTR, region: 5, os_id: "x", private_key_uuid: [], enable_ipv6: "yes", vultr_ssh_key_ids: [1, "k"], cloud_init_script: true, extra: 1 }, http: [] });
add({ name: "server via Vultr: create, unknown token", token: "write", method: "POST", path: VUS, body: { ...VU_BODY, cloud_provider_token_uuid: "nonexistentuuid" }, http: [] });
add({ name: "server via Vultr: create, another provider's token", token: "write", method: "POST", path: VUS, body: { ...VU_BODY, cloud_provider_token_uuid: CT_HETZNER }, http: [] });
add({ name: "server via Vultr: create, unknown private key", token: "write", method: "POST", path: VUS, body: { ...VU_BODY, private_key_uuid: "nonexistentuuid" }, http: [] });
add({ name: "server via Vultr: create, not JSON", token: "write", method: "POST", path: VUS, raw: "region=ams", contentType: "application/x-www-form-urlencoded", http: [] });
add({ name: "server via Vultr: create with a read token", token: "read", method: "POST", path: VUS, body: VU_BODY, http: [] });
denial("server via Vultr: create", "memberWrite", WRITE_DELETE, WRITER);

// DigitalOcean
const DO_BASE = "https://api\\.digitalocean\\.com/v2";
const DOS = "/api/v1/servers/digitalocean";
const DO_BODY = { cloud_provider_token_uuid: CT_DO, region: "fra1", size: "s-1vcpu-1gb", image: "ubuntu-24-04-x64", name: "Db-1", private_key_uuid: K_MAIN };
const DO_KEYS = (keys) => answer(`^GET ${DO_BASE}/account/keys\\?page=1&per_page=50$`, { ssh_keys: keys, links: {}, meta: { total: keys.length } });
const DO_KNOWN = DO_KEYS([{ id: 511, name: "laptop", fingerprint: "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99", public_key: OTHER_PUBLIC_KEY }, { id: "512", name: "Parity Key", fingerprint: KEY_FACTS.md5, public_key: KEY_FACTS.public }]);
const DO_UPLOAD = answer(`^POST ${DO_BASE}/account/keys$`, { ssh_key: { id: 513, name: "Parity Key", fingerprint: KEY_FACTS.md5, public_key: KEY_FACTS.public } }, 201);
const doDroplet = (v4 = [], v6 = [], status = "new", id = 3164444) => ({ droplet: { id, name: "db-1", status, networks: { v4, v6 } } });
const PUBLIC_V4 = [{ ip_address: "10.110.0.2", type: "private" }, { ip_address: "198.51.100.41", type: "public" }];
const PUBLIC_V6 = [{ ip_address: "2001:db8:41::2", type: "public" }];
const DO_CREATE = (body = doDroplet(), status = 202) => answer(`^POST ${DO_BASE}/droplets$`, body, status);
const DO_GET = (body) => answer(`^GET ${DO_BASE}/droplets/3164444$`, body);
add({ name: "server via DigitalOcean: create", token: "write", method: "POST", path: DOS, body: DO_BODY, http: [DO_KNOWN, DO_CREATE(doDroplet(PUBLIC_V4))], after: CLOUD_AFTER });
add({ name: "server via DigitalOcean: create, the key uploaded and the address after a wait", token: "write", method: "POST", path: DOS, body: { ...DO_BODY, name: undefined, image: 154962364 }, http: [DO_KEYS([]), DO_UPLOAD, DO_CREATE(), DO_GET(doDroplet(PUBLIC_V4, [], "active"))], after: CLOUD_AFTER });
add({ name: "server via DigitalOcean: create, no address yet", token: "write", method: "POST", path: DOS, body: DO_BODY, http: [DO_KNOWN, DO_CREATE(), DO_GET(doDroplet())], after: CLOUD_AFTER });
add({ name: "server via DigitalOcean: create, IPv6 only", token: "write", method: "POST", path: DOS, body: DO_BODY, http: [DO_KNOWN, DO_CREATE(doDroplet([], PUBLIC_V6, "active"))], after: CLOUD_AFTER });
add({ name: "server via DigitalOcean: create, IPv6 off by null, no monitoring", token: "write", method: "POST", path: DOS, body: { ...DO_BODY, enable_ipv6: null, monitoring: "0" }, http: [DO_KNOWN, DO_CREATE(doDroplet(PUBLIC_V4))], after: CLOUD_AFTER });
add({ name: "server via DigitalOcean: create with keys and a script, without validating", token: "root", method: "POST", path: DOS, body: { ...DO_BODY, digitalocean_ssh_key_ids: [512, 601, "601"], cloud_init_script: CLOUD_CONFIG, instant_validate: false }, http: [DO_KNOWN, DO_CREATE(doDroplet(PUBLIC_V4))], after: CLOUD_AFTER });
add({ name: "server via DigitalOcean: create and validate", token: "root", method: "POST", path: DOS, body: DO_BODY, http: [DO_KNOWN, DO_CREATE(doDroplet(PUBLIC_V4))], after: CLOUD_AFTER });
for (const [what, script] of BAD_YAML.slice(0, 6)) add({ name: `server via DigitalOcean: create, invalid cloud-init YAML, ${what}`, token: "root", method: "POST", path: DOS, body: { ...DO_BODY, cloud_init_script: script }, http: [] });
add({ name: "server via DigitalOcean: create, validating without deploy", token: "write", method: "POST", path: DOS, body: { ...DO_BODY, instant_validate: 1 }, http: [] });
add({ name: "server via DigitalOcean: create, DigitalOcean refuses", token: "write", method: "POST", path: DOS, body: DO_BODY, http: [DO_KNOWN, DO_CREATE({ id: "unprocessable_entity", message: "You specified an invalid size for Droplet creation." }, 422)], after: CLOUD_AFTER });
add({ name: "server via DigitalOcean: create, rate limited", token: "write", method: "POST", path: DOS, body: DO_BODY, http: [answer(`^GET ${DO_BASE}/account/keys`, { id: "too_many_requests", message: "API Rate limit exceeded." }, 429, { "Retry-After": "60" })], after: CLOUD_AFTER });
add({ name: "server via DigitalOcean: create, no droplet id", token: "write", method: "POST", path: DOS, body: DO_BODY, http: [DO_KNOWN, DO_CREATE({ droplet: { name: "db-1" } })], after: CLOUD_AFTER });
add({ name: "server via DigitalOcean: create, invalid", token: "write", method: "POST", path: DOS, body: { cloud_provider_token_id: 9, size: [], name: "-db", private_key_uuid: K_MAIN, enable_ipv6: "x", monitoring: 2, digitalocean_ssh_key_ids: ["a"], cloud_init_script: [], instant_validate: "yes", extra: 1 }, http: [] });
add({ name: "server via DigitalOcean: create, unknown token", token: "write", method: "POST", path: DOS, body: { ...DO_BODY, cloud_provider_token_uuid: "nonexistentuuid" }, http: [] });
add({ name: "server via DigitalOcean: create, another provider's token", token: "write", method: "POST", path: DOS, body: { ...DO_BODY, cloud_provider_token_uuid: CT_HETZNER }, http: [] });
add({ name: "server via DigitalOcean: create, another team's private key", token: "write", method: "POST", path: DOS, body: { ...DO_BODY, private_key_uuid: K_OTHER }, http: [] });
add({ name: "server via DigitalOcean: create, not JSON", token: "write", method: "POST", path: DOS, raw: "region=fra1", contentType: "application/x-www-form-urlencoded", http: [] });
add({ name: "server via DigitalOcean: create with a read token", token: "read", method: "POST", path: DOS, body: DO_BODY, http: [] });
denial("server via DigitalOcean: create", "memberWrite", WRITE_DELETE, WRITER);

/** The tables whose column order emit.php writes into the goldens (`columns`): what a nested relation serializes in. */
const columnsOf = ["servers", "server_settings", "standalone_dockers", "application_settings", "applications", "environment_variables", "application_deployment_queues", "scheduled_database_backups", "scheduled_database_backup_executions", "services", "service_applications", "service_databases", "projects", "environments", "standalone_postgresqls", "standalone_redis", "standalone_mongodbs", "standalone_mysqls", "standalone_mariadbs", "standalone_keydbs", "standalone_dragonflies", "standalone_clickhouses", "local_persistent_volumes", "local_file_volumes", "github_apps"];

console.log(JSON.stringify({ fixture, columnsOf, cases }, null, 1));
