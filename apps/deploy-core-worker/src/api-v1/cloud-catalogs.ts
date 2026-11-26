// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/HetznerController.php (locations, serverTypes, images,
// sshKeys, firewalls, networks), DigitalOceanController.php (digitalOceanToken, regions, sizes, images, sshKeys),
// VultrController.php (getVultrToken, regions, plans, operatingSystems, sshKeys) and HostingerController.php
// (providerData, rateLimitResponse, hostingerToken, dataCenters, catalog, templates, sshKeys, postInstallScripts)
// (Apache-2.0), modified.
//
// Coolify's /api/v1 for what a cloud provider offers (DP-90), read through one of the org's cloud provider tokens
// (cloud_provider_token_uuid, or the deprecated cloud_provider_token_id, in the query): the validator, the token of that
// provider ("… cloud provider token not found."), the view policy (a team admin's: policy-worker's write), then the
// provider's catalog through the context's fetch (cloud-providers.ts), answered as Coolify writes the decoded arrays,
// and each controller's own failure answers.
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { coolifyJson, obj, type CoolifyAnswer, type PhpValue } from "@saas/contracts/coolify-api";
import { queryAll, validationFailed, type Errors } from "./request.js";
import { validateRules } from "./rules.js";
import { message, type ApiV1Context } from "./context.js";
import { policyDenied, tokenRow, tokenSecret } from "./cloud-provider-tokens.js";
import {
  at,
  CloudProviderApiError,
  digitalOcean,
  digitalOceanClient,
  HostingerApiError,
  hetzner,
  hetznerClient,
  hostinger,
  hostingerClient,
  RateLimitError,
  vultr,
  vultrClient,
  type ProviderClient,
} from "./cloud-providers.js";

export type CloudProvider = "hetzner" | "digitalocean" | "vultr" | "hostinger";
const NAMES: Record<CloudProvider, string> = { hetzner: "Hetzner", digitalocean: "DigitalOcean", vultr: "Vultr", hostinger: "Hostinger" };

/** CloudProviderTokenController's token rules (required_without each other, string). */
export async function tokenRules(errors: Errors, all: Record<string, unknown>): Promise<void> {
  await validateRules(errors, all, [
    ["cloud_provider_token_uuid", [{ requiredWithout: "cloud_provider_token_id" }, "string"]],
    ["cloud_provider_token_id", [{ requiredWithout: "cloud_provider_token_uuid" }, "string"]],
  ]);
}

/** `$request->cloud_provider_token_uuid ?? $request->cloud_provider_token_id` */
export const requestedTokenUuid = (all: Record<string, unknown>): unknown => all.cloud_provider_token_uuid ?? all.cloud_provider_token_id ?? null;

/** The provider's token of the org, decrypted, after the view policy; or the answer that ends the request. */
export async function providerToken(tx: SqlExecutor, c: ApiV1Context, provider: CloudProvider, all: Record<string, unknown>): Promise<{ id: string; token: string } | { answer: CoolifyAnswer }> {
  const row = await tokenRow(tx, requestedTokenUuid(all), provider);
  if (!row) return { answer: message(`${NAMES[provider]} cloud provider token not found.`, 404) };
  // $this->authorize('view', $token): a team admin's.
  if (!(await c.allows(true))) return { answer: policyDenied() };
  return { id: String(row.find(([k]) => k === "id")?.[1]), token: await tokenSecret(tx, c, row) };
}

