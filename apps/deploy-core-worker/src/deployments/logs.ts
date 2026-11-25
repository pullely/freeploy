// Derived from coollabsio/coolify@91b7e3e:app/Models/ApplicationDeploymentQueue.php (addLogEntry, redactLogText,
// hidesUnlockedEnvValues, HIDDEN_ENV_VALUES_HINT), app/Actions/CoolifyTask/RunRemoteProcess.php (takeCompleteOutput),
// bootstrap/helpers/remoteProcess.php (decode_remote_command_output) and
// app/Livewire/Project/Application/Deployment/Show.php (exportLogs, downloadAllLogs, exportLineText)
// (Apache-2.0), modified.
//
// The deployment log: how an entry is made (trimmed, redacted, stamped), how a command's output is cut into
// entries, and how the stored entries become the lines the deployment page shows. The stored format is
// Coolify's: a JSON list of { command, output, type, timestamp, hidden, batch, order }.
import type { DeploymentLogEntry, NewDeploymentLogEntry } from "@saas/db/deploy";
import { containsKnownSecret, redactSensitiveText } from "../helpers/remote-process.js";
import { phpTrim } from "./php.js";
import type { LogRedactionSecrets } from "./runtime-env.js";

export const REDACTED = "<REDACTED>";

export const HIDDEN_ENV_VALUES_HINT =
  'Some environment variable values are hidden in this log. To show values that are not locked, go to Environment Variables > Environment values in logs and select "Hide locked values only".';

/** Carbon::now('UTC') as json_encode() writes it: microseconds, "Z". */
export function logTimestamp(now: Date): string {
  return now.toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}

/** redactLogText(): the application's secrets, then the redactor's own patterns. */
export function redactLogText(text: string, secrets: LogRedactionSecrets): string {
  return redactSensitiveText(text, secrets.known, secrets.locked);
}

export interface LogEntryInput {
  message: string;
  type?: string;
  hidden?: boolean;
  command?: string | null;
  batch?: number;
}

/**
 * addLogEntry(), before it is stored: the message trimmed (a box drawing line keeps a line break before it) and
 * redacted, and — the first time an entry hides an environment value that is not locked — the hint that
 * follows it.
 */
export function buildLogEntry(input: LogEntryInput, secrets: LogRedactionSecrets, now: Date, hintAlreadyAdded: boolean): { entry: NewDeploymentLogEntry; hint: NewDeploymentLogEntry | null } {
  const type = input.type === "error" ? "stderr" : (input.type ?? "stdout");
  let message = phpTrim(input.message);
  if (message.startsWith("╔")) message = "\n" + message;
  const command = input.command ?? null;
  const entry: NewDeploymentLogEntry = {
    command: command === null ? null : redactLogText(command, secrets),
    output: redactLogText(message, secrets),
    type,
    timestamp: logTimestamp(now),
    hidden: input.hidden ?? false,
    batch: input.batch ?? 1,
  };
  // hidesUnlockedEnvValues(): the "redact all values" setting hides a value that is not locked in this text.
  const unlocked = secrets.known.filter((value) => !secrets.locked.includes(value));
  const hides = !hintAlreadyAdded && containsKnownSecret(`${message} ${command ?? ""}`, unlocked);
  return { entry, hint: hides ? { ...entry, command: null, output: HIDDEN_ENV_VALUES_HINT, type: "stdout", hidden: false } : null };
}

const UNFINISHED_PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----(?![\s\S]*-----END [A-Z ]*PRIVATE KEY-----)[\s\S]*/;

/**
 * RunRemoteProcess::takeCompleteOutput(): the complete lines of the output that is waiting — never the start of
 * a private key whose end has not arrived — and what stays waiting. With `final`, everything, an unfinished
 * private key redacted.
 */
