// Derived from coollabsio/coolify@91b7e3e (config/fortify.php: twoFactorAuthentication
// with confirm and confirmPassword; resources/views/livewire/profile/index.blade.php;
// resources/views/auth/two-factor-challenge.blade.php) and the Laravel Fortify
// behaviour it configures (Apache-2.0 / MIT), modified.
//
//   POST   /v1/auth/password/confirm             { password }      password.confirm
//   GET    /v1/auth/two-factor                                     state for /profile
//   POST   /v1/auth/two-factor                                     enable (needs a confirmed password)
//   POST   /v1/auth/two-factor/confirm           { code }          confirm setup
//   POST   /v1/auth/two-factor/recovery-codes                      regenerate (needs a confirmed password)
//   DELETE /v1/auth/two-factor                                     disable (needs a confirmed password)
//   POST   /v1/auth/two-factor/challenge         { challenge, code | recovery_code }   sign-in
import type { Env } from "../env.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { createIdentityRepository, createPasswordStore, createTwoFactorStore } from "@saas/db/identity";
import { hexToUuid } from "@saas/db/ids";
import { createAuthService } from "../services/auth.js";
import { successResponse, errorResponse, validationError, extractBearerToken } from "../http.js";
import { verifyPassword } from "../password.js";
import { loadKey, seal, open } from "../secret-box.js";
import { generateSecret, matchStep, otpauthUrl, recoveryCode } from "../totp.js";
import { issueSession } from "./password-auth.js";
import { __ } from "../laravel-messages.js";

/** config/auth.php password_timeout: a confirmed password lasts 3 hours. */
export const PASSWORD_TIMEOUT_SECONDS = 10800;
const CHALLENGE_SECONDS = 600;
const ISSUER = "Freeploy";
export const MESSAGES = {
  passwordIncorrect: "The provided password was incorrect.",
  codeInvalid: "The provided two factor authentication code was invalid.",
  recoveryInvalid: "The provided two factor recovery code was invalid.",
};

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

interface Ctx {
  db: SqlExecutor;
  userId: string;
  sessionId: string;
  email: string;
  key: CryptoKey;
}

async function withSession(request: Request, env: Env, requestId: string, fn: (c: Ctx) => Promise<Response>): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) return errorResponse("unauthenticated", "Missing or invalid Authorization header", 401, requestId);
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);
  let key: CryptoKey;
  try {
    key = await loadKey(env.IDENTITY_ENCRYPTION_KEY);
  } catch {
    return errorResponse("internal_error", "Two-factor authentication is not configured", 503, requestId);
  }
  const db = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createIdentityRepository(db);
    const s = await createAuthService({ repo, now: () => new Date() }).getSession(token);
    if ("error" in s) return errorResponse("unauthenticated", s.message, 401, requestId);
    const userId = hexToUuid(s.user.id.slice(4));
    const sessionId = hexToUuid(s.session.id.slice(4));
    if (!userId || !sessionId) return errorResponse("unauthenticated", "Invalid session", 401, requestId);
    return await fn({ db, key, email: s.user.email, userId, sessionId });
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await db.dispose();
  }
}

/** Fortify's password.confirm middleware: 423 until the password was confirmed in the last 3 hours. */
async function needsPasswordConfirmation(c: Ctx, requestId: string): Promise<Response | null> {
  const at = await createTwoFactorStore(c.db).passwordConfirmedAt(c.sessionId);
  if (at && Date.now() - at.getTime() < PASSWORD_TIMEOUT_SECONDS * 1000) return null;
  return errorResponse("password_confirmation_required", "Password confirmation required.", 423, requestId);
}

const sealCodes = (c: Ctx, codes: string[]) => seal(c.key, `2fa-recovery:${c.userId}`, JSON.stringify(codes));
const openCodes = async (key: CryptoKey, userId: string, stored: string): Promise<string[]> => JSON.parse(await open(key, `2fa-recovery:${userId}`, stored)) as string[];
const newCodes = () => Array.from({ length: 8 }, recoveryCode);

export function handlePasswordConfirm(request: Request, env: Env, requestId: string): Promise<Response> {
  return withSession(request, env, requestId, async (c) => {
    const body = await readJson(request);
    if (typeof body.password !== "string" || body.password === "") return validationError(requestId, { password: [__("validation.required", { attribute: "password" })] });
    const hash = await createPasswordStore(c.db).get(c.userId);
    if (!hash || !(await verifyPassword(body.password, hash))) return validationError(requestId, { password: [MESSAGES.passwordIncorrect] });
    await createTwoFactorStore(c.db).confirmPassword(c.sessionId);
    return successResponse({ status: "password-confirmed" }, requestId, 200);
  });
}

export function handleTwoFactorState(request: Request, env: Env, requestId: string): Promise<Response> {
  return withSession(request, env, requestId, async (c) => {
    const row = await createTwoFactorStore(c.db).get(c.userId);
    if (!row) return successResponse({ enabled: false, pending: false }, requestId, 200);
    if (row.confirmedAt) return successResponse({ enabled: true, pending: false }, requestId, 200);
    const secret = await open(c.key, `2fa-secret:${c.userId}`, row.secret);
    return successResponse({ enabled: false, pending: true, secret, url: otpauthUrl(ISSUER, c.email, secret) }, requestId, 200);
  });
}

