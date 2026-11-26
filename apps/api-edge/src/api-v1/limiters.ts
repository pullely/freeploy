// Derived from coollabsio/coolify@91b7e3e:app/Http/Middleware/ThrottleFailedApiRequests.php,
// app/Providers/RouteServiceProvider.php (RateLimiter::for('api')), config/api.php, and Laravel's
// Illuminate\Cache\RateLimiter and Illuminate\Routing\Middleware\ThrottleRequests (Apache-2.0 / MIT), modified.
//
// Coolify's two API rate limiters, as pure steps over one key's state:
//
//   throttle:api      API_RATE_LIMIT (default 200) requests a minute per user — the token's user, or
//                     the client IP without a valid token — and 1000 for /api/health. Laravel runs
//                     auth:sanctum first (middleware priority), so a request it refuses is not counted.
//                     Laravel's fixed window: the first hit starts a 60-second window; a request at the
//                     limit gets 429 until the window ends.
//   failed requests   API_FAILED_REQUEST_RATE_LIMIT (default 30; 0 turns it off) failed answers a minute
//                     — 401, 403, and 404 without a token — per bearer token (its SHA-256) or, without one,
//                     per client IP. Reaching the limit blocks every request of that client for 1 minute,
//                     then 5 and 15 minutes when it reaches it again within an hour. Health checks pass.
//
// A step is atomic per key: in production each key is one RateLimiterDO instance (rate-limit-do.ts),
// elsewhere an in-isolate map (approximate across isolates, as the edge's read limiter already is).

export const API_RATE_LIMIT_DEFAULT = 200;
export const API_FAILED_REQUEST_RATE_LIMIT_DEFAULT = 30;
/** RateLimiter::for('api'): Limit::perMinute(1000) for 'api/health'. */
export const API_HEALTH_RATE_LIMIT = 1000;
const DECAY_SECONDS = 60;
const BLOCK_SECONDS = [60, 300, 900] as const;
const STRIKE_MEMORY_SECONDS = 3600;

/** RateLimiter's counter and its timer (`key:timer`, the end of the window, in Unix seconds). */
export interface WindowState {
  hits: number;
  windowEnd: number;
}

export type ThrottleDecision =
  | { allowed: true; limit: number; remaining: number; state: WindowState }
  | { allowed: false; limit: number; retryAfter: number; resetAt: number; state: WindowState | null };

/**
 * ThrottleRequests::handleRequest(): tooManyAttempts() before the request, else hit() and the
 * remaining attempts after it.
 */
export function throttleStep(prev: WindowState | null, limit: number, now: number): ThrottleDecision {
  const live = prev && prev.windowEnd > now ? prev : null;
  if (live && live.hits >= limit) {
    return { allowed: false, limit, retryAfter: live.windowEnd - now, resetAt: live.windowEnd, state: live };
  }
  const next = live ? { hits: live.hits + 1, windowEnd: live.windowEnd } : { hits: 1, windowEnd: now + DECAY_SECONDS };
  return { allowed: true, limit, remaining: Math.max(0, limit - next.hits), state: next };
}

/** ThrottleFailedApiRequests' cache entries for one key: hits, strikes and the end of a block. */
export interface FailedState {
  window: WindowState | null;
  strikes: number;
  strikesUntil: number;
  blockedUntil: number;
}

export const EMPTY_FAILED: FailedState = { window: null, strikes: 0, strikesUntil: 0, blockedUntil: 0 };

/** blockedFor(): seconds the client is still blocked, 0 when it is not. */
export function failedBlockedFor(state: FailedState | null, now: number): number {
  return Math.max(0, (state?.blockedUntil ?? 0) - now);
}

/** isCountedFailure(): 401 and 403, and 404 only without a token (a client with a token often checks if something exists). */
export function isCountedFailure(status: number, hasBearerToken: boolean): boolean {
  return status === 401 || status === 403 || (status === 404 && !hasBearerToken);
}

