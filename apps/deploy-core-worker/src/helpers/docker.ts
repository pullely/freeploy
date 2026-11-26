// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/docker.php (Apache-2.0), modified: TypeScript ports, byte-equal to Coolify's output (held by tools/parity/commands goldens).
//
// The PHP builtins these helpers rely on (escapeshellarg, md5, trim, (int),
// (string), version_compare, json_decode) are ported below with the semantics
// that affect output. Files under helpers/ do not import each other: the parity
// harness runs them with Node's type stripping, which needs `.ts` specifiers,
// while the worker's tsconfig only accepts `.js` ones.

// ---------------------------------------------------------------------------
// PHP builtins
// ---------------------------------------------------------------------------

/** PHP's escapeshellarg() on Linux: single-quote, `'` becomes `'\''`. PHP 8 throws on a NUL byte. */
function escapeshellarg(value: string): string {
  if (value.includes("\0")) {
    throw new Error("escapeshellarg(): Argument #1 ($arg) must not contain any null bytes");
  }
  return "'" + value.split("'").join("'\\''") + "'";
}

/** PHP's trim() with its default character list (" \t\n\r\0\x0B"), not JavaScript's Unicode whitespace. */
function phpTrim(value: string, chars = " \t\n\r\0\x0B"): string {
  let start = 0;
  let end = value.length;
  while (start < end && chars.includes(value.charAt(start))) start++;
  while (end > start && chars.includes(value.charAt(end - 1))) end--;
  return value.slice(start, end);
}

function phpRtrim(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value.charAt(end - 1))) end--;
  return value.slice(0, end);
}

const PHP_INT_MAX = 9223372036854775807n;

/** (int) of an ASCII digit string, saturating at PHP_INT_MAX like PHP's strtol-based cast. */
function phpIntFromDigits(digits: string | undefined): bigint {
  if (digits === undefined || digits === "") return 0n;
  const n = BigInt(digits);
  return n > PHP_INT_MAX ? PHP_INT_MAX : n;
}

/** (string) of a float under PHP's default `precision` (14): "0.1", "1.0E+25", "-0", "INF". */
function phpFloatToString(value: number): string {
  if (Number.isNaN(value)) return "NAN";
  if (value === Infinity) return "INF";
  if (value === -Infinity) return "-INF";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const sign = value < 0 ? "-" : "";
  const [mantissa = "0", exp = "0"] = Math.abs(value).toExponential(13).split("e");
  const exponent = Number(exp);
  const digits = mantissa.replace(".", "").replace(/0+$/, "") || "0";
  if (exponent < -4 || exponent >= 14) {
    const frac = digits.length > 1 ? digits.slice(1) : "0";
    return `${sign}${digits.charAt(0)}.${frac}E${exponent < 0 ? "-" : "+"}${Math.abs(exponent)}`;
  }
  if (exponent < 0) return `${sign}0.${"0".repeat(-exponent - 1)}${digits}`;
  if (digits.length <= exponent + 1) return `${sign}${digits}${"0".repeat(exponent + 1 - digits.length)}`;
  return `${sign}${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`;
}

/** PHP's (string) cast of a JSON-decodable value. Arrays (and decoded objects) become "Array". */
function phpToString(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (value === true) return "1";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : phpFloatToString(value);
  if (typeof value === "bigint") return value.toString();
  return "Array";
}

/** A PHP array as decoded from JSON: a list or an associative array (a plain object). */
function isPhpArray(value: unknown): value is unknown[] | Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function phpArrayValues(value: unknown[] | Record<string, unknown>): unknown[] {
  return Array.isArray(value) ? value : Object.values(value);
}

