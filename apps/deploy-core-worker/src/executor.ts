// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/remoteProcess.php
// (instant_remote_process, excludeCertainErrors) and app/Helpers/SshMultiplexingHelper.php
// (HOST_KEY_CHANGED_MESSAGE) (Apache-2.0), modified.
//
// The client side of apps/ssh-executor (DP4): send a batch, read its NDJSON
// stream, and give back what instant_remote_process gives back — the trimmed
// output, null for "null", sanitized UTF-8 — or throw the error it throws.
import { sanitize_utf8_text } from "./helpers/remote-process.js";

export interface ExecutorConn {
  host: string;
  port: number;
  user: string;
  privateKey: string;
  /** Pinned host key (authorized_keys format); empty on first use. */
  hostKey: string;
  connectTimeout?: number;
  serverInterval?: number;
}

export interface ExecResult {
  stdout: string[];
  stderr: string[];
  exitCode: number;
  /** The host key the server presented, to pin on first use. */
  hostKey: string | null;
  /** A connection-level error (e.g. the host key changed), when there is one. */
  error: string | null;
}

/** Anything that can reach the executor: the Container binding's stub, or fetch in tests. */
export type ExecutorFetch = (path: string, init: { method: "POST"; body: string; headers: Record<string, string> }) => Promise<Response>;

export const HOST_KEY_CHANGED_MESSAGE =
  "The SSH host key of this server changed, so Freeploy did not connect. An admin must check the new key on the Security page of the server.";

interface Event {
  t: "hostkey" | "out" | "err" | "exit" | "error";
  line?: string;
  key?: string;
  code?: number;
  message?: string;
}

/** POST /exec and collect the stream. `onLine` sees each line as it arrives (deployment logs). */
export async function execBatch(
  fetcher: ExecutorFetch,
  conn: ExecutorConn,
  commands: string[],
  timeout?: number,
  onLine?: (stream: "out" | "err", line: string) => void,
): Promise<ExecResult> {
  const res = await fetcher("/exec", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conn, commands, ...(timeout ? { timeout } : {}) }),
  });
  if (!res.ok || !res.body) throw new Error(`ssh-executor answered ${res.status}`);
  const result: ExecResult = { stdout: [], stderr: [], exitCode: 255, hostKey: null, error: null };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  const handle = (raw: string) => {
    if (!raw.trim()) return;
    const e = JSON.parse(raw) as Event;
    if (e.t === "hostkey") result.hostKey = e.key ?? null;
    else if (e.t === "out" || e.t === "err") {
      (e.t === "out" ? result.stdout : result.stderr).push(e.line ?? "");
      onLine?.(e.t, e.line ?? "");
    } else if (e.t === "exit") result.exitCode = e.code ?? 255;
    else if (e.t === "error") {
      result.exitCode = e.code ?? 255;
      result.error = e.message ?? "SSH connection failed";
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf);
  return result;
}

/** PHP's trim() character list. */
const phpTrim = (s: string) => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");

/** excludeCertainErrors(): the message instant_remote_process throws for a failed batch. */
export function remoteErrorMessage(stderr: string, exitCode: number): string {
  let message = phpTrim(stderr);
  if (!message) message = `SSH command failed with exit code: ${exitCode}`;
  if (exitCode === 255 && message.includes("Host key verification failed")) message = HOST_KEY_CHANGED_MESSAGE;
  return message;
}

export class RemoteProcessError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

/** instant_remote_process(): the batch's output, or throw (when throwError) like Coolify. */
export async function instantRemoteProcess(fetcher: ExecutorFetch, conn: ExecutorConn, commands: string[], opts: { throwError?: boolean; timeout?: number } = {}): Promise<{ output: string | null; hostKey: string | null }> {
  const r = await execBatch(fetcher, conn, commands, opts.timeout);
  if (r.error) {
    if (opts.throwError === false) return { output: null, hostKey: r.hostKey };
    throw new RemoteProcessError(r.error, r.exitCode);
  }
  if (r.exitCode !== 0) {
    if (opts.throwError === false) return { output: null, hostKey: r.hostKey };
    throw new RemoteProcessError(remoteErrorMessage(r.stderr.join("\n"), r.exitCode), r.exitCode);
  }
  const output = phpTrim(r.stdout.join("\n"));
  return { output: output === "null" ? null : sanitize_utf8_text(output), hostKey: r.hostKey };
}
