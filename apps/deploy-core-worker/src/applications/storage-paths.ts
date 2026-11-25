// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/shared.php (base_configuration_dir,
// application_configuration_dir, validateShellSafePath, validateFileMountPath, validateHostFileMountPath,
// confineFileMountPath, normalizeUnixPath), app/Models/LocalFileVolume.php (resolveHostPath,
// resourceDirectoryContaining, resolvedFsPath, isOutsideResourceDirectory) and app/Models/Application.php
// (workdir) (Apache-2.0), modified.
//
// The path rules of file and directory mounts. All of it is lexical: nothing
// here looks at a server. Each rule throws Coolify's exception text.

/** An \Exception Coolify throws while it checks a path; handleError() shows its message. */
export class StoragePathError extends Error {}

/** application_configuration_dir(): where Coolify keeps an application's files on the server. */
export const APPLICATION_CONFIGURATION_DIR = "/data/coolify/applications";

/** Application::workdir() */
export const applicationWorkdir = (uuid: string): string => `${APPLICATION_CONFIGURATION_DIR}/${uuid}`;

/** validateShellSafePath()'s forbidden characters, in its order. */
const DANGEROUS: ReadonlyArray<[string, string]> = [
  ["`", "backtick (command substitution)"],
  ["$(", "command substitution"],
  ["${", "variable substitution with potential command injection"],
  ["|", "pipe operator"],
  ["&", "background/AND operator"],
  [";", "command separator"],
  ["\n", "newline (command separator)"],
  ["\r", "carriage return"],
  ["\t", "tab (token separator)"],
  [">", "output redirection"],
  ["<", "input redirection"],
];

/** validateShellSafePath(): the input unchanged, or the exception for its first forbidden character. */
export function validateShellSafePath(input: string, context = "path"): string {
  for (const [char, description] of DANGEROUS) {
    if (input.includes(char)) {
      throw new StoragePathError(`Invalid ${context}: contains forbidden character '${char}' (${description}). Shell metacharacters are not allowed for security reasons.`);
    }
  }
  return input;
}

/** PHP's trim(): spaces, tabs, newlines, carriage returns, NUL and vertical tabs. */
export const phpTrim = (value: string): string => value.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");

const hasRelativeSegment = (path: string): boolean =>
  path
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .some((segment) => segment === "." || segment === "..");

/** validateFileMountPath(): a container path, with one leading slash and no doubled ones. */
export function validateFileMountPath(input: string, context = "file mount path"): string {
  validateShellSafePath(input, context);
  if (input.includes("\0")) throw new StoragePathError(`Invalid ${context}: contains null byte. Null bytes are not allowed in file mount paths for security reasons.`);
  if (input.includes("\\")) throw new StoragePathError(`Invalid ${context}: backslash directory separators are not allowed.`);
  const trimmed = phpTrim(input);
  const path = (trimmed.startsWith("/") ? trimmed : `/${trimmed}`).replace(/\/+/g, "/");
  if (hasRelativeSegment(path)) throw new StoragePathError(`Invalid ${context}: relative path segments ('.' or '..') are not allowed.`);
  return path;
}

/** normalizeUnixPath(): "." and ".." resolved lexically; an absolute path cannot climb above the root. */
export function normalizeUnixPath(path: string): string {
  validateShellSafePath(path, "path");
  if (path.includes("\0")) throw new StoragePathError("Invalid path: contains null byte.");
  if (path.includes("\\")) throw new StoragePathError("Invalid path: backslash directory separators are not allowed.");
  const absolute = path.startsWith("/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length || segments[segments.length - 1] === "..") {
        if (absolute) throw new StoragePathError("Invalid path: resolved path escapes the base directory.");
        segments.push(segment);
        continue;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const normalized = segments.join("/");
  if (absolute) return normalized === "" ? "/" : `/${normalized}`;
  return normalized === "" ? "." : normalized;
}

/** validateHostFileMountPath(): an absolute path on the host that names a file. */
export function validateHostFileMountPath(input: string, context = "host file path"): string {
  validateShellSafePath(input, context);
  if (input.includes("\0")) throw new StoragePathError(`Invalid ${context}: contains null byte.`);
  if (input.includes("\\")) throw new StoragePathError(`Invalid ${context}: backslash directory separators are not allowed.`);
  const path = phpTrim(input).replace(/\/+/g, "/");
  if (path === "" || !path.startsWith("/")) throw new StoragePathError(`Invalid ${context}: must be an absolute path.`);
  if (path === "/" || path.endsWith("/")) throw new StoragePathError(`Invalid ${context}: must point to a file, not a directory.`);
  if (hasRelativeSegment(path)) throw new StoragePathError(`Invalid ${context}: relative path segments ('.' or '..') are not allowed.`);
  return normalizeUnixPath(path);
}

const inside = (path: string, directory: string): boolean => path === directory || path.startsWith(`${directory}/`);

/** confineFileMountPath(): the container path below the resource directory. */
export function confineFileMountPath(baseDirectory: string, path: string, context = "file mount path"): string {
  const base = normalizeUnixPath(baseDirectory);
  const resolved = normalizeUnixPath(`${base}/${validateFileMountPath(path, context)}`);
  if (!inside(resolved, base)) throw new StoragePathError(`Invalid ${context}: resolved path must stay inside the resource configuration directory.`);
  return resolved;
}

/**
 * LocalFileVolume::resolveHostPath(): a host path a user gave — absolute
 * anywhere on the host, or relative to the resource directory, where it must
 * stay.
 */
export function resolveHostPath(resourceDirectory: string, input: string, context = "storage path"): string {
  const directory = normalizeUnixPath(resourceDirectory);
  const path = phpTrim(input);
  if (path === "") throw new StoragePathError(`Invalid ${context}: the path is empty.`);
  if (path.startsWith("~")) throw new StoragePathError(`Invalid ${context}: use an absolute path instead of ~.`);
  validateShellSafePath(path, context);
  const absolute = path.startsWith("/");
  const resolved = normalizeUnixPath(absolute ? path : `${directory}/${path}`);
  if (inside(resolved, directory)) return resolved;
  if (!absolute) throw new StoragePathError(`Invalid ${context}: a relative path must stay inside the resource directory.`);
  if (path.split("/").some((segment) => segment === "." || segment === "..")) throw new StoragePathError(`Invalid ${context}: '.' and '..' segments are not allowed.`);
  if (resolved === "/") throw new StoragePathError(`Invalid ${context}: the root directory cannot be mounted.`);
  return resolved;
}

/** LocalFileVolume::resolvedFsPath(): the stored host path as commands use it (a relative one is inside the workdir). */
export function resolvedFsPath(fsPath: string, workdir: string): string {
  let path = phpTrim(fsPath);
  if (!path.startsWith("/") && !path.startsWith("~")) {
    if (path.startsWith(".")) path = path.slice(1);
    path = path.replace(/^\/+/, "");
    path = workdir.replace(/\/+$/, "") + (path === "" ? "" : `/${path}`);
  }
  return path;
}

/** LocalFileVolume::isOutsideResourceDirectory(): a path that cannot be resolved counts as outside. */
export function isOutsideResourceDirectory(fsPath: string, workdir: string): boolean {
  try {
    const path = normalizeUnixPath(resolvedFsPath(fsPath, workdir));
    return path.startsWith("~") || !inside(path, normalizeUnixPath(workdir));
  } catch {
    return true;
  }
}

/** Whether a resolved host path is the resource directory or below it (resourceDirectoryContaining). */
export function isInsideResourceDirectory(path: string, workdir: string): boolean {
  return inside(path, normalizeUnixPath(workdir));
}
