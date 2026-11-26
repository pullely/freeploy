// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/HetznerController.php (createServer),
// app/Http/Controllers/Api/VultrController.php (createServer, deleteUntrackedInstance, findMatchingSshKey,
// normalizePublicKey, networkConfigurationErrorResponse), app/Http/Controllers/Api/DigitalOceanController.php (createServer,
// digitalOceanToken, deleteUntrackedDroplet, getOrCreateSshKey), app/Http/Controllers/Api/Concerns/RequiresDeployAbility.php,
// app/Services/HetznerService.php (uploadSshKey, createServer, enableServerBackup, deleteServer),
// app/Services/VultrService.php (uploadSshKey, createInstance, waitForPublicIp, getPublicIp, isUsableIp, getInstance,
// deleteInstance), app/Services/DigitalOceanService.php (uploadSshKey, createDroplet, getDroplet, waitForPublicIp,
// deleteDroplet, getPublicIpAddress), app/Models/PrivateKey.php (getPublicKey, generateMd5Fingerprint) and
// bootstrap/helpers/shared.php (hetznerServerIpv6) (Apache-2.0), modified.
//
// Coolify's POST /servers/hetzner, /servers/vultr and /servers/digitalocean (DP-110): a cloud server made through one of the
// org's provider tokens, then stored as a server, as DP-93's Hostinger one is. The providers are asked through DP-90's
// clients (the context's fetch, each service's retries and errors), the SSH key is the private key's real public key (found
// by its MD5 fingerprint — Hetzner, DigitalOcean — or its text — Vultr — before one is uploaded), and the server is stored
// as Team::createServerWithinLimit() stores it (storeCloudServer()). `cloud_init_script` is checked with ValidCloudInitYaml,
// Symfony's parse errors and all (DP-110's port). Coolify then queues ValidateNewCloudServerJob when `instant_validate` is
// on (a deploy token's default), which works over SSH: Freeploy answers 501 there, after the server was made and stored —
// what Coolify commits before it queues the job — so that a server the provider already bills for is never left untracked.
// Team::serverLimitReached() is not checked: Freeploy has no server limit (as DP-78's POST /servers and DP-93's Hostinger).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { COOLIFY_API, coolifyJson, obj, type CoolifyAnswer, type PhpValue } from "@saas/contracts/coolify-api";
import { fingerprintMd5, publicKeyOpenSSH } from "../keys/ssh-keys.js";
import { generateRandomName } from "../helpers/names.js";
import { hostnameError } from "../servers/ip.js";
import { decryptColumn, hasDeployAbility, message, rowsOf, unavailable, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import { addError, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules, type Rules } from "./rules.js";
import { cloudProviderApiAnswer, providerToken, rateLimitAnswer, tokenRules, type CloudProvider } from "./cloud-catalogs.js";
import { at, blank, CloudProviderApiError, dataGet, digitalOceanClient, digitalOcean, hetzner, hetznerClient, isPhpArray, phpValues, RateLimitError, vultr, vultrClient } from "./cloud-providers.js";
import { cloudInitYamlRule } from "./cloud-init-scripts.js";
import { HOSTINGER_SERVER_MESSAGES, PLACEHOLDER_IP, filled, phpTruthy, requestBool, storeCloudServer } from "./hostinger-servers.js";

export const CLOUD_SERVER_MESSAGES = {
  scriptNeedsDeploy: "Missing required permissions: deploy. A cloud-init script or extra SSH keys run as root on the new server, so it needs a token with the deploy permission.",
  validateNeedsDeploy: HOSTINGER_SERVER_MESSAGES.validateNeedsDeploy,
  /** Freeploy's: ValidateNewCloudServerJob installs Docker and the proxy over SSH. */
  validateUnavailable: HOSTINGER_SERVER_MESSAGES.validateUnavailable,
  protocols: "Enable at least one public IP protocol.",
  vultrIpv6: "Enable IPv6 when disabling public IPv4.",
} as const;

/** A PHP array read that PHP warns about (an undefined key, an offset of a non-array): Laravel's ErrorException, the catch-all's 500. */
class PhpWarning extends Error {}

/** `$array['key']`, as PHP reads it under Laravel's error handler. */
function need(v: PhpValue | undefined, key: string): PhpValue {
  const x = isPhpArray(v) ? at(v, key) : undefined;
  if (x === undefined) throw new PhpWarning(`Undefined array key "${key}"`);
  return x;
}

/** (int) of a PHP value. */
function phpInt(v: PhpValue | undefined): number {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string") {
    const m = /^\s*[+-]?\d+/.exec(v);
    return m ? Number(m[0]) : 0;
  }
  if (isPhpArray(v)) return phpValues(v).length ? 1 : 0;
  return 0;
}

