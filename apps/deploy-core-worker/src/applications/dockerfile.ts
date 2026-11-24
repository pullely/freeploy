// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/docker.php (get_port_from_dockerfile),
// bootstrap/helpers/shared.php (dockerfileHealthcheckInstruction, dockerfileHealthcheckOptions,
// parseDockerfileInterval) and app/Models/Application.php (parseHealthcheckFromDockerfile)
// (Apache-2.0), modified.
//
// What Coolify reads from a Dockerfile's text when an application is created
// from it or when General saves it: the first EXPOSE port and the HEALTHCHECK
// that applies to the built image.
import { phpTrim } from "./git.js";

/** PHP's (int) of a string: its leading optional sign and digits, else 0. */
function phpInt(value: string): number {
  const m = value.match(/^[ \t\n\r\v\f]*([+-]?\d+)/);
  return m ? Number(m[1]) : 0;
}

/**
 * get_port_from_dockerfile(): PHP's (int) of what follows the first line that
 * starts with EXPOSE ("80/tcp" and "80 443" read 80, "$PORT" reads 0), or
 * null when no line does. Every caller treats 0 as no port.
 */
export function getPortFromDockerfile(dockerfile: string): number | null {
  for (const raw of dockerfile.split("\n")) {
    const line = phpTrim(raw);
    if (!line.startsWith("EXPOSE")) continue;
    return phpInt(phpTrim(line.split("EXPOSE").join("")));
  }
  return null;
}

interface Stage {
  name: string | null;
  parent: string;
  healthcheck: string | null;
}

/**
 * dockerfileHealthcheckInstruction(): the HEALTHCHECK of the stage Docker
 * builds — the target, or the last one — following FROM to earlier stages;
 * null when none applies or it is HEALTHCHECK NONE.
 */
export function dockerfileHealthcheckInstruction(dockerfile: string | null | undefined, target: string | null = null): string | null {
  const text = dockerfile ?? "";
  // The "# escape=`" parser directive is valid only in the comment lines at the top of the file.
  const directive = text.match(/^(?:[ \t]*#[ \t]*[a-z]+[ \t]*=[^\r\n]*(?:\r\n|\n|\r|\v|\f))*?[ \t]*#[ \t]*escape[ \t]*=[ \t]*([\\`])[ \t]*(?=\n|$)/i);
  const escape = directive ? directive[1]! : "\\";
  const instructions: string[] = [];
  let current = "";
  for (const raw of text.split(/\r\n|\n|\r|\v|\f/)) {
    const line = phpTrim(raw);
    if (line === "" || line.startsWith("#")) continue;
    const continues = line.endsWith(escape);
    current = phpTrim(`${current} ${continues ? line.slice(0, -1) : line}`);
    if (!continues) {
      instructions.push(current);
      current = "";
    }
  }
  if (current !== "") instructions.push(current);

  const stages: Stage[] = [];
  for (const instruction of instructions) {
    const from = instruction.match(/^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i);
    if (from) stages.push({ name: from[2] !== undefined ? from[2].toLowerCase() : null, parent: from[1]!.toLowerCase(), healthcheck: null });
    else if (stages.length && /^HEALTHCHECK(\s|$)/i.test(instruction)) stages[stages.length - 1]!.healthcheck = instruction;
  }
  if (!stages.length) return null;

  const wanted = target !== null && phpTrim(target) !== "" ? phpTrim(target).toLowerCase() : null;
  let index: number | null = wanted === null ? stages.length - 1 : null;
  stages.forEach((stage, i) => {
    if (wanted !== null && stage.name === wanted) index = i;
  });
  while (index !== null) {
    const stage: Stage = stages[index]!;
    if (stage.healthcheck !== null) return /^HEALTHCHECK(?:\s+--\S+)*\s+NONE$/i.test(stage.healthcheck) ? null : stage.healthcheck;
    let parent: number | null = null;
    for (let i = 0; i < index; i++) if (stages[i]!.name === stage.parent) parent = i;
    index = parent;
  }
  return null;
}

const INT_MAX = 2147483647;
const UNIT_SECONDS: Record<string, number> = { ns: 1e-9, us: 1e-6, "µs": 1e-6, "μs": 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 };

/**
 * parseDockerfileInterval(): a Go duration ("1m30s", "1.5m") or a bare number
 * of seconds, as whole seconds; a positive value below one second is 1; null
 * when it is not a duration or does not fit the integer column.
 */
export function parseDockerfileInterval(value: string): number | null {
  const duration = value.startsWith("+") ? value.slice(1) : value;
  if (/^\d+$/.test(duration)) return Number(duration) <= INT_MAX ? Number(duration) : null;
  const parts = [...duration.matchAll(/(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|μs|ms|s|m|h)/gu)];
  if (!parts.length || parts.map((p) => p[0]).join("") !== duration) return null;
  let seconds = 0;
  for (const part of parts) seconds += Number(part[1]) * UNIT_SECONDS[part[2]!]!;
  if (seconds > 0 && seconds < 1) return 1;
  // Round away float noise (0.3m = 17.999…s), then drop the fraction.
  seconds = Math.floor(Math.round(seconds * 1e6) / 1e6);
  return seconds <= INT_MAX ? seconds : null;
}

export interface DockerfileHealthcheckOptions {
  interval: number | null;
  timeout: number | null;
  startPeriod: number | null;
  retries: number | null;
}

/**
 * dockerfileHealthcheckOptions(): the --name=value flags before CMD. An
 * option is null when it is missing or not valid; a zero interval, timeout or
 * retries is Docker's default (30, 30, 3).
 */
export function dockerfileHealthcheckOptions(instruction: string): DockerfileHealthcheckOptions {
  const flagsPart = instruction.match(/^HEALTHCHECK((?:\s+--[a-z-]+=(?:"[^"]*"|'[^']*'|\S+))*)/i);
  const values: Record<string, string> = {};
  for (const flag of (flagsPart?.[1] ?? "").matchAll(/--([a-z-]+)=("[^"]*"|'[^']*'|\S+)/gi)) {
    values[flag[1]!] = flag[2]!.replace(/^(["'])(.*)\1$/, "$2");
  }
  const interval = parseDockerfileInterval(values.interval ?? "");
  const timeout = parseDockerfileInterval(values.timeout ?? "");
  const retries = /^\+?\d{1,9}$/.test(values.retries ?? "") ? Number(values.retries) : null;
  return {
    interval: interval === 0 ? 30 : interval,
    timeout: timeout === 0 ? 30 : timeout,
    startPeriod: parseDockerfileInterval(values["start-period"] ?? ""),
    retries: retries === 0 ? 3 : retries,
  };
}
