// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/application/backup/{index,create,show}.blade.php,
// resources/views/livewire/project/service/volume-backup/{index,show}.blade.php,
// resources/views/livewire/project/shared/storages/volume-backups.blade.php,
// resources/views/livewire/project/shared/storages/volume-backups/{general,s3,retention,executions,danger}.blade.php,
// resources/views/components/{backup-sidebar,backup-tabs,backup-s3-storage}.blade.php and routes/web.php
// (project.application.backup.*, project.service.volume-backups.*, project.service.database.backup*) (Apache-2.0), modified.
//
// The storage backups of an application and of a service (DP-99):
//
//   …/application/{uuid}/backups                                    project.application.backup.index
//   …/application/{uuid}/backups/{backup_uuid}[/executions|/danger]  project.application.backup.show|executions|danger
//   …/application/{uuid}/backups/{backup_uuid}/{s3|retention}       redirect to …/backups/{backup_uuid}
//   …/service/{uuid}/storage-backups                                project.service.volume-backups.index (?backup_uuid= opens a schedule)
//   …/service/{uuid}/storage-backups/{backup_uuid}[/…]              Show::mount(): redirect to …/storage-backups
//   …/service/{uuid}/{stack_service_uuid}/backups[/…]               DatabaseBackups::mount(): redirect
//
// Nothing runs a volume backup yet: "Back up now", a recovery and a download say the SSH executor is not available,
// and the executions stay empty until it is.
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify, toast } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Callout, DangerZone, Empty, FormInput, Listbox, ModalConfirmation, ModalInput, SettingsSection, StatusBadge, UnsavedBar } from "../components/Coolify";
import { SortHeader, TableDropdown, type ListState } from "../components/CoolifyList";
import { useResourceSection, resourceApi, type ApplicationSectionData, type ServiceSectionData } from "./ApplicationSection";
import { ResourceWorkspace } from "./ResourceWorkspace";
import { environmentPath, environmentUuidFromPath, projectUuidFromPath } from "./ProjectChrome";
import { serviceUuidFromPath } from "../lib/service-templates";
import { backupFilterOptions, filterBackups, scheduleStatus, type BackupListItem } from "../lib/volume-backups";

type Kind = "application" | "service";

type BackupItem = BackupListItem;

interface Target {
  key: string;
  type: string;
  name: string;
  existing: { uuid: string; frequency: string } | null;
}

type IndexData = (ApplicationSectionData | ServiceSectionData) & { backups: BackupItem[]; targets: Target[]; databaseBackups?: BackupItem[] };

interface Settings {
  frequency: string;
  enabled: boolean;
  saveToS3: boolean;
  disableLocalBackup: boolean;
  stopDuringBackup: boolean;
  s3StorageIds: string[];
  retentionAmountLocally: number;
  retentionDaysLocally: number;
  retentionMaxStorageLocally: number;
  retentionAmountS3: number;
  retentionDaysS3: number;
  retentionMaxStorageS3: number;
  timeout: number;
  missingBackupNotificationDays: number;
}

interface Execution {
  id: string;
  status: string;
  message: string | null;
  size: number;
  filename: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  localStorageDeleted: boolean;
  s3StorageDeleted: boolean;
  s3Uploaded: boolean | null;
  recoveryPending: boolean;
  recoveryError: string | null;
  recoveryNeedsAttention: boolean;
  isDownloadable: boolean;
}

type ScheduleData = (ApplicationSectionData | ServiceSectionData) & {
  backup: Settings & { uuid: string; targetType: string; targetName: string };
  availableS3Storages: Array<{ uuid: string; name: string; isUsable: boolean }>;
  timezone: string;
  executions: { total: number; page: number; perPage: number; rows: Execution[] };
  deleteScheduleCheckboxes: Array<{ id: string; label: string }>;
};

const page = (content: ReactNode) => (
  <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Backups">
    {content}
  </Layout>
);

/** The resource's page path: …/application/{uuid} or …/service/{uuid}. */
function resourcePath(kind: Kind): string {
  const parts = window.location.pathname.split("/");
  return parts.slice(0, 7).join("/") || `${environmentPath(projectUuidFromPath(), environmentUuidFromPath())}/${kind}/${kind === "service" ? serviceUuidFromPath() : ""}`;
}
const indexPath = (kind: Kind) => `${resourcePath(kind)}/${kind === "application" ? "backups" : "storage-backups"}`;

