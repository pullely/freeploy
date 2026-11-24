# ssh-executor

The SSH side of Freeploy's server management (freeploy-coolify-parity DP4): a
small Go service, run as a Cloudflare Container, reachable only from the
`SshSession` Durable Object in `deploy-core-worker`. It does what Coolify does
with the `ssh` binary (`SshMultiplexingHelper`, `remoteProcess.php`): the batch
runs through Coolify's `remoteShellCommand()` with the commands on stdin, no
agent, forwarding or TTY, Coolify's timeouts, and host keys trusted on first
use, then pinned.

    GET  /health
    POST /exec    { conn, commands[], timeout }        → NDJSON: hostkey, out, err, exit | error
    POST /upload  { conn, path, contentBase64, mode }  → { exit, hostkey, error? }

It keeps no state and never logs a request (bodies carry private keys).

    go test ./...                  # against an in-process SSH server
    docker build -t ssh-executor . # linux/amd64, distroless
