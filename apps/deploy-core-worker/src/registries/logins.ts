// Derived from coollabsio/coolify@91b7e3e:app/Services/DockerRegistryLogins.php and
// app/Livewire/Server/DockerRegistries/Login.php (PROVIDERS, providerFor) (Apache-2.0), modified.
//
// The parts of DockerRegistryLogins that need no server: registry names, the
// registry of an image, reading a Docker config's logins (names and usernames
// only), and the rows of a server's registries card. Its commands (docker
// login, the login check, docker logout, reading the config over SSH) are not
// here: they belong with the SSH executor.

/** DockerRegistryLogins::DOCKER_HUB */
export const DOCKER_HUB = "docker.io";

/**
 * DockerRegistryLogins::REGISTRY_PATTERN: a registry host with an optional
 * port; an IPv6 host is bracketed. Always applied to a normalized (trimmed)
 * name, so PCRE's `$` before a final newline makes no difference.
 */
export const REGISTRY_PATTERN = /^(?:[a-z0-9]([a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(:[0-9]{1,5})?$/;

/** PHP's trim(): space, \n, \r, \t, \v and NUL. */
const phpTrim = (value: string): string => value.replace(/^[ \n\r\t\v\0]+|[ \n\r\t\v\0]+$/g, "");
/** PHP 8's strtolower(): ASCII letters only. */
const asciiLower = (value: string): string => value.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** normalizeRegistry(): a config key such as "https://index.docker.io/v1/" as a registry host. */
export function normalizeRegistry(key: string): string {
  const host = asciiLower(phpTrim(key))
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split("/")[0]!;
  return ["index.docker.io", "registry-1.docker.io", "registry.hub.docker.com", "docker.io"].includes(host) ? DOCKER_HUB : host;
}

/**
 * registryFromImage(): Docker's own rule — the first path part is a registry
 * only if it has a dot or a port, or is "localhost".
 */
export function registryFromImage(image: string): string {
  const trimmed = phpTrim(image);
  if (trimmed === "" || !trimmed.includes("/")) return DOCKER_HUB;
  const first = trimmed.split("/")[0]!;
  return first.includes(".") || first.includes(":") || first === "localhost" ? normalizeRegistry(first) : DOCKER_HUB;
}

/** A registry a server is logged in to: where Docker keeps the credential, and the username when it can be read. */
export interface RegistryLogin {
  source: "auths" | "credHelpers";
  username: string | null;
}

/** PHP's is_array() of a decoded JSON value: an object or a list. */
const isArrayLike = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * PHP's base64_decode($value, true) as bytes: whitespace is skipped, any other
 * character outside the alphabet and a wrong padding fail.
 */
function base64DecodeStrict(value: string): Uint8Array | null {
  const m = /^([A-Za-z0-9+/]*)(={0,2})$/.exec(value.replace(/[ \t\n\r]/g, ""));
  if (!m) return null;
  const data = m[1]!;
  const padding = m[2]!;
  if (data.length % 4 === 1) return null;
  if (padding !== "" && (data.length + padding.length) % 4 !== 0) return null;
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}

/** usernameFromAuth(): Docker stores "username:password" base64 encoded in "auth"; only the username part is kept. */
function usernameFromAuth(entry: Record<string, unknown>): string | null {
  if (typeof entry.username === "string" && entry.username !== "") return entry.username;
  const decoded = typeof entry.auth === "string" ? base64DecodeStrict(entry.auth) : null;
  const colon = decoded ? decoded.indexOf(0x3a) : -1;
  // No colon, or nothing before it.
  if (!decoded || colon < 1) return null;
  try {
    // mb_check_encoding($username, 'UTF-8')
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decoded.subarray(0, colon));
  } catch {
    return null;
  }
}

/** PHP compares registry names byte by byte; they are ASCII, so code units give the same order. */
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * parseConfig(): the registries of a Docker config.json, by name — `auths`
 * before `credHelpers`, the first entry of a registry winning. The config
 * holds credentials: only registry names and usernames leave this function.
 */
export function parseConfig(config: string | null): Record<string, RegistryLogin> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(config ?? "");
  } catch {
    return {};
  }
  if (!isArrayLike(decoded)) return {};
  const found = new Map<string, RegistryLogin>();
  for (const source of ["auths", "credHelpers"] as const) {
    const entries = decoded[source];
    if (!isArrayLike(entries)) continue;
    for (const [key, entry] of Object.entries(entries)) {
      const registry = normalizeRegistry(key);
      if (REGISTRY_PATTERN.test(registry) && !found.has(registry)) {
        found.set(registry, { source, username: source === "auths" && isArrayLike(entry) ? usernameFromAuth(entry) : null });
      }
    }
  }
  // ksort()
  return Object.fromEntries([...found].sort(([a], [b]) => compare(a, b)));
}

