// Derived from coollabsio/coolify@91b7e3e (app/Http/Controllers/Controller.php verify and
// email_verify; app/Livewire/VerifyEmail.php; app/Http/Middleware/DecideWhatToDoWithUser.php;
// app/Livewire/Profile/Index.php requestEmailChange, verifyEmailChange, resendVerificationCode,
// cancelEmailChange; app/Models/User.php) (Apache-2.0), modified.
//
//   POST   /v1/auth/email/verification-notification   send the signed link (1 per 5 minutes)
//   POST   /v1/auth/email/verify          { id, hash, expires, signature }
//   GET    /v1/auth/email/change          { pending }
//   POST   /v1/auth/email/change          { new_email }               a 6-digit code to the new address
//   POST   /v1/auth/email/change/verify   { email_verification_code }
//   POST   /v1/auth/email/change/resend
//   DELETE /v1/auth/email/change
//
// Coolify reports these through toasts; a 422 with `message` (and no fields)
// is a toast message here, as are field errors.
import type { Env } from "../env.js";
import { createSqlExecutor, type SqlExecutor } from "@saas/db/hyperdrive";
import { createEmailStore, createIdentityRepository, createPasswordStore } from "@saas/db/identity";
import { hexToUuid } from "@saas/db/ids";
import { enqueueNotification, buildIdempotencyKey } from "@saas/notifications-client";
import { createAuthService } from "../services/auth.js";
import { successResponse, errorResponse, validationError, extractBearerToken } from "../http.js";
import { hashSha256 } from "../crypto.js";
import { generateSecurityEventId, userPublicId } from "../ids.js";
import { isValidEmail } from "../password-rules.js";
import { extractRequestContext } from "../request-context.js";
import { keys } from "./password-auth.js";
import { __ } from "../laravel-messages.js";

const SYSTEM_ORG_ID = "00000000-0000-0000-0000-000000000000";
/** config/auth.php verification.expire. */
export const VERIFY_EXPIRE_MINUTES = 60;
/** config/constants.php email_change.verification_code_expiry_minutes. */
export const CODE_EXPIRE_MINUTES = 10;

export interface EmailDeps {
  enqueue?: typeof enqueueNotification;
  now?: () => number;
}

const toast = (requestId: string, message: string, status = 422) => errorResponse("toast", message, status, requestId);

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function hmacHex(env: Env, message: string): Promise<string> {
  if (!env.IDENTITY_ENCRYPTION_KEY) throw new Error("IDENTITY_ENCRYPTION_KEY is not configured");
  const raw = Uint8Array.from(atob(env.IDENTITY_ENCRYPTION_KEY), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`email-verify|${message}`)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** URL::temporarySignedRoute('verify.verify', 60 minutes, [id, hash => sha256(email)]), on deploy-web. */
export async function verificationUrl(env: Env, publicId: string, email: string, nowMs = Date.now()): Promise<string> {
  const hash = await hashSha256(email.toLowerCase());
  const expires = Math.floor(nowMs / 1000) + VERIFY_EXPIRE_MINUTES * 60;
  const signature = await hmacHex(env, `${publicId}|${hash}|${expires}`);
  return `${(env.DEPLOY_WEB_URL ?? "").replace(/\/$/, "")}/email/verify/${publicId}/${hash}?expires=${expires}&signature=${signature}`;
}

/** Send the link (also called on registration). */
export async function sendVerificationEmail(env: Env, requestId: string, user: { id: string; email: string }, deps: EmailDeps = {}): Promise<void> {
  if (!env.DEPLOY_WEB_URL) return;
  const url = await verificationUrl(env, userPublicId(user.id), user.email, deps.now?.());
  await (deps.enqueue ?? enqueueNotification)(
    env,
    { internalActor: "identity-worker", actorSubjectType: "system", actorSubjectId: "identity-worker", requestId },
    {
      orgId: SYSTEM_ORG_ID,
      category: "security",
      templateKey: "auth.email_verification",
      templateData: { url },
      recipient: { channel: "email", address: user.email },
      idempotencyKey: buildIdempotencyKey("auth.email_verification", user.id, String(Math.floor(Date.now() / 300_000))),
      correlationId: requestId,
    },
  );
}

interface Ctx {
  db: SqlExecutor;
  userId: string;
  email: string;
}

async function signedIn(request: Request, env: Env, requestId: string, fn: (c: Ctx) => Promise<Response>): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) return errorResponse("unauthenticated", "Missing or invalid Authorization header", 401, requestId);
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);
  const db = createSqlExecutor(env.PLATFORM_DB);
  try {
    const s = await createAuthService({ repo: createIdentityRepository(db), now: () => new Date() }).getSession(token);
    if ("error" in s) return errorResponse("unauthenticated", s.message, 401, requestId);
    const userId = hexToUuid(s.user.id.slice(4));
    if (!userId) return errorResponse("unauthenticated", "Invalid session", 401, requestId);
    return await fn({ db, userId, email: s.user.email });
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await db.dispose();
  }
}

