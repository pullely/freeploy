// Writes cases.json (DP-57): node cases.mjs cases.json. See README.md.
import { writeFileSync } from "node:fs";

const out = { created: {}, urls: {}, validationBase: {}, validation: {} };

// ---- created: what Create::createResource() calls, per type and image.
for (const image of ["postgres:18-alpine", "postgres:17-alpine", "postgres:16-alpine", "supabase/postgres:17.11.0.018", "postgis/postgis:18-3.7-alpine", "pgvector/pgvector:pg18", "pgvector/pgvector:pg17", "postgres", "registry.example.com:5000/postgres:18"]) {
  out.created[`postgresql ${image}`] = { type: "postgresql", database_image: image };
}
for (const image of ["valkey/valkey:9-alpine", "redis:8"]) out.created[`redis ${image}`] = { type: "redis", database_image: image };
for (const type of ["mysql", "mariadb", "mongodb", "keydb", "dragonfly", "clickhouse"]) out.created[type] = { type };

// ---- urls
const ENGINES = {
  postgresql: { base: { postgres_user: "postgres", postgres_password: "S3cretPass", postgres_db: "postgres" }, user: "postgres_user", pass: "postgres_password", db: "postgres_db", modes: ["allow", "prefer", "require", "verify-ca", "verify-full"] },
  mysql: { base: { mysql_user: "mysql", mysql_password: "S3cretPass", mysql_root_password: "RootPass", mysql_database: "default" }, user: "mysql_user", pass: "mysql_password", db: "mysql_database", modes: ["PREFERRED", "REQUIRED", "VERIFY_CA", "VERIFY_IDENTITY"] },
  mariadb: { base: { mariadb_user: "mariadb", mariadb_password: "S3cretPass", mariadb_root_password: "RootPass", mariadb_database: "default" }, user: "mariadb_user", pass: "mariadb_password", db: "mariadb_database", modes: [null] },
  mongodb: { base: { mongo_initdb_root_username: "root", mongo_initdb_root_password: "S3cretPass", mongo_initdb_database: "default" }, user: "mongo_initdb_root_username", pass: "mongo_initdb_root_password", db: "mongo_initdb_database", modes: ["allow", "prefer", "require", "verify-full"] },
  keydb: { base: { keydb_password: "S3cretPass" }, pass: "keydb_password", modes: [null] },
  dragonfly: { base: { dragonfly_password: "S3cretPass" }, pass: "dragonfly_password", modes: [null] },
  clickhouse: { base: { clickhouse_admin_user: "default", clickhouse_admin_password: "S3cretPass", clickhouse_db: "default" }, user: "clickhouse_admin_user", pass: "clickhouse_admin_password", db: "clickhouse_db", modes: [] },
  redis: { base: { image: "valkey/valkey:9-alpine" }, modes: [null] },
};
const REDIS_VARS = [
  { key: "REDIS_PASSWORD", value: "S3cretPass" },
  { key: "REDIS_USERNAME", value: "default" },
];
const SPECIAL = "p@ss:w/rd?#[]%+&= ~é";
for (const [type, e] of Object.entries(ENGINES)) {
  const vars = type === "redis" ? { environmentVariables: REDIS_VARS } : {};
  const url = (id, attributes, extra = {}) => {
    out.urls[`${type} ${id}`] = { type, attributes: { ...e.base, ...attributes }, ...vars, ...extra };
  };
  url("private", {});
  url("public", { is_public: true, public_port: 15432 });
  url("public without a port", { is_public: true, public_port: null });
  url("a port but private", { is_public: false, public_port: 15432 });
  url("public on IPv6", { is_public: true, public_port: 15432 }, { serverIp: "2A01:04F8:0:0:0:0:0:1" });
  url("public on bracketed IPv6", { is_public: true, public_port: 15432 }, { serverIp: "[2a01:4f8::1]" });
  url("public on a hostname", { is_public: true, public_port: 15432 }, { serverIp: "db.example.com" });
  url("public without a server address", { is_public: true, public_port: 15432 }, { serverIp: "" });
  if (e.modes.length) {
    for (const mode of e.modes) {
      url(`ssl ${mode ?? "on"}`, { enable_ssl: true, ...(mode ? { ssl_mode: mode } : {}), is_public: true, public_port: 15432 });
    }
    url("ssl off with a mode", { enable_ssl: false, ...(e.modes[0] ? { ssl_mode: e.modes.at(-1) } : {}), is_public: true, public_port: 15432 });
  }
  if (e.pass) url("special characters", { ...(e.user ? { [e.user]: "us er@x" } : {}), [e.pass]: SPECIAL, ...(e.db ? { [e.db]: "my db" } : {}), is_public: true, public_port: 15432 });
}
// Redis: the version in the image tag decides whether the username is part of the URL; the credentials are variables.
for (const image of ["redis:8", "redis:7.2-alpine", "redis:6.0", "redis:6", "redis:5.0.14", "redis", "redis:latest", "valkey/valkey:9-alpine", "registry.example.com:5000/redis:7", "redis:<b>8</b>", " redis:8 "]) {
  out.urls[`redis image ${image}`] = { type: "redis", attributes: { image, is_public: true, public_port: 16379 }, environmentVariables: REDIS_VARS };
}
out.urls["redis special characters"] = { type: "redis", attributes: { image: "redis:8", is_public: true, public_port: 16379 }, environmentVariables: [{ key: "REDIS_PASSWORD", value: SPECIAL }, { key: "REDIS_USERNAME", value: "us er@x" }] };
out.urls["redis without variables"] = { type: "redis", attributes: { image: "redis:8", is_public: true, public_port: 16379 }, environmentVariables: [] };
out.urls["redis blank username"] = { type: "redis", attributes: { image: "redis:8" }, environmentVariables: [{ key: "REDIS_PASSWORD", value: "S3cretPass" }, { key: "REDIS_USERNAME", value: "" }] };
out.urls["redis legacy quoting"] = { type: "redis", attributes: { image: "redis:8", legacy_password_quoting: true }, environmentVariables: REDIS_VARS };
// KeyDB and Dragonfly: a REDIS_PASSWORD variable, when there is one, is the server password.
for (const type of ["keydb", "dragonfly"]) {
  out.urls[`${type} with a REDIS_PASSWORD variable`] = { type, attributes: { ...ENGINES[type].base, is_public: true, public_port: 16379 }, environmentVariables: [{ key: "REDIS_PASSWORD", value: "FromVariable" }] };
  out.urls[`${type} with an empty REDIS_PASSWORD variable`] = { type, attributes: ENGINES[type].base, environmentVariables: [{ key: "REDIS_PASSWORD", value: "" }] };
  out.urls[`${type} legacy quoting`] = { type, attributes: { ...ENGINES[type].base, legacy_password_quoting: true }, environmentVariables: [{ key: "REDIS_PASSWORD", value: "FromVariable" }] };
}

