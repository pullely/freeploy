// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/shared/environment-variable/{all,add,show}.blade.php,
// app/Livewire/Project/Shared/EnvironmentVariable/{All,Add,Show}.php,
// resources/views/components/{environment-variable-warning,table-pagination}.blade.php,
// resources/views/components/table/{toolbar,search,filter,sort}.blade.php and
// resources/views/components/forms/checkbox.blade.php (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/environment-variables
// (project.application.environment-variables): the Environment Variables page
// inside the application's configuration frame — the switches, the table of
// production and preview variables with its search, filters, sort and paging,
// the add and edit dialogs, and the developer view. The same component is a
// database's Environment Variables page (EnvironmentVariablesContent with kind
// "database"): no preview variables, no order or build secrets switches (an
// application's only), and Redis's REDIS_PASSWORD and REDIS_USERNAME shown as
// its credentials (a fixed name, a required value, no flags).
// Not here: the variables a Compose file hard-codes and "Used by Compose"
// (no Compose application can be created yet), the secret manager links, and
// the loading skeleton.
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Callout, Empty, FormInput, FormTextarea, Helper, Listbox, Loading, ModalConfirmation, ModalInput, SettingsSection, UnsavedBar } from "../components/Coolify";
import { ClientPagination, SortHeader, TableDropdown, type ListState } from "../components/CoolifyList";
import { EnvVarInput } from "../components/EnvVarInput";
import {
  activeFilterText,
  buildWarning,
  ENVIRONMENT_FILTERS,
  FILTER_LABELS,
  pageOf,
  TABLE_SORTS,
  toggleVariableFilter,
  VARIABLE_FILTERS,
  visibleVariables,
  type AvailableSharedVariables,
  type EnvironmentFilter,
  type EnvironmentVariableRow,
  type TableSort,
  type VariableFilter,
} from "../lib/environment-variables";
import { environmentPath, environmentUuidFromPath, limit, projectUuidFromPath } from "./ProjectChrome";
import { resourceApi, resourceFrame, resourceUuidFromPath, type ResourceKind, type ResourceSectionData } from "./ApplicationSection";
import { ResourceWorkspace } from "./ResourceWorkspace";

interface Settings {
  isEnvSortingEnabled: boolean;
  useBuildSecrets: boolean;
  includeCoolifyDefaultVariables: boolean;
  redactAllEnvValuesInLogs: boolean;
}

interface PageData {
  resource: { type: string; uuid: string; name: string; buildPack: string | null };
  showPreview: boolean;
  settings: Settings;
  variables: EnvironmentVariableRow[];
  availableSharedVariables: AvailableSharedVariables;
  canManage: boolean;
  canViewValues: boolean;
}

interface Values {
  value: string | null;
  realValue: string | null;
  isShared: boolean;
  isReallyRequired: boolean;
  isValueHidden: boolean;
  copyValue: string | null;
}

interface DevView {
  showPreview: boolean;
  variables: string;
  variablesPreview: string | null;
}

/** What the dialogs need of the page. */
interface Context {
  api: string;
  /** All's resource type: 'application', or a database's type() ('standalone-redis', …). */
  resourceType: string;
  canManage: boolean;
  canViewValues: boolean;
  availableVars: AvailableSharedVariables;
  scopeUrls: Record<string, string>;
  reload: () => Promise<void>;
}

const HIDDEN = { display: "none" as const };
const BOOLEAN = (no: string, yes: string, yesFirst = false) => (yesFirst ? [{ value: "true", label: yes }, { value: "false", label: no }] : [{ value: "false", label: no }, { value: "true", label: yes }]);
const VALUE_TYPE = BOOLEAN("Single line", "Multiline");
const INTERPOLATION = BOOLEAN("Interpolate $VARIABLES", "Literal (keep $ characters as-is)");
const BUILD_TIME = BOOLEAN("Not available during build", "Available during build", true);
const RUNTIME = BOOLEAN("Not available in the container", "Available in the container", true);
const LITERAL_HELPER =
  "Literal means $VARIABLES in the value is kept as the actual characters '$VARIABLES' instead of being resolved from another variable. Useful when your value contains a $ sign.";
const BUILD_TIME_HELPER = "Make this variable available during the Docker build process. Useful for build secrets and dependencies.";
const RUNTIME_HELPER = "Make this variable available in the running container at runtime.";
const COMMENT_HELPER = "Add a note to document what this environment variable is used for.";

/** Show::mount(): Redis's two credentials, which General manages ($is_redis_credential). */
const isRedisCredential = (ctx: Context, row: EnvironmentVariableRow): boolean => ctx.resourceType === "standalone-redis" && (row.key === "REDIS_PASSWORD" || row.key === "REDIS_USERNAME");

/** <x-highlighted text="*" />: a required field's mark. */
const RequiredMark = ({ on }: { on: boolean }) => (on ? <span className="text-helper">*</span> : null);

/** The first message of each field, as the form shows them under the fields. */
function inlineErrors(fields: Record<string, string[]> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(fields ?? {}).flatMap(([field, messages]) => (messages[0] ? [[field, messages[0]]] : [])));
}

