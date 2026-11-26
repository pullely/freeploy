// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/database/backup/{index,execution-history}.blade.php,
// resources/views/livewire/project/database/{scheduled-backups,create-scheduled-backup,backup-edit}.blade.php,
// resources/views/livewire/project/database/backup-edit/{general,s3,retention,danger}.blade.php,
// resources/views/components/{backup-tabs,backup-s3-storage}.blade.php and resources/views/components/table/row-action*.blade.php
// (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/database/{db_uuid}/backups: the
// schedules of a database, its counts and its executions; a schedule opens in
// a dialog (?schedule={backup_uuid}), as in Coolify, whose
// …/backups/{backup_uuid}/{section?} links redirect here. Configuration only:
// nothing runs a schedule yet, so "Back up now" says the SSH executor is not
// available and the executions stay empty. Import is not ported.
import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, DangerZone, Empty, FormInput, Listbox, ModalConfirmation, ModalInput, SettingsSection, StatusBadge, UnsavedBar } from "../components/Coolify";
import { TableDropdown } from "../components/CoolifyList";
import { databasePath, databasesApi, databaseUuidFromPath, DatabaseWorkspace, type DatabaseShowData } from "./DatabaseChrome";

interface BackupItem {
  uuid: string;
  frequency: string;
  enabled: boolean;
  saveS3: boolean;
  storages: Array<{ uuid: string; name: string; label: string }>;
  latestStatus: string | null;
  latestFinishedAt: string | null;
  executionsCount: number;
}

interface Execution {
  uuid: string;
  backupUuid: string;
  schedule: string;
  status: string;
  databaseName: string | null;
  size: number | null;
  filename: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  s3Uploaded: boolean | null;
}

interface BackupsData {
  available: boolean;
  database: { uuid: string; name: string; status: string; engine: string; projectUuid: string; environmentUuid: string };
  backups: BackupItem[];
  scheduleCount: number;
  enabledScheduleCount: number;
  executionCount: number;
  executions: { total: number; rows: Execution[] };
  canUpdate: boolean;
  canManageBackups: boolean;
  canDelete: boolean;
}

interface BackupDetail {
  uuid: string;
  frequency: string;
  backupEnabled: boolean;
  timezone: string;
  databaseBackupRetentionAmountLocally: number;
  databaseBackupRetentionDaysLocally: number;
  databaseBackupRetentionMaxStorageLocally: number;
  databaseBackupRetentionAmountS3: number;
  databaseBackupRetentionDaysS3: number;
  databaseBackupRetentionMaxStorageS3: number;
  saveS3: boolean;
  disableLocalBackup: boolean;
  s3StorageUuids: string[];
  databasesToBackup: string | null;
  dumpAll: boolean;
  timeout: number;
  missingBackupNotificationDays: number;
  availableS3Storages: Array<{ uuid: string; name: string; isUsable: boolean }>;
  status: string;
  databaseName: string;
  selection: "dump-all" | "mongodb" | "clickhouse" | null;
}

