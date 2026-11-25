// The pieces a deployment is made of (DP-56), each held to what Coolify's own PHP returned for the same
// arguments (fixtures/deployments: cases.json → emit.php → goldens.json): Symfony's Yaml::dump, the custom
// Docker run options, the escaping of a .env value, the log redactor, the output splitter, the git SSH
// setup command, docker stop, PHP's escapeshellarg, the GPU options, the README of a configuration folder,
// and the lines the deployment page makes of a stored log.
import { functionCases, goldenRun, goldenValue, runCases, type GoldenLog } from "./deployment-goldens";
import { parseGpuOptions } from "@deploy-core-worker/applications/settings-validation";
import { convertDockerRunToCompose, seccompProfileMountFlags, unsupportedDockerRunOptions } from "@deploy-core-worker/deployments/docker-run-options";
import { generateReadmeFile, validateGitRef, storedApplicationStatus } from "@deploy-core-worker/deployments/engine";
import { gitSshSetupCommand } from "@deploy-core-worker/deployments/git-ssh";
import { decodeDeploymentLogLines, exportAllDeploymentLogs, exportDeploymentLogs, takeCompleteOutput } from "@deploy-core-worker/deployments/logs";
import { escapeshellarg } from "@deploy-core-worker/deployments/php";
import { escapeComposeEnvFileValue } from "@deploy-core-worker/deployments/runtime-env";
import { PhpFloat, yamlDump, type YamlValue } from "@deploy-core-worker/deployments/yaml";
import { dockerStopCommand } from "@deploy-core-worker/helpers/docker";
import { redactSensitiveText } from "@deploy-core-worker/helpers/remote-process";
import type { DeploymentLogEntry } from "@saas/db/deploy";
import { GOLDEN_NOW } from "./deployment-goldens";

const cases = (prefix: string) => functionCases.filter((c) => c.id.startsWith(prefix)).map((c) => [c.id, c] as const);

/** json_decode() in PHP: an object is an array with string keys, a whole number an int unless it overflows. */
function phpValue(value: unknown): YamlValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isInteger(value) && Math.abs(value) >= 2 ** 63 ? new PhpFloat(value) : value;
  if (Array.isArray(value)) return value.map(phpValue);
  return new Map(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, phpValue(v)]));
}

/** A value of the ports as json_encode() writes a PHP array: an empty array is [], a map an object. */
function phpJson(value: YamlValue): unknown {
  if (value instanceof Map) return value.size === 0 ? [] : Object.fromEntries([...value].map(([k, v]) => [k, phpJson(v)]));
  if (Array.isArray(value)) return value.map(phpJson);
  if (value instanceof PhpFloat) return value.value;
  return value;
}

describe("Yaml::dump($value, 10)", () => {
  it.each(cases("yaml."))("%s", (_, c) => {
    expect(yamlDump(phpValue(c.args[0]))).toBe(goldenValue(c.id));
  });

  it("a float keeps its type: (float) '2' is 2.0, a whole int is not", () => {
    expect(yamlDump(new Map<string, YamlValue>([["cpus", new PhpFloat(2)], ["i", 2], ["z", new PhpFloat(0)], ["h", new PhpFloat(0.5)]]))).toBe("cpus: 2.0\ni: 2\nz: 0.0\nh: 0.5\n");
  });
});

describe("the custom Docker run options", () => {
  it.each(cases("run-options.compose."))("convertDockerRunToCompose %s", (_, c) => {
    expect(phpJson(convertDockerRunToCompose(c.args[0] as string | null))).toEqual(goldenValue(c.id));
  });
  it.each(cases("run-options.unsupported."))("unsupportedDockerRunOptions %s", (_, c) => {
    expect(unsupportedDockerRunOptions(c.args[0] as string | null)).toEqual(goldenValue(c.id));
  });
  it.each(cases("run-options.seccomp."))("seccompProfileMountFlags %s", (_, c) => {
    expect(seccompProfileMountFlags(c.args[0] as string | null)).toBe(goldenValue(c.id));
  });

  it("keeps the order in which the options first appear, as PHP's array does", () => {
    expect([...convertDockerRunToCompose("--init --cap-add A --hostname h --cap-add B").keys()]).toEqual(["init", "cap_add", "hostname"]);
  });
});

describe("escapeComposeEnvFileValue", () => {
  it.each(cases("env-value."))("%s", (_, c) => {
    expect(escapeComposeEnvFileValue(c.args[0] as string | null, c.args[1] as boolean | undefined)).toBe(goldenValue(c.id));
  });
});

describe("the log redactor (SensitiveDataRedactor::redactText)", () => {
  it.each(cases("redact."))("%s", (_, c) => {
    // PHP takes any scalar as a secret: a number is its text, null is none.
    const secrets = (list: unknown): string[] => (list as unknown[]).filter((s) => s !== null).map((s) => String(s));
    expect(redactSensitiveText(c.args[0] as string, secrets(c.args[1]), secrets(c.args[2]))).toBe(goldenValue(c.id));
  });
});

describe("takeCompleteOutput", () => {
  it.each(cases("take-output."))("%s", (_, c) => {
    expect(takeCompleteOutput(c.args[0] as string, c.args[1] as boolean)).toEqual(goldenValue(c.id));
  });
});