export function handleTwoFactorEnable(request: Request, env: Env, requestId: string): Promise<Response> {
  return withSession(request, env, requestId, async (c) => {
    const gate = await needsPasswordConfirmation(c, requestId);
    if (gate) return gate;
    const store = createTwoFactorStore(c.db);
    const existing = await store.get(c.userId);
    if (!existing?.confirmedAt) {
      const secret = generateSecret();
      await store.enable(c.userId, await seal(c.key, `2fa-secret:${c.userId}`, secret), await sealCodes(c, newCodes()));
    }
    return successResponse({ status: "two-factor-authentication-enabled" }, requestId, 200);
  });
}

export function handleTwoFactorConfirm(request: Request, env: Env, requestId: string): Promise<Response> {
  return withSession(request, env, requestId, async (c) => {
    const gate = await needsPasswordConfirmation(c, requestId);
    if (gate) return gate;
    const body = await readJson(request);
    const store = createTwoFactorStore(c.db);
    const row = await store.get(c.userId);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!row || !code) return validationError(requestId, { code: [MESSAGES.codeInvalid] });
    const step = await matchStep(await open(c.key, `2fa-secret:${c.userId}`, row.secret), code, Date.now() / 1000);
    if (step === null || !(await store.useStep(c.userId, step))) return validationError(requestId, { code: [MESSAGES.codeInvalid] });
    await store.confirm(c.userId);
    return successResponse({ status: "two-factor-authentication-confirmed", recoveryCodes: await openCodes(c.key, c.userId, row.recoveryCodes) }, requestId, 200);
  });
}

export function handleRecoveryCodes(request: Request, env: Env, requestId: string): Promise<Response> {
  return withSession(request, env, requestId, async (c) => {
    const gate = await needsPasswordConfirmation(c, requestId);
    if (gate) return gate;
    const store = createTwoFactorStore(c.db);
    if (!(await store.get(c.userId))) return errorResponse("not_found", "Two-factor authentication is not enabled.", 404, requestId);
    const codes = newCodes();
    await store.setRecoveryCodes(c.userId, await sealCodes(c, codes));
    return successResponse({ status: "recovery-codes-generated", recoveryCodes: codes }, requestId, 200);
  });
}

export function handleTwoFactorDisable(request: Request, env: Env, requestId: string): Promise<Response> {
  return withSession(request, env, requestId, async (c) => {
    const gate = await needsPasswordConfirmation(c, requestId);
    if (gate) return gate;
    await createTwoFactorStore(c.db).disable(c.userId);
    return successResponse({ status: "two-factor-authentication-disabled" }, requestId, 200);
  });
}

/** Called by password sign-in: a sealed, short-lived reference to the user in place of a session. */
export async function startChallenge(env: Env, userId: string): Promise<string> {
  const key = await loadKey(env.IDENTITY_ENCRYPTION_KEY);
  return seal(key, "2fa-challenge", JSON.stringify({ u: userId, exp: Math.floor(Date.now() / 1000) + CHALLENGE_SECONDS }));
}

export async function handleTwoFactorChallenge(request: Request, env: Env, requestId: string): Promise<Response> {
  const body = await readJson(request);
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);
  let key: CryptoKey;
  let userId: string;
  try {
    key = await loadKey(env.IDENTITY_ENCRYPTION_KEY);
    const claim = JSON.parse(await open(key, "2fa-challenge", String(body.challenge ?? ""))) as { u: string; exp: number };
    if (claim.exp < Date.now() / 1000) throw new Error("expired");
    userId = claim.u;
  } catch {
    // Fortify: without a pending login the challenge sends the visitor back to /login.
    return errorResponse("unauthenticated", "The sign-in has expired. Please sign in again.", 401, requestId);
  }
  const db = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createIdentityRepository(db);
    const store = createTwoFactorStore(db);
    const row = await store.get(userId);
    const user = await repo.getUserById(userId);
    if (!row?.confirmedAt || !user.ok) return errorResponse("unauthenticated", "The sign-in has expired. Please sign in again.", 401, requestId);
    const recovery = typeof body.recovery_code === "string" ? body.recovery_code.trim() : "";
    if (recovery) {
      const codes = await openCodes(key, userId, row.recoveryCodes);
      if (!codes.includes(recovery)) return validationError(requestId, { recovery_code: [MESSAGES.recoveryInvalid] });
      // Fortify replaces a used recovery code with a new one.
      await store.setRecoveryCodes(userId, await seal(key, `2fa-recovery:${userId}`, JSON.stringify(codes.map((c) => (c === recovery ? recoveryCode() : c)))));
    } else {
      const code = typeof body.code === "string" ? body.code.trim() : "";
      const step = code ? await matchStep(await open(key, `2fa-secret:${userId}`, row.secret), code, Date.now() / 1000) : null;
      if (step === null || !(await store.useStep(userId, step))) return validationError(requestId, { code: [MESSAGES.codeInvalid] });
    }
    const session = await issueSession(db, request, requestId, user.value, "password+2fa");
    if (!session) return errorResponse("internal_error", "Failed to create session", 500, requestId);
    return successResponse(session, requestId, 200);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await db.dispose();
  }
}
