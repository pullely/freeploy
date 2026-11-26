// The console talks to api-edge. On workers.dev the edge is the same host with
// "deploy-web" replaced by "api-edge"; on a custom domain it is api.<domain>.
const SESSION_KEY = "freeploy.session";

export function edgeBase(host = window.location.host): string {
  if (host.includes("deploy-web")) return `https://${host.replace("deploy-web", "api-edge")}`;
  if (host.startsWith("app.")) return `https://api.${host.slice(4)}`;
  if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) return "http://127.0.0.1:8787";
  return `https://api.${host}`;
}

export function sessionToken(): string | null {
  try {
    return localStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

export function storeSession(token: string): void {
  try {
    localStorage.setItem(SESSION_KEY, token);
  } catch {
    /* storage blocked: the session lasts this page only */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage blocked */
  }
}

function authHeaders(): Record<string, string> {
  const token = sessionToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** GET from the edge with the session; null data on 401 (signed out). */
export async function getJson<T>(path: string): Promise<{ status: number; data: T | null }> {
  try {
    const res = await fetch(edgeBase() + path, { headers: authHeaders() });
    const json = (await res.json().catch(() => null)) as { data?: T } | null;
    return { status: res.status, data: res.ok ? (json?.data ?? null) : null };
  } catch {
    return { status: 0, data: null };
  }
}

export interface ApiError {
  status: number;
  /** Messages in Laravel's `$errors->all()` order. */
  messages: string[];
  /** The messages per field, when the edge answered a validation error. */
  fields?: Record<string, string[]>;
  /** A toast's second line, when the API gives one (dispatch('error', $message, $description)). */
  description?: string;
}

/** Laravel's ValidationException message: the first error, then "(and N more error[s])". */
export function summarize(messages: string[]): string {
  const [first = "Something went wrong.", ...rest] = messages;
  if (!rest.length) return first;
  return `${first} (and ${rest.length} more ${rest.length === 1 ? "error" : "errors"})`;
}

/** POST JSON to the edge; on failure, the field messages flattened the way Laravel shows them. */
export async function postJson<T>(path: string, body: unknown, method: "POST" | "PATCH" | "PUT" | "DELETE" = "POST"): Promise<{ ok: true; data: T } | { ok: false; error: ApiError }> {
  let res: Response;
  try {
    res = await fetch(edgeBase() + path, { method, headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: { status: 0, messages: ["Network error. Please try again."] } };
  }
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string; details?: { fields?: Record<string, string[]>; description?: string } } } | null;
  if (res.ok && json?.data !== undefined) return { ok: true, data: json.data };
  const fields = json?.error?.details?.fields;
  const messages = fields ? Object.values(fields).flat() : [json?.error?.message ?? "Something went wrong."];
  const description = json?.error?.details?.description;
  return { ok: false, error: { status: res.status, messages, ...(fields ? { fields } : {}), ...(typeof description === "string" ? { description } : {}) } };
}
