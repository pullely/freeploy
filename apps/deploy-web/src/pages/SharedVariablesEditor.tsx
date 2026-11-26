// Derived from coollabsio/coolify@91b7e3e:resources/views/components/shared-variables/editor.blade.php,
// resources/views/livewire/shared-variables/{team/index,project/show,environment/show,server/show}.blade.php,
// resources/views/livewire/project/shared/environment-variable/{add,show}.blade.php (the shared
// variable paths), resources/views/components/forms/env-var-input.blade.php and
// app/Livewire/SharedVariables/{Team/Index,Project/Show,Environment/Show,Server/Show}.php
// (Apache-2.0), modified.
//
// /shared-variables/team, /shared-variables/project/{uuid},
// /shared-variables/environments/project/{uuid}/environment/{uuid} and
// /shared-variables/server/{uuid}: <x-shared-variables.editor>, one scope's
// variables. The normal view is the table with its search, sort, "Add
// variable" and each row's edit dialog (rename, value, lock, delete); the
// developer view is the KEY=value text. A value is fetched only when a dialog
// or the copy button asks for it, as Coolify decrypts it only then. The Canvas
// switch and the "Connect to resources" links open the scope's canvas (DP-98).
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Callout, Empty, FieldError, FormInput, FormTextarea, Listbox, Loading, ModalConfirmation, ModalInput, SettingsSection, UnsavedBar } from "../components/Coolify";
import { CanvasViewToggle, TableDropdown } from "../components/CoolifyList";
import { fieldErrors } from "./SecurityLayout";
import { scopeHeadline, scopePath, SEARCH_INPUT, SharedVariablesLayout, sharedVariablesApi, type SharedVariableScope } from "./SharedVariablesChrome";

const HIDDEN = { display: "none" as const };
const shown = (visible: boolean) => (visible ? undefined : HIDDEN);

interface Variable {
  id: string;
  key: string;
  comment: string | null;
  isMultiline: boolean;
  isLiteral: boolean;
  isShownOnce: boolean;
  /** A predefined server variable ("Built-in · Read-only"): the only kind whose value the list carries. */
  readOnly: boolean;
  value: string | null;
}

interface EditorData {
  scope: { type: SharedVariableScope; uuid: string | null; title: string; project: { uuid: string; name: string } | null };
  variables: Variable[];
  readOnlyKeys: string[];
  devView: string;
  canUpdate: boolean;
  canViewValues: boolean;
}

/** variablesLabel of each scope's view. */
const VARIABLES_LABEL: Record<SharedVariableScope, string> = {
  team: "Team shared variables",
  project: "Project shared variables",
  environment: "Environment shared variables",
  server: "Server shared variables",
};

const VALUE_TYPES = [
  { value: "false", label: "Single line" },
  { value: "true", label: "Multiline" },
];
const COMMENT_HELPER = "Add a note to document what this environment variable is used for.";
const VALUE_LABEL = "mb-1 flex items-center gap-1 text-sm font-medium";
const DIVIDED = "border-t border-neutral-200 pt-4 dark:border-white/[0.07]";