const HETZNER: Record<string, [string, (client: ProviderClient, c: ApiV1Context) => Promise<PhpValue>]> = {
  locations: ["locations", (client) => hetzner.locations(client)],
  "server-types": [
    "server types",
    (client, c) => {
      // $request->query('location')
      const location = queryAll(c.url).location;
      return hetzner.serverTypes(client, location === undefined || location === null ? null : String(location));
    },
  ],
  // Filter out deprecated images (same as UI): `type` other than system, or `deprecated` true.
  images: [
    "images",
    async (client) =>
      (await hetzner.images(client)).filter((image) => {
        const type = at(image, "type");
        if (type !== undefined && type !== null && type !== "system") return false;
        return at(image, "deprecated") !== true;
      }),
  ],
  "ssh-keys": ["SSH keys", (client) => hetzner.sshKeys(client)],
  firewalls: ["firewalls", (client) => hetzner.firewalls(client)],
  networks: ["networks", (client) => hetzner.networks(client)],
};
const DIGITALOCEAN: Record<string, [string, (client: ProviderClient) => Promise<PhpValue>]> = {
  regions: ["regions", digitalOcean.regions],
  sizes: ["sizes", digitalOcean.sizes],
  images: ["images", digitalOcean.images],
  "ssh-keys": ["SSH keys", digitalOcean.sshKeys],
};
const VULTR: Record<string, [string, (client: ProviderClient) => Promise<PhpValue>]> = {
  regions: ["regions", vultr.regions],
  plans: ["plans", vultr.plans],
  os: ["operating systems", vultr.operatingSystems],
  "ssh-keys": ["SSH keys", vultr.sshKeys],
};
const HOSTINGER: Record<string, [string, (client: ProviderClient) => Promise<PhpValue>]> = {
  "data-centers": ["data centers", hostinger.dataCenters],
  catalog: ["catalog", hostinger.catalog],
  templates: ["templates", hostinger.templates],
  "ssh-keys": ["SSH keys", hostinger.sshKeys],
  "post-install-scripts": ["post-install scripts", hostinger.postInstallScripts],
};

const own = <T>(table: Record<string, T>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

/** routes/api.php's GET /hetzner/*, /digitalocean/*, /vultr/*, /hostinger/* (one segment each); null for any other path. */
export async function cloudCatalogsApi(c: ApiV1Context, provider: CloudProvider, segments: string[]): Promise<CoolifyAnswer | null> {
  const [what, extra] = segments;
  if (what === undefined || extra !== undefined || c.method !== "GET") return null;
  const entry = provider === "hetzner" ? own(HETZNER, what) : provider === "digitalocean" ? own(DIGITALOCEAN, what) : provider === "vultr" ? own(VULTR, what) : own(HOSTINGER, what);
  if (!entry) return null;
  const [resource, read] = entry;
  const all = queryAll(c.url);
  const errors: Errors = [];
  // serverTypes() adds `location: nullable|string`; a query value is always a string.
  await tokenRules(errors, all);
  if (errors.length) return validationFailed(errors);
  const found = await c.sql(c.env, c.orgId, (tx) => providerToken(tx, c, provider, all));
  if ("answer" in found) return found.answer;
  const client =
    provider === "hetzner"
      ? hetznerClient(c.providers, found.token)
      : provider === "digitalocean"
        ? digitalOceanClient(c.providers, found.token)
        : provider === "vultr"
          ? vultrClient(c.providers, found.token)
          : hostingerClient(c.providers, found.token);
  try {
    return coolifyJson(await read(client, c));
  } catch (e) {
    return catalogFailure(provider, resource, e);
  }
}

/** Each controller's catch blocks. */
function catalogFailure(provider: CloudProvider, resource: string, e: unknown): CoolifyAnswer {
  if (provider === "hetzner") {
    const failure = `Failed to fetch Hetzner ${resource}.`;
    if (e instanceof CloudProviderApiError) return cloudProviderApiAnswer(e, failure);
    return message(failure, 500);
  }
  if (provider === "hostinger") {
    if (e instanceof RateLimitError) return rateLimitAnswer(e);
    const prefix = "Hostinger API error: ";
    if (e instanceof HostingerApiError && (e.code === 401 || e.code === 403) && e.message.startsWith(prefix)) {
      return message(`Hostinger denied access to ${resource}: ${e.message.slice(prefix.length)}`, 403);
    }
    return message(`Failed to fetch Hostinger ${resource}.`, 500);
  }
  return message(`Failed to fetch ${NAMES[provider]} ${resource}.`, 500);
}

/** CloudProviderApiException::toJsonResponse() */
export function cloudProviderApiAnswer(e: CloudProviderApiError, failure: string): CoolifyAnswer {
  return coolifyJson(obj({ message: `${failure} ${e.safeMessage()}`, provider_status: e.status, provider_error_code: e.errorCode }), 502);
}

/** rateLimitResponse(): 429, with Retry-After when the provider gave one. */
export function rateLimitAnswer(e: RateLimitError): CoolifyAnswer {
  return coolifyJson(obj({ message: e.message }), 429, { "retry-after": String(e.retryAfter) });
}
