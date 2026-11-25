// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/databases.php (create_standalone_*: the name prefixes
// and which passwords are generated), app/Models/Standalone{Postgresql,Redis,Mysql,Mariadb,Mongodb,Keydb,Dragonfly,
// Clickhouse}.php (type(), the created hooks' volumes, isBackupSolutionAvailable), app/Support/PostgresUser.php,
// app/Livewire/Project/Database/{Postgresql,Redis,Mysql,Mariadb,Mongodb,Keydb,Dragonfly,Clickhouse}/{General,StatusInfo}.php
// (the properties, their rules, messages and validationAttributes, the SSL modes) and
// app/Livewire/Project/New/Select.php (DATABASE_IMAGE_STEPS) (Apache-2.0), modified.
//
// What differs from one database engine to the next, as data: everything else
// (creating, General's fields and saves, the connection URLs) is one
// implementation that reads these.
import type { DatabaseEngine } from "@saas/db/deploy";

/** A credential or free-text property of an engine's General component, and the column it is stored in. */
export interface DatabaseField {
  /** The Livewire property (the API's field). */
  property: string;
  /** The column, or null for a Redis credential, which is an environment variable (`variable`). */
  column: string | null;
  variable?: "REDIS_USERNAME" | "REDIS_PASSWORD";
  /**
   * identifier  ValidationPatterns::databaseIdentifierRules()
   * password    ValidationPatterns::databasePasswordRules()
   * text        'nullable' / 'nullable|string': free text
   */
  kind: "identifier" | "password" | "text";
  /** The label of databaseIdentifierMessages() / databasePasswordMessages(): the regex, min and max messages. */
  label?: string;
  /** $validationAttributes' entry — or, where the component has none, what Laravel derives from the property: the `required` message. */
  attribute: string;
  /** The value can embed credentials: only who may update the database reads it (syncData's $canSeeCredentials). */
  sensitive: boolean;
  /** "After the first start the credentials are read-only, so autofilled values must not be saved." */
  frozenOnceStarted?: boolean;
}

export interface SslMode {
  value: string;
  /** StatusInfo::sslModeOptions(): the option's label. */
  label: string;
}

export interface DatabaseEngineSpec {
  engine: DatabaseEngine;
  /** type(): "standalone-postgresql". */
  databaseType: string;
  /** create_standalone_*(): the name is "<prefix><uuid>". */
  namePrefix: string;
  /** Create::pendingResource(): str($type)->headline(), for "Creating …". */
  headline: string;
  /** StatusInfo::databaseLabel(): "<label> URL (internal)". */
  urlLabel: string;
  /** Select::DATABASE_IMAGE_STEPS: the image is chosen before the database is created. */
  imageStep: boolean;
  /** The columns create_standalone_*() fills with Str::password(length: 64, symbols: false). */
  generatedPasswords: readonly string[];
  fields: readonly DatabaseField[];
  /** General::messages(): 'name.required' => 'The Name field is required.' — or Laravel's default where the component has none. */
  nameRequired: string;
  /** StatusInfo::supportsSsl() */
  supportsSsl: boolean;
  /** StatusInfo::sslModeOptions(), or null where the engine has no mode. */
  sslModes: readonly SslMode[] | null;
  /** StatusInfo::sslModeHelper() */
  sslModeHelper: string | null;
  /** StatusInfo::showPublicUrlPlaceholder() */
  showPublicUrlPlaceholder: boolean;
  /** isBackupSolutionAvailable(): the Backups entries show. */
  backups: boolean;
}

const POSTGRES_SSL_MODES: readonly SslMode[] = [
  { value: "allow", label: "allow (insecure)" },
  { value: "prefer", label: "prefer (secure)" },
  { value: "require", label: "require (secure)" },
  { value: "verify-ca", label: "verify-ca (secure)" },
  { value: "verify-full", label: "verify-full (secure)" },
];

const NAME_REQUIRED = "The Name field is required.";
const NAME_REQUIRED_DEFAULT = "The name field is required.";

const text = (property: string, column: string, attribute: string, sensitive = true): DatabaseField => ({ property, column, kind: "text", attribute, sensitive });

