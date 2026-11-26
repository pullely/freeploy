// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Source/Gitlab/{Create,Change}.php,
// app/Livewire/Source/Gitea/{Create,Change}.php (updatingHtmlUrl, updatedHtmlUrl, selectProvider, getOAuthUrl,
// refreshRedirectUri) and resources/views/livewire/source/{gitlab,gitea}/change.blade.php (Apache-2.0), modified.
//
// What the GitLab and Gitea / Forgejo source pages (DP-103) compute in the browser: the API URL that follows the HTML URL
// while it is the derived one, Gitea's hosted providers, the instance's authorize link (getOAuthUrl(): PHP's
// http_build_query), and the console's redirect and webhook URLs.

export type OauthSourceKind = "gitlab" | "gitea";

const PROVIDER = {
  gitlab: { apiSuffix: "/api/v4", authorizePath: "/oauth/authorize", scope: "api read_user read_repository", applicationsPath: "/-/profile/applications" },
  gitea: { apiSuffix: "/api/v1", authorizePath: "/login/oauth/authorize", scope: "read:user read:repository read:organization", applicationsPath: "/user/settings/applications" },
} as const;

const rtrimSlash = (v: string): string => v.replace(/\/+$/, "");

/** gitlabApiUrlFromHtmlUrl() / giteaApiUrlFromHtmlUrl(). */
export const oauthApiUrlFromHtmlUrl = (kind: OauthSourceKind, htmlUrl: string): string => `${rtrimSlash(htmlUrl)}${PROVIDER[kind].apiSuffix}`;

/**
 * updatingHtmlUrl() then updatedHtmlUrl(): the API URL follows a new HTML URL while it is empty or the one derived from
 * the old HTML URL; otherwise it is kept.
 */
export function followHtmlUrl(kind: OauthSourceKind, previousHtmlUrl: string, apiUrl: string, htmlUrl: string): string {
  return apiUrl.trim() === "" || apiUrl === oauthApiUrlFromHtmlUrl(kind, previousHtmlUrl) ? oauthApiUrlFromHtmlUrl(kind, htmlUrl) : apiUrl;
}

/** Gitea's Create: the provider listbox, and the hosted instances its choice fills in (HOSTED_PROVIDERS). */
export const GITEA_PROVIDERS = [
  { value: "gitea.com", label: "Gitea.com" },
  { value: "codeberg.org", label: "Codeberg (Forgejo)" },
  { value: "self-hosted", label: "Self-hosted Gitea or Forgejo" },
] as const;
const HOSTED: Record<string, string> = { "gitea.com": "https://gitea.com", "codeberg.org": "https://codeberg.org" };

/** selectProvider(): a hosted provider fills in its URLs and the default SSH user and port; self-hosted changes nothing. */
export function selectGiteaProvider<T extends { html_url: string; api_url: string; custom_user: string; custom_port: string }>(provider: string, fields: T): T {
  const html = HOSTED[provider];
  if (!html) return fields;
  return { ...fields, html_url: html, api_url: oauthApiUrlFromHtmlUrl("gitea", html), custom_user: "git", custom_port: "22" };
}

/** PHP's urlencode(): RFC 1738, a space as "+", everything but letters, digits and "-_." escaped. */
export function phpUrlencode(value: string): string {
  return encodeURIComponent(value)
    .replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, "+");
}

/** http_build_query(): the pairs in order, a null value left out. */
export function httpBuildQuery(pairs: Array<[string, string | null]>): string {
  return pairs
    .filter((p): p is [string, string] => p[1] !== null)
    .map(([k, v]) => `${phpUrlencode(k)}=${phpUrlencode(v)}`)
    .join("&");
}

/** getOAuthUrl(): the instance's authorize page with the client id, the redirect URI, the scopes and the state. */
export function oauthAuthorizeUrl(kind: OauthSourceKind, o: { htmlUrl: string; clientId: string | null; redirectUri: string; state: string }): string {
  const query = httpBuildQuery([
    ["client_id", o.clientId],
    ["redirect_uri", o.redirectUri],
    ["response_type", "code"],
    ["scope", PROVIDER[kind].scope],
    ["state", o.state],
  ]);
  return `${rtrimSlash(o.htmlUrl)}${PROVIDER[kind].authorizePath}?${query}`;
}

/** Step 1's link: where the instance's OAuth applications are made. */
export const oauthApplicationsUrl = (kind: OauthSourceKind, htmlUrl: string): string => `${rtrimSlash(htmlUrl)}${PROVIDER[kind].applicationsPath}`;

/** The Webhook URL the page shows: api-edge's /webhooks/source/{kind}/events (Coolify's resolvePublicBaseUrl()). */
export const oauthWebhookUrl = (kind: OauthSourceKind, edgeOrigin: string): string => `${rtrimSlash(edgeOrigin)}/webhooks/source/${kind}/events`;
