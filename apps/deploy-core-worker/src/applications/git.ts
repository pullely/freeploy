// Derived from coollabsio/coolify@91b7e3e:app/Rules/{ValidGitRepositoryUrl,ValidGitBranch}.php,
// bootstrap/helpers/shared.php (parseScpStyleGitUrl, sshGitUrlToHttps, generate_application_name) and
// app/Livewire/Project/New/PublicGitRepository.php (loadBranch's URL normalization, getGitSource)
// (Apache-2.0), modified.
//
// Git repository URLs and branch names as Coolify checks and reads them. The
// rules answer the message Laravel would show, with :attribute already
// replaced; PHP's empty() lets "", "0" and null pass every rule here.
import { generateRandomName, kebab, newPublicId } from "../helpers/names.js";
import { isIpv4, parseIpv6 } from "../servers/ip.js";
import { filterValidateUrl, parseUrl } from "./domains.js";

/** PHP's empty() for the values these rules see. */
const empty = (value: unknown): boolean => value === null || value === undefined || value === "" || value === "0" || value === 0 || value === false;

/** ValidGitRepositoryUrl's $dangerousChars ('\n', '\r' and '\0' are two-character strings in PHP's single quotes). */
const REPOSITORY_DANGEROUS_CHARS = [";", "|", "&", "$", "`", "(", ")", "{", "}", "[", "]", "<", ">", "\\n", "\\r", "\\0", '"', "'", "\\", "!", "?", "*", "^", "%", "=", "+", "#"];

/** ValidGitRepositoryUrl's $dangerousPatterns. */
const REPOSITORY_DANGEROUS_PATTERNS = [/\$\(.*\)/, /\$\{.*\}/, /;;/, /&&/, /\|\|/, />>/, /<</, /\\n/, /\.\.[/\\]/];

/** PHP's rawurldecode(): every %XX is its byte; anything else stays. */
const rawUrlDecode = (value: string): string => value.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));

/**
 * FILTER_VALIDATE_IP passes and FILTER_FLAG_NO_RES_RANGE fails: 0.0.0.0/8,
 * 169.254.0.0/16, 127.0.0.0/8 and 240.0.0.0/4; ::1, ::, ::ffff:0:0/96 and
 * fe80::/10.
 */
function isReservedIp(host: string): boolean {
  if (isIpv4(host)) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 0 || a === 127 || a >= 240 || (a === 169 && b === 254);
  }
  const words = parseIpv6(host);
  if (!words) return false;
  const leadingZeros = words.slice(0, 5).every((w) => w === 0);
  if (words.slice(0, 7).every((w) => w === 0) && (words[7] === 0 || words[7] === 1)) return true;
  if (leadingZeros && words[5] === 0xffff) return true;
  return (words[0]! & 0xffc0) === 0xfe80;
}

export interface ScpStyleGitUrl {
  user: string;
  host: string;
  port: string | null;
  path: string;
}

/** parseScpStyleGitUrl(): `user@host:path` or `user@host:port/path`. */
export function parseScpStyleGitUrl(gitRepository: string | null | undefined): ScpStyleGitUrl | null {
  if (typeof gitRepository !== "string" || gitRepository === "") return null;
  const m = gitRepository.match(/^([A-Za-z0-9._-]+)@(\[[0-9A-Fa-f:.]+\]|[^:[\]]+):(?:(\d+)\/)?(.+)$/);
  if (!m) return null;
  const host = m[2]!.trim();
  const path = m[4]!.replace(/^\/+/, "");
  if (host === "" || path === "") return null;
  return { user: m[1]!, host, port: m[3] === undefined || m[3] === "" ? null : m[3], path };
}

/** sshGitUrlToHttps(): the https URL of an ssh:// or scp-style repository, or null. */
export function sshGitUrlToHttps(gitRepository: string | null | undefined): string | null {
  if (typeof gitRepository === "string" && gitRepository.startsWith("ssh://")) {
    const parts = parseUrl(gitRepository);
    const host = parts?.host ?? "";
    const path = (parts?.path ?? "").replace(/^\/+/, "");
    return host.trim() !== "" && path !== "" ? `https://${host}/${path}` : null;
  }
  const parts = parseScpStyleGitUrl(gitRepository);
  return parts === null ? null : `https://${parts.host}/${parts.path}`;
}

