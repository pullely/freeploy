// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Source/Github/Change.php (createGithubAppSetupState),
// bootstrap/helpers/github.php (getInstallationPath) and app/Http/Controllers/Webhook/Github.php
// (consumeGithubAppSetupState) (Apache-2.0), modified.
//
// The `state` of GitHub's manifest and installation redirects: which App of which org started the setup, and
// for what ('manifest' or 'install'), for 60 minutes. Coolify keeps a random state in its cache and pulls it
// once; deploy-core-worker has no cache, so the state carries its payload, signed with a key derived from
// DEPLOY_ENCRYPTION_KEY (HMAC-SHA256), and expires on its own. It is not single-use: replaying a manifest
// state finds the App's credentials already set (403, as Coolify), and replaying an install state asks
// GitHub about the installation again. The payload is readable — the org it names is how deploy-web knows
// which org to send the callback to — and holds no secret.

export type SetupAction = "manifest" | "install";

export interface SetupState {
  action: SetupAction;
  /** The App's uuid. */
  app: string;
  /** The org's public id (org_…), as the routes take it. */
  org: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

const enc = new TextEncoder();
const TTL_SECONDS = 60 * 60;

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function signingKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = new Uint8Array(await crypto.subtle.sign("HMAC", raw, enc.encode("freeploy:github-app-setup-state")));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** A new state for the App's manifest or installation redirect. */
export async function createSetupState(secret: string, action: SetupAction, app: string, org: string, now: Date = new Date()): Promise<string> {
  const payload = base64url(enc.encode(JSON.stringify({ action, app, org, exp: Math.floor(now.getTime() / 1000) + TTL_SECONDS } satisfies SetupState)));
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await signingKey(secret), enc.encode(payload)));
  return `${payload}.${base64url(signature)}`;
}

/** The payload of a state whose signature holds, that has not expired and is for `action`; else null. */
export async function readSetupState(secret: string, state: unknown, action: SetupAction, now: Date = new Date()): Promise<SetupState | null> {
  if (typeof state !== "string" || state.length > 2048) return null;
  const [payload, signature, extra] = state.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const sig = fromBase64url(signature);
  const body = fromBase64url(payload);
  if (!sig || !body) return null;
  if (!(await crypto.subtle.verify("HMAC", await signingKey(secret), new Uint8Array(sig), enc.encode(payload)))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  const s = parsed as Partial<SetupState>;
  if (s.action !== action || typeof s.app !== "string" || typeof s.org !== "string" || typeof s.exp !== "number") return null;
  if (s.exp <= Math.floor(now.getTime() / 1000)) return null;
  return { action: s.action, app: s.app, org: s.org, exp: s.exp };
}