export function takeCompleteOutput(pending: string, final = false): { taken: string; pending: string } {
  if (final) return { taken: pending.replace(UNFINISHED_PRIVATE_KEY, REDACTED), pending: "" };
  const end = Math.max(pending.lastIndexOf("\n"), pending.lastIndexOf("\r"));
  if (end < 0) return { taken: "", pending };
  let output = pending.slice(0, end + 1);
  const key = UNFINISHED_PRIVATE_KEY.exec(output);
  if (key) output = output.slice(0, key.index);
  return { taken: output, pending: pending.slice(output.length) };
}

/** One line of the deployment page's log. */
export interface DeploymentLogLine {
  line: string;
  /** 'Y-M-d H:i:s' in the server's timezone. */
  timestamp: string;
  stderr: boolean;
  hidden: boolean;
  /** The line is the command the following output belongs to. */
  command?: true;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Carbon::parse($timestamp)->setTimezone($zone)->format('Y-M-d H:i:s'); UTC when the zone is not one. */
export function formatLogTimestamp(timestamp: string, timezone: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  const parts = (zone: string): Record<string, string> => {
    const formatted = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
    return Object.fromEntries(formatted.map((part) => [part.type, part.value]));
  };
  let p: Record<string, string>;
  try {
    p = parts(timezone);
  } catch {
    p = parts("UTC");
  }
  return `${p.year}-${MONTHS[Number(p.month) - 1]}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * decode_remote_command_output(): the stored entries as the lines the page shows — in their order, the debug
 * (hidden) entries only when asked for, each command once before its first output of a batch, and an output
 * split into its lines.
 */
export function decodeDeploymentLogLines(logs: DeploymentLogEntry[] | null, options: { includeHidden: boolean; timezone?: string | null }): DeploymentLogLine[] {
  if (logs === null) return [];
  const timezone = options.timezone || "UTC";
  const shown = options.includeHidden ? logs : logs.filter((entry) => entry.hidden === false);
  const ordered = shown.map((entry, index) => ({ entry, index })).sort((a, b) => (a.entry.order ?? 0) - (b.entry.order ?? 0) || a.index - b.index);
  const seen: Array<{ command: string; batch: number }> = [];
  const lines: DeploymentLogLine[] = [];
  for (const { entry } of ordered) {
    const timestamp = formatLogTimestamp(entry.timestamp, timezone);
    const stderr = entry.type === "stderr";
    const command = entry.command ?? null;
    if (command !== null && !seen.some((s) => s.command === command && s.batch === entry.batch)) {
      lines.push({ line: command, timestamp, stderr, hidden: entry.hidden, command: true });
      seen.push({ command, batch: entry.batch });
    }
    for (const line of String(entry.output ?? "").split("\n")) lines.push({ line, timestamp, stderr, hidden: entry.hidden });
  }
  return lines;
}

/** Show::exportLineText() */
const exportLineText = (line: DeploymentLogLine): string => (line.command ? "[CMD]: " : "") + phpTrim(line.line);

/** Show::exportLogs(): the displayed lines that match the search, with secrets hidden. */
export function exportDeploymentLogs(lines: DeploymentLogLine[], secrets: LogRedactionSecrets, options: { withTimestamps?: boolean; search?: string } = {}): string {
  const search = phpTrim(options.search ?? "").toLowerCase();
  const text = lines
    .map((line) => ({ timestamp: line.timestamp, text: exportLineText(line) }))
    .filter((line) => search === "" || `${line.timestamp} ${line.text}`.toLowerCase().includes(search))
    .map((line) => ((options.withTimestamps ?? true) ? `${line.timestamp} ${line.text}` : line.text))
    .join("\n");
  return redactLogText(text, secrets);
}

/** Show::downloadAllLogs(): every line, the debug lines marked, with secrets hidden. */
export function exportAllDeploymentLogs(lines: DeploymentLogLine[], secrets: LogRedactionSecrets): string {
  return redactLogText(lines.map((line) => `${line.timestamp} ${line.hidden ? "[DEBUG] " : ""}${exportLineText(line)}`).join("\n"), secrets);
}
