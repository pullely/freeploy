// The deployment engine's executor over apps/ssh-executor (DP4): one /exec batch for each process the engine
// starts. Coolify starts an SSH process for each command, with the command batch on the remote shell's stdin;
// the executor does the same with `commands`.
//
// One thing differs from Coolify, in transport only. Where Coolify gives a command content on its stdin (the
// compose file into `tee`), it runs that one command as the SSH command and writes the content to the SSH
// process. The executor has no such call yet, so the content travels inside the batch: base64 in the script,
// decoded on the server and piped into the same command — as Coolify itself writes the .env file.
import { execBatch, type ExecutorConn, type ExecutorFetch } from "../executor.js";
import type { DeploymentExecutor } from "./engine.js";
import { base64Encode } from "./php.js";

/** A command with content for its stdin, as one line of a batch. */
export function withStdin(command: string, input: string): string {
  return `echo '${base64Encode(input)}' | base64 -d | ${command}`;
}

/** The executor of one server's SshSession. `timeout`: seconds a batch may run (the server's deployment timeout). */
export function sessionExecutor(fetcher: ExecutorFetch, conn: ExecutorConn, timeout?: number): DeploymentExecutor {
  return {
    async run(process, onOutput) {
      const script = process.input === undefined ? process.script : withStdin(process.script, process.input);
      // The executor hands lines over as they arrive; the engine's log writes are awaited in that order.
      let delivered: Promise<void> = Promise.resolve();
      const result = await execBatch(fetcher, conn, [script], timeout, (stream, line) => {
        delivered = delivered.then(() => onOutput?.(stream, line + "\n"));
      });
      await delivered;
      const joined = (lines: string[]): string => (lines.length ? lines.join("\n") + "\n" : "");
      if (result.error !== null) {
        // A connection that failed never ran the command: the error is what ssh would print.
        await onOutput?.("err", result.error + "\n");
        return { exitCode: result.exitCode === 0 ? 255 : result.exitCode, stdout: joined(result.stdout), stderr: joined(result.stderr) + result.error + "\n" };
      }
      return { exitCode: result.exitCode, stdout: joined(result.stdout), stderr: joined(result.stderr) };
    },
  };
}

/**
 * An ExecutorFetch for one server's SshSession, addressed by the server's uuid — ssh-session.ts's
 * sessionFetcher(), without importing the Durable Object's class (and its container runtime) here.
 */
export function sessionFetch(namespace: { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): { fetch(request: Request): Promise<Response> } }, serverUuid: string): ExecutorFetch {
  const stub = namespace.get(namespace.idFromName(serverUuid));
  return (path, init) => stub.fetch(new Request(`http://ssh-executor${path}`, init));
}