/** A limiter as Laravel's RateLimiter::attempt: count this attempt, refuse past `max` in `seconds`. */
async function attempt(c: Ctx, request: Request, requestId: string, event: string, key: string, max: number, seconds: number): Promise<{ ok: boolean; retryIn: number; count: number }> {
  const store = createPasswordStore(c.db);
  const k = await keys([key]);
  const [r] = await store.recentAttempts(event, k, seconds);
  const count = r?.count ?? 0;
  if (count >= max) {
    const oldest = r?.oldest ? new Date(r.oldest).getTime() : Date.now();
    return { ok: false, retryIn: Math.max(1, Math.ceil((oldest + seconds * 1000 - Date.now()) / 1000)), count };
  }
  const ctx = extractRequestContext(request, requestId);
  await createIdentityRepository(c.db).recordSecurityEvent({ id: generateSecurityEventId(), eventType: event, outcome: "attempt", userId: c.userId, requestId, ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, metadata: { throttle_keys: k } });
  return { ok: true, retryIn: 0, count: count + 1 };
}

export function handleVerificationNotification(request: Request, env: Env, requestId: string, deps: EmailDeps = {}): Promise<Response> {
  return signedIn(request, env, requestId, async (c) => {
    // VerifyEmail::again(): $this->rateLimit(1, 300).
    const a = await attempt(c, request, requestId, "email.verification.sent", `verify:${c.userId}`, 1, 300);
    if (!a.ok) return toast(requestId, `Too many requests. Please try again in ${a.retryIn} seconds.`, 429);
    await sendVerificationEmail(env, requestId, { id: c.userId, email: c.email }, deps);
    return successResponse({ status: "Email verification link sent!" }, requestId, 200);
  });
}

export function handleEmailVerify(request: Request, env: Env, requestId: string): Promise<Response> {
  return signedIn(request, env, requestId, async (c) => {
    const b = await readJson(request);
    const id = String(b.id ?? "");
    const hash = String(b.hash ?? "");
    const expires = Number(b.expires ?? 0);
    // Controller::email_verify: a valid signature, this user, this address; otherwise 403.
    const expected = await hmacHex(env, `${id}|${hash}|${expires}`);
    const valid =
      String(b.signature ?? "") === expected &&
      expires > Date.now() / 1000 &&
      id === userPublicId(c.userId) &&
      hash === (await hashSha256(c.email.toLowerCase()));
    if (!valid) return errorResponse("forbidden", "Invalid signature.", 403, requestId);
    await createEmailStore(c.db).markVerified(c.userId);
    return successResponse({ status: "verified" }, requestId, 200);
  });
}

export function handleEmailChangeState(request: Request, env: Env, requestId: string): Promise<Response> {
  return signedIn(request, env, requestId, async (c) => {
    const p = await createEmailStore(c.db).pending(c.userId);
    return successResponse({ pending: p && p.expiresAt.getTime() > Date.now() ? p.newEmail : null }, requestId, 200);
  });
}

function sixDigits(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 1_000_000;
  return String(n).padStart(6, "0");
}

async function sendCode(env: Env, requestId: string, c: Ctx, newEmail: string, deps: EmailDeps): Promise<void> {
  const code = sixDigits();
  await createEmailStore(c.db).request(c.userId, newEmail, await hashSha256(code), new Date(Date.now() + CODE_EXPIRE_MINUTES * 60_000));
  await (deps.enqueue ?? enqueueNotification)(
    env,
    { internalActor: "identity-worker", actorSubjectType: "system", actorSubjectId: "identity-worker", requestId },
    {
      orgId: SYSTEM_ORG_ID,
      category: "security",
      templateKey: "auth.email_change",
      templateData: { newEmail, code, expiryMinutes: CODE_EXPIRE_MINUTES },
      recipient: { channel: "email", address: newEmail },
      idempotencyKey: buildIdempotencyKey("auth.email_change", c.userId, code),
      correlationId: requestId,
    },
  );
}

/** requestEmailChange's validation: new_email required | email | unique:users,email. */
export async function newEmailErrors(value: unknown, taken: (lower: string) => Promise<boolean>): Promise<string[]> {
  const attribute = "new email";
  if (typeof value !== "string" || value.trim() === "") return [__("validation.required", { attribute })];
  const out: string[] = [];
  if (!isValidEmail(value)) out.push(__("validation.email", { attribute }));
  if (await taken(value.toLowerCase())) out.push(__("validation.unique", { attribute }));
  return out;
}