export const DATABASE_ENGINE_SPECS: Readonly<Record<DatabaseEngine, DatabaseEngineSpec>> = {
  postgresql: {
    engine: "postgresql",
    databaseType: "standalone-postgresql",
    namePrefix: "postgresql-database-",
    headline: "Postgresql",
    urlLabel: "Postgres",
    imageStep: true,
    generatedPasswords: ["postgres_password"],
    fields: [
      { property: "postgresUser", column: "postgres_user", kind: "identifier", label: "Postgres User", attribute: "Postgres User", sensitive: false },
      { property: "postgresPassword", column: "postgres_password", kind: "password", label: "Postgres Password", attribute: "Postgres Password", sensitive: true },
      { property: "postgresDb", column: "postgres_db", kind: "identifier", label: "Postgres Database", attribute: "Postgres DB", sensitive: false },
      text("postgresInitdbArgs", "postgres_initdb_args", "Postgres Initdb Args", false),
      text("postgresHostAuthMethod", "postgres_host_auth_method", "Postgres Host Auth Method", false),
      text("postgresConf", "postgres_conf", "Postgres Configuration"),
    ],
    nameRequired: NAME_REQUIRED,
    supportsSsl: true,
    sslModes: POSTGRES_SSL_MODES,
    sslModeHelper: "Choose the SSL verification mode for PostgreSQL connections",
    showPublicUrlPlaceholder: false,
    backups: true,
  },
  redis: {
    engine: "redis",
    databaseType: "standalone-redis",
    namePrefix: "redis-database-",
    headline: "Redis",
    urlLabel: "Redis / Valkey",
    imageStep: true,
    generatedPasswords: [],
    fields: [
      text("redisConf", "redis_conf", "Redis Configuration"),
      { property: "redisUsername", column: null, variable: "REDIS_USERNAME", kind: "identifier", label: "Redis Username", attribute: "Redis Username", sensitive: false },
      { property: "redisPassword", column: null, variable: "REDIS_PASSWORD", kind: "password", label: "Redis Password", attribute: "Redis Password", sensitive: true },
    ],
    nameRequired: NAME_REQUIRED,
    supportsSsl: true,
    sslModes: null,
    sslModeHelper: null,
    showPublicUrlPlaceholder: false,
    backups: false,
  },
  mongodb: {
    engine: "mongodb",
    databaseType: "standalone-mongodb",
    namePrefix: "mongodb-database-",
    headline: "Mongodb",
    urlLabel: "Mongo",
    imageStep: false,
    generatedPasswords: ["mongo_initdb_root_password"],
    fields: [
      text("mongoConf", "mongo_conf", "Mongo Configuration"),
      { property: "mongoInitdbRootUsername", column: "mongo_initdb_root_username", kind: "identifier", label: "Root Username", attribute: "Root Username", sensitive: false },
      { property: "mongoInitdbRootPassword", column: "mongo_initdb_root_password", kind: "password", label: "Root Password", attribute: "Root Password", sensitive: true },
      { property: "mongoInitdbDatabase", column: "mongo_initdb_database", kind: "identifier", label: "MongoDB Database", attribute: "Database", sensitive: false },
    ],
    nameRequired: NAME_REQUIRED,
    supportsSsl: true,
    sslModes: POSTGRES_SSL_MODES.filter((m) => m.value !== "verify-ca"),
    sslModeHelper: "Choose the SSL verification mode for MongoDB connections",
    showPublicUrlPlaceholder: false,
    backups: true,
  },
  mysql: {
    engine: "mysql",
    databaseType: "standalone-mysql",
    namePrefix: "mysql-database-",
    headline: "Mysql",
    urlLabel: "MySQL",
    imageStep: false,
    generatedPasswords: ["mysql_root_password", "mysql_password"],
    fields: [
      { property: "mysqlRootPassword", column: "mysql_root_password", kind: "password", label: "Root Password", attribute: "Root Password", sensitive: true },
      { property: "mysqlUser", column: "mysql_user", kind: "identifier", label: "MySQL User", attribute: "User", sensitive: false },
      { property: "mysqlPassword", column: "mysql_password", kind: "password", label: "MySQL Password", attribute: "Password", sensitive: true },
      { property: "mysqlDatabase", column: "mysql_database", kind: "identifier", label: "MySQL Database", attribute: "Database", sensitive: false },
      text("mysqlConf", "mysql_conf", "MySQL Configuration"),
    ],
    nameRequired: NAME_REQUIRED,
    supportsSsl: true,
    sslModes: [
      { value: "PREFERRED", label: "Prefer (secure)" },
      { value: "REQUIRED", label: "Require (secure)" },
      { value: "VERIFY_CA", label: "Verify CA (secure)" },
      { value: "VERIFY_IDENTITY", label: "Verify Full (secure)" },
    ],
    sslModeHelper: "Choose the SSL verification mode for MySQL connections",
    showPublicUrlPlaceholder: false,
    backups: true,
  },
  mariadb: {
    engine: "mariadb",
    databaseType: "standalone-mariadb",
    namePrefix: "mariadb-database-",
    headline: "Mariadb",
    urlLabel: "MariaDB",
    imageStep: false,
    generatedPasswords: ["mariadb_root_password", "mariadb_password"],
    fields: [
      { property: "mariadbRootPassword", column: "mariadb_root_password", kind: "password", label: "Root Password", attribute: "Root Password", sensitive: true },
      { property: "mariadbUser", column: "mariadb_user", kind: "identifier", label: "MariaDB User", attribute: "User", sensitive: false },
      { property: "mariadbPassword", column: "mariadb_password", kind: "password", label: "MariaDB Password", attribute: "Password", sensitive: true },
      { property: "mariadbDatabase", column: "mariadb_database", kind: "identifier", label: "MariaDB Database", attribute: "Database", sensitive: false },
      text("mariadbConf", "mariadb_conf", "MariaDB Configuration"),
    ],
    nameRequired: NAME_REQUIRED,
    supportsSsl: true,
    sslModes: null,
    sslModeHelper: null,
    showPublicUrlPlaceholder: false,
    backups: true,
  },
  keydb: {
    engine: "keydb",
    databaseType: "standalone-keydb",
    namePrefix: "keydb-database-",
    headline: "Keydb",
    urlLabel: "KeyDB",
    imageStep: false,
    generatedPasswords: ["keydb_password"],
    fields: [
      text("keydbConf", "keydb_conf", "keydb conf"),
      { property: "keydbPassword", column: "keydb_password", kind: "password", label: "KeyDB Password", attribute: "keydb password", sensitive: true, frozenOnceStarted: true },
    ],
    nameRequired: NAME_REQUIRED_DEFAULT,
    supportsSsl: true,
    sslModes: null,
    sslModeHelper: null,
    showPublicUrlPlaceholder: true,
    backups: false,
  },
  dragonfly: {
    engine: "dragonfly",
    databaseType: "standalone-dragonfly",
    namePrefix: "dragonfly-database-",
    headline: "Dragonfly",
    urlLabel: "Dragonfly",
    imageStep: false,
    generatedPasswords: ["dragonfly_password"],
    fields: [{ property: "dragonflyPassword", column: "dragonfly_password", kind: "password", label: "Dragonfly Password", attribute: "dragonfly password", sensitive: true, frozenOnceStarted: true }],
    nameRequired: NAME_REQUIRED_DEFAULT,
    supportsSsl: true,
    sslModes: null,
    sslModeHelper: null,
    showPublicUrlPlaceholder: true,
    backups: false,
  },
  clickhouse: {
    engine: "clickhouse",
    databaseType: "standalone-clickhouse",
    namePrefix: "clickhouse-database-",
    headline: "Clickhouse",
    urlLabel: "Clickhouse",
    imageStep: false,
    generatedPasswords: ["clickhouse_admin_password"],
    fields: [
      { property: "clickhouseAdminUser", column: "clickhouse_admin_user", kind: "identifier", label: "Admin User", attribute: "clickhouse admin user", sensitive: false, frozenOnceStarted: true },
      { property: "clickhouseAdminPassword", column: "clickhouse_admin_password", kind: "password", label: "Admin Password", attribute: "clickhouse admin password", sensitive: true, frozenOnceStarted: true },
    ],
    nameRequired: NAME_REQUIRED_DEFAULT,
    supportsSsl: false,
    sslModes: null,
    sslModeHelper: null,
    showPublicUrlPlaceholder: true,
    backups: true,
  },
};

