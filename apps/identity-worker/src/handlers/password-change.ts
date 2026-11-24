// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Profile/Index.php (resetPassword) (Apache-2.0), modified.
//
//   POST /v1/auth/password/change  { current_password, new_password, new_password_confirmation }
//
// The signed-in user changes their password from the profile page. Coolify:
// current_password required; new_password required | Password::defaults() |
// confirmed; then "Current password is incorrect." when the hash does not
// match. On success the password is replaced and, as Laravel's
// AuthenticateSession does once the hash changes, every session ends.
import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createIdentityRepository, createPasswordStore } from "@saas/db/identity";
import { createAuthService } from "../services/auth.js";
import { successResponse, errorResponse, validationError, extractBearerToken } from "../http.js";
import { hashPassword, verifyPassword, isCompromised } from "../password.js";
import { passwordErrors } from "../password-rules.js";
import { __ } from "../laravel-messages.js";

export interface PasswordChangeDeps {
  compromised?: (p: string) => Promise<boolean>;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The field errors Coolify's rules give, in Laravel's order; no database needed. */
export async function passwordChangeErrors(body: Record<string, unknown>, compromised: (p: string) => Promise<boolean>): Promise<Record<string, string[]>> {
  const fields: Record<string, string[]> = {};
  if (typeof body.current_password !== "string" || body.current_password === "") fields.current_password = [__("validation.required", { attribute: "current password" })];
  const pw = await passwordErrors(body.new_password, body.new_password_confirmation, "new_password", compromised);
  if (pw.length) fields.new_password = pw;
  return fields;
}

export async function handlePasswordChange(request: Request, env: Env, requestId: string, deps: PasswordChangeDeps = {}): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) return errorResponse("unauthenticated", "Missing or invalid Authorization header", 401, requestId);
  const body = await readJson(request);
  if (!body) return errorResponse("bad_request", "Invalid JSON body", 400, requestId);
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);
  const db = createSqlExecutor(env.PLATFORM_DB);
  try {
    const repo = createIdentityRepository(db);
    const session = await createAuthService({ repo, now: () => new Date() }).getSession(token);
    if ("error" in session) return errorResponse("unauthenticated", session.message, 401, requestId);
    const fields = await passwordChangeErrors(body, deps.compromised ?? ((p) => isCompromised(p)));
    if (Object.keys(fields).length) return validationError(requestId, fields);
    const store = createPasswordStore(db);
    const found = await repo.getUserByEmail(session.user.email.toLowerCase());
    if (!found.ok) return errorResponse("unauthenticated", "Unknown user", 401, requestId);
    const hash = await store.get(found.value.id);
    if (!hash || !(await verifyPassword(String(body.current_password), hash))) {
      return validationError(requestId, { current_password: ["Current password is incorrect."] });
    }
    await store.set(found.value.id, await hashPassword(String(body.new_password)));
    await store.revokeAllSessions(found.value.id);
    return successResponse({ status: "Password updated." }, requestId, 200);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await db.dispose();
  }
}
