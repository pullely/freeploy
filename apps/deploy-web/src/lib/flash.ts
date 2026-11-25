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

// A notice for the page a form redirects to: what a save could not do yet
// (a step that needs the SSH executor). The next page takes it and shows it once.
const NOTICE_KEY = "freeploy.flash.notice";

export function flashNotice(message: string): void {
  try {
    sessionStorage.setItem(NOTICE_KEY, message);
  } catch {
    /* storage blocked: the message is skipped */
  }
}

export function takeNotice(): string | null {
  try {
    const v = sessionStorage.getItem(NOTICE_KEY);
    sessionStorage.removeItem(NOTICE_KEY);
    return v;
  } catch {
    return null;
  }
}
