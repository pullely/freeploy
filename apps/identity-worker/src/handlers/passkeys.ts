// Derived from coollabsio/coolify@91b7e3e (config/fortify.php Features::passkeys with
// confirmPassword; app/Livewire/Profile/Passkeys.php; resources/views/livewire/profile/passkeys.blade.php;
// resources/views/auth/login.blade.php) and the Laravel passkeys behaviour it configures
// (Apache-2.0 / MIT), modified. WebAuthn by @simplewebauthn/server.
//
//   GET    /v1/auth/passkeys                       the user's passkeys, newest first
//   POST   /v1/auth/passkeys/options               registration options (needs a confirmed password)
//   POST   /v1/auth/passkeys            { name, state, response }   add
//   PATCH  /v1/auth/passkeys/{id}       { name }                    rename
//   DELETE /v1/auth/passkeys/{id}       { password }                delete
//   POST   /v1/auth/passkeys/login/options                          sign-in options
//   POST   /v1/auth/passkeys/login      { state, response }         sign in (skips 2FA)
//
// The relying party is deploy-web's host (DEPLOY_WEB_URL); the WebAuthn
// challenge travels sealed in `state`, so no challenge table is needed.
import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createIdentityRepository, createPasskeyStore, createPasswordStore, createTwoFactorStore } from "@saas/db/identity";
import { hexToUuid } from "@saas/db/ids";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { createAuthService } from "../services/auth.js";
import { successResponse, errorResponse, validationError, extractBearerToken } from "../http.js";
import { verifyPassword } from "../password.js";
import { loadKey, open, seal } from "../secret-box.js";
import { issueSession } from "./password-auth.js";
import { PASSWORD_TIMEOUT_SECONDS } from "./two-factor.js";
import { __ } from "../laravel-messages.js";

const RP_NAME = "Freeploy";
const STATE_SECONDS = 300;
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export function relyingParty(env: Env): { rpID: string; origin: string } | null {
  if (!env.DEPLOY_WEB_URL) return null;
  const u = new URL(env.DEPLOY_WEB_URL);
  return { rpID: u.hostname, origin: u.origin };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const publicPasskey = (p: { id: string; name: string; createdAt: Date; lastUsedAt: Date | null }) => ({
  id: p.id,
  name: p.name,
  createdAt: p.createdAt.toISOString(),
  lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
});

type Session = { userId: string; sessionId: string; email: string; displayName: string | null };

async function signedIn(request: Request, env: Env, requestId: string, fn: (s: Session, db: ReturnType<typeof createSqlExecutor>) => Promise<Response>): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) return errorResponse("unauthenticated", "Missing or invalid Authorization header", 401, requestId);
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);
  const db = createSqlExecutor(env.PLATFORM_DB);
  try {
    const s = await createAuthService({ repo: createIdentityRepository(db), now: () => new Date() }).getSession(token);
    if ("error" in s) return errorResponse("unauthenticated", s.message, 401, requestId);
    const userId = hexToUuid(s.user.id.slice(4));
    const sessionId = hexToUuid(s.session.id.slice(4));
    if (!userId || !sessionId) return errorResponse("unauthenticated", "Invalid session", 401, requestId);
    return await fn({ userId, sessionId, email: s.user.email, displayName: s.user.displayName }, db);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await db.dispose();
  }
}

export function handlePasskeyList(request: Request, env: Env, requestId: string): Promise<Response> {
  return signedIn(request, env, requestId, async (s, db) => {
    const list = await createPasskeyStore(db).list(s.userId);
    return successResponse({ available: relyingParty(env) !== null, passkeys: list.map(publicPasskey) }, requestId, 200);
  });
}

export function handlePasskeyOptions(request: Request, env: Env, requestId: string): Promise<Response> {
  return signedIn(request, env, requestId, async (s, db) => {
    const rp = relyingParty(env);
    if (!rp) return errorResponse("unavailable", "Passkeys are not available.", 503, requestId);
    const at = await createTwoFactorStore(db).passwordConfirmedAt(s.sessionId);
    if (!at || Date.now() - at.getTime() >= PASSWORD_TIMEOUT_SECONDS * 1000) {
      return errorResponse("password_confirmation_required", "Password confirmation required.", 423, requestId);
    }
    const existing = await createPasskeyStore(db).list(s.userId);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: rp.rpID,
      userName: s.email,
      userDisplayName: s.displayName ?? s.email,
      userID: new TextEncoder().encode(s.userId),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({ id: p.credentialId, transports: p.transports as AuthenticatorTransportFuture[] })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    const key = await loadKey(env.IDENTITY_ENCRYPTION_KEY);
    const state = await seal(key, `passkey-register:${s.userId}`, JSON.stringify({ c: options.challenge, exp: Math.floor(Date.now() / 1000) + STATE_SECONDS }));
    return successResponse({ options, state }, requestId, 200);
  });
}

