// A service's Resource Operations → Clone (DP-97's checks, DP-108's clone_service()) through its handler, over the API
// goldens' fixture in PGlite (api-v1-database.ts), each case rolled back: the clone in the service's own environment
// or another one, what it copies (tags, the scheduled task, the variables, a database's backup schedule) and what
// Service::parse() makes again, and the 501s — a file mount the parser made inside the clone's directory, the volume
// data — after which nothing is stored. The answers the API gives are api-v1-service-clone.test.ts's, held to Coolify's.
import type { Env } from "@deploy-core-worker/env";
import { handleServiceConfiguration, serviceResourcesContext } from "@deploy-core-worker/handlers/service-configuration";
import { withOrg } from "@saas/db/deploy";
import type { TransactionalSqlExecutor } from "@saas/db/hyperdrive";
import { fixtureDatabase, ORG_UUID, TEST_KEK, type FixtureDatabase } from "./api-v1-database.js";

const ORG_A = ORG_UUID[1]!;
const ORG_PUBLIC = "org_" + "0".repeat(31) + "a";
const SERVICE = "f1parityservice000000001";
const DESTINATION = "d1paritydestination00001";
const OTHER_DESTINATION = "d2otherdestination000002";
const STAGING = "e2alphastaging0000000002";
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
  const env = {
    ENVIRONMENT: "test",
    DEPLOY_ENCRYPTION_KEY: TEST_KEK,
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      const allow = body.action === "deploy.resource.write" ? write : true;
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  } as unknown as Env;
  const clone = async (body: unknown, uuid = SERVICE): Promise<Answer> => {
    const url = `https://x/v1/organizations/${ORG_PUBLIC}/deploy/services/${uuid}/resource-operations/clone`;
    const res = await handleServiceConfiguration(env, "req_1", actor, ORG_A, [uuid, "resource-operations", "clone"], new Request(url, { method: "POST", body: JSON.stringify(body) }), (_e, o, fn) =>
      withOrg(db, o, (tx) => fn(serviceResourcesContext(tx, o, TEST_KEK))),
    );
    return { status: res.status, body: (await res.json()) as Answer["body"] };
  };
  const query = (sql: string, params: unknown[] = []) =>
    withOrg(db, ORG_A, async (tx) => {
      await tx.execute("SET LOCAL search_path TO deploy");
      return (await tx.execute(sql, params)).rows as Array<Record<string, Json>>;
    });
  const counts = async () => {
    const out: Record<string, number> = {};
    for (const t of ["services", "service_applications", "service_databases", "environment_variables", "local_persistent_volumes", "local_file_volumes", "taggables", "scheduled_tasks", "scheduled_database_backups"]) {
      out[t] = Number((await query(`SELECT count(*)::int AS n FROM ${t}`))[0]!.n);
    }
    return out;
  };
  return { clone, query, counts };
}

const inCase = <T>(fn: (db: TransactionalSqlExecutor) => Promise<T>) => fixture.inCase(fn);
const compose = (volumes: string) => `services:\n  web:\n    image: 'nginx:alpine'\n    volumes:\n      - '${volumes}'\n  db:\n    image: 'postgres:16-alpine'\n`;

