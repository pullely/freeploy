// Derived from coollabsio/coolify@91b7e3e:app/Actions/Shared/EnsureContentFilesOnServer.php (handle, echoCommands,
// plainText), app/Models/LocalFileVolume.php (hasContentToWrite, contentPathOnServer, saveStorageOnServer for a
// file, remoteFileStateCommand, remoteFileStates, assertRemotePathIsNotSymlink, assertRemotePathIsConfined,
// remotePathConfinementCommand, isOutsideResourceDirectory, REMOTE_FILE_STATE_SCRIPT,
// REMOTE_PATH_CONFINEMENT_SCRIPT) and bootstrap/helpers/remoteProcess.php (instant_remote_process,
// excludeCertainErrors) (Apache-2.0), modified.
//
// `docker compose up` creates a missing bind source as an empty directory. So before a database starts, each of
// its file mounts that has content — a certificate, a key, a configuration file — is written to the server when
// it is missing there. All files are checked with one command; a file is written only when its path is missing
// or is an empty directory; a file that exists is never changed and a directory that is not empty never deleted.
//
// The warnings are Coolify's, word for word, with "Coolify" reading "Freeploy". Only what a standalone database
// needs is here: a file (not a directory mount), owned by the database, on the
// database's one server. Directory mounts, host files and files from a Git repository are never written.
import { StoragePathError, normalizeUnixPath, resolveHostPath, resolvedFsPath, validateShellSafePath } from "../applications/storage-paths.js";
import type { DeploymentExecutor } from "../deployments/engine.js";
import { base64Encode, escapeshellarg, phpTrim } from "../deployments/php.js";
import { sanitize_utf8_text } from "../helpers/remote-process.js";

/** A RuntimeException of instant_remote_process(): the failed batch's error text and exit code. */
export class RemoteCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

/**
 * instant_remote_process(): the batch's trimmed output, null for "null". A failure throws the error text (or
 * its exit code), unless `throwError` is false: then null.
 */
export async function instantRemote(executor: DeploymentExecutor, commands: string[], throwError = true): Promise<string | null> {
  const result = await executor.run({ script: commands.join("\n") });
  if (result.exitCode !== 0) {
    if (!throwError) return null;
    // excludeCertainErrors()
    throw new RemoteCommandError(phpTrim(result.stderr) || `SSH command failed with exit code: ${result.exitCode}`, result.exitCode);
  }
  const output = phpTrim(result.stdout);
  return output === "null" ? null : sanitize_utf8_text(output);
}

/** LocalFileVolume::BINARY_PLACEHOLDER and ::TOO_LARGE_PLACEHOLDER: content Coolify could not load from the server. */
const BINARY_PLACEHOLDER = "[binary file]";
const TOO_LARGE_PLACEHOLDER = "[file too large to display]";

/** LocalFileVolume::REMOTE_FILE_STATE_SCRIPT: prints `<number>:<state>` for each path argument, in order. It only reads. */
const REMOTE_FILE_STATE_SCRIPT = `i=0
for path in "$@"; do
    i=$((i + 1))
    if [ -L "$path" ]; then
        if [ -f "$path" ]; then state=file; else state=other; fi
    elif [ -f "$path" ]; then
        state=file
    elif [ -d "$path" ]; then
        state=directory
        if entries=$(ls -A "$path" 2>/dev/null); then
            if [ -z "$entries" ]; then state=empty-directory; fi
        fi
    elif [ -e "$path" ]; then
        state=other
    else
        state=missing
    fi
    printf "%s:%s\\n" "$i" "$state"
done`;

/** LocalFileVolume::REMOTE_PATH_CONFINEMENT_SCRIPT: OK when the second path, symlinks resolved, is inside the first. */
const REMOTE_PATH_CONFINEMENT_SCRIPT = `resolve() {
    path=$1
    rest=
    case $path in /*) ;; *) return 1 ;; esac
    while [ ! -e "$path" ]; do
        if [ -L "$path" ]; then return 1; fi
        rest=/\${path##*/}$rest
        path=\${path%/*}
        [ -n "$path" ] || path=/
    done
    case "$rest/" in */./*|*/../*) return 1 ;; esac
    path=$(readlink -f "$path") || return 1
    printf "%s\\n" "\${path%/}$rest"
}
base=$(resolve "$1") || exit 1
target=$(resolve "$2") || exit 1
case $target in "$base"|"$base"/*) echo OK ;; *) echo NOK ;; esac`;

/** remoteFileStateCommand(): one `sh -c` line with the paths as arguments. */
export const remoteFileStateCommand = (paths: string[]): string => `sh -c ${escapeshellarg(REMOTE_FILE_STATE_SCRIPT)} sh ${paths.map(escapeshellarg).join(" ")}`;