/** A resource that pulls or pushes a named image, as the card lists it. */
export interface RegistryUser {
  /** Application, Database, Service or Build. */
  type: string;
  name: string;
  link: string | null;
}

export interface RegistryRow {
  registry: string;
  logged_in: boolean;
  source: "auths" | "credHelpers" | null;
  username: string | null;
  used_by: RegistryUser[];
}

/** rows(): the logins of a server with the registries its resources need, one row per registry, by name. */
export function registryRows(loggedIn: Record<string, RegistryLogin>, users: Array<RegistryUser & { registry: string }>): RegistryRow[] {
  const usedBy = new Map<string, RegistryUser[]>();
  for (const { registry, ...user } of users) usedBy.set(registry, [...(usedBy.get(registry) ?? []), user]);
  return [...new Set([...Object.keys(loggedIn), ...usedBy.keys()])].sort(compare).map((registry) => ({
    registry,
    logged_in: Object.hasOwn(loggedIn, registry),
    source: loggedIn[registry]?.source ?? null,
    username: loggedIn[registry]?.username ?? null,
    used_by: usedBy.get(registry) ?? [],
  }));
}

export interface RegistryProvider {
  label: string;
  /** The provider's one fixed host, or "" when the user types it. */
  registry: string;
  username: string;
  placeholder: string;
  hint: string;
  /** A provider with one host per region or account: what the typed host must match. */
  hostPattern?: RegExp;
}

/** Login::PROVIDERS. The patterns are applied to a normalized name, so `$` before a final newline makes no difference. */
export const PROVIDERS: Record<string, RegistryProvider> = {
  dockerhub: { label: "Docker Hub", registry: "docker.io", username: "", placeholder: "docker.io", hint: "Use your Docker Hub username and a personal access token." },
  ghcr: { label: "GitHub Container Registry", registry: "ghcr.io", username: "", placeholder: "ghcr.io", hint: "Use your GitHub username and a personal access token (classic) with the read:packages scope." },
  gitlab: { label: "GitLab Container Registry", registry: "registry.gitlab.com", username: "", placeholder: "registry.gitlab.com", hint: "Use a deploy token or a personal access token with the read_registry scope." },
  google: {
    label: "Google Artifact Registry",
    registry: "",
    username: "_json_key",
    placeholder: "europe-west1-docker.pkg.dev",
    hint: "Paste the JSON key of a service account with the Artifact Registry Reader role.",
    hostPattern: /(^|\.)gcr\.io$|-docker\.pkg\.dev$/,
  },
  azure: { label: "Azure Container Registry", registry: "", username: "", placeholder: "myregistry.azurecr.io", hint: "Use a service principal ID and secret, or a repository-scoped token.", hostPattern: /\.azurecr\.(io|cn|us)$/ },
  aws: {
    label: "AWS ECR",
    registry: "",
    username: "AWS",
    placeholder: "123456789012.dkr.ecr.eu-west-1.amazonaws.com",
    hint: "Paste the output of aws ecr get-login-password. This token expires after 12 hours.",
    hostPattern: /^[0-9]{12}\.dkr\.ecr(-fips)?\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/,
  },
  custom: { label: "Other", registry: "", username: "", placeholder: "registry.example.com", hint: "" },
};

/** Login::preset(): the provider's preset, "Other" for an unknown one. */
export function providerPreset(provider: unknown): RegistryProvider {
  return typeof provider === "string" && Object.hasOwn(PROVIDERS, provider) ? PROVIDERS[provider]! : PROVIDERS.custom!;
}

/** Login::providerFor(): the first provider whose host, or host pattern, a registry matches. */
export function providerFor(registry: string): string {
  for (const [key, preset] of Object.entries(PROVIDERS)) {
    if (preset.registry === registry || preset.hostPattern?.test(registry)) return key;
  }
  return "custom";
}
