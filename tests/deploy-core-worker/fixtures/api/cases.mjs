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
/** A deployment's logs column: one line as ApplicationDeploymentQueue::addLogEntry() writes it. */
const deploymentLog = (output) => JSON.stringify([{ command: null, output, type: "stdout", timestamp: "2025-12-30T10:00:01.000000Z", hidden: false, batch: 1, order: 1 }]);
/** The file the parser generated (fixed text; a locked variable's value in it is redacted for the API). */
const SERVICE_GENERATED = "services:\n  web:\n    image: 'nginx:alpine'\n    environment:\n      FOO: bar\n  db:\n    image: 'postgres:16-alpine'\n    environment:\n      POSTGRES_PASSWORD: dbSecretPass1\n";
/** Fixed manual webhook secrets (Coolify's creating hook makes random ones; both sides are given these). */
const webhookSecrets = (prefix) => Object.fromEntries(["github", "gitlab", "bitbucket", "gitea"].map((p) => [`manual_webhook_secret_${p}`, `${prefix}${p}`.padEnd(40, "x")]));

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
  tags: `select t.name from tags t join taggables tg on tg.tag_id = t.id where tg.taggable_type = 'App\\Models\\${model}' order by t.name`,
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
const servicesAfter = (where) => ({
  service: `select case when name ~ '^service-[A-Za-z0-9]{10}$' then 'service-<random>' else ${masked("name")} end as name, description, docker_compose_raw, ${masked("docker_compose")} as docker_compose, connect_to_docker_network, service_type, compose_parsing_version, is_container_label_escape_enabled, redact_all_env_values_in_logs, include_coolify_default_variables, environment_id, server_id, destination_id, destination_type, deleted_at is not null as deleted from services where ${where} order by id`,
  applications: `select a.name, a.human_name, a.image, ${masked("a.fqdn")} as fqdn, a.ports, a.status, a.exclude_from_status, a.is_gzip_enabled, a.is_stripprefix_enabled, a.is_force_https_enabled, a.is_permanent_redirect_enabled, a.redirect, a.is_removed_from_compose, a.deleted_at is not null as deleted from service_applications a join services s on s.id = a.service_id where ${where.replaceAll("id", "s.id")} order by a.id`,
  databases: `select d.name, d.human_name, d.image, d.ports, d.status, d.exclude_from_status, d.is_public, d.is_removed_from_compose, d.deleted_at is not null as deleted from service_databases d join services s on s.id = d.service_id where ${where.replaceAll("id", "s.id")} order by d.id`,
  variables: `select e.key, e.is_preview, e.is_required, e.is_shared, e.is_literal, e.is_multiline, e.is_shown_once, e.is_runtime, e.is_buildtime, e.comment, e.version from environment_variables e join services s on s.id = e.resourceable_id where e.resourceable_type = 'App\\Models\\Service' and ${where.replaceAll("id", "s.id")} order by e.id`,
  volumes: `select ${masked("v.name")} as name, v.mount_path, v.resource_type from local_persistent_volumes v where v.resource_type in ('App\\Models\\ServiceApplication', 'App\\Models\\ServiceDatabase') and v.resource_id in (select a.id from service_applications a join services s on s.id = a.service_id where ${where.replaceAll("id", "s.id")} union select d.id from service_databases d join services s on s.id = d.service_id where ${where.replaceAll("id", "s.id")}) order by v.id`,
  tags: "select t.name from tags t join taggables tg on tg.tag_id = t.id where tg.taggable_type = 'App\\Models\\Service' order by t.name",
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

/** The tables whose column order emit.php writes into the goldens (`columns`): what a nested relation serializes in. */
const columnsOf = ["servers", "server_settings", "standalone_dockers", "application_settings", "applications", "environment_variables", "application_deployment_queues", "scheduled_database_backups", "scheduled_database_backup_executions", "services", "service_applications", "service_databases"];

console.log(JSON.stringify({ fixture, columnsOf, cases }, null, 1));
