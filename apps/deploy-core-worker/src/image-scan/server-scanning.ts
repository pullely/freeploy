// Derived from coollabsio/coolify@91b7e3e:app/Livewire/ImageScan/ServerImageScanning.php,
// resources/views/livewire/image-scan/server-image-scanning.blade.php, app/Actions/ImageScan/SetServerImageScanning.php,
// app/Services/ImageScan/ScannerCommands.php (cpus, memoryOptionsMb, cpuOptions, optionsUpTo), app/Models/ServerSetting.php
// (IMAGE_SCAN_* options), config/constants.php (image_scan.images), bootstrap/helpers/shared.php (formatBytes),
// app/Livewire/Server/Security/HostVulnerabilities.php, resources/views/livewire/server/security/host-vulnerabilities.blade.php,
// app/Livewire/Concerns/ManagesServerPackageUpdates.php, app/Actions/Server/CheckUpdates.php (RISKY_PACKAGES, RISK_LABELS,
// riskFor, fixingUpdates, kernelFlavor, bootKernel, kernelStatus, isOtherKernelPackage), app/Jobs/ImageRescanJob.php
// (canRunOn), app/Models/ServerHostScan.php (findingList) and app/Enums/ImageScanErrorCode.php (message) (Apache-2.0), modified.
//
// A server's Vulnerabilities page (DP-116), without the DOM: ServerImageScanning's scanner limits (their options for the
// server, the listbox entries, the rules and messages) and the section's text, and HostVulnerabilities over the stored
// host scan (server_host_scans) and the stored patch check (server_settings.patch_check_result): the findings in the
// running kernel and in other installed kernels, the search, the sort, the pages, the kernel notes, the fixing updates
// and the exports. Freeploy keeps no scanner cache (PrepareImageScannerJob's state, built-at, failed step, disk used), so
// the scanner reads as never prepared and the delete action shows. Whatever runs on the server (the scanner, a host scan,
// a package update, a reboot) answers that the SSH executor is not available yet, after Coolify's checks.
import { findingFromArray, type Finding } from "./finding.js";
import { ImageRef } from "./image-ref.js";
import { blank, dataGet, filled, int, isRecord, list, parseTime, phpTrim, str, versionCompare } from "./php.js";
import { advisoryUrl, exploitLikelihood } from "./resource-scans.js";
import { exploitSignal } from "./rules.js";
import type { ExportRow } from "./exports.js";

const needsExecutor = (what: string): string => `${what} needs the SSH executor, which is not available yet.`;

/** The toasts and refusals of the page, word for word (the actions' own words keep Coolify's name, as DP-114's do). */
export const SERVER_SCANNING_MESSAGES = {
  enabled: "Image scanning turned on. Coolify is getting the scanner.",
  preparing: "Coolify is getting the scanner.",
  disabled: "Image scanning turned off.",
  deleted: "Scanner data deleted.",
  turnOnFirst: "Turn on image scanning first.",
  managedElsewhere: "This server is managed by another Coolify instance.",
  deleteFailed: "Could not delete the scanner data.",
  limitInvalid: "Choose one of the listed values. Values that are more than this server has are not allowed.",
  hostTurnOnFirst: "Turn on image scanning for this server first.",
  noPackageUpdate: 'This package has no update in the last check. Run "Check for updates" on the Patching page.',
  checkFirst: 'Run "Check for updates" first.',
  /** SetServerImageScanning::prepareScanner(): PrepareImageScannerJob pulls the scanner images over SSH. */
  scannerUnavailable: needsExecutor("Preparing the image scanner on the server"),
  deleteUnavailable: needsExecutor("Deleting the scanner data on the server"),
  hostScanUnavailable: needsExecutor("Scanning the packages of the server"),
  packageUpdateUnavailable: needsExecutor("Updating the packages of the server"),
  rebootUnavailable: needsExecutor("Rebooting the server"),
  removeUnusedUnavailable: needsExecutor("Removing the unused packages of the server"),
} as const;

