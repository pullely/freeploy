// Derived from coollabsio/coolify@91b7e3e:app/Livewire/SettingsOauth.php, app/Models/OauthSetting.php
// (couldBeEnabled, scopeList, isOidc) and Laravel's validation messages (lang/en/validation.php)
// (Apache-2.0 / MIT), modified.
//
// SettingsOauth (Authentication) as plain operations on the platform's deploy.oauth_settings rows and row 0's
// disable_registration_when_oauth_enabled (DP-101). The state is the component's oauth_settings_map, keyed by
// provider, loaded from the rows and overridden by what the page sends. Every rule, message and toast is
// Coolify's; Laravel's :attribute of oauth_settings_map.github.client_id is "oauth settings map.github.client id".
//
// The redirect URI must end with Freeploy's callback path, /v1/auth/oauth/{provider}/callback (identity-worker's),
// where Coolify's is its route('auth.callback'), /auth/{provider}/callback. The rows are stored, not yet read:
// identity-worker signs in with its own GitHub and Google configuration (DP-79).
import { NULLABLE, R, SettingsError, isTrue, validate, type Props, type Rule, type RuleList } from "../notifications/settings.js";

export const OAUTH_MESSAGES = {
  providerUpdated: (provider: string) => `OAuth settings for ${provider} updated successfully!`,
  instanceUpdated: "Instance settings updated successfully!",
  registrationUpdated: "Authentication settings updated successfully!",
  notComplete: (provider: string) => `OAuth settings are not complete for ${provider}.<br/>Please fill in all required fields.`,
  oidcScopes: "OIDC scopes must include 'openid'.",
  incomplete: (provider: string) => `OAuth settings are incomplete for '${provider}'. Required fields are missing. The provider has been disabled.`,
  oidcScopesDisabled: "OIDC scopes must include 'openid'. The provider has been disabled.",
  notFound: (provider: string) => `OAuth setting for ${provider} not found. It may have been deleted.`,
};

/** Freeploy's callback path: identity-worker's /v1/auth/oauth/{provider}/callback. */
export const oauthCallbackPath = (provider: string): string => `/v1/auth/oauth/${provider}/callback`;

/** One provider as the page holds it (oauthSettingToArray()), client_secret decrypted. */
export interface OauthEntry {
  id: string | number;
  provider: string;
  enabled: boolean;
  client_id: string | null;
  client_secret: string | null;
  redirect_uri: string | null;
  tenant: string | null;
  base_url: string | null;
  custom_label: string | null;
  scopes: string;
  allow_registration: boolean;
  auto_join_root_team: boolean;
  require_email_verified: boolean;
  use_pkce: boolean;
  clock_skew_seconds: number;
  label: string;
}

/** A stored row, client_secret decrypted. */
export type OauthRow = Omit<OauthEntry, "scopes" | "label"> & { scopes: string | null };

export interface OauthStore {
  list(): Promise<OauthRow[]>;
  /** $oauth->save(): the provider's filled columns (client_secret plaintext; the store encrypts). */
  save(provider: string, changes: Partial<OauthRow>): Promise<OauthRow | null>;
  loadRegistrationPolicy(): Promise<boolean>;
  saveRegistrationPolicy(value: boolean): Promise<void>;
}