describe("Resource Operations → Clone of a service (DP-108)", () => {
  it("clones the service onto the destination in its own environment and opens the clone's page", () =>
    inCase(async (db) => {
      const { clone, query } = setup(db);
      await query("UPDATE scheduled_database_backups SET database_type = 'App\\Models\\ServiceDatabase', database_id = 1 WHERE id = 2");
      const r = await clone({ destination_uuid: DESTINATION, cloneVolumeData: false });
      expect(r.status).toBe(201);
      expect(r.body.data).toEqual({ projectUuid: "p1alphaprojectuuid000001", environmentUuid: "e1alphaproduction0000001", serviceUuid: expect.any(String) });
      const uuid = r.body.data.serviceUuid as string;
      const [copy] = await query("SELECT id, name, environment_id, compose_parsing_version, docker_compose FROM services WHERE uuid = $1", [uuid]);
      expect([copy!.name, Number(copy!.environment_id), copy!.compose_parsing_version]).toEqual([`parity-service-clone-${uuid}`, 1, "5"]);
      expect(copy!.docker_compose).toContain(`container_name: db-${uuid}`);
      expect((await query("SELECT tag_id FROM taggables WHERE taggable_type = 'App\\Models\\Service' AND taggable_id = $1", [copy!.id])).map((t) => Number(t.tag_id))).toEqual([2]);
      expect((await query("SELECT name FROM scheduled_tasks WHERE service_id = $1", [copy!.id])).map((t) => t.name)).toEqual(["vacuum"]);
      const [database] = await query("SELECT id FROM service_databases WHERE service_id = $1", [copy!.id]);
      const backups = await query("SELECT b.id, (SELECT count(*)::int FROM scheduled_database_backup_s3_storage p WHERE p.scheduled_database_backup_id = b.id) AS s3 FROM scheduled_database_backups b WHERE b.database_type = 'App\\Models\\ServiceDatabase' AND b.database_id = $1", [database!.id]);
      expect(backups.map((b) => Number(b.s3))).toEqual([1]);
    }));

  it("into another environment of the org; an unknown one is cloneTo()'s field error", () =>
    inCase(async (db) => {
      const { clone, query } = setup(db);
      const r = await clone({ destination_uuid: DESTINATION, environment_uuid: STAGING });
      expect([r.status, r.body.data.environmentUuid]).toEqual([201, STAGING]);
      expect(Number((await query("SELECT environment_id FROM services WHERE uuid = $1", [r.body.data.serviceUuid]))[0]!.environment_id)).toBe(2);
      const unknown = await clone({ destination_uuid: DESTINATION, environment_uuid: "nope" });
      expect([unknown.status, unknown.body.error?.details?.fields]).toEqual([422, { environment_id: ["Environment not found."] }]);
      const foreign = await clone({ destination_uuid: OTHER_DESTINATION });
      expect([foreign.status, foreign.body.error?.details?.fields]).toEqual([422, { destination_id: ["Destination not found."] }]);
    }));

  it("a file mount inside the clone's directory, then the volume data, need the SSH executor; nothing is stored", () =>
    inCase(async (db) => {
      const { clone, query, counts } = setup(db);
      await query("UPDATE services SET docker_compose_raw = $1 WHERE uuid = $2", [compose("./default.conf:/etc/nginx/conf.d/default.conf"), SERVICE]);
      const before = await counts();
      const files = await clone({ destination_uuid: DESTINATION, cloneVolumeData: true });
      expect([files.status, files.body.error?.code, files.body.error?.message]).toEqual([501, "unsupported", "Writing the clone's file mounts to the server needs the SSH executor, which is not available yet."]);
      expect(await counts()).toEqual(before);

      // A named volume whose mount path the source's web part has a volume at (the fixture's web-html).
      await query("UPDATE services SET docker_compose_raw = $1 WHERE uuid = $2", [compose("web-html:/usr/share/nginx/html"), SERVICE]);
      const volumes = await clone({ destination_uuid: DESTINATION, cloneVolumeData: true });
      expect([volumes.status, volumes.body.error?.message]).toEqual([501, "Copying the volume data to the clone needs the SSH executor, which is not available yet."]);
      expect(await counts()).toEqual(before);
      // Without the volume data the clone is made, with its own volume.
      const made = await clone({ destination_uuid: DESTINATION, cloneVolumeData: false });
      expect(made.status).toBe(201);
      const names = await query("SELECT v.name FROM local_persistent_volumes v JOIN service_applications a ON a.id = v.resource_id AND v.resource_type = 'App\\Models\\ServiceApplication' JOIN services s ON s.id = a.service_id WHERE s.uuid = $1", [made.body.data.serviceUuid]);
      expect(names.map((v) => v.name)).toEqual([`${made.body.data.serviceUuid}_web-html`]);
    }));

  it("is deploy.resource.write's: a denial is a 404 that stores nothing", () =>
    inCase(async (db) => {
      const { clone, counts } = setup(db, { write: false });
      const before = await counts();
      expect((await clone({ destination_uuid: DESTINATION })).status).toBe(404);
      expect((await setup(db).clone({ destination_uuid: DESTINATION }, "f2otherservice0000000002")).status).toBe(404);
      expect(await counts()).toEqual(before);
    }));
});