/** remotePathConfinementCommand() */
export const remotePathConfinementCommand = (baseDirectory: string, path: string): string => `sh -c ${escapeshellarg(REMOTE_PATH_CONFINEMENT_SCRIPT)} sh ${escapeshellarg(baseDirectory)} ${escapeshellarg(path)}`;

/** PCRE's \\R: any line break. */
const LINE_BREAKS = new RegExp("\\r\\n|[\\n\\v\\f\\r\\x85\\u2028\\u2029]");

export type RemoteFileState = "file" | "missing" | "empty-directory" | "directory" | "other" | "unknown";

/** remoteFileStates(): the state of each path with one server command. A path without a state in the output is `unknown`. */
export async function remoteFileStates(executor: DeploymentExecutor, paths: string[]): Promise<string[]> {
  const states = new Map<number, string>();
  const output = (await instantRemote(executor, [remoteFileStateCommand(paths)], false)) ?? "";
  for (const line of phpTrim(output).split(LINE_BREAKS)) {
    const match = /^(\d+):([a-z-]+)$/.exec(phpTrim(line));
    if (match) states.set(Number(match[1]) - 1, match[2]!);
  }
  return paths.map((_, index) => states.get(index) ?? "unknown");
}

/** A file mount of the database, with its content decrypted. */
export interface ContentFile {
  fs_path: string;
  mount_path: string | null;
  content: string | null;
  is_directory: boolean;
  is_host_file: boolean;
  is_based_on_git: boolean;
  chown: string | null;
  chmod: string | null;
}

/** hasContentToWrite(): a file made from its content — not a directory, a host file, a Git file or a placeholder. */
const hasContentToWrite = (file: ContentFile): boolean => !file.is_directory && !file.is_host_file && !file.is_based_on_git && file.content !== BINARY_PLACEHOLDER && file.content !== TOO_LARGE_PLACEHOLDER;

const insideDirectory = (path: string, directory: string): boolean => path === directory || path.startsWith(`${directory}/`);

/** hostPathAndResourceDirectory(): the file's host path, and the resource directory when the path is inside it. */
function hostPath(file: ContentFile, workdir: string): { path: string; resourceDirectory: string | null } {
  const path = resolveHostPath(workdir, resolvedFsPath(file.fs_path, workdir));
  const directory = normalizeUnixPath(workdir);
  return { path, resourceDirectory: insideDirectory(path, directory) ? directory : null };
}

/** isOutsideResourceDirectory(): a path that cannot be resolved counts as outside. */
function isOutsideResourceDirectory(file: ContentFile, workdir: string): boolean {
  try {
    const path = normalizeUnixPath(resolvedFsPath(file.fs_path, workdir));
    return path.startsWith("~") || !insideDirectory(path, normalizeUnixPath(workdir));
  } catch {
    return true;
  }
}

/** truthiness of a PHP string: "" and "0" are false. */
const truthy = (value: string | null): value is string => value !== null && value !== "" && value !== "0";

/**
 * saveStorageOnServer() for a file: writes the content at the file's path. Outside the resource directory
 * nothing is written through a symlink; inside it, the path must stay inside once symlinks are resolved.
 * Answers whether an empty directory was replaced (FileStorageChanged).
 */
export async function saveContentFileOnServer(executor: DeploymentExecutor, file: ContentFile, workdir: string): Promise<{ replacedEmptyDirectory: boolean }> {
  if (file.is_host_file) return { replacedEmptyDirectory: false };
  const commands: string[] = [];
  const { path, resourceDirectory } = hostPath(file, workdir);
  if (resourceDirectory === null) {
    // assertRemotePathIsNotSymlink()
    const result = await instantRemote(executor, [`test -L ${escapeshellarg(path)} && echo LINK || echo OK`]);
    if (phpTrim(result ?? "") !== "OK") throw new Error(`${path} is a symbolic link on the server. Freeploy does not write a file through a symbolic link. Remove the link or use another path.`);
  } else {
    // assertRemotePathIsConfined()
    const result = await instantRemote(executor, [remotePathConfinementCommand(resourceDirectory, path)], false);
    if (phpTrim(result ?? "") !== "OK") throw new Error("Invalid storage path: resolved path must stay inside the resource configuration directory.");
  }
  const outside = isOutsideResourceDirectory(file, workdir);

  if (path.startsWith("/") || path.startsWith("~")) {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent !== "") commands.push(`mkdir -p ${escapeshellarg(parent)} > /dev/null 2>&1 || true`);
  }
  // Validate and escape resolved path (may differ from fs_path if relative)
  validateShellSafePath(path, "storage path");
  const escaped = escapeshellarg(path);

  const state = (await remoteFileStates(executor, [path]))[0];
  if (state === "unknown") throw new Error(`Freeploy cannot check the file ${path} on the server.`);
  if (state === "other") throw new Error(`A symbolic link or a special file is at ${path} on the server. Freeploy did not write the file.`);
  const isDir = state === "directory" || state === "empty-directory";
  let replacesEmptyDirectory = false;
  if (isDir) {
    // Docker creates a missing bind source as an empty directory. Replace only an empty directory inside the
    // resource directory; never delete files that are on the server.
    if (outside || state !== "empty-directory") {
      throw new Error(`The following file is a directory on the server, but you are trying to mark it as a file: ${path}<br><br>Please delete the directory on the server or mark it as directory.`);
    }
    replacesEmptyDirectory = true;
    commands.push(`rmdir ${escaped}`);
  }
  if (truthy(file.content)) commands.push(`echo '${base64Encode(file.content)}' | base64 -d | tee ${escaped} > /dev/null`);
  else commands.push(`touch ${escaped}`);
  // a+rx instead of +x: +x follows the server umask, so a strict umask leaves the file unreadable for a non-root container user.
  commands.push(`chmod a+rx ${escaped}`);
  if (truthy(file.chown)) commands.push(`chown -- ${escapeshellarg(file.chown)} ${escaped}`);
  if (truthy(file.chmod)) commands.push(`chmod -- ${escapeshellarg(file.chmod)} ${escaped}`);

  await instantRemote(executor, commands);
  return { replacedEmptyDirectory: replacesEmptyDirectory };
}

