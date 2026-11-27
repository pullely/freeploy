// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/HostingerController.php (createServer,
// hostingerToken, rateLimitResponse), app/Http/Controllers/Api/Concerns/RequiresDeployAbility.php,
// app/Services/HostingerService.php (purchaseVirtualMachine, findPurchasedVirtualMachine, setupPurchasedVirtualMachine,
// getVirtualMachine, getVirtualMachines, attachPublicKeys, waitForPublicIp, getPublicIpAddress), app/Models/Server.php
// (PLACEHOLDER_IP, the created hook) and app/Models/PrivateKey.php (getPublicKey) (Apache-2.0), modified.
//
// Coolify's POST /servers/hostinger (DP-93): a Hostinger VPS bought through one of the org's Hostinger tokens, then stored
// as a server with Coolify's placeholder IP until Hostinger gives it one. Hostinger is asked through DP-90's client (the
// context's fetch, HostingerService::request()'s retries and errors); the purchase's setup carries the private key's real
// public key. The server is stored as Server::create() stores it (the created hook's settings, default destination and
// predefined variables, then the proxy's status and type). Coolify then queues ValidateNewCloudServerJob, which works over
// SSH: Freeploy answers 501 in Coolify's envelope there, after the same purchase and the same rows (DP-70's convention).
// Server::serverLimitReached() is not checked: Freeploy has no server limit (as DP-78's POST /servers).
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { COOLIFY_API, coolifyJson, obj, type CoolifyAnswer, type PhpValue } from "@saas/contracts/coolify-api";
import { serverContext } from "../handlers/servers.js";
import { publicKeyOpenSSH } from "../keys/ssh-keys.js";
import { generateRandomName, newPublicId } from "../helpers/names.js";
import { hostnameError } from "../servers/ip.js";
import { PREDEFINED_SERVER_VARIABLE_KEYS } from "../servers/service.js";
import { decryptColumn, hasDeployAbility, message, rowsOf, unavailable, type ApiV1Context } from "./context.js";
import { rowValue } from "./models.js";
import { addError, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules } from "./rules.js";
import { providerToken, tokenRules } from "./cloud-catalogs.js";
import { at, blank, hostingerClient, HostingerApiError, phpValues, RateLimitError, type ProviderClient } from "./cloud-providers.js";

/** Server::PLACEHOLDER_IP */
export const PLACEHOLDER_IP = "1.2.3.4";

export const HOSTINGER_SERVER_MESSAGES = {
  scriptNeedsDeploy: "Missing required permissions: deploy. A post-install script or extra SSH keys run as root on the new server, so it needs a token with the deploy permission.",
  validateNeedsDeploy: "Missing required permissions: deploy. Instant validation installs Docker and starts the proxy on the new server, so it needs a token with the deploy permission.",
  /** Freeploy's: ValidateNewCloudServerJob installs Docker and the proxy over SSH. */
  validateUnavailable: "Validating the new server needs the SSH executor, which is not available yet.",
} as const;

const ALLOWED = ["cloud_provider_token_uuid", "cloud_provider_token_id", "item_id", "data_center_id", "template_id", "name", "private_key_uuid", "enable_backups", "public_key_ids", "post_install_script_id", "instant_validate"];

export const filled = (v: unknown): boolean => !(v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0));
/** $request->boolean() */
export const requestBool = (v: unknown): boolean => v === true || v === 1 || (typeof v === "string" && ["1", "true", "on", "yes"].includes(v.trim().toLowerCase()));
/** $request->integer(): intval() of the input. */
export const requestInt = (v: unknown): number => {
  if (typeof v === "number") return Math.trunc(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  const m = typeof v === "string" ? /^\s*[+-]?\d+/.exec(v) : null;
  return m ? Number(m[0]) : 0;
};
/** $request->array(): the input as an array (a scalar wrapped, null empty). */
export const requestArray = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : typeof v === "object" ? Object.values(v as Record<string, unknown>) : [v]);

/** createServer()'s customApiValidator() rules, then the fields not allowed. */
async function validate(all: Record<string, unknown>): Promise<Errors> {
  const errors: Errors = [];
  await tokenRules(errors, all);
  await validateRules(errors, all, [
    ["item_id", ["required", "string"]],
    ["data_center_id", ["required", "integer"]],
    ["template_id", ["required", "integer"]],
    [
      "name",
      [
        "nullable",
        "string",
        "max:253",
        {
          closure: async (v) => {
            if (typeof v !== "string") return [];
            const e = hostnameError("name", v);
            return e ? [e] : [];
          },
        },
      ],
    ],
    ["private_key_uuid", ["required", "string"]],
    ["enable_backups", ["nullable", "boolean"]],
    ["public_key_ids", ["nullable", "array"]],
    ["public_key_ids.*", ["integer"]],
    ["post_install_script_id", ["nullable", "integer"]],
    ["instant_validate", ["nullable", "boolean"]],
  ]);
  for (const k of Object.keys(all)) if (!ALLOWED.includes(k)) addError(errors, k, "This field is not allowed.");
  return errors;
}