/** providerLabel(). */
export function providerLabel(provider: string): string {
  if (provider === "oidc") return "OpenID Connect";
  if (provider === "gitlab") return "GitLab";
  // Str::headline(): words split on _ and -, each capitalised.
  return provider
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** oauthSettingToArray(). */
export function toEntry(row: OauthRow): OauthEntry {
  return {
    id: row.id,
    provider: row.provider,
    enabled: Boolean(row.enabled),
    client_id: row.client_id,
    client_secret: row.client_secret,
    redirect_uri: row.redirect_uri,
    tenant: row.tenant,
    base_url: row.base_url,
    custom_label: row.custom_label,
    scopes: row.scopes || "openid email profile",
    allow_registration: Boolean(row.allow_registration),
    auto_join_root_team: Boolean(row.auto_join_root_team),
    require_email_verified: row.require_email_verified ?? true,
    use_pkce: row.use_pkce ?? true,
    clock_skew_seconds: Number(row.clock_skew_seconds ?? 60),
    label: providerLabel(row.provider),
  };
}

/** mount()'s oauth_settings_map: OpenID Connect first, then by provider. */
export function oauthSettingsMap(rows: OauthRow[]): Record<string, OauthEntry> {
  const sorted = [...rows].sort((a, b) => {
    const ka = a.provider === "oidc" ? "" : a.provider;
    const kb = b.provider === "oidc" ? "" : b.provider;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return Object.fromEntries(sorted.map((r) => [r.provider, toEntry(r)]));
}

/** The page's view: the map, the client secrets only for who can update ("Hidden (only admins can view)"). */
export function oauthView(rows: OauthRow[], registrationPolicy: boolean, canUpdate: boolean): Props {
  const map = oauthSettingsMap(rows);
  if (!canUpdate) for (const e of Object.values(map)) e.client_secret = null;
  return { oauth_settings_map: map, disable_registration_when_oauth_enabled: registrationPolicy };
}

const filled = (v: unknown) => v !== null && v !== undefined && !(typeof v === "string" && v.trim() === "");

/** OauthSetting::couldBeEnabled(). */
export function couldBeEnabled(o: Pick<OauthRow, "provider" | "client_id" | "client_secret" | "tenant" | "base_url">): boolean {
  const base = filled(o.client_id) && filled(o.client_secret);
  if (o.provider === "azure") return base && filled(o.tenant);
  if (o.provider === "authentik" || o.provider === "clerk" || o.provider === "oidc") return base && filled(o.base_url);
  return base;
}

/** OauthSetting::scopeList(). */
export function scopeList(scopes: string | null): string[] {
  const list = [...new Set((scopes || "openid email profile").replace(/,/g, " ").split(" ").map((s) => s.trim()).filter(Boolean))];
  return list.length === 0 ? ["openid", "email", "profile"] : list;
}

const attr = (p: string) => p.replace(/_/g, " ");

/** Laravel's `url:http,https`. */
const url = (): Rule => ({
  check: (v, _s, p) => {
    if (typeof v !== "string") return `The ${attr(p)} field must be a valid URL.`;
    try {
      const u = new URL(v);
      return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "" && !/\s/.test(v) ? null : `The ${attr(p)} field must be a valid URL.`;
    } catch {
      return `The ${attr(p)} field must be a valid URL.`;
    }
  },
});
/** callbackPathRule(): the path, without a trailing slash, is the callback's. */
const callbackPath = (provider: string): Rule => ({
  check: (v) => {
    let path = "";
    try {
      path = new URL(String(v)).pathname;
    } catch {
      path = String(v).split(/[?#]/)[0] ?? "";
    }
    return path.replace(/\/+$/, "") === oauthCallbackPath(provider) ? null : `The redirect URI must end with ${oauthCallbackPath(provider)}.`;
  },
});
/** Laravel's `integer`. */
const integer = (): Rule => ({ check: (v, _s, p) => ((typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) ? null : `The ${attr(p)} field must be an integer.`) });

/** validationRules($provider): the map's keys, oauth_settings_map.{provider}.{field}. */
function validationRules(providers: string[], all: boolean): Record<string, RuleList> {
  const rules: Record<string, RuleList> = {};
  for (const p of providers) {
    const k = (f: string) => `oauth_settings_map.${p}.${f}`;
    rules[k("enabled")] = [R.required(), R.boolean()];
    rules[k("client_id")] = [NULLABLE, R.string()];
    rules[k("client_secret")] = [NULLABLE, R.string()];
    rules[k("redirect_uri")] = [NULLABLE, R.string(), R.maxString(2048), url(), callbackPath(p)];
    rules[k("tenant")] = [NULLABLE, R.string()];
    rules[k("base_url")] = [NULLABLE, R.string(), R.maxString(2048), url()];
    rules[k("custom_label")] = [NULLABLE, R.string(), R.maxString(255)];
    rules[k("scopes")] = [NULLABLE, R.string(), R.maxString(1000)];
    rules[k("allow_registration")] = [R.boolean()];
    rules[k("auto_join_root_team")] = [R.boolean()];
    rules[k("require_email_verified")] = [R.boolean()];
    rules[k("use_pkce")] = [R.boolean()];
    rules[k("clock_skew_seconds")] = [NULLABLE, integer(), R.minNumeric(0), R.maxNumeric(600)];
  }
  if (all) rules.disable_registration_when_oauth_enabled = [R.boolean()];
  return rules;
}

/** The map flattened to the validator's keys. */
function flatten(map: Record<string, Partial<OauthEntry>>, policy: unknown): Props {
  const state: Props = { disable_registration_when_oauth_enabled: policy };
  for (const [p, e] of Object.entries(map)) for (const [f, v] of Object.entries(e)) state[`oauth_settings_map.${p}.${f}`] = v;
  return state;
}

const nullableString = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
};
const raw = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** fillOauthSetting(): the columns $oauth->fill() sets (an empty client_secret is null, OauthSetting's mutator). */
export function fillOauthSetting(provider: string, data: Partial<OauthEntry>): Omit<OauthRow, "id"> {
  const secret = raw(data.client_secret);
  return {
    provider,
    enabled: isTrue(data.enabled ?? false),
    client_id: raw(data.client_id),
    client_secret: secret === "" ? null : secret,
    redirect_uri: nullableString(data.redirect_uri),
    tenant: raw(data.tenant),
    base_url: nullableString(data.base_url),
    custom_label: raw(data.custom_label),
    scopes: raw(data.scopes),
    allow_registration: isTrue(data.allow_registration ?? false),
    auto_join_root_team: isTrue(data.auto_join_root_team ?? false),
    require_email_verified: isTrue(data.require_email_verified ?? true),
    use_pkce: isTrue(data.use_pkce ?? true),
    // (int): PHP's integer cast of what the page sent.
    clock_skew_seconds: Math.trunc(Number.parseInt(String(data.clock_skew_seconds ?? 60), 10) || 0),
  };
}

const columns = (filledRow: Omit<OauthRow, "id">): Partial<OauthRow> => {
  const { provider: _provider, ...rest } = filledRow;
  void _provider;
  return rest;
};

export type OauthAction = "submit" | "toggleProvider" | "saveRegistrationPolicy";
export const isOauthAction = (a: unknown): a is OauthAction => a === "submit" || a === "toggleProvider" || a === "saveRegistrationPolicy";

export interface OauthResult {
  rows: OauthRow[];
  registrationPolicy: boolean;
  /** The success toast, if any. */
  message: string | null;
  /** An error toast besides it (submit() of every provider: the disabled ones). */
  error: string | null;
}

/** A failure with the state to show afterwards: handleError()'s toast, and the rows as they are now. */
export class OauthActionError extends SettingsError {}

/**
 * One of the page's actions. `selectedProvider` is the route's {provider} (null on /settings/oauth); `body` holds
 * oauth_settings_map (the page's map), disable_registration_when_oauth_enabled and, for toggleProvider, provider.
 */
export async function runOauthAction(store: OauthStore, action: OauthAction, selectedProvider: string | null, body: Props): Promise<OauthResult> {
  const rows = await store.list();
  const stored = oauthSettingsMap(rows);
  const sent = body.oauth_settings_map && typeof body.oauth_settings_map === "object" && !Array.isArray(body.oauth_settings_map) ? (body.oauth_settings_map as Record<string, Partial<OauthEntry>>) : {};
  // The page's map: the stored entries, with the page's fields over them (an unknown provider is no entry).
  const map: Record<string, Partial<OauthEntry>> = {};
  for (const [p, e] of Object.entries(stored)) {
    const over = sent[p] && typeof sent[p] === "object" ? sent[p] : {};
    map[p] = { ...e, ...over, id: e.id, provider: p };
  }
  const policy: unknown = "disable_registration_when_oauth_enabled" in body ? body.disable_registration_when_oauth_enabled : await store.loadRegistrationPolicy();
  const done = async (message: string | null, error: string | null = null): Promise<OauthResult> => ({ rows: await store.list(), registrationPolicy: await store.loadRegistrationPolicy(), message, error });

  /** updateOauthSettings($provider). */
  const update = async (provider: string | null): Promise<{ message: string | null; error: string | null }> => {
    validate(flatten(map, policy), validationRules(provider ? [provider] : Object.keys(map), provider === null));
    if (provider) {
      const filledRow = fillOauthSetting(provider, map[provider]!);
      // ensureProviderCanBeEnabled(): $oauth->update(['enabled' => false]) saves the filled model, then throws.
      if (filledRow.enabled && !couldBeEnabled(filledRow)) {
        await store.save(provider, { ...columns(filledRow), enabled: false });
        throw new OauthActionError(OAUTH_MESSAGES.notComplete(provider));
      }
      if (filledRow.enabled && provider === "oidc" && !scopeList(filledRow.scopes).includes("openid")) {
        await store.save(provider, { ...columns(filledRow), enabled: false });
        throw new OauthActionError(OAUTH_MESSAGES.oidcScopes);
      }
      const saved = await store.save(provider, columns(filledRow));
      if (!saved) throw new OauthActionError(OAUTH_MESSAGES.notFound(provider));
      return { message: OAUTH_MESSAGES.providerUpdated(provider), error: null };
    }
    const errors: string[] = [];
    for (const p of Object.keys(map)) {
      const filledRow = fillOauthSetting(p, map[p]!);
      if (filledRow.enabled && !couldBeEnabled(filledRow)) {
        filledRow.enabled = false;
        errors.push(OAUTH_MESSAGES.incomplete(p));
      }
      if (filledRow.enabled && p === "oidc" && !scopeList(filledRow.scopes).includes("openid")) {
        filledRow.enabled = false;
        errors.push(OAUTH_MESSAGES.oidcScopesDisabled);
      }
      const saved = await store.save(p, columns(filledRow));
      if (!saved) errors.push(`OAuth setting for provider '${p}' not found. It may have been deleted.`);
    }
    await store.saveRegistrationPolicy(isTrue(policy));
    return { message: null, error: errors.length ? errors.join("<br/>") : null };
  };

  switch (action) {
    case "saveRegistrationPolicy": {
      validate({ disable_registration_when_oauth_enabled: policy }, { disable_registration_when_oauth_enabled: [R.boolean()] });
      await store.saveRegistrationPolicy(isTrue(policy));
      return done(OAUTH_MESSAGES.registrationUpdated);
    }
    case "toggleProvider": {
      const provider = typeof body.provider === "string" ? body.provider : "";
      // abort(404)
      if (!Object.hasOwn(map, provider)) throw new SettingsError("Not found", 404);
      if (!isTrue(map[provider]!.enabled)) {
        // validateProviderCanBeEnabled()
        validate(flatten(map, policy), validationRules([provider], false));
        const candidate = fillOauthSetting(provider, { ...map[provider], enabled: true });
        if (!couldBeEnabled(candidate)) throw new OauthActionError(OAUTH_MESSAGES.notComplete(provider));
        if (provider === "oidc" && !scopeList(candidate.scopes).includes("openid")) throw new OauthActionError(OAUTH_MESSAGES.oidcScopes);
      }
      map[provider]!.enabled = !isTrue(map[provider]!.enabled);
      return done((await update(provider)).message);
    }
    case "submit": {
      if (selectedProvider !== null && !Object.hasOwn(map, selectedProvider)) throw new SettingsError("Not found", 404);
      const r = await update(selectedProvider);
      return done(selectedProvider === null ? OAUTH_MESSAGES.instanceUpdated : r.message, r.error);
    }
  }
}