/** "3 minutes ago", as Carbon's diffForHumans() words it. */
function ago(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  const abs = Math.abs(s);
  const [n, unit] = abs < 60 ? [abs, "second"] : abs < 3600 ? [Math.floor(abs / 60), "minute"] : abs < 86400 ? [Math.floor(abs / 3600), "hour"] : [Math.floor(abs / 86400), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"} ${s < 0 ? "from now" : "ago"}`;
}

/** formatBytes() */
function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Math.round(v * 100) / 100} ${units[i]}`;
}


/** <x-backup-s3-storage> */
function BackupS3Storage({ backup, withBucket }: { backup: BackupItem; withBucket: boolean }) {
  const tooltip = !backup.saveS3 ? "S3 storage: Not configured" : backup.storages.length ? `S3 storage: ${backup.storages.map((s) => (withBucket ? s.label : s.name)).join(", ")}` : "S3 storage: Unavailable";
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5" data-tooltip={tooltip} aria-label={tooltip} tabIndex={0}>
      {!backup.saveS3 ? (
        <span className="text-neutral-400 dark:text-fg-faint">Local only</span>
      ) : backup.storages.length === 0 ? (
        <>
          <Reicon name="alert-triangle" className="size-3.5 shrink-0 text-red-500" />
          <span className="text-red-600 dark:text-red-400">Unavailable</span>
        </>
      ) : (
        <>
          <span className="truncate">{backup.storages[0]!.name}</span>
          {backup.storages.length > 1 ? <span className="shrink-0 text-neutral-400 dark:text-fg-faint">+{backup.storages.length - 1}</span> : null}
        </>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- Create

/** livewire/project/application/backup/create (also the service's Create). */
function CreateBackup({ kind, base, targets, onSaved }: { kind: Kind; base: string; targets: Target[]; onSaved: (uuid: string) => void }) {
  const [targetKey, setTargetKey] = useState(targets[0]?.key ?? "");
  const target = targets.find((t) => t.key === targetKey) ?? null;
  const [frequency, setFrequency] = useState(target?.existing?.frequency ?? "daily");
  const [errors, setErrors] = useState<Record<string, string>>({});
  // updatedTargetKey(): loadSelectedBackup() takes the target's schedule's frequency.
  useEffect(() => {
    if (target?.existing) setFrequency(target.existing.frequency);
  }, [target]);
  if (targets.length === 0) return <Empty size="sm" title="No backup targets" description="Add a persistent volume or directory mount before configuring a backup." iconName="storages" />;
  const existingUrl = target?.existing ? (kind === "application" ? `${indexPath(kind)}/${target.existing.uuid}` : `${indexPath(kind)}?backup_uuid=${encodeURIComponent(target.existing.uuid)}`) : null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await postJson<{ message: string; backupUuid: string }>(base, { targetKey, frequency });
    if (!r.ok) {
      const inline: Record<string, string> = {};
      for (const [f, m] of Object.entries(r.error.fields ?? {})) if (m[0]) inline[f] = m[0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    notify.success(r.data.message);
    onSaved(r.data.backupUuid);
  }
  return (
    <form className="application-settings-form flex w-full flex-col gap-4" onSubmit={(e) => void submit(e)}>
      {existingUrl ? (
        <Callout type="info" title="This target already has a backup schedule">
          Each volume or directory has one schedule. Saving here updates it. To upload each backup to more S3 storages, select them in the S3 storages setting of the{" "}
          <a className="underline" href={existingUrl}>
            existing schedule
          </a>
          .
        </Callout>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Listbox id="targetKey" label="Backup target" required options={targets.map((t) => ({ value: t.key, label: `${t.type}: ${t.name}` }))} value={targetKey} onChange={setTargetKey} error={errors.targetKey} />
        <FormInput id="frequency" label="Frequency" required placeholder="daily or 0 0 * * *" helper="Use every_minute, hourly, daily, weekly, monthly, yearly, or a cron expression." value={frequency} onChange={setFrequency} error={errors.frequency} />
      </div>
      <div className="mt-2 flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
        <button type="submit" className="button button-highlighted">
          {existingUrl ? "Update schedule" : "Create schedule"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- the list


/** The index's Alpine list: search, a type filter, sorting by a column. */
function BackupTable({ kind, backups, databaseBackups, onOpen, actions }: { kind: Kind; backups: BackupItem[]; databaseBackups: BackupItem[]; onOpen: (b: BackupItem) => void; actions?: (b: BackupItem) => ReactNode }) {
  const [search, setSearch] = useState(() => new URLSearchParams(window.location.search).get("search") ?? "");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sortBy, setSortBy] = useState("target_asc");
  const list = { sortBy, setSortBy } as unknown as ListState<unknown>;
  const all = [...databaseBackups, ...backups];
  const filterOptions = backupFilterOptions(backups, kind === "service");
  const shown = useMemo(() => filterBackups(all, search, typeFilter, sortBy), [all, search, typeFilter, sortBy]);
  const grid = kind === "service" ? "backup-table-grid service-backup-table-grid" : "backup-table-grid";
  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search backups" aria-label="Search backups" className="input h-8! w-full py-0! pr-8! pl-8!" />
        </div>
        <div className="flex items-center gap-2">
          <TableDropdown
            panelClass="w-48!"
            trigger={(open) => (
              <button type="button" className="button" aria-haspopup="listbox" aria-expanded={open}>
                <svg className="size-3.5 opacity-65" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M4 6h16M7 12h10M10 18h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
                </svg>
                Filter
              </button>
            )}
          >
            {(close) =>
              filterOptions.map((o) => (
                <button key={o.value} type="button" className="listbox-option" onClick={() => (setTypeFilter(o.value), close())}>
                  <span className="flex-1">{o.label}</span>
                  {typeFilter === o.value ? <Reicon name="check" className="size-3.5" /> : null}
                </button>
              ))
            }
          </TableDropdown>
        </div>
      </div>
      <SettingsSection
        title="Schedules"
        helper={kind === "service" ? "Database, persistent volume, and directory backup schedules for this service." : "Persistent volume and directory backup schedules for this application."}
        flush={all.length > 0}
      >
        {all.length > 0 && shown.length === 0 ? <Empty size="sm" title="No backups found" description="No scheduled backups match your search." /> : null}
        {all.length > 0 ? (
          shown.length > 0 ? (
            <div className="data-table flex w-full flex-col overflow-x-auto">
              <div className={`data-table-header ${grid}`}>
                <SortHeader list={list} label="Target" asc="target_asc" desc="target_desc" />
                <SortHeader list={list} label="Type" asc="type_asc" desc="type_desc" />
                <SortHeader list={list} label="Schedule" asc="schedule_asc" desc="schedule_desc" />
                <SortHeader list={list} label="Status" asc="status_asc" desc="status_desc" />
                <SortHeader list={list} label="S3" asc="s3_asc" desc="s3_desc" />
                <SortHeader list={list} label="Last run" asc="lastrun_asc" desc="lastrun_desc" first="desc" />
                {kind === "service" ? <span className="text-right">Actions</span> : <SortHeader list={list} label="Executions" asc="executions_asc" desc="executions_desc" first="desc" className="justify-self-end" />}
              </div>
              {shown.map((b) => {
                const [label, type] = scheduleStatus(b);
                return (
                  <div
                    key={`${b.targetType}-${b.uuid}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => onOpen(b)}
                    onKeyDown={(e) => e.key === "Enter" && onOpen(b)}
                    className={`data-table-row ${grid} cursor-pointer text-left text-[13px] text-neutral-700 dark:text-fg-dim`}
                  >
                    <span className="min-w-0 truncate font-medium text-neutral-950 dark:text-fg" title={b.targetName}>
                      {b.targetName}
                    </span>
                    <span className="min-w-0">
                      <button
                        type="button"
                        className="table-filter-value"
                        title={`Filter by ${b.targetType}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setTypeFilter(typeFilter === b.targetType.toLowerCase() ? "all" : b.targetType.toLowerCase());
                        }}
                      >
                        {b.targetType}
                      </button>
                    </span>
                    <span>{b.frequency}</span>
                    <span>
                      <StatusBadge label={label} type={type} />
                    </span>
                    <span className="min-w-0">
                      <BackupS3Storage backup={b} withBucket={kind === "service"} />
                    </span>
                    <span>{b.latestFinishedAt ? ago(b.latestFinishedAt) : b.latestStatus === "running" ? "Running now" : "Never"}</span>
                    {kind === "service" ? (
                      <span className="flex justify-end" onClick={(e) => e.stopPropagation()}>
                        {actions?.(b)}
                      </span>
                    ) : (
                      <span className="text-right tabular-nums text-neutral-950 dark:text-fg">{b.executionsCount}</span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null
        ) : (
          <Empty
            size="sm"
            title="No scheduled backups"
            description={kind === "service" ? "Add a database, persistent volume, or directory backup schedule to protect service data." : "Add a persistent volume or directory backup schedule to protect application data."}
            iconName="storages"
          />
        )}
      </SettingsSection>
    </>
  );
}

function Counts({ backups }: { backups: BackupItem[] }) {
  const stat = (label: string, value: number) => (
    <div>
      <p className="text-xs font-medium text-neutral-500 dark:text-fg-dim">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-neutral-950 dark:text-fg">{value}</p>
    </div>
  );
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {stat("Schedules", backups.length)}
      {stat("Enabled", backups.filter((b) => b.enabled).length)}
      {stat("Total executions", backups.reduce((n, b) => n + b.executionsCount, 0))}
    </div>
  );
}

// ---------------------------------------------------------------- one schedule

type Section = "general" | "executions" | "danger";

/** VolumeBackups's general section (general, s3 and retention). */
function ScheduleGeneral({ api, data, canUpdate, onChanged }: { api: string; data: ScheduleData; canUpdate: boolean; onChanged: (d: ScheduleData) => void }) {
  const initial = (): Settings & Record<string, unknown> => {
    const settings: Record<string, unknown> = { ...data.backup };
    for (const key of ["uuid", "targetName", "targetType"]) delete settings[key];
    return settings as Settings & Record<string, unknown>;
  };
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(initial()), [data]);
  const dirty = canUpdate && JSON.stringify(form) !== JSON.stringify(initial());
  const set = (k: string) => (v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const num = (k: string) => (v: string) => set(k)(v === "" ? "" : Number(v));
  const b = data.backup;

  const save = useCallback(
    async (body: Record<string, unknown>) => {
      setSaving(true);
      const r = await postJson<ScheduleData & { message: string }>(api, body, "PATCH");
      setSaving(false);
      if (!r.ok) {
        const inline: Record<string, string> = {};
        for (const [f, m] of Object.entries(r.error.fields ?? {})) if (m[0]) inline[f] = m[0];
        setErrors(inline);
        return notify.error(summarize(r.error.messages));
      }
      setErrors({});
      onChanged(r.data);
      notify.success(r.data.message);
    },
    [api, onChanged],
  );
  async function backupNow() {
    const r = await postJson<unknown>(`${api}/run`, {});
    if (!r.ok) return notify.error(summarize(r.error.messages));
  }
  const field = (k: keyof Settings, label: string, helper: string, extra: { min?: number; max?: number; suffix?: string } = {}) => (
    <FormInput id={k} label={label} type="number" {...(extra.min !== undefined ? { min: extra.min } : {})} {...(extra.max !== undefined ? { max: extra.max } : {})} required helper={helper} value={String(form[k])} onChange={num(k)} disabled={!canUpdate} error={errors[k]} />
  );
  return (
    <form
      className="application-settings-form flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        void save({ ...form, action: "save" });
      }}
    >
      <UnsavedBar dirty={dirty} saving={saving} onSave={() => void save({ ...form, action: "save" })} />
      <SettingsSection
        title="Backup schedule"
        helper="Choose when this storage is archived and how long each backup may run."
        actions={
          canUpdate ? (
            <div className="flex items-center gap-2">
              <Button highlighted={!b.enabled} disabled={saving} onClick={() => void save({ ...form, action: "toggleEnabled" })}>
                {b.enabled ? "Disable backup" : "Enable backup"}
              </Button>
              <Button onClick={() => void backupNow()}>Back up now</Button>
            </div>
          ) : undefined
        }
      >
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg bg-neutral-50 px-3 py-2.5 ring-1 ring-neutral-200 dark:bg-white/[0.05] dark:ring-white/[0.07]">
          <span className="text-[12px] text-neutral-500 dark:text-fg-dim">{b.targetType}</span>
          <span className="truncate text-[12px] font-medium text-neutral-900 dark:text-fg">{b.targetName}</span>
        </div>
        <Callout type="warning" title="File-level consistency">
          Archives created while the application writes to this storage can be inconsistent. Stopping containers during the archive is safer, but briefly interrupts the application.
          <div className="mt-4">
            <Listbox
              id="stopDuringBackup"
              label="Archive behavior"
              options={[
                { value: "false", label: "Keep containers running" },
                { value: "true", label: "Stop containers during archive" },
              ]}
              value={String(form.stopDuringBackup)}
              onChange={(v) => void save({ ...form, stopDuringBackup: v === "true", action: "instantSave" })}
              disabled={!canUpdate}
            />
          </div>
        </Callout>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <FormInput id="frequency" label="Frequency" required helper="Use every_minute, hourly, daily, weekly, monthly, yearly, or a cron expression." value={form.frequency} onChange={set("frequency")} disabled={!canUpdate} error={errors.frequency} />
          <FormInput id="timezone" label="Timezone" required disabled helper="Uses the backup server timezone, or the instance timezone when none is configured." value={data.timezone} />
          {field("timeout", "Timeout", "Maximum backup runtime in seconds.", { min: 60, max: 36000 })}
          {field("missingBackupNotificationDays", "Missing backup alert after", "Notify through backup failure channels after this many days without an execution. Use 0 to disable.", { min: 0, max: 365 })}
        </div>
      </SettingsSection>

      {data.availableS3Storages.length === 0 ? (
        <SettingsSection title="S3 storage" helper="Send volume backup archives to a validated object storage destination." flush>
          <Empty title="No validated S3 storage" description="Add and validate an S3 storage destination before enabling remote backups." iconName="storages">
            <a className="button" href="/storages">
              Open S3 storage
            </a>
          </Empty>
        </SettingsSection>
      ) : (
        <SettingsSection
          title="S3 storage"
          helper="Choose where remote copies are stored and whether local archives are retained."
          actions={
            <Button highlighted={!b.saveToS3} disabled={!canUpdate || saving} onClick={() => void save({ ...form, action: "toggleS3" })}>
              {b.saveToS3 ? "Disable S3" : "Enable S3"}
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Listbox
              id="s3StorageIds"
              label="S3 storages"
              helper="Each backup is uploaded to every selected storage."
              placeholder="Select S3 storages"
              options={data.availableS3Storages.map((s) => ({ value: s.uuid, label: s.name + (s.isUsable ? "" : " (unavailable)") }))}
              value={null}
              onChange={() => undefined}
              values={form.s3StorageIds}
              onValues={(values) => void save({ ...form, s3StorageIds: values, action: "s3StorageIds" })}
              disabled={!canUpdate}
              error={errors.s3StorageIds}
            />
            <Listbox
              id="disableLocalBackup"
              label="Local copy"
              options={[
                { value: "false", label: "Keep local backup" },
                { value: "true", label: "Delete after S3 upload" },
              ]}
              value={String(form.disableLocalBackup)}
              onChange={(v) => set("disableLocalBackup")(v === "true")}
              disabled={!b.saveToS3 || !canUpdate}
            />
          </div>
        </SettingsSection>
      )}

      <SettingsSection title="Retention" helper="The first reached limit removes the oldest archive. Use 0 for unlimited retention.">
        {(
          [
            ["Local backups", "Locally", "local", ""],
            ["S3 backups", "S3", "S3", "mt-6 border-t border-neutral-200 pt-6 dark:border-white/[0.06]"],
          ] as const
        ).map(([heading, suffix, words, className]) => (
          <div key={suffix} className={className}>
            <h3 className="mb-3 text-sm font-semibold text-black dark:text-fg">{heading}</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {field(`retentionAmount${suffix}`, "Backups to keep", `Maximum number of recent ${words} backups.`, { min: 0 })}
              {field(`retentionDays${suffix}`, "Days to keep", `Remove ${words} backups older than this many days.`, { min: 0 })}
              {field(`retentionMaxStorage${suffix}`, "Maximum storage (GB)", `Remove the oldest ${words} backups after this total size is reached.`, { min: 0 })}
            </div>
          </div>
        ))}
      </SettingsSection>
    </form>
  );
}

/** volume-backups/executions.blade.php */
function ScheduleExecutions({ api, data, canUpdate, onPage }: { api: string; data: ScheduleData; canUpdate: boolean; onPage: (page: number, perPage: number) => void }) {
  const { total, page: current, perPage, rows } = data.executions;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  async function run(path: string, method: "POST" | "DELETE" = "POST", reload = false) {
    const r = await postJson<{ message: string; level?: string }>(`${api}/${path}`, {}, method);
    if (!r.ok) return notify.error(summarize(r.error.messages));
    toast(r.data.message, { type: r.data.level === "info" ? "info" : "success" });
    if (reload || method === "DELETE") onPage(current, perPage);
  }
  return (
    <SettingsSection
      title="Executions"
      helper="Review generated archives, availability, and cleanup status."
      flush
      actions={
        canUpdate ? (
          <>
            <Button onClick={() => void run("executions/cleanup-failed", "POST", true)}>Cleanup failed</Button>
            <ModalConfirmation
              title="Cleanup Deleted Backup Entries?"
              trigger={<button className="button button-error">Cleanup deleted</button>}
              actions={["This permanently deletes backup execution entries whose local and S3 files have already been deleted.", "This only removes database entries, not backup files."]}
              confirmationText="cleanup deleted backups"
              confirmationLabel="Please confirm by typing 'cleanup deleted backups' below"
              shortConfirmationLabel="Confirmation"
              onSubmit={() => run("executions/cleanup-deleted", "POST", true)}
            />
          </>
        ) : undefined
      }
    >
      {total > 0 ? (
        <div className="data-table w-full overflow-x-auto">
          <div className="data-table-header volume-backup-executions-grid border-b border-neutral-200 bg-neutral-50 dark:border-white/[0.08] dark:bg-white/[0.05]">
            <span>Status</span>
            <span>Archive</span>
            <span>Time</span>
            <span>Size</span>
            <span>Availability</span>
            <span className="text-right">Actions</span>
          </div>
          {rows.map((x) => {
            const finished = x.finishedAt ?? x.updatedAt;
            const label = x.status === "running" ? "In progress" : x.status === "success" && x.s3Uploaded === false ? "S3 warning" : x.status.charAt(0).toUpperCase() + x.status.slice(1);
            const type = x.status === "running" ? "warning" : x.status === "success" ? (x.s3Uploaded === false ? "warning" : "success") : x.status === "failed" ? "error" : "neutral";
            const liveS3 = x.s3Uploaded === true && !x.s3StorageDeleted;
            const actions = x.localStorageDeleted ? [] : ["This backup will be permanently deleted from local storage."];
            const errorLabel = ({ s3_auth: "S3 credentials", s3_bucket: "S3 bucket missing", server_unreachable: "server unreachable", remote_command: "remote command failed" } as Record<string, string>)[x.recoveryError ?? ""] ?? "unknown error";
            const recoveryPending = x.status !== "running" && x.recoveryPending;
            return (
              <div key={x.id} className="data-table-row volume-backup-executions-grid min-h-16 items-center gap-x-3 border-b border-neutral-200 text-[12px] last:border-b-0 dark:border-white/[0.07]">
                <span>
                  <StatusBadge label={label} type={type} />
                </span>
                <span className="min-w-0 truncate font-mono">{x.filename ?? "No archive name"}</span>
                <span className="text-[11px] text-neutral-500 dark:text-fg-faint">
                  {x.status === "running" ? (
                    `Running since ${x.createdAt ? ago(x.createdAt) : "now"}`
                  ) : (
                    <>
                      <span className="block text-black dark:text-fg">{finished}</span>
                      {finished ? ago(finished) : null}
                    </>
                  )}
                </span>
                <span className="tabular-nums text-neutral-500 dark:text-fg-dim">{x.size > 0 ? formatBytes(x.size) : "-"}</span>
                <span className="flex flex-wrap gap-1">
                  <StatusBadge label={x.localStorageDeleted ? "Local deleted" : "Local"} type={x.localStorageDeleted ? "neutral" : "success"} />
                  {x.s3Uploaded !== null ? <StatusBadge label={x.s3StorageDeleted ? "S3 deleted" : x.s3Uploaded ? "S3" : "S3 failed"} type={x.s3StorageDeleted ? "neutral" : x.s3Uploaded ? "success" : "error"} /> : null}
                  {recoveryPending ? x.recoveryNeedsAttention ? <StatusBadge label={`Needs attention (${errorLabel})`} type="error" /> : <StatusBadge label="Recovery pending" type="warning" title={x.recoveryError ? `Last attempt: ${errorLabel}` : null} /> : null}
                </span>
                <span className="flex items-center justify-end gap-1">
                  {x.status === "success" && x.isDownloadable ? (
                    <button type="button" className="icon-button shrink-0" title="Download backup" aria-label="Download backup" onClick={() => void run(`executions/${x.id}/download`)}>
                      <Reicon name="upload" className="size-3.5 rotate-180" />
                    </button>
                  ) : null}
                  {recoveryPending && canUpdate ? (
                    <button type="button" className="icon-button shrink-0" title="Retry recovery" aria-label="Retry recovery" onClick={() => void run(`executions/${x.id}/retry`)}>
                      <Reicon name="refresh" className="size-3.5" />
                    </button>
                  ) : null}
                  {x.status !== "running" && canUpdate ? (
                    <ModalConfirmation
                      title="Confirm Backup Deletion?"
                      trigger={
                        <button type="button" className="icon-button shrink-0 text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300" title="Delete backup" aria-label="Delete backup">
                          <Reicon name="trash" className="size-3.5" />
                        </button>
                      }
                      checkboxes={liveS3 ? [{ id: "delete_backup_s3", label: "Delete the selected backup permanently from every S3 storage" }] : []}
                      actions={actions.length ? actions : ["This backup execution record will be deleted."]}
                      confirmationText={x.filename ?? ""}
                      confirmationLabel="Please confirm the execution of the actions by entering the Backup Filename below"
                      shortConfirmationLabel="Backup Filename"
                      onSubmit={(selected) => run(`executions/${x.id}${selected.includes("delete_backup_s3") ? "?delete_backup_s3=1" : ""}`, "DELETE")}
                    />
                  ) : null}
                </span>
                {x.message ? <pre className="volume-backup-execution-message col-span-6 min-w-0 max-w-full max-h-20 overflow-y-auto overflow-x-hidden bg-transparent py-2 text-[11px] break-words whitespace-pre-wrap text-neutral-600 dark:text-fg-dim">{x.message}</pre> : null}
              </div>
            );
          })}
          <div className="flex items-center justify-between gap-3 px-3 py-2 text-xs text-neutral-500 dark:text-fg-dim">
            <span>
              {(current - 1) * perPage + 1}–{Math.min(total, current * perPage)} of {total}
            </span>
            <span className="flex items-center gap-2">
              <select className="input h-7! py-0!" value={perPage} onChange={(e) => onPage(1, Number(e.target.value))} aria-label="Page size">
                {[10, 25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <Button disabled={current <= 1} onClick={() => onPage(current - 1, perPage)}>
                Previous
              </Button>
              <Button disabled={current >= lastPage} onClick={() => onPage(current + 1, perPage)}>
                Next
              </Button>
            </span>
          </div>
        </div>
      ) : (
        <Empty size="sm" title="No executions" description="Run the backup schedule to create its first execution." iconName="storages" />
      )}
    </SettingsSection>
  );
}

/** volume-backups/danger.blade.php */
function ScheduleDanger({ api, data, onDeleted }: { api: string; data: ScheduleData; onDeleted: () => void }) {
  return (
    <div className="application-settings-form">
      <SettingsSection title="Delete backup schedule" helper="Permanently delete this schedule and optionally delete its local and S3 archives." className="danger-section">
        <DangerZone
          title="This action cannot be undone."
          action={
            <ModalConfirmation
              title="Delete backup schedule?"
              trigger={<button className="button button-error">Delete schedule</button>}
              checkboxes={data.deleteScheduleCheckboxes}
              actions={["Delete the selected backup schedule."]}
              confirmationText={data.backup.targetName}
              confirmationLabel={`Enter the ${data.backup.targetType} identifier to confirm.`}
              shortConfirmationLabel={`${data.backup.targetType} identifier`}
              onSubmit={async (selected) => {
                const q = selected.map((id) => `${id}=1`).join("&");
                const r = await postJson<{ message: string }>(`${api}${q ? `?${q}` : ""}`, {}, "DELETE");
                if (!r.ok) return notify.error(summarize(r.error.messages));
                notify.success(r.data.message);
                onDeleted();
              }}
            />
          }
        >
          <p>You can select which backup archives to remove.</p>
        </DangerZone>
      </SettingsSection>
    </div>
  );
}

/** The schedule's sections (the backup sidebar's General, Executions and Danger Zone). */
function ScheduleSections({ kind, uuid, data, setData, section, onSection, sections }: { kind: Kind; uuid: string; data: ScheduleData; setData: (d: ScheduleData) => void; section: Section; onSection: (s: Section) => void; sections: Section[] }) {
  const { me } = useSignedIn();
  const api = `${resourceApi(kind, me.team?.id, uuid)}/${kind === "application" ? "backups" : "storage-backups"}/${encodeURIComponent(data.backup.uuid)}`;
  const reloadPage = async (p: number, perPage: number) => {
    const r = await getJson<ScheduleData>(`${api}?page=${p}&perPage=${perPage}`);
    if (r.data) setData({ ...r.data, canUpdate: data.canUpdate } as ScheduleData);
  };
  const labels: Record<Section, string> = { general: "General", executions: "Executions", danger: "Danger Zone" };
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <nav aria-label="Backup sections" className="flex min-w-0 flex-wrap gap-1 border-b border-neutral-200 pb-2 dark:border-white/[0.08]">
        {sections.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onSection(s)}
            className={`inline-flex h-8 shrink-0 cursor-pointer items-center rounded-md px-3 text-[13px] font-medium transition-colors ${section === s ? "bg-coollabs/10 text-coollabs ring-1 ring-coollabs/25 dark:bg-brand/15 dark:text-brand-light dark:ring-brand-light/25" : "text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-fg-dim dark:hover:bg-white/[0.06] dark:hover:text-fg"}`}
          >
            {labels[s]}
          </button>
        ))}
      </nav>
      {section === "executions" ? (
        <ScheduleExecutions api={api} data={data} canUpdate={data.canUpdate} onPage={(p, n) => void reloadPage(p, n)} />
      ) : section === "danger" ? (
        <ScheduleDanger api={api} data={data} onDeleted={() => window.location.assign(indexPath(kind))} />
      ) : (
        <ScheduleGeneral api={api} data={data} canUpdate={data.canUpdate} onChanged={(d) => setData({ ...d, canUpdate: data.canUpdate } as ScheduleData)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the pages

/** project.application.backup.index */
function ApplicationBackupsContent() {
  const { me, data } = useResourceSection<IndexData>("application", "backups");
  const [creating, setCreating] = useState(false);
  if (!data) return null;
  const base = `${resourceApi("application", me.team?.id, resourceFrameUuid(data))}/backups`;
  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Backups">
      <div className="application-settings-form flex min-w-0 flex-col gap-6">
        <SettingsSection
          title="Storage backups"
          helper="Schedule backups for persistent volumes and directory mounts attached to this application."
          actions={
            data.canUpdate ? (
              <ModalInput
                title="New scheduled backup"
                open={creating}
                onOpenChange={setCreating}
                trigger={
                  <button type="button" className="button button-highlighted">
                    <Reicon name="plus" className="size-3.5" />
                    Add
                  </button>
                }
              >
                <CreateBackup kind="application" base={base} targets={data.targets} onSaved={(uuid) => window.location.assign(`${indexPath("application")}/${uuid}`)} />
              </ModalInput>
            ) : undefined
          }
        >
          <Counts backups={data.backups} />
        </SettingsSection>
        <BackupTable kind="application" backups={data.backups} databaseBackups={[]} onOpen={(b) => window.location.assign(`${indexPath("application")}/${b.uuid}`)} />
      </div>
    </ResourceWorkspace>
  );
}

const resourceFrameUuid = (data: ApplicationSectionData | ServiceSectionData): string => ("application" in data ? data.application.uuid : data.service.uuid);

/** project.application.backup.show|executions|danger */
function ApplicationBackupShowContent() {
  const parts = window.location.pathname.replace(/\/+$/, "").split("/");
  const at = parts.lastIndexOf("backups");
  const backupUuid = decodeURIComponent(parts[at + 1] ?? "");
  const section: Section = parts[at + 2] === "executions" ? "executions" : parts[at + 2] === "danger" ? "danger" : "general";
  const { me, data, setData } = useResourceSection<ScheduleData>("application", `backups/${encodeURIComponent(backupUuid)}`);
  if (!data) return null;
  const go = (s: Section) => window.location.assign(`${indexPath("application")}/${encodeURIComponent(backupUuid)}${s === "general" ? "" : `/${s}`}`);
  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Backups">
      <div className="min-w-0">
        <a className="menu-item mb-3 inline-flex" href={indexPath("application")}>
          <Reicon name="logout" className="menu-item-icon rotate-180" />
          <span className="menu-item-label">Back to backups</span>
        </a>
        <ScheduleSections kind="application" uuid={resourceFrameUuid(data)} data={data} setData={setData} section={section} onSection={go} sections={["general", "executions", "danger"]} />
      </div>
    </ResourceWorkspace>
  );
}

/** project.service.volume-backups.index */
function ServiceStorageBackupsContent() {
  const { me, data } = useResourceSection<IndexData>("service", "storage-backups");
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(() => new URLSearchParams(window.location.search).get("backup_uuid"));
  const [schedule, setSchedule] = useState<ScheduleData | null>(null);
  const [section, setSection] = useState<Section>("general");
  const uuid = serviceUuidFromPath();
  const base = `${resourceApi("service", me.team?.id, uuid)}/storage-backups`;
  // openSchedule($uuid): the schedule's modal (#[Url(as: 'backup_uuid')]).
  useEffect(() => {
    if (!open) return setSchedule(null);
    void (async () => {
      const r = await postJson<ScheduleData>(`${base}/${encodeURIComponent(open)}`, null, "GET");
      if (!r.ok) {
        setOpen(null);
        return notify.error(summarize(r.error.messages));
      }
      setSchedule({ ...r.data, canUpdate: true } as ScheduleData);
    })();
  }, [open, base]);
  if (!data) return null;
  const databaseBackups = data.databaseBackups ?? [];
  async function backupNow(type: "database" | "storage", backupUuid: string) {
    const r = await postJson<{ message: string }>(`${base}/now/${type}/${encodeURIComponent(backupUuid)}`, {});
    if (!r.ok) return notify.error(summarize(r.error.messages));
    notify.success(r.data.message);
  }
  const openRow = (b: BackupItem) => {
    // A database schedule opens BackupEdit for a service database, which is not ported.
    if (b.targetType === "Database") return notify.error("Editing a service database's backup schedule is not available yet.");
    setSection("general");
    setOpen(b.uuid);
  };
  return (
    <ResourceWorkspace data={data} orgId={me.team?.id} active="Backups">
      <div className="application-settings-form flex min-w-0 flex-col gap-6">
        <ModalInput title="Edit backup schedule" {...(schedule ? { subtitle: `${schedule.backup.targetName} · ${schedule.backup.frequency} schedule` } : {})} open={Boolean(open && schedule)} onOpenChange={(v) => !v && setOpen(null)}>
          {schedule ? <ScheduleSections kind="service" uuid={uuid} data={schedule} setData={setSchedule} section={section} onSection={setSection} sections={["general", "danger"]} /> : null}
        </ModalInput>
        <SettingsSection
          title="Backups"
          helper="Manage database, persistent volume, and directory backup schedules for this service."
          actions={
            data.canUpdate ? (
              <ModalInput
                title="New storage backup"
                open={creating}
                onOpenChange={setCreating}
                trigger={
                  <button type="button" className="button button-highlighted">
                    <Reicon name="plus" className="size-3.5" />
                    Add backup
                  </button>
                }
              >
                <CreateBackup kind="service" base={base} targets={data.targets} onSaved={() => window.location.assign(indexPath("service"))} />
              </ModalInput>
            ) : undefined
          }
        >
          <Counts backups={[...data.backups, ...databaseBackups]} />
        </SettingsSection>
        <BackupTable
          kind="service"
          backups={data.backups}
          databaseBackups={databaseBackups}
          onOpen={openRow}
          actions={(b) =>
            data.canUpdate ? (
              <span className="flex items-center gap-1">
                <Button disabled={b.targetType === "Database" && !b.databaseRunning} tooltip={b.targetType === "Database" && !b.databaseRunning ? "The database must be running to start a backup." : null} onClick={() => void backupNow(b.targetType === "Database" ? "database" : "storage", b.uuid)}>
                  Back up now
                </Button>
                {b.targetType === "Database" ? null : <Button onClick={() => openRow(b)}>Edit</Button>}
              </span>
            ) : null
          }
        />
      </div>
    </ResourceWorkspace>
  );
}

/** Show::mount() and DatabaseBackups::mount(): the redirects of a service's backup links. */
function ServiceBackupRedirect({ database }: { database: boolean }) {
  const { me } = useSignedIn();
  useEffect(() => {
    const parts = window.location.pathname.replace(/\/+$/, "").split("/");
    const service = resourcePath("service");
    const api = resourceApi("service", me.team?.id, serviceUuidFromPath());
    void (async () => {
      if (database) {
        const stack = decodeURIComponent(parts[7] ?? "");
        const r = await getJson<{ redirect: string }>(`${api}/database-backups/${encodeURIComponent(stack)}`);
        if (!r.data) return window.location.replace(environmentPath(projectUuidFromPath(), environmentUuidFromPath()));
        return window.location.replace(r.data.redirect === "configuration" ? service : r.data.redirect === "part" ? `${service}/${encodeURIComponent(stack)}` : `${service}/storage-backups`);
      }
      // Show::mount(): the service's schedule (firstOrFail()), then the index without it.
      const at = parts.lastIndexOf("storage-backups");
      const backup = decodeURIComponent(parts[at + 1] ?? "");
      const r = await getJson<IndexData>(`${api}/storage-backups`);
      window.location.replace(r.data?.backups.some((b) => b.uuid === backup) ? `${service}/storage-backups` : environmentPath(projectUuidFromPath(), environmentUuidFromPath()));
    })();
  }, [database, me.team?.id]);
  return null;
}

export const ApplicationBackupsPage = () => page(<ApplicationBackupsContent />);
export const ApplicationBackupShowPage = () => page(<ApplicationBackupShowContent />);
export const ServiceStorageBackupsPage = () => page(<ServiceStorageBackupsContent />);
export const ServiceStorageBackupRedirectPage = () => page(<ServiceBackupRedirect database={false} />);
export const ServiceDatabaseBackupsRedirectPage = () => page(<ServiceBackupRedirect database />);