/** After a counted failure: RateLimiter::hit($key, 60) and, at the limit, block() and clear the hits. */
export function failedRecordStep(prev: FailedState | null, limit: number, now: number): { state: FailedState; blocked: boolean } {
  const s = prev ?? EMPTY_FAILED;
  const live = s.window && s.window.windowEnd > now ? s.window : null;
  const window = live ? { hits: live.hits + 1, windowEnd: live.windowEnd } : { hits: 1, windowEnd: now + DECAY_SECONDS };
  if (window.hits < limit) return { state: { ...s, window }, blocked: false };
  const strikes = (s.strikesUntil > now ? s.strikes : 0) + 1;
  const seconds = BLOCK_SECONDS[Math.min(strikes, BLOCK_SECONDS.length) - 1]!;
  return { state: { window: null, strikes, strikesUntil: now + STRIKE_MEMORY_SECONDS, blockedUntil: now + seconds }, blocked: true };
}

/** The headers ThrottleRequests adds: X-RateLimit-Limit and -Remaining, and on a 429 Retry-After and X-RateLimit-Reset. */
export function throttleHeaders(d: ThrottleDecision): Record<string, string> {
  if (d.allowed) return { "x-ratelimit-limit": String(d.limit), "x-ratelimit-remaining": String(d.remaining) };
  return {
    "x-ratelimit-limit": String(d.limit),
    "x-ratelimit-remaining": "0",
    "retry-after": String(d.retryAfter),
    "x-ratelimit-reset": String(d.resetAt),
  };
}

/** ThrottleRequestsException as Laravel's handler renders it for a JSON client (pretty-printed). */
export const TOO_MANY_ATTEMPTS_BODY = '{\n    "message": "Too Many Attempts."\n}';

export function failedBlockedBody(retryAfter: number): string {
  return JSON.stringify({ message: `Too many failed API requests. Retry after ${retryAfter} seconds.` });
}

/** One limiter key's atomic steps; the in-isolate map or a Durable Object behind it. */
export interface LimiterStore {
  throttle(key: string, limit: number, now: number): Promise<ThrottleDecision>;
  failedBlockedFor(key: string, now: number): Promise<number>;
  failedRecord(key: string, limit: number, now: number): Promise<boolean>;
}

/** The in-isolate store: tests, dev, and the fallback when the Durable Object binding is absent. */
export function memoryLimiterStore(): LimiterStore & { clear(): void } {
  const windows = new Map<string, WindowState>();
  const failed = new Map<string, FailedState>();
  const prune = () => {
    if (windows.size > 10_000) windows.clear();
    if (failed.size > 10_000) failed.clear();
  };
  return {
    async throttle(key, limit, now) {
      prune();
      const d = throttleStep(windows.get(key) ?? null, limit, now);
      if (d.state) windows.set(key, d.state);
      return d;
    },
    async failedBlockedFor(key, now) {
      return failedBlockedFor(failed.get(key) ?? null, now);
    },
    async failedRecord(key, limit, now) {
      prune();
      const r = failedRecordStep(failed.get(key) ?? null, limit, now);
      failed.set(key, r.state);
      return r.blocked;
    },
    clear() {
      windows.clear();
      failed.clear();
    },
  };
}

/** The messages RateLimiterDO answers for Coolify's limiters (one DO instance per key). */
export type CoolifyLimiterMessage =
  | { kind: "coolify-throttle"; limit: number; now: number }
  | { kind: "coolify-failed-check"; now: number }
  | { kind: "coolify-failed-record"; limit: number; now: number };

/** The store over RATE_LIMITER_DO: each key is one Durable Object, whose requests run one at a time. */
export function durableLimiterStore(ns: DurableObjectNamespace): LimiterStore {
  const send = async <T>(key: string, message: CoolifyLimiterMessage): Promise<T> => {
    const stub = ns.get(ns.idFromName(`coolify-api:${key}`));
    const res = await stub.fetch("https://rate-limiter.internal/coolify", { method: "POST", body: JSON.stringify(message) });
    if (!res.ok) throw new Error(`limiter ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    throttle: (key, limit, now) => send<ThrottleDecision>(key, { kind: "coolify-throttle", limit, now }),
    failedBlockedFor: async (key, now) => (await send<{ retryAfter: number }>(key, { kind: "coolify-failed-check", now })).retryAfter,
    failedRecord: async (key, limit, now) => (await send<{ blocked: boolean }>(key, { kind: "coolify-failed-record", limit, now })).blocked,
  };
}

/** Configuration from the edge's variables (Coolify's .env), with Coolify's defaults. */
export function limitFromEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}