/**
 * ValidGitRepositoryUrl (allowSSH and allowIP as its defaults): the message
 * for `attribute`, or null. `allowRepositoryPath` also accepts `owner/name`,
 * which applications with a Git source store.
 */
export function gitRepositoryUrlError(attribute: string, value: unknown, allowRepositoryPath = false): string | null {
  if (empty(value) || typeof value !== "string") return null;
  const invalidCharacters = `The ${attribute} contains invalid characters.`;

  // Brackets are only allowed around an IPv6 host, so the rest of the URL is checked without it.
  const withoutIpv6Host = value.replace(/^((?:https?|git):\/\/|(?:ssh:\/\/)?[a-zA-Z0-9._-]+@)\[([0-9A-Fa-f:.]+)\]/, (match, prefix: string, address: string) =>
    parseIpv6(address) ? `${prefix}ipv6-host` : match,
  );
  const decoded = rawUrlDecode(withoutIpv6Host);
  if (/[\x00-\x1F\x7F]/.test(decoded)) return invalidCharacters;
  if (REPOSITORY_DANGEROUS_CHARS.some((c) => decoded.includes(c))) return invalidCharacters;
  if (REPOSITORY_DANGEROUS_PATTERNS.some((p) => p.test(decoded))) return `The ${attribute} contains invalid patterns.`;

  if (/^[a-zA-Z0-9._-]+@(\[[0-9A-Fa-f:.]+\]|[a-zA-Z0-9.-]+):/.test(value)) {
    const scp = parseScpStyleGitUrl(value);
    if (scp === null || !/^(\[[0-9A-Fa-f:.]+\]|[a-zA-Z0-9.-]+)$/.test(scp.host) || !/^[a-zA-Z0-9\-_/.~%]+$/.test(scp.path)) return `The ${attribute} is not a valid SSH repository URL.`;
    return null;
  }
  if (value.startsWith("ssh://")) {
    return /^ssh:\/\/[a-zA-Z0-9._-]+@(\[[0-9A-Fa-f:.]+\]|[a-zA-Z0-9.-]+)(:[0-9]{1,5})?\/[a-zA-Z0-9\-_/.~%]+$/.test(value) ? null : `The ${attribute} is not a valid SSH repository URL.`;
  }
  if (value.startsWith("http://") || value.startsWith("https://")) {
    if (!filterValidateUrl(value)) return `The ${attribute} is not a valid URL.`;
    const parsed = parseUrl(value) ?? {};
    // parse_url() keeps the brackets around an IPv6 host.
    const host = (parsed.host ?? "").toLowerCase().replace(/^[[\]]+|[[\]]+$/g, "");
    if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(host) || isReservedIp(host) || host.endsWith(".local")) return `The ${attribute} cannot point to internal hosts.`;
    // Percent-encoding is only allowed in the path.
    if (`${parsed.host ?? ""}${parsed.user ?? ""}${parsed.pass ?? ""}`.includes("%")) return invalidCharacters;
    if ((parsed.query ?? "") !== "" || (parsed.fragment ?? "") !== "") return `The ${attribute} should not contain query parameters or fragments.`;
    const path = parsed.path ?? "";
    if (path !== "" && !/^[a-zA-Z0-9\-_/.@~%]+$/.test(path)) return `The ${attribute} path contains invalid characters.`;
    return null;
  }
  if (value.startsWith("git://")) {
    return /^git:\/\/(\[[0-9A-Fa-f:.]+\]|[a-zA-Z0-9.-]+)(:[0-9]+)?[:/][a-zA-Z0-9\-_/.~%]+$/.test(value) ? null : `The ${attribute} is not a valid git:// URL.`;
  }
  // A repository path (owner/name, or group/subgroup/name) that the Git source turns into a URL.
  if (allowRepositoryPath && /^[a-zA-Z0-9_][a-zA-Z0-9._-]*(\/[a-zA-Z0-9._-]+)+$/.test(value)) return null;
  return `The ${attribute} must start with https://, http://, git://, ssh://, or be an SSH URL (user@host:path).`;
}

/** ValidGitBranch's $dangerousChars. */
const BRANCH_DANGEROUS_CHARS = [";", "|", "&", "$", "`", "(", ")", "{", "}", "<", ">", "\\n", "\\r", "\\0", '"', "'", "\\", "!", "*", "?", "[", "]", "~", "^", ":", " ", "#"];

