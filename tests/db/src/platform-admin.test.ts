// The platform operator's data (freeploy-coolify-parity DP12, DP-79), against a real Postgres (PGlite):
//  - the platform settings are Coolify's instance settings row 0 of deploy.instance_settings, owned by no
//    org: deploy_app with any org set sees none of it and cannot change it; only asPlatformAdmin() reads
//    and writes it; it is created with Coolify's defaults, the sponsorship reminder off;
//  - the Admin View's users and subscriber counts (packages/db/src/membership/platform-admin.ts) on the
//    identity, membership and billing migrations of the manifest.
import { PGlite } from "@electric-sql/pglite";
import { manifest } from "@saas/db";
import { asPlatformAdmin, readPlatformSettings, updatePlatformSettings, withOrg, PLATFORM_SETTINGS_ORG_ID } from "@saas/db/deploy";
import { countPlatformSubscribers, listPlatformUsers, type PlatformUsersQuery } from "@saas/db/membership";
import { deployDatabase, executor, migrationSql } from "./deploy-schema.js";

const ORG_A = "00000000-0000-4000-8000-00000000000a";

describe("platform settings: row 0 of deploy.instance_settings", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await deployDatabase();
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  test("created on first read with Coolify's defaults, the sponsorship reminder off, owned by no org", async () => {
    const row = await asPlatformAdmin(executor(db), (tx) => readPlatformSettings(tx));
    expect(row).toMatchObject({
      instance_name: null,
      is_registration_enabled: true,
      disable_two_step_confirmation: false,
      is_passkey_enabled: true,
      is_dns_validation_enabled: true,
      is_sponsorship_popup_enabled: false,
    });
    const owner = await db.query<{ id: number; org_id: string }>("SELECT id, org_id FROM deploy.instance_settings");
    expect(owner.rows).toEqual([{ id: 0, org_id: PLATFORM_SETTINGS_ORG_ID }]);
  });

  test("the operator writes the ported columns and nothing else", async () => {
    const row = await asPlatformAdmin(executor(db), (tx) =>
      updatePlatformSettings(tx, { instance_name: "Freeploy stage", is_registration_enabled: false, is_sponsorship_popup_enabled: true }),
    );
    expect(row).toMatchObject({ instance_name: "Freeploy stage", is_registration_enabled: false, is_sponsorship_popup_enabled: true, is_passkey_enabled: true });
  });

  test("an org — any org — sees nothing of it and changes nothing", async () => {
    const seen = await withOrg(executor(db), ORG_A, (tx) => tx.execute("SELECT * FROM deploy.instance_settings"));
    expect(seen.rows).toEqual([]);
    const changed = await withOrg(executor(db), ORG_A, (tx) => tx.execute("UPDATE deploy.instance_settings SET instance_name = 'pwned'"));
    expect(changed.rowCount).toBe(0);
    // An org cannot claim the platform's org id either: its own row is all it can write.
    await expect(
      withOrg(executor(db), ORG_A, (tx) => tx.execute("INSERT INTO deploy.instance_settings (id, org_id) VALUES (1, $1)", [PLATFORM_SETTINGS_ORG_ID])),
    ).rejects.toThrow();
    // readPlatformSettings() under an org: its insert is refused by row-level security.
    await expect(withOrg(executor(db), ORG_A, (tx) => readPlatformSettings(tx))).rejects.toThrow();
    const row = await asPlatformAdmin(executor(db), (tx) => readPlatformSettings(tx));
    expect(row.instance_name).toBe("Freeploy stage");
  });
});

