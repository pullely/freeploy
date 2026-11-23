// Laravel's session('status') flash: a message shown once on the next page
// (e.g. "Your password has been reset." on /login after a reset).
const KEY = "freeploy.flash.status";

export function flashStatus(message: string): void {
  try {
    sessionStorage.setItem(KEY, message);
  } catch {
    /* storage blocked: the message is skipped */
  }
}

export function takeStatus(): string | null {
  try {
    const v = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return v;
  } catch {
    return null;
  }
}
