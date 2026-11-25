// Writes cases.json (DP-62): node cases.mjs cases.json. See README.md.
//
// The cases are generated so that every engine gets the same ones: a start with the defaults, a custom image,
// a public port, SSL (generated, and given — once for each ssl_mode the engine has), a custom configuration,
// extra volumes and file mounts, variables, resource limits, a log drain, custom Docker options, the health
// check settings, failures, a restart, a stop, and the TCP proxy.
import { readFileSync, writeFileSync } from "node:fs";

const UUID = "db0000000000000000000001";
const DIR = `/data/coolify/databases/${UUID}`;
const here = new URL(".", import.meta.url);
// DP-48's throwaway CA, made by Coolify's own SslHelper (fixtures/ssl/README.md), and a leaf signed with it.
const CA_CERTIFICATE = readFileSync(new URL("../ssl/php-ca.crt", here), "utf8");
const CA_PRIVATE_KEY = readFileSync(new URL("../ssl/php-ca.key.txt", here), "utf8");
const LEAF_CERTIFICATE = readFileSync(new URL("../ssl/php-leaf.crt", here), "utf8");
// A throwaway key (openssl ecparam -name prime256v1 -genkey | openssl pkcs8 -topk8 -nocrypt): Coolify only writes it to a file.
const LEAF_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgaXRUSi/rEHDFqyzp
8ENTKlXoZ4KsI1C5MoiR3L/RdGWhRANCAAQDcpa8uSRouUuyPCiOrw7cAaXlh2gX
CKpgoyZP2rgyJzILiq4SpiEDGz3XQym1fFuKu6mhsnhTWNx3DMP2Ilm9
-----END PRIVATE KEY-----
`;

// The long texts stand once in cases.json; a value "@text:<name>" is that text.
const texts = {
  "ca-certificate": CA_CERTIFICATE,
  "ca-private-key": CA_PRIVATE_KEY,
  "leaf-certificate": LEAF_CERTIFICATE,
  "leaf-private-key": LEAF_PRIVATE_KEY,
  "leaf-certificate-and-key": LEAF_CERTIFICATE + "\n" + LEAF_PRIVATE_KEY,
};

const inspect = (status, health) => JSON.stringify({ Name: `/${UUID}`, State: health ? { Status: status, Health: { Status: health } } : { Status: status } }) + "\n";
const states = (...list) => list.map((state, i) => `${i + 1}:${state}`).join("\n") + "\n";

const defaults = {
  server: { name: "srv", ip: "10.0.0.5", user: "root", port: 22 },
  serverSettings: { is_reachable: true, is_usable: true },
  destination: { name: "coolify", network: "coolify" },
  project: { name: "My Project" },
  environment: { name: "production" },
  database: { uuid: UUID },
  variables: [],
  sharedVariables: [],
  persistentStorages: [],
  fileStorages: [],
  responses: [
    { match: "echo 'Starting database.'", output: "Starting database.\nDatabase started.\n" },
    { match: "docker container inspect", output: inspect("running", "healthy") },
    { match: "docker network inspect", output: "false\n" },
    { match: "test -L", output: "OK\n" },
    { match: "resolve() {", output: "OK\n" },
  ],
};

/** Per engine: the row a new database has, where its certificate is mounted, its ssl modes, its configuration column. */
const ENGINES = {
  postgresql: {
    base: { name: `postgresql-database-${UUID}`, postgres_password: "S3cretPass", image: "postgres:17-alpine" },
    customImage: "supabase/postgres:17.4.1.032",
    otherImages: ["postgres:18-alpine", "registry.example.com:5000/team/postgres:16"],
    mount: "/var/lib/postgresql/certs",
    modes: ["allow", "prefer", "require", "verify-ca", "verify-full"],
    conf: ["postgres_conf", "max_connections = 200\nshared_buffers = 256MB\n", "listen_addresses = 'localhost'\nport = 5433\n"],
    credentials: [["POSTGRES_USER", "appuser"], ["POSTGRES_PASSWORD", "Fr0m$Var"], ["POSTGRES_DB", "appdb"]],
    proxySsl: 5432,
  },
  redis: {
    base: { name: `redis-database-${UUID}`, image: "redis:7.2" },
    variables: [{ key: "REDIS_PASSWORD", value: "S3cretPass" }, { key: "REDIS_USERNAME", value: "default" }],
    customImage: "valkey/valkey:9-alpine",
    otherImages: ["redis:6.0.20", "docker.io/library/redis:5"],
    mount: "/etc/redis/certs",
    modes: [null],
    conf: ["redis_conf", "maxmemory 256mb\nmaxmemory-policy allkeys-lru\n", "port 6390\nrequirepass fromconf\n"],
    credentials: [["REDIS_PASSWORD", "Fr0m$Var pass"]],
    quoting: true,
  },
  mysql: {
    base: { name: `mysql-database-${UUID}`, mysql_root_password: "R00tPass", mysql_password: "S3cretPass", image: "mysql:8" },
    customImage: "mysql:9.1",
    otherImages: ["registry.example.com:5000/team/mysql:8.4"],
    mount: "/etc/mysql/certs",
    modes: ["PREFERRED", "REQUIRED", "VERIFY_CA", "VERIFY_IDENTITY"],
    conf: ["mysql_conf", "[mysqld]\nmax_connections = 500\n", "[mysqld]\nport = 3307\n"],
    credentials: [["MYSQL_ROOT_PASSWORD", "Fr0m$Var"], ["MYSQL_DATABASE", "appdb"], ["MYSQL_USER", "appuser"], ["MYSQL_PASSWORD", "apppass"]],
  },
  mariadb: {
    base: { name: `mariadb-database-${UUID}`, mariadb_root_password: "R00tPass", mariadb_password: "S3cretPass", image: "mariadb:11" },
    customImage: "mariadb:10.11",
    otherImages: ["registry.example.com:5000/team/mariadb:11.4"],
    mount: "/etc/mysql/certs",
    modes: [null],
    conf: ["mariadb_conf", "[mariadbd]\nmax_connections = 500\n", "[mariadbd]\nport = 3307\n"],
    credentials: [["MARIADB_ROOT_PASSWORD", "Fr0m$Var"], ["MARIADB_DATABASE", "appdb"], ["MARIADB_USER", "appuser"], ["MARIADB_PASSWORD", "apppass"]],
  },
  mongodb: {
    base: { name: `mongodb-database-${UUID}`, mongo_initdb_root_password: "S3cretPass", image: "mongo:8" },
    customImage: "mongo:4.4",
    otherImages: ["registry.example.com:5000/team/mongo:7"],
    mount: "/etc/mongo/certs",
    pem: true,
    modes: ["allow", "prefer", "require", "verify-full"],
    conf: ["mongo_conf", "storage:\n  wiredTiger:\n    engineConfig:\n      cacheSizeGB: 1\n", "net:\n  port: 27018\n"],
    credentials: [["MONGO_INITDB_ROOT_USERNAME", "app\"user"], ["MONGO_INITDB_ROOT_PASSWORD", "Fr0m$Var/x"], ["MONGO_INITDB_DATABASE", "appdb"]],
  },
  keydb: {
    base: { name: `keydb-database-${UUID}`, keydb_password: "S3cretPass", image: "eqalpha/keydb:latest" },
    customImage: "eqalpha/keydb:x86_64_v6.3.4",
    otherImages: ["registry.example.com:5000/team/keydb:6"],
    mount: "/etc/keydb/certs",
    modes: [null],
    conf: ["keydb_conf", "maxmemory 256mb\n", "port 6390\nrequirepass fromconf\n"],
    credentials: [["REDIS_PASSWORD", "Fr0m$Var pass"]],
    quoting: true,
    password: "keydb_password",
  },
  dragonfly: {
    base: { name: `dragonfly-database-${UUID}`, dragonfly_password: "S3cretPass", image: "docker.dragonflydb.io/dragonflydb/dragonfly" },
    customImage: "docker.dragonflydb.io/dragonflydb/dragonfly:v1.25.1",
    otherImages: ["ghcr.io/dragonflydb/dragonfly:latest"],
    mount: "/etc/dragonfly/certs",
    modes: [null],
    conf: null,
    credentials: [["REDIS_PASSWORD", "Fr0m$Var pass"]],
    quoting: true,
    password: "dragonfly_password",
  },
  clickhouse: {
    base: { name: `clickhouse-database-${UUID}`, clickhouse_admin_password: "S3cretPass", image: "clickhouse/clickhouse-server:25.11" },
    customImage: "clickhouse/clickhouse-server:24.8-alpine",
    otherImages: ["bitnamilegacy/clickhouse", "registry.example.com:5000/team/clickhouse:25"],
    mount: null,
    modes: [],
    conf: null,
    credentials: [["CLICKHOUSE_USER", "appuser"], ["CLICKHOUSE_PASSWORD", "Fr0m$Var"], ["CLICKHOUSE_DB", "appdb"]],
  },
};

const runs = [];
for (const [engine, e] of Object.entries(ENGINES)) {
  const baseVariables = e.variables ?? [];
  /** Variables of a case: the engine's own (Redis's two), with the case's replacing those of the same key. */
  const vars = (list) => [...baseVariables.filter((b) => !list.some((v) => v.key === b.key)), ...list];
  const run = (id, action, c = {}) => {
    const { database, variables, ...rest } = c;
    runs.push({ id: `${engine}.${id}`, engine, action, database: { ...e.base, ...(database ?? {}) }, variables: vars(variables ?? []), ...rest });
  };
  const start = (id, c = {}) => run(id, "start", c);
  const certFiles = e.pem
    ? [{ fs_path: `${DIR}/ssl/server.pem`, mount_path: `${e.mount}/server.pem`, content: "@text:leaf-certificate-and-key", chmod: "600" }]
    : [
        { fs_path: `${DIR}/ssl/server.crt`, mount_path: `${e.mount}/server.crt`, content: "@text:leaf-certificate", chmod: "644" },
        { fs_path: `${DIR}/ssl/server.key`, mount_path: `${e.mount}/server.key`, content: "@text:leaf-private-key", chmod: "600" },
      ];
  const givenSsl = (extra = {}) => ({
    caCertificate: { ssl_certificate: "@text:ca-certificate", ssl_private_key: "@text:ca-private-key" },
    certificate: { ssl_certificate: "@text:leaf-certificate", ssl_private_key: "@text:leaf-private-key", configuration_dir: DIR, mount_path: e.mount, subject_alternative_names: [`DNS:${UUID}`, "IP:10.0.0.5"] },
    fileStorages: certFiles,
    responses: [{ match: "sh -c 'i=0", output: states(...certFiles.map(() => "file")) }],
    ...extra,
  });

  // ── the configuration: what the compose file and the command list are made of ──
  start("defaults");
  start("custom image", { database: { image: e.customImage } });
  e.otherImages.forEach((image, i) => start(`custom image ${i + 2}`, { database: { image } }));
  start("public port", { database: { is_public: true, public_port: 15432, public_port_timeout: 600 } });
  start("ports mappings", { database: { ports_mappings: "15432:5432,127.0.0.1:15433:5433" } });
  if (e.mount) {
    // Nothing exists: Coolify makes the server's CA and the database's certificate, and writes the missing files.
    start("ssl generated", { database: { enable_ssl: true }, responses: [{ match: "sh -c 'i=0", output: states(...certFiles.map(() => "missing")) }] });
    // The CA exists, the database has no certificate yet; its files are already on the server (an earlier start).
    start("ssl generated with a CA", { database: { enable_ssl: true }, caCertificate: { ssl_certificate: "@text:ca-certificate", ssl_private_key: "@text:ca-private-key" }, responses: [{ match: "sh -c 'i=0", output: states(...certFiles.map(() => "file")) }] });
    for (const mode of e.modes) start(`ssl ${mode ?? "on"}`, givenSsl({ database: { enable_ssl: true, ...(mode ? { ssl_mode: mode } : {}) } }));
    // The certificate files are missing on the server (a new server, a cleaned directory): written before the start.
    start("ssl files missing", givenSsl({ database: { enable_ssl: true }, responses: [{ match: "sh -c 'i=0", output: states(...certFiles.map((_, i) => (i === 0 ? "empty-directory" : "missing"))) }] }));
    start("ssl files unreadable", givenSsl({ database: { enable_ssl: true }, responses: [{ match: "sh -c 'i=0", output: states(...certFiles.map((_, i) => (i === 0 ? "directory" : "other"))) }] }));
    // SSL switched off after a start with it: the certificate rows and the mounts go.
    start("ssl off again", givenSsl({ database: { enable_ssl: false }, responses: [] }));
    if (e.conf) start("ssl with a configuration", givenSsl({ database: { enable_ssl: true, [e.conf[0]]: e.conf[1], ...(e.modes[0] ? { ssl_mode: e.modes.at(-1) } : {}) } }));
    start("ssl and public", givenSsl({ database: { enable_ssl: true, is_public: true, public_port: 15432 } }));
  }
  if (e.conf) {
    start("custom configuration", { database: { [e.conf[0]]: e.conf[1] } });
    start("custom configuration with a port", { database: { [e.conf[0]]: e.conf[2] } });
    start("empty configuration", { database: { [e.conf[0]]: "" } });
  }
  start("extra volumes", {
    persistentStorages: [
      { name: `${UUID}-extra`, mount_path: "/extra" },
      { name: `${UUID}-host`, mount_path: "/host-data", host_path: "/srv/data" },
      { name: `${UUID}-empty-host`, mount_path: "/other", host_path: "" },
    ],
  });
  start("without volumes", { defaultVolumes: false });
  start("file mounts", {
    fileStorages: [
      { fs_path: `${DIR}/conf.d`, mount_path: "/conf.d", is_directory: true },
      { fs_path: `${DIR}/extra.conf`, mount_path: "/etc/extra.conf", content: "key = value\nother = 'quoted'\n" },
      { fs_path: `${DIR}/empty.conf`, mount_path: "/etc/empty.conf" },
      { fs_path: `${DIR}/present.conf`, mount_path: "/etc/present.conf", content: "already there", chown: "999:999", chmod: "640" },
      { fs_path: "/etc/hosts", mount_path: "/etc/hosts.host", is_host_file: true },
    ],
    responses: [{ match: "sh -c 'i=0", sequence: [{ output: states("missing", "empty-directory", "file") }, { output: states("missing") }, { output: states("empty-directory") }] }],
  });
  // Files outside the database's directory are never written through a symbolic link; a relative path is inside
  // the directory; a path Coolify refuses is told and left alone.
  start("file mounts outside the directory", {
    fileStorages: [
      { fs_path: "/srv/conf/outside.conf", mount_path: "/etc/outside.conf", content: "x = 1\n", chmod: "600" },
      { fs_path: "/srv/conf/link.conf", mount_path: "/etc/link.conf", content: "y = 2\n" },
      { fs_path: "./relative.conf", mount_path: "/etc/relative.conf", content: "z = 3\n" },
      { fs_path: "~/home.conf", mount_path: "/etc/home.conf", content: "h = 4\n" },
      { fs_path: "/srv/a;b.conf", mount_path: "/etc/ab.conf", content: "i = 5\n" },
      { fs_path: `${DIR}/../other/escape.conf`, mount_path: "/etc/escape.conf", content: "j = 6\n" },
      { fs_path: `${DIR}/binary.dat`, mount_path: "/etc/binary.dat", content: "[binary file]" },
    ],
    responses: [
      { match: "sh -c 'i=0", sequence: [{ output: states("missing", "missing", "missing", "missing") }, { output: states("missing") }, { output: states("directory") }, { output: states("empty-directory") }] },
      { match: "test -L", sequence: [{ output: "OK\n" }, { output: "LINK\n" }, { output: "OK\n" }] },
    ],
  });
  start("file mounts the server refuses", {
    fileStorages: [
      { fs_path: `${DIR}/a.conf`, mount_path: "/etc/a.conf", content: "a" },
      { fs_path: `${DIR}/b.conf`, mount_path: "/etc/b.conf", content: "b" },
      { fs_path: `${DIR}/c.conf`, mount_path: "/etc/c.conf", content: "c" },
      { fs_path: `${DIR}/d.conf`, mount_path: "/etc/d.conf", content: "0" },
    ],
    responses: [
      // The first check finds all four missing; then the path is not confined, cannot be checked, is special, or cannot be written.
      { match: "sh -c 'i=0", sequence: [{ output: states("missing", "missing", "missing", "missing") }, { output: "garbage\n" }, { output: states("other") }, { output: states("missing") }] },
      { match: "resolve() {", sequence: [{ output: "NOK\n" }, { output: "OK\n" }] },
      { match: "touch ", errorOutput: "touch: cannot touch: Read-only file system\n", exitCode: 1 },
    ],
  });
  start("variables", {
    variables: [
      { key: "PLAIN", value: "value" },
      { key: "DOLLAR", value: "pa$$word and ${OTHER}" },
      { key: "LITERAL", value: "pa$$word and ${OTHER}", is_literal: true },
      { key: "MULTILINE", value: "line one\nline two with $x\n", is_multiline: true },
      { key: "JSON", value: '{"a":"$b","c":[1,2]}' },
      { key: "SPACES", value: "  padded value  " },
      { key: "QUOTES", value: `it's "quoted" #hash` },
      { key: "EMPTY", value: "" },
      { key: "SHARED", value: "{{team.SHARED_KEY}}-suffix" },
      { key: "SHARED_PROJECT", value: "{{project.DB_HOST}}:{{environment.DB_PORT}}@{{server.REGION}}" },
      { key: "SHARED_MISSING", value: "{{team.NOT_THERE}}" },
      { key: "BUILD_ONLY", value: "still in the container", is_buildtime: true, is_runtime: false },
      { key: "LOCKED", value: "locked value", is_shown_once: true },
    ],
    sharedVariables: [
      { type: "team", key: "SHARED_KEY", value: "team$value" },
      { type: "project", key: "DB_HOST", value: "db.internal" },
      { type: "environment", key: "DB_PORT", value: "5432" },
      { type: "server", key: "REGION", value: "eu-central", is_shown_once: true },
    ],
  });
  start("credential variables", { variables: e.credentials.map(([key, value]) => ({ key, value })) });
  start("literal credential variables", { variables: e.credentials.map(([key, value]) => ({ key, value, is_literal: true })) });
  start("legacy escaped variables", {
    variables: [
      { key: "PLAIN", value: "pa$word", uses_legacy_escaping: true },
      { key: "LITERAL", value: "pa$word 'x'", is_literal: true, uses_legacy_escaping: true },
      { key: "JSON", value: '{"a":"$b"}', uses_legacy_escaping: true },
      { key: "EDGE", value: " edge ", uses_legacy_escaping: true },
      ...e.credentials.map(([key, value]) => ({ key, value, uses_legacy_escaping: true })),
    ],
  });
  start("coolify variables overridden", {
    variables: [
      { key: "COOLIFY_RESOURCE_UUID", value: "mine" },
      { key: "COOLIFY_APP_NAME", value: "my-app" },
      { key: "COOLIFY_SERVER_IP", value: "1.2.3.4" },
    ],
  });
  start("without coolify variables", { database: { include_coolify_default_variables: false } });
  start("vault reference in a literal", { variables: [{ key: "TOKEN", value: "{{vault.API_TOKEN}}", is_literal: true }] });
  start("vault reference", { variables: [{ key: "TOKEN", value: "{{vault.API_TOKEN}}" }] });
  start("names to slug", { database: { name: "Ünïcode Datenbank & Söhne_2" }, project: { name: "Projekt Größe / Zwei" }, environment: { name: "Stage #1" } });
  start("resource limits", { database: { limits_memory: "512m", limits_memory_swap: "1g", limits_memory_swappiness: 10, limits_memory_reservation: "256m", limits_cpus: "1.5", limits_cpuset: "0-1", limits_cpu_shares: 512 } });
  start("resource limits whole cpus", { database: { limits_cpus: "2", limits_cpuset: "" } });
  start("log drain", { database: { is_log_drain_enabled: true }, serverSettings: { is_logdrain_axiom_enabled: true } });
  start("log drain cloudwatch", { database: { is_log_drain_enabled: true }, serverSettings: { is_logdrain_cloudwatch_enabled: true, logdrain_cloudwatch_region: "eu-central-1", logdrain_cloudwatch_group: "freeploy", logdrain_cloudwatch_stream_prefix: "db-" } });
  start("log drain off on the server", { database: { is_log_drain_enabled: true } });
  start("log drain off on the database", { serverSettings: { is_logdrain_custom_enabled: true } });
  start("custom docker options", { database: { custom_docker_run_options: "--cap-add SYS_NICE --ulimit nofile=1024:2048 --shm-size 256m --hostname db-host --add-host host.docker.internal:host-gateway" } });
  start("custom docker options with an address", { database: { custom_docker_run_options: "--ip 172.20.0.5 --ip6 fd00::5 --memory 1g --privileged --device /dev/fuse" } });
  start("health check settings", { database: { health_check_interval: 30, health_check_timeout: 10, health_check_retries: 3, health_check_start_period: 60 } });
  start("health check disabled", { database: { health_check_enabled: false } });
  start("ipv6 server", { server: { ip: "2a01:4f8::1" } });
  start("docker 29", { serverSettings: { docker_version: "29.0.1" } });
  if (e.quoting) {
    const password = `p'a ss"w;o&r|d<x>\\y`;
    const named = e.password ? { database: { [e.password]: password } } : { variables: [{ key: "REDIS_PASSWORD", value: password }] };
    start("quoted password", named);
    start("legacy unquoted password", { ...named, database: { ...(named.database ?? {}), legacy_password_quoting: true } });
    start("legacy quoting with a plain password", { database: { legacy_password_quoting: true } });
    if (e.password) start("legacy quoting and a password variable", { database: { legacy_password_quoting: true }, variables: [{ key: "REDIS_PASSWORD", value: "from var" }] });
  }
  if (engine === "redis") {
    start("blank username", { variables: [{ key: "REDIS_USERNAME", value: "" }] });
    start("shared credentials", { variables: [{ key: "REDIS_PASSWORD", value: "{{team.REDIS_PW}}" }, { key: "REDIS_USERNAME", value: "{{team.REDIS_USER}}" }], sharedVariables: [{ type: "team", key: "REDIS_PW", value: "shared$pw" }, { type: "team", key: "REDIS_USER", value: "shareduser" }] });
    // A database whose two variables were deleted.
    start("without variables");
    runs.at(-1).variables = [];
  }
  if (engine === "postgresql") {
    start("init scripts", {
      database: {
        init_scripts: [
          { index: 0, filename: "01-schema.sql", content: "CREATE TABLE t (id int);\n" },
          { index: 1, filename: "../../etc/02 seed's.sh", content: "#!/bin/sh\necho 'seed'\n" },
          { index: 2, filename: "03-empty.sql", content: "" },
        ],
      },
    });
    start("init scripts empty list", { database: { init_scripts: [] } });
    start("initdb args and auth method", { database: { postgres_initdb_args: "--data-checksums --locale=C", postgres_host_auth_method: "scram-sha-256", postgres_user: "admin", postgres_db: "main" } });
    start("supabase with a configuration", { database: { image: e.customImage, postgres_conf: "max_connections = 50\n", postgres_user: "supabase_admin" } });
    start("supabase with ssl", givenSsl({ database: { image: e.customImage, enable_ssl: true, postgres_user: "supabase_admin" } }));
  }
  if (engine === "clickhouse") {
    // The container keeps its data in an unnamed volume (a database from before v4.4): the start is refused.
    start("data in an unnamed volume", { responses: [{ match: "docker inspect --format", output: "volume 0123456789abcdef\n" }] });
    start("data in an unnamed volume after crash restarts", { database: { restart_count: 2, last_restart_at: "2026-11-19 08:00:00", last_restart_type: "crash" }, responses: [{ match: "docker inspect --format", output: "volume 0123456789abcdef\n" }] });
    start("data in its own volume", { responses: [{ match: "docker inspect --format", output: `volume clickhouse-data-${UUID}\n` }] });
    start("data in a bind mount", { responses: [{ match: "docker inspect --format", output: "bind \n" }] });
  }

  // ── what a start does when something is wrong ──
  start("pull fails", { responses: [{ match: "echo 'Starting database.'", output: "Starting database.\nPulling image.\n", errorOutput: "Error response from daemon: pull access denied for nope, repository does not exist\n", exitCode: 1 }] });
  start("command fails without output", { responses: [{ match: "echo 'Starting database.'", exitCode: 125 }] });
  start("output in pieces", { responses: [{ match: "echo 'Starting database.'", output: "Starting database.\r\nsecond line\nno line break at the end", errorOutput: "warning: something\n" }] });
  start("server unreachable", { serverSettings: { is_reachable: false } });
  start("server disabled", { serverSettings: { force_disabled: true } });
  start("container still starting", { responses: [{ match: "docker container inspect", sequence: [{ output: inspect("running", "starting") }, { output: inspect("running", "starting") }, { output: inspect("running", "healthy") }] }] });
  start("container never healthy", { responses: [{ match: "docker container inspect", output: inspect("running", "starting") }] });
  start("container without a health check", { responses: [{ match: "docker container inspect", output: inspect("running", null) }] });
  start("container exited", { responses: [{ match: "docker container inspect", output: inspect("exited", null) }] });
  start("container not found", { responses: [{ match: "docker container inspect", output: "", errorOutput: "Error response from daemon: No such container\n", exitCode: 1 }] });
  start("already running", { database: { status: "running:healthy", started_at: "2026-11-01 08:00:00" } });
  // The restart counters a crash-restarting container leaves (PushServerUpdateJob): a start resets them, a
  // start that is refused keeps them.
  const restarts = { restart_count: 3, last_restart_at: "2026-11-19 08:00:00", last_restart_type: "crash" };
  start("after crash restarts", { database: { status: "exited", ...restarts } });
  start("after crash restarts on an unreachable server", { database: { status: "exited", ...restarts }, serverSettings: { is_reachable: false } });

  // ── restart, stop, the TCP proxy ──
  run("restart", "restart", { database: { status: "running:healthy", started_at: "2026-11-01 08:00:00" } });
  run("restart public", "restart", { database: { status: "running:healthy", started_at: "2026-11-01 08:00:00", is_public: true, public_port: 15432 } });
  run("restart on an unreachable server", "restart", { database: { status: "running:healthy" }, serverSettings: { is_usable: false } });
  run("restart with a vault reference", "restart", { database: { status: "running:healthy" }, variables: [{ key: "TOKEN", value: "{{vault.API_TOKEN}}" }] });
  run("restart after crash restarts", "restart", { database: { status: "running:healthy", started_at: "2026-11-01 08:00:00", ...restarts } });
  run("stop", "stop", { database: { status: "running:healthy", started_at: "2026-11-01 08:00:00" } });
  run("stop after crash restarts", "stop", { database: { status: "running:healthy", ...restarts } });
  run("stop without cleanup after crash restarts", "stop", { database: { status: "running:healthy", ...restarts }, dockerCleanup: false });
  run("stop without cleanup", "stop", { database: { status: "running:healthy" }, dockerCleanup: false });
  run("stop public", "stop", { database: { status: "running:healthy", is_public: true, public_port: 15432 } });
  run("stop fails", "stop", { database: { status: "running:healthy" }, responses: [{ match: "docker stop", errorOutput: "Cannot connect to the Docker daemon\n", exitCode: 1 }] });
  run("stop public and the proxy fails", "stop", { database: { status: "running:healthy", is_public: true, public_port: 15432 }, responses: [{ match: "-proxy", errorOutput: "permission denied\n", exitCode: 1 }] });
  run("stop on an unreachable server", "stop", { database: { status: "running:healthy" }, serverSettings: { is_reachable: false } });
  run("stop on docker 29", "stop", { database: { status: "running:healthy" }, serverSettings: { docker_version: "29.0.1" } });
  run("proxy start", "proxy-start", { database: { status: "running:healthy", is_public: true, public_port: 15432 } });
  run("proxy start with ipv6 and a timeout", "proxy-start", { database: { status: "running:healthy", is_public: true, public_port: 15432, public_port_timeout: 120 }, responses: [{ match: "docker network inspect", output: "true\n" }] });
  run("proxy start with a zero timeout", "proxy-start", { database: { status: "running:healthy", is_public: true, public_port: 15432, public_port_timeout: 0 }, destination: { network: "custom-net_1" } });
  run("proxy start without a timeout", "proxy-start", { database: { status: "running:healthy", is_public: true, public_port: 15432, public_port_timeout: null } });
  if (e.mount) run("proxy start with ssl", "proxy-start", { database: { status: "running:healthy", is_public: true, public_port: 15432, enable_ssl: true } });
  run("proxy start and the port is taken", "proxy-start", {
    database: { status: "running:healthy", is_public: true, public_port: 15432 },
    responses: [{ match: "mkdir -p", errorOutput: "Error response from daemon: driver failed programming external connectivity: Bind for 0.0.0.0:15432 failed: port is already allocated\n", exitCode: 1 }],
  });
  run("proxy start fails", "proxy-start", { database: { status: "running:healthy", is_public: true, public_port: 15432 }, responses: [{ match: "mkdir -p", errorOutput: "Cannot connect to the Docker daemon\n", exitCode: 1 }] });
  run("proxy stop", "proxy-stop", { database: { status: "running:healthy", is_public: true, public_port: 15432 } });
  run("proxy stop fails", "proxy-stop", { database: { status: "running:healthy", is_public: true, public_port: 15432 }, responses: [{ match: "-proxy", errorOutput: "permission denied\n", exitCode: 1 }] });
}

writeFileSync(process.argv[2] ?? new URL("cases.json", here), JSON.stringify({ texts, defaults, runs }, null, 1) + "\n");
console.error(`${runs.length} cases`);
