// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/source/github/change.blade.php (createGithubApp)
// (Apache-2.0), modified.
//
// The GitHub App manifest "Register with GitHub" posts to GitHub: Coolify's permissions and events, with
// Freeploy's own URLs — the webhook on api-edge's public origin (/webhooks/source/github/events), and the two
// redirects GitHub sends the browser back with on deploy-web (/webhooks/source/github/redirect and /install, the
// pages that hand the code and the installation to the API).

export interface ManifestInput {
  /** The App's name as the page shows it (kebab-case). */
  name: string;
  organization: string | null;
  htmlUrl: string;
  /** The setup state the API made for this App. */
  state: string;
  /** deploy-web's origin. */
  webOrigin: string;
  /** api-edge's origin (edgeBase()). */
  edgeOrigin: string;
  previewDeploymentPermissions: boolean;
  deploymentStatusPermissions: boolean;
  administration: boolean;
}

export interface GithubManifest {
  /** Where the form posts: GitHub's "new App" page of the account or the organization, with the state. */
  action: string;
  manifest: {
    name: string;
    url: string;
    hook_attributes: { url: string; active: boolean };
    redirect_url: string;
    callback_urls: string[];
    public: boolean;
    request_oauth_on_install: boolean;
    setup_url: string;
    setup_on_update: boolean;
    default_permissions: Record<string, string>;
    default_events: string[];
  };
}

const trimSlashes = (value: string): string => value.replace(/\/+$/, "");

/** createGithubApp(): the manifest and the URL its form posts to. */
export function githubManifest(input: ManifestInput): GithubManifest {
  const webBase = trimSlashes(input.webOrigin);
  const webhooks = `${trimSlashes(input.edgeOrigin)}/webhooks`;
  const organization = input.organization ? encodeURIComponent(input.organization.replace(/^\/+|\/+$/g, "")) : "";
  const path = organization ? `organizations/${organization}/settings/apps/new` : "settings/apps/new";
  const permissions: Record<string, string> = { contents: "read", metadata: "read", emails: "read", administration: "read" };
  const events = ["push"];
  if (input.previewDeploymentPermissions) {
    permissions.pull_requests = "write";
    events.push("pull_request");
  }
  if (input.deploymentStatusPermissions) permissions.deployments = "write";
  if (input.administration) permissions.administration = "write";
  return {
    action: `${input.htmlUrl}/${path}?state=${input.state}`,
    manifest: {
      name: input.name,
      url: webBase,
      hook_attributes: { url: `${webhooks}/source/github/events`, active: true },
      redirect_url: `${webBase}/webhooks/source/github/redirect`,
      callback_urls: [`${webBase}/login/github/app`],
      public: false,
      request_oauth_on_install: false,
      setup_url: `${webBase}/webhooks/source/github/install`,
      setup_on_update: true,
      default_permissions: permissions,
      default_events: events,
    },
  };
}

/** The org a setup state names: the readable half of the API's signed state ("<base64url JSON>.<signature>"). */
export function setupStateOrg(state: string | null): string | null {
  if (!state) return null;
  const payload = state.split(".")[0] ?? "";
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (payload.length % 4)) % 4))) as { org?: unknown };
    return typeof json.org === "string" && /^org_[A-Za-z0-9]+$/.test(json.org) ? json.org : null;
  } catch {
    return null;
  }
}
