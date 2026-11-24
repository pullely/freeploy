// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/applications.php (GIT_PINNED_HOST_KEYS,
// GIT_PROVIDER_HOST_KEY_SOURCES, isValidGitKnownHostsLine, gitKnownHostsLineHosts, gitPinnedHosts,
// gitHostsWithPublishedKeys, gitKnownHostsLineHasHostWithPublishedKeys, gitKnownHostsLines,
// gitKnownHostFingerprint) (Apache-2.0), modified.
//
// The SSH host keys git accepts: the keys GitHub, GitLab.com and Bitbucket
// Cloud publish (pinned, as Coolify ships them), and the rules of the
// known_hosts lines an application saves for any other host.

/** GIT_PINNED_HOST_KEYS: `host[,host] key-type key`, as the providers publish them. */
export const GIT_PINNED_HOST_KEYS: readonly string[] = [
  "github.com,ssh.github.com,[ssh.github.com]:443 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "github.com,ssh.github.com,[ssh.github.com]:443 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "github.com,ssh.github.com,[ssh.github.com]:443 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=",
  "gitlab.com,[altssh.gitlab.com]:443 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf",
  "gitlab.com,[altssh.gitlab.com]:443 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBFSMqzJeV9rUzU4kWitGjeR4PWSa29SPqJ1fVkhtj3Hw9xjLVXVYrU9QlYWrOLXBpQ6KWjbjTDTdDkoohFzgbEY=",
  "gitlab.com,[altssh.gitlab.com]:443 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQCsj2bNKTBSpIYDEGk9KxsGh3mySTRgMtXL583qmBpzeQ+jqCMRgBqB98u3z++J1sKlXHWfM9dyhSevkMwSbhoR8XIq/U0tCNyokEi/ueaBMCvbcTHhO7FcwzY92WK4Yt0aGROY5qX2UKSeOvuP4D6TPqKF1onrSzH9bx9XUf2lEdWT/ia1NEKjunUqu1xOB/StKDHMoX4/OKyIzuS0q/T1zOATthvasJFoPrAjkohTyaDUz2LN5JoH839hViyEG82yB+MjcFV5MU3N1l1QL3cVUCh93xSaua1N85qivl+siMkPGbO5xR/En4iEY6K2XPASUEMaieWVNTRCtJ4S8H+9",
  "bitbucket.org,[altssh.bitbucket.org]:443 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIazEu89wgQZ4bqs3d63QSMzYVa0MuJ2e2gKTKqu+UUO",
  "bitbucket.org,[altssh.bitbucket.org]:443 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBPIQmuzMBuKdWeF4+a2sjSSpBK0iqitSQ+5BM9KhpexuGt20JpTVM7u5BDZngncgrqDMbWdxMWWOGtZ9UgbqgZE=",
  "bitbucket.org,[altssh.bitbucket.org]:443 ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDQeJzhupRu0u0cdegZIa8e86EG2qOCsIsD1Xw0xSeiPDlCr7kq97NLmMbpKTX6Esc30NuoqEEHCuc7yWtwp8dI76EEEB1VqY9QJq6vk+aySyboD5QF61I/1WeTwu+deCbgKMGbUijeXhtfbxSxm6JwGrXrhBdofTsbKRUsrN1WoNgUa8uqN1Vx6WAJw1JHPhglEGGHea6QICwJOAr/6mrui/oB7pkaWKHj3z7d1IC4KWLtY47elvjbaTlkN04Kc/5LFEirorGYVbt15kAUlqGM65pk6ZBxtaO3+30LVlORZkxOh+LKL/BvbZ/iRNhItLqNyieoQj/uh/7Iv4uyH/cV/0b4WDSd3DptigWq84lJubb9t/DnZlrJazxyDCulTmKdOR7vs9gMTo+uoIrPSb8ScTtvw65+odKAlBj59dhnVp9zd7QUojOpXlL62Aw56U4oO+FALuevvMjiWeavKhJqlR7i5n9srYcrNV7ttmDw7kf/97P5zauIhxcjX+xHv4M=",
];