/** ServerSetting::IMAGE_SCAN_*_OPTIONS */
export const MEMORY_OPTIONS_MB = [1024, 2048, 4096, 8192];
export const TIMEOUT_OPTIONS_SECONDS = [300, 600, 1200, 1800, 3600];
export const CPU_OPTIONS = [0.5, 1, 2, 4];
const DEFAULT_CPUS = 1;

/** config('constants.image_scan.images') */
const SCANNER_IMAGES: Record<string, { repo: string; version: string }> = {
  syft: { repo: "anchore/syft", version: "1.55.0" },
  grype: { repo: "anchore/grype", version: "0.121.0" },
  regctl: { repo: "regclient/regctl", version: "0.11.7" },
  init: { repo: "alpine", version: "3.22.7" },
};

/** The server facts the page reads: settings columns and server_metadata. */
export interface ScanningServer {
  name: string;
  serverMetadata: unknown;
  settings: Record<string, unknown>;
}

/** ScannerCommands::optionsUpTo() */
function optionsUpTo(options: readonly number[], capacity: number): number[] {
  if (capacity <= 0) return [...options];
  const fitting = options.filter((o) => o <= capacity);
  return fitting.length === 0 ? [Math.min(...options)] : fitting;
}

/** ScannerCommands::memoryOptionsMb() */
export const memoryOptionsMb = (server: ScanningServer): number[] => optionsUpTo(MEMORY_OPTIONS_MB, Math.trunc(int(dataGet(server.serverMetadata, "memory_bytes", 0)) / (1024 * 1024)));

/** ScannerCommands::cpuOptions() */
export const cpuOptions = (server: ScanningServer): number[] => optionsUpTo(CPU_OPTIONS, int(dataGet(server.serverMetadata, "cpus", 0)));

/** PHP's string of a float option: 1.0 is "1", 0.5 is "0.5". */
const phpNumber = (n: number): string => String(n);

