// Derived from coollabsio/coolify@91b7e3e:resources/views/auth/confirm-password.blade.php (Apache-2.0), modified.
// /user/confirm-password (Fortify password.confirm): confirms the session's
// password for 3 hours, then returns to the page that asked (redirect()->intended()).
import { useState, type FormEvent } from "react";
import { ConfirmPasswordMarkup } from "./generated/ConfirmPasswordMarkup";
import { ErrorList } from "../components/AuthAlert";
import { postJson, sessionToken } from "../lib/api";

export function ConfirmPasswordPage() {
  const [errors, setErrors] = useState<string[]>([]);
  if (!sessionToken()) {
    window.location.replace("/login");
    return null;
  }
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const result = await postJson("/v1/auth/password/confirm", { password: new FormData(e.currentTarget).get("password") });
    if (!result.ok) {
      setErrors(result.error.messages);
      return;
    }
    let intended = "/";
    try {
      intended = sessionStorage.getItem("freeploy.intended") || "/";
      sessionStorage.removeItem("freeploy.intended");
    } catch {
      /* storage blocked */
    }
    window.location.assign(intended);
  }
  return <ConfirmPasswordMarkup alert={<ErrorList errors={errors} />} onSubmit={onSubmit} />;
}