function Check({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none">
      <path d="M5 12l5 5 9-11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A table cell: the check of a set flag, or a dash. */
function FlagCell({ on }: { on: boolean }) {
  if (!on) return <span className="data-table-cell-dash">-</span>;
  return (
    <span className="data-table-cell-check">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="size-4">
        <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
      </svg>
    </span>
  );
}

/**
 * <x-forms.env-var-input> for a shared variable: no other variable can be
 * referenced from one ($availableVars is empty), so it is the input, the peek
 * toggle of a password, and the warning about a space at an edge.
 */
function EnvVarInput(props: { id: string; label: string; value: string; onChange: (value: string) => void; type?: "text" | "password"; placeholder?: string; required?: boolean; disabled?: boolean }) {
  const password = props.type === "password";
  const [peek, setPeek] = useState(false);
  const type = password && !peek ? "password" : "text";
  return (
    <div className="w-full">
      <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
        <label className="mb-0! flex items-center gap-1 text-sm font-medium leading-4">
          {props.label} {props.required ? <span className="text-helper">*</span> : null}
        </label>
      </div>

      <div className="relative">
        <input
          autoComplete="off"
          className={type === "text" && !props.disabled ? "input truncate" : "input"}
          required={props.required}
          disabled={props.disabled}
          type={type}
          id={props.id}
          name={props.id}
          placeholder={props.placeholder ?? ""}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
        {password ? (
          <button
            type="button"
            onClick={() => setPeek(!peek)}
            className="password-toggle flex absolute inset-y-0 right-0 z-10 items-center pr-2 cursor-pointer text-neutral-500 hover:text-black dark:text-neutral-400 dark:hover:text-white"
            aria-label="Toggle password visibility"
          >
            {peek ? <Reicon name="eye-off2" className="size-[18px]" /> : <Reicon name="eye" className="size-[18px]" />}
          </button>
        ) : null}
      </div>

      <p className="mt-1 text-xs text-warning" style={shown(/^\s|\s$/.test(props.value))}>
        The value starts or ends with a space. Freeploy keeps the space.
      </p>
    </div>
  );
}

/** add.blade.php with :shared="true": Livewire's Add component, saved by the scope's saveKey(). */
export function AddVariable({ base, onDone }: { base: string; onDone: () => void }) {
  const [key, setKey] = useState("");
  const [comment, setComment] = useState("");
  const [value, setValue] = useState("");
  const [isMultiline, setIsMultiline] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // Shared variables are not literal unless the developer view says so (Add's default).
    const r = await postJson(base, { key, value, comment, is_multiline: isMultiline, is_literal: false });
    if (!r.ok) {
      const inline = fieldErrors(r.error.fields, ["key", "comment", "value"]);
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    onDone();
  }

  return (
    <form className="flex w-full flex-col gap-4" onSubmit={(e) => void submit(e)}>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormInput placeholder="NODE_ENV" id="key" label="Name" required value={key} onChange={setKey} error={errors.key} />
        <FormInput id="comment" label="Comment" placeholder="Optional note" helper={COMMENT_HELPER} value={comment} onChange={setComment} error={errors.comment} />
      </div>
      <div>
        {isMultiline ? (
          <div>
            <FormTextarea id="value" label="Value" required monospace={false} value={value} onChange={setValue} error={errors.value} />
          </div>
        ) : (
          <div>
            <EnvVarInput placeholder="production" id="value" label="Value" required value={value} onChange={setValue} />
            <FieldError message={errors.value} />
          </div>
        )}
      </div>

      <div className={`grid gap-4 ${DIVIDED} sm:grid-cols-2`}>
        <Listbox id="is_multiline" label="Value type" options={VALUE_TYPES} value={String(isMultiline)} onChange={(v) => setIsMultiline(v === "true")} />
      </div>

      <div className={`flex justify-end ${DIVIDED}`}>
        <button type="submit" className="button">
          Add variable
        </button>
      </div>
    </form>
  );
}

/** The variable with its value (Show::loadValues); `value` stays null when it is locked or hidden. */
type LoadedVariable = Variable & { isValueHidden: boolean };

/** <x-copy-button resolve="$wire.copyValue()">: the value is fetched when the button is pressed. */
function CopyValueButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const r = await getJson<LoadedVariable>(url);
    if (r.data?.value === null || r.data?.value === undefined) return;
    await navigator.clipboard?.writeText(r.data.value);
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

/** The form of the "Edit environment variable" dialog (show.blade.php's, for a shared variable). */
function EditVariable(props: { url: string; variable: Variable; canUpdate: boolean; canViewValues: boolean; connectLink: string | null; onDone: () => void }) {
  const { url, variable, canUpdate } = props;
  const isLocked = variable.isShownOnce;
  const isValueHidden = !props.canViewValues;
  const canEditValue = canUpdate && !isLocked && !isValueHidden;
  const [key, setKey] = useState(variable.key);
  const [comment, setComment] = useState(variable.comment ?? "");
  const [value, setValue] = useState("");
  const [newLockedValue, setNewLockedValue] = useState("");
  const [isMultiline, setIsMultiline] = useState(variable.isMultiline);
  const [valuesLoaded, setValuesLoaded] = useState(isLocked || isValueHidden);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // loadValues(): the dialog opens at once; the value follows.
  useEffect(() => {
    if (isLocked || isValueHidden) return;
    void (async () => {
      const r = await getJson<LoadedVariable>(url);
      setValue(r.data?.value ?? "");
      setValuesLoaded(true);
    })();
  }, [url, isLocked, isValueHidden]);

  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setDirty(true);
    };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!valuesLoaded) return;
    const r = await postJson<{ message: string }>(url, { key, value, comment, is_multiline: isMultiline, is_literal: variable.isLiteral, is_shown_once: variable.isShownOnce, newLockedValue }, "PATCH");
    if (!r.ok) {
      const inline = fieldErrors(r.error.fields, ["key", "comment", "value", "newLockedValue"]);
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    notify.success(r.data.message);
    props.onDone();
  }

  async function lock() {
    const r = await postJson(`${url}/lock`, {});
    if (!r.ok) return notify.error(summarize(r.error.messages));
    props.onDone();
  }

  async function remove() {
    const r = await postJson<{ message: string }>(url, {}, "DELETE");
    if (!r.ok) return notify.error(summarize(r.error.messages));
    notify.success(r.data.message);
    props.onDone();
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex w-full flex-col gap-4">
      <div className="grid items-end gap-4 sm:grid-cols-2">
        <FormInput id="key" label="Name" disabled={!canEditValue} value={key} onChange={edit(setKey)} error={errors.key} />
        <FormInput id="comment" label="Comment" placeholder="Optional note" helper={COMMENT_HELPER} disabled={!canUpdate} value={comment} onChange={edit(setComment)} error={errors.comment} />
      </div>

      <div>
        {isValueHidden ? (
          <div className="w-full">
            <label className={VALUE_LABEL}>Value</label>
            <input disabled type="text" value="Hidden (only admins can view)" readOnly className="input w-full italic !text-neutral-500 dark:!text-neutral-500" />
          </div>
        ) : isLocked ? (
          <FormInput
            id="newLockedValue"
            type="password"
            label="Value"
            placeholder="Hidden after locking. Enter a new value to replace it."
            helper="The locked value cannot be shown. Leave this empty to keep it."
            disabled={!canUpdate}
            value={newLockedValue}
            onChange={edit(setNewLockedValue)}
            error={errors.newLockedValue ?? errors.value}
          />
        ) : (
          <>
            <div style={shown(isMultiline)} className="w-full">
              {valuesLoaded ? (
                <FormTextarea id="value" label="Value" monospace={false} disabled={!canEditValue} value={value} onChange={edit(setValue)} />
              ) : (
                <>
                  <label className={VALUE_LABEL}>Value</label>
                  <div className="input flex min-h-24 w-full items-start py-2 text-neutral-500 dark:text-fg-dim" aria-busy="true">
                    <Loading text="Loading value..." />
                  </div>
                </>
              )}
            </div>

            <div style={shown(!isMultiline)} className="w-full">
              {valuesLoaded ? (
                <EnvVarInput id="value" label="Value" type="password" disabled={!canEditValue} value={value} onChange={edit(setValue)} />
              ) : (
                <>
                  <label className={VALUE_LABEL}>Value</label>
                  <div className="relative">
                    <div className="input input-with-password-toggle flex w-full items-center text-neutral-500 dark:text-fg-dim" aria-busy="true">
                      <Loading text="Loading value..." />
                    </div>
                  </div>
                </>
              )}
            </div>
            <FieldError message={errors.value} />
          </>
        )}
      </div>

      <div className={`grid gap-4 ${DIVIDED} sm:grid-cols-2`}>
        <Listbox id={`is_multiline-${variable.id}`} label="Value type" options={VALUE_TYPES} value={String(isMultiline)} onChange={(v) => edit(setIsMultiline)(v === "true")} disabled={!canUpdate} />
      </div>

      {canUpdate ? (
        <div className={`flex flex-wrap items-center justify-between gap-2 ${DIVIDED}`}>
          <div data-environment-variable-delete-action>
            <ModalConfirmation
              title="Confirm Environment Variable Deletion?"
              buttonTitle="Delete"
              actions={["The selected environment variable will be permanently deleted."]}
              confirmationText={variable.key}
              confirmationLabel="Please confirm the execution of the actions by entering the Environment Variable Name below"
              shortConfirmationLabel="Environment Variable Name"
              step2ButtonText="Permanently Delete"
              onSubmit={remove}
            />
          </div>
          <div className="ml-auto flex flex-wrap gap-2" data-environment-variable-update-actions>
            {props.connectLink ? (
              <a href={props.connectLink} className="button" title="Add this variable to resources, and see which resources use it">
                <Reicon name="link" className="size-3.5" />
                Connect to resources
              </a>
            ) : null}
            {!isLocked ? (
              <div>
                <ModalConfirmation
                  title="Lock Environment Variable?"
                  trigger={
                    <button type="button" className="button">
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
            <fieldset disabled={!dirty}>
              <button type="submit" className="button button-highlighted">
                Update variable
              </button>
            </fieldset>
          </div>
        </div>
      ) : null}
    </form>
  );
}

interface RowProps {
  variable: Variable;
  type: SharedVariableScope;
  base: string;
  /** The row's place in the table: by key, and by creation. */
  order: number;
  visible: boolean;
  canUpdate: boolean;
  canViewValues: boolean;
  connectLink: string | null;
  onChanged: () => void;
}

/** A read-only row: one of a server's predefined variables, with its value. */
function BuiltInRow({ variable, type, order, visible }: Pick<RowProps, "variable" | "type" | "order" | "visible">) {
  return (
    <div className="env-table-item" style={{ order, ...(visible ? {} : HIDDEN) }}>
      <div className="data-table-row env-table-grid-shared">
        <div className="min-w-0">
          <div className="env-key-label truncate font-mono text-[13px]" title={variable.key}>
            {variable.key}
          </div>
          <div className="text-[11px] text-neutral-500 dark:text-fg-dim">Built-in · Read-only</div>
        </div>
        <span className="env-type-desktop text-[13px] text-neutral-500 dark:text-fg-dim">{scopeHeadline(type)}</span>
        <span className="min-w-0 truncate font-mono text-[13px]" title={variable.value ?? ""}>
          {variable.value}
        </span>
        <span className="data-table-cell-dash">-</span>
        <span className="justify-self-end text-neutral-400 dark:text-fg-faint" title="Built-in variable, managed by Freeploy">
          <Reicon name="keys" className="size-3.5" />
        </span>
      </div>
    </div>
  );
}

/** show.blade.php for a shared variable: the table row and its edit dialog. */
function VariableRow({ variable, type, base, order, visible, canUpdate, canViewValues, connectLink, onChanged }: RowProps) {
  const [editorOpen, setEditorOpen] = useState(false);
  const url = `${base}/${variable.id}`;
  const isLocked = variable.isShownOnce;
  return (
    <div className="env-table-item" data-env-key={variable.key} style={{ order, ...(visible ? {} : HIDDEN) }}>
      <div className="data-table-row env-table-grid-shared ">
        <div className="flex min-w-0 items-center gap-2">
          {isLocked ? (
            <svg className="size-3.5 shrink-0 text-neutral-400 dark:text-fg-faint" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
                <path d="M5 13a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6z" />
                <path d="M11 16a1 1 0 1 0 2 0a1 1 0 0 0-2 0m-3-5V7a4 4 0 1 1 8 0v4" />
              </g>
            </svg>
          ) : null}
          <button type="button" data-env-name-trigger className="env-key-label min-w-0 truncate text-left font-mono text-[13px] text-black dark:text-fg" title={variable.key} onClick={() => setEditorOpen(true)}>
            {variable.key}
          </button>
        </div>
        <div className="env-type-desktop text-[13px] text-neutral-500 dark:text-fg-dim">{scopeHeadline(type)}</div>
        <div className="min-w-0 truncate text-[13px] text-neutral-500 dark:text-fg-dim" title={variable.comment || undefined}>
          {variable.comment || "-"}
        </div>
        <FlagCell on={variable.isMultiline} />
        <div className="flex items-center justify-end gap-0.5 justify-self-end">
          {connectLink ? (
            <a href={connectLink} className="icon-button shrink-0" title={`Connect ${variable.key} to resources`} aria-label={`Connect ${variable.key} to resources`}>
              <Reicon name="link" className="size-3.5" />
            </a>
          ) : null}
          {!isLocked && canViewValues ? <CopyValueButton url={url} /> : null}
          <ModalInput
            title="Edit environment variable"
            closeOutside={false}
            open={editorOpen}
            onOpenChange={setEditorOpen}
            trigger={
              <button type="button" data-env-settings-trigger className="icon-button shrink-0" title="Edit environment variable" aria-label="Edit environment variable">
                <Reicon name="settings" className="size-3.5" />
              </button>
            }
          >
            <EditVariable
              url={url}
              variable={variable}
              canUpdate={canUpdate}
              canViewValues={canViewValues}
              connectLink={connectLink}
              onDone={() => {
                setEditorOpen(false);
                onChanged();
              }}
            />
          </ModalInput>
        </div>
      </div>
    </div>
  );
}

const SORTS: Array<["alphabetical" | "creation", string]> = [
  ["alphabetical", "Alphabetical"],
  ["creation", "Creation order"],
];

/** The developer view: a server's predefined variables above the form, then the text with its unsaved bar. */
function DeveloperView({ data, base, onSaved }: { data: EditorData; base: string; onSaved: (data: EditorData) => void }) {
  const [text, setText] = useState(data.devView);
  const [saving, setSaving] = useState(false);
  const builtIn = data.variables.filter((v) => v.readOnly).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  // submit(): on a failure the edited text stays.
  const save = useCallback(async () => {
    setSaving(true);
    const r = await postJson<EditorData & { message: string | null }>(`${base}/bulk`, { variables: text });
    setSaving(false);
    if (!r.ok) return notify.error(summarize(r.error.messages));
    if (r.data.message) notify.success(r.data.message);
    setText(r.data.devView);
    onSaved(r.data);
  }, [base, text, onSaved]);

  return (
    <>
      {builtIn.length > 0 ? (
        <div className="border-b border-neutral-200 p-4 dark:border-white/[0.08]">
          <div className="mb-2 text-[12px] text-neutral-500 dark:text-fg-dim">Built-in · Read-only</div>
          {builtIn.map((variable) => (
            <div key={variable.id} className="break-all font-mono text-[13px]">
              {variable.key}={variable.value}
            </div>
          ))}
        </div>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-4 p-4"
      >
        <UnsavedBar dirty={text !== data.devView} saving={saving} onSave={() => void save()} />
        <Callout type="info" title="Note">
          To make a variable literal, put <code className="font-mono"># coolify: literal</code> directly above its line. Without this line, the flag does not change.
        </Callout>
        <FormTextarea rows={20} id="variables" label={VARIABLES_LABEL[data.scope.type]} disabled={!data.canUpdate} value={text} onChange={setText} />
      </form>
    </>
  );
}

/** Which scope a page shows, from its path. */
export type EditorScope = { type: "team" } | { type: "project" | "environment" | "server"; uuid: string; projectUuid?: string };

/** Where a scope that is gone sends the visitor: its index. */
const INDEX: Record<SharedVariableScope, string> = {
  team: "/shared-variables",
  project: "/shared-variables/projects",
  environment: "/shared-variables/environments",
  server: "/shared-variables/servers",
};

/** <x-shared-variables.editor>. */
export function SharedVariablesEditor({ scope }: { scope: EditorScope }) {
  const { me } = useSignedIn();
  const base = `${sharedVariablesApi(me.team?.id)}/${scope.type === "team" ? "team" : `${scope.type}/${encodeURIComponent(scope.uuid)}`}`;
  const expectedProject = scope.type === "environment" ? scope.projectUuid : undefined;
  const [data, setData] = useState<EditorData | null>(null);
  const [view, setView] = useState<"normal" | "dev">("normal");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"alphabetical" | "creation">("alphabetical");
  const [addOpen, setAddOpen] = useState(false);

  const load = useCallback(async () => {
    const r = await getJson<EditorData>(base);
    // The environment belongs to the project its path names (Coolify looks it up within the project).
    if (!r.data || (expectedProject !== undefined && r.data.scope.project?.uuid !== expectedProject)) {
      if (r.status !== 401) window.location.replace(INDEX[scope.type]);
      return;
    }
    setData(r.data);
  }, [base, expectedProject, scope.type]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return null;
  const { variables, readOnlyKeys, canUpdate, canViewValues } = data;
  const type = data.scope.type;
  const page = scopePath(type, data.scope.uuid, data.scope.project?.uuid ?? null);
  const canvasUrl = `${page ?? INDEX[type]}/canvas`;
  const scopeLabel = scopeHeadline(type);
  const query = search.trim().toLowerCase();
  // $alphabeticalPositions: each variable's place when sorted by key.
  const alphabetical = new Map([...variables].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((v, i) => [v.id, i]));
  // filteredCount: the key, the comment or the scope holds the search.
  const filteredCount = !query ? variables.length : variables.filter((v) => [v.key.toLowerCase(), (v.comment ?? "").toLowerCase(), scopeLabel.toLowerCase()].some((value) => value.includes(query))).length;

  return (
    <SharedVariablesLayout>
      <div className="application-settings-form w-full">
        <SettingsSection
          title={data.scope.title}
          flush
          actions={
            <>
              <button
                type="button"
                className="button whitespace-nowrap"
                onClick={() => {
                  setView(view === "normal" ? "dev" : "normal");
                  void load();
                }}
              >
                <Reicon name={view === "normal" ? "browser-code" : "unordered-list"} className="size-3.5" />
                <span className="max-sm:hidden">{view === "normal" ? "Developer view" : "Normal view"}</span>
                <span className="sm:hidden">{view === "normal" ? "Developer" : "Normal"}</span>
              </button>
              <CanvasViewToggle canvasUrl={canvasUrl} />
            </>
          }
        >
          {view === "normal" ? (
            <>
              <div className="flex flex-col gap-3 border-b border-neutral-200 p-3 sm:flex-row sm:items-center sm:justify-between dark:border-white/[0.08]">
                <div className="relative w-full sm:max-w-sm">
                  <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
                  <input type="search" placeholder="Search variables" value={search} onChange={(e) => setSearch(e.target.value)} className={SEARCH_INPUT} />
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    style={shown(search !== "")}
                    className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.07] dark:hover:text-fg"
                    aria-label="Clear search"
                  >
                    <Reicon name="x" className="size-3" />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <TableDropdown
                    panelClass="w-48!"
                    trigger={(open) => (
                      <button type="button" className="button" aria-haspopup="listbox" aria-expanded={open}>
                        <Reicon name="sort-direction" className="size-3.5" />
                        Sort
                      </button>
                    )}
                  >
                    {(close) =>
                      SORTS.map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          className="listbox-option"
                          onClick={() => {
                            setSort(value);
                            close();
                          }}
                        >
                          <span>{label}</span>
                          {sort === value ? <Check className="size-3.5 shrink-0" /> : null}
                        </button>
                      ))
                    }
                  </TableDropdown>

                  {canUpdate ? (
                    <ModalInput
                      title="New Shared Variable"
                      open={addOpen}
                      onOpenChange={setAddOpen}
                      trigger={
                        <button type="button" className="button button-highlighted">
                          <Reicon name="plus" className="size-3.5" />
                          Add variable
                        </button>
                      }
                    >
                      <AddVariable
                        base={base}
                        onDone={() => {
                          setAddOpen(false);
                          void load();
                        }}
                      />
                    </ModalInput>
                  ) : null}
                </div>
              </div>

              {variables.length === 0 ? (
                <div className="p-3">
                  <Empty title="No shared variables" description="Add a variable to make it available to resources in this scope." iconName="variables" size="sm" />
                </div>
              ) : (
                <div className="data-table flex w-full flex-col">
                  <div className="data-table-header env-table-grid-shared order-[-1]">
                    <span>Name</span>
                    <span>Scope</span>
                    <span>{readOnlyKeys.length ? "Value / comment" : "Comment"}</span>
                    <span className="text-center">Multiline</span>
                    <span className="text-right">Actions</span>
                  </div>
                  {variables.map((variable, index) => {
                    const order = sort === "alphabetical" ? (alphabetical.get(variable.id) ?? index) : index;
                    // The row's x-show: its key, comment and scope as one text.
                    const visible = `${variable.key} ${variable.comment ?? ""} ${scopeLabel}`.toLowerCase().includes(query);
                    return variable.readOnly ? (
                      <BuiltInRow key={`shared-variable-${type}-${variable.id}`} variable={variable} type={type} order={order} visible={visible} />
                    ) : (
                      <VariableRow
                        key={`shared-variable-${type}-${variable.id}`}
                        variable={variable}
                        type={type}
                        base={base}
                        order={order}
                        visible={visible}
                        canUpdate={canUpdate}
                        canViewValues={canViewValues}
                        connectLink={page ? `${page}/canvas?select=${encodeURIComponent(`variable:${variable.id}`)}` : null}
                        onChanged={() => void load()}
                      />
                    );
                  })}
                  <div className="order-[9999] flex min-h-11 items-center border-t border-neutral-200 px-4 text-[11px] text-neutral-500 dark:border-white/[0.08] dark:text-fg-faint">
                    <span>{`${filteredCount} ${filteredCount === 1 ? "variable" : "variables"}`}</span>
                  </div>
                </div>
              )}
            </>
          ) : (
            <DeveloperView key={data.devView} data={data} base={base} onSaved={setData} />
          )}
        </SettingsSection>
      </div>
    </SharedVariablesLayout>
  );
}
