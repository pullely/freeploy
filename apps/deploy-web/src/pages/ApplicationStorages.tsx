// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/service/{storage,file-storage}.blade.php,
// resources/views/livewire/project/shared/storages/all.blade.php,
// resources/views/components/table/{row-actions,row-action}.blade.php and
// app/Livewire/Project/Service/{Storage,FileStorage}.php, app/Livewire/Project/Shared/Storages/All.php
// (Apache-2.0), modified.
//
// /project/{uuid}/environment/{env_uuid}/application/{app_uuid}/persistent-storage
// (project.application.persistent-storage): the application's volume, file,
// host file and directory mounts. A volume is a row that takes effect at the
// next deployment. What Coolify does on the server for a file or a directory
// needs the SSH executor: the API says what did not run, and the toast shows
// it. Volume and directory backups are not ported, so the Backup column only
// shows a schedule that exists.
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Layout } from "../layout/Layout";
import { Reicon } from "../components/Reicon";
import { Callout, Empty, FormInput, FormTextarea, Helper, Listbox, ModalConfirmation, ModalInput, SettingsSection, UnsavedBar, type ConfirmationCheckbox } from "../components/Coolify";
import { TableDropdown } from "../components/CoolifyList";
import { applicationsApi, ApplicationWorkspace } from "./ApplicationChrome";
import { useApplicationSection, yesNo, type ApplicationSectionData, type PatchResult } from "./ApplicationSection";
import { sendJson, showError, showSaved } from "./ApplicationResource";

interface Volume {
  id: string;
  name: string;
  mountPath: string;
  hostPath: string | null;
  isPreviewSuffixEnabled: boolean;
  isReadOnly: boolean;
  isShared: boolean;
  backup: { enabled: boolean; s3: boolean };
}

interface Mount {
  id: string;
  fsPath: string;
  mountPath: string;
  isDirectory: boolean;
  isHostFile: boolean;
  isBasedOnGit: boolean;
  isPreviewSuffixEnabled: boolean;
  content: string | null;
  isBinary: boolean;
  isTooLarge: boolean;
  canDeleteFromServer: boolean;
  hasEnabledBackup: boolean;
}

interface Storages {
  isSwarm: boolean;
  gitBased: boolean;
  hostPath: string;
  defaultVolumeName: string;
  volumeUnavailableReason: string | null;
  volumes: Volume[];
  files: Mount[];
  directories: Mount[];
}

