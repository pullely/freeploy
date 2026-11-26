export interface Env {
  PLATFORM_DB?: Hyperdrive;
  IDENTITY_WORKER?: Fetcher;
  MEMBERSHIP_WORKER?: Fetcher;
  PROJECTS_WORKER?: Fetcher;
  DEPLOY_CORE_WORKER?: Fetcher;
  EVENTS_WORKER?: Fetcher;
  CONFIG_WORKER?: Fetcher;
  WEBHOOKS_WORKER?: Fetcher;
  METERING_WORKER?: Fetcher;
  BILLING_WORKER?: Fetcher;
  NOTIFICATIONS_WORKER?: Fetcher;
  INTEGRATIONS_WORKER?: Fetcher;
  // Optional KV binding backing the Stripe-style idempotency replay store
  // (Task 0095). Absent on `dev` (no live worker) and absent on the older
  // verify-only stages. When unbound, `replayOrExecute` degrades to a
  // direct downstream forward — never 5xx.
  IDEMPOTENCY_KV?: KVNamespace;
  // Durable Object namespace backing the per-(scope,key) rate-limit counters
  // (PERF5 Stage B). Each bucket key maps to one DO instance for an atomic,
  // race-free token bucket without a KV write on the hot path. Absent on
  // dev/local, where the limiter falls back to the KV path (then fail-open).
  RATE_LIMITER_DO?: DurableObjectNamespace;
  ENVIRONMENT: string;
  CONSOLE_CUSTOM_DOMAIN?: string;
  // M0 / Solo profile switch. "true" runs the single-user B2C profile (see
  // ./solo-mode.ts); absent or any other value keeps the full multi-tenant
  // baseline. Deploy-time wrangler var, not a secret.
  SOLO_MODE?: string;
  // Coolify's /api/v1 (DP-70): Coolify's .env and instance settings, as deploy-time vars. All optional:
  // absent means Coolify's defaults (API on for every address, 200 requests and 30 failed requests a minute).
  /** API_RATE_LIMIT */
  API_RATE_LIMIT?: string;
  /** API_FAILED_REQUEST_RATE_LIMIT (0 turns the failed-request throttle off) */
  API_FAILED_REQUEST_RATE_LIMIT?: string;
  /** "false": the instance setting is_api_enabled off ("API is disabled."). */
  API_ENABLED?: string;
  /** The instance setting allowed_ips: comma-separated addresses and CIDRs; empty or 0.0.0.0 allows all. */
  API_ALLOWED_IPS?: string;
}
