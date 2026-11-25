import type { MigrationManifest } from "./types.js";

export const manifest: MigrationManifest = {
  version: 1,
  migrations: [
    {
      id: "000_control_baseline",
      context: "control",
      path: "000_control/up.sql",
      checksum:
        "2a5d7f30684c99e3ff441ca8a2c38038dedd1bab4db4a40e92cd36bb22be297f",
      description:
        "Baseline control migration — creates the migration tracking schema",
    },
    {
      id: "010_identity_core",
      context: "identity",
      path: "010_identity_core/up.sql",
      checksum:
        "f8db63c83e2b1b29e6d0b9b133a7db490e2adcfdf26bfc6ce55c63c8a629075d",
      description:
        "Identity persistence foundation — users, auth identities, login challenges, sessions",
    },
    {
      id: "020_membership_core",
      context: "membership",
      path: "020_membership_core/up.sql",
      checksum:
        "50da482998db74431866aa5285737026239a28618017019320ee7bb20e49381d",
      description:
        "Membership persistence foundation — organizations, members, invitations, role assignments",
    },
    {
      id: "030_events_audit_core",
      context: "events",
      path: "030_events_audit_core/up.sql",
      checksum:
        "388aa634380200595ff3a3d15c638e696bf9b93e46330327e84ef10cec8a3f58",
      description:
        "Events/audit persistence foundation — canonical event log and audit entry projections",
    },
    {
      id: "040_projects_core",
      context: "projects",
      path: "040_projects_core/up.sql",
      checksum:
        "d7cb842130856986157629965fd9afba6b36e737e73b125884b64976d2f8b7f6",
      description:
        "Projects persistence foundation — projects and environments tables with tenant isolation",
    },
    {
      id: "050_identity_security_events",
      context: "identity",
      path: "050_identity_security_events/up.sql",
      checksum:
        "a1bb9f50075ea93e389feb7c7282bdbd5b5ebf6671f789b0f7a707110ae74ca2",
      description:
        "Identity-owned security-event source facts — pre-organization user activity log",
    },
    {
      id: "060_identity_api_keys",
      context: "identity",
      path: "060_identity_api_keys/up.sql",
      checksum:
        "834e71e40f729cdf1cd4db32a4071b62c09fd63c9ea4bbf0c035c15c94ff99a1",
      description:
        "Identity-owned service principals and API keys — org-bound automation actors and credential persistence",
    },
    {
      id: "070_config_settings_flags",
      context: "config",
      path: "070_config_settings_flags/up.sql",
      checksum:
        "be2b60f0ddb6f342a8c9038db602e142a34d36ffa7f7a17f4d218231087d6562",
      description:
        "Config persistence foundation — scoped settings, feature flags, and secret metadata",
    },
    {
      id: "080_webhooks_core",
      context: "webhooks",
      path: "080_webhooks_core/up.sql",
      checksum:
        "bfffc592f82028dd06865833bfd5e8124dbfe51e2e02aecccea4b14b42e9f2a6",
      description:
        "Webhook persistence foundation — endpoints, subscriptions, and delivery attempts",
    },
    {
      id: "090_webhooks_delivery",
      context: "webhooks",
      path: "090_webhooks_delivery/up.sql",
      checksum:
        "a881356b376afd2cccbf326a9bfb7e393e073cd88b3923a38d34907457c39021",
      description:
        "Webhook delivery runtime — fixes event_id type, adds dispatch cursor and delivery indexes",
    },
    {
      id: "100_metering_foundation",
      context: "metering",
      path: "100_metering_foundation/up.sql",
      checksum:
        "d02693e6ec3d76193d58b9038a211c877adbf1c141e4f40d9ca8bb7a78c90930",
      description:
        "Metering persistence foundation — usage records, rollups, quota definitions, and quota violations",
    },
    {
      id: "110_billing_foundation",
      context: "billing",
      path: "110_billing_foundation/up.sql",
      checksum:
        "980564a806e89c0039f012f7c0ec49267920aea549b394c5af3712722e4b9f8f",
      description:
        "Billing persistence foundation — provider-neutral plans, billing customers, subscriptions, invoices, and entitlements",
    },
    {
      id: "120_notifications_core",
      context: "notifications",
      path: "120_notifications_core/up.sql",
      checksum:
        "868cc1092b4b385b6ed3d203efe5302191865131bb98d0e9f5fe5ad6d16f01bb",
      description:
        "Notifications persistence foundation — preferences, notifications, attempts, suppressions",
    },
    {
      id: "130_webhook_secret_rotation_grace",
      context: "webhooks",
      path: "130_webhook_secret_rotation_grace/up.sql",
      checksum:
        "4c5474e7b5ca228adc18ca09b7cd2387938efab8f1e55b675fd4aee6e3ec4e5a",
      description:
        "Dual-secret rotation window — adds previous_secret_{ciphertext,version,expires_at} for grace-period delivery signing",
    },
    {
      id: "140_support_action_records",
      context: "support",
      path: "140_support_action_records/up.sql",
      checksum:
        "50262de186b5ec91797e25532b56cf69028f3975dcc58751c07de6ef1517f190",
      description:
        "Support persistence foundation — append-only audited support-action ledger owned by the admin-support worker",
    },
    {
      id: "150_entitlement_decision_observations",
      context: "billing",
      path: "150_entitlement_decision_observations/up.sql",
      checksum:
        "ba7a1a00ad723752e1bdedc8bcd47c210b24ae18bd3245cb71af84432aefa7f8",
      description:
        "Entitlement-decision observability — append-only, counts-only observation table (org × entitlement key × outcome) owned by the billing context",
    },
    {
      id: "160_identity_user_last_org",
      context: "identity",
      path: "160_identity_user_last_org/up.sql",
      checksum:
        "d102ce426114b032407f6e03ee2e02de65ccb25e4f42df25b340e5a641829dc6",
      description:
        "Per-user last-viewed organization preference (nullable slug hint on identity.users) backing the console's cross-device default landing",
    },
    {
      id: "170_membership_org_parent",
      context: "membership",
      path: "170_membership_org_parent/up.sql",
      checksum:
        "8af612994d6ad4f76e416ec034cdcfc9e2e416bed04c4fde405481627b4093b2",
      description:
        "Optional parent-organization pointer (nullable parent_org_id on membership.organizations) — the dormant seam for the saas-multi-org-billing epic; NULL = standalone, no behavior change",
    },
    {
      id: "180_integrations_foundation",
      context: "integrations",
      path: "180_integrations_foundation/up.sql",
      checksum:
        "e86ac972013587fcd3b04be5c1daa1306a456990ebbb9d30e9b5d79770772497",
      description:
        "Integrations persistence foundation (IG0, dormant) — provider-agnostic connections, GitHub installation facts, repo links with branch→environment maps, the durable inbound-delivery inbox, and the encrypted installation-token cache",
    },
    {
      id: "190_integrations_delivery_attribution",
      context: "integrations",
      path: "190_integrations_delivery_attribution/up.sql",
      checksum:
        "535487194c9c4a129e013282a5f51a5c3e6e2afb3f15c5a0b5f1028e0c5af73f",
      description:
        "Connection pointer on the inbound-delivery inbox (nullable connection_id + partial index) — lets the per-connection delivery log scope precisely; attributed by the IG2 cron drain",
    },
    {
      id: "500_deploy_core",
      context: "deploy",
      path: "500_deploy_core/up.sql",
      checksum:
        "afa0f32afc4db7dcf4191ac18b9cd4ec00830c0019de9a40cdcb337bcf1d1300",
      description:
        "Deploy persistence foundation (DP2) — the Coolify resource model ported from coollabsio/coolify@91b7e3e's final schema: same tables and columns, team_id → org_id on every table, row-level security forced on every table, role deploy_app. GENERATED by packages/db/scripts/generate-deploy-schema.ts",
    },
    {
      id: "510_deploy_org_keys",
      context: "deploy",
      path: "510_deploy_org_keys/up.sql",
      checksum:
        "df9ddecdd08a00716aaa5dbdd3a69566baff207b34790532eea730b319d18045",
      description:
        "Per-org data keys for the deploy context's encrypted columns (DP2) — wrapped by the platform KEK DEPLOY_ENCRYPTION_KEY, org-scoped by forced row-level security",
    },
    {
      id: "520_deploy_schema_fold_fixes",
      context: "deploy",
      path: "520_deploy_schema_fold_fixes/up.sql",
      checksum:
        "164c6fe451509ce5d248a186bcc4ca36cb029c3c667ab7ae339eec995cbe74fe",
      description:
        "Deploy schema delta (DP2): columns the first fold missed (migrations that loop over table lists) or kept after Coolify dropped them, generated against the frozen 500_deploy_core",
    },
    {
      id: "530_identity_password_credentials",
      context: "identity",
      path: "530_identity_password_credentials/up.sql",
      checksum:
        "3320ab55d38b835a056d6bda4b810778b337a5e913c3900c97a84132561fb248",
      description:
        "Email + password sign-in (freeploy-coolify-parity DP3) — one PBKDF2-SHA256 credential per user, and an index for the attempt counts that throttle sign-in and registration",
    },
    {
      id: "540_identity_password_resets",
      context: "identity",
      path: "540_identity_password_resets/up.sql",
      checksum:
        "9e241b5fc946f1a9c568cd8a07c0ff486be35ab4c4d6e61b17125a43b5d9a17b",
      description:
        "Password reset tokens (freeploy-coolify-parity DP3) — one hashed token per user, Laravel broker semantics (10-minute expiry, 60-second throttle)",
    },
    {
      id: "550_identity_two_factor",
      context: "identity",
      path: "550_identity_two_factor/up.sql",
      checksum:
        "fbbdf73ff4a40d710ea3b41992f7823fa01877cabbaacdebe09f767f30b06acd",
      description:
        "Two-factor authentication (freeploy-coolify-parity DP3) — encrypted TOTP secret and recovery codes per user, confirmed_at; sessions.password_confirmed_at",
    },
    {
      id: "560_identity_passkeys",
      context: "identity",
      path: "560_identity_passkeys/up.sql",
      checksum:
        "9da7a3ab6e134390c21f555d72f4c0f28698235bb22740cdeee8dfbf701aabd0",
      description:
        "Passkeys (freeploy-coolify-parity DP3) — named WebAuthn credentials per user with public key, counter and last use",
    },
    {
      id: "570_identity_email_verification",
      context: "identity",
      path: "570_identity_email_verification/up.sql",
      checksum:
        "a614d2df099065d5bb2ac62b32e992ae4e8445670c6b43dbdb339cc79214391c",
      description:
        "Email verification and email change (freeploy-coolify-parity DP3) — users.email_verified_at (existing accounts verified), pending changes with hashed 6-digit codes",
    },
    {
      id: "580_identity_avatars",
      context: "identity",
      path: "580_identity_avatars/up.sql",
      checksum:
        "34e176ac6b6391b4ce4f98e1f46ad457ca8cb42fbb4a006bbbf3ca4b7cdd6089",
      description:
        "Profile pictures (freeploy-coolify-parity DP3) — one base64 image per user",
    },
    {
      id: "590_deploy_shared_variables_server_scope",
      context: "deploy",
      path: "590_deploy_shared_variables_server_scope/up.sql",
      checksum:
        "1a767ad2f4ae768d92c8e14d9568f2a5818192fdb61ca8c237dfaa4b3804c7ad",
      description:
        "Server-wide shared variables (freeploy-coolify-parity DP5) — shared_environment_variables.type accepts 'server', the raw statement of Coolify's migration that the schema fold does not read",
    },
    {
      id: "610_deploy_tags_org_name_unique",
      context: "deploy",
      path: "610_deploy_tags_org_name_unique/up.sql",
      checksum:
        "726b0537ffae2b348074afa815626d8d7fe3b164cee1623f285dda381e33adf0",
      description:
        "Tag names unique per org (freeploy-coolify-parity DP5) — drops the global tags_name_unique the schema fold kept and adds (org_id, name), as Coolify's two tag index migrations do per team",
    },
    {
      id: "630_deploy_database_public_port_timeout",
      context: "deploy",
      path: "630_deploy_database_public_port_timeout/up.sql",
      checksum:
        "f70fcb8093d08e60925f368b252885d975211cbb4dca242fe7334fa15282c75e",
      description:
        "Database proxy timeout (freeploy-coolify-parity DP7) — public_port_timeout on the eight standalone database tables and service_databases, Coolify's 2026_02_27 migration that the schema fold does not have",
    },
    {
      id: "660_deploy_schema_catch_up",
      context: "deploy",
      path: "660_deploy_schema_catch_up/up.sql",
      checksum:
        "fbffd7fd1e715f9d91eb51b13e93c7ae381636fa4c7988ebc1c20c7b098d75bb",
      description:
        "Schema catch-up (freeploy-coolify-parity DP-60) — every column, type, default, CHECK value, index and unique index (org-scoped) that Coolify's real schema has and the fold missed, found by comparing catalogs; drops environment_variables.is_build_time as Coolify did",
    },
    {
      id: "710_membership_org_description",
      context: "membership",
      path: "710_membership_org_description/up.sql",
      checksum:
        "5f9e0642f69e3bef855fbd6fe7a5226407ef01ce54c269af1501cdc8030b43dd",
      description:
        "A team's description (freeploy-coolify-parity DP10) — nullable organizations.description for the deploy console's team General page, as Coolify's teams.description",
    },
  ],
};
