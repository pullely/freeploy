// session('success' | 'error') of Coolify's GitHub redirects (DP-72): the message a callback page leaves for the
// page it goes on to — the source's page, or the Sources list — shown there once as a toast.
import { toast } from "./toast";

const FLASH_KEY = "freeploy.flash.source";

export function flashSource(type: "success" | "error", message: string): void {
  try {
    sessionStorage.setItem(FLASH_KEY, JSON.stringify({ type, message }));
  } catch {
    /* storage blocked: the message is skipped */
  }
}

/** Shows the message a redirect left, once. */
export function showSourceFlash(): void {
  try {
    const raw = sessionStorage.getItem(FLASH_KEY);
    sessionStorage.removeItem(FLASH_KEY);
    if (!raw) return;
    const f = JSON.parse(raw) as { type: "success" | "error"; message: string };
    toast(f.message, { type: f.type === "error" ? "danger" : "success" });
  } catch {
    /* storage blocked */
  }
}
