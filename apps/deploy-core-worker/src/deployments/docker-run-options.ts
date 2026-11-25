// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/docker.php (convertDockerRunToCompose,
// unsupportedDockerRunOptions, seccompProfileMountFlags) and bootstrap/helpers/constants.php
// (DOCKER_RUN_OPTION_MAPPING) (Apache-2.0), modified.
//
// An application's "Custom Docker Options" (a `docker run` option string) as the compose keys Coolify
// merges into the container's service. Byte-equal to Coolify's PHP for the run-options.* cases of
// tests/deploy-core-worker/fixtures/deployments.
import { escapeshellarg, phpTrim } from "./php.js";
import type { YamlValue } from "./yaml.js";

/** Custom Docker options that Coolify converts to Compose; other options conflict with settings Coolify manages. */
export const DOCKER_RUN_OPTION_MAPPING: Readonly<Record<string, string>> = {
  "--add-host": "extra_hosts",
  "--cap-add": "cap_add",
  "--cap-drop": "cap_drop",
  "--security-opt": "security_opt",
  "--sysctl": "sysctls",
  "--device": "devices",
  "--init": "init",
  "--ulimit": "ulimits",
  "--privileged": "privileged",
  "--ip": "ip",
  "--ip6": "ip6",
  "--shm-size": "shm_size",
  "--dns": "dns",
  "--gpus": "gpus",
  "--hostname": "hostname",
  "--entrypoint": "entrypoint",
  "--pids-limit": "pids_limit",
  "--read-only": "read_only",
  "--runtime": "runtime",
  "--tmpfs": "tmpfs",
};

// PCRE's \s without /u: the ASCII white space only.
const S = "[ \\t\\n\\v\\f\\r]";
const NS = "[^ \\t\\n\\v\\f\\r\"']";
const OPTION_RE = new RegExp(`(--\\w+(?:-\\w+)*)(?:${S}+|=)?((?!-(?!\\d))(?:"(?:\\\\.|[^"])*"|'[^']*'|${NS}|["'])+)?`, "g");
const QUOTED_RE = /"((?:\\.|[^"])*)"|'([^']*)'/g;
const ENTRYPOINT_RE = new RegExp(`--entrypoint(?:=|${S}+)("(?:\\\\.|[^"])*"|'(?:\\\\.|[^'])*'|[^ \\t\\n\\v\\f\\r]+)`);
const TOKEN_RE = new RegExp(`(?:[^ \\t\\n\\v\\f\\r'"\\\\]+|\\\\.|"(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')+`, "g");
const WORD_RE = new RegExp(`(?:"(?:\\\\.|[^"])*"|'[^']*'|${NS}|["'])+`, "g");