type Data = ApplicationSectionData & Storages;
type Saved = Storages & { message: string | null; unavailable?: string };
type Send = (method: "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>) => Promise<PatchResult<Saved>>;
type Tab = "volumes" | "files" | "directories";
type MountType = "volume" | "file" | "host-file" | "directory";

const PR_SUFFIX_HELPER = "Adds -pr-N to the storage name or path so each preview uses isolated data. Disabling it shares production data with previews.";
const TAB_BASE = "h-7 rounded-md px-2.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const TAB_ACTIVE = "bg-white text-black shadow-sm ring-1 ring-neutral-200 dark:bg-white/[0.09] dark:text-fg dark:ring-white/[0.08]";
const TAB_INACTIVE = "text-neutral-500 hover:text-black dark:text-fg-faint dark:hover:text-fg";
const MODAL_INTRO = "text-[13px] leading-5 text-neutral-500 dark:text-fg-dim";

/** Storage::resolveDefaultTab(): the first kind that has mounts. */
const defaultTab = (s: Storages): Tab => (s.volumes.length ? "volumes" : s.files.length ? "files" : s.directories.length ? "directories" : "volumes");

/** The "Add mount" menu and its four dialogs. */
function AddMount({ uuid, storages, send, onAdded }: { uuid: string; storages: Storages; send: Send; onAdded: (tab: Tab) => void }) {
  const [menu, setMenu] = useState(false);
  const [open, setOpen] = useState<MountType | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const blank = { name: storages.defaultVolumeName, mount_path: "", file_storage_path: "", file_storage_source: "", file_storage_content: "", host_file_storage_source: "", host_file_storage_destination: "", file_storage_directory_source: storages.hostPath, file_storage_directory_destination: "" };
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!menu) return;
    const onClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [menu]);

  const field = (name: keyof typeof blank) => ({ id: name, value: form[name], onChange: (v: string) => setForm({ ...form, [name]: v }), error: errors[name] });
  const close = () => {
    setOpen(null);
    setErrors({});
  };

  /** submitPersistentVolume() and its siblings: on success clearForm(), the kind's tab, and the dialog closes. */
  const submit = (type: MountType, tab: Tab, fields: Array<keyof typeof blank>) => async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const r = await send("POST", "", { type, ...Object.fromEntries(fields.map((f) => [f, form[f]])) });
    if (!r.ok) {
      const inline: Record<string, string> = {};
      for (const [name, messages] of Object.entries(r.error.fields)) if (messages[0]) inline[name] = messages[0];
      setErrors(inline);
      if (!r.error.messages.length) showError(r.error);
      return;
    }
    setForm({ ...blank, name: r.data.defaultVolumeName });
    close();
    onAdded(tab);
  };

  /** previewPath(): where the managed file will be on the host. */
  const source = form.file_storage_source.trim();
  const path = form.file_storage_path.trim();
  const previewPath = source !== "" ? (source.startsWith("/") ? source : `${storages.hostPath}/${source.replace(/^\.\//, "")}`) : storages.hostPath + (path === "" ? "/" : path.startsWith("/") ? path : `/${path}`);

  const option = (type: MountType, icon: string, label: string) => (
    <button
      type="button"
      className="listbox-option justify-start! gap-2.5!"
      role="menuitem"
      onClick={() => {
        setOpen(type);
        setMenu(false);
      }}
    >
      <Reicon name={icon} className="size-3.5 shrink-0 opacity-70" />
      {label}
    </button>
  );
  const dialog = (type: MountType, title: string, children: ReactNode) => (
    <ModalInput title={title} open={open === type} onOpenChange={(o) => (o ? setOpen(type) : close())}>
      {children}
    </ModalInput>
  );
  const submitButton = (label: string) => (
    <div className="flex justify-end pt-2">
      <button type="submit" className="button">
        {label}
      </button>
    </div>
  );

  return (
    <div>
      <div className="relative" ref={root}>
        <button type="button" className="button button-highlighted" onClick={() => setMenu(!menu)} aria-haspopup="menu" aria-expanded={menu}>
          <Reicon name="plus" className="size-3.5" />
          Add mount
          <Reicon name="chevron-down" className="size-3 opacity-55" />
        </button>
        <div role="menu" className="listbox-panel left-0! right-auto! z-[90]! w-52! min-w-52! sm:left-auto! sm:right-0!" style={menu ? undefined : { display: "none" }}>
          {option("volume", "storages", "Volume mount")}
          {option("file", "file", "File mount")}
          {option("host-file", "file-content", "Host file mount")}
          {option("directory", "folder", "Directory mount")}
        </div>
      </div>

      {dialog(
        "volume",
        "Add volume mount",
        storages.volumeUnavailableReason ? (
          <Callout type="warning" title="Volume mounts are unavailable" className="w-full">
            {storages.volumeUnavailableReason}
          </Callout>
        ) : (
          <form className="flex w-full flex-col gap-4" onSubmit={submit("volume", "volumes", ["name", "mount_path"])}>
            <p className={MODAL_INTRO}>
              Mount a Docker volume inside the container. Freeploy adds the prefix <code className="break-all">{uuid}-</code> to the name, so that the volume name is unique on the server.
            </p>
            <div className="flex flex-col gap-4">
              <FormInput {...field("name")} placeholder="pv-name" label="Name" required helper="Volume name." />
              <FormInput {...field("mount_path")} placeholder="/tmp/root" label="Destination Path" required helper="Directory inside the container." />
              {submitButton("Add volume")}
            </div>
          </form>
        ),
      )}

      {dialog(
        "file",
        "Add file mount",
        <form className="flex w-full flex-col gap-4" onSubmit={submit("file", "files", ["file_storage_path", "file_storage_source", "file_storage_content"])}>
          <p className={MODAL_INTRO}>Create a managed file on the host and mount it inside the container.</p>
          <div className="flex flex-col gap-4">
            <div className="rounded-lg bg-neutral-100 p-3 text-xs ring-1 ring-neutral-200 dark:bg-white/[0.04] dark:ring-white/[0.07]">
              <div className="mb-1 font-medium">Host file path</div>
              <code className="break-all">{previewPath}</code>
            </div>
            <FormInput {...field("file_storage_path")} placeholder="/etc/nginx/nginx.conf" label="Destination Path" required helper="File location inside the container" />
            <FormInput
              {...field("file_storage_source")}
              placeholder="/srv/config/app.conf"
              label="Source Path"
              helper="Optional. File location on the host: an absolute path anywhere on the host, or a path relative to the resource directory. Empty: Freeploy keeps the file in the resource directory. Freeploy never deletes a file outside the resource directory."
            />
            <FormTextarea {...field("file_storage_content")} label="Content" />
            {submitButton("Add file")}
          </div>
        </form>,
      )}

      {dialog(
        "host-file",
        "Add host file mount",
        <form className="flex w-full flex-col gap-4" onSubmit={submit("host-file", "files", ["host_file_storage_source", "host_file_storage_destination"])}>
          <p className={MODAL_INTRO}>Bind an existing host file into the container. Freeploy will not modify or delete the source file.</p>
          <div className="flex flex-col gap-4">
            <FormInput {...field("host_file_storage_source")} placeholder="/etc/nginx/nginx.conf" label="Host File Path" required helper="Existing file on the host system." />
            <FormInput {...field("host_file_storage_destination")} placeholder="/etc/nginx/nginx.conf" label="Destination Path" required helper="File location inside the container." />
            {submitButton("Add host file")}
          </div>
        </form>,
      )}

      {dialog(
        "directory",
        "Add directory mount",
        <form className="flex w-full flex-col gap-4" onSubmit={submit("directory", "directories", ["file_storage_directory_source", "file_storage_directory_destination"])}>
          <p className={MODAL_INTRO}>Bind a directory from the host system into the container.</p>
          <div className="flex flex-col gap-4">
            <FormInput
              {...field("file_storage_directory_source")}
              placeholder={`${storages.hostPath}/etc/nginx`}
              label="Source Directory"
              required
              helper="Directory on the host: an absolute path anywhere on the host, or a path relative to the resource directory. Freeploy creates it when it is missing, and never deletes a directory outside the resource directory."
            />
            <FormInput {...field("file_storage_directory_destination")} placeholder="/etc/nginx" label="Destination Directory" required helper="Directory inside the container." />
            {submitButton("Add directory")}
          </div>
        </form>,
      )}
    </div>
  );
}