/** ScannerCommands::cpus(): the CPU limit a scan uses, as Docker's --cpus. */
export function scannerCpus(server: ScanningServer): string {
  const raw = server.settings.image_scan_cpus;
  const configured = raw === null || raw === undefined ? DEFAULT_CPUS : Number(raw);
  let cpus = Math.min(Math.max(...CPU_OPTIONS), Math.max(Math.min(...CPU_OPTIONS), Number.isFinite(configured) ? configured : 0));
  cpus = Math.min(cpus, Math.max(...cpuOptions(server)));
  return cpus.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** formatBytes() */
export function formatBytes(bytes: number | null, precision = 2): string {
  if (bytes === null || bytes === 0 || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const factor = 10 ** precision;
  const value = Math.round((bytes / 1024 ** exponent) * factor) / factor;
  return `${phpNumber(value)} ${units[exponent]}`;
}

/** listboxOptions(): the values that fit the server, and a saved value that no longer fits, marked. */
function listboxOptions(allowed: readonly number[], current: number, label: (value: number) => string): Array<{ value: string; label: string }> {
  const values = allowed.includes(current) ? [...allowed] : [...allowed, current];
  values.sort((a, b) => a - b);
  return values.map((value) => ({ value: phpNumber(value), label: label(value) + (allowed.includes(value) ? "" : " (more than this server has)") }));
}

export type ScannerLimit = "scannerMemoryMb" | "scannerSyftTimeout" | "scannerGrypeTimeout" | "scannerCpus";

/** scannerLimits(): property => [settings column, allowed values, saved message]. */
export function scannerLimits(server: ScanningServer): Record<ScannerLimit, { column: string; options: string[]; message: string }> {
  return {
    scannerMemoryMb: { column: "image_scan_memory_mb", options: memoryOptionsMb(server).map(phpNumber), message: "Scanner memory limit saved. It applies to the next scan." },
    scannerSyftTimeout: { column: "image_scan_syft_timeout", options: TIMEOUT_OPTIONS_SECONDS.map(phpNumber), message: "Syft time limit saved. It applies to the next scan." },
    scannerGrypeTimeout: { column: "image_scan_grype_timeout", options: TIMEOUT_OPTIONS_SECONDS.map(phpNumber), message: "Grype time limit saved. It applies to the next scan." },
    scannerCpus: { column: "image_scan_cpus", options: cpuOptions(server).map(phpNumber), message: "Scanner CPU limit saved. It applies to the next scan." },
  };
}

export const isScannerLimit = (v: unknown): v is ScannerLimit => v === "scannerMemoryMb" || v === "scannerSyftTimeout" || v === "scannerGrypeTimeout" || v === "scannerCpus";

/** Laravel's attribute of a property: scannerMemoryMb is "scanner memory mb". */
const attributeOf = (property: string): string => property.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();

/** saveScannerLimit()'s validate(): ['required', Rule::in($options)] with the page's own `.in` message. */
export function validateScannerLimit(server: ScanningServer, property: ScannerLimit, value: unknown): string | null {
  if (value === null || value === undefined || (typeof value === "string" && phpTrim(value) === "")) return `The ${attributeOf(property)} field is required.`;
  const v = typeof value === "number" ? phpNumber(value) : typeof value === "string" ? value : null;
  return v !== null && scannerLimits(server)[property].options.includes(v) ? null : SERVER_SCANNING_MESSAGES.limitInvalid;
}

/** The stored value of a limit as the column holds it (decimal for the CPUs). */
export const limitValue = (property: ScannerLimit, value: string): number => (property === "scannerCpus" ? Number(value) : Number.parseInt(value, 10));

const cpuLabel = (cpus: number): string => `${phpNumber(cpus)} ${cpus > 1 ? "CPUs" : "CPU"}`;

/** render() of ServerImageScanning. */
export function renderServerImageScanning(server: ScanningServer) {
  const s = server.settings;
  const memoryMb = int(s.image_scan_memory_mb);
  return {
    enabled: s.is_image_scan_enabled === true,
    // fillScannerLimits(): (string) of each column.
    limits: {
      scannerMemoryMb: str(s.image_scan_memory_mb),
      scannerSyftTimeout: str(s.image_scan_syft_timeout),
      scannerGrypeTimeout: str(s.image_scan_grype_timeout),
      scannerCpus: str(s.image_scan_cpus),
    },
    memoryLimit: formatBytes(memoryMb * 1024 * 1024, 0),
    memoryOptions: listboxOptions(memoryOptionsMb(server), memoryMb, (mb) => formatBytes(mb * 1024 * 1024, 0)),
    timeoutOptions: TIMEOUT_OPTIONS_SECONDS.map((seconds) => ({ value: phpNumber(seconds), label: `${phpNumber(seconds / 60)} minutes` })),
    cpuOptions: listboxOptions(cpuOptions(server), Number(s.image_scan_cpus ?? 0), cpuLabel),
    // Freeploy keeps no scanner cache: never prepared, nothing known about the disk.
    prepareState: null as string | null,
    failedStep: null as string | null,
    registries: [...new Set(Object.values(SCANNER_IMAGES).map((i) => ImageRef.parse(i.repo).registry))].join(", "),
    diskUsed: null as string | null,
    hasScannerData: true,
    toolVersions: (["syft", "grype", "regctl"] as const).map((tool) => `${{ syft: "Syft", grype: "Grype", regctl: "regctl" }[tool]} ${SCANNER_IMAGES[tool]!.version}`).join(", "),
    builtAt: null as string | null,
    cpuLimit: scannerCpus(server),
  };
}

// ── CheckUpdates ────────────────────────────────────────────────────────────

const FULL_UPGRADE_ONLY = ["pacman"];

const RISKY_PACKAGES: Record<string, Record<string, string[]>> = {
  apt: {
    docker: ["docker-ce", "docker-ce-cli", "docker-ce-rootless-extras", "docker-buildx-plugin", "docker-compose-plugin", "containerd.io", "containerd", "runc", "docker.io"],
    kernel: ["linux-image-*", "linux-modules-*", "linux-generic*", "linux-virtual*", "linux-aws*", "linux-azure*", "linux-gcp*", "linux-oracle*", "linux-kvm*", "linux-raspi*"],
    system: ["libc6", "libc-bin", "systemd", "systemd-sysv", "libsystemd0", "udev", "dbus", "openssh-server", "openssh-sftp-server"],
  },
  dnf: {
    docker: ["docker-ce", "docker-ce-cli", "docker-ce-rootless-extras", "docker-buildx-plugin", "docker-compose-plugin", "containerd.io", "containerd", "runc", "moby-engine", "docker"],
    kernel: ["kernel", "kernel-core", "kernel-modules", "kernel-modules-core", "kernel-modules-extra", "kernel-uek", "kernel-uek-core", "kernel-uek-modules"],
    system: ["glibc", "glibc-common", "glibc-langpack-*", "systemd", "systemd-libs", "systemd-udev", "dbus", "dbus-broker", "openssh-server"],
  },
  zypper: {
    docker: ["docker", "docker-ce", "containerd", "runc", "docker-compose", "docker-buildx"],
    kernel: ["kernel-default", "kernel-default-base", "kernel-azure", "kernel-kvmsmall"],
    system: ["glibc", "systemd", "libsystemd0", "udev", "dbus-1", "openssh", "openssh-server"],
  },
  pacman: {
    docker: ["docker", "containerd", "runc", "docker-compose", "docker-buildx"],
    kernel: ["linux", "linux-lts", "linux-zen", "linux-hardened"],
    system: ["glibc", "systemd", "systemd-libs", "dbus", "openssh"],
  },
  apk: {
    docker: ["docker", "docker-engine", "docker-cli", "docker-openrc", "docker-cli-compose", "docker-cli-buildx", "containerd", "runc"],
    kernel: ["linux-lts", "linux-virt", "linux-edge"],
    system: ["musl", "openrc", "openssh", "openssh-server"],
  },
};

export const RISK_LABELS: Record<string, string> = {
  docker: "Restarts Docker and the running containers",
  kernel: "Needs a reboot to apply",
  system: "Restarts core system services",
};

/** fnmatch() of the patterns above: `*` only. */
const fnmatch = (pattern: string, name: string): boolean => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "s").test(name);

/** CheckUpdates::riskFor() */
export function riskFor(packageManager: string | null, pkg: string): string | null {
  for (const [risk, patterns] of Object.entries(RISKY_PACKAGES[packageManager ?? ""] ?? {})) for (const p of patterns) if (fnmatch(p, pkg)) return risk;
  return null;
}

/** CheckUpdates::kernelFlavor() */
function kernelFlavor(pkg: string): string | null {
  const m = /^linux-.*?-\d+\.\d+\.\d+[^-]*(?:-\d+)?-([a-z].*)$/.exec(pkg) ?? /^linux-(?:(?:signed-|unsigned-)?image-|headers-|modules-(?:extra-)?|tools-)?([a-z][a-z0-9-]*?)(?:-(?:hwe|lts)-[\d.]+(?:-edge)?)?$/.exec(pkg);
  if (m === null) return null;
  return m[1] === "virtual" ? "generic" : m[1]!;
}

type Update = Record<string, unknown>;

/** CheckUpdates::fixingUpdates() */
export function fixingUpdates(pkg: string, patchResult: unknown): Update[] {
  const packageManager = dataGet(patchResult, "package_manager");
  if (typeof packageManager === "string" && FULL_UPGRADE_ONLY.includes(packageManager)) return [];
  const updates = list(dataGet(patchResult, "updates", [])).filter(isRecord);
  const own = updates.find((u) => u.package === pkg);
  if (own !== undefined) return [own];
  const flavor = kernelFlavor(pkg);
  if (flavor === null || riskFor(typeof packageManager === "string" ? packageManager : null, pkg) !== "kernel") return [];
  return updates.filter((u) => u.risk === "kernel" && kernelFlavor(str(u.package)) === flavor);
}

interface Kernel {
  package: string;
  version: string;
  release: string;
}
const installedKernels = (patchResult: unknown): Kernel[] => list(dataGet(patchResult, "kernels.installed", [])).filter(isRecord).map((k) => ({ package: str(k.package), version: str(k.version), release: str(k.release) }));
const withoutEpoch = (version: string): string => version.replace(/^\d+:/, "");
const versionAtLeast = (version: string, minimum: string): boolean => versionCompare(withoutEpoch(version), withoutEpoch(minimum)) >= 0;
const kernelHasPackage = (kernel: Kernel, pkg: string, version: string): boolean => pkg.endsWith(`-${kernel.release}`) || (pkg.startsWith("kernel") && withoutEpoch(version) === withoutEpoch(kernel.version));

/** CheckUpdates::bootKernel() */
export function bootKernel(patchResult: unknown): Kernel | null {
  const boot = dataGet(patchResult, "kernels.boot");
  return typeof boot === "string" ? (installedKernels(patchResult).find((k) => k.release === boot) ?? null) : null;
}

/** CheckUpdates::kernelStatus() */
export function kernelStatus(pkg: string, version: string, fixedIn: string | null, patchResult: unknown): "fixed_after_reboot" | "runs_after_reboot" | null {
  const running = dataGet(patchResult, "kernels.running");
  const installed = installedKernels(patchResult);
  if (typeof running !== "string" || installed.length === 0) return null;
  const runningKernel = installed.find((k) => k.release === running);
  const kernel = installed.find((k) => kernelHasPackage(k, pkg, version));
  if (kernel === undefined || runningKernel === undefined) return null;
  const boot = bootKernel(patchResult);
  if (boot === null || boot.release === running) return null;
  if (kernel.release !== running) return kernel.release === boot.release ? "runs_after_reboot" : null;
  return fixedIn !== null && versionAtLeast(boot.version, fixedIn) ? "fixed_after_reboot" : null;
}

const isRpmKernelPackage = (pkg: string): boolean => riskFor("dnf", pkg) === "kernel" || riskFor("zypper", pkg) === "kernel";

/** CheckUpdates::isOtherKernelPackage() */
export function isOtherKernelPackage(pkg: string, version: string, runningRelease: string | null): boolean {
  if (blank(runningRelease)) return false;
  const running = runningRelease!;
  const packageKernel = /^linux-.*?-(\d+\.\d+(?:\.\d+)?-\d+)(?:-|$)/.exec(pkg);
  if (packageKernel !== null) {
    const runningKernel = /^(\d+\.\d+(?:\.\d+)?-\d+)/.exec(running);
    return runningKernel !== null && packageKernel[1] !== runningKernel[1];
  }
  if (!isRpmKernelPackage(pkg)) return false;
  const v = withoutEpoch(version);
  const suse = /^(.+)-[a-z][a-z0-9_]*$/.exec(running);
  if (suse !== null) return v.replace(/\.\d+$/, "") !== suse[1];
  return v !== running.replace(/\.[^.]+$/, "");
}

// ── ImageScanErrorCode ──────────────────────────────────────────────────────

/** ImageScanErrorCode::message(): the fixed message of a stored error code, or null for a value the enum does not have. */
export function errorCodeMessage(code: string | null, context: Record<string, unknown>): string | null {
  if (code === null) return null;
  const server = str(context.server ?? "the server");
  const n = str(context.n ?? "?");
  switch (code) {
    case "disk_space":
      return context.n !== undefined && context.n !== null ? `Not enough disk space on ${server}: ${n} GB needed.` : `Not enough disk space on ${server}.`;
    case "db_too_old":
      return `The vulnerability database is ${n} days old. ${server} cannot reach grype.anchore.io.`;
    case "db_missing":
      return `The vulnerability database is not on ${server} yet. Wait for the first update to finish or check that ${server} can reach grype.anchore.io.`;
    case "timeout":
      switch (context.step) {
        case "db-status":
          return `The check of the vulnerability database took too long and was stopped. Grype reads the whole database file, which is slow on a slow disk. Raise the Grype time limit on the Vulnerabilities page of ${server}.`;
        case "save":
          return `Docker took too long to export the image and was stopped. Raise the Syft time limit on the Vulnerabilities page of ${server}.`;
        case "sbom":
          return `Syft took too long and was stopped. Raise the Syft time limit on the Vulnerabilities page of ${server}.`;
        case "grype":
          return `Grype took too long and was stopped. Raise the Grype time limit on the Vulnerabilities page of ${server}.`;
        default:
          return "The scan took too long and was stopped.";
      }
    case "out_of_memory":
      return `The scanner ran out of memory and was stopped. Raise the scanner memory limit on the Vulnerabilities page of ${server}, and make sure that ${server} has that much free memory.`;
    case "lock_busy":
      return `Another scan is still running on ${server}.`;
    case "registry_auth":
      return `Coolify cannot read this image from its registry. Log in to the registry on ${server}.`;
    case "build_server_off":
      return "Image scanning is off on the build server.";
    case "scanning_off":
      return `Turn on image scanning on ${server}.`;
    case "custom_command":
      return "Coolify cannot check the image because this application uses a custom build or start command.";
    case "image_missing":
      return `The image is not on ${server}. Click Scan now to pull and scan it. An image that Coolify builds needs a new deploy.`;
    case "pull_failed":
      return `Coolify could not pull the image to ${server}. Check the image name, and log in to its registry on ${server} if it is private.`;
    case "truncated":
      return "The scan result was too large to read completely.";
    case "no_package_database":
      return `Coolify found no package database of a supported package manager (dpkg, rpm, apk, pacman) on ${server}.`;
    case "unknown":
      return "The scan could not run.";
    default:
      return null;
  }
}

// ── HostVulnerabilities ─────────────────────────────────────────────────────

/** A stored host scan (server_host_scans), as ServerHostScan's casts read it. */
export interface HostScan {
  errorCode: string | null;
  errorContext: Record<string, unknown> | null;
  eol: Record<string, unknown> | null;
  summary: Record<string, unknown> | null;
  findings: unknown[];
  findingsTruncated: boolean;
  scannedAt: Date | null;
}

/** HostVulnerabilities' public properties. */
export interface HostState {
  search: string;
  sortBy: string;
  showOtherKernels: boolean;
  page: number;
  perPage: number;
}

const SORT_COLUMNS = ["vulnerability", "package", "fixed", "severity"];
const SEVERITY_ORDER: Record<string, number> = { unknown: 0, low: 1, medium: 2, high: 3, critical: 4 };

/** The page state from the query (search, sortBy, showOtherKernels, page, perPage); sortFindings() keeps a known sort only. */
export function hostState(q: URLSearchParams): HostState {
  const sortBy = q.get("sortBy") ?? "";
  const [column, direction] = sortBy.split("_", 2);
  const page = Number.parseInt(q.get("page") ?? "", 10);
  const perPage = Number.parseInt(q.get("perPage") ?? "", 10);
  return {
    search: q.get("search") ?? "",
    sortBy: SORT_COLUMNS.includes(column ?? "") && (direction === "asc" || direction === "desc") ? sortBy : "",
    showOtherKernels: q.get("showOtherKernels") === "1",
    page: Number.isFinite(page) ? page : 1,
    perPage: Number.isFinite(perPage) ? perPage : 10,
  };
}

const natcase = (a: string, b: string): number => Math.sign(a.localeCompare(b, "en", { numeric: true, sensitivity: "base" }));

/** sortedFindings(): the stored order, or by a column; findings without a fix stay last in both directions. */
function sortedFindings(findings: readonly Finding[], sortBy: string): Finding[] {
  if (sortBy === "") return [...findings];
  const [column, direction] = sortBy.split("_", 2) as [string, string];
  const compare = (a: Finding, b: Finding): number => {
    switch (column) {
      case "vulnerability":
        return natcase(a.displayId, b.displayId);
      case "package":
        return natcase(a.package, b.package);
      case "fixed":
        return versionCompare(a.fixedIn ?? "", b.fixedIn ?? "");
      default:
        return Math.sign((SEVERITY_ORDER[a.severity] ?? 0) - (SEVERITY_ORDER[b.severity] ?? 0));
    }
  };
  return [...findings].sort((a, b) => {
    if (column === "fixed" && (a.fixedIn === null) !== (b.fixedIn === null)) return a.fixedIn === null ? 1 : -1;
    return direction === "asc" ? compare(a, b) : compare(b, a);
  });
}

/** findingSets(): the host scan's findings in the running kernel and in other kernels, and the shown ones (search, sort). */
export function findingSets(scan: HostScan | null, patchCheckResult: unknown, state: HostState) {
  let patchResult = patchCheckResult;
  // The kernel that ran during the scan; the patch check can be older, for example from before a reboot.
  const scanned = dataGet(scan?.summary ?? null, "running_kernel");
  const runningKernel = (scanned ?? dataGet(patchResult, "kernels.running")) as string | null;
  if (isRecord(patchResult) && runningKernel !== null) {
    const kernels = isRecord(patchResult.kernels) ? { ...patchResult.kernels } : {};
    patchResult = { ...patchResult, kernels: { ...kernels, running: runningKernel } };
  }
  const all = (scan?.findings ?? []).map(findingFromArray);
  const otherKernels = all.filter((f) => isOtherKernelPackage(f.package, f.version, runningKernel === null ? null : str(runningKernel)));
  const active = all.filter((f) => !isOtherKernelPackage(f.package, f.version, runningKernel === null ? null : str(runningKernel)));
  const hostFindings = state.showOtherKernels ? [...active, ...otherKernels] : active;
  const search = phpTrim(state.search).toLowerCase();
  const sorted = sortedFindings(hostFindings, state.sortBy);
  const shown = search === "" ? sorted : sorted.filter((f) => [f.displayId, f.id, ...f.aliases, f.package, f.title].join(" ").toLowerCase().includes(search));
  return { patchResult, runningKernel: runningKernel === null ? null : str(runningKernel), active, otherKernels, hostFindings, shown };
}

/** exportRows(): the shown findings with the ID the page shows. */
export function hostExportRows(shown: readonly Finding[]): ExportRow[] {
  return shown.map((finding) => ({ finding, state: filled(finding.fixedIn) ? "fixed" : "no_fix", ignore: null, image: "", id: finding.displayId !== "" ? finding.displayId : finding.id }));
}

/** The view of one finding row (the @php block of host-vulnerabilities.blade.php). */
function findingRow(finding: Finding, patchResult: unknown, runningKernel: string | null) {
  const signal = exploitSignal(finding);
  let updates = fixingUpdates(finding.package, patchResult);
  const isOwnUpdate = updates.length === 1 && updates[0]!.package === finding.package;
  let riskLabels = [...new Set(updates.map((u) => u.risk).filter((r): r is string => typeof r === "string" && r !== ""))].map((r) => RISK_LABELS[r]).filter((l): l is string => l !== undefined);
  const status = kernelStatus(finding.package, finding.version, finding.fixedIn, patchResult);
  const isOtherKernel = isOtherKernelPackage(finding.package, finding.version, runningKernel);
  const isOldKernel = isOtherKernel && status !== "runs_after_reboot";
  if (isOtherKernel) {
    updates = [];
    riskLabels = [];
  }
  return {
    key: `${finding.id}-${finding.package}-${finding.artifactId}`,
    displayId: finding.displayId,
    title: finding.title,
    summary: finding.summary !== "" ? finding.summary : finding.title,
    package: finding.package,
    version: finding.version,
    fixedIn: finding.fixedIn,
    severity: finding.severity,
    signal,
    kernelStatus: status,
    isOtherKernel,
    isOldKernel,
    updates: updates.map((u) => ({ package: str(u.package ?? ""), newVersion: str(u.new_version ?? "") })),
    isOwnUpdate,
    riskLabels,
    cvssScore: finding.cvssScore === null ? null : finding.cvssScore.toFixed(1),
    kev: finding.kev,
    likelihood: exploitLikelihood(finding.epss),
    aliases: finding.aliases.filter((a) => a !== finding.displayId),
    advisoryUrl: advisoryUrl(finding.displayId),
  };
}

/** render() of HostVulnerabilities. */
export function renderHostVulnerabilities(scan: HostScan | null, patchCheckResult: unknown, state: HostState, facts: { serverName: string; hostScanAvailable: boolean; canUpdate: boolean; now: Date; ago: (d: Date) => string }) {
  const sets = findingSets(scan, patchCheckResult, state);
  const { patchResult, runningKernel, active, otherKernels, hostFindings, shown } = sets;
  const installed = installedKernels(patchResult);
  const runningKernelVersion = installed.find((k) => k.release === runningKernel)?.version ?? null;
  const perPage = Math.max(1, Math.min(100, state.perPage));
  const lastPage = Math.max(1, Math.ceil(shown.length / perPage));
  const page = Math.max(1, Math.min(state.page, lastPage));
  const slice = shown.slice((page - 1) * perPage, page * perPage);
  const kernelStatusCounts: Record<string, number> = {};
  for (const f of active) {
    const s = kernelStatus(f.package, f.version, f.fixedIn, patchResult);
    if (s !== null) kernelStatusCounts[s] = (kernelStatusCounts[s] ?? 0) + 1;
  }
  const summary = scan?.summary ?? null;
  const error = scan === null ? null : errorCodeMessage(scan.errorCode, { ...(scan.errorContext ?? {}), server: facts.serverName });
  return {
    state: { search: state.search, sortBy: state.sortBy, showOtherKernels: state.showOtherKernels },
    hostScan:
      scan === null
        ? null
        : {
            summary,
            findingsTruncated: scan.findingsTruncated,
            scannedAt: scan.scannedAt === null ? null : { ago: facts.ago(scan.scannedAt), title: scan.scannedAt.toISOString().replace("T", " ").slice(0, 19) },
            error,
            errorDetail: facts.canUpdate && error !== null ? (dataGet(scan.errorContext, "detail") as string | null) : null,
            eol: scan.eol === null ? null : { name: str(dataGet(scan.eol, "name") ?? ""), version: str(dataGet(scan.eol, "version") ?? "") },
          },
    hostScanRunning: false,
    hostScanAvailable: facts.hostScanAvailable,
    hasResult: filled(patchResult) && patchResult !== false,
    rebootRequired: dataGet(patchResult, "reboot_required") === true,
    packageManager: (dataGet(patchResult, "package_manager") as string | null) ?? null,
    kernelStatusCounts,
    otherKernelCount: Math.max(otherKernels.length, int(dataGet(summary, "other_kernels", 0))),
    hasOldKernels: runningKernelVersion !== null && installed.some((k) => versionCompare(k.version, runningKernelVersion) < 0),
    runningKernel,
    bootKernel: bootKernel(patchResult)?.release ?? null,
    hostFindingsCount: hostFindings.length,
    shownCount: shown.length,
    items: {
      items: slice.map((f) => findingRow(f, patchResult, runningKernel)),
      total: shown.length,
      perPage,
      currentPage: page,
      lastPage,
      firstItem: slice.length === 0 ? null : (page - 1) * perPage + 1,
      lastItem: slice.length === 0 ? null : (page - 1) * perPage + slice.length,
    },
  };
}

/** A stored server_host_scans row read with ServerHostScan's casts. */
export function hostScanOf(row: { error_code: string | null; error_context: unknown; eol: unknown; summary: unknown; findings: unknown; findings_truncated: boolean; scanned_at: string | null } | null): HostScan | null {
  if (row === null) return null;
  const json = (v: unknown): unknown => {
    if (typeof v !== "string") return v ?? null;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  };
  const obj = (v: unknown): Record<string, unknown> | null => {
    const parsed = json(v);
    return isRecord(parsed) ? parsed : Array.isArray(parsed) && parsed.length === 0 ? null : null;
  };
  const findings = json(row.findings);
  return {
    errorCode: row.error_code,
    errorContext: obj(row.error_context),
    eol: obj(row.eol),
    summary: obj(row.summary),
    findings: Array.isArray(findings) ? findings : isRecord(findings) ? Object.values(findings) : [],
    findingsTruncated: row.findings_truncated === true,
    scannedAt: parseTime(row.scanned_at),
  };
}

/** The stored patch check (patch_check_result, an `array` cast): null when none. */
export function patchResultOf(stored: unknown): Record<string, unknown> | null {
  let v = stored;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  return isRecord(v) ? v : null;
}
