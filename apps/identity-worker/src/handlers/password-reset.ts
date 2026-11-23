// Derived from coollabsio/coolify@91b7e3e: Laravel Fortify's password reset flow as
// Coolify configures it (config/auth.php passwords.users: expire 10 minutes,
// throttle 60 seconds; app/Actions/Fortify/ResetUserPassword.php;
// app/Notifications/TransactionalEmails/ResetPassword.php) (Apache-2.0), modified.
//
//   POST /v1/auth/password/forgot  { email }
//   POST /v1/auth/password/reset   { token, email, password, password_confirmation }
//
// Messages are Laravel's (laravel-messages.ts, verified against the reference).
// Coolify answers the same sentence whether or not the address exists.
import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createIdentityRepository, createPasswordStore } from "@saas/db/identity";
import { enqueueNotification, buildIdempotencyKey } from "@saas/notifications-client";
import { successResponse, errorResponse, validationError } from "../http.js";
import { hashSha256 } from "../crypto.js";
import { hashPassword, isCompromised } from "../password.js";
import { isValidEmail } from "../password-rules.js";
import { __ } from "../laravel-messages.js";
import { validateRegistration } from "../password-rules.js";

const EXPIRE_MINUTES = 10;
const THROTTLE_SECONDS = 60;
const SYSTEM_ORG_ID = "00000000-0000-0000-0000-000000000000";

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fortify's email field rules on both reset forms: required | email. */
function emailErrors(email: unknown): string[] {
  if (typeof email !== "string" || email.trim() === "") return [__("validation.required", { attribute: "email" })];
  if (!isValidEmail(email)) return [__("validation.email", { attribute: "email" })];
  return [];
}

export interface PasswordResetDeps {
  enqueue?: typeof enqueueNotification;
  compromised?: (p: string) => Promise<boolean>;
}

export async function handlePasswordForgot(request: Request, env: Env, requestId: string, deps: PasswordResetDeps = {}): Promise<Response> {
  const body = await readJson(request);
  if (!body) return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  const errs = emailErrors(body.email);
  if (errs.length) return validationError(requestId, { email: errs });
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);
  if (!env.DEPLOY_WEB_URL) return errorResponse("internal_error", "Console URL not configured", 503, requestId);
  const email = String(body.email);
  const db = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createIdentityRepository(db);
    const store = createPasswordStore(db);
    const found = await repo.getUserByEmail(email.toLowerCase());
    if (found.ok) {
      if (await store.resetRecentlyCreated(found.value.id, THROTTLE_SECONDS)) {
        // The broker's RESET_THROTTLED: Fortify returns it as an error on `email`.
        return validationError(requestId, { email: [__("passwords.throttled")] });
      }
      const token = randomToken();
      await store.createReset(found.value.id, await hashSha256(token));
      const url = `${env.DEPLOY_WEB_URL.replace(/\/$/, "")}/reset-password/${token}?email=${encodeURIComponent(found.value.email)}`;
      await (deps.enqueue ?? enqueueNotification)(
        env,
        { internalActor: "identity-worker", actorSubjectType: "system", actorSubjectId: "identity-worker", requestId },
        {
          orgId: SYSTEM_ORG_ID,
          category: "security",
          templateKey: "auth.password_reset",
          templateData: { url, count: EXPIRE_MINUTES },
          recipient: { channel: "email", address: found.value.email },
          idempotencyKey: buildIdempotencyKey("auth.password_reset", found.value.id, String(Math.floor(Date.now() / 1000 / THROTTLE_SECONDS))),
          correlationId: requestId,
        },
      );
    }
    // Same answer whether or not the address exists (Coolify's passwords.sent).
    return successResponse({ status: __("passwords.sent") }, requestId, 200);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await db.dispose();
  }
}

export async function handlePasswordReset(request: Request, env: Env, requestId: string, deps: PasswordResetDeps = {}): Promise<Response> {
  const body = await readJson(request);
  if (!body) return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  // Fortify: token required, email required|email; then ResetUserPassword's rules.
  const fields: Record<string, string[]> = {};
  if (typeof body.token !== "string" || body.token === "") fields.token = [__("validation.required", { attribute: "token" })];
  const em = emailErrors(body.email);
  if (em.length) fields.email = em;
  if (Object.keys(fields).length) return validationError(requestId, fields);
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);
  const db = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createIdentityRepository(db);
    const store = createPasswordStore(db);
    const pwErrors = (
      await validateRegistration(
        { name: "x", email: "x@example.com", password: body.password, password_confirmation: body.password_confirmation },
        { emailTaken: async () => false, compromised: deps.compromised ?? ((p) => isCompromised(p)) },
      )
    ).password;
    if (pwErrors?.length) return validationError(requestId, { password: pwErrors });
    const found = await repo.getUserByEmail(String(body.email).toLowerCase());
    if (!found.ok) return validationError(requestId, { email: [__("passwords.user")] });
    const status = await store.checkReset(found.value.id, await hashSha256(String(body.token)), EXPIRE_MINUTES * 60);
    if (status !== "valid") return validationError(requestId, { email: [__("passwords.token")] });
    const hash = await hashPassword(String(body.password));
    await store.set(found.value.id, hash);
    await store.deleteReset(found.value.id);
    await store.revokeAllSessions(found.value.id);
    return successResponse({ status: __("passwords.reset") }, requestId, 200);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await db.dispose();
  }
}