describe("the Admin View's users and subscribers", () => {
  let db: PGlite;
  const U = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
  const subject = (uuid: string) => `usr_${uuid.replace(/-/g, "")}`;
  const ORG_PAID = "00000000-0000-4000-8000-0000000000a1";
  const ORG_LAPSED = "00000000-0000-4000-8000-0000000000a2";
  const ORG_FREE = "00000000-0000-4000-8000-0000000000a3";
  const q = (over: Partial<PlatformUsersQuery> = {}): PlatformUsersQuery => ({ search: "", teamFilter: "all", orgId: null, sort: "name_asc", excludeUserId: null, limit: 10, offset: 0, ...over });

  beforeAll(async () => {
    db = new PGlite();
    for (const m of manifest.migrations.filter((x) => x.context === "identity" || x.context === "membership" || x.context === "billing")) await db.exec(migrationSql(m.id));
    await db.query(
      `INSERT INTO identity.users (id, email, email_lower, display_name, status) VALUES
        ($1, 'alice@example.com', 'alice@example.com', 'Alice', 'active'),
        ($2, 'bob@example.com', 'bob@example.com', 'Bob', 'active'),
        ($3, 'carol@example.com', 'carol@example.com', NULL, 'active'),
        ($4, 'gone@example.com', 'gone@example.com', 'Gone', 'deleted')`,
      [U(1), U(2), U(3), U(4)],
    );
    for (const [org, slug] of [
      [ORG_PAID, "paid"],
      [ORG_LAPSED, "lapsed"],
      [ORG_FREE, "free"],
    ] as const) {
      await db.query(`INSERT INTO membership.organizations (id, name, slug, slug_lower) VALUES ($1, $2, $2, $2)`, [org, slug]);
    }
    await db.query(
      `INSERT INTO membership.organization_members (id, org_id, subject_id) VALUES
        (gen_random_uuid(), $1, $4), (gen_random_uuid(), $2, $5), (gen_random_uuid(), $3, $6)`,
      [ORG_PAID, ORG_LAPSED, ORG_FREE, subject(U(1)), subject(U(2)), subject(U(3))],
    );
    // billing stores the org as text; a paid team, and a team whose subscription has lapsed (two rows: one team).
    await db.query(
      `INSERT INTO billing.subscriptions (id, org_id, billing_customer_id, plan_id, status) VALUES
        ('sub_1', $1, 'cus_1', 'plan_pro', 'active'),
        ('sub_2', $2, 'cus_2', 'plan_pro', 'canceled'),
        ('sub_3', $3, 'cus_2', 'plan_pro', 'expired')`,
      [ORG_PAID, ORG_LAPSED, ORG_LAPSED.replace(/-/g, "")],
    );
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  test("every user but the deleted, by name, with whether one of their teams pays", async () => {
    const r = await listPlatformUsers(executor(db), q());
    expect(r.total).toBe(3);
    expect(r.users.map((u) => [u.displayName, u.email, u.hasActiveSubscription])).toEqual([
      ["Alice", "alice@example.com", true],
      ["Bob", "bob@example.com", false],
      [null, "carol@example.com", false],
    ]);
  });

  test("search (Coolify's like on name or email), the current team filter, the sorts, a page, the operator left out", async () => {
    expect((await listPlatformUsers(executor(db), q({ search: "bo" }))).users.map((u) => u.email)).toEqual(["bob@example.com"]);
    expect((await listPlatformUsers(executor(db), q({ search: "carol@" }))).users.map((u) => u.email)).toEqual(["carol@example.com"]);
    // Postgres LIKE is case-sensitive, as on Coolify's Postgres.
    expect((await listPlatformUsers(executor(db), q({ search: "ALICE" }))).total).toBe(0);
    expect((await listPlatformUsers(executor(db), q({ teamFilter: "current", orgId: ORG_PAID }))).users.map((u) => u.email)).toEqual(["alice@example.com"]);
    expect((await listPlatformUsers(executor(db), q({ teamFilter: "outside", orgId: ORG_PAID }))).users.map((u) => u.email)).toEqual(["bob@example.com", "carol@example.com"]);
    expect((await listPlatformUsers(executor(db), q({ sort: "email_desc" }))).users.map((u) => u.email)).toEqual(["carol@example.com", "bob@example.com", "alice@example.com"]);
    const page2 = await listPlatformUsers(executor(db), q({ sort: "email_asc", limit: 2, offset: 2 }));
    expect([page2.total, page2.users.map((u) => u.email)]).toEqual([3, ["carol@example.com"]]);
    const past = await listPlatformUsers(executor(db), q({ limit: 2, offset: 10 }));
    expect([past.total, past.users]).toEqual([3, []]);
    expect((await listPlatformUsers(executor(db), q({ excludeUserId: U(1) }))).users.map((u) => u.email)).toEqual(["bob@example.com", "carol@example.com"]);
  });

  test("subscribers: teams with a paid subscription, and teams with one that is not", async () => {
    expect(await countPlatformSubscribers(executor(db))).toEqual({ active: 1, inactive: 1 });
  });
});
