// Derived from coollabsio/coolify@91b7e3e:resources/views/auth/register.blade.php (Apache-2.0), modified.
// /register: Coolify's markup (generated from the reference's rendered page) with
// the brand swapped; registers through Freeploy's identity service with
// Coolify's rules and messages, then signs in.
import { useState, type FormEvent } from "react";
import { RegisterMarkup } from "./generated/RegisterMarkup";
import { ErrorList } from "../components/AuthAlert";
import { postJson, storeSession } from "../lib/api";

export function RegisterPage() {
  const [errors, setErrors] = useState<string[]>([]);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const result = await postJson<{ token: string }>("/v1/auth/password/register", {
      name: f.get("name"),
      email: f.get("email"),
      password: f.get("password"),
      password_confirmation: f.get("password_confirmation"),
    });
    if (!result.ok) {
      setErrors(result.error.messages);
      return;
    }
    storeSession(result.data.token);
    window.location.assign("/");
  }
  return <RegisterMarkup alert={<ErrorList errors={errors} />} onSubmit={onSubmit} />;
}
