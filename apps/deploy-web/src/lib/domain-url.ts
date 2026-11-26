// Derived from coollabsio/coolify@91b7e3e:app/Support/DomainUrlParts.php and
// app/Models/S3Storage.php (detectPathStyleEndpoint) (Apache-2.0), modified.
//
// The parts of <x-forms.domain-input> (protocol, host, port, path) and the URL
// they make; and the URL style a new S3 endpoint starts with.

export interface DomainUrlParts {
  scheme: string;
  host: string;
  port: string;
  path: string;
}

export const EMPTY_PARTS: DomainUrlParts = { scheme: "https", host: "", port: "", path: "" };

/** DomainUrlParts::compose() */
export function composeUrl(p: DomainUrlParts): string {
  const scheme = p.scheme.trim().toLowerCase() === "http" ? "http" : "https";
  const host = p.host.trim();
  const port = p.port.trim();
  let path = p.path.trim();
  if (path !== "" && !path.startsWith("/") && !path.startsWith("?") && !path.startsWith("#")) path = "/" + path;
  return `${scheme}://${host}${port !== "" ? `:${port}` : ""}${path}`;
}

/** DomainUrlParts::split(): the parts of a URL with a host, else the empty parts. */
export function splitUrl(url: string | null | undefined): DomainUrlParts {
  const m = url ? /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)(?::(\d*))?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url) : null;
  if (!m || !m[2]) return { ...EMPTY_PARTS };
  const scheme = m[1]!.toLowerCase();
  return {
    scheme: scheme === "http" || scheme === "https" ? scheme : "https",
    host: m[2],
    port: m[3] ?? "",
    path: (m[4] ?? "") + (m[5] ?? "") + (m[6] ?? ""),
  };
}

/** S3Storage::VIRTUAL_HOSTED_STYLE_HOST_SUFFIXES */
const VIRTUAL_HOSTED = ["aliyuncs.com", "myqcloud.com", "volces.com", "bytepluses.com"];

/** S3Storage::detectPathStyleEndpoint(): virtual-hosted style for the providers that reject path-style URLs. */
export function detectPathStyleEndpoint(endpoint: string): boolean {
  const host = splitUrl(endpoint).host.toLowerCase();
  return !VIRTUAL_HOSTED.some((s) => host === s || host.endsWith("." + s));
}
