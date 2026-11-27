// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/settings/updates.blade.php,
// resources/views/livewire/settings-email.blade.php, resources/views/livewire/settings-oauth.blade.php,
// resources/views/components/settings/layout.blade.php and app/Models/InstanceSettings.php (Apache-2.0), modified.
//
// The decisions of the platform's Updates, Email and Authentication pages (DP-101), apart from React: which
// callout a channel shows, which fields a provider has, the "Not active yet" notice, the settings pages Coolify
// lists, and the API paths.

/** The API of each page (deploy-core-worker handlers/platform-settings-more.ts). */
export const INSTANCE_SETTINGS_API = {
  updates: "/v1/platform/settings/updates",
  backup: "/v1/platform/settings/backup",
  email: "/v1/platform/settings/email",
  oauth: (provider: string | null) => (provider === null ? "/v1/platform/settings/oauth" : `/v1/platform/settings/oauth/${encodeURIComponent(provider)}`),
};

/** <x-settings.layout>'s $settingsMenuSections (Image Scanning since DP-116). */
export const SETTINGS_PAGES: Array<{ section: string; label: string; href: string; icon: string }> = [
  { section: "Configuration", label: "General", href: "/settings", icon: "settings" },
  { section: "Configuration", label: "Advanced", href: "/settings/advanced", icon: "grid" },
  { section: "Configuration", label: "Updates", href: "/settings/updates", icon: "refresh3" },
  { section: "Configuration", label: "Image Scanning", href: "/settings/image-scanning", icon: "shield-alert" },
  { section: "Instance", label: "Authentication", href: "/settings/oauth", icon: "keys" },
  { section: "Instance", label: "Email", href: "/settings/email", icon: "mail" },
  { section: "Instance", label: "Backup", href: "/settings/backup", icon: "database" },
];

// ── Updates ──────────────────────────────────────────────────────────────

export type UpdateChannel = "stable" | "preview" | "nightly" | "custom";

/** The Channel listbox's options. */
export const UPDATE_CHANNEL_OPTIONS: Array<{ value: UpdateChannel; label: string; description: string }> = [
  { value: "stable", label: "Stable", description: "Stable releases" },
  { value: "preview", label: "Preview", description: "Betas and release candidates, then the stable release" },
  { value: "nightly", label: "Nightly", description: "Early access to the next version, two builds each day. Less tested" },
  { value: "custom", label: "Custom image", description: "A pinned image, such as the build of a pull request" },
];

/** The callout under the channel (none for Preview). */
export function channelCallout(channel: string): { type: "info" | "danger"; title: string; body: string } | null {
  if (channel === "stable") return { type: "info", title: "Try the next version early", body: "The Nightly channel installs a build of the next version two times each day. Nightly builds get less testing and can break this instance." };
  if (channel === "nightly")
    return {
      type: "danger",
      title: "Nightly builds can break this instance",
      body: "Nightly builds are untested builds of the next version. Things can break at any time and breaking changes are possible, including database changes a stable release does not expect. Back up first and use nightly only on an instance you can rebuild. After switching back to stable, the instance keeps getting the nightlies of its version until that version is released as stable.",
    };
  if (channel === "custom")
    return {
      type: "danger",
      title: "A custom image can break this instance",
      body: "The image installs only when you upgrade to it here, and automatic updates pause until you switch back to a channel. Pull request builds are untested and can include database changes a later release does not expect.",
    };
  return null;
}

/** InstanceSettings::randomAutoUpdateFrequency(): what submit() puts in an empty Update frequency. */
export function randomAutoUpdateFrequency(random: () => number = Math.random): string {
  return `${Math.floor(random() * 60)} 0 * * *`;
}

/** submit()'s answer to an invalid frequency: the toast, and the value an empty field gets back. */
export function frequencyFallback(message: string, autoUpdateFrequency: string, updateCheckFrequency: string, random: () => number = Math.random): { auto_update_frequency?: string; update_check_frequency?: string } {
  if (message.includes("Auto Update Frequency") && autoUpdateFrequency === "") return { auto_update_frequency: randomAutoUpdateFrequency(random) };
  if (message.includes("Update Check Frequency") && updateCheckFrequency === "") return { update_check_frequency: "0 * * * *" };
  return {};
}

// ── Email ───────────────────────────────────────────────────────────────

export type EmailProvider = "none" | "smtp" | "resend";
export const EMAIL_PROVIDER_LABELS: Record<EmailProvider, string> = { none: "None", smtp: "SMTP", resend: "Resend" };

/** The "Not active yet" callout's text, when the selected provider is not the one that sends. */
export function notActiveYet(selected: EmailProvider, active: EmailProvider): string | null {
  if (selected === active) return null;
  const until = active === "none" ? "Until then, Freeploy does not send email." : `Until then, Freeploy sends email with ${EMAIL_PROVIDER_LABELS[active]}.`;
  return `Enter the ${EMAIL_PROVIDER_LABELS[selected]} settings and save. ${until}`;
}

