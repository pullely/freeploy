// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/profile/index.blade.php and
// app/Livewire/Profile/Index.php (Apache-2.0), modified.
// /profile: Coolify's markup (generated from the reference's rendered page).
// Saving the name and changing the password work as in Coolify, with its
// toasts; the email change, avatar, 2FA, passkeys and account deletion are
// later DP3 tasks.
import type { FormEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { ProfileMarkup } from "./generated/ProfileMarkup";
import { ProfilePortalMarkup } from "./generated/ProfilePortalMarkup";
import { postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";

const initial = (s: string) => (s.trim()[0] ?? "").toUpperCase();

function ProfileContent() {
  const { me, setMe } = useSignedIn();
  const name = me.user.displayName?.trim() || me.user.email;

  // <x-unsaved-bar>: shown (class is-dirty) while the form differs from what is saved.
  function onProfileInput(e: FormEvent<HTMLFormElement>) {
    const value = (e.currentTarget.elements.namedItem("name") as HTMLInputElement | null)?.value ?? "";
    e.currentTarget.firstElementChild?.classList.toggle("is-dirty", value !== name);
  }

  async function onSaveProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const value = String(new FormData(form).get("name") ?? "");
    if (!value.trim()) {
      notify.error("The name field is required.");
      return;
    }
    const res = await postJson<unknown>("/v1/auth/profile", { displayName: value }, "PATCH");
    if (!res.ok) {
      notify.error(summarize(res.error.messages));
      return;
    }
    setMe({ ...me, user: { ...me.user, displayName: value } });
    form.firstElementChild?.classList.remove("is-dirty");
    notify.success("Profile updated.");
  }

  async function onChangePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const res = await postJson<{ status: string }>("/v1/auth/password/change", {
      current_password: form.get("current_password"),
      new_password: form.get("new_password"),
      new_password_confirmation: form.get("new_password_confirmation"),
    });
    if (!res.ok) {
      notify.error(summarize(res.error.messages));
      return;
    }
    notify.success(res.data.status);
    // Every session ended with the old password; the reload lands on /login.
    setTimeout(() => window.location.reload(), 1000);
  }

  return (
    <ProfileMarkup
      onSaveProfile={onSaveProfile}
      onProfileInput={onProfileInput}
      onChangePassword={onChangePassword}
      userInitial={initial(name)}
      userName={name}
      userEmail={me.user.email}
      teamName={me.team?.name ?? ""}
    />
  );
}

export function ProfilePage() {
  return (
    <Layout title="Profile" href="/profile" searchTitle="Search this page and everything (Press / or Ctrl+K, then Tab to switch)" portal={<ProfilePortalMarkup />}>
      <ProfileContent />
    </Layout>
  );
}