/** "3 minutes ago", as Carbon's diffForHumans() words it. */
function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  const [n, unit] = s < 60 ? [s, "second"] : s < 3600 ? [Math.floor(s / 60), "minute"] : s < 86400 ? [Math.floor(s / 3600), "hour"] : [Math.floor(s / 86400), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

/** The status badge of a schedule: its latest run, else Waiting / Disabled. */
function scheduleStatus(b: BackupItem): [string, "neutral" | "success" | "warning" | "error"] {
  if (b.latestStatus === "running") return ["In progress", "warning"];
  if (b.latestStatus === "success") return ["Success", "success"];
  if (b.latestStatus === "failed") return ["Failed", "error"];
  return [b.enabled ? "Waiting" : "Disabled", "neutral"];
}

/** <x-backup-s3-storage>: S3 is a setting, not a state. */
function BackupS3Storage({ backup }: { backup: BackupItem }) {
  const tooltip = backup.saveS3 && backup.storages.length ? `S3 storage: ${backup.storages.map((s) => s.label).join(", ")}` : undefined;
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1.5" {...(tooltip ? { "data-tooltip": tooltip, "aria-label": tooltip, tabIndex: 0 } : {})}>
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

/** livewire/project/database/create-scheduled-backup. */
function CreateScheduledBackup({ base, onCreated }: { base: string; onCreated: (uuid: string) => void }) {
  const [frequency, setFrequency] = useState("");
  const [error, setError] = useState<string | undefined>();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await postJson<{ uuid: string }>(`${base}/backups`, { frequency });
    setFrequency("");
    if (!r.ok) {
      const field = r.error.fields?.frequency?.[0];
      if (field) return setError(field);
      return notify.error(summarize(r.error.messages));
    }
    setError(undefined);
    onCreated(r.data.uuid);
  }
  return (
    <form className="application-settings-form flex w-full flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <FormInput
        id="frequency"
        label="Frequency"
        required
        placeholder="0 0 * * * or daily"
        helper="You can use every_minute, hourly, daily, weekly, monthly, yearly or a cron expression."
        value={frequency}
        onChange={setFrequency}
        error={error}
      />
      <div className="flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
        <button type="submit" className="button button-highlighted">
          Add schedule
        </button>
      </div>
    </form>
  );
}

/** The chip input of "Databases to back up" (general.blade.php's Alpine component). */
function DatabaseChips({ value, onChange, disabled }: { value: string | null; onChange: (v: string) => void; disabled: boolean }) {
  const [draft, setDraft] = useState("");
  const databases = (value ?? "").split(",").map((n) => n.trim()).filter(Boolean);
  const add = () => {
    const names = draft.split(",").map((n) => n.trim()).filter(Boolean);
    if (!names.length) return;
    onChange([...new Set([...databases, ...names])].join(","));
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    }
  };
  return (
    <div className="chip-input">
      {databases.map((database, index) => (
        <span key={database} className="chip font-mono">
          <span>{database}</span>
          <button type="button" className="chip-remove" aria-label={`Remove ${database}`} disabled={disabled} onClick={() => onChange(databases.filter((_, i) => i !== index).join(","))}>
            <Reicon name="x" className="size-3" />
          </button>
        </span>
      ))}
      <input value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={onKey} onBlur={add} type="text" placeholder="Type a database and press Enter" disabled={disabled} />
    </div>
  );
}

type EditForm = Omit<BackupDetail, "availableS3Storages" | "status" | "databaseName" | "selection" | "uuid" | "timezone"> & Record<string, unknown>;
/** The fields the form edits (what the save sends). */
const EDITABLE = [
  "frequency", "backupEnabled", "databaseBackupRetentionAmountLocally", "databaseBackupRetentionDaysLocally", "databaseBackupRetentionMaxStorageLocally",
  "databaseBackupRetentionAmountS3", "databaseBackupRetentionDaysS3", "databaseBackupRetentionMaxStorageS3", "saveS3", "disableLocalBackup", "s3StorageUuids",
  "databasesToBackup", "dumpAll", "timeout", "missingBackupNotificationDays",
] as const;
const editable = (d: BackupDetail): EditForm => Object.fromEntries(EDITABLE.map((k) => [k, d[k]])) as EditForm;