describe("commands", () => {
  it.each(cases("git-ssh."))("gitSshSetupCommand %s", (_, c) => {
    expect(gitSshSetupCommand(c.args[0] as string, c.args[1] as string | null)).toBe(goldenValue(c.id));
  });
  it.each(cases("docker-stop."))("dockerStopCommand %s", (_, c) => {
    expect(dockerStopCommand(c.args[0] as number, c.args[1] as string, c.args[2] as string | null)).toBe(goldenValue(c.id));
  });
  it.each(cases("shell-arg."))("escapeshellarg %s", (_, c) => {
    expect(escapeshellarg(c.args[0] as string)).toBe(goldenValue(c.id));
  });
  it.each(cases("readme."))("generate_readme_file %s", (_, c) => {
    expect(generateReadmeFile(c.args[0] as string, c.args[1] as string)).toBe(goldenValue(c.id));
  });
});

describe("ApplicationSetting::parseGpuOptions (DP-52's port, which the compose file uses)", () => {
  it.each(cases("gpu-options."))("%s", (_, c) => {
    const golden = goldenValue(c.id);
    // PHP's json_encode() writes an empty mapping as [].
    expect(parseGpuOptions(c.args[0] as string | null)).toEqual(Array.isArray(golden) ? {} : golden);
  });
});

describe("what no golden covers, by reading Coolify's source", () => {
  it("validateGitRef", () => {
    expect(validateGitRef(" HEAD ")).toBe("HEAD");
    expect(validateGitRef("")).toBe("");
    expect(validateGitRef("v1.2.3/rc_1-a")).toBe("v1.2.3/rc_1-a");
    expect(() => validateGitRef("-rf", "deployment commit")).toThrow("Invalid deployment commit: must not start with a hyphen.");
    expect(() => validateGitRef("a;b", "deployment commit")).toThrow("Invalid deployment commit: contains disallowed characters. Only alphanumeric characters, dots, hyphens, underscores, and slashes are allowed.");
  });

  it("the Application model's status mutator", () => {
    expect(storedApplicationStatus("running")).toBe("running:unhealthy");
    expect(storedApplicationStatus("running (healthy)")).toBe("running:healthy");
    expect(storedApplicationStatus("exited:unhealthy")).toBe("exited:unhealthy");
  });
});

describe("the lines of the deployment page (decode_remote_command_output)", () => {
  const viewed = runCases.filter((run) => (run as unknown as { view?: boolean }).view === true);
  const stored = (logs: GoldenLog[]): DeploymentLogEntry[] =>
    logs.map((entry, index) => ({ command: entry.command ?? null, output: entry.output, type: entry.type ?? "stdout", timestamp: GOLDEN_NOW, hidden: entry.hidden ?? false, batch: entry.batch ?? 1, order: index + 1 }));

  it("has cases", () => {
    expect(viewed.length).toBeGreaterThanOrEqual(5);
  });

  it.each(viewed.map((run) => [run.id, run] as const))("%s", (_, run) => {
    const golden = goldenRun(run.id) as ReturnType<typeof goldenRun> & { lines: unknown[]; linesAll: unknown[] };
    const logs = stored(golden.deployment!.logs!);
    // PHP writes `command: true` only on a command line; the others have no such key.
    expect(decodeDeploymentLogLines(logs, { includeHidden: false })).toEqual(golden.lines);
    expect(decodeDeploymentLogLines(logs, { includeHidden: true })).toEqual(golden.linesAll);
  });

  it("shows the time in the server's timezone, and falls back to UTC for a zone that is none", () => {
    const logs = stored([{ output: "a" }]);
    expect(decodeDeploymentLogLines(logs, { includeHidden: false, timezone: "Europe/Berlin" })[0]!.timestamp).toBe("2026-Nov-20 11:11:12");
    expect(decodeDeploymentLogLines(logs, { includeHidden: false, timezone: "Not/AZone" })[0]!.timestamp).toBe("2026-Nov-20 10:11:12");
    expect(decodeDeploymentLogLines(null, { includeHidden: true })).toEqual([]);
  });

  it("exports them as Show::exportLogs and downloadAllLogs do", () => {
    const logs = stored([
      { output: "Pulling", command: "docker pull x", hidden: true, batch: 2 },
      { output: "  token tok_live_0123456789  " },
      { output: "boom\nagain", type: "stderr" },
    ]);
    const secrets = { known: ["tok_live_0123456789"], locked: [] };
    const shown = decodeDeploymentLogLines(logs, { includeHidden: false });
    expect(exportDeploymentLogs(shown, secrets)).toBe("2026-Nov-20 10:11:12 token <REDACTED>\n2026-Nov-20 10:11:12 boom\n2026-Nov-20 10:11:12 again");
    expect(exportDeploymentLogs(shown, secrets, { withTimestamps: false, search: " AGAIN " })).toBe("again");
    expect(exportAllDeploymentLogs(decodeDeploymentLogLines(logs, { includeHidden: true }), secrets)).toBe(
      "2026-Nov-20 10:11:12 [DEBUG] [CMD]: docker pull x\n2026-Nov-20 10:11:12 [DEBUG] Pulling\n2026-Nov-20 10:11:12 token <REDACTED>\n2026-Nov-20 10:11:12 boom\n2026-Nov-20 10:11:12 again",
    );
  });
});