/** preg_replace('/\\(["$`\\])/', '$1', …): \" \$ \` \\ lose their backslash. */
const unescapeDoubleQuoted = (text: string): string => text.replace(/\\(["$`\\])/g, "$1");

/** array_unique(): the first of each value, in order. */
const unique = (values: string[]): string[] => values.filter((v, i) => values.indexOf(v) === i);

type Gpus = { driver: string; capabilities: string[]; device_ids?: string[]; count?: number };
type Parsed = string[] | boolean | Gpus;

const gpuDevice = (payload: Gpus): Map<string, YamlValue> => {
  const device = new Map<string, YamlValue>([
    ["driver", payload.driver],
    ["capabilities", payload.capabilities],
  ]);
  if (payload.device_ids) device.set("device_ids", payload.device_ids);
  if (payload.count !== undefined) device.set("count", payload.count);
  return device;
};

/**
 * convertDockerRunToCompose(): the compose keys of the options Coolify supports, in the order the options
 * first appear. `ip` and `ip6` are not compose keys: the caller turns them into the network's addresses.
 */
export function convertDockerRunToCompose(customDockerRunOptions: string | null): Map<string, YamlValue> {
  const text = customDockerRunOptions ?? "";
  const options = new Map<string, Parsed>();
  for (const match of text.matchAll(OPTION_RE)) {
    const option = match[1]!;
    // Remove the quotes like a shell: unescape \" \$ \` \\ in double quotes, keep single-quoted text as is.
    let value = (match[2] ?? "").replace(QUOTED_RE, (_all, double: string | undefined, single: string | undefined) => (single !== undefined ? single : unescapeDoubleQuoted(double ?? "")));
    if (option === "--gpus") {
      // all, a count (2), or device IDs ("device=0,1"; the inner quotes are part of the Docker syntax)
      const gpus = phpTrim(value, '"');
      const payload: Gpus = { driver: "nvidia", capabilities: ["gpu"] };
      const devices = /^device=([0-9A-Za-z\-,]+)$/.exec(gpus);
      if (devices) payload.device_ids = devices[1]!.split(",");
      else if (/^[0-9]+$/.test(gpus)) payload.count = Number(gpus);
      options.set(option, payload);
      continue;
    }
    if (option === "--entrypoint") {
      let entrypoint: string | null = null;
      // The first --entrypoint of the whole text, with quoted strings and their escapes.
      const raw = ENTRYPOINT_RE.exec(text)?.[1];
      if (raw !== undefined) {
        if (raw.startsWith('"') && raw.endsWith('"')) entrypoint = unescapeDoubleQuoted(raw.slice(1, -1));
        else if (raw.startsWith("'") && raw.endsWith("'")) entrypoint = raw.slice(1, -1);
        else entrypoint = raw;
      }
      // PHP's truthiness: "" and "0" are not a value.
      if (entrypoint !== null && entrypoint !== "" && entrypoint !== "0" && phpTrim(entrypoint) !== "") {
        const current = options.get(option);
        options.set(option, unique([...(Array.isArray(current) ? current : []), entrypoint]));
      }
      continue;
    }
    if (option === "--init" || option === "--privileged" || option === "--read-only") {
      // Boolean flags only take a value with "=" (--privileged=false); a space-separated word is not their value
      const hasInlineValue = match[0].slice(option.length).startsWith("=");
      options.set(option, !(hasInlineValue && value.toLowerCase() === "false"));
      continue;
    }
    if (phpTrim(value) === "") continue;
    value = String(value);
    const current = options.get(option);
    options.set(option, unique([...(Array.isArray(current) ? current : []), value]));
  }

  const compose = new Map<string, YamlValue>();
  for (const [option, value] of options) {
    const key = DOCKER_RUN_OPTION_MAPPING[option];
    if (key === undefined) continue;
    if (option === "--ulimit") {
      const ulimits = new Map<string, YamlValue>();
      for (const ulimit of value as string[]) {
        const eq = ulimit.indexOf("=");
        if (eq < 0) continue;
        const type = ulimit.slice(0, eq);
        const rest = ulimit.slice(eq + 1);
        const limits = rest.split(":");
        // Compose needs both soft and hard in the mapping form, so a single limit is set directly
        ulimits.set(type, limits.length === 2 ? new Map<string, YamlValue>([["soft", limits[0]!], ["hard", limits[1]!]]) : rest);
      }
      if (ulimits.size > 0) compose.set(key, ulimits);
    } else if (option === "--shm-size" || option === "--hostname" || option === "--runtime" || option === "--entrypoint") {
      const first = (value as string[])[0];
      // ! empty(trim($value[0])): "0" is empty in PHP.
      if (first !== undefined && phpTrim(first) !== "" && phpTrim(first) !== "0") compose.set(key, first);
    } else if (option === "--pids-limit") {
      const first = (value as string[])[0] ?? "";
      if (/^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(first)) compose.set(key, Math.trunc(Number(first)));
    } else if (option === "--gpus") {
      compose.set("deploy", new Map<string, YamlValue>([["resources", new Map<string, YamlValue>([["reservations", new Map<string, YamlValue>([["devices", [gpuDevice(value as Gpus)]]])]])]]));
    } else {
      compose.set(key, value as string[] | boolean);
    }
  }

  // Short interactive/TTY flags (-i, -t, -it, -ti) and their long forms are not matched by the long-option
  // regex above. Quoted option values stay together, so flags inside an entrypoint are not options.
  for (const [token] of text.matchAll(TOKEN_RE)) {
    if (token === "--interactive") compose.set("stdin_open", true);
    else if (token === "--tty") compose.set("tty", true);
    else if (/^-[dit]+$/.test(token)) {
      if (token.includes("i")) compose.set("stdin_open", true);
      if (token.includes("t")) compose.set("tty", true);
    }
  }
  return compose;
}

/** The options (--network, -e, ...) that convertDockerRunToCompose() does not apply. */
export function unsupportedDockerRunOptions(customDockerRunOptions: string | null): string[] {
  const unsupported: string[] = [];
  // Split into shell words, so text inside a quoted value is not taken as an option
  for (const [word] of (customDockerRunOptions ?? "").matchAll(WORD_RE)) {
    if (!word.startsWith("-") || /^-\d/.test(word)) continue;
    // convertDockerRunToCompose() maps these outside DOCKER_RUN_OPTION_MAPPING
    if (/^(-[dit]+|--interactive|--tty)$/.test(word)) continue;
    // strtok($word, '='): the text before the first "=".
    const name = word.replace(/^=+/, "").split("=")[0]!;
    const option = word.startsWith("--") ? "--" + name.replace(/^-+/, "") : name;
    if (!(option in DOCKER_RUN_OPTION_MAPPING)) unsupported.push(option);
  }
  return unique(unsupported);
}

/**
 * --mount flags that make seccomp profile files from the custom Docker options readable in the deployment
 * helper container, where docker compose reads them. The path stays the same, so security_opt works unchanged.
 */
export function seccompProfileMountFlags(customDockerRunOptions: string | null): string {
  const securityOpt = convertDockerRunToCompose(customDockerRunOptions).get("security_opt");
  const flags: string[] = [];
  for (const opt of Array.isArray(securityOpt) ? securityOpt : []) {
    const profile = typeof opt === "string" ? /^seccomp[=:](\/[A-Za-z0-9._/-]+)$/.exec(opt) : null;
    if (profile && !profile[1]!.includes("..")) flags.push("--mount " + escapeshellarg(`type=bind,source=${profile[1]},target=${profile[1]},readonly`));
  }
  return unique(flags).join(" ");
}
