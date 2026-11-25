// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Security/{CloudProviderTokenForm,CloudProviderTokens}.php,
// app/Livewire/Security/CloudProviderToken/Show.php and
// app/Livewire/Server/CloudProviderToken/Show.php (the Http calls) (Apache-2.0), modified.
//
// How Coolify asks a cloud provider whether a token works: one GET with the
// token as a Bearer credential, ten seconds at most, valid when the answer is
// 2xx. Coolify does it in three places with slightly different requests; each
// is kept as it is. The request goes through a ProviderHttp so that tests
// never touch the network.

export const CLOUD_PROVIDERS = ["hetzner", "digitalocean", "vultr", "hostinger"] as const;
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

/** One GET to a provider's API: whether the answer was 2xx (Laravel's $response->successful()). */
export type ProviderHttp = (url: string, headers: Record<string, string>) => Promise<{ ok: boolean }>;

/** Http::timeout(10)->get($url): fetch with a ten second limit. */
export const providerFetch: ProviderHttp = async (url, headers) => {
  const response = await fetch(url, { method: "GET", headers, signal: AbortSignal.timeout(10_000) });
  return { ok: response.ok };
};

/** The provider's display name; an unknown provider reads Hetzner, as Show::providerName() has it. */
export function providerName(provider: string): string {
  switch (provider) {
    case "digitalocean":
      return "DigitalOcean";
    case "vultr":
      return "Vultr";
    case "hostinger":
      return "Hostinger";
    default:
      return "Hetzner";
  }
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const bearerJson = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}`, Accept: "application/json" });

/** CloudProviderTokenForm::validateToken($provider, $token): a new token, before it is stored. Any failure is false. */
export async function validateNewToken(http: ProviderHttp, provider: string, token: string): Promise<boolean> {
  try {
    if (provider === "hetzner") return (await http("https://api.hetzner.cloud/v1/servers", bearer(token))).ok;
    if (provider === "digitalocean") return (await http("https://api.digitalocean.com/v2/account", bearerJson(token))).ok;
    if (provider === "vultr") return (await http("https://api.vultr.com/v2/account", bearer(token))).ok;
    if (provider === "hostinger") return (await http("https://developers.hostinger.com/api/vps/v1/virtual-machines", bearerJson(token))).ok;
    return false;
  } catch {
    return false;
  }
}

/**
 * CloudProviderTokens::validateToken / CloudProviderToken\Show::validateToken:
 * a stored token. Null for a provider Coolify does not know ('Unknown provider.').
 */
export async function validateStoredToken(http: ProviderHttp, provider: string, token: string): Promise<boolean | null> {
  try {
    if (provider === "hetzner") return (await http("https://api.hetzner.cloud/v1/servers?per_page=1", bearer(token))).ok;
    if (provider === "digitalocean") return (await http("https://api.digitalocean.com/v2/account", bearer(token))).ok;
    if (provider === "vultr") return (await http("https://api.vultr.com/v2/account", bearer(token))).ok;
    if (provider === "hostinger") return (await http("https://developers.hostinger.com/api/vps/v1/virtual-machines", bearerJson(token))).ok;
    return null;
  } catch {
    return false;
  }
}

/** Server\CloudProviderToken\Show::validationEndpoint($provider). */
export function validationEndpoint(provider: string): string {
  switch (provider) {
    case "vultr":
      return "https://api.vultr.com/v2/account";
    case "digitalocean":
      return "https://api.digitalocean.com/v2/account";
    case "hostinger":
      return "https://developers.hostinger.com/api/vps/v1/virtual-machines";
    default:
      return "https://api.hetzner.cloud/v1/servers";
  }
}

/** Server\CloudProviderToken\Show::validateToken(): the server's token against its provider. Throws what the request throws. */
export async function validateServerToken(http: ProviderHttp, provider: string, token: string): Promise<boolean> {
  return (await http(validationEndpoint(provider), bearer(token))).ok;
}

/** The provider ids of a server that the token must be able to read. */
export interface ServerCloudIds {
  hetznerServerId: string | null;
  vultrInstanceId: string | null;
  hostingerVirtualMachineId: string | null;
}

export const SERVER_TOKEN_MESSAGES = {
  invalid: "This token is invalid or has insufficient permissions.",
  hetznerNoAccess: "This token cannot access this server. It may belong to a different Hetzner project.",
  vultrNoAccess: "This token cannot access this instance. It may belong to a different Vultr account.",
  hostingerNoAccess: "This token cannot access this VPS. It may belong to a different Hostinger account.",
  failed: (reason: string) => `Failed to validate token: ${reason}`,
} as const;

/**
 * Server\CloudProviderToken\Show::validateTokenForServer(): the token works,
 * and it can read this very server at its provider. Null when valid, else
 * Coolify's error.
 */
export async function validateTokenForServer(http: ProviderHttp, provider: string, token: string, server: ServerCloudIds): Promise<string | null> {
  try {
    if (!(await http(validationEndpoint(provider), bearer(token))).ok) return SERVER_TOKEN_MESSAGES.invalid;
    if (server.hetznerServerId && !(await http(`https://api.hetzner.cloud/v1/servers/${server.hetznerServerId}`, bearer(token))).ok) {
      return SERVER_TOKEN_MESSAGES.hetznerNoAccess;
    }
    if (server.vultrInstanceId && !(await http(`https://api.vultr.com/v2/instances/${server.vultrInstanceId}`, bearer(token))).ok) {
      return SERVER_TOKEN_MESSAGES.vultrNoAccess;
    }
    if (
      server.hostingerVirtualMachineId &&
      !(await http(`https://developers.hostinger.com/api/vps/v1/virtual-machines/${server.hostingerVirtualMachineId}`, bearerJson(token))).ok
    ) {
      return SERVER_TOKEN_MESSAGES.hostingerNoAccess;
    }
    return null;
  } catch (e) {
    return SERVER_TOKEN_MESSAGES.failed(e instanceof Error ? e.message : String(e));
  }
}
