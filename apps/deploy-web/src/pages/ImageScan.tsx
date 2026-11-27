// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/image-scan/{vulnerabilities,packages,scan-settings,
// fleet-vulnerabilities,instance-image-scanning,team-image-scanning,server-image-scanning}.blade.php,
// resources/views/livewire/server/security/host-vulnerabilities.blade.php,
// resources/views/components/server/remove-unused-packages-button.blade.php, resources/views/livewire/image-scan/partials/{security-image,security-action,
// finding-row,ignore-modal,scan-rules,scan-ignores}.blade.php, resources/views/components/image-scan/{severity-badge,
// export-menu,image-select,error-log}.blade.php, resources/views/livewire/project/{application,service,database}/
// configuration.blade.php (the Security sub-page) and app/Livewire/ImageScan/*.php (Apache-2.0), modified.
//
// DP-114's pages:
//
//   …/application/{uuid}/vulnerabilities   project.application.vulnerabilities   Vulnerabilities, Packages, ScanSettings
//   …/service/{uuid}/vulnerabilities       project.service.vulnerabilities       the same, the settings listing ignores only
//   …/database/{uuid}/vulnerabilities      project.database.vulnerabilities      the same
//   …/vulnerabilities/sbom/{scan}/{format} project.*.vulnerabilities.sbom        ImageScanSbomController: the file, saved
//   /vulnerabilities                       vulnerabilities                       FleetVulnerabilities
//
// DP-116's pages:
//
//   /settings/image-scanning               settings.image-scanning               InstanceImageScanning (the operator's)
//   /team/image-scanning                   team.image-scanning                   TeamImageScanning
//   /server/{uuid}/security/vulnerabilities server.security.vulnerabilities      ServerImageScanning, HostVulnerabilities
//   /server/{uuid}/security/image-scanning server.security.image-scanning        a redirect to the one above
//
// Getting the scanner, deleting its data, turning scanning on, a host scan, a package update and a reboot answer that
// the SSH executor is not available yet (a toast); Freeploy keeps no scanner state, so the scanner reads as never got.
//
// Scan now, Update, Pull latest and Rebuild answer that the SSH executor is not available yet (a toast). The live updates
// on scan events (ListensToTeamChannel) are not ported: Freeploy runs no scan.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { notify } from "../lib/toast";
import { getJson, postJson } from "../lib/api";
import { Reicon } from "../components/Reicon";
import { Button, Callout, CopyButton, DangerCallout, Empty, Listbox, ModalConfirmation, ModalInput, SettingsSection, SettingsSubsection, StatusBadge } from "../components/Coolify";
import { PAGER_BUTTON, PageSizeSelect, TableDropdown } from "../components/CoolifyList";
import { resourceApi, resourceFrame, resourceUuidFromPath, type ResourceKind, type ResourceSectionData } from "./ApplicationSection";
import { environmentPath, environmentUuidFromPath, limit, projectUuidFromPath } from "./ProjectChrome";
import { ResourceWorkspace } from "./ResourceWorkspace";
import { ServerWorkspace, serverUuidFromPath, limit as serverLimit, type ServerInfo } from "./ServerChrome";
import { SettingsLayout } from "./PlatformSettings";
import { PlatformNotFound } from "./PlatformAdmin";
import { Sort, TeamLayout, teamApi } from "./Team";
import {
  countOf,
  gateHelper,
  hostQuery,
  inheritedOptions,
  INITIAL_HOST,
  otherKernelsLine,
  removeUnusedSupported,
  rulesHelper,
  scanCostText,
  scannerCheckpoints,
  scanningSectionHelper,
  setHost,
  vulnerabilitiesWord,
  type HostState,
  environmentOfPath,
  exportMenu,
  fleetQuery,
  fleetStateFromUrl,
  fleetUrl,
  ignoreModal,
  INITIAL_FINDINGS,
  INITIAL_PACKAGES,
  numberFormat,
  otherFixesText,
  resetFindingFilters,
  resetFleetFilters,
  resetPackageFilters,
  resourceQuery,
  sbomFromPath,
  sbomPath,
  selectImage,
  serversNotScanningTitle,
  setFindings,
  setFixState,
  severityBadge,
  showImageFindings,
  showPackageImage,
  splitSentence,
  toggleFleet,
  togglePackageType,
  toggleSeverity,
  whyMoreText,
  type FindingsState,
  type FleetState,
  type PackagesState,
} from "../lib/image-scan";

// ---------------------------------------------------------------- the API's answers

interface Button {
  label: string;
  title: string;
  submit: Record<string, string>;
  actions: string[];
  warning: string;
}
interface Action {
  key: string;
  type: string;
  sentence: string;
  copy: string | null;
  button: Button | null;
}
interface Why {
  title: string;
  display_id: string;
  link: string | null;
  cvss: string | null;
  cvssNote: string | null;
  severity: string;
  signal: string | null;
  exploited: boolean;
  package: string;
  version: string;
}
interface ImageRow {
  key: string;
  name: string | null;
  ref: string;
  status: string;
  badge: string | null;
  badgeType: string;
  open: boolean;
  sentence: string;
  attackNote: string | null;
  advice: string | null;
  lines: string[];
  primary: Action | null;
  mergedWith: string | null;
  why: Why[];
  whyMore: number;
  provenance: string | null;
  others: Action[];
  moreActions: number;
  versionNotes: Array<{ text: string; link: string | null }>;
  filter: string | null;
  override: { service: string; from: string; to: string } | null;
}
interface Card {
  status: string;
  checking: boolean;
  badge: string | null;
  badgeType: string;
  header: string | null;
  single: boolean;
  rows: ImageRow[];
}
interface FindingRow {
  key: string;
  id: string;
  url: string | null;
  package: string;
  version: string;
  fixedIn: string | null;
  severity: string;
  kev: boolean;
  summary: string;
  likelihood: string | null;
  aliases: Array<{ id: string; url: string | null }>;
  ignore: { reason: string; until: string | null } | null;
  image: string;
  owner: string;
  base: string | null;
  neverAllowed: boolean;
}
interface PackageGroup {
  key: string;
  package: string;
  version: string;
  image: string;
  owner: string;
  severity: string;
  kev: boolean;
  neverAllowed: boolean;
  fixed: string | null;
  count: number;
  rows: FindingRow[];
}
interface Paged<T> {
  items: T[];
  total: number;
  perPage: number;
  currentPage: number;
  lastPage: number;
  firstItem: number | null;
  lastItem: number | null;
}
interface Vulnerabilities {
  offState: "server" | "application" | null;
  serverName: string;
  serverUrl: string | null;
  canUpdate: boolean;
  isApplication: boolean;
  state: Omit<FindingsState, "page" | "perPage"> | null;
  hasScans?: boolean;
  errorMessages?: Array<{ message: string; detail: string | null }>;
  card?: Card | null;
  checkedAt?: { iso: string; ago: string; title: string } | null;
  truncated?: boolean;
  findingCount?: number;
  stateCounts?: Record<string, number>;
  fixStates?: Record<string, string>;
  ignoredCount?: number;
  shownCount?: number;
  items?: Paged<FindingRow | PackageGroup>;
  grouped?: boolean;
  groupedFindingCount?: number | null;
  imageOptions?: string[];
  showsImage?: boolean;
  isService?: boolean;
  canIgnoreForTeam?: boolean;
  hasFilters?: boolean;
  severityOptions?: string[];
}
interface Packages {
  hasScans: boolean;
  total: number;
  items: Paged<{ key: string; name: string; version: string; type: string; licenses: string[]; purl: string; image: string }>;
  typeOptions: string[];
  imageOptions: string[];
  showsImage: boolean;
  truncated: boolean;
  downloads: Array<{ image: string; scanUuid: string }>;
}
interface ScanSettings {
  scopeType: string;
  canEdit: boolean;
  showsTeamSettingsLink: boolean;
  ignores: Array<{ uuid: string; vulnerabilityId: string | null; package: string | null; reason: string; expires: string | null; teamWide: boolean; ownerName: string | null }>;
  rules: null | {
    gateMode: string;
    onScanError: string;
    countMedium: string;
    appScanEnabled: string;
    buildsByTeam: string;
    appScanOn: boolean;
    isDockerImage: boolean;
    inheritLabels: Record<string, string>;
    gateModeOptions: Array<{ value: string; label: string; description?: string }>;
    onScanErrorOptions: Array<{ value: string; label: string }>;
    countMediumOptions: Array<{ value: string; label: string }>;
  };
}
type SecurityData = ResourceSectionData & { vulnerabilities: Vulnerabilities; packages: Packages; settings: ScanSettings; resourceType: string };

// ---------------------------------------------------------------- small views

const MUTED = "text-[11px] text-neutral-500 dark:text-fg-faint";
const NOTE = "text-[13px] leading-5 text-neutral-600 dark:text-fg-dim";
const LINK = "font-medium text-neutral-800 underline decoration-neutral-400/40 underline-offset-4 transition-colors hover:text-neutral-950 hover:decoration-current dark:text-fg dark:decoration-white/25 dark:hover:text-white dark:hover:decoration-current";
const SEGMENT = "h-7 rounded-md px-2.5 text-[12px] font-medium whitespace-nowrap transition-colors";
const SEGMENT_ACTIVE = "bg-white text-black shadow-sm ring-1 ring-neutral-200 dark:bg-white/[0.09] dark:text-fg dark:ring-white/[0.08]";
const SEGMENT_IDLE = "text-neutral-500 hover:text-black dark:text-fg-faint dark:hover:text-fg";
const GROUP_LABEL = "px-2 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-neutral-400 dark:text-fg-faint";
const CODE = "max-w-full truncate rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-[12px] text-neutral-800 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg";

const DOTS: Record<string, string> = {
  "severity-critical": "bg-error",
  "severity-high": "bg-severity-high",
  "severity-medium": "bg-severity-medium",
  "severity-low": "bg-neutral-400 dark:bg-neutral-500",
  neutral: "bg-neutral-400 dark:bg-neutral-500",
};

/** <x-image-scan.severity-badge> (an <x-status-badge> of a severity type). */
function SeverityBadge({ severity, title, count = null }: { severity: string; title?: string | null; count?: number | null }) {
  const b = severityBadge(severity, count);
  return (
    <span className="inline-flex max-w-full items-center whitespace-nowrap text-neutral-700 dark:text-fg gap-1.5 text-[13px]" title={title ?? undefined}>
      <span className="relative flex size-1.5 shrink-0">
        <span className={`relative inline-flex size-1.5 rounded-full ${DOTS[b.type] ?? DOTS.neutral}`} />
      </span>
      <span className="truncate">{b.label}</span>
    </span>
  );
}

const badgeTypeOf = (t: string | null): "neutral" | "warning" | "error" => (t === "error" ? "error" : t === "warning" ? "warning" : "neutral");