/** HostingerService::getPublicIpAddress(): the first filled address, IPv4 first. */
export function publicIpOf(vm: PhpValue): string | null {
  for (const version of ["ipv4", "ipv6"]) {
    for (const ip of phpValues(at(vm, version))) {
      const address = at(ip, "address");
      if (!blank(address)) return String(address);
    }
  }
  return null;
}

const vmId = (vm: PhpValue): PhpValue | undefined => at(vm, "id");

/** HostingerService::purchaseVirtualMachine() */
export async function purchase(client: ProviderClient, itemId: unknown, setup: Array<[string, unknown]>): Promise<PhpValue> {
  // Hostinger accepts only a fully qualified hostname and uses its own default otherwise.
  const hostname = setup.find(([k]) => k === "hostname")?.[1];
  const finalSetup = typeof hostname === "string" && hostname.includes(".") ? setup : setup.filter(([k]) => k !== "hostname");
  const existing = phpValues(await client.request("get", "/api/vps/v1/virtual-machines")).map(vmId);
  let response: PhpValue;
  try {
    response = await client.request("post", "/api/vps/v1/virtual-machines", { item_id: itemId, setup: Object.fromEntries(finalSetup) });
  } catch (e) {
    // Hostinger can charge for the VPS before its setup fails, so keep the VPS if one was created.
    let bought: PhpValue | undefined;
    try {
      bought = phpValues(await client.request("get", "/api/vps/v1/virtual-machines")).find((x) => !existing.some((id) => id === vmId(x)));
    } catch {
      bought = undefined;
    }
    if (bought === undefined || bought === null) throw e;
    if (at(bought, "state") !== "initial") return bought;
    try {
      return await client.request("post", `/api/vps/v1/virtual-machines/${requestInt(vmId(bought))}/setup`, Object.fromEntries(finalSetup));
    } catch {
      return bought;
    }
  }
  const machine = at(response, "virtual_machine");
  const id = at(machine, "id");
  if (blank(id) || id === 0 || id === "0" || id === false) {
    const order = at(response, "id");
    throw new HostingerApiError(`Hostinger order ${order === undefined || order === null ? "unknown" : String(order)} is waiting for payment. Finish the VPS setup in hPanel.`, 202);
  }
  return machine!;
}

/** HostingerService::waitForPublicIp(): ten more looks, a second apart, while the VPS has no public IP. */
export async function waitForPublicIp(c: Pick<ApiV1Context, "providers">, client: ProviderClient, vm: PhpValue): Promise<PhpValue> {
  if (publicIpOf(vm) !== null || blank(vmId(vm))) return vm;
  let current = vm;
  for (let attempt = 0; attempt < 10; attempt++) {
    await c.providers.sleep(1000);
    current = await client.request("get", `/api/vps/v1/virtual-machines/${requestInt(vmId(current))}`);
    if (publicIpOf(current) !== null) return current;
  }
  return current;
}

/**
 * Team::createServerWithinLimit($teamId, [...]), then the proxy's status and type (DP-110: Hetzner's, Vultr's and
 * DigitalOcean's too): Server::create() — the created hook's settings, default destination and predefined variables — with
 * the provider's columns.
 */
