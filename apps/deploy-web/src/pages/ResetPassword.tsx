// Derived from coollabsio/coolify@91b7e3e:resources/views/auth/reset-password.blade.php (Apache-2.0), modified.
// /reset-password/{token}?email=…: Coolify's markup with the brand swapped. Sets the
// new password through identity; on success Coolify redirects to /login with the
// status "Your password has been reset.".
import { useEffect, useState, type FormEvent } from "react";
import { ResetPasswordMarkup } from "./generated/ResetPasswordMarkup";
import { ErrorList } from "../components/AuthAlert";
import { postJson } from "../lib/api";
import { flashStatus } from "../lib/flash";

export function ResetPasswordPage() {
  const [errors, setErrors] = useState<string[]>([]);
  const token = decodeURIComponent(window.location.pathname.split("/").filter(Boolean)[1] ?? "");
  // Coolify fills the hidden token and the email from the request (the link carries ?email=).
  useEffect(() => {
    const email = new URLSearchParams(window.location.search).get("email") ?? "";
    const set = (name: string, value: string) => {
      const el = document.querySelector<HTMLInputElement>(`input[name="${name}"]`);
      if (el) el.value = value;
    };
    set("token", token);
    set("email", email);
  }, [token]);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const result = await postJson<{ status: string }>("/v1/auth/password/reset", {
      token,
      email: f.get("email"),
      password: f.get("password"),
      password_confirmation: f.get("password_confirmation"),
    });
    if (!result.ok) {
      setErrors(result.error.messages);
      return;
    }
    flashStatus(result.data.status);
    window.location.assign("/login");
  }
  return <ResetPasswordMarkup alert={<ErrorList errors={errors} />} onSubmit={onSubmit} />;
}