// ---- validation
const COMMON_GOOD = { name: "My database", description: "A description", image: "postgres:18-alpine", portsMappings: "3000:5432", isPublic: false, publicPort: 5432, publicPortTimeout: 3600, isLogDrainEnabled: false, customDockerRunOptions: "--cap-add SYS_ADMIN" };
const COMMON_BAD = { name: "", description: "bad <script>", image: "", portsMappings: "abc", isPublic: "maybe", publicPort: "70000", publicPortTimeout: "0", isLogDrainEnabled: "maybe", customDockerRunOptions: null };
const FORMS = {
  postgresql: {
    stored: { postgres_user: "postgres", postgres_password: "Stored1", postgres_db: "postgres" },
    identifiers: { postgresUser: "postgres_user", postgresDb: "postgres_db" },
    passwords: { postgresPassword: "postgres_password" },
    free: ["postgresInitdbArgs", "postgresHostAuthMethod", "postgresConf", "initScripts"],
  },
  redis: {
    stored: {},
    variables: [{ key: "REDIS_PASSWORD", value: "Stored1" }, { key: "REDIS_USERNAME", value: "default" }],
    identifiers: { redisUsername: null },
    passwords: { redisPassword: null },
    storedInput: { redisUsername: "default", redisPassword: "Stored1" },
    free: ["redisConf"],
  },
  mysql: {
    stored: { mysql_user: "mysql", mysql_password: "Stored1", mysql_root_password: "Stored2", mysql_database: "default" },
    identifiers: { mysqlUser: "mysql_user", mysqlDatabase: "mysql_database" },
    passwords: { mysqlPassword: "mysql_password", mysqlRootPassword: "mysql_root_password" },
    free: ["mysqlConf"],
  },
  mariadb: {
    stored: { mariadb_user: "mariadb", mariadb_password: "Stored1", mariadb_root_password: "Stored2", mariadb_database: "default" },
    identifiers: { mariadbUser: "mariadb_user", mariadbDatabase: "mariadb_database" },
    passwords: { mariadbPassword: "mariadb_password", mariadbRootPassword: "mariadb_root_password" },
    free: ["mariadbConf"],
  },
  mongodb: {
    stored: { mongo_initdb_root_username: "root", mongo_initdb_root_password: "Stored1", mongo_initdb_database: "default" },
    identifiers: { mongoInitdbRootUsername: "mongo_initdb_root_username", mongoInitdbDatabase: "mongo_initdb_database" },
    passwords: { mongoInitdbRootPassword: "mongo_initdb_root_password" },
    free: ["mongoConf"],
  },
  keydb: { stored: { keydb_password: "Stored1" }, identifiers: {}, passwords: { keydbPassword: "keydb_password" }, free: ["keydbConf"] },
  dragonfly: { stored: { dragonfly_password: "Stored1" }, identifiers: {}, passwords: { dragonflyPassword: "dragonfly_password" }, free: [] },
  clickhouse: {
    stored: { clickhouse_admin_user: "default", clickhouse_admin_password: "Stored1" },
    identifiers: { clickhouseAdminUser: "clickhouse_admin_user" },
    passwords: { clickhouseAdminPassword: "clickhouse_admin_password" },
    free: [],
  },
};
for (const [type, f] of Object.entries(FORMS)) {
  const ids = Object.keys(f.identifiers);
  const pws = Object.keys(f.passwords);
  const storedOf = (field) => f.storedInput?.[field] ?? f.stored[f.identifiers[field] ?? f.passwords[field]];
  const unchanged = Object.fromEntries([...ids, ...pws].map((field) => [field, storedOf(field)]));
  const free = Object.fromEntries(f.free.map((field) => [field, null]));
  // Every case of a type gives only what differs from the type's base: the fields of `input`, and `stored` or `environmentVariables` whole.
  const base = { stored: f.stored, environmentVariables: f.variables ?? [], input: { ...COMMON_GOOD, ...free, ...unchanged } };
  out.validationBase[type] = base;
  const validation = (id, input, stored = f.stored, variables = f.variables) => {
    const changed = Object.fromEntries(Object.entries(input).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(base.input[field])));
    out.validation[`${type} ${id}`] = { type, ...(stored !== f.stored ? { stored } : {}), ...(variables !== f.variables ? { environmentVariables: variables } : {}), input: changed };
  };
  validation("everything valid", { ...COMMON_GOOD, ...free, ...Object.fromEntries(ids.map((i) => [i, "new_user1"])), ...Object.fromEntries(pws.map((p) => [p, "N3w-Pass.word!"])) });
  validation("everything unchanged", { ...COMMON_GOOD, ...free, ...unchanged });
  validation("everything invalid", { ...COMMON_BAD, ...free, ...Object.fromEntries(ids.map((i) => [i, "1 bad;name"])), ...Object.fromEntries(pws.map((p) => [p, "bad pass$word"])) });
  validation("credentials blank", { ...COMMON_GOOD, ...free, ...Object.fromEntries([...ids, ...pws].map((field) => [field, ""])) });
  validation("credentials null", { ...COMMON_GOOD, ...free, ...Object.fromEntries([...ids, ...pws].map((field) => [field, null])) });
  validation("credentials not strings", { ...COMMON_GOOD, ...free, ...Object.fromEntries([...ids, ...pws].map((field) => [field, 12345])) });
  validation("credentials at their longest", { ...COMMON_GOOD, ...free, ...Object.fromEntries(ids.map((i) => [i, "a".repeat(63)])), ...Object.fromEntries(pws.map((p) => [p, "a".repeat(128)])) });
  validation("credentials too long", { ...COMMON_GOOD, ...free, ...Object.fromEntries(ids.map((i) => [i, "a".repeat(64)])), ...Object.fromEntries(pws.map((p) => [p, "a".repeat(129)])) });
  // A stored value the pattern would refuse stays accepted while it is not changed.
  const legacyStored = { ...f.stored };
  const legacyInput = {};
  let legacyVariables = f.variables;
  for (const field of ids) {
    if (f.identifiers[field]) legacyStored[f.identifiers[field]] = "legacy-user";
    legacyInput[field] = "legacy-user";
  }
  for (const field of pws) {
    if (f.passwords[field]) legacyStored[f.passwords[field]] = "legacy pass$";
    legacyInput[field] = "legacy pass$";
  }
  if (type === "redis") legacyVariables = [{ key: "REDIS_PASSWORD", value: "legacy pass$" }, { key: "REDIS_USERNAME", value: "legacy-user" }];
  validation("legacy credentials unchanged", { ...COMMON_GOOD, ...free, ...legacyInput }, legacyStored, legacyVariables);
  validation("legacy credentials too long", { ...COMMON_GOOD, ...free, ...Object.fromEntries(ids.map((i) => [i, "legacy-" + "a".repeat(60)])), ...Object.fromEntries(pws.map((p) => [p, "legacy $" + "a".repeat(125)])) }, legacyStored, legacyVariables);

  const one = (id, changes) => validation(id, { ...COMMON_GOOD, ...free, ...unchanged, ...changes });
  one("name too long", { name: "n".repeat(256) });
  one("name with forbidden characters", { name: "db <1>" });
  one("name not a string", { name: 12 });
  one("description too long", { description: "d".repeat(256) });
  one("description null", { description: null });
  one("image null", { image: null });
  one("image not a string", { image: 42 });
  one("image a list", { image: ["postgres"] });
  for (const [id, value] of Object.entries({ "a pair": "3000:5432", "pairs with spaces removed": "3000:5432,8080:80/udp", "an ip": "127.0.0.1:8080:80", "ipv6": "[::1]::80", "a range": "3000-3005:3000-3005", "a single port": "5432", "a trailing comma": "3000:5432,", blank: "", "null": null, "a number": 5432 })) {
    one(`port mappings ${id}`, { portsMappings: value });
  }
  for (const [id, value] of Object.entries({ "zero": 0, "one": 1, "the highest": 65535, "too high": 65536, "negative": -1, "a decimal": 1.5, "a decimal string": "1.5", "a numeric string": "5432", "text": "abc", blank: "", "null": null, "true": true, "padded": " 5432 ", "leading zero": "05432" })) {
    one(`public port ${id}`, { publicPort: value });
  }
  for (const [id, value] of Object.entries({ "zero": 0, "one": 1, "negative": -5, "text": "abc", blank: "", "null": null, "a decimal": 2.5, "large": 99999999 })) {
    one(`public port timeout ${id}`, { publicPortTimeout: value });
  }
  for (const [id, value] of Object.entries({ "true": true, "false": false, "one": 1, "zero": 0, "the string one": "1", "the string zero": "0", "the string true": "true", "yes": "yes", "null": null, "two": 2, blank: "" })) {
    one(`is public ${id}`, { isPublic: value });
    one(`log drain ${id}`, { isLogDrainEnabled: value });
  }
  for (const [id, value] of Object.entries({ "a number": 5, "a list": ["--x"], "null": null, blank: "", "shell characters": "--env A=$(id); rm -rf /" })) {
    one(`docker options ${id}`, { customDockerRunOptions: value });
  }
  for (const field of f.free) {
    one(`${field} a string`, { [field]: "some = 'value'\n# comment" });
    if (field !== "initScripts") one(`${field} a number`, { [field]: 5 });
    one(`${field} blank`, { [field]: "" });
  }
  for (const field of ids) {
    for (const [id, value] of Object.entries({ "a leading digit": "1user", "an underscore first": "_user", "a hyphen": "my-user", "a space": "my user", "unicode": "üser", "one character": "a", "a dot": "a.b", "a trailing newline": "user\n" })) {
      one(`${field} with ${id}`, { [field]: value });
    }
  }
  for (const field of pws) {
    for (const [id, value] of Object.entries({ "every allowed symbol": "Aa0!@#%^*()_+-=[]{}:,.?/~", "a dollar": "pa$s", "a backtick": "pa`s", "a quote": "pa's", "a double quote": 'pa"s', "a backslash": "pa\\s", "a semicolon": "pa;s", "a pipe": "pa|s", "an ampersand": "pa&s", "angle brackets": "pa<s>", "a space": "pa s", "a tab": "pa\ts", "a trailing newline": "pass\n", "unicode": "pässword", "one character": "a" })) {
      one(`${field} with ${id}`, { [field]: value });
    }
  }
}
// Redis with a locked password variable: the password is not validated.
out.validation["redis locked password"] = {
  type: "redis",
  environmentVariables: [{ key: "REDIS_PASSWORD", value: "Stored1", is_shown_once: true }, { key: "REDIS_USERNAME", value: "default" }],
  input: { redisPassword: "bad pass$" },
};
out.validation["redis locked password left empty"] = {
  type: "redis",
  environmentVariables: [{ key: "REDIS_PASSWORD", value: "Stored1", is_shown_once: true }, { key: "REDIS_USERNAME", value: "default" }],
  input: { redisPassword: null },
};

const section = (cases) => "{\n" + Object.entries(cases).map(([id, c]) => `  ${JSON.stringify(id)}: ${JSON.stringify(c)}`).join(",\n") + "\n }";
writeFileSync(process.argv[2], "{\n" + Object.entries(out).map(([name, cases]) => ` ${JSON.stringify(name)}: ${section(cases)}`).join(",\n") + "\n}\n");
console.log(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Object.keys(v).length])));
