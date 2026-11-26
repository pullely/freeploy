// Derived from coollabsio/coolify@91b7e3e:app/Http/Controllers/Api/ServerProxyController.php (saveConfiguration),
// app/Actions/Proxy/SaveProxyConfiguration.php (handle, ensureDefaultContainerName), app/Services/ProxyPortParser.php
// (fromConfiguration and what it calls) and bootstrap/helpers/shared.php (isBase64Encoded) (Apache-2.0), modified.
//
// Coolify's PUT /servers/{uuid}/proxy/configuration (DP-90): the deploy permission, validateIncomingRequest(), the
// validator, the server, the update policy, a base64 configuration decoded (UTF-8 only), a functional server, then
// SaveProxyConfiguration: ProxyPortParser's checks of the traefik and caddy services' published ports (the Compose file
// read as Symfony's Yaml::parse() with PARSE_CUSTOM_TAGS reads it: compose-yaml), the proxy's container_name, and the
// configuration's hash and text saved into the server's proxy. Coolify then writes the file on the server over SSH:
// Freeploy answers 501 there, after the save, as Coolify stored it first.
import { coolifyJson, obj, type CoolifyAnswer } from "@saas/contracts/coolify-api";
import { PhpArray, type PhpValue } from "../compose/php.js";
import { parseYamlWithCustomTags, TaggedValue, YamlParseError } from "../compose/yaml.js";
import { md5 } from "../helpers/docker.js";
import { encodeLabels, isBase64Encoded } from "../labels/custom-labels.js";
import { isIpv4, isIpv6 } from "../servers/ip.js";
import { decodeBase64Utf8 } from "./application-create.js";
import { policyDenied } from "./cloud-provider-tokens.js";
import { hasDeployAbility, message, unavailable, type ApiV1Context } from "./context.js";
import { extraFields, readApiBody, validationFailed, type Errors } from "./request.js";
import { validateRules } from "./rules.js";
import { findServer, functional, isSwarm, proxyOf, saveServer } from "./server-settings.js";

export const PROXY_CONFIGURATION_API_MESSAGES = {
  /** RequiresDeployAbility, with the controller's reason. */
  needsDeploy: "Missing required permissions: deploy. Coolify applies the proxy configuration on the server, so it needs a token with the deploy permission.",
  /** Freeploy: instant_remote_process() writing the file on the server needs the SSH executor. */
  writeUnavailable: "Writing the proxy configuration on the server is not available yet: it needs the SSH executor. The configuration is saved.",
} as const;

// ── ProxyPortParser ─────────────────────────────────────────────────────────

/** InvalidArgumentException */
class InvalidPorts extends Error {}

const INVALID = "Proxy ports must use Docker Compose port syntax with ports from 1 through 65535.";
const VARIABLE = /\$(?:\{[A-Za-z_][A-Za-z0-9_]*(?::?[-?+][^${}]*)?\}|[A-Za-z_][A-Za-z0-9_]*)/;
const VARIABLE_ALL = new RegExp(VARIABLE.source, "g");
const DEFAULT_ALL = /\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^${}]*)\}/g;
const SAFE_REMAINDER = /^[0-9A-Za-z.:[\]/-]*$/;

const invalid = (): never => {
  throw new InvalidPorts(INVALID);
};
const isInt = (v: unknown): v is number | bigint => (typeof v === "number" && Number.isInteger(v)) || typeof v === "bigint";
const isArray = (v: unknown): v is PhpArray => v instanceof PhpArray;

/** withoutTags() */
function withoutTags(v: PhpValue | TaggedValue): PhpValue {
  if (v instanceof TaggedValue) return withoutTags(v.value);
  if (isArray(v)) {
    const out = new PhpArray();
    for (const [k, x] of v) out.set(k, withoutTags(x as PhpValue | TaggedValue));
    return out;
  }
  return v;
}

/** data_get($array, 'a.b.c'): null when a segment is not there. */
function dataGet(v: PhpValue | TaggedValue | undefined, path: string): PhpValue | TaggedValue | null {
  let cur: PhpValue | TaggedValue | undefined = v;
  for (const seg of path.split(".")) {
    if (!isArray(cur) || !cur.has(seg)) return null;
    cur = cur.get(seg) as PhpValue | TaggedValue;
  }
  return cur ?? null;
}