/** strip_tags(), for the messages here: a "<…>" run goes. */
const stripTags = (text: string): string => text.replace(/<[^<>]*>/g, "");
/** plainText(): one line of text out of an exception message. */
const plainText = (message: string): string => phpTrim(stripTags(message.split("<br>").join(" ")).replace(/[ \t\n\v\f\r]+/g, " "));
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface ContentFileLog {
  message: string;
  type: "stdout" | "stderr";
}

/**
 * EnsureContentFilesOnServer::handle(): writes each missing content file; answers its log lines (they never
 * contain file content), how many files it wrote and how many empty directories it replaced.
 */
export async function ensureContentFilesOnServer(executor: DeploymentExecutor, files: ContentFile[], workdir: string): Promise<{ log: ContentFileLog[]; written: number; replacedEmptyDirectories: number }> {
  const log: ContentFileLog[] = [];
  const candidates: Array<{ file: ContentFile; path: string }> = [];
  for (const file of files) {
    if (!hasContentToWrite(file)) continue;
    try {
      candidates.push({ file, path: hostPath(file, workdir).path });
    } catch (e) {
      if (!(e instanceof StoragePathError)) throw e;
      log.push({ message: "Warning: " + plainText(e.message), type: "stderr" });
    }
  }
  if (candidates.length === 0) return { log, written: 0, replacedEmptyDirectories: 0 };

  const states = await remoteFileStates(executor, candidates.map((c) => c.path));
  const toWrite: Array<{ file: ContentFile; path: string }> = [];
  candidates.forEach((candidate, index) => {
    const { file, path } = candidate;
    const state = states[index];
    if (state === "missing" || state === "empty-directory") toWrite.push(candidate);
    else if (state === "file") return;
    else if (state === "directory") log.push({ message: `Warning: A directory that is not empty is at ${path} on the server. Freeploy did not write the configuration file for ${file.mount_path ?? ""}. Remove the directory on the server, then start the resource again.`, type: "stderr" });
    else if (state === "other") log.push({ message: `Warning: A symbolic link or a special file is at ${path} on the server. Freeploy did not write the configuration file for ${file.mount_path ?? ""}.`, type: "stderr" });
    else log.push({ message: `Warning: Freeploy cannot check the configuration file ${path} on the server.`, type: "stderr" });
  });
  if (toWrite.length === 0) return { log, written: 0, replacedEmptyDirectories: 0 };

  log.push({ message: toWrite.length === 1 ? "Writing 1 missing configuration file." : `Writing ${toWrite.length} missing configuration files.`, type: "stdout" });
  let written = 0;
  let replaced = 0;
  for (const { file, path } of toWrite) {
    try {
      if ((await saveContentFileOnServer(executor, file, workdir)).replacedEmptyDirectory) replaced++;
      written++;
    } catch (e) {
      log.push({ message: `Warning: Freeploy cannot write the configuration file ${path}: ${plainText(messageOf(e))}`, type: "stderr" });
    }
  }
  return { log, written, replacedEmptyDirectories: replaced };
}

/** EnsureContentFilesOnServer::echoCommands(): the log lines as `echo` commands, for a command list that runs later. */
export const contentFileEchoCommands = (log: ContentFileLog[]): string[] => log.map((entry) => "echo " + escapeshellarg(entry.message));