/** PHP's trim(): spaces, tabs, newlines, carriage returns, NUL and vertical tabs. */
export const phpTrim = (value: string): string => value.replace(/^[ \t\n\r\0\v]+|[ \t\n\r\0\v]+$/g, "");

/** ValidGitBranch: the message for `attribute`, or null. */
export function gitBranchError(attribute: string, value: unknown): string | null {
  if (empty(value) || typeof value !== "string") return null;
  const branch = phpTrim(value);
  if (BRANCH_DANGEROUS_CHARS.some((c) => branch.includes(c))) return `The ${attribute} contains invalid characters.`;
  if (branch.includes("..") || branch.includes("//") || branch.includes("@{")) return `The ${attribute} contains invalid patterns.`;
  if (branch.startsWith("/") || branch.endsWith("/") || branch.startsWith(".") || branch.endsWith(".")) return `The ${attribute} cannot start or end with / or .`;
  if (!/^[a-zA-Z0-9\-_/.]+$/.test(branch)) return `The ${attribute} contains invalid characters. Only letters, numbers, hyphens, underscores, forward slashes, and dots are allowed.`;
  if (branch === "HEAD") return `The ${attribute} cannot be HEAD.`;
  if (branch.endsWith(".lock")) return `The ${attribute} cannot end with .lock.`;
  return null;
}

/**
 * loadBranch()'s first block: an SSH URL reads as its https form; an http(s)
 * URL that does not end in ".git" gets it — the condition Coolify writes
 * ("does not contain github.com, or does not contain git.sr.ht") holds for
 * every URL, tangled ones apart — and a github.com URL then loses it again.
 */
export function normalizeRepositoryUrl(repositoryUrl: string): string {
  let url = sshGitUrlToHttps(repositoryUrl) ?? repositoryUrl;
  if ((url.startsWith("https://") || url.startsWith("http://")) && !url.endsWith(".git") && (!url.includes("github.com") || !url.includes("git.sr.ht")) && !url.includes("tangled")) url += ".git";
  if (url.includes("github.com") && url.endsWith(".git")) url = url.slice(0, url.lastIndexOf(".git"));
  return url;
}

export interface GitSourceOfUrl {
  gitHost: string;
  /** `owner/name` for github.com; the whole URL for any other host. */
  gitRepository: string;
  /** The branch the URL names (…/tree/<branch>), else 'main'. For GitHub it may still carry a directory. */
  gitBranch: string;
  /** 'github': Coolify's public GitHub source; 'other': no source. */
  gitSource: "github" | "other";
}

/** Spatie\Url's path segments: the path split on "/", empty parts left out. */
const segments = (path: string): string[] => path.split("/").filter((s) => s !== "");

/** getGitSource(): the host, the repository and the branch of a normalized repository URL. */
export function gitSourceOfUrl(repositoryUrl: string): GitSourceOfUrl {
  const parsed = parseUrl(repositoryUrl) ?? {};
  const gitHost = parsed.host ?? "";
  const path = parsed.path ?? "";
  const parts = segments(path);
  let gitBranch = "main";
  if (parts[2] === "tree") {
    // str($path)->trim('/')->after('tree/')
    const trimmed = path.replace(/^\/+|\/+$/g, "");
    const at = trimmed.indexOf("tree/");
    gitBranch = at === -1 ? trimmed : trimmed.slice(at + "tree/".length);
  }
  if (gitHost === "github.com") return { gitHost, gitRepository: `${parts[0] ?? ""}/${parts[1] ?? ""}`, gitBranch, gitSource: "github" };
  return { gitHost, gitRepository: repositoryUrl, gitBranch, gitSource: "other" };
}

/**
 * generate_application_name(): "<repository name>:<branch>-<cuid>" in kebab
 * case, without the characters a name may not hold; a name that ends up
 * shorter than three characters is a random one.
 */
export function generateApplicationName(gitRepository: string, gitBranch: string, cuid: string = newPublicId()): string {
  const repositoryName = gitRepository.includes("/") ? gitRepository.slice(gitRepository.lastIndexOf("/") + 1) : gitRepository;
  const name = kebab(`${repositoryName}:${gitBranch}-${cuid}`).replace(/[^\p{L}\p{M}\p{N}\s\-_.@/&()#,:+]+/gu, "");
  return name === "" || name === "0" || [...name].length < 3 ? generateRandomName(cuid) : name;
}