const containsVariable = (v: string): boolean => VARIABLE.test(v);

function resolveDefaults(value: string): string | null {
  if (!SAFE_REMAINDER.test(value.replace(VARIABLE_ALL, ""))) invalid();
  const resolved = value.replace(DEFAULT_ALL, (_all, d: string) => d);
  return containsVariable(resolved) ? null : resolved;
}

function portNumber(port: unknown): number {
  if (isInt(port)) {
    if (port < 1 || port > 65535) invalid();
    return Number(port);
  }
  if (typeof port !== "string" || !/^\d+$/.test(port)) return invalid();
  const n = Number(port);
  if (n < 1 || n > 65535) invalid();
  return n;
}

function portOrRange(value: unknown): number | null {
  if (typeof value === "string") {
    const range = /^(\d+)-(\d+)$/.exec(value);
    if (range) {
      if (portNumber(range[1]) > portNumber(range[2])) invalid();
      return null;
    }
  }
  return portNumber(value);
}

function hostPort(host: string, container: string): number | null {
  portOrRange(container);
  return host === "" ? null : portOrRange(host);
}

function validateProtocol(protocol: unknown): void {
  // Docker Compose accepts the protocol in any letter case.
  if (protocol !== null && protocol !== undefined && (typeof protocol !== "string" || !["tcp", "udp", "sctp"].includes(protocol.toLowerCase()))) invalid();
}

/** filter_var($hostIp, FILTER_VALIDATE_IP) */
function validateHostIp(hostIp: unknown): void {
  if (typeof hostIp !== "string" || !(isIpv4(hostIp) || isIpv6(hostIp))) invalid();
}

/** resolveLongSyntaxVariables(): whether a variable stays unresolved; the port's fields resolved in place. */
function resolveLongSyntaxVariables(port: PhpArray): boolean {
  let unresolved = false;
  const validators: Array<[string, (v: string) => void]> = [
    ["target", (v) => void portOrRange(v)],
    ["published", (v) => void portOrRange(v)],
    ["host_ip", validateHostIp],
    ["protocol", validateProtocol],
  ];
  for (const [field, validate] of validators) {
    const value = port.get(field) ?? null;
    if (typeof value !== "string" || !containsVariable(value)) continue;
    const resolved = resolveDefaults(value);
    if (resolved !== null) {
      try {
        validate(resolved);
        port.set(field, resolved);
        continue;
      } catch (e) {
        if (!(e instanceof InvalidPorts)) throw e;
        // The variable may be set to a valid value when Docker Compose starts the proxy.
      }
    }
    unresolved = true;
    if (field === "target" || field === "published") port.set(field, 1);
    else port.delete(field);
  }
  return unresolved;
}

/** publishedPort(): throws for a port Docker Compose would refuse. */
function publishedPort(configured: PhpValue): number | null {
  if (typeof configured === "string" && containsVariable(configured)) {
    const resolved = resolveDefaults(configured);
    if (resolved === null) return null;
    try {
      return publishedPort(resolved);
    } catch (e) {
      if (e instanceof InvalidPorts) return null;
      throw e;
    }
  }
  if (isArray(configured)) {
    if (configured.isList() || !configured.has("target")) invalid();
    const port = configured.clone();
    const unresolved = resolveLongSyntaxVariables(port);
    validateProtocol(port.get("protocol") ?? null);
    if (port.has("host_ip")) validateHostIp(port.get("host_ip"));
    const target = portNumber(port.get("target"));
    const published = port.has("published") ? portOrRange(port.get("published")) : target;
    return unresolved ? null : published;
  }
  if (!isInt(configured) && typeof configured !== "string") return invalid();
  if (isInt(configured)) return portNumber(configured);
  let definition = configured;
  const slash = definition.lastIndexOf("/");
  if (slash !== -1) {
    validateProtocol(definition.slice(slash + 1));
    definition = definition.slice(0, slash);
  }
  // [HOST_IP:][HOST_PORT:]CONTAINER_PORT, where each port may be a range and an empty HOST_PORT after a host IP means a random host port.
  if (definition.startsWith("[")) {
    const m = /^\[([^\]]+)]:([^:]*):([^:]+)$/.exec(definition);
    if (!m) return invalid();
    validateHostIp(m[1]);
    return hostPort(m[2]!, m[3]!);
  }
  const parts = definition.split(":");
  if (parts.length > 3 || (parts.length > 1 && parts[0] === "")) invalid();
  if (parts.length === 3) validateHostIp(parts.shift());
  return parts.length === 1 ? portOrRange(parts[0]) : hostPort(parts[0]!, parts[1]!);
}