/** The `type` of the New Resource page and of POST /databases for an engine (they are the same words). */
export const isDatabaseEngine = (value: unknown): value is DatabaseEngine => typeof value === "string" && Object.prototype.hasOwnProperty.call(DATABASE_ENGINE_SPECS, value);

/** PostgresUser::isSupabaseImage(): '~(^|/)supabase/postgres(:|@|$)~'. */
export const isSupabaseImage = (image: string | null): boolean => /(^|\/)supabase\/postgres(:|@|$)/.test(image ?? "");
/** PostgresUser::SUPABASE_ADMIN: the superuser of Supabase images. */
export const SUPABASE_ADMIN = "supabase_admin";

export interface DatabaseVolume {
  name: string;
  mountPath: string;
}

/**
 * The created hook of each model: the data volumes a new database gets.
 * PostgreSQL reads its major version from the image — the first ":<digits>"
 * (or ":pg<digits>") in it — and mounts /var/lib/postgresql from 18 on,
 * /var/lib/postgresql/data before (and when the image names no version).
 */
export function defaultVolumes(engine: DatabaseEngine, uuid: string, image: string | null): DatabaseVolume[] {
  switch (engine) {
    case "postgresql": {
      const major = Number(/:(?:pg)?(\d+)/i.exec(image ?? "")?.[1] ?? 0);
      return [{ name: `postgres-data-${uuid}`, mountPath: major >= 18 ? "/var/lib/postgresql" : "/var/lib/postgresql/data" }];
    }
    case "redis":
      return [{ name: `redis-data-${uuid}`, mountPath: "/data" }];
    case "mongodb":
      return [
        { name: `mongodb-configdb-${uuid}`, mountPath: "/data/configdb" },
        { name: `mongodb-db-${uuid}`, mountPath: "/data/db" },
      ];
    case "mysql":
      return [{ name: `mysql-data-${uuid}`, mountPath: "/var/lib/mysql" }];
    case "mariadb":
      return [{ name: `mariadb-data-${uuid}`, mountPath: "/var/lib/mysql" }];
    case "keydb":
      return [{ name: `keydb-data-${uuid}`, mountPath: "/data" }];
    case "dragonfly":
      return [{ name: `dragonfly-data-${uuid}`, mountPath: "/data" }];
    case "clickhouse":
      return [{ name: `clickhouse-data-${uuid}`, mountPath: "/var/lib/clickhouse" }];
  }
}