/** The Backup cell: a schedule's badge, or a dash. */
function BackupBadge({ backup }: { backup: Volume["backup"] }) {
  if (!backup.enabled) return <span className="data-table-cell-dash">-</span>;
  return (
    <span className={backup.s3 ? "table-badge table-badge-success" : "table-badge"} title="Volume backup is enabled" aria-label={backup.s3 ? "Backups are saved to S3" : "Backups are stored locally only"}>
      {backup.s3 ? "S3" : "Local"}
    </span>
  );
}

/** <livewire:project.shared.storages.all>: the volumes as rows, each a form of its own. */
function VolumeList({ storages, canUpdate, compose, send }: { storages: Storages; canUpdate: boolean; compose: boolean; send: Send }) {
  const formsOf = (volumes: Volume[]) => Object.fromEntries(volumes.map((v) => [v.id, { name: v.name, mountPath: v.mountPath, isPreviewSuffixEnabled: v.isPreviewSuffixEnabled }]));
  const [forms, setForms] = useState(() => formsOf(storages.volumes));
  const [pendingRename, setPendingRename] = useState<{ storageId: string; from: string; to: string } | null>(null);
  useEffect(() => {
    setForms(formsOf(storages.volumes));
  }, [storages.volumes]);

  const hasSourcePaths = storages.volumes.some((v) => v.hostPath !== null);
  const supportsPreviewSuffix = storages.gitBased;
  const grid = `${supportsPreviewSuffix ? "volumes-table-grid-with-pr" : canUpdate ? "volumes-table-grid" : "volumes-table-grid-readonly"}${hasSourcePaths ? " has-source" : ""}`;

  /** All::submit(): a rename first asks (409 with the two names), then saves with renameConfirmed. */
  async function submit(id: string, renameConfirmed = false, override: Partial<{ isPreviewSuffixEnabled: boolean }> = {}) {
    const form = { ...forms[id]!, ...override };
    const r = await send("PATCH", `/volumes/${id}`, { ...form, renameConfirmed });
    if (r.ok) return;
    const pending = r.error.details.pendingRename as { storageId: string; from: string; to: string } | undefined;
    if (r.error.status === 409 && pending) return setPendingRename(pending);
    showError(r.error);
  }
  const cancelRename = () => {
    if (pendingRename) setForms((f) => ({ ...f, [pendingRename.storageId]: { ...f[pendingRename.storageId]!, name: pendingRename.from } }));
    setPendingRename(null);
  };

  const prSuffix = (
    <div className="volumes-mobile-label volumes-field-label flex items-center gap-1.5">
      <span>PR suffix</span>
      <Helper helper={PR_SUFFIX_HELPER} />
    </div>
  );
  const source = (v: Volume) =>
    hasSourcePaths ? (
      <div className="volumes-cell-source min-w-0">
        <span className="volumes-mobile-label volumes-field-label">Source Path</span>
        {v.hostPath !== null ? <FormInput value={v.hostPath} readOnly /> : <span className="data-table-cell-dash">-</span>}
      </div>
    ) : null;
  const backup = (v: Volume) => (
    <div className="volumes-col-backup flex items-center justify-center gap-1.5">
      <span className="volumes-mobile-label volumes-field-label">Backup</span>
      <BackupBadge backup={v.backup} />
    </div>
  );

  return (
    <div className="flex w-full flex-col">
      {compose ? (
        <div className="border-b border-neutral-200 px-4 py-3 text-[13px] leading-5 text-amber-800 dark:border-white/[0.08] dark:text-amber-300/90">
          Docker Compose volume mounts are read-only here. Edit the compose file and reload it to change volumes.
        </div>
      ) : null}

      <div className="data-table w-full">
        <div className={`data-table-header ${grid}`}>
          <span>Storage Name</span>
          {hasSourcePaths ? <span>Source Path</span> : null}
          <span>Destination Path</span>
          {supportsPreviewSuffix ? (
            <div className="volumes-col-pr flex items-center gap-1.5">
              <span>PR suffix</span>
              <Helper helper={PR_SUFFIX_HELPER} />
            </div>
          ) : null}
          <span className="volumes-col-backup text-center">Backup</span>
          {canUpdate ? <span className="volumes-col-actions text-right">Actions</span> : null}
        </div>

        {storages.volumes.map((v) => {
          const form = forms[v.id];
          if (!form) return null;
          if (v.isReadOnly) {
            return (
              <div className="env-table-item" key={v.id}>
                <div className={`data-table-row ${grid} text-[13px] text-neutral-700 dark:text-fg-dim`}>
                  <div className="volumes-cell-name min-w-0">
                    <span className="volumes-mobile-label volumes-field-label">Storage Name</span>
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 truncate text-[13px] font-medium text-neutral-950 dark:text-fg" title={v.name}>
                        {v.name}
                      </span>
                    </div>
                  </div>
                  {source(v)}
                  <div className="volumes-cell-dest min-w-0">
                    <span className="volumes-mobile-label volumes-field-label">Destination Path</span>
                    <span className="block min-w-0 truncate text-[13px] text-neutral-950 dark:text-fg" title={v.mountPath}>
                      {v.mountPath}
                    </span>
                  </div>
                  {supportsPreviewSuffix ? (
                    <div className="volumes-col-pr min-w-0">
                      {prSuffix}
                      <span>{v.isPreviewSuffixEnabled ? "Add suffix" : "Share volume"}</span>
                    </div>
                  ) : null}
                  {backup(v)}
                  {canUpdate ? (
                    <div className="volumes-col-actions volumes-cell-actions flex flex-nowrap items-center justify-end gap-1.5">
                      <span className="text-neutral-400 dark:text-fg-faint">—</span>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          }
          const set = (changes: Partial<typeof form>) => setForms({ ...forms, [v.id]: { ...form, ...changes } });
          return (
            <form
              className="env-table-item"
              key={v.id}
              onSubmit={(e) => {
                e.preventDefault();
                void submit(v.id);
              }}
            >
              <div className={`data-table-row ${grid}`}>
                <div className="volumes-cell-name min-w-0">
                  <span className="volumes-mobile-label volumes-field-label">Storage Name</span>
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <FormInput id={`forms.${v.id}.name`} value={form.name} onChange={(name) => set({ name })} required readOnly={v.isShared} />
                    </div>
                  </div>
                </div>
                {source(v)}
                <div className="volumes-cell-dest min-w-0">
                  <span className="volumes-mobile-label volumes-field-label">Destination Path</span>
                  <FormInput id={`forms.${v.id}.mountPath`} value={form.mountPath} onChange={(mountPath) => set({ mountPath })} required placeholder="/path/in/container" />
                </div>
                {supportsPreviewSuffix ? (
                  <div className="volumes-col-pr min-w-0">
                    {prSuffix}
                    <Listbox
                      id={`forms.${v.id}.isPreviewSuffixEnabled`}
                      options={[
                        { value: "true", label: "Add suffix" },
                        { value: "false", label: "Share volume" },
                      ]}
                      value={yesNo(form.isPreviewSuffixEnabled)}
                      onChange={(value) => {
                        // updatedForms(): the PR suffix saves itself.
                        set({ isPreviewSuffixEnabled: value === "true" });
                        void submit(v.id, false, { isPreviewSuffixEnabled: value === "true" });
                      }}
                    />
                  </div>
                ) : null}
                {backup(v)}
                <div className="volumes-col-actions volumes-cell-actions flex flex-nowrap items-center justify-end gap-1.5">
                  <button type="submit" className="sr-only" tabIndex={-1} aria-hidden="true">
                    Update
                  </button>
                  {v.isShared ? (
                    <button type="button" onClick={() => void submit(v.id)} className="icon-button shrink-0" title="Update storage" aria-label={`Update ${v.name}`}>
                      <Reicon name="check" className="size-3.5" />
                    </button>
                  ) : (
                    <TableDropdown
                      panelClass="w-44!"
                      trigger={(open) => (
                        <button type="button" className="icon-button" title="Storage actions" aria-label="Storage actions" aria-haspopup="menu" aria-expanded={open}>
                          <Reicon name="dots-horizontal" className="size-4" />
                        </button>
                      )}
                    >
                      {(close) => (
                        <div className="contents">
                          <button
                            type="button"
                            role="menuitem"
                            className="listbox-option justify-start!"
                            onClick={() => {
                              close();
                              void submit(v.id);
                            }}
                          >
                            Update
                          </button>
                          <div className="my-1 border-t border-neutral-200 dark:border-white/[0.08]" />
                          <div className="row-actions-danger contents" onClick={close}>
                            <ModalConfirmation
                              title="Confirm persistent storage deletion?"
                              trigger={
                                <button type="button" role="menuitem" className="listbox-option justify-start!">
                                  Delete
                                </button>
                              }
                              actions={["The selected persistent storage/volume will be permanently deleted.", "If the persistent storage/volume is actvily used by a resource data will be lost."]}
                              confirmationText={v.name}
                              confirmationLabel="Please confirm the execution of the actions by entering the Storage Name below"
                              shortConfirmationLabel="Storage Name"
                              onSubmit={async () => {
                                const r = await send("DELETE", `/volumes/${v.id}`);
                                if (!r.ok) showError(r.error);
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </TableDropdown>
                  )}
                </div>
              </div>
            </form>
          );
        })}
      </div>

      <ModalInput title="Change the volume name?" open={pendingRename !== null} onOpenChange={(open) => (open ? undefined : cancelRename())} closeOutside={false}>
        {pendingRename ? (
          <div>
            <Callout type="warning" title="The data does not move to the new volume" className="mb-4">
              <ul className="mt-2 ml-4 list-disc">
                <li>Changing the name does not rename or move the Docker volume.</li>
                <li>
                  After the next restart or deployment, the resource uses the Docker volume <strong>{pendingRename.to}</strong>. If that volume does not exist, Docker creates it empty.
                </li>
                <li>
                  Your data stays in <strong>{pendingRename.from}</strong>. Freeploy does not copy it, and does not delete it when you delete this resource.
                </li>
                <li>To keep your data, stop the resource and copy the data into the new volume before you start it again.</li>
              </ul>
            </Callout>
            <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
              <button type="button" className="button" onClick={cancelRename}>
                Cancel
              </button>
              <button
                type="button"
                className="button button-error"
                onClick={() => {
                  const id = pendingRename.storageId;
                  setPendingRename(null);
                  void submit(id, true);
                }}
              >
                Change Volume Name
              </button>
            </div>
          </div>
        ) : null}
      </ModalInput>
    </div>
  );
}

/** <livewire:project.service.file-storage>: one file, host file or directory mount. */
function FileStorage({ mount, gitBased, canUpdate, send }: { mount: Mount; gitBased: boolean; canUpdate: boolean; send: Send }) {
  const [content, setContent] = useState(mount.content ?? "");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setContent(mount.content ?? "");
  }, [mount.content]);
  const kind = mount.isDirectory ? "directory" : "file";
  // FileStorage::mount(): a path that starts with "." is shown without the dot.
  const fsPath = mount.fsPath.startsWith(".") ? mount.fsPath.slice(1) : mount.fsPath;
  const isReadOnly = mount.isTooLarge;

  const run = async (method: "PATCH" | "DELETE", path: string, body?: Record<string, unknown>) => {
    setSaving(true);
    const r = await send(method, `/files/${mount.id}${path}`, body);
    setSaving(false);
    if (!r.ok) showError(r.error);
  };
  const act = (action: string, extra: Record<string, unknown> = {}) => run("PATCH", "", { action, ...extra });

  // FileStorage::render(): what the deletion dialog says and offers.
  const deletionActions = [mount.isHostFile ? "The mount will be removed from the container." : `The selected ${kind} will be permanently deleted from the container.`];
  const deletionCheckboxes: ConfirmationCheckbox[] = [];
  if (mount.canDeleteFromServer) {
    deletionCheckboxes.push({
      id: "permanently_delete",
      label: mount.isDirectory ? "The selected directory and all its contents will be permanently deleted from the server." : "The selected file will be permanently deleted from the server.",
      checked: true,
    });
  } else {
    deletionActions.push(`Only the mount configuration will be removed. The ${kind} at ${mount.fsPath} is not deleted on the server.`);
  }
  const deletion = (title: string) => (
    <ModalConfirmation
      title={title}
      buttonTitle="Delete"
      checkboxes={deletionCheckboxes}
      actions={deletionActions}
      confirmationText={fsPath}
      confirmationLabel="Please confirm the execution of the actions by entering the Filepath below"
      shortConfirmationLabel="Filepath"
      onSubmit={(selected) => run("DELETE", `?permanently_delete=${selected.includes("permanently_delete")}`)}
    />
  );
  const hidden = (
    <Callout type="info" title="Hidden (only admins can view)">
      The file content can contain secrets.
    </Callout>
  );
  const contentLabel = mount.isBasedOnGit ? "Content (refreshed after a successful deployment)" : "Content";
  const contentHelper = "The content shown may be outdated. Click 'Load from server' to fetch the latest version.";
  const dirty = canUpdate && !isReadOnly && !mount.isDirectory && !mount.isHostFile && content !== (mount.content ?? "");
  const submit = () => void act("save", { content });

  return (
    <div>
      <div className="flex flex-col gap-4">
        {mount.isTooLarge ? (
          <Callout type="warning" title="File too large">
            File on server exceeds 5 MB and cannot be edited from the UI. Edit it directly on the server.
          </Callout>
        ) : mount.isHostFile ? (
          <Callout type="info" title="Host-managed file">
            This host file mount is bind-only. Freeploy will not create, edit, load, chmod, or delete the source file.
          </Callout>
        ) : null}
        <div className="flex flex-col justify-center text-sm select-text">
          <div className="grid gap-4 md:grid-cols-2">
            <FormInput label="Source Path" value={mount.fsPath} readOnly />
            <FormInput label="Destination Path" value={mount.mountPath} readOnly />
          </div>
        </div>
        {gitBased && canUpdate ? (
          <div className="w-full sm:w-96">
            <Listbox
              id={`isPreviewSuffixEnabled-${mount.id}`}
              label="PR deployment suffix"
              helper="Choose whether preview deployments receive an isolated -pr-N path suffix."
              options={[
                { value: "true", label: "Add suffix" },
                { value: "false", label: "Share path" },
              ]}
              value={yesNo(mount.isPreviewSuffixEnabled)}
              onChange={(value) => void act("instantSave", { isPreviewSuffixEnabled: value === "true", ...(mount.isDirectory || mount.isHostFile ? {} : { content }) })}
            />
          </div>
        ) : null}
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <UnsavedBar dirty={dirty} saving={saving} onSave={submit} />
          {canUpdate ? (
            <div className="flex flex-wrap items-center gap-2">
              {mount.isHostFile ? (
                isReadOnly ? null : (
                  deletion("Confirm Host File Mount Removal?")
                )
              ) : mount.isDirectory ? (
                <>
                  <ModalConfirmation
                    title="Confirm Directory Conversion to File?"
                    trigger={
                      <button type="button" className="button">
                        Convert to file
                      </button>
                    }
                    actions={["All files in this directory will be permanently deleted and an empty file will be created in its place."]}
                    confirmationText={fsPath}
                    confirmationLabel="Please confirm the execution of the actions by entering the Filepath below"
                    shortConfirmationLabel="Filepath"
                    step2ButtonText="Convert to file"
                    onSubmit={() => act("convertToFile")}
                  />
                  {isReadOnly ? null : deletion("Confirm Directory Deletion?")}
                </>
              ) : (
                <>
                  {!mount.isBinary && !mount.isTooLarge ? (
                    <ModalConfirmation
                      title="Confirm File Conversion to Directory?"
                      trigger={
                        <button type="button" className="button">
                          Convert to directory
                        </button>
                      }
                      actions={["The selected file will be permanently deleted and an empty directory will be created in its place."]}
                      confirmationText={fsPath}
                      confirmationLabel="Please confirm the execution of the actions by entering the Filepath below"
                      shortConfirmationLabel="Filepath"
                      step2ButtonText="Convert to directory"
                      onSubmit={() => act("convertToDirectory")}
                    />
                  ) : null}
                  <button type="button" className="button" onClick={() => void act("loadFromServer")}>
                    Load from server
                  </button>
                  {isReadOnly ? null : deletion("Confirm File Deletion?")}
                </>
              )}
            </div>
          ) : null}
          {mount.isDirectory || mount.isHostFile ? null : canUpdate ? (
            <FormTextarea
              id={`content-${mount.id}`}
              label={contentLabel}
              helper={contentHelper}
              rows={20}
              value={content}
              onChange={setContent}
              disabled={isReadOnly || mount.isBasedOnGit || mount.isBinary}
            />
          ) : (
            hidden
          )}
        </form>
      </div>
    </div>
  );
}

function ApplicationStoragesContent() {
  const { me, data, setData } = useApplicationSection<Data>("storages");
  const [tab, setTab] = useState<Tab | null>(null);
  if (!data) return null;
  const { application, canUpdate } = data;
  const base = `${applicationsApi(me.team?.id)}/${encodeURIComponent(application.uuid)}/storages`;
  const compose = application.buildPack === "dockercompose";
  const activeTab = tab ?? defaultTab(data);
  const counts = { volumes: data.volumes.length, files: data.files.length, directories: data.directories.length };
  const any = counts.volumes + counts.files + counts.directories > 0;

  /** Every action answers the page again (refreshStorages), with its toast. */
  const send: Send = async (method, path, body) => {
    const r = await sendJson<Saved>(method, base + path, body);
    if (r.ok) {
      const { message, unavailable, ...storages } = r.data;
      setData({ ...data, ...storages });
      showSaved({ message, ...(unavailable ? { unavailable } : {}) });
    }
    return r;
  };
  const tabButton = (name: Tab, label: string) => (
    <button type="button" onClick={() => setTab(name)} disabled={counts[name] === 0} className={`${TAB_BASE} ${activeTab === name ? TAB_ACTIVE : TAB_INACTIVE}`}>
      {label} ({counts[name]})
    </button>
  );
  const mounts = (list: Mount[], empty: ReactNode) => (
    <div className="flex flex-col gap-4 p-4">{list.length ? list.map((m) => <FileStorage key={m.id} mount={m} gitBased={data.gitBased} canUpdate={canUpdate} send={send} />) : empty}</div>
  );

  return (
    <ApplicationWorkspace application={application} orgId={me.team?.id} active="Persistent Storage" canUpdate={canUpdate} canDeploy={data.canDeploy}>
      <div className="flex flex-col gap-6">
        <SettingsSection
          id="storage-mounts-section"
          title="Persistent storage"
          flush
          helper={data.gitBased ? "Preview deployment volumes can use a -pr-#PRNumber suffix so each pull request receives isolated storage." : "Mount volumes, files, or directories to preserve data between deployments."}
          actions={
            <>
              {!compose && canUpdate ? <AddMount uuid={application.uuid} storages={data} send={send} onAdded={setTab} /> : null}
              {any ? (
                <div className="inline-flex items-center gap-0.5 rounded-lg bg-neutral-100 p-1 dark:bg-white/[0.04]">
                  {tabButton("volumes", "Volumes")}
                  {tabButton("files", "Files")}
                  {tabButton("directories", "Directories")}
                </div>
              ) : null}
            </>
          }
        >
          {!any ? (
            <Empty size="sm" title="No persistent storage" description="Add a volume, file, or directory mount to preserve data between deployments." iconName="storages" />
          ) : activeTab === "volumes" ? (
            counts.volumes ? (
              <VolumeList storages={data} canUpdate={canUpdate} compose={compose} send={send} />
            ) : (
              <Empty size="sm" title="No volumes configured" description="Switch tabs or add a volume mount." iconName="storages" />
            )
          ) : activeTab === "files" ? (
            mounts(data.files, <Empty size="sm" title="No file mounts configured" description="Switch tabs or add a file mount." iconName="file" />)
          ) : (
            mounts(data.directories, <Empty size="sm" title="No directory mounts configured" description="Switch tabs or add a directory mount." iconName="folder" />)
          )}
        </SettingsSection>
      </div>
    </ApplicationWorkspace>
  );
}

export function ApplicationStoragesPage() {
  return (
    <Layout title="Projects" href="/projects" navHref="/projects" documentTitle="Configuration">
      <ApplicationStoragesContent />
    </Layout>
  );
}
