// SshSession (freeploy-coolify-parity DP4): one Durable Object per server, backed
// by a Cloudflare Container running apps/ssh-executor. It replaces Coolify's
// per-server SSH multiplexing (SshMultiplexingHelper: one ControlMaster per
// server, kept for an hour) with one executor instance per server that sleeps
// after ten idle minutes. Callers address it by server id:
//   env.SSH_SESSION.get(env.SSH_SESSION.idFromName(serverId)).fetch(...)
import { Container } from "@cloudflare/containers";

export class SshSession extends Container {
  // ssh-executor listens on 8080 (apps/ssh-executor/main.go).
  defaultPort = 8080;
  sleepAfter = "10m";
}

/** An ExecutorFetch (executor.ts) for one server's session. */
export function sessionFetcher(ns: DurableObjectNamespace<SshSession>, serverId: string) {
  const stub = ns.get(ns.idFromName(serverId));
  return (path: string, init: { method: "POST"; body: string; headers: Record<string, string> }) =>
    stub.fetch(new Request(`http://ssh-executor${path}`, init));
}
