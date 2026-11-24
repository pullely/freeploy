// Derived from coollabsio/coolify@91b7e3e:resources/views/auth/forgot-password.blade.php (Apache-2.0), modified.
// /forgot-password: Coolify's markup with the brand swapped. Asks identity for a
// reset link; Coolify shows the same status whether or not the address exists.
import { useState, type FormEvent } from "react";
import { ForgotPasswordMarkup } from "./generated/ForgotPasswordMarkup";
import { AuthAlert, ErrorList } from "../components/AuthAlert";
import { postJson } from "../lib/api";

export function ForgotPasswordPage() {
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const result = await postJson<{ status: string }>("/v1/auth/password/forgot", { email: f.get("email") });
    if (!result.ok) {
      setStatus(null);
      setErrors(result.error.messages);
      return;
    }
    setErrors([]);
    setStatus(result.data.status);
  }
  const alert = status ? <AuthAlert type="success">{status}</AuthAlert> : <ErrorList errors={errors} />;
  return <ForgotPasswordMarkup alert={alert} onSubmit={onSubmit} />;
}
