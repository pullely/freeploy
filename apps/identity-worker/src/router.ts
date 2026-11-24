import type { Env } from "./env.js";
import { handleHealth } from "./handlers/health.js";
import { handleLoginStart } from "./handlers/login-start.js";
import { handlePasswordLogin, handlePasswordRegister } from "./handlers/password-auth.js";
import { handlePasswordChange } from "./handlers/password-change.js";
import { handleDeletionInfo, handleAccountDelete } from "./handlers/account.js";
import { handleAvatarPut, handleAvatarDelete, handleAvatarGet } from "./handlers/avatar.js";
import {
  handleVerificationNotification,
  handleEmailVerify,
  handleEmailChangeState,
  handleEmailChangeRequest,
  handleEmailChangeCancel,
  handleEmailChangeVerify,
  handleEmailChangeResend,
} from "./handlers/email.js";
import {
  handlePasskeyList,
  handlePasskeyAdd,
  handlePasskeyOptions,
  handlePasskeyLoginOptions,
  handlePasskeyLogin,
  handlePasskeyRename,
  handlePasskeyDelete,
} from "./handlers/passkeys.js";
import {
  handlePasswordConfirm,
  handleTwoFactorState,
  handleTwoFactorEnable,
  handleTwoFactorDisable,
  handleTwoFactorConfirm,
  handleRecoveryCodes,
  handleTwoFactorChallenge,
} from "./handlers/two-factor.js";
import { handlePasswordForgot, handlePasswordReset } from "./handlers/password-reset.js";
import { handleLoginComplete } from "./handlers/login-complete.js";
import { handleSession } from "./handlers/session.js";
import { handleResolveBearer } from "./handlers/resolve-bearer.js";
import { handleLogout } from "./handlers/logout.js";
import { handleSecurityEvents } from "./handlers/security-events.js";
import { handleProfile } from "./handlers/profile.js";
import { handleOAuthProviders } from "./handlers/oauth-providers.js";
import { handleOAuthStart } from "./handlers/oauth-start.js";
import { handleOAuthCallback } from "./handlers/oauth-callback.js";
import { handleCreateApiKey, handleListApiKeys, handleRevokeApiKey } from "./handlers/api-key-admin.js";
import { errorResponse, notFound, methodNotAllowed } from "./http.js";

const ORG_API_KEYS_RE = /^\/v1\/organizations\/[^/]+\/api-keys$/;
const ORG_API_KEY_ID_RE = /^\/v1\/organizations\/[^/]+\/api-keys\/[^/]+$/;
const OAUTH_START_RE = /^\/v1\/auth\/oauth\/[^/]+\/start$/;
const OAUTH_CALLBACK_RE = /^\/v1\/auth\/oauth\/[^/]+\/callback$/;
import { generateRequestId } from "./ids.js";

const REQUEST_ID_RE = /^[\w-]{1,128}$/;

function resolveRequestId(request: Request): string {
  const header = request.headers.get("x-request-id");
  if (header && REQUEST_ID_RE.test(header)) return header;
  return generateRequestId();
}