/** <x-forms.checkbox instantSave>: a labelled switch that saves on click. */
function Checkbox({ id, label, helper, checked, disabled, onChange }: { id: string; label: string; helper?: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className={`form-control group flex min-h-9 max-w-full items-center rounded-lg px-2.5 py-1.5 transition-colors ${disabled ? "opacity-55" : "cursor-pointer hover:bg-neutral-100/80 dark:hover:bg-white/[0.035]"}`}>
      <label htmlFor={id} className={`label flex w-full max-w-full min-w-0 items-center gap-3 px-0 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
        <span className="flex min-w-0 grow items-center gap-1.5 break-words text-[12px] text-neutral-600 dark:text-fg-dim">
          {label}
          {helper ? <Helper helper={helper} /> : null}
        </span>
        <span className="relative flex size-[18px] shrink-0">
          <input
            type="checkbox"
            disabled={disabled}
            className="peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer appearance-none opacity-0 disabled:cursor-not-allowed"
            id={id}
            checked={checked}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span className="pointer-events-none absolute inset-0 rounded-[5px] border border-neutral-300 bg-white shadow-[inset_0_1px_1px_rgb(0_0_0/0.04)] transition-[color,background-color,border-color,box-shadow] duration-150 ease-out group-hover:border-neutral-400 peer-checked:border-coollabs peer-checked:bg-coollabs peer-focus-visible:ring-2 peer-focus-visible:ring-coollabs/25 peer-focus-visible:ring-offset-2 peer-disabled:opacity-50 dark:border-white/[0.14] dark:bg-white/[0.045] dark:shadow-none dark:group-hover:border-white/[0.22] dark:peer-checked:border-brand dark:peer-checked:bg-brand dark:peer-focus-visible:ring-brand-light/30 dark:peer-focus-visible:ring-offset-base" />
          <svg className="pointer-events-none absolute inset-0 m-auto size-3 scale-75 text-white opacity-0 transition-[opacity,transform] peer-checked:scale-100 peer-checked:opacity-100" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="m2.25 6.15 2.35 2.3 5.15-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </label>
    </div>
  );
}

/** <x-environment-variable-warning>: the caution under a build-time variable with a problematic value. */
function BuildWarning({ name, value, isBuildtime }: { name: string; value: string | null; isBuildtime: boolean }) {
  const warning = buildWarning(name, value, isBuildtime);
  if (!warning) return null;
  return (
    <Callout type="warning" title="Caution">
      <div className="text-sm">{warning.issue}</div>
      <div className="text-sm">{warning.recommendation}</div>
    </Callout>
  );
}

/** "Tip: Type {{ to reference a shared environment variable". */
function SharedVariableTip() {
  return (
    <div className="mt-1.5 text-xs text-neutral-500 dark:text-fg-faint">
      Tip: Type <span className="font-mono text-coollabs dark:text-brand-light">{"{{"}</span> to reference a shared environment variable
    </div>
  );
}

/** The four listboxes of a variable's flags (add.blade.php and show.blade.php share them). */
function FlagFields(props: {
  multiline: boolean;
  literal: boolean;
  buildtime: boolean;
  runtime: boolean;
  disabled?: boolean;
  errors: Record<string, string>;
  onChange: (flag: "isMultiline" | "isLiteral" | "isBuildtime" | "isRuntime", value: boolean) => void;
}) {
  const disabled = props.disabled ?? false;
  return (
    <div className="grid gap-4 border-t border-neutral-200 pt-4 dark:border-white/[0.07] sm:grid-cols-2">
      <Listbox id="is_multiline" label="Value type" options={VALUE_TYPE} value={String(props.multiline)} onChange={(v) => props.onChange("isMultiline", v === "true")} disabled={disabled} error={props.errors.is_multiline} />
      <Listbox id="is_literal" label="Interpolation" options={INTERPOLATION} helper={LITERAL_HELPER} value={String(props.literal)} onChange={(v) => props.onChange("isLiteral", v === "true")} disabled={disabled} error={props.errors.is_literal} />
      <Listbox id="is_buildtime" label="Build time" options={BUILD_TIME} helper={BUILD_TIME_HELPER} value={String(props.buildtime)} onChange={(v) => props.onChange("isBuildtime", v === "true")} disabled={disabled} error={props.errors.is_buildtime} />
      <Listbox id="is_runtime" label="Runtime" options={RUNTIME} helper={RUNTIME_HELPER} value={String(props.runtime)} onChange={(v) => props.onChange("isRuntime", v === "true")} disabled={disabled} error={props.errors.is_runtime} />
    </div>
  );
}

const NEW_VARIABLE = { key: "", value: "", comment: "", isMultiline: false, isLiteral: false, isBuildtime: true, isRuntime: true };

/** add.blade.php: the "New Environment Variable" form. */
function AddForm({ ctx, onDone }: { ctx: Context; onDone: () => void }) {
  const [form, setForm] = useState(NEW_VARIABLE);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    const r = await postJson<{ uuid: string; message: string }>(ctx.api, {
      key: form.key,
      value: form.value,
      comment: form.comment === "" ? null : form.comment,
      is_multiline: form.isMultiline,
      is_literal: form.isLiteral,
      is_runtime: form.isRuntime,
      is_buildtime: form.isBuildtime,
    });
    setSaving(false);
    if (!r.ok) {
      const inline = inlineErrors(r.error.fields);
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    notify.success(r.data.message);
    onDone();
    await ctx.reload();
  }

  return (
    <form className="flex w-full flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormInput placeholder="NODE_ENV" id="key" label="Name" required value={form.key} onChange={(key) => setForm({ ...form, key })} error={errors.key} />
        <FormInput id="comment" label="Comment" placeholder="Optional note" helper={COMMENT_HELPER} value={form.comment} onChange={(comment) => setForm({ ...form, comment: comment.slice(0, 256) })} error={errors.comment} />
      </div>
      <div>
        {form.isMultiline ? (
          <div>
            <FormTextarea id="value" label="Value" required monospace={false} value={form.value} onChange={(value) => setForm({ ...form, value })} error={errors.value} />
          </div>
        ) : (
          <div>
            <EnvVarInput placeholder="production" id="value" label="Value" required value={form.value} onChange={(value) => setForm({ ...form, value })} error={errors.value} availableVars={ctx.availableVars} scopeUrls={ctx.scopeUrls} />
          </div>
        )}
        {form.isMultiline ? null : <SharedVariableTip />}
      </div>

      <FlagFields multiline={form.isMultiline} literal={form.isLiteral} buildtime={form.isBuildtime} runtime={form.isRuntime} errors={errors} onChange={(flag, value) => setForm({ ...form, [flag]: value })} />

      <BuildWarning name={form.key} value={form.value} isBuildtime={form.isBuildtime} />

      <div className="flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.07]">
        <Button type="submit" disabled={saving}>
          Add variable
        </Button>
      </div>
    </form>
  );
}

const CHECK = (
  <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="size-4">
    <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
  </svg>
);

/** A flag cell of the table: a check or a dash. */
function Flag({ on, className = "" }: { on: boolean; className?: string }) {
  return on ? <span className={`${className} data-table-cell-check`.trim()}>{CHECK}</span> : <span className={`${className} data-table-cell-dash`.trim()}>-</span>;
}

/** <x-copy-button resolve="$wire.copyValue()">: asks for the value when clicked, then copies it. */
function CopyValueButton({ api }: { api: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const r = await getJson<Values>(api);
    const value = r.data?.copyValue;
    if (value === null || value === undefined) return;
    await navigator.clipboard?.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }
  return (
    <button type="button" title="Copy value" aria-label="Copy value" className="icon-button group shrink-0" onClick={() => void copy()}>
      <span className="inline-flex transition-transform duration-150 ease-out group-active:scale-75">
        <Reicon name="copy" className="size-3.5" {...(copied ? { style: HIDDEN } : {})} />
        <Reicon name="check" className="size-3.5 text-success" {...(copied ? {} : { style: HIDDEN })} />
      </span>
    </button>
  );
}

interface EditForm {
  key: string;
  comment: string;
  value: string;
  newLockedValue: string;
  isMultiline: boolean;
  isLiteral: boolean;
  isBuildtime: boolean;
  isRuntime: boolean;
}

/** show.blade.php's dialog: the value is asked for when the dialog opens (Show::loadValues). */
function EditDialog({ ctx, row, onClose }: { ctx: Context; row: EnvironmentVariableRow; onClose: () => void }) {
  const api = `${ctx.api}/${encodeURIComponent(row.uuid)}`;
  const initial = useMemo<EditForm>(
    () => ({ key: row.key, comment: row.comment ?? "", value: "", newLockedValue: "", isMultiline: row.isMultiline, isLiteral: row.isLiteral, isBuildtime: row.isBuildtime, isRuntime: row.isRuntime }),
    [row],
  );
  const [form, setForm] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [values, setValues] = useState<Values | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      const r = await getJson<Values>(api);
      if (!r.data) return;
      setValues(r.data);
      setForm((f) => ({ ...f, value: r.data!.value ?? "" }));
      setSaved((f) => ({ ...f, value: r.data!.value ?? "" }));
    })();
  }, [api]);

  const canUpdate = ctx.canManage;
  const credential = isRedisCredential(ctx, row);
  const isLocked = row.isShownOnce;
  const isDisabled = row.isMagic;
  const isValueHidden = !ctx.canViewValues;
  const canEditValue = canUpdate && !isLocked && !isDisabled && !isValueHidden;
  const valuesLoaded = values !== null;
  const dirty = (Object.keys(form) as Array<keyof EditForm>).some((field) => form[field] !== saved[field]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body: Record<string, unknown> = {
      key: form.key,
      comment: form.comment === "" ? null : form.comment,
      is_multiline: form.isMultiline,
      is_literal: form.isLiteral,
      is_runtime: form.isRuntime,
      is_buildtime: form.isBuildtime,
    };
    // The form holds the value only once it is loaded, and never a locked one.
    if (isLocked) body.newLockedValue = form.newLockedValue;
    else if (canEditValue && valuesLoaded) body.value = form.value;
    setSaving(true);
    const r = await postJson<{ message: string }>(api, body, "PATCH");
    setSaving(false);
    if (!r.ok) {
      const inline = inlineErrors(r.error.fields);
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    notify.success(r.data.message);
    onClose();
    await ctx.reload();
  }

  async function lock() {
    const r = await postJson<{ locked: boolean }>(`${api}/lock`, {});
    if (!r.ok) return notify.error(summarize(r.error.messages));
    onClose();
    await ctx.reload();
  }

  async function remove() {
    const r = await postJson<{ message: string }>(api, {}, "DELETE");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    notify.success(r.data.message);
    onClose();
    await ctx.reload();
  }

  let valueField: ReactNode;
  if (isValueHidden) {
    valueField = (
      <div className="w-full">
        <label className="mb-1 flex items-center gap-1 text-sm font-medium">Value</label>
        <input disabled type="text" value="Hidden (only admins can view)" readOnly className="input w-full italic !text-neutral-500 dark:!text-neutral-500" />
      </div>
    );
  } else if (isLocked) {
    valueField = (
      <FormInput
        id="newLockedValue"
        type="password"
        label="Value"
        placeholder="Hidden after locking. Enter a new value to replace it."
        helper="The locked value cannot be shown. Leave this empty to keep it."
        disabled={!canUpdate || isDisabled}
        value={form.newLockedValue}
        onChange={(newLockedValue) => setForm({ ...form, newLockedValue })}
        error={errors.newLockedValue}
      />
    );
  } else if (form.isMultiline) {
    valueField = (
      <div className="w-full">
        <label className="mb-1 flex items-center gap-1 text-sm font-medium">
          Value
          <RequiredMark on={credential} />
        </label>
        {valuesLoaded ? (
          <FormTextarea id="value" monospace={false} disabled={!canEditValue} value={form.value} onChange={(value) => setForm({ ...form, value })} error={errors.value} />
        ) : (
          <div className="input flex min-h-24 w-full items-start py-2 text-neutral-500 dark:text-fg-dim" aria-busy="true">
            <Loading text="Loading value..." />
          </div>
        )}
      </div>
    );
  } else {
    valueField = (
      <div className="w-full">
        <label className="mb-1 flex items-center gap-1 text-sm font-medium">
          Value
          <RequiredMark on={credential} />
        </label>
        <div className="relative">
          {valuesLoaded ? (
            <EnvVarInput id="value" type="password" disabled={!canEditValue} value={form.value} onChange={(value) => setForm({ ...form, value })} error={errors.value} availableVars={ctx.availableVars} scopeUrls={ctx.scopeUrls} />
          ) : (
            <div className="input input-with-password-toggle flex w-full items-center text-neutral-500 dark:text-fg-dim" aria-busy="true">
              <Loading text="Loading value..." />
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex w-full flex-col gap-4">
      <div className="grid items-end gap-4 sm:grid-cols-2">
        <FormInput id="key" label="Name" required={credential} disabled={!canEditValue || credential} value={form.key} onChange={(key) => setForm({ ...form, key })} error={errors.key} />
        <FormInput id="comment" label="Comment" placeholder="Optional note" helper={COMMENT_HELPER} disabled={!canUpdate} value={form.comment} onChange={(comment) => setForm({ ...form, comment: comment.slice(0, 256) })} error={errors.comment} />
      </div>

      <div>
        {valueField}
        {!isValueHidden && !isLocked && !form.isMultiline ? <SharedVariableTip /> : null}
      </div>

      {values?.isShared ? <FormInput disabled type="password" id="real_value" label="Resolved value" value={values.realValue ?? ""} /> : null}

      {/* $showValueType, $showInterpolation, $showBuildtime and $showRuntime: none for a magic variable or a Redis credential. */}
      {row.isMagic || credential ? null : (
        <FlagFields multiline={form.isMultiline} literal={form.isLiteral} buildtime={form.isBuildtime} runtime={form.isRuntime} disabled={!canUpdate} errors={errors} onChange={(flag, value) => setForm({ ...form, [flag]: value })} />
      )}

      <BuildWarning name={form.key} value={valuesLoaded && !isLocked && !isValueHidden ? form.value : null} isBuildtime={form.isBuildtime} />

      {canUpdate ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 pt-4 dark:border-white/[0.07]">
          <div data-environment-variable-delete-action>
            {row.isMagic ? null : (
              <ModalConfirmation
                title="Confirm Environment Variable Deletion?"
                buttonTitle="Delete"
                actions={["The selected environment variable will be permanently deleted."]}
                confirmationText={row.key}
                confirmationLabel="Please confirm the execution of the actions by entering the Environment Variable Name below"
                shortConfirmationLabel="Environment Variable Name"
                step2ButtonText="Permanently Delete"
                onSubmit={remove}
              />
            )}
          </div>
          <div className="ml-auto flex flex-wrap gap-2" data-environment-variable-update-actions>
            {!isLocked && !row.isMagic ? (
              <div>
                <ModalConfirmation
                  title="Lock Environment Variable?"
                  trigger={
                    <button className="button flex gap-2" type="button">
                      Lock
                    </button>
                  }
                  actions={["The value will be hidden. You cannot see or copy it again.", "You can still replace the value with a new one, but you cannot unlock the variable."]}
                  confirmationText={null}
                  step2ButtonText="Lock"
                  onSubmit={lock}
                />
              </div>
            ) : null}
            {isDisabled ? null : (
              <fieldset disabled={!dirty || saving}>
                <Button type="submit" highlighted>
                  Update variable
                </Button>
              </fieldset>
            )}
          </div>
        </div>
      ) : null}
    </form>
  );
}

/** show.blade.php: a row of the table with its copy button and its edit dialog. */
function VariableRow({ ctx, row }: { ctx: Context; row: EnvironmentVariableRow }) {
  const [open, setOpen] = useState(false);
  const credential = isRedisCredential(ctx, row);
  return (
    <div className="env-table-item" data-env-key={row.key}>
      <div className="data-table-row env-table-grid env-table-grid-no-type">
        <div className="flex min-w-0 items-center gap-2">
          {row.isShownOnce ? (
            <svg className="size-3.5 shrink-0 text-neutral-400 dark:text-fg-faint" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
                <path d="M5 13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6z" />
                <path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0-2 0m-3-5V7a4 4 0 1 1 8 0v4" />
              </g>
            </svg>
          ) : null}
          <button type="button" data-env-name-trigger className="env-key-label min-w-0 truncate text-left font-mono text-[13px] text-black dark:text-fg" title={row.key} onClick={() => setOpen(true)}>
            {row.key}
          </button>
          {row.comment ? <Helper helper={row.comment} /> : null}
          {/* Without the value: the badge shows for every required variable (Show::syncData). */}
          {row.isRequired ? <span className="table-badge table-badge-danger shrink-0">Required</span> : null}
        </div>
        <Flag on={row.isMagic} className="env-managed-desktop" />
        <Flag on={row.isLiteral} />
        <Flag on={row.isMultiline} />
        <Flag on={row.isBuildtime && !credential} />
        <Flag on={row.isRuntime && !credential} />
        <div className="flex items-center justify-end gap-0.5 justify-self-end">
          {!row.isShownOnce && ctx.canViewValues ? <CopyValueButton api={`${ctx.api}/${encodeURIComponent(row.uuid)}`} /> : null}
          <ModalInput
            title="Edit environment variable"
            open={open}
            onOpenChange={setOpen}
            trigger={
              <button type="button" data-env-settings-trigger className="icon-button shrink-0" title="Edit environment variable" aria-label="Edit environment variable">
                <Reicon name="settings" className="size-3.5" />
              </button>
            }
          >
            <EditDialog ctx={ctx} row={row} onClose={() => setOpen(false)} />
          </ModalInput>
        </div>
      </div>
    </div>
  );
}

/** The mark of a chosen option in the filter menu. */
function FilterMark({ selected }: { selected: boolean }) {
  return (
    <span
      className={`flex size-4 shrink-0 items-center justify-center rounded-[5px] border ${
        selected ? "border-coollabs bg-coollabs text-white dark:border-brand dark:bg-brand dark:text-white" : "border-neutral-300 bg-white dark:border-white/[0.14] dark:bg-white/[0.045]"
      }`}
    >
      {selected ? (
        <svg className="size-3" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="m2.25 6.15 2.35 2.3 5.15-5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
    </span>
  );
}

function storedPageSize(key: string): number {
  try {
    const saved = Number(localStorage.getItem(key));
    return saved >= 1 && saved <= 100 ? saved : 10;
  } catch {
    return 10;
  }
}

const PAGE_SIZE_KEY = "freeploy.page-size.environment-variables";

/** The developer view: both sets as text, saved together (All::submit). */
function DeveloperView({ api, canManage, onSaved }: { api: string; canManage: boolean; onSaved: () => Promise<void> }) {
  const [view, setView] = useState<DevView | null>(null);
  const [text, setText] = useState({ variables: "", variablesPreview: "" });
  const [saving, setSaving] = useState(false);

  const show = useCallback((v: DevView) => {
    setView(v);
    setText({ variables: v.variables, variablesPreview: v.variablesPreview ?? "" });
  }, []);
  useEffect(() => {
    void (async () => {
      const r = await getJson<DevView>(`${api}/dev`);
      if (r.data) show(r.data);
    })();
  }, [api, show]);

  const submit = useCallback(async () => {
    setSaving(true);
    const r = await postJson<DevView & { message: string | null }>(`${api}/dev`, text, "PUT");
    setSaving(false);
    // An invalid "# coolify:" line changes nothing and keeps the edited text.
    if (!r.ok) return notify.error(summarize(r.error.messages));
    show(r.data);
    if (r.data.message) notify.success(r.data.message);
    await onSaved();
  }, [api, text, show, onSaved]);

  if (!view) return null;
  const dirty = text.variables !== view.variables || (view.showPreview && text.variablesPreview !== (view.variablesPreview ?? ""));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex w-full flex-col gap-4"
    >
      {canManage ? (
        <Callout type="info" title="Note">
          Inline comments with space before # (e.g., <code className="font-mono">KEY=value #comment</code>) are stripped. To set flags, put{" "}
          <code className="font-mono"># coolify: literal buildtime=false runtime=false</code> directly above a variable line. Without this line, the flags of a variable do not change.
        </Callout>
      ) : null}
      <FormTextarea rows={10} monospace={false} id="variables" label="Production" disabled={!canManage} value={text.variables} onChange={(variables) => setText({ ...text, variables })} />
      {view.showPreview ? (
        <FormTextarea rows={10} monospace={false} id="variablesPreview" label="Preview deployments" disabled={!canManage} value={text.variablesPreview} onChange={(variablesPreview) => setText({ ...text, variablesPreview })} />
      ) : null}
      {canManage ? <UnsavedBar dirty={dirty} saving={saving} onSave={() => void submit()} /> : null}
    </form>
  );
}

/** <livewire:project.shared.environment-variable.all :resource>: an application's or a database's variables. */
export function EnvironmentVariablesContent({ kind }: { kind: ResourceKind }) {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const uuid = resourceUuidFromPath(kind);
  const resourceBase = resourceApi(kind, me.team?.id, uuid);
  const api = `${resourceBase}/environment-variables`;
  const [app, setApp] = useState<ResourceSectionData | null>(null);
  const [data, setData] = useState<PageData | null>(null);
  const [view, setView] = useState<"normal" | "dev">("normal");
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<VariableFilter[]>([]);
  const [environment, setEnvironment] = useState<EnvironmentFilter>("all");
  const [sort, setSort] = useState<TableSort>("default");
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(() => storedPageSize(PAGE_SIZE_KEY));

  const reload = useCallback(async () => {
    const r = await getJson<PageData>(api);
    if (r.data) setData(r.data);
  }, [api]);

  useEffect(() => {
    void (async () => {
      // A service's frame is its configuration page's (DP-66).
      const r = await getJson<ResourceSectionData>(kind === "service" ? `${resourceBase}/configuration` : resourceBase);
      // Configuration::mount(): the resource through its project and environment, or a 404.
      if (!r.data) {
        if (r.status === 404) window.location.replace(environmentPath(projectUuid, environmentUuid));
        return;
      }
      const frame = resourceFrame(r.data);
      if (frame.project.uuid !== projectUuid || frame.environment.uuid !== environmentUuid) return window.location.replace("/projects");
      setApp(r.data);
      await reload();
    })();
  }, [resourceBase, projectUuid, environmentUuid, reload]);
  useEffect(() => {
    if (app) document.title = `${limit(resourceFrame(app).name, 10)} > Configuration | Freeploy`;
  }, [app]);

  const visible = useMemo(() => visibleVariables(data?.variables ?? [], { search, filters, environment, sort }), [data, search, filters, environment, sort]);

  if (!app) return null;
  const resource = resourceFrame(app);
  const canManage = data?.canManage ?? false;

  /** All::instantSave(), saveCoolifyDefaultVariables() and saveLogRedactionSetting(). */
  async function saveSetting(field: string, value: boolean) {
    const r = await postJson<{ message: string; settings: Settings }>(`${api}/settings`, { [field]: value }, "PATCH");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    notify.success(r.data.message);
    setPage(1);
    await reload();
  }

  const ctx: Context = {
    api,
    resourceType: data?.resource.type ?? kind,
    canManage,
    canViewValues: data?.canViewValues ?? false,
    availableVars: data?.availableSharedVariables ?? { team: [], project: [], environment: [], server: [] },
    scopeUrls: {
      team: "/shared-variables/team",
      project: "/shared-variables/projects",
      environment: `/shared-variables/environments/project/${projectUuid}/environment/${environmentUuid}`,
      server: resource.server ? `/shared-variables/server/${resource.server.uuid}` : "/shared-variables/servers",
      default: "/shared-variables",
    },
    reload,
  };

  const paging = pageOf(visible, page, perPage);
  const activeCount = filters.length + (environment !== "all" ? 1 : 0);
  const activeText = activeFilterText(filters, environment);
  const resetPage = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setPage(1);
  };
  // <x-table.sort-header> and <x-table-pagination> read the list's state from this.
  const list: ListState<EnvironmentVariableRow> = {
    search,
    setSearch: resetPage(setSearch),
    sortBy: sort,
    setSortBy: (value) => resetPage(setSort)(value as TableSort),
    viewMode: "table",
    setViewMode: () => undefined,
    page: paging.page,
    setPage,
    pageSize: perPage,
    setPageSize: (size) => {
      setPerPage(size);
      setPage(1);
      try {
        localStorage.setItem(PAGE_SIZE_KEY, String(size));
      } catch {
        /* storage blocked: the choice lasts this page only */
      }
    },
    pageSizeKey: PAGE_SIZE_KEY,
    filtered: visible,
    paginated: paging.rows,
    totalPages: paging.lastPage,
    rangeStart: paging.from,
    rangeEnd: paging.to,
  };

  const settings = data?.settings;
  const groupByScope = data?.showPreview ?? false;
  let renderedScope: string | null = null;
  const rows: ReactNode[] = [];
  for (const row of paging.rows) {
    if (groupByScope && row.scope !== renderedScope) {
      renderedScope = row.scope;
      rows.push(
        <div
          key={`scope-${row.scope}`}
          className="flex items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-[12px] font-semibold text-neutral-700 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-fg"
        >
          {row.scope === "preview" ? "Preview deployments" : "Production"}
        </div>,
      );
    }
    rows.push(<VariableRow key={row.uuid} ctx={ctx} row={row} />);
  }

  return (
    <ResourceWorkspace data={app} orgId={me.team?.id} active="Environment Variables">
      <div className="flex flex-col gap-4">
        <SettingsSection
          id="environment-variables-section"
          title="Environment variables"
          helper="Environment variables (secrets) for this resource."
          actions={canManage ? <Button onClick={() => setView(view === "normal" ? "dev" : "normal")}>{view === "normal" ? "Developer view" : "Normal view"}</Button> : undefined}
        >
          {view === "dev" ? (
            <DeveloperView api={api} canManage={canManage} onSaved={reload} />
          ) : settings ? (
            <div className="flex w-full flex-col gap-4">
              {/* @if ($resourceClass === 'App\Models\Application'): the order and build secrets switches. */}
              {data.resource.type === "application" ? (
                <div className="grid w-full items-end gap-4 sm:grid-cols-2">
                  {data.resource.buildPack !== "dockercompose" ? (
                    <Listbox
                      id="is_env_sorting_enabled"
                      label="Environment variable order"
                      helper="Controls how environment variables are ordered in the list and written to the generated .env file on deploy."
                      options={BOOLEAN("Creation order", "Alphabetical")}
                      value={String(settings.isEnvSortingEnabled)}
                      onChange={(v) => void saveSetting("is_env_sorting_enabled", v === "true")}
                      disabled={!canManage}
                    />
                  ) : null}
                  <Listbox
                    id="use_build_secrets"
                    label="Build secrets"
                    helper="Docker BuildKit secrets keep values out of the final image for enhanced security during builds. Requires Docker 18.09+ with BuildKit support."
                    options={BOOLEAN("Standard build arguments", "Docker BuildKit secrets")}
                    value={String(settings.useBuildSecrets)}
                    onChange={(v) => void saveSetting("use_build_secrets", v === "true")}
                    disabled={!canManage}
                  />
                </div>
              ) : null}
              <Checkbox
                id="include_coolify_default_variables"
                label="Include Freeploy default variables"
                helper="Adds COOLIFY_APP_NAME, COOLIFY_PROJECT_NAME, COOLIFY_ENVIRONMENT_NAME and COOLIFY_SERVER_IP to the container at runtime. A variable that you define with the same name wins. Takes effect after the next deploy or restart."
                checked={settings.includeCoolifyDefaultVariables}
                onChange={(checked) => void saveSetting("include_coolify_default_variables", checked)}
                disabled={!canManage}
              />
              <div className="grid w-full items-end gap-4 sm:grid-cols-2">
                <Listbox
                  id="redact_all_env_values_in_logs"
                  label="Environment values in logs"
                  helper="Hide every environment variable value in deployment logs, scheduled task output, copied or downloaded logs, and logs from the API and MCP. Live log streaming is not changed. Locked variables and known secret formats are always hidden."
                  options={BOOLEAN("Hide locked values only", "Hide all values", true)}
                  value={String(settings.redactAllEnvValuesInLogs)}
                  onChange={(v) => void saveSetting("redact_all_env_values_in_logs", v === "true")}
                  disabled={!canManage}
                />
              </div>
            </div>
          ) : null}
        </SettingsSection>

        {view === "normal" ? (
          <div className="table-toolbar flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center mt-2" aria-busy={data ? "false" : "true"}>
            <div className="min-w-0 w-full flex-1 sm:max-w-md">
              <div className="table-search relative min-w-0 w-full">
                <input
                  type="search"
                  placeholder="Search environment variables"
                  aria-label="Search environment variables"
                  className="input w-full pl-8!"
                  disabled={!data}
                  value={search}
                  onChange={(e) => list.setSearch(e.target.value)}
                />
                <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-2.5">
                  <Reicon name="search" className="size-3.5 text-neutral-400 dark:text-fg-faint" />
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
              <div className="table-filter">
                <TableDropdown
                  panelClass="w-44! overflow-hidden! p-0!"
                  trigger={(open) => (
                    <button type="button" aria-haspopup="listbox" aria-expanded={open} title={activeText || undefined} className={`button max-w-80 min-w-0${activeCount > 0 ? " button-highlighted" : ""}`}>
                      <Reicon name="filter" className="size-3.5 shrink-0" />
                      <span className="truncate">{activeText || "Filter"}</span>
                      {activeCount > 0 ? (
                        <span className="shrink-0 rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500 dark:bg-white/[0.07] dark:text-fg-dim">{activeCount}</span>
                      ) : null}
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <div className="max-h-80 overflow-y-auto p-1">
                        {VARIABLE_FILTERS.map((filter) => (
                          <button key={filter} type="button" className="listbox-option" onClick={() => resetPage(setFilters)(toggleVariableFilter(filters, filter))}>
                            <span>{FILTER_LABELS[filter]}</span>
                            <FilterMark selected={filters.includes(filter)} />
                          </button>
                        ))}
                        {data?.showPreview ? (
                          <>
                            <div className="my-1 border-t border-neutral-200 dark:border-white/10" />
                            {ENVIRONMENT_FILTERS.map(([value, label]) => (
                              <button
                                key={value}
                                type="button"
                                className="listbox-option"
                                onClick={() => {
                                  resetPage(setEnvironment)(value);
                                  close();
                                }}
                              >
                                <span>{label}</span>
                                <FilterMark selected={environment === value} />
                              </button>
                            ))}
                          </>
                        ) : null}
                      </div>
                      <div className="border-t border-neutral-200 bg-white p-1 dark:border-white/10 dark:bg-raised">
                        <button
                          type="button"
                          className="listbox-option text-neutral-500 dark:text-fg-dim"
                          disabled={activeCount === 0}
                          onClick={() => {
                            setFilters([]);
                            setEnvironment("all");
                            setPage(1);
                            close();
                          }}
                        >
                          <span>Reset filters</span>
                          <Reicon name="x" className="size-3.5" />
                        </button>
                      </div>
                    </>
                  )}
                </TableDropdown>
              </div>
              {/* The table header, with its Name sort, is hidden on small screens (app.css, max-width: 768px). */}
              <div className="min-[769px]:hidden">
                <div className="table-sort">
                  <TableDropdown
                    panelClass="w-44!"
                    trigger={(open) => (
                      <button type="button" className="button" aria-haspopup="listbox" aria-expanded={open}>
                        <Reicon name="sort-direction" className="size-3.5" />
                        Sort
                      </button>
                    )}
                  >
                    {(close) =>
                      TABLE_SORTS.map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className="listbox-option"
                          onClick={() => {
                            resetPage(setSort)(value);
                            close();
                          }}
                        >
                          <span>{label}</span>
                          {sort === value ? <span>✓</span> : null}
                        </button>
                      ))
                    }
                  </TableDropdown>
                </div>
              </div>
              {canManage ? (
                <ModalInput
                  title="New Environment Variable"
                  open={adding}
                  onOpenChange={setAdding}
                  trigger={
                    <button type="button" className="button button-highlighted">
                      <Reicon name="plus" className="size-3.5" />
                      Add
                    </button>
                  }
                >
                  <AddForm ctx={ctx} onDone={() => setAdding(false)} />
                </ModalInput>
              ) : null}
            </div>
          </div>
        ) : null}

        {view !== "normal" ? null : !data ? (
          <div id="environment-table-section" className="application-settings-section-body is-flush mt-1 w-full scroll-mt-28" role="status">
            <span className="sr-only">Loading environment variables</span>
          </div>
        ) : (
          <div id="environment-table-section" className={`application-settings-section-body relative mt-1 scroll-mt-28 ${visible.length > 0 ? "is-flush" : ""} w-full`}>
            {search.trim() !== "" && visible.length === 0 ? (
              <Empty size="sm" title="No environment variables found" description="No variables match your search." />
            ) : visible.length > 0 ? (
              <div className="data-table w-full">
                <div className="environment-table-scroll relative">
                  <div className="transition-all">
                    <div className="data-table-header env-table-grid env-table-grid-no-type">
                      <SortHeader list={list} label="Name" asc="name_asc" desc="name_desc" />
                      <span className="text-center">Managed</span>
                      <span className="text-center">Literal</span>
                      <span className="text-center">Multiline</span>
                      <span className="text-center">Buildtime</span>
                      <span className="text-center">Runtime</span>
                      <span className="text-right">Actions</span>
                    </div>
                    {rows}
                  </div>
                </div>
                <ClientPagination list={list} options={[10, 25, 50, 100]} />
              </div>
            ) : (
              <div className="relative min-h-40">
                <div>
                  <Empty size="sm" title="No environment variables" description="Add your first variable with the + Add button above." iconName="variables" />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </ResourceWorkspace>
  );
}

export function ApplicationEnvironmentVariablesPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <EnvironmentVariablesContent kind="application" />
    </Layout>
  );
}