/** <x-checkbox> of a filter option. */
function Check({ selected }: { selected: boolean }) {
  return (
    <span
      className={
        selected
          ? "flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-coollabs bg-coollabs text-white dark:border-brand dark:bg-brand dark:text-white"
          : "flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-neutral-300 bg-white dark:border-white/[0.14] dark:bg-white/[0.045]"
      }
    >
      {selected ? (
        <svg className="size-3" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="m2.25 6.15 2.35 2.3 5.15-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );
}

/** <x-table.filter>: the filter button with its count and its options' panel. */
function TableFilter({ activeCount, onReset, children }: { activeCount: number; onReset: () => void; children: ReactNode }) {
  return (
    <TableDropdown
      panelClass="min-w-56! p-1!"
      trigger={() => (
        <button type="button" className={activeCount > 0 ? "button button-highlighted normal-case!" : "button normal-case!"} aria-haspopup="listbox">
          <Reicon name="filter" className="size-3.5" />
          Filter{activeCount > 0 ? ` (${activeCount})` : ""}
        </button>
      )}
    >
      {() => (
        <div className="flex flex-col">
          {children}
          {activeCount > 0 ? (
            <button type="button" className="listbox-option" onClick={onReset}>
              Reset
            </button>
          ) : null}
        </div>
      )}
    </TableDropdown>
  );
}

/** <x-table.search> */
function TableSearch({ placeholder, value, onChange }: { placeholder: string; value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  // wire:model.live.debounce.300ms
  useEffect(() => {
    if (draft === value) return;
    const t = setTimeout(() => onChange(draft), 300);
    return () => clearTimeout(t);
  }, [draft, value, onChange]);
  return (
    <div className="relative min-w-0 flex-1">
      <Reicon name="search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-neutral-400" />
      <input type="search" className="input h-8! pl-8!" placeholder={placeholder} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={placeholder} />
    </div>
  );
}

/** <x-image-scan.image-select>: one image, or "All images"; only for more than one image. */
function ImageSelect({ options, selected, onSelect }: { options: string[]; selected: string[]; onSelect: (image: string) => void }) {
  if (options.length <= 1) return null;
  const current = selected.length === 1 ? selected[0]! : null;
  return (
    <TableDropdown
      panelClass="min-w-56! max-w-80! p-1!"
      trigger={() => (
        <button type="button" aria-haspopup="listbox" className={current !== null ? "button button-highlighted max-w-64 min-w-0 normal-case!" : "button max-w-64 min-w-0 normal-case!"}>
          <Reicon name="layers" className="size-3.5 shrink-0" />
          <span className="truncate" title={current ?? "All images"}>
            {current ?? "All images"}
          </span>
          <Reicon name="chevron-down" className="size-3.5 shrink-0" />
        </button>
      )}
    >
      {(close) => (
        <>
          {[["", "All images"] as const, ...options.map((o) => [o, o] as const)].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="listbox-option"
              role="option"
              aria-selected={(current ?? "") === value}
              onClick={() => {
                onSelect(value);
                close();
              }}
            >
              <span className={value !== "" ? "truncate font-mono text-[12px]" : "truncate"} title={label}>
                {label}
              </span>
              {(current ?? "") === value ? <Reicon name="check" className="size-3.5 shrink-0" /> : null}
            </button>
          ))}
        </>
      )}
    </TableDropdown>
  );
}

/** <x-table-pagination> */
function Pagination({ paged, onPage, onPerPage }: { paged: Paged<unknown>; onPage: (page: number) => void; onPerPage: (n: number) => void }) {
  return (
    <footer className="pager flex min-h-11 items-center justify-between border-t border-neutral-200 px-4 text-[11px] text-neutral-500 dark:border-white/[0.08] dark:text-fg-faint">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-7 items-center whitespace-nowrap tabular-nums">{`${paged.firstItem ?? 0}-${paged.lastItem ?? 0} of ${paged.total}`}</span>
        <PageSizeSelect value={paged.perPage} onChange={onPerPage} options={[10, 25, 50, 100]} />
      </div>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => onPage(paged.currentPage - 1)} disabled={paged.currentPage <= 1} className={PAGER_BUTTON} aria-label="Previous page">
          <Reicon name="arrow-right" className="size-3.5 rotate-180" />
        </button>
        <button type="button" onClick={() => onPage(paged.currentPage + 1)} disabled={paged.currentPage >= paged.lastPage} className={PAGER_BUTTON} aria-label="Next page">
          <Reicon name="arrow-right" className="size-3.5" />
        </button>
      </div>
    </footer>
  );
}

/** A file the API answered ({ filename, contentType, content }), saved by the browser (response()->streamDownload()). */
function saveFile(file: { filename: string; contentType: string; content: string }) {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.contentType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = file.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** <x-image-scan.export-menu>: copy as Markdown (or the IDs), download CSV or JSON, of the rows on all pages. */
function ExportMenu({ count, noun, withIds, exportPath }: { count: number; noun: "finding" | "resource"; withIds: boolean; exportPath: (format: string) => string }) {
  const copy = exportMenu(count, noun);
  const copyList = async (format: string, done: string) => {
    if (!navigator.clipboard) return notify.error(copy.noClipboard);
    const r = await getJson<{ content: string }>(exportPath(format));
    if (!r.data) return notify.error(copy.copyFailed);
    try {
      await navigator.clipboard.writeText(r.data.content);
      notify.success(done);
    } catch {
      notify.error(copy.copyFailed);
    }
  };
  const download = async (format: string) => {
    const r = await getJson<{ filename: string; contentType: string; content: string }>(exportPath(format));
    if (r.data) saveFile(r.data);
  };
  return (
    <TableDropdown
      panelClass="w-64! p-1!"
      trigger={() => (
        <button type="button" className="button normal-case!" aria-haspopup="menu" disabled={count === 0}>
          <Reicon name="download" className="size-3.5" />
          Export
          <Reicon name="chevron-down" className="size-3.5" />
        </button>
      )}
    >
      {(close) => (
        <>
          <p className="px-2 pb-1.5 pt-1 text-[11px] leading-4 text-neutral-500 dark:text-fg-faint">{copy.intro}</p>
          <button type="button" className="listbox-option" role="menuitem" onClick={() => (close(), void copyList("markdown", copy.markdownDone))}>
            <span className="flex-1 text-left">Copy as Markdown table</span>
          </button>
          {withIds ? (
            <button type="button" className="listbox-option" role="menuitem" onClick={() => (close(), void copyList("ids", copy.idsDone))}>
              <span className="flex-1 text-left">Copy IDs</span>
            </button>
          ) : null}
          <div className="my-1 border-t border-neutral-200 dark:border-white/[0.08]" role="separator" />
          <button type="button" className="listbox-option" role="menuitem" onClick={() => (close(), void download("csv"))}>
            <span className="flex-1 text-left">Download CSV</span>
          </button>
          <button type="button" className="listbox-option" role="menuitem" onClick={() => (close(), void download("json"))}>
            <span className="flex-1 text-left">Download JSON</span>
          </button>
        </>
      )}
    </TableDropdown>
  );
}

// ---------------------------------------------------------------- the main card

type Run = (body: Record<string, unknown>) => Promise<boolean>;

/** security-action.blade.php: one action's button (confirmation first) or its copy text. */
function SecurityAction({ action, primary, withSentence, run }: { action: Action; primary: boolean; withSentence: boolean; run: Run }) {
  const button = action.button;
  return (
    <div className={withSentence ? "flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4" : "flex min-w-0 flex-col gap-2"}>
      {withSentence ? <p className="min-w-0 text-[13px] leading-5 text-neutral-800 dark:text-fg">{action.sentence}</p> : null}
      {button !== null ? (
        <div className="shrink-0">
          <ModalConfirmation
            title={button.title}
            buttonTitle={button.label}
            actions={button.actions}
            warningMessage={button.warning}
            confirmationText={null}
            step2ButtonText={button.label}
            trigger={
              <button type="button" className={primary ? "button button-highlighted normal-case!" : "button normal-case!"}>
                {button.label}
              </button>
            }
            onSubmit={async () => {
              await run(button.submit);
            }}
          />
        </div>
      ) : action.copy ? (
        <div className="flex min-w-0 shrink-0 items-center gap-1">
          <code className={CODE} title={action.copy}>
            {action.copy}
          </code>
          <CopyButton value={action.copy} label={`Copy ${action.copy}`} />
        </div>
      ) : null}
    </div>
  );
}

/** security-image.blade.php: the open content of one image of the main card. */
function SecurityImage({ row, single, canUpdate, run, openFindings }: { row: ImageRow; single: boolean; canUpdate: boolean; run: Run; openFindings: (filter: string | null) => void }) {
  const sentence = splitSentence(row.sentence, row.ref);
  const whyTitle = row.status === "no_fix" ? "Not fixed yet" : "Fixed by this update";
  const otherCount = row.others.length + row.moreActions;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex max-w-3xl flex-col gap-3">
        <p className="text-pretty text-[15px] font-medium leading-6 text-neutral-950 dark:text-fg">
          {sentence.ref !== null ? <code className="break-all font-mono text-[14px]">{sentence.ref}</code> : null}
          {sentence.rest}
        </p>
        {single && row.status !== "check_needed" && row.primary !== null ? <SecurityAction action={row.primary} primary withSentence={false} run={run} /> : null}
        {row.attackNote !== null || row.advice !== null || row.lines.length > 0 || (single && row.versionNotes.length > 0) ? (
          <div className="flex flex-col gap-1">
            {row.attackNote !== null ? <p className={NOTE}>{row.attackNote}</p> : null}
            {row.advice !== null ? <p className={NOTE}>{row.advice}</p> : null}
            {row.lines.map((line) => (
              <p key={line} className={NOTE}>
                {line}
              </p>
            ))}
            {(single ? row.versionNotes : []).map((note) => (
              <p key={note.text} className={NOTE}>
                {note.text}{" "}
                {note.link !== null ? (
                  <a href={note.link} className={LINK}>
                    Registry logins
                  </a>
                ) : null}
              </p>
            ))}
          </div>
        ) : null}
      </div>

      {row.override !== null ? (
        <p className="max-w-3xl text-[12px] leading-5 text-neutral-500 dark:text-fg-faint">
          Freeploy deploys <code className="font-mono">{row.override.to}</code> instead of <code className="font-mono">{row.override.from}</code> from your compose file.{" "}
          {canUpdate ? (
            <button type="button" className={LINK} title="The next deploy uses the image of the compose file again." onClick={() => void run({ action: "removeImageOverride", service: row.override!.service })}>
              Use the compose file
            </button>
          ) : null}
        </p>
      ) : null}

      {row.why.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h4 className="text-[12px] font-medium text-neutral-700 dark:text-fg-dim">{whyTitle}</h4>
          <ul className="flex flex-col divide-y divide-neutral-200 overflow-hidden rounded-lg border border-neutral-200 dark:divide-white/[0.06] dark:border-white/[0.08]" aria-label={whyTitle}>
            {row.why.map((entry) => (
              <li key={`${entry.display_id}${entry.title}`} className="flex flex-col gap-1 px-3 py-2.5">
                <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <span className="min-w-0 text-[13px] leading-5 text-neutral-900 dark:text-fg">{entry.title}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {entry.cvss !== null ? (
                      <>
                        <SeverityBadge severity={entry.severity} />
                        <span className="text-[12px] tabular-nums text-neutral-600 dark:text-fg-dim">{entry.cvss}</span>
                      </>
                    ) : (
                      <SeverityBadge severity={entry.severity} title={entry.cvssNote} />
                    )}
                  </span>
                </div>
                <div className={`flex min-w-0 flex-wrap items-center gap-x-1.5 ${MUTED}`}>
                  {entry.package !== "" ? <span className="min-w-0 break-all font-mono max-sm:w-full">{`${entry.package} ${entry.version}`.trim()}</span> : null}
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                    {entry.package !== "" ? (
                      <span className="max-sm:hidden" aria-hidden="true">
                        ·
                      </span>
                    ) : null}
                    {entry.link !== null ? (
                      <a href={entry.link} target="_blank" rel="noopener noreferrer" className="font-mono underline decoration-neutral-400/40 underline-offset-4 hover:text-neutral-950 hover:decoration-current dark:decoration-white/25 dark:hover:text-fg">
                        {entry.display_id}
                      </a>
                    ) : (
                      <span className="font-mono">{entry.display_id}</span>
                    )}
                  </span>
                  {entry.signal !== null ? (
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                      <span aria-hidden="true">·</span>
                      <span className={entry.exploited ? "text-error" : undefined}>{entry.signal}</span>
                    </span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {row.whyMore > 0 ? (
            <div>
              <button type="button" className={`text-[12px] ${LINK}`} onClick={() => openFindings(row.filter)}>
                {whyMoreText(row.whyMore)} <span aria-hidden="true">→</span>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {row.provenance !== null ? (
        <p className="max-w-3xl text-[12px] leading-5 text-neutral-500 dark:text-fg-faint">
          <span className="font-medium text-neutral-700 dark:text-fg-dim">How Freeploy knows:</span> {row.provenance}
        </p>
      ) : null}

      {row.others.length > 0 ? (
        <details className="group/others">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md text-[12px] font-medium text-neutral-600 hover:text-neutral-950 dark:text-fg-dim dark:hover:text-fg [&::-webkit-details-marker]:hidden">
            <Reicon name="chevron-down" className="size-3.5 shrink-0 -rotate-90 group-open/others:rotate-0" />
            {otherFixesText(otherCount)}
          </summary>
          <div className="mt-2 flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-white/[0.06] dark:border-white/[0.08]">
            {row.others.map((other) => (
              <div key={other.key} className="px-3 py-2.5">
                <SecurityAction action={other} primary={false} withSentence run={run} />
              </div>
            ))}
          </div>
          {row.moreActions > 0 ? <p className={`mt-2 ${MUTED} text-[12px]!`}>and {numberFormat(row.moreActions)} more</p> : null}
        </details>
      ) : null}
    </div>
  );
}

/** One image of a list: its header row, closed or open (spec 15.11). */
function ImageListItem({ row, first, canUpdate, run, openFindings }: { row: ImageRow; first: boolean; canUpdate: boolean; run: Run; openFindings: (filter: string | null) => void }) {
  const [open, setOpen] = useState(row.open);
  return (
    <li>
      <div className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
        <button type="button" className="group flex min-w-0 flex-1 items-center gap-2 rounded-md text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Reicon name="chevron-down" className={`size-3.5 shrink-0 text-neutral-500 transition-transform dark:text-fg-faint${open ? "" : " -rotate-90"}`} />
          <span className="flex min-w-0 flex-col">
            {row.name !== null ? (
              <>
                <span className="truncate text-[13px] font-medium text-neutral-950 dark:text-fg">{row.name}</span>
                <code className="truncate font-mono text-[11px] text-neutral-500 dark:text-fg-faint" title={row.ref}>
                  {row.ref}
                </code>
              </>
            ) : (
              <code className="truncate font-mono text-[12px] text-neutral-900 dark:text-fg" title={row.ref}>
                {row.ref}
              </code>
            )}
          </span>
        </button>
        <div className="flex shrink-0 flex-wrap items-center gap-2 pl-5.5 sm:pl-0">
          {row.badge !== null ? <StatusBadge type={badgeTypeOf(row.badgeType)} label={row.badge} /> : <span className={MUTED}>{row.status === "ok" ? "No action needed" : "Not checked"}</span>}
          {row.mergedWith !== null ? <span className={MUTED}>Updated with {row.mergedWith}</span> : row.primary !== null ? <SecurityAction action={row.primary} primary={first} withSentence={false} run={run} /> : null}
        </div>
      </div>
      {row.versionNotes.map((note) => (
        <p key={note.text} className="-mt-1 truncate px-3 pb-2 text-[11px] text-neutral-500 sm:pl-8.5 dark:text-fg-faint" title={note.text}>
          {note.text}{" "}
          {note.link !== null ? (
            <a href={note.link} className="underline underline-offset-4 hover:text-neutral-950 dark:hover:text-fg">
              Registry logins
            </a>
          ) : null}
        </p>
      ))}
      {open ? (
        <div className="px-3 pb-3 pt-1 sm:pl-8.5">
          <SecurityImage row={row} single={false} canUpdate={canUpdate} run={run} openFindings={openFindings} />
        </div>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------- the findings

function FindingRowView({ row, nested, showsImage, canUpdate, onIgnore }: { row: FindingRow; nested: boolean; showsImage: boolean; canUpdate: boolean; onIgnore: (target: string, kind: "vulnerability" | "package", owner: string, neverAllowed: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const hasDetails = row.summary !== "" || row.likelihood !== null || row.aliases.length > 0 || row.ignore !== null || (row.base !== null && row.base !== "");
  const grid = ["data-table-row image-scan-findings-grid", nested ? "is-nested" : "", !nested && showsImage ? "has-image" : ""].filter(Boolean).join(" ");
  return (
    <div className="border-b border-neutral-200 last:border-b-0 dark:border-white/[0.06]">
      <div className={grid}>
        <div className="flex min-w-0 items-center gap-1.5">
          {!nested ? (
            <button type="button" className="icon-button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Show details of ${row.id}`}>
              <Reicon name="chevron-down" className={`size-3.5 transition-transform duration-150 ${open ? "rotate-0" : "-rotate-90"}`} />
            </button>
          ) : null}
          {row.url !== null ? (
            <a href={row.url} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-[12px] font-medium text-neutral-950 underline-offset-4 hover:underline dark:text-fg">
              {row.id}
            </a>
          ) : (
            <span className="truncate font-mono text-[12px] font-medium text-neutral-950 dark:text-fg">{row.id}</span>
          )}
        </div>
        {!nested ? (
          <>
            <span className="image-scan-secondary min-w-0 truncate text-[12px] text-neutral-700 dark:text-fg-dim" title={row.package}>
              {row.package}
            </span>
            {showsImage ? (
              <span className={`image-scan-secondary min-w-0 truncate ${MUTED}`} title={row.image}>
                {row.image}
              </span>
            ) : null}
          </>
        ) : null}
        <span className="image-scan-secondary min-w-0 truncate font-mono text-[11px] text-neutral-600 dark:text-fg-dim">
          {row.version}
          {row.fixedIn ? ` → ${row.fixedIn}` : ""}
        </span>
        <span className="image-scan-severity-cell flex min-w-0 flex-wrap items-center gap-1">
          <SeverityBadge severity={row.severity} />
          {row.kev ? (
            <span title="Attackers are using this, according to CISA.">
              <StatusBadge type="error" label="Known exploited" />
            </span>
          ) : null}
        </span>
        <span className="flex justify-end">
          {row.ignore !== null ? (
            <span className={MUTED} title={row.ignore.reason}>
              Ignored{row.ignore.until ? ` until ${row.ignore.until}` : ""}
            </span>
          ) : canUpdate ? (
            <button type="button" className="icon-button" title="Ignore" aria-label={`Ignore ${row.id}`} onClick={() => onIgnore(row.id, "vulnerability", row.owner, row.neverAllowed)}>
              <Reicon name="eye-off2" className="size-3.5" />
            </button>
          ) : null}
        </span>
      </div>
      {hasDetails && (nested || open) ? (
        <div className={`flex flex-col gap-1 px-4 pb-3 text-[12px] text-neutral-600 dark:text-fg-dim${nested ? "" : " pl-12"}`}>
          {row.summary !== "" ? <p className="max-w-3xl">{row.summary}</p> : null}
          {row.likelihood !== null ? <p className={MUTED}>Exploit likelihood: {row.likelihood}</p> : null}
          {row.base ? (
            <p className={MUTED}>
              Comes from <span className="font-mono">{row.base}</span>.
            </p>
          ) : null}
          {row.aliases.length > 0 ? (
            <p className={MUTED}>
              Also known as{" "}
              {row.aliases.map((alias, i) => (
                <span key={alias.id}>
                  {alias.url !== null ? (
                    <a href={alias.url} target="_blank" rel="noopener noreferrer" className="font-mono underline-offset-4 hover:underline">
                      {alias.id}
                    </a>
                  ) : (
                    <span className="font-mono">{alias.id}</span>
                  )}
                  {i === row.aliases.length - 1 ? "" : ", "}
                </span>
              ))}
            </p>
          ) : null}
          {row.ignore !== null ? <p className={MUTED}>Reason: {row.ignore.reason}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function PackageGroupView({ group, showsImage, canUpdate, onIgnore }: { group: PackageGroup; showsImage: boolean; canUpdate: boolean; onIgnore: (target: string, kind: "vulnerability" | "package", owner: string, neverAllowed: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-neutral-200 last:border-b-0 dark:border-white/[0.08]">
      <div className={`data-table-row image-scan-packages-grid${showsImage ? " has-image" : ""}`}>
        <div className="flex min-w-0 items-center gap-1.5">
          <button type="button" className="icon-button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Show the findings of ${group.package}`}>
            <Reicon name="chevron-down" className={`size-3.5 transition-transform duration-150 ${open ? "rotate-0" : "-rotate-90"}`} />
          </button>
          <span className="truncate text-[12px] font-medium text-neutral-950 dark:text-fg" title={group.package}>
            {group.package}
          </span>
        </div>
        {showsImage ? (
          <span className={`image-scan-secondary truncate ${MUTED}`} title={group.image}>
            {group.image}
          </span>
        ) : null}
        <span className="image-scan-secondary min-w-0 truncate font-mono text-[11px] text-neutral-600 dark:text-fg-dim" title={`${group.version}${group.fixed ? ` → ${group.fixed}` : ""}`}>
          {group.version}
          {group.fixed ? ` → ${group.fixed}` : ""}
        </span>
        <span className="image-scan-severity-cell flex min-w-0 flex-wrap items-center gap-1">
          <SeverityBadge severity={group.severity} />
          {group.kev ? (
            <span title="Attackers are using this, according to CISA.">
              <StatusBadge type="error" label="Known exploited" />
            </span>
          ) : null}
        </span>
        <span className="image-scan-secondary text-[12px] tabular-nums text-neutral-600 dark:text-fg-dim">{numberFormat(group.count)}</span>
        <span className="flex justify-end">
          {canUpdate ? (
            <button type="button" className="icon-button" title="Ignore package" aria-label={`Ignore ${group.package}`} onClick={() => onIgnore(group.package, "package", group.owner, group.neverAllowed)}>
              <Reicon name="eye-off2" className="size-3.5" />
            </button>
          ) : null}
        </span>
      </div>
      {open ? (
        <div className="border-t border-neutral-200 bg-neutral-50/60 dark:border-white/[0.06] dark:bg-white/[0.015]">
          {group.rows.map((row) => (
            <FindingRowView key={row.key} row={row} nested showsImage={showsImage} canUpdate={canUpdate} onIgnore={onIgnore} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** ignore-modal.blade.php: one modal for every Ignore button. */
function IgnoreModal({ request, canIgnoreForTeam, onClose, run }: { request: { target: string; kind: "vulnerability" | "package"; owner: string; neverAllowed: boolean } | null; canIgnoreForTeam: boolean; onClose: () => void; run: Run }) {
  const [scope, setScope] = useState("resource");
  const [expires, setExpires] = useState("90");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setScope("resource");
    setExpires("90");
    setReason("");
  }, [request]);
  if (request === null) return null;
  const m = ignoreModal(request.kind, request.neverAllowed, canIgnoreForTeam);
  const submit = async () => {
    if (saving || reason.trim() === "") return;
    setSaving(true);
    // Validation errors arrive as an error toast; the modal stays open so the input can be fixed.
    const saved = await run({ action: "ignore", target: request.target, kind: request.kind, scope, expires, reason, ownerUuid: request.owner });
    setSaving(false);
    if (saved) onClose();
  };
  return (
    <ModalInput title={m.title} open onOpenChange={(o) => (o ? undefined : onClose())}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="break-all font-mono text-[12px] text-neutral-600 dark:text-fg-dim">{request.target}</p>
        <div className="flex-1 form-control">
          <label htmlFor="image-scan-ignore-reason" className="mb-1.5 flex items-center gap-1 text-sm font-medium leading-4">
            Reason <span className="text-error">*</span>
          </label>
          <textarea id="image-scan-ignore-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} required className="input scrollbar" placeholder="Why this does not affect the app" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Listbox id="image-scan-ignore-scope" label="Scope" options={m.scopeOptions} value={scope} onChange={setScope} />
          <Listbox id="image-scan-ignore-expires" label="Expires" {...(m.expiresHelper ? { helper: m.expiresHelper } : {})} options={m.expiresOptions} value={expires} onChange={setExpires} />
        </div>
        <div className="flex justify-end gap-2">
          <Button className="normal-case!" onClick={onClose}>
            Cancel
          </Button>
          <Button className="normal-case!" highlighted disabled={saving || reason.trim() === ""} onClick={() => void submit()}>
            Ignore
          </Button>
        </div>
      </form>
    </ModalInput>
  );
}

// ---------------------------------------------------------------- the page

/** The page's data: the resource through its project and environment (Configuration::mount()), or back to the environment. */
function useSecurityPage(kind: ResourceKind) {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const uuid = resourceUuidFromPath(kind);
  const base = `${resourceApi(kind, me.team?.id, uuid)}/vulnerabilities`;
  const [findings, setFindingsState] = useState<FindingsState>(INITIAL_FINDINGS);
  const [packages, setPackagesState] = useState<PackagesState>(INITIAL_PACKAGES);
  const [data, setData] = useState<SecurityData | null>(null);
  const load = useCallback(async () => {
    const r = await getJson<SecurityData>(base + resourceQuery(findings, packages));
    if (!r.data) {
      if (r.status === 404) window.location.replace(environmentPath(projectUuid, environmentUuid));
      return;
    }
    const frame = resourceFrame(r.data);
    if (frame.project.uuid !== projectUuid || frame.environment.uuid !== environmentUuid) return window.location.replace("/projects");
    setData(r.data);
  }, [base, findings, packages, projectUuid, environmentUuid]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (data) document.title = `${limit(resourceFrame(data).name, 10)} > Configuration | Freeploy`;
  }, [data]);
  /** One of the page's actions: its toasts; an error toast for a refusal. True when it did not fail. */
  const run: Run = useCallback(
    async (body) => {
      const r = await postJson<{ toasts: Array<{ type: string; message: string }> }>(base, body, "PATCH");
      if (!r.ok) {
        notify.error(r.error.messages[0] ?? "Something went wrong.");
        return false;
      }
      for (const t of r.data.toasts) (t.type === "success" ? notify.success : notify.error)(t.message);
      await load();
      return true;
    },
    [base, load],
  );
  return { me, base, data, findings, setFindingsState, packages, setPackagesState, run };
}

function SecurityContent({ kind }: { kind: ResourceKind }) {
  const page = useSecurityPage(kind);
  const { me, data, findings, setFindingsState, packages, setPackagesState, run, base } = page;
  const [ignore, setIgnore] = useState<{ target: string; kind: "vulnerability" | "package"; owner: string; neverAllowed: boolean } | null>(null);
  if (!data) return null;
  const v = data.vulnerabilities;
  const exportPath = (format: string) => `${base}/export${resourceQuery(findings, packages)}${resourceQuery(findings, packages) ? "&" : "?"}format=${format}`;
  const openFindings = (filter: string | null) => {
    if (filter !== null) setFindingsState(showImageFindings(findings, filter, v.imageOptions ?? []));
    document.getElementById("all-findings-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  const onIgnore = (target: string, k: "vulnerability" | "package", owner: string, neverAllowed: boolean) => setIgnore({ target, kind: k, owner, neverAllowed });

  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Security">
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-6">
          {v.offState === "server" ? (
            <Empty title={`Image scanning is off for ${v.serverName}.`} {...(v.serverUrl === null ? { description: "Ask a team admin to turn it on." } : {})} iconName="shield-alert">
              {v.serverUrl !== null ? (
                <a className="button normal-case!" href={v.serverUrl}>
                  Turn on
                </a>
              ) : null}
            </Empty>
          ) : v.offState === "application" ? (
            <Empty title="Image scanning is off for this app." description="Turn on Scan this app in the settings below." iconName="shield-alert" />
          ) : (
            <MainAndFindings data={data} kind={kind} findings={findings} setFindings={setFindingsState} run={run} openFindings={openFindings} onIgnore={onIgnore} exportPath={exportPath} />
          )}
          {v.canUpdate ? <IgnoreModal request={ignore} canIgnoreForTeam={v.canIgnoreForTeam ?? false} onClose={() => setIgnore(null)} run={run} /> : null}
        </div>
        <PackagesSection p={data.packages} state={packages} setState={setPackagesState} />
        <ScanSettingsSection s={data.settings} run={run} />
      </div>
    </ResourceWorkspace>
  );
}

function MainAndFindings(props: {
  data: SecurityData;
  kind: ResourceKind;
  findings: FindingsState;
  setFindings: (s: FindingsState) => void;
  run: Run;
  openFindings: (filter: string | null) => void;
  onIgnore: (target: string, kind: "vulnerability" | "package", owner: string, neverAllowed: boolean) => void;
  exportPath: (format: string) => string;
}) {
  const { data, findings, setFindings: set, run, openFindings, onIgnore } = props;
  const v = data.vulnerabilities;
  const card = v.card ?? null;
  const checkNeeded = card?.status === "check_needed" && !card.checking;
  const items = v.items!;
  const showsImage = v.showsImage ?? false;
  const state = v.state!;
  const stateCounts = v.stateCounts ?? { fixed: 0, no_fix: 0 };
  return (
    <>
      <SettingsSection
        id="security-section"
        title="Security"
        badges={card?.badge ? <StatusBadge type={badgeTypeOf(card.badgeType)} label={card.badge} /> : undefined}
        actions={
          <>
            {v.checkedAt ? (
              <span className={MUTED} title={v.checkedAt.title}>
                Checked {v.checkedAt.ago}
              </span>
            ) : null}
            {v.canUpdate ? (
              <Button className="normal-case!" highlighted={checkNeeded || (card === null && !v.isApplication)} onClick={() => void run({ action: "scanNow" })}>
                <Reicon name="refresh" className="size-3.5" />
                Scan now
              </Button>
            ) : null}
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {card === null ? (
            <Empty size="sm" title={v.isApplication ? "Not scanned yet. The next deploy scans the image." : "Not scanned yet."} />
          ) : card.single && card.rows.length === 1 ? (
            <SecurityImage row={card.rows[0]!} single canUpdate={v.canUpdate} run={run} openFindings={openFindings} />
          ) : (
            <>
              {card.header !== null ? <p className="text-[15px] font-medium leading-6 text-neutral-950 dark:text-fg">{card.header}</p> : null}
              <ul className="flex flex-col divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-white/[0.06] dark:border-white/[0.08]" aria-label="Images">
                {card.rows.map((row, i) => (
                  <ImageListItem key={row.key} row={row} first={i === 0} canUpdate={v.canUpdate} run={run} openFindings={openFindings} />
                ))}
              </ul>
            </>
          )}
        </div>
      </SettingsSection>

      {v.hasScans ? (
        <SettingsSection id="all-findings-section" title={`All findings (${numberFormat(v.findingCount ?? 0)})`} flush actions={<ExportMenu count={v.shownCount ?? 0} noun="finding" withIds exportPath={props.exportPath} />}>
          {v.truncated ? (
            <div className="border-b border-neutral-200 p-3 dark:border-white/[0.08]">
              <Callout type="info" title="Too many results">
                Only part of the results is shown, with the problems that attackers are using first.
              </Callout>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 p-3 dark:border-white/[0.08]">
            <TableSearch placeholder="Search by ID or package" value={state.search} onChange={(search) => set(setFindings(findings, { search }))} />
            {!state.showIgnored ? (
              <div className="inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-neutral-100 p-1 dark:bg-white/[0.04]" role="group" aria-label="Fix state">
                {Object.entries(v.fixStates ?? {}).map(([value, label]) => (
                  <button key={value} type="button" onClick={() => set(setFixState(findings, value))} aria-pressed={state.fixState === value} className={`${SEGMENT} ${state.fixState === value ? SEGMENT_ACTIVE : SEGMENT_IDLE}`}>
                    {label} <span className="tabular-nums">({numberFormat(stateCounts[value] ?? 0)})</span>
                  </button>
                ))}
              </div>
            ) : null}
            <ImageSelect options={v.imageOptions ?? []} selected={state.images} onSelect={(image) => set(selectImage(findings, image, v.imageOptions ?? []))} />
            <TableFilter activeCount={state.severities.length} onReset={() => set(resetFindingFilters(findings))}>
              <span className={GROUP_LABEL}>Severity</span>
              {(v.severityOptions ?? []).map((option) => (
                <button key={option} type="button" className="listbox-option" role="option" aria-selected={state.severities.includes(option)} onClick={() => set(toggleSeverity(findings, option))}>
                  <span>{option[0]!.toUpperCase() + option.slice(1)}</span>
                  <Check selected={state.severities.includes(option)} />
                </button>
              ))}
            </TableFilter>
            {!state.showIgnored ? (
              <div className="inline-flex items-center gap-0.5 rounded-lg bg-neutral-100 p-1 dark:bg-white/[0.04]" role="group" aria-label="Group results">
                {(
                  [
                    ["package", "By package"],
                    ["cve", "By CVE"],
                  ] as const
                ).map(([value, label]) => (
                  <button key={value} type="button" onClick={() => set(setFindings(findings, { view: value }))} aria-pressed={state.view === value} className={`${SEGMENT} ${state.view === value ? SEGMENT_ACTIVE : SEGMENT_IDLE}`}>
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {state.showIgnored ? (
            <div className="flex items-center justify-between gap-2 border-b border-neutral-200 px-4 py-2 dark:border-white/[0.08]">
              <span className="text-[12px] font-medium text-neutral-700 dark:text-fg">Ignored</span>
              <button type="button" className="text-[12px] font-medium text-coollabs hover:underline dark:text-brand-light" onClick={() => set(setFindings(findings, { showIgnored: false }))}>
                Back to the results
              </button>
            </div>
          ) : null}
          <div className="relative">
            {items.items.length === 0 ? (
              !state.showIgnored && !v.hasFilters && state.fixState === "fixed" ? (
                <Empty size="sm" title="No finding has a fixed version.">
                  {(stateCounts.no_fix ?? 0) > 0 ? (
                    <button type="button" className="button normal-case!" onClick={() => set(setFixState(findings, "no_fix"))}>
                      No fix yet ({numberFormat(stateCounts.no_fix ?? 0)})
                    </button>
                  ) : null}
                </Empty>
              ) : v.hasFilters ? (
                <Empty size="sm" title="No matching findings" description="Try another search, or reset the filters." />
              ) : (
                <Empty size="sm" title={state.showIgnored ? "No ignored findings." : "No findings in this group."} />
              )
            ) : v.grouped ? (
              <div className="data-table">
                <div className={`data-table-header image-scan-packages-grid${showsImage ? " has-image" : ""}`}>
                  <span>Package</span>
                  {showsImage ? <span className="image-scan-secondary">Image</span> : null}
                  <span className="image-scan-secondary">Version</span>
                  <span className="image-scan-severity-cell">Severity</span>
                  <span className="image-scan-secondary">Findings</span>
                  <span className="sr-only">Actions</span>
                </div>
                {(items.items as PackageGroup[]).map((group) => (
                  <PackageGroupView key={group.key} group={group} showsImage={showsImage} canUpdate={v.canUpdate} onIgnore={onIgnore} />
                ))}
              </div>
            ) : (
              <div className="data-table">
                <div className={`data-table-header image-scan-findings-grid${showsImage ? " has-image" : ""}`}>
                  <span>Finding</span>
                  <span className="image-scan-secondary">Package</span>
                  {showsImage ? <span className="image-scan-secondary">Image</span> : null}
                  <span className="image-scan-secondary">Version</span>
                  <span className="image-scan-severity-cell">Severity</span>
                  <span className="sr-only">Actions</span>
                </div>
                {(items.items as FindingRow[]).map((row) => (
                  <FindingRowView key={row.key} row={row} nested={false} showsImage={showsImage} canUpdate={v.canUpdate} onIgnore={onIgnore} />
                ))}
              </div>
            )}
          </div>
          {v.groupedFindingCount !== null && v.groupedFindingCount !== undefined && items.total > 0 ? (
            <p className={`border-t border-neutral-200 px-4 py-2.5 ${MUTED} tabular-nums dark:border-white/[0.08]`}>
              {countOf(v.groupedFindingCount, "finding")} in {countOf(items.total, "package")}
            </p>
          ) : null}
          <Pagination paged={items} onPage={(page) => set({ ...findings, page })} onPerPage={(perPage) => set(setFindings(findings, { perPage }))} />
          {(v.ignoredCount ?? 0) > 0 && !state.showIgnored ? (
            <div className="border-t border-neutral-200 px-4 py-2.5 dark:border-white/[0.08]">
              <button type="button" className="text-[12px] font-medium text-coollabs hover:underline dark:text-brand-light" onClick={() => set(setFindings(findings, { showIgnored: true }))}>
                {numberFormat(v.ignoredCount ?? 0)} ignored
              </button>
            </div>
          ) : null}
        </SettingsSection>
      ) : null}
    </>
  );
}

/** packages.blade.php: the packages of the stored package lists, and the SBOM downloads. */
function PackagesSection({ p, state, setState }: { p: Packages; state: PackagesState; setState: (s: PackagesState) => void }) {
  if (!p.hasScans) return null;
  const resourcePath = window.location.pathname.replace(/\/vulnerabilities\/?$/, "");
  return (
    <SettingsSection
      id="packages-section"
      title="Packages and SBOM"
      flush
      helper="The software packages that Freeploy found in the image, with their versions and licenses. The SBOM (software bill of materials) is the full list of these packages in a standard format (CycloneDX or SPDX). Download it for audits or for other security tools."
      actions={
        <TableDropdown
          panelClass="min-w-56! p-1!"
          trigger={() => (
            <button type="button" className="button normal-case!" aria-haspopup="menu">
              <Reicon name="download" className="size-3.5" />
              Download SBOM
              <Reicon name="chevron-down" className="size-3.5" />
            </button>
          )}
        >
          {(close) => (
            <>
              {p.downloads.map((d) => (
                <div key={d.scanUuid}>
                  {p.downloads.length > 1 ? (
                    <span className={`${GROUP_LABEL} block max-w-72 truncate normal-case tracking-normal`} title={d.image}>
                      {d.image}
                    </span>
                  ) : null}
                  <a className="listbox-option" role="menuitem" href={sbomPath(resourcePath, d.scanUuid, "cyclonedx")} onClick={close}>
                    CycloneDX 1.6 JSON
                  </a>
                  <a className="listbox-option" role="menuitem" href={sbomPath(resourcePath, d.scanUuid, "spdx")} onClick={close}>
                    SPDX 2.3 JSON
                  </a>
                </div>
              ))}
            </>
          )}
        </TableDropdown>
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 p-3 dark:border-white/[0.08]">
        <TableSearch placeholder="Search packages" value={state.search} onChange={(search) => setState({ ...state, search, page: 1 })} />
        <ImageSelect options={p.imageOptions} selected={state.images} onSelect={(image) => setState(showPackageImage(state, image))} />
        {p.typeOptions.length > 0 ? (
          <TableFilter activeCount={state.types.length} onReset={() => setState(resetPackageFilters(state))}>
            <span className={GROUP_LABEL}>Type</span>
            {p.typeOptions.map((option) => (
              <button key={option} type="button" className="listbox-option" role="option" aria-selected={state.types.includes(option)} onClick={() => setState(togglePackageType(state, option))}>
                <span className="truncate">{option}</span>
                <Check selected={state.types.includes(option)} />
              </button>
            ))}
          </TableFilter>
        ) : null}
      </div>
      {p.truncated ? (
        <div className="border-b border-neutral-200 p-3 dark:border-white/[0.08]">
          <Callout type="info" title="Too many packages">
            Only the first 10,000 are shown.
          </Callout>
        </div>
      ) : null}
      <div className="relative">
        {p.items.items.length === 0 ? (
          <Empty size="sm" title={p.total === 0 ? "No packages found." : "No matching packages"} {...(p.total === 0 ? {} : { description: "Try another search, or reset the filters." })} />
        ) : (
          <div className="data-table">
            <div className={`data-table-header image-scan-sbom-grid${p.showsImage ? " has-image" : ""}`}>
              <span>Package</span>
              <span>Version</span>
              <span className="image-scan-secondary">Type</span>
              {p.showsImage ? <span className="image-scan-secondary">Image</span> : null}
              <span className="image-scan-secondary">License</span>
            </div>
            {p.items.items.map((pkg) => (
              <div key={pkg.key} className={`data-table-row image-scan-sbom-grid border-b border-neutral-200 last:border-b-0 dark:border-white/[0.08]${p.showsImage ? " has-image" : ""}`}>
                <span className="min-w-0 truncate text-[12px] font-medium text-neutral-950 dark:text-fg" title={pkg.purl || pkg.name}>
                  {pkg.name}
                </span>
                <span className="min-w-0 truncate font-mono text-[11px] text-neutral-600 dark:text-fg-dim">{pkg.version}</span>
                <span className="image-scan-secondary min-w-0 truncate text-[11px] text-neutral-600 dark:text-fg-dim">{pkg.type}</span>
                {p.showsImage ? (
                  <span className="image-scan-secondary min-w-0 truncate text-[11px] text-neutral-500 dark:text-fg-faint" title={pkg.image}>
                    {pkg.image}
                  </span>
                ) : null}
                <span className="image-scan-secondary min-w-0 truncate text-[11px] text-neutral-600 dark:text-fg-dim" title={pkg.licenses.join(", ")}>
                  {pkg.licenses.join(", ")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <Pagination paged={p.items} onPage={(page) => setState({ ...state, page })} onPerPage={(perPage) => setState({ ...state, perPage, page: 1 })} />
    </SettingsSection>
  );
}

const IGNORES_HELPER = "Ignored findings do not count for the status, alerts, or Block deploys. Ignore a finding from All findings on the Security page of a resource.";

/** scan-ignores.blade.php */
function ScanIgnores({ s, run }: { s: Pick<ScanSettings, "ignores" | "canEdit" | "showsTeamSettingsLink">; run: Run }) {
  if (s.ignores.length === 0) return <Empty size="sm" title="No ignored findings." />;
  return (
    <div className="data-table">
      <div className="data-table-header image-scan-ignores-table-grid">
        <span>Finding or package</span>
        <span>Reason</span>
        <span>Expires</span>
        <span>Set for</span>
        <span className="text-right">Actions</span>
      </div>
      {s.ignores.map((ignore) => (
        <div key={ignore.uuid} className="data-table-row image-scan-ignores-table-grid border-b border-neutral-200 last:border-b-0 dark:border-white/[0.07]">
          <div className="min-w-0 truncate text-[12px] text-black dark:text-fg">
            {ignore.vulnerabilityId ? (
              <span className="font-mono">{ignore.vulnerabilityId}</span>
            ) : (
              <>
                All findings in <span className="font-mono">{ignore.package}</span>
              </>
            )}
          </div>
          <div className="min-w-0 truncate text-[12px] text-neutral-600 dark:text-fg-dim" title={ignore.reason}>
            {ignore.reason}
          </div>
          <div className="text-[11px] text-neutral-500 dark:text-fg-dim">{ignore.expires ?? "Never"}</div>
          <div className="min-w-0 text-[11px] text-neutral-500 dark:text-fg-dim">{ignore.teamWide ? "All team resources" : (ignore.ownerName ?? "This resource")}</div>
          <div className="flex justify-end">
            {ignore.teamWide ? (
              s.showsTeamSettingsLink ? (
                <a href="/team/image-scanning" className="inline-flex h-7 items-center rounded-md px-2 text-[11px] font-medium text-neutral-600 hover:bg-neutral-100 dark:text-fg-dim dark:hover:bg-white/[0.06]">
                  Team settings
                </a>
              ) : null
            ) : s.canEdit ? (
              <ModalConfirmation
                title="Remove this ignore?"
                actions={["The finding counts again for the status, alerts, and Block deploys."]}
                confirmationText={null}
                step2ButtonText="Remove"
                trigger={
                  <button type="button" className="inline-flex h-7 items-center rounded-md px-2 text-[11px] font-medium text-error transition-colors hover:bg-error/10">
                    Remove
                  </button>
                }
                onSubmit={async () => {
                  await run({ action: "removeIgnore", uuid: ignore.uuid });
                }}
              />
            ) : null}
          </div>
        </div>
      ))}
    </div>
  );
}

/** scan-settings.blade.php of a resource: an application's Settings card, or a database's and a service's Ignored findings. */
function ScanSettingsSection({ s, run }: { s: ScanSettings; run: Run }) {
  if (s.rules === null) {
    return (
      <SettingsSection id="image-scan-ignores-section" title="Ignored findings" helper={IGNORES_HELPER} flush>
        <ScanIgnores s={s} run={run} />
      </SettingsSection>
    );
  }
  const r = s.rules;
  const inherit = (field: string, options: Array<{ value: string; label: string; description?: string }>) => [{ value: "", label: r.inheritLabels[field] ?? "" }, ...options];
  return (
    <SettingsSection id="image-scan-settings-section" title="Settings">
      <SettingsSubsection title="Rules" helper="Rules for this app." first>
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Listbox id="appScanEnabled" label="Scan this app" disabled={!s.canEdit} helper="Off stops the scans of this app's image." options={[{ value: "1", label: "On" }, { value: "0", label: "Off" }]} value={r.appScanEnabled} onChange={(value) => void run({ action: "appScanEnabled", value })} />
            {r.isDockerImage ? (
              <Listbox
                id="buildsByTeam"
                label="Who builds this image"
                disabled={!s.canEdit}
                helper="Freeploy detects whether your team builds this image. Set it when the detection is wrong."
                options={[
                  { value: "", label: "Detect automatically" },
                  { value: "1", label: "My team" },
                  { value: "0", label: "Someone else" },
                ]}
                value={r.buildsByTeam}
                onChange={(value) => void run({ action: "buildsByTeam", value })}
              />
            ) : null}
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <div className="min-w-0">
              <Listbox id="gateMode" label="Block deploys" disabled={!s.canEdit || !r.appScanOn} helper="Stop a deploy when the new image has security problems." options={inherit("gate_mode", r.gateModeOptions)} value={r.gateMode} onChange={(value) => void run({ action: "saveRule", column: "gate_mode", value })} />
              {!r.appScanOn ? <p className="mt-1.5 text-[12px] text-neutral-500 dark:text-fg-faint">Turn on the scan for this app first.</p> : null}
            </div>
            <Listbox id="onScanError" label="If the scan cannot run" disabled={!s.canEdit} helper="Applies when Block deploys is On or Strict." options={inherit("on_scan_error", r.onScanErrorOptions)} value={r.onScanError} onChange={(value) => void run({ action: "saveRule", column: "on_scan_error", value })} />
            <Listbox
              id="countMedium"
              label="Count medium problems"
              disabled={!s.canEdit}
              helper="Medium problems that an update fixes give a security update. Problems that attackers are likely to use always count."
              options={inherit("count_medium", r.countMediumOptions)}
              value={r.countMedium}
              onChange={(value) => void run({ action: "saveRule", column: "count_medium", value })}
            />
          </div>
        </div>
      </SettingsSubsection>
      <SettingsSubsection title="Ignored findings" helper={IGNORES_HELPER}>
        <div className="overflow-hidden rounded-lg border border-neutral-200 dark:border-white/[0.08]">
          <ScanIgnores s={s} run={run} />
        </div>
      </SettingsSubsection>
    </SettingsSection>
  );
}

const configurationPage = (content: ReactNode) => (
  <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
    {content}
  </Layout>
);

export const ApplicationVulnerabilitiesPage = () => configurationPage(<SecurityContent kind="application" />);
export const ServiceVulnerabilitiesPage = () => configurationPage(<SecurityContent kind="service" />);
export const DatabaseVulnerabilitiesPage = () => configurationPage(<SecurityContent kind="database" />);

// ---------------------------------------------------------------- an SBOM download

/** ImageScanSbomController: the file of a current scan's stored package list, saved; then back to the Security page. */
function SbomDownload({ kind }: { kind: ResourceKind }) {
  const { me } = useSignedIn();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const route = sbomFromPath(window.location.pathname);
    if (route === null) return setFailed(true);
    const uuid = resourceUuidFromPath(kind);
    const path = `${resourceApi(kind, me.team?.id, uuid)}/vulnerabilities/sbom/${encodeURIComponent(route.scanUuid)}/${encodeURIComponent(route.format)}?environment=${encodeURIComponent(environmentOfPath(window.location.pathname) ?? "")}`;
    void (async () => {
      const r = await getJson<{ filename: string; contentType: string; content: string }>(path);
      if (!r.data) return setFailed(true);
      saveFile(r.data);
      window.location.replace(`${route.resourcePath}/vulnerabilities`);
    })();
  }, [kind, me.team?.id]);
  return failed ? <Empty title="Not found" description="This SBOM is not available." iconName="shield-alert" /> : null;
}

export const ApplicationSbomPage = () => configurationPage(<SbomDownload kind="application" />);
export const ServiceSbomPage = () => configurationPage(<SbomDownload kind="service" />);
export const DatabaseSbomPage = () => configurationPage(<SbomDownload kind="database" />);

// ---------------------------------------------------------------- the team's Security page

interface FleetItem {
  key: string;
  name: string;
  link: string | null;
  project: string | null;
  environment: string | null;
  server: string | null;
  status: string;
  statusLabel: string;
  badgeType: string | null;
  imagesLine: string | null;
  action: { text: string; link: boolean; muted: boolean } | null;
  match: { id: string; package: string; version: string; fixedIn: string | null; severity: string; state: string; more: number } | null;
  checkedAt: { iso: string; ago: string; title: string } | null;
}
interface FleetData {
  state: Omit<FleetState, "page" | "perPage">;
  items: Paged<FleetItem>;
  shownCount: number;
  searching: boolean;
  notScannedLine: string | null;
  notCheckedToggle: string | null;
  hidesNotChecked: boolean;
  searchCapped: boolean;
  maxDecodedScans: number;
  serversNotScanning: number;
  serverOptions: Record<string, string>;
  projectOptions: Record<string, string>;
  statusOptions: Record<string, string>;
  hasFilters: boolean;
  hasResources: boolean;
  stateLabels: Record<string, string>;
}

function FleetContent() {
  const { me } = useSignedIn();
  const api = `/v1/organizations/${me.team?.id ?? ""}/deploy/vulnerabilities`;
  const [state, setState] = useState<FleetState>(() => fleetStateFromUrl(window.location.search));
  const [data, setData] = useState<FleetData | null>(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    void (async () => {
      const r = await getJson<FleetData>(api + fleetQuery(state));
      if (r.data) setData(r.data);
    })();
    history.replaceState(null, "", fleetUrl(state));
  }, [api, state]);
  const dismissKey = `coolify.image-scan.servers-not-scanning-dismissed.${me.team?.id ?? ""}.${data?.serversNotScanning ?? 0}`;
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(dismissKey) === "1");
    } catch {
      setDismissed(false);
    }
  }, [dismissKey]);
  if (!data) return null;
  const exportPath = (format: string) => `${api}/export${fleetQuery(state)}${fleetQuery(state) ? "&" : "?"}format=${format}`;
  const count = data.state.statuses.length + data.state.servers.length + data.state.projects.length;
  const option = (field: "statuses" | "servers" | "projects", value: string, label: string) => (
    <button key={value} type="button" className="listbox-option" role="option" aria-selected={data.state[field].includes(value)} onClick={() => setState(toggleFleet(state, field, value))}>
      <span className="truncate" title={label}>
        {label}
      </span>
      <Check selected={data.state[field].includes(value)} />
    </button>
  );
  return (
    <div className="flex w-full min-w-0 flex-col gap-6">
      <div className="min-w-0">
        <h1 className="min-w-0 text-[24px]! leading-7! font-semibold! tracking-tight!">Security</h1>
        <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">What each resource of your team needs, from its last image scan.</p>
      </div>
      {data.serversNotScanning > 0 && !dismissed ? (
        <Callout type="info" title={serversNotScanningTitle(data.serversNotScanning)}>
          <a href="/servers" className="font-medium text-coollabs hover:underline dark:text-brand-light">
            Go to servers
          </a>{" "}
          <button
            type="button"
            className="ml-2 text-[12px] text-neutral-500 hover:underline"
            onClick={() => {
              try {
                localStorage.setItem(dismissKey, "1");
              } catch {
                /* storage blocked */
              }
              setDismissed(true);
            }}
          >
            Dismiss
          </button>
        </Callout>
      ) : null}
      <div className="min-w-0 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-white/[0.08] dark:bg-white/[0.05]">
        <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 p-3 dark:border-white/[0.08]">
          <TableSearch placeholder="Search by CVE, GHSA, or package" value={state.search} onChange={(search) => setState({ ...state, search, page: 1 })} />
          <TableFilter activeCount={count} onReset={() => setState(resetFleetFilters(state))}>
            <span className={GROUP_LABEL}>Status</span>
            {Object.entries(data.statusOptions).map(([value, label]) => option("statuses", value, label))}
            {Object.keys(data.serverOptions).length > 0 ? <span className={GROUP_LABEL}>Server</span> : null}
            {Object.entries(data.serverOptions).map(([value, label]) => option("servers", value, label))}
            {Object.keys(data.projectOptions).length > 0 ? <span className={GROUP_LABEL}>Project</span> : null}
            {Object.entries(data.projectOptions).map(([value, label]) => option("projects", value, label))}
          </TableFilter>
          <ExportMenu count={data.shownCount} noun="resource" withIds={false} exportPath={exportPath} />
        </div>
        <div className="relative">
          {data.items.items.length === 0 ? (
            data.searching ? (
              <Empty size="sm" title="No scanned image has this vulnerability or package." description="Check the ID, or search for the package name." />
            ) : data.hasFilters ? (
              <Empty size="sm" title="No matching resources" description="Try other filters, or reset them." />
            ) : !data.hasResources ? (
              <Empty size="sm" title="No resources yet" description="The resources of your team show here." />
            ) : data.hidesNotChecked ? (
              <Empty size="sm" title="No resource was scanned yet" description="Resources that were not scanned are hidden. Freeploy scans an image when it deploys or starts it on a server that scans images." />
            ) : null
          ) : (
            <div className="data-table">
              <div className="data-table-header image-scan-fleet-grid">
                <span>Resource</span>
                <span>{data.searching ? "Match" : "Status"}</span>
                <span className="image-scan-fleet-action">{data.searching ? "State" : "Action"}</span>
                <span className="image-scan-secondary">Server</span>
                <span className="image-scan-secondary image-scan-fleet-tertiary">Checked</span>
              </div>
              {data.items.items.map((entry) => (
                <div key={entry.key} className="data-table-row image-scan-fleet-grid border-b border-neutral-200 last:border-b-0 dark:border-white/[0.08]">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {entry.link ? (
                          <a href={entry.link} className="block min-w-0 truncate text-[12px] font-medium text-neutral-950 hover:underline dark:text-fg" title={entry.name}>
                            {entry.name}
                          </a>
                        ) : (
                          <span className="block min-w-0 truncate text-[12px] font-medium text-neutral-950 dark:text-fg">{entry.name}</span>
                        )}
                        {data.searching && entry.badgeType !== null ? <StatusBadge type={badgeTypeOf(entry.badgeType)} label={entry.statusLabel} /> : null}
                      </div>
                      <span className={`block truncate ${MUTED}`} title={`${entry.project ?? ""} / ${entry.environment ?? ""}`}>
                        {entry.project} / {entry.environment}
                      </span>
                    </div>
                  </div>
                  {data.searching && entry.match ? (
                    <>
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <SeverityBadge severity={entry.match.severity} />
                        <span className="min-w-0 truncate font-mono text-[11px] text-neutral-700 dark:text-fg" title={`${entry.match.id} ${entry.match.package} ${entry.match.version}`}>
                          {entry.match.id} · {entry.match.package} {entry.match.version}
                        </span>
                        {entry.match.more > 0 ? <span className={MUTED}>+{numberFormat(entry.match.more)} more</span> : null}
                      </div>
                      <span className="image-scan-fleet-action text-[12px] text-neutral-700 dark:text-fg">
                        {data.stateLabels[entry.match.state]}
                        {entry.match.state === "fixed" && entry.match.fixedIn ? <span className={MUTED}> → {entry.match.fixedIn}</span> : null}
                      </span>
                    </>
                  ) : (
                    <>
                      <div className="flex min-w-0 flex-col items-start justify-center gap-0.5">
                        {entry.badgeType !== null ? <StatusBadge type={badgeTypeOf(entry.badgeType)} label={entry.statusLabel} /> : <span className={MUTED}>{entry.statusLabel}</span>}
                        {entry.imagesLine !== null ? <span className={`${MUTED} tabular-nums`}>{entry.imagesLine}</span> : null}
                      </div>
                      <div className="image-scan-fleet-action min-w-0">
                        {entry.action !== null ? (
                          entry.action.link && entry.link ? (
                            <a
                              href={`${entry.link}#security-section`}
                              className={`line-clamp-2 underline decoration-neutral-400/40 underline-offset-4 transition-colors hover:text-neutral-950 hover:decoration-current dark:decoration-white/25 dark:hover:text-fg dark:hover:decoration-current ${entry.action.muted ? "text-[12px] text-neutral-500 dark:text-fg-faint" : "text-[12px] text-neutral-800 dark:text-fg"}`}
                              title={entry.action.text}
                            >
                              {entry.action.text}
                            </a>
                          ) : (
                            <span className={`line-clamp-2 ${entry.action.muted ? "text-[12px] text-neutral-500 dark:text-fg-faint" : "text-[12px] text-neutral-800 dark:text-fg"}`}>{entry.action.text}</span>
                          )
                        ) : null}
                      </div>
                    </>
                  )}
                  <span className="image-scan-secondary truncate text-[11px] text-neutral-600 dark:text-fg-dim" title={entry.server ?? undefined}>
                    {entry.server}
                  </span>
                  <span className={`image-scan-secondary image-scan-fleet-tertiary ${MUTED}`} title={entry.checkedAt?.title}>
                    {entry.checkedAt?.ago}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <Pagination paged={data.items} onPage={(page) => setState({ ...state, page })} onPerPage={(perPage) => setState({ ...state, perPage, page: 1 })} />
        {data.searchCapped ? (
          <div className="border-t border-neutral-200 px-4 py-2.5 text-[12px] text-neutral-500 dark:border-white/[0.08] dark:text-fg-faint">
            Only the first {data.maxDecodedScans} images with a match were searched. Filter by server or project to see the rest.
          </div>
        ) : null}
        {data.notScannedLine ? (
          <div className="border-t border-neutral-200 px-4 py-2.5 text-[12px] text-neutral-500 dark:border-white/[0.08] dark:text-fg-faint">
            {data.notScannedLine}{" "}
            {data.notCheckedToggle !== null ? (
              <button
                type="button"
                onClick={() => setState({ ...state, showNotChecked: !state.showNotChecked, page: 1 })}
                className="font-medium text-neutral-700 underline decoration-neutral-400/40 underline-offset-4 transition-colors hover:text-neutral-950 hover:decoration-current dark:text-fg-dim dark:decoration-white/25 dark:hover:text-fg"
              >
                {data.notCheckedToggle}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** routes/web.php's vulnerabilities: <x-slot:title>Security | Coolify</x-slot>. */
export function FleetVulnerabilitiesPage() {
  return (
    <Layout title="Security" href="/vulnerabilities" navHref="/vulnerabilities" documentTitle="Security">
      <FleetContent />
    </Layout>
  );
}

// ---------------------------------------------------------------- DP-116: the scan rules of a level

interface LevelSettings {
  scopeType: "instance" | "team" | "server";
  canEdit: boolean;
  showsIgnores: boolean;
  showsTeamSettingsLink: boolean;
  ignores: ScanSettings["ignores"];
  rules: {
    gateMode: string;
    onScanError: string;
    countMedium: string;
    scanNewServers?: string;
    canEditScanNewServers?: boolean;
    appScanOn: boolean;
    inheritLabels: Record<string, string> | null;
    gateModeOptions: Array<{ value: string; label: string; description?: string }>;
    onScanErrorOptions: Array<{ value: string; label: string }>;
    countMediumOptions: Array<{ value: string; label: string }>;
  };
}

const ON_OFF = [
  { value: "0", label: "Off" },
  { value: "1", label: "On" },
];

/** A page's action: PATCH { action, … }, its toasts, a refusal (or what needs the SSH executor) as an error toast; then reload. */
function usePageRun(api: string, reload: () => Promise<void>): Run {
  return useCallback(
    async (body) => {
      const r = await postJson<{ toasts: Array<{ type: string; message: string }> }>(api, body, "PATCH");
      if (!r.ok) {
        notify.error(r.error.messages[0] ?? "Something went wrong.");
        await reload();
        return false;
      }
      for (const t of r.data.toasts) (t.type === "success" ? notify.success : notify.error)(t.message);
      await reload();
      return true;
    },
    [api, reload],
  );
}

/** partials/scan-rules.blade.php of the instance, a team or a server. */
function LevelRules({ s, run }: { s: LevelSettings; run: Run }) {
  const r = s.rules;
  const labels = r.inheritLabels;
  return (
    <div className="flex flex-col gap-4">
      {s.scopeType === "team" ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <Listbox
            id="scanNewServers"
            label="Scan images on new servers"
            disabled={!s.canEdit || r.canEditScanNewServers !== true}
            helper="Pre-selects image scanning when someone adds a server to this team. They can change it."
            options={ON_OFF}
            value={r.scanNewServers ?? "0"}
            onChange={(value) => void run({ action: "scanNewServers", value })}
          />
        </div>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <div className="min-w-0">
          <Listbox id="gateMode" label="Block deploys" disabled={!s.canEdit || !r.appScanOn} helper={gateHelper(s.scopeType)} options={inheritedOptions(labels?.gate_mode, r.gateModeOptions)} value={r.gateMode} onChange={(value) => void run({ action: "saveRule", column: "gate_mode", value })} />
        </div>
        <Listbox id="onScanError" label="If the scan cannot run" disabled={!s.canEdit} helper="Applies when Block deploys is On or Strict." options={inheritedOptions(labels?.on_scan_error, r.onScanErrorOptions)} value={r.onScanError} onChange={(value) => void run({ action: "saveRule", column: "on_scan_error", value })} />
        <Listbox
          id="countMedium"
          label="Count medium problems"
          disabled={!s.canEdit}
          helper="Medium problems that an update fixes give a security update. Problems that attackers are likely to use always count."
          options={inheritedOptions(labels?.count_medium, r.countMediumOptions)}
          value={r.countMedium}
          onChange={(value) => void run({ action: "saveRule", column: "count_medium", value })}
        />
      </div>
      <p className="text-[12px] text-neutral-500 dark:text-fg-faint">Block deploys applies only to apps.</p>
    </div>
  );
}

/** scan-settings.blade.php of a level: Rules (embedded in a server's card), and the team's Ignored findings. */
function LevelSettingsView({ s, run, embedded = false }: { s: LevelSettings; run: Run; embedded?: boolean }) {
  if (embedded) {
    return (
      <SettingsSubsection id="image-scan-rules-section" title="Rules" helper={rulesHelper(s.scopeType)} first>
        <LevelRules s={s} run={run} />
      </SettingsSubsection>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <SettingsSection id="image-scan-rules-section" title="Rules" helper={rulesHelper(s.scopeType)}>
        <LevelRules s={s} run={run} />
      </SettingsSection>
      {s.showsIgnores ? (
        <SettingsSection id="image-scan-ignores-section" title="Ignored findings" helper={IGNORES_HELPER} flush>
          <ScanIgnores s={s} run={run} />
        </SettingsSection>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- /settings/image-scanning

const INSTANCE_IMAGE_SCANNING_API = "/v1/platform/settings/image-scanning";

/** InstanceImageScanning: the defaults of every team; a customer gets the platform's 404. */
function InstanceImageScanningContent() {
  const [data, setData] = useState<LevelSettings | null>(null);
  const [missing, setMissing] = useState(false);
  const load = useCallback(async () => {
    const r = await getJson<{ settings: LevelSettings }>(INSTANCE_IMAGE_SCANNING_API);
    if (!r.data) {
      if (r.status === 404) setMissing(true);
      return;
    }
    setData(r.data.settings);
  }, []);
  useEffect(() => {
    void load();
    document.title = "Image Scanning | Freeploy";
  }, [load]);
  const run = usePageRun(INSTANCE_IMAGE_SCANNING_API, load);
  if (missing) return <PlatformNotFound />;
  if (!data) return null;
  return (
    <SettingsLayout>
      <div className="application-settings-form flex min-w-0 flex-col gap-6">
        <LevelSettingsView s={data} run={run} />
      </div>
    </SettingsLayout>
  );
}

export function InstanceImageScanningPage() {
  return (
    <Layout title="Image Scanning" href="/settings/image-scanning" documentTitle="Image Scanning">
      <InstanceImageScanningContent />
    </Layout>
  );
}

// ---------------------------------------------------------------- /team/image-scanning

/** TeamImageScanning: the team's defaults, Scan images on new servers and the team-wide ignores. */
function TeamImageScanningContent() {
  const { me } = useSignedIn();
  const api = `/v1/organizations/${me.team?.id ?? ""}/deploy/team/image-scanning`;
  const [data, setData] = useState<LevelSettings | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await getJson<{ settings: LevelSettings }>(api);
    if (!r.data) {
      if (r.status !== 401) notify.error("Failed to load the team.");
      return;
    }
    setData(r.data.settings);
  }, [api]);
  useEffect(() => {
    void load();
    document.title = "Team Image Scanning | Freeploy";
    void getJson<{ role: string }>(`${teamApi(me.team?.id)}/members`).then((m) => setRole(m.data?.role ?? null));
  }, [load, me.team?.id]);
  const run = usePageRun(api, load);
  if (!data) return null;
  return (
    <TeamLayout role={role}>
      <div className="application-settings-form flex flex-col gap-6">
        <LevelSettingsView s={data} run={run} />
      </div>
    </TeamLayout>
  );
}

export function TeamImageScanningPage() {
  return (
    <Layout title="Team" href="/team/image-scanning" documentTitle="Team Image Scanning">
      <TeamImageScanningContent />
    </Layout>
  );
}

// ---------------------------------------------------------------- /server/{uuid}/security/vulnerabilities

interface ServerScanning {
  enabled: boolean;
  limits: Record<"scannerMemoryMb" | "scannerSyftTimeout" | "scannerGrypeTimeout" | "scannerCpus", string>;
  memoryLimit: string;
  memoryOptions: Array<{ value: string; label: string }>;
  timeoutOptions: Array<{ value: string; label: string }>;
  cpuOptions: Array<{ value: string; label: string }>;
  prepareState: string | null;
  failedStep: string | null;
  registries: string;
  diskUsed: string | null;
  hasScannerData: boolean;
  toolVersions: string;
  builtAt: string | null;
  cpuLimit: string;
}
interface HostFinding {
  key: string;
  displayId: string;
  title: string;
  summary: string;
  package: string;
  version: string;
  fixedIn: string | null;
  severity: string;
  signal: string | null;
  kernelStatus: string | null;
  isOtherKernel: boolean;
  isOldKernel: boolean;
  updates: Array<{ package: string; newVersion: string }>;
  isOwnUpdate: boolean;
  riskLabels: string[];
  cvssScore: string | null;
  kev: boolean;
  likelihood: string | null;
  aliases: string[];
  advisoryUrl: string | null;
}
interface HostData {
  hostScan: null | {
    summary: Record<string, number | string> | null;
    findingsTruncated: boolean;
    scannedAt: { ago: string; title: string } | null;
    error: string | null;
    errorDetail: string | null;
    eol: { name: string; version: string } | null;
  };
  hostScanRunning: boolean;
  hostScanAvailable: boolean;
  hasResult: boolean;
  rebootRequired: boolean;
  packageManager: string | null;
  kernelStatusCounts: Record<string, number>;
  otherKernelCount: number;
  hasOldKernels: boolean;
  runningKernel: string | null;
  bootKernel: string | null;
  hostFindingsCount: number;
  shownCount: number;
  items: Paged<HostFinding>;
}
interface ServerScanningData {
  server: ServerInfo;
  canUpdate: boolean;
  scanning: ServerScanning;
  settings: LevelSettings;
  host: HostData;
}

/** <x-checkpoint-item> with its status. */
function Checkpoint({ title, icon, status, description }: { title: string; icon: string; status: string; description: string }) {
  const tone = status === "success" ? "text-success" : status === "error" ? "text-error" : status === "running" ? "text-warning" : "text-neutral-500 dark:text-fg-dim";
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-3">
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 dark:border-white/[0.08] dark:bg-white/[0.035] ${tone}`}>
        <Reicon name={icon} className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold">{title}</span>
        <span className="mt-0.5 block text-[11px] text-neutral-500 dark:text-fg-faint">{description}</span>
      </span>
    </div>
  );
}

/** server-image-scanning.blade.php: the Image scanning card — the switch, the scanner, its limits and the server's rules. */
function ServerImageScanningCard({ data, run }: { data: ServerScanningData; run: Run }) {
  const { server, canUpdate, scanning: sc, settings } = data;
  const costText = scanCostText(sc.cpuLimit, sc.memoryLimit);
  const checkpoints = scannerCheckpoints(sc.prepareState, sc.failedStep, sc.registries, sc.builtAt);
  const cannotUpdate = !canUpdate;
  const limit = (property: keyof ServerScanning["limits"], label: string, helper: string, options: Array<{ value: string; label: string }>) => (
    <Listbox
      id={property}
      label={label}
      disabled={cannotUpdate}
      helper={helper}
      options={options}
      // A decimal column reads "1.00": the option of the same number is the current one.
      value={options.find((o) => Number(o.value) === Number(sc.limits[property]))?.value ?? sc.limits[property]}
      onChange={(value) => void run({ action: "limit", property, value })}
    />
  );
  const actions = canUpdate ? (
    <>
      {sc.enabled && (sc.prepareState === null || sc.prepareState === "failed") ? <Button onClick={() => void run({ action: "prepareScanner" })}>{sc.prepareState === "failed" ? "Try again" : "Get scanner"}</Button> : null}
      {!sc.enabled || sc.hasScannerData ? (
        <ModalConfirmation
          title="Delete scanner data?"
          buttonTitle="Delete scanner data"
          actions={["Freeploy removes the stored SBOMs, the vulnerability database, and the scanner images from this server.", "Scan results in Freeploy stay. The next scan gets the scanner again."]}
          confirmationText={null}
          step2ButtonText="Delete scanner data"
          onSubmit={async () => {
            await run({ action: "deleteScannerData" });
          }}
        />
      ) : null}
      <ModalConfirmation
        key={sc.enabled ? "on" : "off"}
        title={sc.enabled ? "Disable image scanning?" : "Enable image scanning?"}
        trigger={<Button highlighted={!sc.enabled}>{sc.enabled ? "Disable" : "Enable"}</Button>}
        warningMessage={sc.enabled ? "New deployments and running images on this server are no longer checked for vulnerabilities. You can enable it again at any time." : "Scans run on this server and use its resources. You can disable it again at any time."}
        actions={sc.enabled ? ["Freeploy stops scanning the images and the operating system packages of this server.", "Scan results and scanner data on the server stay."] : [costText]}
        confirmationText={null}
        step2ButtonText={sc.enabled ? "Disable image scanning" : "Enable image scanning"}
        onSubmit={async () => {
          await run({ action: sc.enabled ? "disable" : "enable" });
        }}
      />
    </>
  ) : null;
  return (
    <SettingsSection id="server-image-scanning-section" title="Image scanning" helper={scanningSectionHelper(sc.toolVersions, sc.builtAt, sc.diskUsed, costText)} actions={actions}>
      {!sc.enabled ? (
        <Empty size="sm" iconName="shield-alert" title={`Image scanning is off for ${server.name}.`} description={costText}>
          {!canUpdate ? <span className="text-[13px] text-neutral-500 dark:text-fg-faint">Ask a team admin to turn it on.</span> : null}
        </Empty>
      ) : sc.prepareState !== "ready" ? (
        <div className="divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-white/[0.08] dark:border-white/[0.08]">
          <Checkpoint title="Get scanner" icon="download" status={checkpoints.pull.status} description={checkpoints.pull.description} />
          <Checkpoint title="Update database" icon="database" status={checkpoints.database.status} description={checkpoints.database.description} />
        </div>
      ) : null}
      <div className={!sc.enabled || sc.prepareState !== "ready" ? "mt-5 border-t border-neutral-200 pt-5 dark:border-white/[0.07]" : undefined}>
        <SettingsSubsection
          id="image-scan-limits-section"
          title="Scanner limits"
          helper="Limits of each scanner step on this server. Raise one when a scan stops because it took too long or ran out of memory. A new limit applies to the next scan."
          first
        >
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {limit("scannerSyftTimeout", "Syft time limit", "Time to export one local image from Docker, and time to list its packages. Large images and slow disks need more time.", sc.timeoutOptions)}
            {limit("scannerGrypeTimeout", "Grype time limit", "Time to check the vulnerability database, and time to match the packages of one image with it. Slow disks need more time.", sc.timeoutOptions)}
            {limit("scannerCpus", "Scanner CPU limit", "CPUs that each scanner step can use. Values above the CPU count of this server are not listed.", sc.cpuOptions)}
            {limit("scannerMemoryMb", "Scanner memory limit", "Memory that each scanner step can use. Values above the memory of this server are not listed. The server must also have this much free memory when a scan runs.", sc.memoryOptions)}
          </div>
        </SettingsSubsection>
        <div className="mt-5 border-t border-neutral-200 pt-5 dark:border-white/[0.07]">
          <LevelSettingsView s={settings} run={run} embedded />
        </div>
      </div>
    </SettingsSection>
  );
}

/** host-vulnerabilities.blade.php: one finding, its row and its details. */
function HostFindingRow({ f, runningKernel, canUpdate, run }: { f: HostFinding; runningKernel: string | null; canUpdate: boolean; run: Run }) {
  const [open, setOpen] = useState(false);
  const update = () => run({ action: "updateVulnerablePackage", package: f.package });
  return (
    <div className="border-b border-neutral-200 last:border-b-0 dark:border-white/[0.08]">
      <div onClick={() => setOpen(!open)} className="data-table-row host-vulnerabilities-table-grid w-full cursor-pointer text-left hover:bg-neutral-50 dark:hover:bg-white/[0.03]">
        <div className="flex min-w-0 items-start gap-1.5">
          <Reicon name="chevron-down" className={`mt-0.5 size-3.5 shrink-0 text-neutral-500 transition-transform duration-150 dark:text-fg-faint ${open ? "rotate-0" : "-rotate-90"}`} />
          <div className="min-w-0">
            <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <button type="button" onClick={(e) => (e.stopPropagation(), setOpen(!open))} aria-expanded={open ? "true" : "false"} aria-label={`Show details of ${f.displayId}`} className="shrink-0 cursor-pointer font-mono text-[12px] text-neutral-950 dark:text-fg">
                {f.displayId}
              </button>
              {f.signal === "exploited" ? <StatusBadge label="Exploited" type="error" /> : f.signal === "likely" ? <StatusBadge label="Likely exploited" type="warning" /> : null}
            </p>
            {f.title !== "" ? <p className="mt-0.5 truncate text-[11px] text-neutral-500 dark:text-fg-faint">{f.title}</p> : null}
          </div>
        </div>
        <div className="min-w-0">
          <p className="truncate font-mono text-[12px] text-neutral-700 dark:text-fg-dim">{f.package}</p>
          <p className="mt-0.5 truncate text-[10px] text-neutral-500 dark:text-fg-faint">Installed: {f.version}</p>
        </div>
        <div className="flex min-w-0 flex-col items-start gap-1">
          <span className="truncate font-mono text-[12px] text-neutral-700 dark:text-fg-dim">{f.fixedIn ?? "No fix yet"}</span>
          {f.kernelStatus === "fixed_after_reboot" ? <StatusBadge label="Fix installed, reboot needed" type="warning" /> : f.isOldKernel ? <StatusBadge label="Kernel not running" type="neutral" /> : f.kernelStatus === "runs_after_reboot" ? <StatusBadge label="Runs after the reboot" type="neutral" /> : null}
          {f.updates.length > 0 ? <StatusBadge label={f.isOwnUpdate ? `Update available: ${f.updates[0]!.newVersion}` : "Kernel update available"} type="success" /> : null}
          {f.riskLabels.map((risk) => (
            <span key={risk} className="flex items-center gap-1 text-[10px] text-neutral-500 dark:text-fg-faint">
              <Reicon name="alert-triangle" className="size-3 shrink-0 text-red-500" />
              {risk}
            </span>
          ))}
        </div>
        <div className="flex justify-end">
          <SeverityBadge severity={f.severity} />
        </div>
        <div className="flex justify-end" onClick={(e) => e.stopPropagation()}>
          {f.updates.length > 0 && canUpdate ? (
            f.riskLabels.length > 0 ? (
              <ModalConfirmation
                title={`Update ${f.isOwnUpdate ? f.package : "the kernel"}?`}
                buttonTitle="Update"
                actions={[`Freeploy updates ${f.updates.map((u) => u.package).join(", ")}.`, ...f.riskLabels]}
                warningMessage="Freeploy cannot roll back a package update. Check the update logs when it is done."
                confirmationText={null}
                step2ButtonText="Update"
                onSubmit={async () => {
                  await update();
                }}
              />
            ) : (
              <Button onClick={() => void update()}>Update</Button>
            )
          ) : null}
        </div>
      </div>
      {open ? (
        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-4 pb-4 sm:grid-cols-[8rem_minmax(0,1fr)] sm:pl-9 text-[12px] text-neutral-700 dark:text-fg-dim">
          {f.summary !== "" ? <dd className="col-span-2 mb-1 max-w-3xl leading-5">{f.summary}</dd> : null}
          <dt className="text-neutral-500 dark:text-fg-faint">Package</dt>
          <dd className="min-w-0 break-all font-mono">{f.package}</dd>
          <dt className="text-neutral-500 dark:text-fg-faint">Installed</dt>
          <dd className="min-w-0 break-all font-mono">{f.version}</dd>
          <dt className="text-neutral-500 dark:text-fg-faint">Fixed in</dt>
          <dd className="min-w-0 break-all font-mono">{f.fixedIn ?? "No fix yet"}</dd>
          {f.updates.length > 0 ? (
            <>
              <dt className="text-neutral-500 dark:text-fg-faint">Update</dt>
              <dd className="min-w-0 break-words">
                {f.updates.map((u) => (
                  <span key={u.package} className="block break-all font-mono">
                    {u.package} {u.newVersion}
                  </span>
                ))}
                {f.riskLabels.length > 0 ? <span className="block">{f.riskLabels.join(". ")}.</span> : null}
              </dd>
            </>
          ) : null}
          {f.kernelStatus !== null || f.isOtherKernel ? (
            <>
              <dt className="text-neutral-500 dark:text-fg-faint">Kernel</dt>
              <dd className="min-w-0 break-words">
                {f.kernelStatus === "fixed_after_reboot" ? (
                  <>
                    The server runs kernel <span className="font-mono">{runningKernel}</span>. The kernel that starts after a reboot has the fix. Reboot the server to use it.
                  </>
                ) : f.isOldKernel ? (
                  <>
                    No risk now: the server does not run this kernel (it runs <span className="font-mono">{runningKernel}</span>).
                  </>
                ) : (
                  "This kernel is installed, but the server runs it only after a reboot."
                )}
              </dd>
            </>
          ) : null}
          {f.cvssScore !== null ? (
            <>
              <dt className="text-neutral-500 dark:text-fg-faint">CVSS score</dt>
              <dd>{f.cvssScore}</dd>
            </>
          ) : null}
          {f.kev ? (
            <>
              <dt className="text-neutral-500 dark:text-fg-faint">Exploited</dt>
              <dd>Attackers are using this, according to CISA.</dd>
            </>
          ) : f.likelihood !== null ? (
            <>
              <dt className="text-neutral-500 dark:text-fg-faint">Exploit likelihood</dt>
              <dd>{f.likelihood}</dd>
            </>
          ) : null}
          {f.aliases.length > 0 ? (
            <>
              <dt className="text-neutral-500 dark:text-fg-faint">Also known as</dt>
              <dd className="min-w-0 break-all font-mono">{f.aliases.join(", ")}</dd>
            </>
          ) : null}
          {f.advisoryUrl !== null ? (
            <>
              <dt className="text-neutral-500 dark:text-fg-faint">Advisory</dt>
              <dd>
                <a href={f.advisoryUrl} target="_blank" rel="noopener noreferrer" className="font-medium underline underline-offset-4">
                  Open {f.displayId}
                </a>
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

/** HostVulnerabilities: the vulnerabilities in the operating system packages of the server, from the stored host scan. */
function HostVulnerabilitiesSection({ data, state, setState, run, exportPath }: { data: ServerScanningData; state: HostState; setState: (s: HostState) => void; run: Run; exportPath: (format: string) => string }) {
  const { server, canUpdate, host: h } = data;
  const scan = h.hostScan;
  const summary = scan?.summary ?? null;
  const n = (k: string): number => Number(summary?.[k] ?? 0);
  const hasFindings = h.hostFindingsCount > 0;
  const fixedAfterReboot = h.kernelStatusCounts.fixed_after_reboot ?? 0;
  const badges = (
    <>
      {scan?.error && !h.hostScanRunning ? <StatusBadge label="Scan failed" type="error" /> : null}
      {summary ? (
        <>
          {(["critical", "high"] as const).map((severity) => (n(severity) > 0 ? <SeverityBadge key={severity} severity={severity} count={n(severity)} /> : null))}
          {n("exploited") > 0 ? <StatusBadge label={`${n("exploited")} exploited`} type="error" /> : null}
          {["critical", "high", "medium", "low", "unknown"].reduce((sum, k) => sum + n(k), 0) === 0 ? <StatusBadge label="No relevant problems" type="success" /> : null}
        </>
      ) : !h.hostScanAvailable ? (
        <StatusBadge label="Off" type="neutral" />
      ) : !h.hostScanRunning ? (
        <StatusBadge label="Not scanned yet" type="neutral" />
      ) : null}
    </>
  );
  const actions =
    hasFindings || h.hostScanAvailable ? (
      <>
        {hasFindings ? (
          <>
            <div className="w-56">
              <TableSearch placeholder="Search by ID or package" value={state.search} onChange={(search) => setState(setHost(state, { search }))} />
            </div>
            <ExportMenu count={h.shownCount} noun="finding" withIds exportPath={exportPath} />
          </>
        ) : null}
        {h.hostScanAvailable && canUpdate ? (
          <Button disabled={h.hostScanRunning} onClick={() => void run({ action: "scanHostPackages" })}>
            <Reicon name="refresh" className="size-3.5" />
            Scan now
          </Button>
        ) : null}
      </>
    ) : null;
  return (
    <SettingsSection
      id="server-host-vulnerabilities-section"
      title="Vulnerabilities"
      helper="Known vulnerabilities in the operating system packages of this server. Freeploy scans them with the image scanner every day and after a package update. Problems that the distribution does not fix are not shown."
      flush
      badges={badges}
      actions={actions}
    >
      {!h.hostScanAvailable && scan === null ? (
        <div className="p-4">
          <Empty size="sm" iconName="shield-alert" title={`Image scanning is off for ${server.name}.`} description="Enable image scanning below to also scan the operating system packages of this server.">
            <a className="text-[13px] font-medium underline" href="#server-image-scanning-section">
              Image scanning settings
            </a>
          </Empty>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-600 dark:text-fg-dim">
              <span>
                Last scan: {scan?.scannedAt ? <span title={scan.scannedAt.title}>{scan.scannedAt.ago}</span> : "never"}
              </span>
              {summary ? (
                <>
                  {n("medium") > 0 ? <SeverityBadge severity="medium" count={n("medium")} /> : null}
                  {n("fixable") > 0 ? <StatusBadge label={`${n("fixable")} fixed by an update`} type="warning" /> : null}
                </>
              ) : null}
            </div>
            {hasFindings && (scan?.findingsTruncated || !h.hasResult) ? (
              <p className="text-[12px] text-neutral-500 dark:text-fg-faint">
                {scan?.findingsTruncated ? "Only the most important vulnerabilities of a larger result are shown. " : null}
                {!h.hasResult ? 'Run "Check for updates" to see which packages have an update.' : null}
              </p>
            ) : null}
            {h.rebootRequired ? (
              <Callout type="warning" title="Reboot required">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span>
                    {fixedAfterReboot > 0 ? (
                      <>
                        The server runs kernel <span className="font-mono">{h.runningKernel}</span>, which has {fixedAfterReboot} listed {vulnerabilitiesWord(fixedAfterReboot)}. The fixed kernel <span className="font-mono">{h.bootKernel}</span> is installed and is the boot kernel. Reboot the server to start it.
                      </>
                    ) : h.runningKernel && h.bootKernel && h.bootKernel !== h.runningKernel ? (
                      <>
                        Kernel <span className="font-mono">{h.bootKernel}</span> is installed and starts after a reboot. The server now runs <span className="font-mono">{h.runningKernel}</span>. No listed vulnerability needs this reboot.
                      </>
                    ) : (
                      "Some installed updates apply only after a reboot."
                    )}
                  </span>
                  {canUpdate ? (
                    <ModalConfirmation
                      title="Reboot server?"
                      buttonTitle="Reboot server"
                      warningMessage="The containers on this server stop until the server is back."
                      actions={["The server reboots in a few seconds.", "All containers on this server stop, and the containers with a restart policy start again after the reboot.", "The server is not reachable for a few minutes."]}
                      confirmationText={server.name}
                      confirmationLabel="Enter the server name to confirm"
                      shortConfirmationLabel="Server name"
                      step2ButtonText="Reboot server"
                      onSubmit={async () => {
                        await run({ action: "rebootServer" });
                      }}
                    />
                  ) : null}
                </div>
              </Callout>
            ) : null}
            {h.otherKernelCount > 0 ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-neutral-500 dark:text-fg-faint">
                <span>{otherKernelsLine(h.otherKernelCount, state.showOtherKernels)}</span>
                <button type="button" onClick={() => setState(setHost(state, { showOtherKernels: !state.showOtherKernels }))} className="cursor-pointer font-medium underline underline-offset-4">
                  {state.showOtherKernels ? "Hide" : "Show"}
                </button>
                {h.hasOldKernels && canUpdate && removeUnusedSupported(h.packageManager) ? (
                  <ModalConfirmation
                    title="Remove unused packages?"
                    buttonTitle="Remove old kernels"
                    actions={["Removes packages that nothing needs anymore, and old kernels.", "The running kernel and the newest kernel stay installed."]}
                    warningMessage="Freeploy cannot restore removed packages. Check the logs when it is done."
                    confirmationText={null}
                    step2ButtonText="Remove"
                    onSubmit={async () => {
                      await run({ action: "removeUnusedPackages" });
                    }}
                  />
                ) : null}
              </div>
            ) : null}
            {scan?.error ? (
              <DangerCallout title="The last scan failed" className="">
                {scan.error}
                {canUpdate && scan.errorDetail ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{scan.errorDetail}</pre> : null}
              </DangerCallout>
            ) : null}
            {scan?.eol ? (
              <Callout type="warning" title="Operating system is end of life">
                {scan.eol.name} {scan.eol.version} gets no security updates anymore. Upgrade the operating system of this server.
              </Callout>
            ) : null}
            {scan?.scannedAt && !hasFindings ? <Empty size="sm" title="No relevant vulnerabilities" description="The installed packages have no critical, high, or exploited vulnerabilities." iconName="check-circle" /> : null}
          </div>
          {hasFindings && h.items.items.length === 0 ? (
            <div className="border-t border-neutral-200 p-6 dark:border-white/[0.08]">
              <Empty size="sm" title="No matching vulnerabilities" description="Try another ID or package, or clear the search." iconName="search" />
            </div>
          ) : hasFindings ? (
            <div className="data-table">
              <div className="data-table-header host-vulnerabilities-table-grid">
                <Sort label="Vulnerability" asc="vulnerability_asc" desc="vulnerability_desc" sortBy={state.sortBy} onSort={(sortBy) => setState(setHost(state, { sortBy }))} />
                <Sort label="Package" asc="package_asc" desc="package_desc" sortBy={state.sortBy} onSort={(sortBy) => setState(setHost(state, { sortBy }))} />
                <Sort label="Fixed in" asc="fixed_asc" desc="fixed_desc" sortBy={state.sortBy} onSort={(sortBy) => setState(setHost(state, { sortBy }))} />
                <div className="flex justify-end">
                  <Sort label="Severity" asc="severity_asc" desc="severity_desc" first="desc" sortBy={state.sortBy} onSort={(sortBy) => setState(setHost(state, { sortBy }))} />
                </div>
                <span className="text-right">Action</span>
              </div>
              {h.items.items.map((f) => (
                <HostFindingRow key={f.key} f={f} runningKernel={h.runningKernel} canUpdate={canUpdate} run={run} />
              ))}
              <Pagination paged={h.items} onPage={(page) => setState({ ...state, page })} onPerPage={(perPage) => setState(setHost(state, { perPage }))} />
            </div>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

function ServerImageScanningContent() {
  const { me } = useSignedIn();
  const uuid = serverUuidFromPath();
  const api = `/v1/organizations/${me.team?.id ?? ""}/deploy/servers/${encodeURIComponent(uuid)}/security/vulnerabilities`;
  const [state, setState] = useState<HostState>(INITIAL_HOST);
  const [data, setData] = useState<ServerScanningData | null>(null);
  const load = useCallback(async () => {
    const r = await getJson<ServerScanningData>(api + hostQuery(state));
    if (!r.data) {
      // mount(): a server of another team (or a page the caller may not open) is not found.
      if (r.status === 404) window.location.replace("/servers");
      return;
    }
    setData(r.data);
  }, [api, state]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (data) document.title = `${serverLimit(data.server.name, 10)} > Vulnerabilities | Freeploy`;
  }, [data]);
  const run = usePageRun(api, load);
  if (!data) return null;
  const exportPath = (format: string) => {
    const q = hostQuery(state);
    return `${api}/export${q}${q ? "&" : "?"}format=${format}`;
  };
  return (
    <ServerWorkspace server={data.server} orgId={me.team?.id} active="security" activeSub="vulnerabilities" canUpdate={data.canUpdate}>
      <div className="application-settings-form flex w-full min-w-0 flex-col gap-6">
        <ServerImageScanningCard data={data} run={run} />
        <HostVulnerabilitiesSection data={data} state={state} setState={setState} run={run} exportPath={exportPath} />
      </div>
    </ServerWorkspace>
  );
}

export function ServerImageScanningPage() {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle="Vulnerabilities">
      <ServerImageScanningContent />
    </Layout>
  );
}

