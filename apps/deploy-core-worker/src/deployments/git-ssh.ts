// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/applications.php (GIT_PINNED_HOST_KEYS, gitSshConfigFile,
// gitKnownHostsFile, isValidGitKnownHostsLine, gitKnownHostsLineHosts, gitPinnedHosts, gitHostsWithPublishedKeys,
// gitKnownHostsLines, gitSshSetupCommand) (Apache-2.0), modified.
//
// The SSH client setup every deployment helper gets, whether the deployment uses git or not: the published host
// keys of the large git hosts, pinned, and the host keys saved for the application. A Docker image deployment
// never runs git, but Coolify writes these two files into its helper all the same, so the command is the same.
//
// Not here: the host keys a provider publishes over HTTPS and "Fetch current host key" stores
// (fetchGitProviderHostKeys, gitProviderHostKeys' cache): Freeploy has no Source page yet, so the pinned list
// is used as it is.
import { base64Encode, phpTrim } from "./php.js";

/**
 * The published SSH host keys of the large git hosts, also for their SSH endpoints on port 443.
 * Git over SSH to these hosts accepts only these keys.
 */
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

/** The providers that publish their SSH host keys over HTTPS: the key is the host list of their lines above. */
const GIT_PROVIDER_HOST_KEY_SOURCES = ["github.com,ssh.github.com,[ssh.github.com]:443", "bitbucket.org,[altssh.bitbucket.org]:443"];

export const gitSshConfigFile = (uuid: string): string => `/root/.ssh/coolify_git_${uuid}.config`;
export const gitKnownHostsFile = (uuid: string): string => `/root/.ssh/coolify_git_${uuid}.known_hosts`;

const HOST = String.raw`(?:[A-Za-z0-9._:-]+|\[[A-Za-z0-9._:-]+\]:[0-9]{1,5})`;
const KEY_TYPE = String.raw`(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)`;
const KNOWN_HOSTS_LINE = new RegExp(`^${HOST}(?:,${HOST})* ${KEY_TYPE} [A-Za-z0-9+/]+={0,2}$`);

/** A known_hosts line without markers, hashed host names, or comments: `host[,host] key-type key`. */
export const isValidGitKnownHostsLine = (line: string): boolean => !line.includes("\n") && KNOWN_HOSTS_LINE.test(line);

/** The host names of a known_hosts line, without brackets and ports. */
export function gitKnownHostsLineHosts(line: string): string[] {
  return (line.split(" ")[0] ?? "").split(",").map((host) => host.replace(/^\[(.+)\]:[0-9]+$/, "$1").toLowerCase());
}

const unique = (values: string[]): string[] => values.filter((v, i) => values.indexOf(v) === i);

/** The host names in GIT_PINNED_HOST_KEYS. */
export const gitPinnedHosts = (): string[] => unique(GIT_PINNED_HOST_KEYS.flatMap(gitKnownHostsLineHosts));

const gitHostsWithPublishedKeys = (): string[] => unique(GIT_PROVIDER_HOST_KEY_SOURCES.flatMap(gitKnownHostsLineHosts));

/** The valid known_hosts lines of a text, without blank lines, duplicates, and lines of the hosts that publish their keys. */
export function gitKnownHostsLines(text: string | null): string[] {
  const published = gitHostsWithPublishedKeys();
  const lines = (text ?? "")
    .split(/\r\n|[\n\v\f\r]/)
    .map((line) => phpTrim(line).replace(/[ \t\n\v\f\r]+/g, " "))
    .filter((line) => isValidGitKnownHostsLine(line) && !gitKnownHostsLineHosts(line).some((host) => published.includes(host)));
  return unique(lines);
}

/**
 * gitSshSetupCommand() for the helper container: write the known_hosts file (the pinned keys, then the
 * application's saved ones) and the SSH config that checks the pinned hosts strictly and trusts any other
 * host on first use.
 */
export function gitSshSetupCommand(uuid: string, knownHosts: string | null = null): string {
  const knownHostsFile = gitKnownHostsFile(uuid);
  const config =
    [`Host ${gitPinnedHosts().join(" ")}`, "    StrictHostKeyChecking yes", "Host *", "    StrictHostKeyChecking accept-new", `    UserKnownHostsFile ${knownHostsFile}`, "    HashKnownHosts no", "    Include ~/.ssh/config /etc/ssh/ssh_config"].join("\n") + "\n";
  const knownHostsContent = [...GIT_PINNED_HOST_KEYS, ...gitKnownHostsLines(knownHosts)].join("\n") + "\n";
  const write = (content: string, file: string): string => `echo '${base64Encode(content)}' | base64 -d | tee ${file} > /dev/null`;
  return "mkdir -p /root/.ssh && " + write(knownHostsContent, knownHostsFile) + " && " + write(config, gitSshConfigFile(uuid));
}