/** ProxyPortParser::fromConfiguration(): the configuration's message when Coolify refuses it, else null. */
export function proxyPortsError(configuration: string): string | null {
  let parsed: PhpValue;
  try {
    parsed = withoutTags(parseYamlWithCustomTags(configuration));
  } catch (e) {
    if (e instanceof YamlParseError) return "The proxy configuration must contain valid YAML.";
    throw e;
  }
  if (!isArray(parsed)) return null;
  try {
    const ports: PhpValue[] = [];
    for (const service of ["traefik", "caddy"]) {
      const configured = dataGet(parsed, `services.${service}.ports`);
      if (configured === null) continue;
      if (!isArray(configured) || !configured.isList()) invalid();
      ports.push(...(configured as PhpArray).values());
    }
    for (const port of ports) publishedPort(port);
    return null;
  } catch (e) {
    if (e instanceof InvalidPorts) return e.message;
    throw e;
  }
}

/** ensureDefaultContainerName(): the traefik or caddy service must be named coolify-proxy. */
export function containerNameError(configuration: string): string | null {
  const services = dataGet(parseYamlWithCustomTags(configuration), "services");
  for (const service of ["traefik", "caddy"]) {
    if (!isArray(services) || !services.has(service)) continue;
    let name = dataGet(services, `${service}.container_name`);
    if (name instanceof TaggedValue) name = name.value;
    if (name !== "coolify-proxy") return `The ${service} container_name must be coolify-proxy. Coolify uses this name to manage the proxy.`;
  }
  return null;
}

/** A ValidationException of the action: Laravel's JSON, the first message as the message. */
const validationException = (text: string): CoolifyAnswer => coolifyJson(obj({ message: text, errors: obj({ configuration: [text] }) }), 422);

// ── the route ───────────────────────────────────────────────────────────────

export async function saveProxyConfiguration(c: ApiV1Context, uuid: string): Promise<CoolifyAnswer> {
  if (!hasDeployAbility(c)) return message(PROXY_CONFIGURATION_API_MESSAGES.needsDeploy, 403);
  const body = await readApiBody(c.request);
  if (body.incomingError) return body.incomingError;
  const all = body.all;
  const errors: Errors = [];
  await validateRules(errors, all, [["configuration", ["required", "string"]]]);
  extraFields(errors, all, ["configuration"]);
  if (errors.length) return validationFailed(errors);
  return c.sql(c.env, c.orgId, async (tx) => {
    const f = await findServer(tx, uuid);
    if (!f) return message("Server not found.", 404);
    // $this->authorize('update', $server): a team admin's.
    if (!(await c.allows(true))) return policyDenied();
    let configuration = all.configuration as string;
    if (isBase64Encoded(configuration)) {
      const decoded = decodeBase64Utf8(configuration);
      if (decoded === null) return coolifyJson(obj({ message: "Validation failed.", errors: obj({ configuration: ["The configuration should be valid base64-encoded UTF-8 text."] }) }), 422);
      configuration = decoded;
    }
    // filled(trim($configuration))
    if (configuration.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "") === "") {
      return coolifyJson(obj({ message: "Validation failed.", errors: obj({ configuration: ["The configuration field is required."] }) }), 422);
    }
    if (!functional(f)) return message("Server is not functional.", 400);
    // SaveProxyConfiguration::handle()
    const portsError = proxyPortsError(configuration);
    if (portsError !== null) return validationException(portsError);
    if (!isSwarm(f)) {
      const nameError = containerNameError(configuration);
      if (nameError !== null) return validationException(nameError);
    }
    const proxy = proxyOf(f);
    proxy.last_saved_settings = md5(encodeLabels(configuration));
    proxy.last_saved_proxy_configuration = configuration;
    await saveServer(tx, f, { proxy });
    // instant_remote_process(): the file written on the server (with a backup of the previous one).
    return unavailable(PROXY_CONFIGURATION_API_MESSAGES.writeUnavailable);
  });
}
