// An environment's Clone page (DP-100, CloneMe) through its handler, over the API goldens' fixture in PGlite
// (api-v1-database.ts), each case rolled back: mount()'s page, clone()'s rules and messages in Coolify's order, the
// clone into a new environment and into a new project (a service by DP-108's clone_service()), the 501s where Coolify
// copies volume data or writes a file mount on a server (nothing stored), authorization, org isolation and routing.
import type { Env } from "@deploy-core-worker/env";
import { route } from "@deploy-core-worker/router";
import { cloneMeContext, handleEnvironmentClone } from "@deploy-core-worker/handlers/environment-clone";
import { CLONE_ME_MESSAGES } from "@deploy-core-worker/projects/clone-me";
import { withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_A = ORG_UUID[1]!;
const ORG_B = ORG_UUID[2]!;
const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const PROJECT = "p1alphaprojectuuid000001";
const PRODUCTION = "e1alphaproduction0000001";
const STAGING = "e2alphastaging0000000002";
const BETA_PRODUCTION = "e3betaproduction00000003";
const DESTINATION = "d1paritydestination00001";
const OTHER_DESTINATION = "d2otherdestination000002";
const SERVICE = "f1parityservice000000001";
const actor = { subjectId: "usr_" + "0".repeat(31) + "1", subjectType: "user" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

let fixture: FixtureDatabase;
beforeAll(async () => {
  fixture = await fixtureDatabase();
}, 120_000);
afterAll(async () => fixture?.pg.close());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Answer = { status: number; body: { data?: Json; error?: { code: string; message: string; details?: Record<string, Json> } } };

function setup(db: TransactionalSqlExecutor, { write = true } = {}) {
  const asked: string[] = [];
  const env = {
    ENVIRONMENT: "test",
    DEPLOY_ENCRYPTION_KEY: TEST_KEK,
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const allow = body.action === "deploy.resource.write" ? write : true;
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  } as unknown as Env;
  const send = async (method: string, environment = PRODUCTION, body?: unknown, org = ORG_A, project = PROJECT): Promise<Answer> => {
    const init: RequestInit = { method, headers: { "content-type": "application/json" } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const url = `https://x/v1/organizations/${ORG_PUBLIC}/deploy/projects/${project}/environments/${environment}/clone`;
    const res = await handleEnvironmentClone(env, "req_1", actor, org, { projectUuid: project, environmentUuid: environment }, new Request(url, init), (_e, o, fn) =>
      withOrg(db, o, (tx) => fn(cloneMeContext(tx, o, TEST_KEK))),
    );
    return { status: res.status, body: (await res.json()) as Answer["body"] };
  };
  const query = (sql: string, params: unknown[] = [], org = ORG_A) =>
    withOrg(db, org, async (tx) => {
      await tx.execute("SET LOCAL search_path TO deploy");
      return (await tx.execute(sql, params)).rows as Array<Record<string, Json>>;
    });
  /** How many rows of what a clone writes the org has. */
  const counts = async (org = ORG_A) => {
    const tables = [
      "projects", "environments", "project_settings", "applications", "application_settings", "standalone_postgresqls", "standalone_redis", "standalone_mongodbs",
      "standalone_mysqls", "standalone_mariadbs", "standalone_keydbs", "standalone_dragonflies", "standalone_clickhouses", "services", "local_persistent_volumes",
      "local_file_volumes", "environment_variables", "taggables", "scheduled_tasks", "scheduled_database_backups",
    ];
    const out: Record<string, number> = {};
    for (const t of tables) out[t] = Number((await query(`SELECT count(*)::int AS n FROM ${t}`, [], org))[0]!.n);
    return out;
  };
  /** The service out of the way (moved to Beta), so that the environment holds only what Freeploy clones. */
  const withoutService = () => query("UPDATE services SET environment_id = (SELECT id FROM environments WHERE uuid = $1) WHERE uuid = $2", [BETA_PRODUCTION, SERVICE]);
  return { send, query, counts, asked, withoutService };
}

const inCase = <T>(fn: (db: TransactionalSqlExecutor) => Promise<T>) => fixture.inCase(fn);
const body = (extra: Record<string, unknown> = {}) => ({ type: "environment", newName: "alpha-copy", selectedDestination: DESTINATION, cloneVolumeData: false, ...extra });

describe("the Clone page (mount)", () => {
  it("answers the environment, the default name, the destinations by server and the resources by name", () =>
    inCase(async (db) => {
      const { send, asked } = setup(db);
      const r = await send("GET");
      expect(r.status).toBe(200);
      const data = r.body.data;
      expect(data.project).toEqual({ uuid: PROJECT, name: "Alpha" });
      expect(data.environment).toEqual({ uuid: PRODUCTION, name: "production" });
      // str(clone_resource_name('Alpha', new_public_id()))->slug(): the project's name, "-clone-" and a fresh id.
      expect(data.newName.replace(/-clone-[a-z0-9]+$/, "")).toBe("alpha");
      expect(data.newName).not.toBe((await send("GET")).body.data.newName);
      expect(data.servers).toEqual([{ uuid: "s1parityserveruuid000001", name: "parity-server", destinations: [{ uuid: DESTINATION, name: expect.any(String) }] }]);
      expect(data.applications.map((a: Json) => a.name)).toEqual(["parity-git", "parity-image"]);
      expect(data.databases.map((d: Json) => d.name)).toEqual([
        "parity-clickhouse", "parity-dragonfly", "parity-keydb", "parity-mariadb", "parity-mongodb", "parity-mysql", "parity-postgres", "parity-redis",
      ]);
      expect(data.services).toEqual([{ uuid: SERVICE, name: "parity-service", description: "The fixture's service" }]);
      // can.create.resources: the write permission, for the page too.
      expect(asked).toContain("deploy.resource.write");
    }));

  it("leaves out a build server; an environment of another project, or another org's project, is a 404", () =>
    inCase(async (db) => {
      const { send, query } = setup(db);
      await query("UPDATE server_settings SET server_role = 'build'");
      expect((await send("GET")).body.data.servers).toEqual([]);
      expect((await send("GET", BETA_PRODUCTION)).status).toBe(404);
      expect((await send("GET", PRODUCTION, undefined, ORG_B)).status).toBe(404);
      expect((await send("GET", "e4otherproduction0000004", undefined, ORG_B, "p3otherprojectuuid000003")).status).toBe(200);
    }));
});

describe("clone(): Coolify's rules and messages", () => {
  it("validates selectedDestination and newName with CloneMe::messages() and Laravel's own, all errors of a field, nothing stored", () =>
    inCase(async (db) => {
      const { send, counts } = setup(db);
      const before = await counts();
      const empty = await send("POST", PRODUCTION, { type: "environment" });
      expect(empty.status).toBe(422);
      expect(empty.body.error?.details?.fields).toEqual({ selectedDestination: ["Please select a server & destination."], newName: ["Please enter a name for the new project or environment."] });
      const short = await send("POST", PRODUCTION, body({ newName: "a<" }));
      expect(short.body.error?.details?.fields).toEqual({ newName: ["The new name field must be at least 3 characters.", "The new name field format is invalid."] });
      const long = await send("POST", PRODUCTION, body({ newName: "x".repeat(256) }));
      expect(long.body.error?.details?.fields).toEqual({ newName: ["The new name field must not be greater than 255 characters."] });
      expect((await send("POST", PRODUCTION, body({ newName: 42 }))).body.error?.details?.fields).toEqual({ newName: ["The new name field must be a string."] });
      expect(await counts()).toEqual(before);
    }));

  it("then 'Environment not found.' and 'Destination not found.' (another org's, or a build server's)", () =>
    inCase(async (db) => {
      const { send, query } = setup(db);
      const missing = await send("POST", BETA_PRODUCTION, body());
      expect([missing.status, missing.body.error?.message]).toEqual([422, CLONE_ME_MESSAGES.environmentNotFound]);
      expect(CLONE_ME_MESSAGES.environmentNotFound).toBe("Environment not found.");
      const foreign = await send("POST", PRODUCTION, body({ selectedDestination: OTHER_DESTINATION }));
      expect([foreign.status, foreign.body.error?.message]).toEqual([422, "Destination not found."]);
      await query("UPDATE server_settings SET server_role = 'build'");
      expect((await send("POST", PRODUCTION, body())).body.error?.message).toBe("Destination not found.");
    }));

  it("refuses a project or an environment name that exists; a name that differs only in case meets the unique index", () =>
    inCase(async (db) => {
      const { send, counts } = setup(db);
      const before = await counts();
      expect((await send("POST", PRODUCTION, body({ type: "project", newName: "Beta" }))).body.error?.message).toBe("Project with the same name already exists.");
      expect((await send("POST", PRODUCTION, body({ newName: "staging" }))).body.error?.message).toBe("Environment with the same name already exists.");
      expect((await send("POST", PRODUCTION, body({ newName: "Staging" }))).body.error?.message).toBe("Duplicate entry found. Please use a different name.");
      expect(await counts()).toEqual(before);
    }));
});

describe("clone(): what is cloned", () => {
  it("into a new environment of the project: the applications as clone-of-…, the databases under their names, each with its rows", () =>
    inCase(async (db) => {
      const { send, query, withoutService } = setup(db);
      await withoutService();
      const r = await send("POST", PRODUCTION, body({ newName: "Alpha Copy" }));
      expect(r.status).toBe(201);
      expect(r.body.data.projectUuid).toBe(PROJECT);
      const [env] = await query("SELECT e.id, e.name, p.uuid AS project FROM environments e JOIN projects p ON p.id = e.project_id WHERE e.uuid = $1", [r.body.data.environmentUuid]);
      // Environment::customizeName(): lower case.
      expect([env!.name, env!.project]).toEqual(["alpha copy", PROJECT]);
      const apps = await query("SELECT id, uuid, name, status, destination_id FROM applications WHERE environment_id = $1 ORDER BY id", [env!.id]);
      expect(apps.map((a) => a.name)).toEqual(apps.map((a, i) => `clone-of-${["parity-image", "parity-git"][i]}-${a.uuid}`));
      // 'status' => 'exited', as Application's status mutator stores it.
      expect(apps.map((a) => a.status)).toEqual(["exited:unhealthy", "exited:unhealthy"]);
      const image = apps[0]!;
      expect((await query("SELECT name FROM local_persistent_volumes WHERE resource_id = $1 AND resource_type = 'App\\Models\\Application'", [image.id])).map((v) => v.name)).toEqual([`${image.uuid}-data`]);
      expect(Number((await query("SELECT count(*)::int AS n FROM local_file_volumes WHERE resource_id = $1 AND resource_type = 'App\\Models\\Application'", [image.id]))[0]!.n)).toBe(3);
      const postgres = (await query("SELECT id, uuid, name, status, started_at FROM standalone_postgresqls WHERE environment_id = $1", [env!.id]))[0]!;
      expect([postgres.name, postgres.status, postgres.started_at]).toEqual(["parity-postgres", "exited:unhealthy", null]);
      expect((await query("SELECT name FROM local_persistent_volumes WHERE resource_id = $1 AND resource_type = 'App\\Models\\StandalonePostgresql'", [postgres.id])).map((v) => v.name)).toEqual([`postgres-data-${postgres.uuid}`]);
      expect(Number((await query("SELECT count(*)::int AS n FROM scheduled_database_backups WHERE database_id = $1", [postgres.id]))[0]!.n)).toBe(2);
      for (const t of ["standalone_redis", "standalone_mongodbs", "standalone_mysqls", "standalone_mariadbs", "standalone_keydbs", "standalone_dragonflies", "standalone_clickhouses"]) {
        expect(Number((await query(`SELECT count(*)::int AS n FROM ${t} WHERE environment_id = $1`, [env!.id]))[0]!.n)).toBe(1);
      }
      // The source is untouched.
      expect(Number((await query("SELECT count(*)::int AS n FROM applications WHERE environment_id = 1"))[0]!.n)).toBe(2);
    }));

  it("an environment with a service: clone_service() under the service's name, its parts parsed again (DP-108)", () =>
    inCase(async (db) => {
      const { send, query } = setup(db);
      const r = await send("POST", PRODUCTION, body({ newName: "with-service" }));
      expect(r.status).toBe(201);
      const [env] = await query("SELECT id FROM environments WHERE uuid = $1", [r.body.data.environmentUuid]);
      const services = await query("SELECT id, uuid, name, docker_compose FROM services WHERE environment_id = $1", [env!.id]);
      expect(services.map((x) => x.name)).toEqual(["parity-service"]);
      const clone = services[0]!;
      expect(clone.uuid).not.toBe(SERVICE);
      expect(clone.docker_compose).toContain(`container_name: web-${clone.uuid}`);
      expect(clone.docker_compose).toContain("coolify.environmentName=with-service");
      expect((await query("SELECT name FROM service_applications WHERE service_id = $1", [clone.id])).map((p) => p.name)).toEqual(["web"]);
      expect((await query("SELECT name FROM service_databases WHERE service_id = $1", [clone.id])).map((p) => p.name)).toEqual(["db"]);
      expect((await query("SELECT key FROM environment_variables WHERE resourceable_type = 'App\\Models\\Service' AND resourceable_id = $1 ORDER BY key", [clone.id])).map((v) => v.key)).toEqual(["DB_PASSWORD", "FOO"]);
      expect((await query("SELECT name FROM scheduled_tasks WHERE service_id = $1", [clone.id])).map((t) => t.name)).toEqual(["vacuum"]);
      // The source is untouched.
      expect(Number((await query("SELECT count(*)::int AS n FROM services WHERE uuid = $1 AND environment_id = 1", [SERVICE]))[0]!.n)).toBe(1);
    }));

  it("into a new project: its description gets ' (clone)', the source environment's name when it is not production, and the page opens it", () =>
    inCase(async (db) => {
      const { send, query, withoutService } = setup(db);
      await withoutService();
      const r = await send("POST", PRODUCTION, body({ type: "project", newName: "alpha-copy" }));
      expect(r.status).toBe(201);
      const [project] = await query("SELECT id, name, description FROM projects WHERE uuid = $1", [r.body.data.projectUuid]);
      expect([project!.name, project!.description]).toEqual(["alpha-copy", "The first project (clone)"]);
      const envs = await query("SELECT uuid, name FROM environments WHERE project_id = $1 ORDER BY id", [project!.id]);
      expect(envs).toEqual([{ uuid: r.body.data.environmentUuid, name: "production" }]);
      expect(Number((await query("SELECT count(*)::int AS n FROM project_settings WHERE project_id = $1", [project!.id]))[0]!.n)).toBe(1);
      expect(Number((await query("SELECT count(*)::int AS n FROM applications a JOIN environments e ON e.id = a.environment_id WHERE e.project_id = $1", [project!.id]))[0]!.n)).toBe(2);

      const staging = await send("POST", STAGING, body({ type: "project", newName: "staging-copy" }));
      const [copy] = await query("SELECT id, description FROM projects WHERE uuid = $1", [staging.body.data.projectUuid]);
      expect((await query("SELECT uuid, name FROM environments WHERE project_id = $1 ORDER BY id", [copy!.id])).map((e) => e.name)).toEqual(["production", "staging"]);
      expect((await query("SELECT name FROM environments WHERE uuid = $1", [staging.body.data.environmentUuid]))[0]!.name).toBe("staging");
    }));
});

describe("clone(): the 501s, after Coolify's checks, with nothing stored", () => {
  it("a service's file mount inside the clone's directory needs the SSH executor (DP-108's clone_service())", () =>
    inCase(async (db) => {
      const { send, counts, query } = setup(db);
      await query("UPDATE services SET docker_compose_raw = $1 WHERE uuid = $2", ["services:\n  web:\n    image: 'nginx:alpine'\n    volumes:\n      - './default.conf:/etc/nginx/conf.d/default.conf'\n", SERVICE]);
      const before = await counts();
      const r = await send("POST", PRODUCTION, body());
      expect([r.status, r.body.error?.code, r.body.error?.message]).toEqual([501, "unsupported", "Writing the clone's file mounts to the server needs the SSH executor, which is not available yet."]);
      // The applications come first: their volume copy is the first that cannot be done.
      expect((await send("POST", PRODUCTION, body({ cloneVolumeData: true }))).body.error?.message).toBe("Copying the volume data to the clone needs the SSH executor, which is not available yet.");
      expect(await counts()).toEqual(before);
    }));

  it("Clone volume data with a volume to copy needs the SSH executor; without it the clone is made", () =>
    inCase(async (db) => {
      const { send, counts, withoutService } = setup(db);
      await withoutService();
      const before = await counts();
      const r = await send("POST", PRODUCTION, body({ cloneVolumeData: true }));
      expect([r.status, r.body.error?.message]).toEqual([501, "Copying the volume data to the clone needs the SSH executor, which is not available yet."]);
      expect(await counts()).toEqual(before);
      expect((await send("POST", PRODUCTION, body({ cloneVolumeData: false }))).status).toBe(201);
    }));

  it("a managed file mount inside the clone's directory needs the SSH executor to be written", () =>
    inCase(async (db) => {
      const { send, counts, query, withoutService } = setup(db);
      await withoutService();
      await query("UPDATE local_file_volumes SET fs_path = './config.json' WHERE uuid = 'm1parityappconfigfile001'");
      const before = await counts();
      const r = await send("POST", PRODUCTION, body());
      expect([r.status, r.body.error?.message]).toEqual([501, "Writing the clone's file mounts to the server needs the SSH executor, which is not available yet."]);
      expect(await counts()).toEqual(before);
    }));
});

describe("authorization, org isolation and routing", () => {
  it("asks deploy.resource.write before anything; a denial is a 404 that stores nothing", () =>
    inCase(async (db) => {
      const { send, counts, withoutService } = setup(db, { write: false });
      await withoutService();
      const before = await counts();
      expect((await send("GET")).status).toBe(404);
      expect((await send("POST", PRODUCTION, body())).status).toBe(404);
      expect(await counts()).toEqual(before);
    }));

  it("another org sees neither the project nor its destination, and stores nothing in either org", () =>
    inCase(async (db) => {
      const { send, counts, withoutService } = setup(db);
      await withoutService();
      const [a, b] = [await counts(ORG_A), await counts(ORG_B)];
      expect((await send("POST", PRODUCTION, body(), ORG_B)).status).toBe(404);
      const theirs = await send("POST", "e4otherproduction0000004", body({ selectedDestination: DESTINATION }), ORG_B, "p3otherprojectuuid000003");
      expect(theirs.body.error?.message).toBe("Destination not found.");
      expect([await counts(ORG_A), await counts(ORG_B)]).toEqual([a, b]);
    }));

  it("answers 405 for another method; route() sends …/environments/{env}/clone here", async () => {
    const res = await handleEnvironmentClone({ ENVIRONMENT: "test" } as Env, "req_1", actor, ORG_A, { projectUuid: PROJECT, environmentUuid: PRODUCTION }, new Request("https://x/", { method: "DELETE" }));
    expect(res.status).toBe(405);
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    // Without bindings the handler answers 503: the route exists.
    expect((await route(new Request(`https://x/v1/organizations/${ORG_PUBLIC}/deploy/projects/${PROJECT}/environments/${PRODUCTION}/clone`, { headers }), { ENVIRONMENT: "test" } as Env)).status).toBe(503);
  });
});