export async function storeCloudServer(
  tx: SqlExecutor,
  c: { orgId: string; env: Pick<ApiV1Context["env"], "DEPLOY_ENCRYPTION_KEY"> },
  input: { name: string; ip: string; privateKeyId: string | number; columns: Array<[string, unknown]>; imageScanEnabled?: boolean },
) {
  const ctx = serverContext(tx, c.orgId, c.env);
  const server = await ctx.store.insert({
    uuid: newPublicId(),
    name: input.name,
    description: null,
    ip: input.ip,
    user: "root",
    port: 22,
    privateKeyId: input.privateKeyId,
    proxy: { redirect_enabled: true, status: "exited", type: "TRAEFIK" },
    serverRole: "both",
    // DP-118: the console's SetsImageScanning::applyImageScanning(); /api/v1 stores it off.
    imageScanEnabled: input.imageScanEnabled === true,
    defaultDestinationUuid: newPublicId(),
  });
  if (input.columns.length) await tx.execute(`UPDATE deploy.servers SET ${input.columns.map(([k], i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [server.id, ...input.columns.map(([, v]) => v)]);
  // The created hook's predefined server shared variables: the uuid and the name, both literal.
  const predefined: Record<(typeof PREDEFINED_SERVER_VARIABLE_KEYS)[number], string> = { COOLIFY_SERVER_UUID: server.uuid, COOLIFY_SERVER_NAME: server.name };
  for (const variable of PREDEFINED_SERVER_VARIABLE_KEYS) await ctx.store.addSharedVariable({ serverId: server.id, key: variable, value: await ctx.variables.encrypt(predefined[variable]), isLiteral: true });
  return server;
}

const orNull = (v: PhpValue | undefined): string | null => (v === undefined || v === null ? null : String(v));

async function storeServer(tx: SqlExecutor, c: ApiV1Context, input: { name: string; privateKeyId: string | number; tokenId: string; vmId: PhpValue | undefined; state: PhpValue | undefined }) {
  return storeCloudServer(tx, c, {
    name: input.name,
    ip: PLACEHOLDER_IP,
    privateKeyId: input.privateKeyId,
    columns: [
      ["cloud_provider_token_id", input.tokenId],
      ["hostinger_virtual_machine_id", orNull(input.vmId)],
      ["hostinger_virtual_machine_status", orNull(input.state)],
    ],
  });
}

/** HostingerController::createServer() */
export async function createHostingerServer(c: ApiV1Context): Promise<CoolifyAnswer> {
  // $this->authorize('create', [Server::class]): a team admin's.
  if (!(await c.allows(true))) return COOLIFY_API.unauthorized();
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const errors = await validate(all);
  if (errors.length) return validationFailed(errors);
  const publicKeyIds = requestArray(all.public_key_ids);
  if ((filled(all.post_install_script_id) || publicKeyIds.length > 0) && !hasDeployAbility(c)) return message(HOSTINGER_SERVER_MESSAGES.scriptNeedsDeploy, 403);
  const instantValidate = filled(all.instant_validate) ? requestBool(all.instant_validate) : hasDeployAbility(c);
  if (instantValidate && !hasDeployAbility(c)) return message(HOSTINGER_SERVER_MESSAGES.validateNeedsDeploy, 403);
  return c.sql(c.env, c.orgId, async (tx) => {
    const token = await providerToken(tx, c, "hostinger", all);
    if ("answer" in token) return token.answer;
    const key = (await rowsOf(tx)("private_keys", "t.uuid = $1", [String(all.private_key_uuid)]))[0];
    if (!key) return message("Private key not found.", 404);
    let virtualMachineId: number | null = null;
    try {
      const client = hostingerClient(c.providers, token.token);
      const name = (phpTruthy(all.name) ? String(all.name) : generateRandomName()).trim().toLowerCase();
      const pem = await decryptColumn(tx, c, "private_keys", "private_key", rowValue(key, "private_key"));
      let publicKey = "Error loading private key";
      try {
        if (pem !== null) publicKey = `${await publicKeyOpenSSH(pem)} `;
      } catch {
        publicKey = "Error loading private key";
      }
      const setup: Array<[string, unknown]> = [
        ["data_center_id", requestInt(all.data_center_id)],
        ["template_id", requestInt(all.template_id)],
        ["hostname", name],
        ["enable_backups", requestBool(all.enable_backups)],
        ["public_key", { name: String(rowValue(key, "name")), key: publicKey }],
      ];
      if (filled(all.post_install_script_id)) setup.push(["post_install_script_id", requestInt(all.post_install_script_id)]);
      let vm = await purchase(client, all.item_id, setup);
      virtualMachineId = requestInt(vmId(vm));
      const server = await storeServer(tx, c, { name, privateKeyId: rowValue(key, "id") as string | number, tokenId: token.id, vmId: vmId(vm), state: at(vm, "state") });
      let ip = PLACEHOLDER_IP;
      try {
        if (publicKeyIds.length > 0) await client.request("post", `/api/vps/v1/public-keys/attach/${virtualMachineId}`, { ids: publicKeyIds.map(requestInt) });
        vm = await waitForPublicIp(c, client, vm);
        const address = publicIpOf(vm);
        if (address !== null) {
          const state = at(vm, "state");
          await tx.execute("UPDATE deploy.servers SET ip = $2, hostinger_virtual_machine_status = COALESCE($3, hostinger_virtual_machine_status) WHERE id = $1", [server.id, address, state === undefined || state === null ? null : String(state)]);
          ip = address;
        }
      } catch {
        // report($e): the VPS keeps its placeholder IP; the server status check fills it in later.
      }
      // ValidateNewCloudServerJob::dispatch($server): over SSH.
      if (instantValidate) return unavailable(HOSTINGER_SERVER_MESSAGES.validateUnavailable);
      return coolifyJson(obj({ uuid: server.uuid, hostinger_virtual_machine_id: vmId(vm) ?? null, ip, provisioning: ip === PLACEHOLDER_IP }), 201);
    } catch (e) {
      if (e instanceof RateLimitError) return coolifyJson(obj({ message: e.message }), 429, { "retry-after": String(e.retryAfter) });
      if (e instanceof HostingerApiError && e.code === 202) return message(e.message, 202);
      if (!(e instanceof HostingerApiError)) throw e;
      return coolifyJson(obj({ message: virtualMachineId ? "The Hostinger VPS was purchased but could not be saved in Coolify. Manage it in hPanel." : "Failed to create Hostinger server.", ...(virtualMachineId ? { hostinger_virtual_machine_id: virtualMachineId } : {}) }), 500);
    }
  });
}

/** PHP's truthiness of a request value (`$request->name ?: …`). */
export function phpTruthy(v: unknown): boolean {
  return !(v === undefined || v === null || v === false || v === 0 || v === "" || v === "0" || (Array.isArray(v) && v.length === 0));
}