/** (string) of a PHP scalar. */
const phpString = (v: PhpValue | undefined): string => (v === null || v === undefined || v === false ? "" : v === true ? "1" : String(v));

/** array_values(array_unique($ids)): the first of each value as a string compares. */
function unique<T>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = phpString(v as PhpValue);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** A request array field: its values, or [] (the controllers' defaults for null). */
const idsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as Record<string, unknown>) : []);

const nameRule = {
  closure: async (v: unknown) => {
    if (typeof v !== "string") return [];
    const e = hostnameError("name", v);
    return e ? [e] : [];
  },
};

/** The controller's customApiValidator(), then the fields not allowed. */
async function validate(all: Record<string, unknown>, rules: Rules, allowed: readonly string[]): Promise<Errors> {
  const errors: Errors = [];
  await tokenRules(errors, all);
  // Laravel puts the items of a `field.*` rule after the other attributes (ValidationRuleParser::explodeWildcardRules()).
  await validateRules(errors, all, [...rules.filter(([k]) => !k.includes("*")), ...rules.filter(([k]) => k.includes("*"))]);
  for (const k of Object.keys(all)) if (!allowed.includes(k)) addError(errors, k, "This field is not allowed.");
  return errors;
}

interface Prepared {
  token: { id: string; token: string };
  key: { id: string | number; name: string; publicKey: string; md5: string | null };
}

/** The provider's token (404, the view policy), then the private key ("Private key not found."), its public key and fingerprint. */
async function prepare(tx: SqlExecutor, c: ApiV1Context, provider: CloudProvider, all: Record<string, unknown>): Promise<Prepared | { answer: CoolifyAnswer }> {
  const token = await providerToken(tx, c, provider, all);
  if ("answer" in token) return token;
  const row = typeof all.private_key_uuid === "string" ? (await rowsOf(tx)("private_keys", "t.uuid = $1", [all.private_key_uuid]))[0] : undefined;
  if (!row) return { answer: message("Private key not found.", 404) };
  const pem = await decryptColumn(tx, c, "private_keys", "private_key", rowValue(row, "private_key"));
  // getPublicKey(): extractPublicKeyFromPrivate() ?? 'Error loading private key'
  let publicKey = "Error loading private key";
  try {
    if (pem !== null) publicKey = `${await publicKeyOpenSSH(pem)} `;
  } catch {
    publicKey = "Error loading private key";
  }
  let md5: string | null = null;
  try {
    md5 = pem === null ? null : await fingerprintMd5(pem);
  } catch {
    md5 = null;
  }
  return { token, key: { id: rowValue(row, "id") as string | number, name: String(rowValue(row, "name")), publicKey, md5 } };
}

/** The deploy permission the controllers ask for a script or extra keys, and for a validation; the instant_validate default. */
function deployChecks(c: ApiV1Context, all: Record<string, unknown>, extraKeys: string): { answer: CoolifyAnswer } | { instantValidate: boolean } {
  if ((phpTruthy(all.cloud_init_script) || idsOf(all[extraKeys]).length > 0) && !hasDeployAbility(c)) return { answer: message(CLOUD_SERVER_MESSAGES.scriptNeedsDeploy, 403) };
  const instantValidate = filled(all.instant_validate) ? requestBool(all.instant_validate) : hasDeployAbility(c);
  if (instantValidate && !hasDeployAbility(c)) return { answer: message(CLOUD_SERVER_MESSAGES.validateNeedsDeploy, 403) };
  return { instantValidate };
}

const errorAnswer = (e: unknown, failure: string): CoolifyAnswer | null => {
  if (e instanceof RateLimitError) return rateLimitAnswer(e);
  if (e instanceof CloudProviderApiError) return cloudProviderApiAnswer(e, failure);
  return null;
};

