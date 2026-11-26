// Derived from coollabsio/coolify@91b7e3e:app/Actions/Database/{StartDatabaseProxy,StopDatabaseProxy}.php and
// bootstrap/helpers/{shared,docker}.php (database_proxy_dir, dockerRemoveCommand) (Apache-2.0), modified.
//
// The TCP proxy of a public database: an nginx container on the database's network that listens on the public
// port and passes the stream to the database. Pure functions of plain row data: the nginx configuration, the
// compose file and the commands that start it, and the one command that removes it. Byte-equal to Coolify's PHP
// for the proxy runs of tests/deploy-core-worker/fixtures/database-start.
//
// Only a standalone database's proxy is here; a service's database (ServiceDatabase) comes with services.
import type { DatabaseEngine } from "@saas/db/deploy";
import { RESTART_MODE } from "../deployments/compose.js";
import { base64Encode, escapeshellarg } from "../deployments/php.js";
import { yamlDump, type YamlValue } from "../deployments/yaml.js";
import { dockerRemoveCommand } from "../helpers/docker.js";
import { databaseWorkdir } from "./start-plan.js";

/**
 * StartDatabaseProxy::CONFIG_VERSION: the version of the generated proxy configuration, kept as a label so that
 * a status check can recreate a proxy started with an older one.
 */
export const PROXY_CONFIG_VERSION = "2";
export const PROXY_CONFIG_VERSION_LABEL = "coolify.databaseProxyConfigVersion";

/** The port the engine listens on in its container; with SSL, the Redis-like engines listen on 6380. */
export function databaseInternalPort(engine: DatabaseEngine, enableSsl: boolean): number {
  switch (engine) {
    case "mariadb":
    case "mysql":
      return 3306;
    case "postgresql":
      return 5432;
    case "redis":
    case "keydb":
    case "dragonfly":
      return enableSsl ? 6380 : 6379;
    case "clickhouse":
      return 9000;
    case "mongodb":
      return 27017;
    case "sqlite":
      // A SQLite database is never public: its table has no public_port, and General no Access section.
      throw new Error("A SQLite database has no port.");
  }
}

/** database_proxy_dir() */
export const databaseProxyDir = (uuid: string): string => `${databaseWorkdir(uuid)}/proxy`;
export const databaseProxyContainer = (uuid: string): string => `${uuid}-proxy`;

/** The command that asks whether the database's network has IPv6: Docker then publishes the port on [::] too. */
export const networkIpv6Command = (network: string): string => `docker network inspect ${escapeshellarg(network)} --format '{{.EnableIPv6}}'`;

export interface ProxyPlanInput {
  engine: DatabaseEngine;
  uuid: string;
  /** $database->destination->network */
  network: string;
  publicPort: number;
  /** Seconds an idle connection stays open; null or below 1 is an hour. */
  publicPortTimeout: number | null;
  enableSsl: boolean;
  /** What networkIpv6Command() answered "true" to. */
  ipv6Enabled: boolean;
}

export interface ProxyPlan {
  nginxConf: string;
  compose: string;
  commands: string[];
  configurationDir: string;
  containerName: string;
}

/** StartDatabaseProxy::handle(): the proxy's files and the commands that (re)create its container. */
export function buildProxyPlan(input: ProxyPlanInput): ProxyPlan {
  const container = databaseProxyContainer(input.uuid);
  const dir = databaseProxyDir(input.uuid);
  const port = input.publicPort;
  // buildProxyTimeoutConfig()
  const timeout = input.publicPortTimeout === null || input.publicPortTimeout < 1 ? 3600 : input.publicPortTimeout;
  // buildListenConfig()
  const listen = input.ipv6Enabled ? `listen ${port};\n        listen [::]:${port};` : `listen ${port};`;
  // buildUpstreamConfig(): the upstream is a variable so nginx resolves it through Docker's DNS on new connections.
  const upstream = `set $upstream ${input.uuid}:${databaseInternalPort(input.engine, input.enableSsl)};\n        proxy_pass $upstream;`;
  const nginxConf = [
    "user  nginx;",
    "worker_processes  auto;",
    "",
    "error_log  /var/log/nginx/error.log;",
    "",
    "events {",
    "    worker_connections  1024;",
    "}",
    "stream {",
    "   resolver 127.0.0.11 valid=10s;",
    "   server {",
    `        ${listen}`,
    `        ${upstream}`,
    `        proxy_timeout ${timeout}s;`,
    "   }",
    "}",
  ].join("\n");

  const map = (entries: Array<[string, YamlValue]>): Map<string, YamlValue> => new Map(entries);
  const compose = map([
    [
      "services",
      map([
        [
          container,
          map([
            ["image", "nginx:stable-alpine"],
            ["container_name", container],
            ["restart", RESTART_MODE],
            ["labels", map([[PROXY_CONFIG_VERSION_LABEL, PROXY_CONFIG_VERSION]])],
            ["ports", [`${port}:${port}`]],
            ["networks", [input.network]],
            ["volumes", [map([["type", "bind"], ["source", `${dir}/nginx.conf`], ["target", "/etc/nginx/nginx.conf"]])]],
            ["healthcheck", map([["test", ["CMD", "stat", "/etc/nginx/nginx.conf"]], ["interval", "5s"], ["timeout", "5s"], ["retries", 3], ["start_period", "1s"]])],
          ]),
        ],
      ]),
    ],
    ["networks", map([[input.network, map([["external", true], ["name", input.network], ["attachable", true]])]])],
  ]);
  const yaml = yamlDump(compose, 4, 2);

  return {
    nginxConf,
    compose: yaml,
    configurationDir: dir,
    containerName: container,
    commands: [
      `mkdir -p ${dir}`,
      `echo '${base64Encode(nginxConf)}' | base64 -d | tee ${dir}/nginx.conf > /dev/null`,
      `echo '${base64Encode(yaml)}' | base64 -d | tee ${dir}/docker-compose.yaml > /dev/null`,
      // Pass -f so Compose uses only the file that was written here.
      `docker compose --project-directory ${dir} -f ${dir}/docker-compose.yaml pull`,
      // Remove the old proxy only after the pull, so a failed pull keeps it running.
      dockerRemoveCommand(container),
      `docker compose --project-directory ${dir} -f ${dir}/docker-compose.yaml up -d`,
    ],
  };
}

/** StopDatabaseProxy::handle(): the command that removes the proxy container (no error when there is none). */
export const proxyStopCommand = (uuid: string): string => dockerRemoveCommand(databaseProxyContainer(uuid));

/** isNonTransientError(): a start that failed because the port is taken will fail again, so the database goes private. */
export function isNonTransientProxyError(message: string): boolean {
  return ["port is already allocated", "address already in use", "Bind for"].some((pattern) => message.includes(pattern));
}