/** livewire/project/database/backup-edit with backup-edit/{general,s3,retention}: the General section. */
function BackupEditGeneral({ api, detail, canManage, onChanged }: { api: string; detail: BackupDetail; canManage: boolean; onChanged: (d: BackupDetail) => void }) {
  const [form, setForm] = useState<EditForm>(() => editable(detail));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => setForm(editable(detail)), [detail]);
  const dirty = canManage && JSON.stringify(form) !== JSON.stringify(editable(detail));
  const set = (k: string) => (v: unknown) => setForm((f) => ({ ...f, [k]: v }));
  const num = (k: string) => (v: string) => set(k)(v === "" ? "" : Number(v));
  const running = detail.status.startsWith("running");

  /** submit(), instantSave() and toggleS3(): the API answers the toast. */
  const save = useCallback(
    async (body: Record<string, unknown>) => {
      setSaving(true);
      const r = await postJson<{ backup: BackupDetail; message: string }>(api, body, "PATCH");
      setSaving(false);
      if (!r.ok) {
        const inline: Record<string, string> = {};
        for (const [f, m] of Object.entries(r.error.fields ?? {})) if (m[0]) inline[f] = m[0];
        setErrors(inline);
        return notify.error(summarize(r.error.messages));
      }
      setErrors({});
      onChanged(r.data.backup);
      notify.success(r.data.message);
    },
    [api, onChanged],
  );
  async function toggleEnabled() {
    const r = await postJson<{ enabled: boolean; message: string }>(api, { action: "toggleEnabled" }, "PATCH");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    onChanged({ ...detail, backupEnabled: r.data.enabled });
    notify.success(r.data.message);
  }
  async function backupNow() {
    const r = await postJson<unknown>(api, {});
    if (!r.ok) return notify.error(summarize(r.error.messages));
  }
  const storageOptions = detail.availableS3Storages.map((s) => ({ value: s.uuid, label: s.name + (s.isUsable ? "" : " (unavailable)") }));

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        void save(form);
      }}
    >
      <UnsavedBar dirty={dirty} saving={saving} onSave={() => void save(form)} />
      <SettingsSection
        title="Backup schedule"
        helper="Choose what to back up, when it runs, and how long it may run."
        actions={
          <div className="flex items-center gap-2">
            <Button highlighted={!detail.backupEnabled} disabled={!canManage} onClick={() => void toggleEnabled()}>
              {detail.backupEnabled ? "Disable backup" : "Enable backup"}
            </Button>
            <Button disabled={!running || !canManage} tooltip={running ? null : "The database must be running to start a backup."} onClick={() => void backupNow()}>
              Back up now
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          {detail.selection === "dump-all" ? (
            <div className="grid w-full gap-4">
              <Listbox
                id="dumpAll"
                label="Database selection"
                options={[
                  { value: "true", label: "All databases" },
                  { value: "false", label: "Specific databases" },
                ]}
                value={String(form.dumpAll)}
                onChange={(v) => void save({ ...form, dumpAll: v === "true", action: "instantSave" })}
                disabled={!canManage}
              />
              {!detail.dumpAll ? (
                <div className="w-full">
                  <label className="mb-1.5 block text-sm font-medium">Databases to back up</label>
                  <DatabaseChips value={form.databasesToBackup} onChange={set("databasesToBackup")} disabled={!canManage} />
                  <p className="mt-1.5 text-xs text-neutral-500 dark:text-fg-dim">Add one or more database names. Leave empty to include the default database.</p>
                </div>
              ) : null}
            </div>
          ) : detail.selection === "mongodb" ? (
            <FormInput
              id="databasesToBackup"
              label="Databases to include"
              helper="Use database:collection1,collection2|database2 to exclude selected collections. Leave empty to include all databases and collections."
              value={form.databasesToBackup ?? ""}
              onChange={set("databasesToBackup")}
              disabled={!canManage}
            />
          ) : detail.selection === "clickhouse" ? (
            <FormInput id="databasesToBackup" label="Databases to back up" helper="Comma-separated database names. Leave empty to include the default database." value={form.databasesToBackup ?? ""} onChange={set("databasesToBackup")} disabled={!canManage} />
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FormInput id="frequency" label="Frequency" required value={form.frequency} onChange={set("frequency")} disabled={!canManage} error={errors.frequency} />
            <FormInput id="timezone" label="Timezone" required disabled helper="Uses the deployment server timezone, or the instance timezone when none is configured." value={detail.timezone} />
            <FormInput
              id="timeout"
              label="Timeout"
              type="number"
              min={60}
              required
              helper="Maximum runtime in seconds of the complete backup run: the dumps and S3 uploads of all databases."
              value={String(form.timeout)}
              onChange={num("timeout")}
              disabled={!canManage}
              error={errors.timeout}
            />
            <FormInput
              id="missingBackupNotificationDays"
              label="Missing backup alert after"
              type="number"
              min={0}
              max={365}
              required
              helper="Notify through backup failure channels after this many days without an execution. Use 0 to disable."
              value={String(form.missingBackupNotificationDays)}
              onChange={num("missingBackupNotificationDays")}
              disabled={!canManage}
              error={errors.missingBackupNotificationDays}
            />
          </div>
        </div>
      </SettingsSection>

      {detail.availableS3Storages.length === 0 ? (
        <SettingsSection title="S3 storage" helper="Send backup archives to a validated object storage destination." flush>
          <Empty title="No validated S3 storage" description="Add and validate an S3 storage destination before enabling remote backups." iconName="storages">
            <a className="button" href="/storages">
              Open S3 storage
            </a>
          </Empty>
        </SettingsSection>
      ) : (
        <SettingsSection
          title="S3 storage"
          helper="Choose where remote backups are stored and whether local copies are retained."
          actions={
            <Button highlighted={!detail.saveS3} disabled={!canManage} onClick={() => void save({ ...form, action: "toggleS3" })}>
              {detail.saveS3 ? "Disable S3" : "Enable S3"}
            </Button>
          }
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Listbox
              id="s3StorageIds"
              label="S3 storages"
              helper="Each backup is uploaded to every selected storage."
              placeholder="Select S3 storages"
              options={storageOptions}
              value={null}
              onChange={() => undefined}
              values={form.s3StorageUuids}
              onValues={(values) => void save({ ...form, s3StorageUuids: values, action: "instantSave" })}
              disabled={!canManage}
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
              disabled={!detail.saveS3 || !canManage}
            />
          </div>
        </SettingsSection>
      )}

      <SettingsSection title="Retention" helper="The first reached limit removes the oldest backup. Use 0 for unlimited retention.">
        <div className="space-y-6">
          {(
            [
              ["Local backups", "Locally", "local"],
              ["S3 backups", "S3", "S3"],
            ] as const
          ).map(([heading, suffix, words]) => (
            <div key={suffix}>
              <h4 className="mb-2 text-xs! font-medium! text-neutral-500! dark:text-fg-dim!">{heading}</h4>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <FormInput
                  id={`databaseBackupRetentionAmount${suffix}`}
                  label="Backups to keep"
                  type="number"
                  min={0}
                  required
                  helper={`Maximum number of recent ${words} backups of each database.`}
                  value={String(form[`databaseBackupRetentionAmount${suffix}`])}
                  onChange={num(`databaseBackupRetentionAmount${suffix}`)}
                  disabled={!canManage}
                  error={errors[`databaseBackupRetentionAmount${suffix}`]}
                />
                <FormInput
                  id={`databaseBackupRetentionDays${suffix}`}
                  label="Days to keep"
                  type="number"
                  min={0}
                  required
                  helper={`Remove ${words} backups older than this many days, counted from the newest backup of the same database.`}
                  value={String(form[`databaseBackupRetentionDays${suffix}`])}
                  onChange={num(`databaseBackupRetentionDays${suffix}`)}
                  disabled={!canManage}
                  error={errors[`databaseBackupRetentionDays${suffix}`]}
                />
                <FormInput
                  id={`databaseBackupRetentionMaxStorage${suffix}`}
                  label="Maximum storage (GB)"
                  type="number"
                  min={0}
                  required
                  helper={`Remove oldest ${words} backups after the backups of all databases reach this total size. The newest backup of each database stays.`}
                  value={String(form[`databaseBackupRetentionMaxStorage${suffix}`])}
                  onChange={num(`databaseBackupRetentionMaxStorage${suffix}`)}
                  disabled={!canManage}
                  error={errors[`databaseBackupRetentionMaxStorage${suffix}`]}
                />
              </div>
            </div>
          ))}
        </div>
      </SettingsSection>
    </form>
  );
}

/** backup-edit/danger. */
function BackupEditDanger({ api, detail, canDelete, onDeleted }: { api: string; detail: BackupDetail; canDelete: boolean; onDeleted: () => void }) {
  async function remove(selected: string[]) {
    const q = new URLSearchParams({
      delete_associated_backups_locally: selected.includes("delete_associated_backups_locally") ? "1" : "0",
      delete_associated_backups_s3: selected.includes("delete_associated_backups_s3") ? "1" : "0",
    });
    const r = await postJson<{ message: string }>(`${api}?${q.toString()}`, {}, "DELETE");
    if (!r.ok) return notify.error(`Failed to delete backup: ${summarize(r.error.messages)}`);
    notify.success(r.data.message);
    onDeleted();
  }
  return (
    <div className="application-settings-form">
      <SettingsSection title="Delete backup schedule" helper="Permanently remove this schedule and optionally its backup archives.">
        <DangerZone
          title="This action cannot be undone."
          action={
            <ModalConfirmation
              title="Confirm Backup Schedule Deletion?"
              disabled={!canDelete}
              trigger={
                <button type="button" className="button button-error" disabled={!canDelete}>
                  Delete schedule
                </button>
              }
              checkboxes={[
                { id: "delete_associated_backups_locally", label: "All backups will be permanently deleted from local storage." },
                { id: "delete_associated_backups_s3", label: "All backups will be permanently deleted (associated with this backup job) from every S3 storage of this schedule." },
              ]}
              actions={["The selected backup schedule will be deleted.", "Scheduled backups for this database will stop if this is its only schedule."]}
              confirmationText={detail.databaseName}
              confirmationLabel="Enter the database name to confirm deletion."
              shortConfirmationLabel="Database Name"
              onSubmit={remove}
            />
          }
        >
          <p>You can select which backup archives to remove.</p>
        </DangerZone>
      </SettingsSection>
    </div>
  );
}

/** The schedule's dialog: General and Danger Zone (<x-backup-tabs context="service-schedule">). */
function ScheduleModal(props: { api: string; open: boolean; onClose: () => void; databaseName: string; canManage: boolean; canDelete: boolean; onChanged: () => void }) {
  const [detail, setDetail] = useState<BackupDetail | null>(null);
  const [section, setSection] = useState<"general" | "danger">("general");
  useEffect(() => {
    void (async () => {
      const r = await getJson<{ backup: BackupDetail }>(props.api);
      if (r.data) setDetail(r.data.backup);
    })();
  }, [props.api]);
  const { onChanged } = props;
  const changed = useCallback(
    (d: BackupDetail) => {
      setDetail(d);
      onChanged();
    },
    [onChanged],
  );
  if (!detail) return null;
  return (
    <ModalInput title="Edit backup schedule" subtitle={`${props.databaseName} · ${detail.frequency} schedule`} open={props.open} onOpenChange={(o) => (o ? undefined : props.onClose())}>
      <div className="modal-flat-sections flex min-w-0 flex-col gap-6">
        <nav aria-label="Backup sections" className="flex min-w-0 flex-wrap gap-1 border-b border-neutral-200 pb-2 dark:border-white/[0.08]">
          {(
            [
              ["general", "General"],
              ["danger", "Danger Zone"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSection(key)}
              className={`inline-flex h-8 shrink-0 cursor-pointer items-center rounded-md px-3 text-[13px] font-medium transition-colors ${
                section === key
                  ? "bg-coollabs/10 text-coollabs ring-1 ring-coollabs/25 dark:bg-brand/15 dark:text-brand-light dark:ring-brand-light/25"
                  : "text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:text-fg-dim dark:hover:bg-white/[0.06] dark:hover:text-fg"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
        {section === "general" ? (
          <BackupEditGeneral api={props.api} detail={detail} canManage={props.canManage} onChanged={changed} />
        ) : (
          <BackupEditDanger
            api={props.api}
            detail={detail}
            canDelete={props.canDelete}
            onDeleted={() => {
              props.onChanged();
              props.onClose();
            }}
          />
        )}
      </div>
    </ModalInput>
  );
}

function DatabaseBackupsContent() {
  const { me } = useSignedIn();
  const uuid = databaseUuidFromPath();
  const base = `${databasesApi(me.team?.id)}/${encodeURIComponent(uuid)}`;
  const [show, setShow] = useState<DatabaseShowData | null>(null);
  const [data, setData] = useState<BackupsData | null>(null);
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [schedule, setSchedule] = useState<string | null>(() => new URLSearchParams(window.location.search).get("schedule"));

  const load = useCallback(async () => {
    const r = await getJson<BackupsData>(`${base}/backups`);
    if (r.data) setData(r.data);
  }, [base]);
  useEffect(() => {
    void (async () => {
      const r = await getJson<DatabaseShowData>(base);
      if (!r.data) {
        if (r.status === 404) window.location.replace("/projects");
        return;
      }
      const here = databasePath(r.data.database.project.uuid, r.data.database.environment.uuid, r.data.database.uuid);
      // Backup\Index::mount(): a database without a backup solution goes to its configuration.
      if (!r.data.database.backups) return window.location.replace(here);
      setShow(r.data);
      document.title = `${r.data.database.name.slice(0, 10)} > Backups | Freeploy`;
      await load();
    })();
  }, [base, load]);

  if (!show || !data) return null;
  const { database } = show;
  // A ?schedule= that names no schedule of this database opens nothing.
  const selected = schedule && data.backups.some((b) => b.uuid === schedule) ? schedule : null;
  const q = search.toLowerCase();
  const matches = (b: BackupItem) => !q || database.name.toLowerCase().includes(q) || b.frequency.toLowerCase().includes(q) || b.storages.map((s) => s.name).join(", ").toLowerCase().includes(q);
  const running = database.status.startsWith("running");

  function openSchedule(backupUuid: string) {
    setSchedule(backupUuid);
  }
  function closeSchedule() {
    setSchedule(null);
    // closeScheduleModal(): a reload must not open it again.
    history.replaceState(history.state, "", location.pathname);
  }
  async function backupNow(backupUuid: string) {
    const r = await postJson<unknown>(`${base}/backups/${backupUuid}`, {});
    if (!r.ok) notify.error(summarize(r.error.messages));
  }

  return (
    <DatabaseWorkspace database={database} orgId={me.team?.id} active="Backups" canUpdate={show.canUpdate} canManage={show.canManage}>
      <div className="application-settings-form flex min-w-0 flex-col gap-6">
        <SettingsSection
          title="Database backups"
          helper="Automate database backups and track the latest execution for each schedule."
          actions={
            data.canUpdate ? (
              <ModalInput
                title="New Scheduled Backup"
                open={addOpen}
                onOpenChange={setAddOpen}
                trigger={
                  <button type="button" className="button button-highlighted">
                    + Add
                  </button>
                }
              >
                <CreateScheduledBackup
                  base={base}
                  onCreated={(created) => {
                    setAddOpen(false);
                    history.replaceState(history.state, "", `${location.pathname}?schedule=${created}`);
                    setSchedule(created);
                    void load();
                  }}
                />
              </ModalInput>
            ) : undefined
          }
        >
          <div className="grid gap-4 sm:grid-cols-3">
            {(
              [
                ["Schedules", data.scheduleCount],
                ["Enabled", data.enabledScheduleCount],
                ["Total executions", data.executionCount],
              ] as const
            ).map(([label, n]) => (
              <div key={label}>
                <p className="text-xs font-medium text-neutral-500 dark:text-fg-dim">{label}</p>
                <p className="mt-1 text-xl font-semibold tabular-nums text-neutral-950 dark:text-fg">{n}</p>
              </div>
            ))}
          </div>
        </SettingsSection>

        <div className="flex min-w-0 flex-col gap-6">
          {selected ? (
            <ScheduleModal
              key={selected}
              api={`${base}/backups/${selected}`}
              open
              onClose={closeSchedule}
              databaseName={database.name}
              canManage={data.canManageBackups}
              canDelete={data.canDelete}
              onChanged={() => void load()}
            />
          ) : null}
          {data.backups.length ? (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="relative max-w-sm">
                <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
                <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search backups" className="input h-8! w-full pl-8! text-[13px]!" placeholder="Search backups" />
              </div>
            </div>
          ) : null}
          <SettingsSection title="Schedules" helper="Backup schedules of this database." flush={data.backups.length > 0}>
            {data.backups.length === 0 ? (
              <Empty size="sm" title="No scheduled backups" description="Create a schedule to start protecting this database." iconName="storages" />
            ) : !data.backups.some(matches) ? (
              <Empty size="sm" title="No matching backup schedules" description="Try another database name, frequency, or storage name." />
            ) : (
              <div className="data-table w-full overflow-x-auto">
                <div className="flex min-w-[48rem] flex-col">
                  <div className="data-table-header database-backup-table-grid">
                    <span>Schedule</span>
                    <span>Status</span>
                    <span>S3</span>
                    <span>Last run</span>
                    <span>Executions</span>
                    <span className="text-right">Actions</span>
                  </div>
                  {data.backups.filter(matches).map((b) => {
                    const [label, type] = scheduleStatus(b);
                    return (
                      <div
                        key={b.uuid}
                        role="button"
                        tabIndex={0}
                        onClick={() => openSchedule(b.uuid)}
                        onKeyDown={(e) => e.key === "Enter" && openSchedule(b.uuid)}
                        className="data-table-row database-backup-table-grid cursor-pointer text-left text-[13px] text-neutral-700 dark:text-fg-dim"
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium text-neutral-950 dark:text-fg">{b.frequency}</span>
                          {!b.enabled && b.latestStatus ? <StatusBadge label="Disabled" /> : null}
                        </span>
                        <span className="flex items-center gap-2">
                          <StatusBadge label={label} type={type} />
                        </span>
                        <span className="min-w-0">
                          <BackupS3Storage backup={b} />
                        </span>
                        <span>{b.latestFinishedAt ? ago(b.latestFinishedAt) : b.latestStatus === "running" ? "Running now" : "Never"}</span>
                        <span>{b.executionsCount}</span>
                        <span className="flex justify-end" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                          <TableDropdown
                            panelClass="w-44!"
                            trigger={(open) => (
                              <button type="button" className="icon-button" title="Backup schedule actions" aria-label="Backup schedule actions" aria-haspopup="menu" aria-expanded={open}>
                                <Reicon name="dots-horizontal" className="size-4" />
                              </button>
                            )}
                          >
                            {(close) => (
                              <div className="contents">
                                {data.canManageBackups ? (
                                  <button
                                    type="button"
                                    role="menuitem"
                                    className="listbox-option justify-start!"
                                    disabled={!running}
                                    title={running ? undefined : "The database must be running to start a backup."}
                                    onClick={() => (close(), void backupNow(b.uuid))}
                                  >
                                    Back up now
                                  </button>
                                ) : null}
                                <button type="button" role="menuitem" className="listbox-option justify-start!" onClick={() => (close(), openSchedule(b.uuid))}>
                                  Edit
                                </button>
                              </div>
                            )}
                          </TableDropdown>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </SettingsSection>
        </div>

        <SettingsSection title="Executions" helper="Review backup runs across every schedule of this database." flush>
          {data.executions.rows.length === 0 ? (
            <Empty size="sm" title="No backup executions" description="Execution history appears here after a backup schedule runs." iconName="browser-terminal" />
          ) : (
            <div className="data-table relative w-full overflow-x-auto">
              <div className="flex min-w-[48rem] flex-col">
                <div className="data-table-header database-backup-table-grid">
                  <span>Schedule</span>
                  <span>Status</span>
                  <span>S3</span>
                  <span>Started</span>
                  <span>Database</span>
                  <span />
                </div>
                {data.executions.rows.map((x) => (
                  <div key={x.uuid} className="data-table-row database-backup-table-grid text-[13px] text-neutral-700 dark:text-fg-dim">
                    <span className="truncate font-medium text-neutral-950 dark:text-fg">{x.schedule}</span>
                    <span>
                      <StatusBadge label={x.status.charAt(0).toUpperCase() + x.status.slice(1)} type={x.status === "success" ? "success" : x.status === "failed" ? "error" : "warning"} />
                    </span>
                    <span>{x.s3Uploaded === null ? "Local only" : x.s3Uploaded ? "Uploaded" : "Failed"}</span>
                    <span>{x.startedAt ? ago(x.startedAt) : ""}</span>
                    <span className="truncate">{x.databaseName ?? ""}</span>
                    <span />
                  </div>
                ))}
              </div>
            </div>
          )}
        </SettingsSection>
      </div>
    </DatabaseWorkspace>
  );
}

export function DatabaseBackupsPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Backups">
      <DatabaseBackupsContent />
    </Layout>
  );
}