// ── Hetzner ───────────────────────────────────────────────────────────────

const HETZNER_ALLOWED = ["cloud_provider_token_uuid", "cloud_provider_token_id", "location", "server_type", "image", "name", "private_key_uuid", "enable_ipv4", "enable_ipv6", "enable_backups", "hetzner_ssh_key_ids", "hetzner_firewall_ids", "hetzner_network_ids", "cloud_init_script", "instant_validate"];

/** hetznerServerIpv6(): the network's first address (the prefix with ::1), or null. */
export function hetznerServerIpv6(network: PhpValue | undefined): string | null {
  if (blank(network)) return null;
  const text = phpString(network);
  const address = text.includes("/") ? text.slice(0, text.indexOf("/")) : text;
  const bytes = ipv6Bytes(address);
  if (bytes === null) return null;
  if (!text.includes("/")) return address;
  bytes[15] = bytes[15]! | 1;
  return formatIpv6(bytes);
}

/** inet_pton() of an IPv6 address (filter_var(…, FILTER_FLAG_IPV6)), or null. */
function ipv6Bytes(address: string): number[] | null {
  if (!/^[0-9a-fA-F:.]+$/.test(address) || !address.includes(":")) return null;
  let tail: number[] = [];
  let text = address;
  const v4 = /:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (v4) {
    const parts = v4[1]!.split(".").map(Number);
    if (parts.some((p) => p > 255)) return null;
    tail = parts;
    text = `${address.slice(0, v4.index)}:0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  if ([...head, ...rest].some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const fill = 8 - head.length - rest.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...rest].map((g) => Number.parseInt(g, 16));
  const bytes = all.flatMap((g) => [g >> 8, g & 0xff]);
  if (v4) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** inet_ntop() of 16 bytes: the longest run of two or more zero groups as "::", lowercase hex. */
function formatIpv6(bytes: number[]): string {
  const g: number[] = [];
  for (let i = 0; i < 16; i += 2) g.push((bytes[i]! << 8) | bytes[i + 1]!);
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (bestLen < 2) return hex.join(":");
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLen).join(":")}`;
}

/** HetznerController::createServer() */
export async function createHetznerServer(c: ApiV1Context): Promise<CoolifyAnswer> {
  // $this->authorize('create', [Server::class]): a team admin's.
  if (!(await c.allows(true))) return COOLIFY_API.unauthorized();
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const errors = await validate(
    all,
    [
      ["location", ["required", "string"]],
      ["server_type", ["required", "string"]],
      ["image", ["required", "integer"]],
      ["name", ["nullable", "string", "max:253", nameRule]],
      ["private_key_uuid", ["required", "string"]],
      ["enable_ipv4", ["nullable", "boolean"]],
      ["enable_ipv6", ["nullable", "boolean"]],
      ["enable_backups", ["nullable", "boolean"]],
      ["hetzner_ssh_key_ids", ["nullable", "array"]],
      ["hetzner_ssh_key_ids.*", ["integer"]],
      ["hetzner_firewall_ids", ["nullable", "array"]],
      ["hetzner_firewall_ids.*", ["integer"]],
      ["hetzner_network_ids", ["nullable", "array"]],
      ["hetzner_network_ids.*", ["integer"]],
      ["cloud_init_script", ["nullable", "string", cloudInitYamlRule("cloud init script")]],
      ["instant_validate", ["nullable", "boolean"]],
    ],
    HETZNER_ALLOWED,
  );
  if (errors.length) return validationFailed(errors);
  const checks = deployChecks(c, all, "hetzner_ssh_key_ids");
  if ("answer" in checks) return checks.answer;
  // The defaults: a generated name, both protocols, no backups, no extra keys, firewalls or networks.
  const name = phpTruthy(all.name) ? String(all.name) : generateRandomName();
  const enableIpv4 = all.enable_ipv4 ?? true;
  const enableIpv6 = all.enable_ipv6 ?? true;
  const enableBackups = all.enable_backups ?? false;
  if (!requestBool(enableIpv4) && !requestBool(enableIpv6)) {
    return coolifyJson(obj({ message: "Validation failed.", errors: obj({ enable_ipv4: [CLOUD_SERVER_MESSAGES.protocols], enable_ipv6: [CLOUD_SERVER_MESSAGES.protocols] }) }), 422);
  }
  return c.sql(c.env, c.orgId, async (tx) => {
    const ready = await prepare(tx, c, "hetzner", all);
    if ("answer" in ready) return ready.answer;
    const client = hetznerClient(c.providers, ready.token.token);
    let serverId: PhpValue | undefined;
    try {
      // The fingerprint finds a key Hetzner already has; otherwise the private key's public key is uploaded.
      let sshKeyId: PhpValue | undefined;
      for (const key of await hetzner.sshKeys(client)) {
        if (need(key, "fingerprint") === ready.key.md5) {
          sshKeyId = need(key, "id");
          break;
        }
      }
      if (sshKeyId === undefined) sshKeyId = need(at(await client.request("post", "/ssh_keys", { name: ready.key.name, public_key: ready.key.publicKey }), "ssh_key") ?? [], "id");
      // Normalize server name to lowercase for RFC 1123 compliance
      const serverName = name.trim().toLowerCase();
      const params: Record<string, unknown> = {
        name: serverName,
        server_type: all.server_type,
        image: all.image,
        location: all.location,
        start_after_create: true,
        ssh_keys: unique([sshKeyId, ...idsOf(all.hetzner_ssh_key_ids)]),
        public_net: { enable_ipv4: enableIpv4, enable_ipv6: enableIpv6 },
      };
      // array_map(function (int $firewallId) …): the ids as integers.
      const firewalls = unique(idsOf(all.hetzner_firewall_ids));
      if (firewalls.length) params.firewalls = firewalls.map((id) => ({ firewall: phpInt(id as PhpValue) }));
      const networks = unique(idsOf(all.hetzner_network_ids));
      if (networks.length) params.networks = networks;
      if (phpTruthy(all.cloud_init_script)) params.user_data = all.cloud_init_script;
      const server = at(await client.request("post", "/servers", params), "server") ?? [];
      serverId = isPhpArray(server) ? at(server, "id") : undefined;
      // The IP: IPv4 when enabled, else the IPv6 network's first address.
      let ip: string | null = null;
      const ipv4 = dataGet(server, "public_net.ipv4.ip");
      const ipv6 = dataGet(server, "public_net.ipv6.ip");
      if (phpTruthy(enableIpv4) && ipv4 !== undefined && ipv4 !== null) ip = phpString(ipv4);
      else if (phpTruthy(enableIpv6) && ipv6 !== undefined && ipv6 !== null) ip = hetznerServerIpv6(ipv6);
      if (!ip) throw new PhpWarning("No public IP address available. Enable at least one of IPv4 or IPv6.");
      const stored = await storeCloudServer(tx, c, {
        name: serverName,
        ip,
        privateKeyId: ready.key.id,
        columns: [
          ["cloud_provider_token_id", ready.token.id],
          ["hetzner_server_id", need(server, "id")],
          ["hetzner_server_status", at(server, "status") ?? null],
        ],
      });
      if (phpTruthy(enableBackups)) {
        try {
          await client.request("post", `/servers/${phpInt(need(server, "id"))}/actions/enable_backup`);
        } catch {
          // report($e)
        }
      }
      // ValidateNewCloudServerJob::dispatch($server): over SSH.
      if (checks.instantValidate) return unavailable(CLOUD_SERVER_MESSAGES.validateUnavailable);
      return coolifyJson(obj({ uuid: stored.uuid, hetzner_server_id: need(server, "id"), ip }), 201);
    } catch (e) {
      const answer = errorAnswer(e, "Failed to create Hetzner server.");
      if (answer) return answer;
      if (!(e instanceof PhpWarning) && !isUnexpected(e)) throw e;
      // report($e), then the Hetzner server deleted again when one was made.
      if (serverId !== undefined && serverId !== null) {
        try {
          await client.request("delete", `/servers/${phpInt(serverId)}`);
        } catch {
          // report($cleanupError)
        }
      }
      return message("Failed to create Hetzner server.", 500);
    }
  });
}

/** A Throwable the controllers' catch-all answers (a transfer error, a provider client's own error). */
const isUnexpected = (e: unknown): boolean => e instanceof Error;

// ── Vultr ─────────────────────────────────────────────────────────────────

const VULTR_ALLOWED = ["cloud_provider_token_uuid", "cloud_provider_token_id", "region", "plan", "os_id", "name", "private_key_uuid", "enable_ipv6", "disable_public_ipv4", "vultr_ssh_key_ids", "cloud_init_script", "instant_validate"];

/** VultrService::isUsableIp() */
const usableIp = (ip: PhpValue | undefined): boolean => !blank(ip) && ip !== "0.0.0.0" && ip !== "::";

/** VultrService::getPublicIp() */
function vultrPublicIp(instance: PhpValue | undefined, disablePublicIpv4: boolean, enableIpv6: boolean): string | null {
  const ipv4 = at(instance, "main_ip") ?? null;
  if (!disablePublicIpv4 && usableIp(ipv4)) return phpString(ipv4);
  const ipv6 = at(instance, "v6_main_ip") ?? null;
  if (enableIpv6 && usableIp(ipv6)) return phpString(ipv6);
  return null;
}

/** normalizePublicKey(): the key's type and data, without its comment. */
const normalizePublicKey = (key: string): string => key.trim().split(/\s+/).slice(0, 2).join(" ");

/** VultrController::createServer() */
export async function createVultrServer(c: ApiV1Context): Promise<CoolifyAnswer> {
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const errors = await validate(
    all,
    [
      ["region", ["required", "string"]],
      ["plan", ["required", "string"]],
      ["os_id", ["required", "integer"]],
      ["name", ["nullable", "string", "max:253", nameRule]],
      ["private_key_uuid", ["required", "string"]],
      ["enable_ipv6", ["nullable", "boolean"]],
      ["disable_public_ipv4", ["nullable", "boolean"]],
      ["vultr_ssh_key_ids", ["nullable", "array"]],
      ["vultr_ssh_key_ids.*", ["string"]],
      ["cloud_init_script", ["nullable", "string", cloudInitYamlRule("cloud init script")]],
      ["instant_validate", ["nullable", "boolean"]],
    ],
    VULTR_ALLOWED,
  );
  if (errors.length) return validationFailed(errors);
  const checks = deployChecks(c, all, "vultr_ssh_key_ids");
  if ("answer" in checks) return checks.answer;
  const name = phpTruthy(all.name) ? String(all.name) : generateRandomName();
  const enableIpv6 = all.enable_ipv6 ?? true;
  const disablePublicIpv4 = all.disable_public_ipv4 ?? false;
  if (phpTruthy(disablePublicIpv4) && !phpTruthy(enableIpv6)) {
    return coolifyJson(obj({ message: "Validation failed.", errors: obj({ enable_ipv6: [CLOUD_SERVER_MESSAGES.vultrIpv6] }) }), 422);
  }
  return c.sql(c.env, c.orgId, async (tx) => {
    const ready = await prepare(tx, c, "vultr", all);
    if ("answer" in ready) return ready.answer;
    const client = vultrClient(c.providers, ready.token.token);
    let instanceId: string | null = null;
    let stored = false;
    // deleteUntrackedInstance(): an instance Vultr made that no server row tracks.
    const deleteUntracked = async () => {
      if (!instanceId || stored) return;
      try {
        await client.request("delete", `/instances/${encodeRaw(instanceId)}`);
      } catch {
        // report($e)
      }
    };
    try {
      let sshKeyId: PhpValue | undefined;
      const wanted = normalizePublicKey(ready.key.publicKey);
      for (const key of await vultr.sshKeys(client)) {
        if (normalizePublicKey(phpString(at(key, "ssh_key") ?? "")) === wanted) {
          sshKeyId = need(key, "id");
          break;
        }
      }
      if (sshKeyId === undefined) sshKeyId = need(at(await client.request("post", "/ssh-keys", { name: ready.key.name, ssh_key: ready.key.publicKey }), "ssh_key") ?? [], "id");
      const serverName = name.trim().toLowerCase();
      const params: Record<string, unknown> = {
        region: all.region,
        plan: all.plan,
        os_id: all.os_id,
        label: serverName,
        hostname: serverName,
        sshkey_id: unique([sshKeyId, ...idsOf(all.vultr_ssh_key_ids)]),
        enable_ipv6: enableIpv6,
        disable_public_ipv4: disablePublicIpv4,
      };
      // createInstance(): the script base64-encoded.
      if (phpTruthy(all.cloud_init_script)) params.user_data = base64(String(all.cloud_init_script));
      let instance = at(await client.request("post", "/instances", params), "instance") ?? [];
      instanceId = phpString(need(instance, "id"));
      const server = await storeCloudServer(tx, c, {
        name: serverName,
        ip: vultrPublicIp(instance, phpTruthy(disablePublicIpv4), phpTruthy(enableIpv6)) ?? PLACEHOLDER_IP,
        privateKeyId: ready.key.id,
        columns: [
          ["cloud_provider_token_id", ready.token.id],
          ["vultr_instance_id", instanceId],
          ["vultr_instance_status", nullableString(at(instance, "status"))],
        ],
      });
      stored = true;
      let ip = server.ip;
      try {
        // waitForPublicIp(): six more looks, a second apart, while the instance has no usable address.
        if (vultrPublicIp(instance, phpTruthy(disablePublicIpv4), phpTruthy(enableIpv6)) === null && !blank(at(instance, "id"))) {
          for (let attempt = 0; attempt < 6; attempt++) {
            await c.providers.sleep(1000);
            instance = at(await client.request("get", `/instances/${encodeRaw(phpString(need(instance, "id")))}`), "instance") ?? [];
            if (vultrPublicIp(instance, phpTruthy(disablePublicIpv4), phpTruthy(enableIpv6)) !== null) break;
          }
        }
        const assigned = vultrPublicIp(instance, phpTruthy(disablePublicIpv4), phpTruthy(enableIpv6));
        if (assigned && assigned !== ip) {
          const status = at(instance, "status");
          await tx.execute("UPDATE deploy.servers SET ip = $2, vultr_instance_status = COALESCE($3, vultr_instance_status) WHERE id = $1", [server.id, assigned, nullableString(status)]);
          ip = assigned;
        }
      } catch {
        // report($e)
      }
      if (checks.instantValidate) return unavailable(CLOUD_SERVER_MESSAGES.validateUnavailable);
      return coolifyJson(obj({ uuid: server.uuid, vultr_instance_id: instanceId, ip }), 201);
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      await deleteUntracked();
      return errorAnswer(e, "Failed to create Vultr server.") ?? message("Failed to create Vultr server.", 500);
    }
  });
}

/** rawurlencode() */
const encodeRaw = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
const nullableString = (v: PhpValue | undefined): string | null => (v === undefined || v === null ? null : phpString(v));
/** base64_encode() of the UTF-8 text. */
const base64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

// ── DigitalOcean ──────────────────────────────────────────────────────────

const DIGITALOCEAN_ALLOWED = ["cloud_provider_token_uuid", "cloud_provider_token_id", "region", "size", "image", "name", "private_key_uuid", "enable_ipv6", "monitoring", "digitalocean_ssh_key_ids", "cloud_init_script", "instant_validate"];

/** DigitalOceanService::getPublicIpAddress(): the first public address with an ip_address, IPv4 first. */
function dropletPublicIp(droplet: PhpValue | undefined, enableIpv4: boolean, enableIpv6: boolean): string | null {
  for (const [version, enabled] of [["v4", enableIpv4], ["v6", enableIpv6]] as const) {
    if (!enabled) continue;
    for (const network of phpValues(dataGet(droplet, `networks.${version}`) ?? [])) {
      const address = at(network, "ip_address");
      if (at(network, "type") === "public" && !blank(address)) return phpString(address);
    }
  }
  return null;
}

/** $request->boolean($key, $default): the default only for a key the input does not have (null is false). */
const requestBoolOr = (all: Record<string, unknown>, key: string, fallback: boolean): boolean => (key in all ? requestBool(all[key]) : fallback);

/** DigitalOceanController::createServer() */
export async function createDigitalOceanServer(c: ApiV1Context): Promise<CoolifyAnswer> {
  // $this->authorize('create', [Server::class]): a team admin's.
  if (!(await c.allows(true))) return COOLIFY_API.unauthorized();
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const errors = await validate(
    all,
    [
      ["region", ["required", "string"]],
      ["size", ["required", "string"]],
      ["image", ["required"]],
      ["name", ["nullable", "string", "max:253", nameRule]],
      ["private_key_uuid", ["required", "string"]],
      ["enable_ipv6", ["nullable", "boolean"]],
      ["monitoring", ["nullable", "boolean"]],
      ["digitalocean_ssh_key_ids", ["nullable", "array"]],
      ["digitalocean_ssh_key_ids.*", ["integer"]],
      ["cloud_init_script", ["nullable", "string", cloudInitYamlRule("cloud init script")]],
      ["instant_validate", ["nullable", "boolean"]],
    ],
    DIGITALOCEAN_ALLOWED,
  );
  if (errors.length) return validationFailed(errors);
  const checks = deployChecks(c, all, "digitalocean_ssh_key_ids");
  if ("answer" in checks) return checks.answer;
  const name = phpTruthy(all.name) ? String(all.name) : generateRandomName();
  const enableIpv6 = requestBoolOr(all, "enable_ipv6", true);
  const monitoring = requestBoolOr(all, "monitoring", true);
  return c.sql(c.env, c.orgId, async (tx) => {
    const ready = await prepare(tx, c, "digitalocean", all);
    if ("answer" in ready) return ready.answer;
    const client = digitalOceanClient(c.providers, ready.token.token);
    let dropletId: number | null = null;
    let stored = false;
    try {
      // getOrCreateSshKey(): the key with the private key's MD5 fingerprint, or the public key uploaded.
      let sshKeyId: number | undefined;
      for (const key of await digitalOcean.sshKeys(client)) {
        if ((at(key, "fingerprint") ?? null) === ready.key.md5) {
          sshKeyId = phpInt(need(key, "id"));
          break;
        }
      }
      sshKeyId ??= phpInt(need(at(await client.request("post", "/account/keys", { name: ready.key.name, public_key: ready.key.publicKey }), "ssh_key") ?? [], "id"));
      const serverName = name.trim().toLowerCase();
      const params: Record<string, unknown> = {
        name: serverName,
        region: all.region,
        size: all.size,
        image: all.image,
        ssh_keys: unique([sshKeyId, ...idsOf(all.digitalocean_ssh_key_ids)]),
        ipv6: enableIpv6,
        monitoring,
      };
      if (phpTruthy(all.cloud_init_script)) params.user_data = all.cloud_init_script;
      let droplet = at(await client.request("post", "/droplets", params), "droplet") ?? [];
      dropletId = phpInt(need(droplet, "id"));
      const server = await storeCloudServer(tx, c, {
        name: serverName,
        ip: PLACEHOLDER_IP,
        privateKeyId: ready.key.id,
        columns: [
          ["cloud_provider_token_id", ready.token.id],
          ["digitalocean_droplet_id", dropletId],
          ["digitalocean_droplet_status", nullableString(at(droplet, "status"))],
        ],
      });
      stored = true;
      let ip = PLACEHOLDER_IP;
      try {
        // waitForPublicIp(): thirty more looks, a second apart, while the droplet has no public address.
        if (dropletPublicIp(droplet, true, enableIpv6) === null && !blank(at(droplet, "id"))) {
          for (let attempt = 0; attempt < 30; attempt++) {
            await c.providers.sleep(1000);
            droplet = at(await client.request("get", `/droplets/${phpInt(need(droplet, "id"))}`), "droplet") ?? [];
            if (dropletPublicIp(droplet, true, enableIpv6) !== null) break;
          }
        }
        const address = dropletPublicIp(droplet, true, enableIpv6);
        if (address) {
          await tx.execute("UPDATE deploy.servers SET ip = $2, digitalocean_droplet_status = COALESCE($3, digitalocean_droplet_status) WHERE id = $1", [server.id, address, nullableString(at(droplet, "status"))]);
          ip = address;
        }
      } catch {
        // report($e)
      }
      if (checks.instantValidate) return unavailable(CLOUD_SERVER_MESSAGES.validateUnavailable);
      return coolifyJson(obj({ uuid: server.uuid, digitalocean_droplet_id: dropletId, ip }), 201);
    } catch (e) {
      if (!(e instanceof Error)) throw e;
      // deleteUntrackedDroplet()
      if (dropletId && !stored) {
        try {
          await client.request("delete", `/droplets/${dropletId}`);
        } catch {
          // report($e)
        }
      }
      return errorAnswer(e, "Failed to create DigitalOcean server.") ?? message("Failed to create DigitalOcean server.", 500);
    }
  });
}
