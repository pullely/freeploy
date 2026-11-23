// Derived from coollabsio/coolify@91b7e3e:resources/views/auth/login.blade.php (Apache-2.0), modified.
// /login: Coolify's markup (generated from the reference's rendered page), the
// brand swapped. Submitting signs in with email + password through Freeploy's
// identity service; failures show Laravel's messages in Coolify's error alert.
import { useState, type FormEvent } from "react";
import { LoginMarkup } from "./generated/LoginMarkup";
import { ErrorList } from "../components/AuthAlert";
import { postJson, storeSession } from "../lib/api";

export function LoginPage() {
  const [errors, setErrors] = useState<string[]>([]);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const result = await postJson<{ token: string }>("/v1/auth/password/login", { email: form.get("email"), password: form.get("password") });
    if (!result.ok) {
      setErrors(result.error.messages);
      return;
    }
    storeSession(result.data.token);
    window.location.assign("/");
  }
  return <LoginMarkup alert={<ErrorList errors={errors} />} onSubmit={onSubmit} />;
}
