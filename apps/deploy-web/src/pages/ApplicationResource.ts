// What the Persistent Storage, Tags, Resource Operations and Danger Zone pages
// of an application share: a request to the edge with any method that keeps
// the details of a refusal (a pending rename, an error's description), and
// how its answer is shown.
import { edgeBase, sessionToken } from "../lib/api";
import { notify, toast } from "../lib/toast";
import type { PatchError, PatchResult } from "./ApplicationSection";

/** POST, PATCH or DELETE to the edge. A DELETE carries its options in the query (the edge forwards no body with it). */
export async function sendJson<T>(method: "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>): Promise<PatchResult<T>> {
  const token = sessionToken();
  const headers: Record<string, string> = { ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const init: RequestInit = { method, headers };
  if (method !== "DELETE") {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  let res: Response;
  try {
    res = await fetch(edgeBase() + path, init);
  } catch {
    return { ok: false, error: { status: 0, message: "Network error. Please try again.", fields: {}, messages: [], details: {} } };
  }
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string; details?: Record<string, unknown> } } | null;
  if (res.ok && json?.data !== undefined) return { ok: true, data: json.data };
  const details = json?.error?.details ?? {};
  const fields = (details.fields as Record<string, string[]> | undefined) ?? {};
  return { ok: false, error: { status: res.status, message: json?.error?.message ?? "Something went wrong.", fields, messages: Object.values(fields).flat(), details } };
}

/** handleError() / dispatch('error', title, description): the refusal as an error toast (each field message on its own). */
export function showError(error: PatchError): void {
  if (error.messages.length) {
    for (const message of error.messages) notify.error(message);
    return;
  }
  const description = typeof error.details.description === "string" ? error.details.description : "";
  toast(error.message, { type: "danger", description });
}

/** What a save answers beside the page's data: the success toast, and what could not run on the server. */
export function showSaved(saved: { message?: string | null; unavailable?: string }): void {
  if (saved.message) notify.success(saved.message);
  if (saved.unavailable) toast(saved.unavailable, { type: "warning" });
}