export function handlePasskeyAdd(request: Request, env: Env, requestId: string): Promise<Response> {
  return signedIn(request, env, requestId, async (s, db) => {
    const rp = relyingParty(env);
    if (!rp) return errorResponse("unavailable", "Passkeys are not available.", 503, requestId);
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return validationError(requestId, { name: [__("validation.required", { attribute: "name" })] });
    if (name.length > 255) return validationError(requestId, { name: [__("validation.max.string", { attribute: "name", max: 255 })] });
    const key = await loadKey(env.IDENTITY_ENCRYPTION_KEY);
    let challenge: string;
    try {
      const st = JSON.parse(await open(key, `passkey-register:${s.userId}`, String(body.state ?? ""))) as { c: string; exp: number };
      if (st.exp < Date.now() / 1000) throw new Error("expired");
      challenge = st.c;
    } catch {
      return validationError(requestId, { passkey: ["The passkey registration expired. Please try again."] });
    }
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: false,
      });
    } catch {
      verified = null;
    }
    if (!verified?.verified || !verified.registrationInfo) return validationError(requestId, { passkey: ["The passkey could not be verified."] });
    const cred = verified.registrationInfo.credential;
    const id = crypto.randomUUID();
    await createPasskeyStore(db).add({ id, userId: s.userId, name, credentialId: cred.id, publicKey: b64url(cred.publicKey), counter: cred.counter, transports: cred.transports ?? [] });
    return successResponse({ status: "Passkey added.", passkey: { id, name } }, requestId, 201);
  });
}

export function handlePasskeyRename(request: Request, env: Env, requestId: string, id: string): Promise<Response> {
  return signedIn(request, env, requestId, async (s, db) => {
    const body = await readJson(request);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return validationError(requestId, { name: [__("validation.required", { attribute: "name" })] });
    if (name.length > 255) return validationError(requestId, { name: [__("validation.max.string", { attribute: "name", max: 255 })] });
    if (!(await createPasskeyStore(db).rename(s.userId, id, name))) return errorResponse("not_found", "Not Found", 404, requestId);
    return successResponse({ status: "Passkey renamed." }, requestId, 200);
  });
}

export function handlePasskeyDelete(request: Request, env: Env, requestId: string, id: string): Promise<Response> {
  return signedIn(request, env, requestId, async (s, db) => {
    const body = await readJson(request);
    const hash = await createPasswordStore(db).get(s.userId);
    if (typeof body.password !== "string" || !hash || !(await verifyPassword(body.password, hash))) {
      return validationError(requestId, { password: ["The provided password is incorrect."] });
    }
    if (!(await createPasskeyStore(db).remove(s.userId, id))) return errorResponse("not_found", "Not Found", 404, requestId);
    return successResponse({ status: "Passkey deleted." }, requestId, 200);
  });
}

export async function handlePasskeyLoginOptions(_request: Request, env: Env, requestId: string): Promise<Response> {
  const rp = relyingParty(env);
  if (!rp) return errorResponse("unavailable", "Passkeys are not available.", 503, requestId);
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "preferred" });
  const key = await loadKey(env.IDENTITY_ENCRYPTION_KEY);
  const state = await seal(key, "passkey-login", JSON.stringify({ c: options.challenge, exp: Math.floor(Date.now() / 1000) + STATE_SECONDS }));
  return successResponse({ options, state }, requestId, 200);
}

const LOGIN_FAILED = "The passkey could not be verified.";

export async function handlePasskeyLogin(request: Request, env: Env, requestId: string): Promise<Response> {
  const rp = relyingParty(env);
  if (!rp || !env.PLATFORM_DB) return errorResponse("unavailable", "Passkeys are not available.", 503, requestId);
  const body = await readJson(request);
  const response = body.response as AuthenticationResponseJSON | undefined;
  let challenge: string;
  try {
    const key = await loadKey(env.IDENTITY_ENCRYPTION_KEY);
    const st = JSON.parse(await open(key, "passkey-login", String(body.state ?? ""))) as { c: string; exp: number };
    if (st.exp < Date.now() / 1000) throw new Error("expired");
    challenge = st.c;
  } catch {
    return validationError(requestId, { email: [LOGIN_FAILED] });
  }
  const db = createSqlExecutor(env.PLATFORM_DB);
  try {
    const store = createPasskeyStore(db);
    const passkey = response?.id ? await store.byCredentialId(response.id) : null;
    if (!passkey || !response) return validationError(requestId, { email: [LOGIN_FAILED] });
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: { id: passkey.credentialId, publicKey: unb64url(passkey.publicKey), counter: passkey.counter, transports: passkey.transports as AuthenticatorTransportFuture[] },
        requireUserVerification: false,
      });
    } catch {
      verified = null;
    }
    if (!verified?.verified) return validationError(requestId, { email: [LOGIN_FAILED] });
    await store.used(passkey.id, verified.authenticationInfo.newCounter);
    const user = await createIdentityRepository(db).getUserById(passkey.userId);
    if (!user.ok) return validationError(requestId, { email: [LOGIN_FAILED] });
    // A passkey sign-in skips two-factor authentication (Coolify's copy says so).
    const session = await issueSession(db, request, requestId, user.value, "passkey");
    if (!session) return errorResponse("internal_error", "Failed to create session", 500, requestId);
    return successResponse(session, requestId, 200);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await db.dispose();
  }
}
