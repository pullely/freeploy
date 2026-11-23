// Derived from coollabsio/coolify@91b7e3e:app/Providers/FortifyServiceProvider.php,
// app/Providers/RouteServiceProvider.php and app/Actions/Fortify/CreateNewUser.php (Apache-2.0), modified.
//
// Email + password sign-in and registration (DP3), as Coolify does them:
//   POST /v1/auth/password/login     { email, password }
//   POST /v1/auth/password/register  { name, email, password, password_confirmation }
// Both answer { token, tokenType, expiresAt, user } on success, Laravel's
// messages on failure (422 with details.fields, or 429 when throttled).
import type { Env } from "../env.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { createIdentityRepository, createPasswordStore } from "@saas/db/identity";
import { successResponse, errorResponse, validationError } from "../http.js";
import { extractRequestContext } from "../request-context.js";
import { ensurePersonalOrg } from "../solo-mode.js";
import { hashSha256 } from "../crypto.js";
import { generateSessionId, generateTokenSecret, buildSessionToken, userPublicId, generateUserId, generateSecurityEventId } from "../ids.js";
import { hashPassword, verifyPassword, isCompromised } from "../password.js";
import { validateRegistration } from "../password-rules.js";
import { normalize_email_identity } from "../email-identity.js";
import { __ } from "../laravel-messages.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Laravel's validation failure: 422 with every field's messages under error.details.fields. */
function fieldErrors(requestId: string, fields: Record<string, string[]>): Response {
  return validationError(requestId, fields);
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function issueSession(db: SqlExecutor, request: Request, requestId: string, user: { id: string; email: string; displayName: string | null }, method: string) {
  const repo = createIdentityRepository(db);
  const ctx = extractRequestContext(request, requestId);
  const sessionUuid = generateSessionId();
  const secret = generateTokenSecret();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  const created = await repo.createSession({ id: sessionUuid, userId: user.id, tokenHash: await hashSha256(secret), expiresAt, createdAt: now });
  if (!created.ok) return null;
  await repo.recordSecurityEvent({ id: generateSecurityEventId(), eventType: "session.created", outcome: "success", userId: user.id, sessionId: sessionUuid, requestId, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, metadata: { method } });
  return {
    token: buildSessionToken(sessionUuid, secret),
    tokenType: "bearer" as const,
    expiresAt: expiresAt.toISOString(),
    user: { id: userPublicId(user.id), email: user.email, displayName: user.displayName },
  };
}

/** Throttle keys, hashed (they hold an email and an IP). */
async function keys(parts: string[]): Promise<string[]> {
  return Promise.all(parts.map((p) => hashSha256(p)));
}

export async function handlePasswordLogin(request: Request, env: Env, requestId: string): Promise<Response> {
  const body = await readJson(request);
  if (!body) return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  const ctx = extractRequestContext(request, requestId);
  const db = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createIdentityRepository(db);
    const store = createPasswordStore(db);
    // Coolify's `login` limiter: 5 per minute by "email|ip" and by email identity,
    // counted on every attempt (route middleware throttle:login).
    const identity = normalize_email_identity(email);
    const throttleKeys = await keys([`login:${email}|${ctx.ip ?? ""}`, ...(identity ? [`login:email-identity:${identity}`] : [])]);
    const recent = await store.recentAttempts("password.login.attempt", throttleKeys, 60);
    await repo.recordSecurityEvent({ id: generateSecurityEventId(), eventType: "password.login.attempt", outcome: "attempt", requestId, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, metadata: { throttle_keys: throttleKeys } });
    if (recent.some((r) => r.count >= 5)) {
      // Laravel answers a throttled route with 429 "Too Many Attempts.".
      return errorResponse("rate_limited", "Too Many Attempts.", 429, requestId);
    }
    // Fortify validates presence first: email and password required.
    const required: Record<string, string[]> = {};
    if (!email.trim()) required.email = [__("validation.required", { attribute: "email" })];
    if (!password) required.password = [__("validation.required", { attribute: "password" })];
    if (Object.keys(required).length) return fieldErrors(requestId, required);

    const found = await repo.getUserByEmail(email.toLowerCase());
    const hash = found.ok ? await store.get(found.value.id) : null;
    const valid = hash ? await verifyPassword(password, hash) : false;
    if (!found.ok || !valid) {
      await repo.recordSecurityEvent({ id: generateSecurityEventId(), eventType: "password.login.failed", outcome: "invalid_credentials", requestId, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, metadata: {} });
      // Fortify: ValidationException on `email` with auth.failed.
      return fieldErrors(requestId, { email: [__("auth.failed")] });
    }
    const session = await issueSession(db, request, requestId, found.value, "password");
    if (!session) return errorResponse("internal_error", "Failed to create session", 500, requestId);
    return successResponse(session, requestId, 200);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await db.dispose();
  }
}

export async function handlePasswordRegister(request: Request, env: Env, requestId: string, deps: { compromised?: (p: string) => Promise<boolean> } = {}): Promise<Response> {
  const body = await readJson(request);
  if (!body) return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);
  const ctx = extractRequestContext(request, requestId);
  const db = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createIdentityRepository(db);
    const store = createPasswordStore(db);
    // CreateNewUser::ensureRegistrationIsNotRateLimited: 3 per 10 minutes per IP,
    // 3 per hour per email identity, checked before validation, then hit.
    const identity = normalize_email_identity(typeof body.email === "string" ? body.email : null);
    const ipKey = await keys([`registration:ip:${ctx.ip ?? ""}`]);
    const idKey = identity ? await keys([`registration:email-identity:${identity}`]) : [];
    const [byIp] = await store.recentAttempts("password.register.attempt", ipKey, 600);
    const [byId] = idKey.length ? await store.recentAttempts("password.register.attempt", idKey, 3600) : [{ count: 0, oldest: null }];
    if ((byIp?.count ?? 0) >= 3 || (byId?.count ?? 0) >= 3) {
      return errorResponse("rate_limited", "Too many registration attempts. Please try again later.", 429, requestId);
    }
    await repo.recordSecurityEvent({ id: generateSecurityEventId(), eventType: "password.register.attempt", outcome: "attempt", requestId, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, metadata: { throttle_keys: [...ipKey, ...idKey] } });

    const errors = await validateRegistration(body, {
      emailTaken: async (lower) => (await repo.getUserByEmail(lower)).ok,
      compromised: deps.compromised ?? ((p) => isCompromised(p)),
    });
    if (Object.keys(errors).length) return fieldErrors(requestId, errors);

    const email = String(body.email);
    const now = new Date();
    // Hash first: a failure must not leave an account without a credential.
    const passwordHash = await hashPassword(String(body.password));
    const created = await repo.createUser({ id: generateUserId(), email, emailLower: email.toLowerCase(), displayName: String(body.name), createdAt: now });
    if (!created.ok) return errorResponse("internal_error", "Failed to create user", 500, requestId);
    await store.set(created.value.id, passwordHash);
    await ensurePersonalOrg(env, requestId, created.value);
    const session = await issueSession(db, request, requestId, created.value, "password");
    if (!session) return errorResponse("internal_error", "Failed to create session", 500, requestId);
    return successResponse(session, requestId, 201);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await db.dispose();
  }
}
