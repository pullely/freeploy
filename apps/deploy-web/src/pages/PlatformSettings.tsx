// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/settings/{index,advanced}.blade.php,
// resources/views/components/settings/layout.blade.php and app/Livewire/Settings/{Index,Advanced}.php
// (Apache-2.0), modified.
//
// The platform's settings (freeploy-coolify-parity DP12), the platform operator's alone, in the Settings
// submenu of the sidebar (which only an operator has):
//   /settings           General (Settings\Index): the instance's Name
//   /settings/advanced  Advanced (Settings\Advanced): registration, destructive action confirmation,
//                       passkeys, DNS validation, sponsorship reminders
// Only the settings a hosted, multi-tenant Freeploy has are shown; the others are the edge's or the
// deployment's configuration, or have no meaning for a hosted service (IMPLEMENTATION-STATUS.md, Notes on
// DP12). Anyone else gets the API's 404 and this page Coolify's 404 page: a customer cannot tell it exists.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Layout } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { FormInput, Listbox, SettingsSection, SettingsSubsection, UnsavedBar } from "../components/Coolify";
import { PlatformNotFound } from "./PlatformAdmin";
import { SETTINGS_PAGES } from "../lib/instance-settings";

export interface PlatformSettings {
  instance_name: string | null;
  is_registration_enabled: boolean;
  disable_two_step_confirmation: boolean;
  is_passkey_enabled: boolean;
  is_dns_validation_enabled: boolean;
  is_sponsorship_popup_enabled: boolean;
}

export const PLATFORM_SETTINGS_API = "/v1/platform/settings";

/** <x-settings.layout>: the mobile title and the settings pages fed to the page search. */
export function SettingsLayout({ children }: { children: ReactNode }) {
  const origin = window.location.origin;
  // DP-101: the settings pages Freeploy has (Image Scanning is not ported).
  const pages: Array<[string, string]> = SETTINGS_PAGES.map((p) => [p.label, p.href]);
  const items = JSON.stringify(pages.map(([label, path]) => ({ label, breadcrumb: "Settings", search_text: `${label} Settings`, href: origin + path, navigate: true })));
  return (
    <section className="application-settings-workspace w-full max-w-none">
      <header className="settings-mobile-header xl:hidden">
        <h1 className="settings-mobile-title">Instance Settings</h1>
        <p className="settings-mobile-description">Configure global settings for this Freeploy instance.</p>
      </header>
      <div hidden data-settings-search-items={items} />
      <div className="min-w-0">{children}</div>
    </section>
  );
}

/** The settings, whether they can be saved, and a save: what both pages share. */
function usePlatformSettings() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [canUpdate, setCanUpdate] = useState(false);
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    void getJson<{ settings: PlatformSettings; canUpdate: boolean }>(PLATFORM_SETTINGS_API).then((r) => {
      if (!r.data) {
        if (r.status === 404) setMissing(true);
        else if (r.status !== 401) notify.error("Failed to load the settings.");
        return;
      }
      setSettings(r.data.settings);
      setCanUpdate(r.data.canUpdate);
    });
  }, []);
  /** instantSave() / submit(): the answer's toast, or the fields' errors. */
  const save = useCallback(async (section: "general" | "advanced", action: "submit" | "instantSave", values: Partial<PlatformSettings>): Promise<Record<string, string> | null> => {
    const r = await postJson<{ settings: PlatformSettings; message: string }>(PLATFORM_SETTINGS_API, { section, action, values }, "PATCH");
    if (!r.ok) {
      const inline: Record<string, string> = {};
      for (const [field, messages] of Object.entries(r.error.fields ?? {})) if (messages[0]) inline[field] = messages[0];
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return inline;
    }
    setSettings(r.data.settings);
    notify.success(r.data.message);
    return null;
  }, []);
  return { settings, canUpdate, missing, save };
}

// ── /settings ───────────────────────────────────────────────────────────

function SettingsGeneral() {
  const { settings, canUpdate, missing, save } = usePlatformSettings();
  const [name, setName] = useState("");
  const [saved, setSaved] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!settings) return;
    setName(settings.instance_name ?? "");
    setSaved(settings.instance_name ?? "");
  }, [settings]);
  const submit = useCallback(async () => {
    setSaving(true);
    const errs = await save("general", "submit", { instance_name: name === "" ? null : name });
    setSaving(false);
    setErrors(errs ?? {});
    if (!errs) setSaved(name);
  }, [name, save]);
  if (missing) return <PlatformNotFound />;
  if (!settings) return null;
  return (
    <SettingsLayout>
      <form
        className="application-settings-form flex w-full min-w-0 flex-col gap-6"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          if (canUpdate) void submit();
        }}
      >
        <UnsavedBar dirty={canUpdate && name !== saved} saving={saving} onSave={() => void submit()} />
        <SettingsSection title="General">
          <div className="grid gap-4 lg:grid-cols-2">
            <FormInput id="instance_name" label="Name" placeholder="Freeploy" helper="Custom name for this Freeploy instance." value={name} onChange={setName} disabled={!canUpdate} error={errors.instance_name} />
          </div>
        </SettingsSection>
      </form>
    </SettingsLayout>
  );
}

