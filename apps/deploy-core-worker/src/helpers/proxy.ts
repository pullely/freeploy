// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/proxy.php (Apache-2.0), modified: TypeScript ports, byte-equal to Coolify's output (held by tools/parity/commands goldens).
//
// escapeShellValue() (docker.php) and PHP's escapeshellarg() are repeated here
// instead of imported: helpers/ files do not import each other (see docker.ts).

function escapeshellarg(value: string): string {
  if (value.includes("\0")) {
    throw new Error("escapeshellarg(): Argument #1 ($arg) must not contain any null bytes");
  }
  return "'" + value.split("'").join("'\\''") + "'";
}

/** bootstrap/helpers/docker.php escapeShellValue(). */
function escapeShellValue(value: string): string {
  return "'" + value.split("'").join("'\\''") + "'";
}

/** App\Support\ValidationPatterns::DOCKER_NETWORK_PATTERN; `\n?` because PCRE's `$` also matches before a final newline. */
const DOCKER_NETWORK_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\n?$/;

export function traefikAccessLogCommands(enabled: boolean): string[] {
  if (!enabled) return [];
  return [
    "--accesslog=true",
    "--accesslog.filepath=/traefik/access.log",
    "--accesslog.format=json",
    "--accesslog.fields.headers.names.Cf-Connecting-Ip=keep",
    "--accesslog.fields.headers.names.Cf-Ipcountry=keep",
    "--accesslog.fields.headers.names.Cf-Cache-Status=keep",
    "--accesslog.fields.headers.names.Cf-Verified-Bot=keep",
    "--accesslog.fields.headers.names.Cf-Ray=keep",
    // Kept so Sentinel can resolve the real client IP behind a non-Cloudflare
    // reverse proxy (leftmost X-Forwarded-For entry) and report User-Agents/referrers.
    "--accesslog.fields.headers.names.X-Forwarded-For=keep",
    "--accesslog.fields.headers.names.User-Agent=keep",
    "--accesslog.fields.headers.names.Referer=keep",
  ];
}

export function traefikAccessLogRotationScript(): string {
  return [
    'log="${TRAEFIK_ACCESS_LOG:-/traefik/access.log}"',
    'max_bytes="${TRAEFIK_ACCESS_LOG_MAX_BYTES:-20971520}"',
    'interval="${TRAEFIK_ACCESS_LOG_ROTATE_INTERVAL:-60}"',
    "keep=5",
    "while true; do",
    '  size=$(stat -c %s "$log" 2>/dev/null || echo 0)',
    '  if [ "$size" -gt "$max_bytes" ]; then',
    '    rm -f "$log.$keep.gz"',
    "    i=$((keep - 1))",
    '    while [ "$i" -ge 1 ]; do',
    '      if [ -f "$log.$i.gz" ]; then mv -f "$log.$i.gz" "$log.$((i + 1)).gz"; fi',
    "      i=$((i - 1))",
    "    done",
    '    if cp "$log" "$log.1"; then',
    '      : > "$log"',
    '      gzip -f "$log.1"',
    "    fi",
    "  fi",
    '  sleep "$interval"',
    "done",
  ].join("\n");
}

export function isDockerPredefinedNetwork(network: string): boolean {
  // Only filter 'default' and 'host' to match existing codebase patterns.
  return network === "default" || network === "host";
}

export function isUsableDockerNetworkName(network: unknown): boolean {
  return typeof network === "string" && network !== "" && !isDockerPredefinedNetwork(network) && DOCKER_NETWORK_PATTERN.test(network);
}

export function dockerNetworkEnsureCommand(network: string, overlay = false, quietCreate = false): string {
  const safe = escapeshellarg(network);
  const createFlags = overlay ? "--driver overlay --attachable" : "--attachable";
  const quiet = quietCreate ? " >/dev/null" : "";
  return `docker network inspect ${safe} >/dev/null 2>&1 || docker network create ${createFlags} ${safe}${quiet}`;
}

export function dockerProxyNetworkEnsureCommand(network: string): string {
  const script =
    "net=" +
    escapeshellarg(network) +
    "\n" +
    [
      'docker network inspect "$net" >/dev/null 2>&1 && exit 0',
      'if docker network create --attachable --ipv6 "$net" >/dev/null 2>&1; then',
      "    case \"$(docker network inspect --format '{{range .IPAM.Config}}{{.Gateway}} {{end}}' \"$net\" 2>/dev/null)\" in",
      '        */*) docker network rm "$net" >/dev/null 2>&1 && docker network create --attachable "$net" >/dev/null ;;',
      "    esac",
      "else",
      '    docker network create --attachable "$net" >/dev/null',
      "fi",
      "exit 0",
    ].join("\n");
  return "sh -c " + escapeShellValue(script);
}