/** SmtpPresets::PRESETS' hosts: the hosts whose username and password are required (requiresLogin()). */
const SMTP_PROVIDER_HOSTS = [
  "smtp.postshiba.com",
  "email-smtp.us-east-1.amazonaws.com",
  "smtp-relay.brevo.com",
  "smtp.gmail.com",
  "smtp.mailgun.org",
  "in-v3.mailjet.com",
  "smtp.office365.com",
  "smtp.postmarkapp.com",
  "smtp.protonmail.ch",
  "smtp.resend.com",
  "smtp.sendgrid.net",
  "smtp.zoho.com",
];
export const isProviderHost = (host: unknown): boolean => SMTP_PROVIDER_HOSTS.includes(String(host ?? "").trim().toLowerCase());

// ── Authentication ─────────────────────────────────────────────────────

/** Freeploy's OAuth callback (identity-worker), where Coolify's is /auth/{provider}/callback. */
export const oauthCallbackPath = (provider: string): string => `/v1/auth/oauth/${provider}/callback`;
/** oauth_default_redirect_uri(): the Redirect URI's placeholder. */
export const defaultRedirectUri = (apiBase: string, provider: string): string => `${apiBase.replace(/\/+$/, "")}${oauthCallbackPath(provider)}`;

export type OauthField = "redirect_uri" | "base_url" | "client_id" | "client_secret" | "scopes" | "clock_skew_seconds" | "custom_label" | "tenant";
export type OauthCheckbox = "allow_registration" | "require_email_verified" | "use_pkce" | "auto_join_root_team";

export interface OauthFieldSpec {
  field: OauthField;
  label: string;
  required?: boolean;
  type?: "text" | "password" | "number";
  helper?: string;
  placeholder?: string;
  wide?: boolean;
}

const OIDC_ISSUER_HELPER =
  "OpenID Provider issuer URL, for example https://example.okta.com. Freeploy uses it to discover the authorization, token, userinfo, and JWKS endpoints. For Microsoft Entra ID, use https://login.microsoftonline.com/<tenant ID>/v2.0 and add the optional ID token claims email and xms_edov to the app registration.";

/** The fields a provider's section shows, in the blade's order. */
export function oauthFields(provider: string): OauthFieldSpec[] {
  const fields: OauthFieldSpec[] =
    provider === "oidc"
      ? [
          { field: "redirect_uri", label: "Redirect URI" },
          { field: "base_url", label: "Issuer URL", required: true, helper: OIDC_ISSUER_HELPER },
          { field: "client_id", label: "Client ID", required: true },
          { field: "client_secret", label: "Client secret", required: true, type: "password" },
          { field: "scopes", label: "Scopes", helper: "Must include openid. Common scopes are openid email profile groups." },
          { field: "clock_skew_seconds", label: "Clock skew (seconds)", type: "number" },
          { field: "custom_label", label: "Login button label", placeholder: "Login with SSO", wide: true },
        ]
      : [
          { field: "redirect_uri", label: "Redirect URI" },
          { field: "client_id", label: "Client ID", required: true },
          { field: "client_secret", label: "Client secret", required: true, type: "password" },
        ];
  if (provider === "azure") fields.push({ field: "tenant", label: "Tenant", required: true });
  if (provider === "google")
    fields.push({
      field: "tenant",
      label: "Hosted domain",
      helper: "Optional Google Workspace domain, for example example.com. Only accounts from this domain can sign in. Use * to allow any Workspace account but no personal Google accounts.",
    });
  if (["authentik", "clerk", "zitadel", "gitlab"].includes(provider)) fields.push({ field: "base_url", label: "Base URL", required: provider === "authentik" || provider === "clerk" });
  return fields;
}

/** The checkboxes under a provider's fields. */
export function oauthCheckboxes(provider: string): Array<{ field: OauthCheckbox; label: string; helper?: string }> {
  const boxes: Array<{ field: OauthCheckbox; label: string; helper?: string }> = [];
  if (provider === "oidc") {
    boxes.push({ field: "allow_registration", label: "Allow OIDC user creation", helper: "Allow a successful OIDC login to create a user when password registration is disabled." });
    boxes.push({ field: "require_email_verified", label: "Require verified email" });
    boxes.push({ field: "use_pkce", label: "Use PKCE" });
  }
  boxes.push({ field: "auto_join_root_team", label: "Auto-join new users to Root team", helper: "Add newly-created OAuth users to the Root team as members without creating a personal team." });
  return boxes;
}

/** The Enable button's check in the browser: the provider's required fields, before toggleProvider(). */
export function missingRequired(provider: string, entry: Record<string, unknown>): OauthField | null {
  for (const f of oauthFields(provider)) if (f.required && String(entry[f.field] ?? "").trim() === "") return f.field;
  return null;
}