export async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const requestId = resolveRequestId(request);

  try {
    if (url.pathname === "/health" && request.method === "GET") {
      return handleHealth(env, requestId);
    }

    if (url.pathname === "/v1/auth/login/start") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleLoginStart(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/password/login") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handlePasswordLogin(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/password/register") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handlePasswordRegister(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/password/forgot") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handlePasswordForgot(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/password/reset") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handlePasswordReset(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/password/confirm") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handlePasswordConfirm(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/two-factor") {
      if (request.method === "GET") return handleTwoFactorState(request, env, requestId);
      if (request.method === "POST") return handleTwoFactorEnable(request, env, requestId);
      if (request.method === "DELETE") return handleTwoFactorDisable(request, env, requestId);
      return methodNotAllowed(requestId);
    }

    if (url.pathname === "/v1/auth/two-factor/confirm") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleTwoFactorConfirm(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/two-factor/recovery-codes") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleRecoveryCodes(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/two-factor/challenge") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleTwoFactorChallenge(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/avatar") {
      if (request.method === "PUT") return handleAvatarPut(request, env, requestId);
      if (request.method === "DELETE") return handleAvatarDelete(request, env, requestId);
      return methodNotAllowed(requestId);
    }
    const avatarOf = url.pathname.match(/^\/v1\/auth\/avatar\/(usr_[0-9a-f]{32})$/)?.[1];
    if (avatarOf) {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleAvatarGet(request, env, requestId, avatarOf);
    }

    if (url.pathname === "/v1/auth/account/deletion") {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleDeletionInfo(request, env, requestId);
    }
    if (url.pathname === "/v1/auth/account") {
      if (request.method !== "DELETE") return methodNotAllowed(requestId);
      return handleAccountDelete(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/email/verification-notification") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleVerificationNotification(request, env, requestId);
    }
    if (url.pathname === "/v1/auth/email/verify") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleEmailVerify(request, env, requestId);
    }
    if (url.pathname === "/v1/auth/email/change") {
      if (request.method === "GET") return handleEmailChangeState(request, env, requestId);
      if (request.method === "POST") return handleEmailChangeRequest(request, env, requestId);
      if (request.method === "DELETE") return handleEmailChangeCancel(request, env, requestId);
      return methodNotAllowed(requestId);
    }
    if (url.pathname === "/v1/auth/email/change/verify") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleEmailChangeVerify(request, env, requestId);
    }
    if (url.pathname === "/v1/auth/email/change/resend") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleEmailChangeResend(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/passkeys") {
      if (request.method === "GET") return handlePasskeyList(request, env, requestId);
      if (request.method === "POST") return handlePasskeyAdd(request, env, requestId);
      return methodNotAllowed(requestId);
    }
    if (url.pathname === "/v1/auth/passkeys/options") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handlePasskeyOptions(request, env, requestId);
    }
    if (url.pathname === "/v1/auth/passkeys/login/options") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handlePasskeyLoginOptions(request, env, requestId);
    }
    if (url.pathname === "/v1/auth/passkeys/login") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handlePasskeyLogin(request, env, requestId);
    }
    const passkeyId = url.pathname.match(/^\/v1\/auth\/passkeys\/([0-9a-f-]{36})$/)?.[1];
    if (passkeyId) {
      if (request.method === "PATCH") return handlePasskeyRename(request, env, requestId, passkeyId);
      if (request.method === "DELETE") return handlePasskeyDelete(request, env, requestId, passkeyId);
      return methodNotAllowed(requestId);
    }

    if (url.pathname === "/v1/auth/password/change") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handlePasswordChange(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/login/complete") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleLoginComplete(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/session") {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleSession(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/resolve") {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleResolveBearer(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/logout") {
      if (request.method !== "POST") return methodNotAllowed(requestId);
      return handleLogout(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/security-events") {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleSecurityEvents(request, env, requestId);
    }

    if (url.pathname === "/v1/auth/profile") {
      if (request.method !== "GET" && request.method !== "PATCH") return methodNotAllowed(requestId);
      return handleProfile(request, env, requestId);
    }

    // OAuth sign-in (pre-organization, identity-owned). Browser-redirect flow.
    if (url.pathname === "/v1/auth/oauth/providers") {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleOAuthProviders(env, requestId);
    }

    if (OAUTH_START_RE.test(url.pathname)) {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleOAuthStart(request, env, requestId);
    }

    if (OAUTH_CALLBACK_RE.test(url.pathname)) {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return handleOAuthCallback(request, env, requestId);
    }

    // API-key admin routes (forwarded from api-edge)
    if (ORG_API_KEYS_RE.test(url.pathname)) {
      if (request.method === "POST") return handleCreateApiKey(request, env, requestId);
      if (request.method === "GET") return handleListApiKeys(request, env, requestId);
      return methodNotAllowed(requestId);
    }

    if (ORG_API_KEY_ID_RE.test(url.pathname)) {
      if (request.method === "DELETE") return handleRevokeApiKey(request, env, requestId);
      return methodNotAllowed(requestId);
    }

    return notFound(requestId, url.pathname);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  }
}
