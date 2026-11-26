// Derived from coollabsio/coolify@91b7e3e:app/Models/StandaloneSqlite.php (connectedVolumes,
// composeApplicationsUsingDataVolume, hasConnectedApplications, connectedApplicationNames) and
// bootstrap/helpers/parsers.php (composeExternalVolumeDockerNames, composeExternalVolumeDockerName) (Apache-2.0), modified.
//
// Who mounts a SQLite database's data volume (DP-112): an application with a volume connected from the database's page
// (local_persistent_volumes.standalone_sqlite_id), or a Docker Compose application on the same server whose Compose
// file declares the volume as external. Coolify refuses to delete a database such an application mounts.
import { listComposeApplications, listDatabaseVolumeNames, listSqliteConnectedVolumes } from "@saas/db/deploy";
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { PhpArray, phpString } from "../compose/php.js";
import { dataGet } from "../compose/support.js";
import { parseDockerComposeYaml } from "../compose/yaml.js";
import { isComposeExternalVolume } from "../services/compose-helpers.js";

/**
 * composeExternalVolumeDockerNames(): the Docker names of the external volumes a Compose file declares at its top level
 * (`name`, else `external.name`, else the key); none for a file that is empty or not valid YAML.
 */
export function composeExternalVolumeDockerNames(compose: string | null): string[] {
  if (compose === null || compose.trim() === "") return [];
  let volumes;
  try {
    volumes = dataGet(parseDockerComposeYaml(compose), "volumes");
  } catch {
    return [];
  }
  if (!(volumes instanceof PhpArray)) return [];
  const names: string[] = [];
  for (const [key, declaration] of volumes) {
    if (!isComposeExternalVolume(declaration)) continue;
    const name = dataGet(declaration, "name");
    const externalName = dataGet(declaration, "external.name");
    names.push(name !== null ? phpString(name) : externalName !== null ? phpString(externalName) : String(key));
  }
  return names;
}

/** What hasConnectedApplications() and connectedApplicationNames() read of a SQLite database. */
export interface SqliteDatabaseRef {
  id: string | number;
  /** $this->destination?->server_id */
  serverId: string | number | null;
}

/**
 * connectedApplicationNames(): the names of the resources that mount the database's data volume — the connected
 * volumes' resources, then the Docker Compose applications of the org on the database's server that declare one of
 * its Docker volumes as external — without empty and repeated names; null when none does (hasConnectedApplications()
 * is false). A connected volume whose resource is gone still counts, without a name, as in Coolify.
 */
export async function sqliteConnectedApplicationNames(tx: SqlExecutor, db: SqliteDatabaseRef): Promise<string[] | null> {
  const connected = await listSqliteConnectedVolumes(tx, db.id);
  const names: Array<string | null> = connected.map((v) => v.resource_name);
  if (db.serverId !== null) {
    const volumes = await listDatabaseVolumeNames(tx, "sqlite", db.id);
    for (const application of await listComposeApplications(tx)) {
      if (application.server_id === null || String(application.server_id) !== String(db.serverId)) continue;
      const external = composeExternalVolumeDockerNames(application.docker_compose_raw);
      if (volumes.some((v) => external.includes(v))) names.push(application.name);
    }
  }
  if (names.length === 0) return null;
  return [...new Set(names.filter((n): n is string => n !== null && n !== ""))];
}