export function handleEmailChangeRequest(request: Request, env: Env, requestId: string, deps: EmailDeps = {}): Promise<Response> {
  return signedIn(request, env, requestId, async (c) => {
    const b = await readJson(request);
    const repo = createIdentityRepository(c.db);
    const errs = await newEmailErrors(b.new_email, async (lower) => (await repo.getUserByEmail(lower)).ok);
    if (errs.length) return validationError(requestId, { new_email: errs });
    const newEmail = String(b.new_email).toLowerCase();
    const ip = extractRequestContext(request, requestId).ip ?? "";
    if (!(await attempt(c, request, requestId, "email.change.user", `email-change:user:${c.userId}`, 1, 120)).ok) {
      const again = await createPasswordStore(c.db).recentAttempts("email.change.user", await keys([`email-change:user:${c.userId}`]), 120);
      const oldest = again[0]?.oldest ? new Date(again[0].oldest).getTime() : Date.now();
      return toast(requestId, `Too many requests. Please wait ${Math.max(1, Math.ceil((oldest + 120_000 - Date.now()) / 1000))} seconds before trying again.`, 429);
    }
    if (!(await attempt(c, request, requestId, "email.change.email", `email-change:email:${newEmail}`, 3, 3600)).ok) {
      return toast(requestId, "This email address has received too many verification requests. Please try again later.", 429);
    }
    if (!(await attempt(c, request, requestId, "email.change.ip", `email-change:ip:${ip}`, 5, 3600)).ok) {
      return toast(requestId, "Too many requests from your IP address. Please try again later.", 429);
    }
    await sendCode(env, requestId, c, newEmail, deps);
    return successResponse({ status: `Verification code sent to ${newEmail}`, pending: newEmail }, requestId, 200);
  });
}

export function handleEmailChangeVerify(request: Request, env: Env, requestId: string): Promise<Response> {
  return signedIn(request, env, requestId, async (c) => {
    const b = await readJson(request);
    const code = b.email_verification_code;
    const attribute = "email verification code";
    if (typeof code !== "string" || code === "") return validationError(requestId, { email_verification_code: [__("validation.required", { attribute })] });
    if (code.length !== 6) return validationError(requestId, { email_verification_code: [__("validation.size.string", { attribute, size: 6 })] });
    const store = createEmailStore(c.db);
    const key = `email-verify:user:${c.userId}`;
    const a = await attempt(c, request, requestId, "email.change.verify", key, 5, 600);
    if (!a.ok) {
      if (a.count >= 10) {
        await store.clear(c.userId);
        return toast(requestId, "Email change request cancelled due to too many failed attempts. Please start over.", 429);
      }
      return toast(requestId, `Too many verification attempts. Please wait ${Math.ceil(a.retryIn / 60)} minutes before trying again.`, 429);
    }
    const p = await store.pending(c.userId);
    if (!p || p.expiresAt.getTime() <= Date.now() || p.codeHash !== (await hashSha256(code))) return toast(requestId, "Invalid or expired verification code.");
    await store.apply(c.userId, p.newEmail);
    return successResponse({ status: "Email address updated successfully.", email: p.newEmail }, requestId, 200);
  });
}

export function handleEmailChangeResend(request: Request, env: Env, requestId: string, deps: EmailDeps = {}): Promise<Response> {
  return signedIn(request, env, requestId, async (c) => {
    const p = await createEmailStore(c.db).pending(c.userId);
    if (!p || p.expiresAt.getTime() <= Date.now()) return toast(requestId, "No pending email change request.");
    const half = CODE_EXPIRE_MINUTES / 2;
    const since = Math.floor((Date.now() - (p.expiresAt.getTime() - CODE_EXPIRE_MINUTES * 60_000)) / 60_000);
    if (since < half) return toast(requestId, `Please wait ${Math.ceil(half - since)} more minutes before requesting a new code.`);
    if (!(await attempt(c, request, requestId, "email.change.email", `email-change:email:${p.newEmail}`, 3, 3600)).ok) {
      return toast(requestId, "This email address has received too many verification requests. Please try again later.", 429);
    }
    await sendCode(env, requestId, c, p.newEmail, deps);
    return successResponse({ status: `New verification code sent to ${p.newEmail}` }, requestId, 200);
  });
}

export function handleEmailChangeCancel(request: Request, env: Env, requestId: string): Promise<Response> {
  return signedIn(request, env, requestId, async (c) => {
    await createEmailStore(c.db).clear(c.userId);
    return successResponse({ status: "Email change request cancelled." }, requestId, 200);
  });
}