/** `$array[$key] ?? null` / data_get($array, $key) for a key without dots. */
function phpArrayGet(value: unknown, key: string): unknown {
  if (!isPhpArray(value) || Array.isArray(value)) return null;
  return Object.prototype.hasOwnProperty.call(value, key) ? (value[key] ?? null) : null;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** json_decode($raw, true): null where PHP's decoder fails (syntax, unpaired surrogates, depth > 512). */
function phpJsonDecode(raw: string): unknown {
  if (LONE_SURROGATE.test(raw)) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const valid = (v: unknown, depth: number): boolean => {
    if (typeof v === "string") return !LONE_SURROGATE.test(v);
    if (!isPhpArray(v)) return true;
    if (depth + 1 > 512) return false;
    if (Array.isArray(v)) return v.every((item) => valid(item, depth + 1));
    return Object.entries(v).every(([k, item]) => !LONE_SURROGATE.test(k) && valid(item, depth + 1));
  };
  return valid(decoded, 0) ? decoded : null;
}

/** PHP's md5() over the UTF-8 bytes of the string, as lowercase hex. Pure TypeScript, so it runs in Workers. */
export function md5(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const length = bytes.length;
  const blocks = ((length + 8) >>> 6) + 1;
  const words = new Uint32Array(blocks * 16);
  for (let i = 0; i < length; i++) words[i >>> 2]! |= bytes[i]! << ((i % 4) * 8);
  words[length >>> 2]! |= 0x80 << ((length % 4) * 8);
  words[blocks * 16 - 2] = (length * 8) >>> 0;
  words[blocks * 16 - 1] = Math.floor(length / 0x20000000);
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  for (let block = 0; block < blocks; block++) {
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + K[i]! + words[block * 16 + g]!) >>> 0;
      const s = S[(i >>> 4) * 4 + (i % 4)]!;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  let hex = "";
  for (const word of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i++) hex += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

// ---------------------------------------------------------------------------
// bootstrap/helpers/docker.php
// ---------------------------------------------------------------------------

export function traefikServiceNameHash(serviceName: string): string {
  return md5(serviceName).slice(0, 4);
}

export function traefikSafeServiceNameSegment(serviceName: string): string {
  let normalized = serviceName.split(".").join("-").split("_").join("-");
  normalized = normalized.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/-+/g, "-");
  normalized = phpTrim(normalized, "-");
  if (normalized === "") normalized = "service";
  return normalized + "-" + traefikServiceNameHash(serviceName);
}

export function caddyTrafficAppKey(uuid: string, serviceName: string | null = null): string {
  // PHP truthiness: null, "" and "0" are false.
  const key = serviceName !== null && serviceName !== "" && serviceName !== "0" ? uuid + "-" + traefikSafeServiceNameSegment(serviceName) : uuid;
  return key.replace(/[^A-Za-z0-9-]+/g, "-");
}

export type OwnerType = "application" | "service" | "database";

export function dockerPsByOwnerCommands(
  type: OwnerType | string,
  uuid: string,
  extraFilters: string[] = [],
  format = "{{json .}}",
  all = true,
  legacyExtraFilters: string[] | null = null,
): string[] {
  const filters = (values: string[]): string => values.map((filter) => "--filter " + escapeshellarg(filter)).join(" ");
  const base = "docker ps" + (all ? " -a" : "");
  const formatArgument = "--format " + escapeshellarg(format);
  const legacyFilters = legacyExtraFilters ?? extraFilters;
  const commands = [
    base + " " + filters([`label=coolify.${type}Uuid=${uuid}`, ...extraFilters]) + " " + formatArgument,
    base + " " + filters([`label=coolify.${type}Id`, `label=com.docker.compose.project=${uuid}`, ...legacyFilters]) + " " + formatArgument,
  ];
  if (type === "application") {
    commands.push(base + " " + filters(["label=coolify.applicationId", `name=${uuid}`, ...legacyFilters]) + " " + formatArgument);
  }
  return commands;
}

export function containerIdsByOwnerScript(
  type: OwnerType | string,
  uuid: string,
  extraFilters: string[] = [],
  all = true,
  legacyExtraFilters: string[] | null = null,
): string {
  const commands = dockerPsByOwnerCommands(type, uuid, extraFilters, "{{.ID}}", all, legacyExtraFilters);
  return "container_ids=$({ " + commands.join("; ") + "; } | sort -u)";
}

/** Parsed "major.minor.patch" parts of a normalized version, or null. */
function dockerEngineVersionParts(rawVersion: string | null): [bigint, bigint, bigint] | null {
  if (rawVersion === null || phpTrim(rawVersion) === "") return null;
  const match = /\d+\.\d+(?:\.\d+)?/.exec(rawVersion);
  if (match === null) return null;
  const parts = match[0].split(".");
  return [phpIntFromDigits(parts[0]), phpIntFromDigits(parts[1]), phpIntFromDigits(parts[2])];
}

export function parseDockerEngineVersion(rawVersion: string | null): string | null {
  const parts = dockerEngineVersionParts(rawVersion);
  return parts === null ? null : parts.map((p) => p.toString()).join(".");
}

export function dockerEngineVersionFromJson(raw: string | null): string | null {
  if (raw === null || phpTrim(raw) === "") return null;
  const decoded = phpJsonDecode(raw);
  if (!isPhpArray(decoded)) return null;
  const version = phpArrayGet(phpArrayGet(decoded, "Server"), "Version");
  return typeof version === "string" ? parseDockerEngineVersion(version) : null;
}

export function dockerStopTimeoutOption(dockerVersion: string | null): string {
  // parseDockerEngineVersion() then version_compare($normalized, '28.0.0', '>=').
  const parts = dockerEngineVersionParts(dockerVersion);
  if (parts !== null) {
    const [major, minor, patch] = parts;
    const newer = major !== 28n ? major > 28n : minor !== 0n ? minor > 0n : patch >= 0n;
    if (newer) return "--timeout";
  }
  return "--time";
}

/** The PHP version also accepts a Server model (its dockerVersion()); only the version string is ported. */
export function dockerStopCommand(timeout: number, containers: string, dockerVersion: string | null = null): string {
  const option = dockerStopTimeoutOption(dockerVersion);
  const flag = option === "--timeout" ? `--timeout=${timeout}` : `--time=${timeout}`;
  return `docker stop ${flag} ${containers}`;
}

export function dockerRemoveCommandWithTimeout(container: string, timeout = 60, killAfter = 10): string {
  const escaped = escapeShellValue(container);
  const script =
    `if command -v timeout >/dev/null 2>&1; then output=$(timeout -k ${killAfter}s ${timeout}s docker rm -f ${escaped} 2>&1); exit_code=$?; else output=''; exit_code=124; fi; ` +
    `if [ "$exit_code" -eq 124 ]; then echo '__COOLIFY_CONTAINER_REMOVE_TIMEOUT__'; ` +
    `elif [ "$exit_code" -ne 0 ] && printf '%s' "$output" | grep -q 'No such container:'; then exit 0; ` +
    `elif [ "$exit_code" -ne 0 ]; then printf '%s\\n' "$output" >&2; else printf '%s\\n' "$output"; fi; exit $exit_code`;
  return "bash -c " + escapeShellValue(script);
}

export function dockerRemoveCommand(container: string): string {
  const command = "docker rm -f " + escapeShellValue(container);
  return dockerCommandIgnoringError(command, "No such container:");
}

export function dockerReadOnlyFileMountOption(source: string, target: string): string {
  return "--mount " + escapeshellarg(`type=bind,source=${source},target=${target},readonly`);
}

export function composeProjectMountsCommand(projectName: string): string {
  const format =
    '{"name":{{json .Name}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"imageVolumes":{{json .Config.Volumes}},"mounts":{{json .Mounts}}}';
  return (
    "docker ps -aq --filter " +
    escapeshellarg(`label=com.docker.compose.project=${projectName}`) +
    " | xargs -r docker inspect --format " +
    escapeshellarg(format) +
    " 2>/dev/null || true"
  );
}

export function composeServiceVolumeTargets(volumes: unknown): string[] | null {
  const targets: string[] = [];
  for (const volume of isPhpArray(volumes) ? phpArrayValues(volumes) : []) {
    let target: unknown;
    if (isPhpArray(volume)) {
      target = phpArrayGet(volume, "target");
    } else {
      // source:target:mode, where the source can contain colons, for example ${DATA:-/data}.
      const parts = phpToString(volume).split(":");
      // PHP's `$` also matches before a trailing newline.
      if (parts.length > 1 && /^[a-zA-Z,]+\n?$/.test(parts[parts.length - 1]!)) parts.pop();
      target = parts[parts.length - 1];
    }
    if (typeof target !== "string" || !target.startsWith("/")) return null;
    targets.push(phpRtrim(target, "/") || "/");
  }
  return targets;
}

export function dockerNetworkRemoveCommand(network: string): string {
  const command = "docker network rm " + escapeShellValue(network);
  return dockerCommandIgnoringError(command, "network .* not found");
}

export function dockerCommandIgnoringError(command: string, ignoredError: string): string {
  const script =
    `output=$(${command} 2>&1); exit_code=$?; if [ "$exit_code" -ne 0 ] && printf '%s' "$output" | grep -Eq ` +
    escapeShellValue(ignoredError) +
    `; then exit 0; fi; if [ "$exit_code" -ne 0 ]; then printf '%s\\n' "$output" >&2; else printf '%s\\n' "$output"; fi; exit $exit_code`;
  return "bash -c " + escapeShellValue(script);
}

export function escapeShellValue(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}
