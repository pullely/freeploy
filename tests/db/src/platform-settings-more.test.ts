// The platform's Updates, Email and Authentication settings (freeploy-coolify-parity DP12, DP-101), against a real
// Postgres (PGlite) with the deploy schema at head:
//  - more columns of DP-79's row 0 of deploy.instance_settings, a page's columns only, Coolify's defaults;
//  - deploy.oauth_settings: OauthSettingSeeder's eleven providers, created on first read, owned by no org;
//  - row-level security: deploy_app with any org set sees none of it and changes none of it; only
//    asPlatformAdmin() reads and writes it.
import { PGlite } from "@electric-sql/pglite";
import {
  asPlatformAdmin,
  listPlatformOauthSettings,
  readPlatformSettingsMore,
  updatePlatformOauthSetting,
  updatePlatformSettingsMore,
  withOrg,
  PLATFORM_OAUTH_PROVIDERS,
  PLATFORM_SETTINGS_ORG_ID,
} from "@saas/db/deploy";
import { deployDatabase, executor } from "./deploy-schema.js";

const ORG_A = "00000000-0000-4000-8000-00000000000a";

describe("the platform's Updates, Email and Authentication settings", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await deployDatabase();
  }, 120_000);
  afterAll(async () => {
    await db.close();
  });

  test("a page reads its columns of row 0, created with Coolify's defaults", async () => {
    const updates = await asPlatformAdmin(executor(db), (tx) => readPlatformSettingsMore(tx, "updates"));
    expect(updates).toEqual({
      is_auto_update_enabled: true,
      auto_update_frequency: "0 0 * * *",
      update_check_frequency: "0 * * * *",
      update_channel: "stable",
      update_custom_tag: null,
      previous_update_channel: null,
      new_version_available: false,
    });
    const email = await asPlatformAdmin(executor(db), (tx) => readPlatformSettingsMore(tx, "email"));
    expect(email).toMatchObject({ smtp_enabled: false, resend_enabled: false, smtp_password: null, resend_api_key: null });
    expect(Object.keys(email)).not.toContain("smtp_servers");
    const owner = await db.query<{ id: number; org_id: string }>("SELECT id, org_id FROM deploy.instance_settings");
    expect(owner.rows).toEqual([{ id: 0, org_id: PLATFORM_SETTINGS_ORG_ID }]);
  });

  test("a page writes its own columns and no other", async () => {
    const row = await asPlatformAdmin(executor(db), (tx) => updatePlatformSettingsMore(tx, "updates", { is_auto_update_enabled: false, update_check_frequency: "daily" }));
    expect(row).toMatchObject({ is_auto_update_enabled: false, update_check_frequency: "daily" });
    await asPlatformAdmin(executor(db), (tx) => updatePlatformSettingsMore(tx, "oauth", { disable_registration_when_oauth_enabled: true }));
    await expect(asPlatformAdmin(executor(db), (tx) => updatePlatformSettingsMore(tx, "updates", { smtp_password: "x" }))).rejects.toThrow("Not a updates platform setting: smtp_password");
    await expect(asPlatformAdmin(executor(db), (tx) => updatePlatformSettingsMore(tx, "email", { instance_name: "x" }))).rejects.toThrow();
    const stored = await db.query<Record<string, unknown>>("SELECT is_auto_update_enabled, disable_registration_when_oauth_enabled, instance_name, smtp_password FROM deploy.instance_settings WHERE id = 0");
    expect(stored.rows[0]).toEqual({ is_auto_update_enabled: false, disable_registration_when_oauth_enabled: true, instance_name: null, smtp_password: null });
  });

  test("the OAuth providers: seeded once on first read, owned by no org, a provider's fillable columns written", async () => {
    const first = await asPlatformAdmin(executor(db), (tx) => listPlatformOauthSettings(tx));
    expect(first.map((r) => r.provider)).toEqual([...PLATFORM_OAUTH_PROVIDERS]);
    expect(first[0]).toMatchObject({ enabled: false, client_id: null, client_secret: null, allow_registration: true, require_email_verified: true, use_pkce: true, clock_skew_seconds: 60, auto_join_root_team: false });
    await asPlatformAdmin(executor(db), (tx) => listPlatformOauthSettings(tx));
    const all = await db.query<{ org_id: string }>("SELECT org_id FROM deploy.oauth_settings");
    expect(all.rows).toEqual(Array(PLATFORM_OAUTH_PROVIDERS.length).fill({ org_id: PLATFORM_SETTINGS_ORG_ID }));
    const saved = await asPlatformAdmin(executor(db), (tx) => updatePlatformOauthSetting(tx, "github", { enabled: true, client_id: "id", client_secret: "fp1:1:ciphertext", clock_skew_seconds: 30 }));
    expect(saved).toMatchObject({ provider: "github", enabled: true, client_id: "id", client_secret: "fp1:1:ciphertext", clock_skew_seconds: 30 });
    expect(await asPlatformAdmin(executor(db), (tx) => updatePlatformOauthSetting(tx, "nope", { enabled: true }))).toBeNull();
    await expect(asPlatformAdmin(executor(db), (tx) => updatePlatformOauthSetting(tx, "github", { provider: "x" } as never))).rejects.toThrow("Not an OAuth setting: provider");
  });

  test("an org — any org — sees nothing of it and changes nothing", async () => {
    const seen = await withOrg(executor(db), ORG_A, async (tx) => [(await tx.execute("SELECT * FROM deploy.instance_settings")).rows, (await tx.execute("SELECT * FROM deploy.oauth_settings")).rows]);
    expect(seen).toEqual([[], []]);
    const changed = await withOrg(executor(db), ORG_A, (tx) => tx.execute("UPDATE deploy.oauth_settings SET enabled = false"));
    expect(changed.rowCount).toBe(0);
    // The queries under an org: the row is not there to read, and an update writes nothing.
    await expect(withOrg(executor(db), ORG_A, (tx) => readPlatformSettingsMore(tx, "email"))).rejects.toThrow();
    expect(await withOrg(executor(db), ORG_A, (tx) => updatePlatformOauthSetting(tx, "github", { enabled: false }))).toBeNull();
    // listPlatformOauthSettings() under an org: its seed of the platform's rows is refused by row-level security.
    await expect(withOrg(executor(db), ORG_A, (tx) => listPlatformOauthSettings(tx))).rejects.toThrow();
    const github = await db.query<{ enabled: boolean }>("SELECT enabled FROM deploy.oauth_settings WHERE provider = 'github'");
    expect(github.rows).toEqual([{ enabled: true }]);
  });
});