/** GIT_PROVIDER_HOST_KEY_SOURCES: the host lists of the providers that publish their keys over HTTPS. */
export const PROVIDER_HOST_KEY_SOURCES: Readonly<Record<string, string>> = {
  "github.com,ssh.github.com,[ssh.github.com]:443": "https://api.github.com/meta",
  "bitbucket.org,[altssh.bitbucket.org]:443": "https://bitbucket.org/site/ssh",
};

const HOST = "(?:[A-Za-z0-9._:-]+|\\[[A-Za-z0-9._:-]+\\]:[0-9]{1,5})";
const KEY_TYPE = "(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\\.com|sk-ecdsa-sha2-nistp256@openssh\\.com)";
const LINE_RE = new RegExp(`^${HOST}(?:,${HOST})* ${KEY_TYPE} [A-Za-z0-9+/]+={0,2}$`);

/** isValidGitKnownHostsLine(): `host[,host] key-type key`, without markers, hashed names or comments. */
export function isValidKnownHostsLine(line: string): boolean {
  return !line.includes("\n") && LINE_RE.test(line);
}

/** gitKnownHostsLineHosts(): the host names of a line, lower case, without brackets and ports. */
export function knownHostsLineHosts(line: string): string[] {
  return (line.split(" ")[0] ?? "").split(",").map((host) => host.replace(/^\[(.+)\]:[0-9]+$/, "$1").toLowerCase());
}

const unique = (values: string[]): string[] => [...new Set(values)];

/** gitPinnedHosts() */
export const pinnedHosts = (): string[] => unique(GIT_PINNED_HOST_KEYS.flatMap(knownHostsLineHosts));

/** gitHostsWithPublishedKeys(): saved keys are not used for these hosts. */
export const hostsWithPublishedKeys = (): string[] => unique(Object.keys(PROVIDER_HOST_KEY_SOURCES).flatMap(knownHostsLineHosts));

/** gitKnownHostsLineHasHostWithPublishedKeys() */
export function lineHasHostWithPublishedKeys(line: string): boolean {
  const published = hostsWithPublishedKeys();
  return knownHostsLineHosts(line).some((host) => published.includes(host));
}

/** PCRE's \R: a line break of any kind (CRLF, LF, VT, FF, CR, NEL, LS, PS). */
const LINE_BREAK = new RegExp(`\\r\\n|[\\n\\v\\f\\r${String.fromCharCode(0x85, 0x2028, 0x2029)}]`);

/** A text's lines as submit() reads them: split on `\R`, trimmed, inner whitespace collapsed. */
export function normalizedLines(text: string | null | undefined): string[] {
  return (text ?? "").split(LINE_BREAK).map((line) => line.trim().replace(/\s+/g, " "));
}

/** gitKnownHostsLines(): the valid lines of a text, without blanks, duplicates and the hosts with published keys. */
export function knownHostsLines(text: string | null | undefined): string[] {
  return unique(normalizedLines(text).filter((line) => isValidKnownHostsLine(line) && !lineHasHostWithPublishedKeys(line)));
}

export interface HostKeyFingerprint {
  host: string;
  type: string;
  fingerprint: string;
}

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** PHP's base64_decode() without strict: what is not in the alphabet is skipped. */
function base64Bytes(value: string): Uint8Array<ArrayBuffer> {
  const clean = value.replace(/[^A-Za-z0-9+/]/g, "");
  const binary = atob(clean.length % 4 === 1 ? clean.slice(0, -1) : clean);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** gitKnownHostFingerprint(): the SHA256 fingerprint as `ssh-keygen -lf` shows it. */
export async function knownHostFingerprint(line: string): Promise<HostKeyFingerprint> {
  const [host = "", type = "", key = ""] = line.split(" ");
  const digest = await crypto.subtle.digest("SHA-256", base64Bytes(key));
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/=+$/, "");
  return { host, type, fingerprint: `SHA256:${base64}` };
}

/** PHP's sha1() of a line: what identifies a saved host key on the page. */
export async function lineId(line: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(line)));
}