export function SettingsGeneralPage() {
  return (
    <Layout title="Settings" href="/settings">
      <SettingsGeneral />
    </Layout>
  );
}

// ── /settings/advanced ──────────────────────────────────────────────────

type Flag = "is_registration_enabled" | "disable_two_step_confirmation" | "is_passkey_enabled" | "is_dns_validation_enabled" | "is_sponsorship_popup_enabled";

const ENABLED = [
  { value: "true", label: "Enabled" },
  { value: "false", label: "Disabled" },
];

function SettingsAdvanced() {
  const { settings, canUpdate, missing, save } = usePlatformSettings();
  /** A listbox with onChange="instantSave": set the property, then save every setting of the page. */
  const instantSave = useCallback(
    (flag: Flag, value: string) => {
      if (!settings) return;
      const next = { ...settings, [flag]: value === "true" };
      void save("advanced", "instantSave", {
        is_registration_enabled: next.is_registration_enabled,
        disable_two_step_confirmation: next.disable_two_step_confirmation,
        is_passkey_enabled: next.is_passkey_enabled,
        is_dns_validation_enabled: next.is_dns_validation_enabled,
        is_sponsorship_popup_enabled: next.is_sponsorship_popup_enabled,
      });
    },
    [settings, save],
  );
  if (missing) return <PlatformNotFound />;
  if (!settings) return null;
  const flag = (f: Flag) => String(settings[f]);
  return (
    <SettingsLayout>
      <form className="application-settings-form flex min-w-0 flex-col gap-6" onSubmit={(e) => e.preventDefault()}>
        <SettingsSection id="access-section" title="Access and API">
          <div className="grid gap-4 lg:grid-cols-2">
            <Listbox
              id="is_registration_enabled"
              label="Registration"
              helper="Allow users to create their own account. When disabled, only administrators can create accounts."
              options={[
                { value: "true", label: "Anyone can register" },
                { value: "false", label: "Registration disabled" },
              ]}
              value={flag("is_registration_enabled")}
              onChange={(v) => instantSave("is_registration_enabled", v)}
              disabled={!canUpdate}
            />
            <Listbox
              id="disable_two_step_confirmation"
              label="Destructive action confirmation"
              helper="Choose whether destructive actions require password and text confirmation."
              options={[
                { value: "false", label: "Require two-step confirmation" },
                { value: "true", label: "Skip two-step confirmation" },
              ]}
              value={flag("disable_two_step_confirmation")}
              onChange={(v) => instantSave("disable_two_step_confirmation", v)}
              disabled={!canUpdate}
            />
            <Listbox
              id="is_passkey_enabled"
              label="Passkeys"
              helper="Let users sign in with a passkey. Passkeys need an HTTPS instance URL. Stored passkeys are kept when this is disabled."
              options={ENABLED}
              value={flag("is_passkey_enabled")}
              onChange={(v) => instantSave("is_passkey_enabled", v)}
              disabled={!canUpdate}
            />
          </div>
        </SettingsSection>

        <SettingsSection id="network-section" title="Network" helper="Domain validation and the internal targets that outbound requests may reach.">
          <SettingsSubsection first id="dns-section" title="DNS validation">
            <div className="grid gap-4 lg:grid-cols-2">
              <Listbox
                id="is_dns_validation_enabled"
                label="DNS validation"
                helper="Validate custom domains before deployment."
                options={ENABLED}
                value={flag("is_dns_validation_enabled")}
                onChange={(v) => instantSave("is_dns_validation_enabled", v)}
                disabled={!canUpdate}
              />
            </div>
          </SettingsSubsection>
        </SettingsSection>

        <SettingsSection id="interface-section" title="Interface and telemetry">
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Listbox
                id="is_sponsorship_popup_enabled"
                label="Sponsorship reminders"
                helper="Show the monthly project sponsorship reminder."
                options={ENABLED}
                value={flag("is_sponsorship_popup_enabled")}
                onChange={(v) => instantSave("is_sponsorship_popup_enabled", v)}
                disabled={!canUpdate}
              />
            </div>
          </div>
        </SettingsSection>
      </form>
    </SettingsLayout>
  );
}

export function SettingsAdvancedPage() {
  return (
    <Layout title="Advanced Settings" href="/settings/advanced">
      <SettingsAdvanced />
    </Layout>
  );
}
