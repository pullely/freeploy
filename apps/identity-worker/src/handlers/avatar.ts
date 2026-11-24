// Derived from coollabsio/coolify@91b7e3e (app/Livewire/Profile/Index.php uploadAvatar and
// removeAvatar; profile_avatar_url) (Apache-2.0), modified.
//
//   PUT    /v1/auth/avatar         raw image body (Content-Type image/jpeg|png|webp)
//   DELETE /v1/auth/avatar
//   GET    /v1/auth/avatar/{usr_…} the image (public, like Coolify's avatar URL)
import type { Env } from "../env.js";
import { createSqlExecutor } from "@saas/db/hyperdrive";
import { createAvatarStore, createIdentityRepository } from "@saas/db/identity";
import { hexToUuid } from "@saas/db/ids";
import { createAuthService } from "../services/auth.js";
import { successResponse, errorResponse, validationError, extractBearerToken } from "../http.js";

const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_KB = 5120;
const MAX_SIDE = 6000;

/** Width and height from a JPEG, PNG or WebP header, or null. */
export function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const u16 = (i: number) => (b[i]! << 8) | b[i + 1]!;
  const le16 = (i: number) => b[i]! | (b[i + 1]! << 8);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: (u16(16) << 16) | u16(18), h: (u16(20) << 16) | u16(22) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const marker = b[i + 1]!;
      const len = u16(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: u16(i + 5), w: u16(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  const tag = String.fromCharCode(...b.slice(8, 12));
  if (String.fromCharCode(...b.slice(0, 4)) === "RIFF" && tag === "WEBP") {
    const chunk = String.fromCharCode(...b.slice(12, 16));
    if (chunk === "VP8 ") return { w: le16(26) & 0x3fff, h: le16(28) & 0x3fff };
    if (chunk === "VP8L") {
      const v = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
      return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8X") return { w: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), h: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
  }
  return null;
}

/** 'avatar' => required | image | mimes:jpg,jpeg,png,webp | max:5120 | dimensions:max_width=6000,max_height=6000. */
export function avatarErrors(contentType: string, bytes: Uint8Array): string[] {
  if (!bytes.length) return ["The avatar field is required."];
  const size = imageSize(bytes);
  if (!TYPES[contentType] || !size) return ["The avatar field must be an image.", "The avatar field must be a file of type: jpg, jpeg, png, webp."];
  const out: string[] = [];
  if (bytes.length > MAX_KB * 1024) out.push(`The avatar field must not be greater than ${MAX_KB} kilobytes.`);
  if (size.w > MAX_SIDE || size.h > MAX_SIDE) out.push("The avatar field has invalid image dimensions.");
  return out;
}

const b64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

async function signedInUser(request: Request, env: Env, requestId: string, fn: (db: ReturnType<typeof createSqlExecutor>, userId: string) => Promise<Response>): Promise<Response> {
  const token = extractBearerToken(request);
  if (!token) return errorResponse("unauthenticated", "Missing or invalid Authorization header", 401, requestId);
  if (!env.PLATFORM_DB) return errorResponse("internal_error", "Database not configured", 503, requestId);
  const db = createSqlExecutor(env.PLATFORM_DB);
  try {
    const s = await createAuthService({ repo: createIdentityRepository(db), now: () => new Date() }).getSession(token);
    if ("error" in s) return errorResponse("unauthenticated", s.message, 401, requestId);
    const id = hexToUuid(s.user.id.slice(4));
    if (!id) return errorResponse("unauthenticated", "Invalid session", 401, requestId);
    return await fn(db, id);
  } catch {
    return errorResponse("internal_error", "An unexpected error occurred", 500, requestId);
  } finally {
    await db.dispose();
  }
}

export function handleAvatarPut(request: Request, env: Env, requestId: string): Promise<Response> {
  return signedInUser(request, env, requestId, async (db, userId) => {
    const contentType = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const bytes = new Uint8Array(await request.arrayBuffer());
    const errs = avatarErrors(contentType, bytes);
    if (errs.length) return validationError(requestId, { avatar: errs });
    await createAvatarStore(db).put(userId, contentType, b64(bytes));
    return successResponse({ status: "Profile picture updated." }, requestId, 200);
  });
}

export function handleAvatarDelete(request: Request, env: Env, requestId: string): Promise<Response> {
  return signedInUser(request, env, requestId, async (db, userId) => {
    await createAvatarStore(db).remove(userId);
    return successResponse({ status: "Profile picture removed." }, requestId, 200);
  });
}

export async function handleAvatarGet(_request: Request, env: Env, requestId: string, publicId: string): Promise<Response> {
  const userId = hexToUuid(publicId.slice(4));
  if (!userId || !env.PLATFORM_DB) return errorResponse("not_found", "Not Found", 404, requestId);
  const db = createSqlExecutor(env.PLATFORM_DB);
  try {
    const a = await createAvatarStore(db).get(userId);
    if (!a) return errorResponse("not_found", "Not Found", 404, requestId);
    const bytes = Uint8Array.from(atob(a.data), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: { "content-type": a.contentType, "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
  } finally {
    await db.dispose();
  }
}
