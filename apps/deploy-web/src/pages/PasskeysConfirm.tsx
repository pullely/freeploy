// Derived from coollabsio/coolify@91b7e3e:routes/web.php (profile.passkeys.confirm) (Apache-2.0), modified.
// GET /profile/passkeys/confirm sits behind password.confirm and redirects to
// /profile with status 'passkey-add', which opens the passkey form.
import { useEffect } from "react";
import { postJson, sessionToken } from "../lib/api";

export function PasskeysConfirmPage() {
  useEffect(() => {
    if (!sessionToken()) {
      window.location.replace("/login");
      return;
    }
    void postJson("/v1/auth/passkeys/options", {}).then((r) => {
      if (!r.ok && r.error.status === 423) {
        try {
          sessionStorage.setItem("freeploy.intended", "/profile?status=passkey-add");
        } catch {
          /* storage blocked */
        }
        window.location.replace("/user/confirm-password");
        return;
      }
      window.location.replace("/profile?status=passkey-add");
    });
  }, []);
  return null;
}
