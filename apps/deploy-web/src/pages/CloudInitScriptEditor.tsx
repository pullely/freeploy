// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/security/cloud-init-script-form.blade.php,
// resources/views/livewire/security/cloud-init-script/show.blade.php,
// app/Livewire/Security/CloudInitScriptForm.php and
// app/Livewire/Security/CloudInitScript/Show.php (Apache-2.0), modified.
//
// A cloud-init script's forms: the "New Cloud-Init Script" form, the "Edit
// Cloud-Init Script" dialog, and the script's own page
// /security/cloud-init-scripts/{uuid}. The script's content is loaded only
// for who may change it.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { FormInput, FormTextarea, ModalConfirmation, SettingsSection, UnsavedBar } from "../components/Coolify";
import { fieldErrors, SecurityLayout } from "./SecurityLayout";

export interface CloudInitScriptShow {
  uuid: string;
  name: string;
  /** Null for who may not change the script. */
  script: string | null;
  canUpdate: boolean;
}

const SCRIPT_HELPER = "Cloud-config YAML or another script accepted by your provider.";

/** cloud-init-script-form.blade.php for a new script; onSaved is scriptSaved + closeModal. */
export function CloudInitScriptForm({ base, onSaved }: { base: string; onSaved: (uuid: string) => void }) {
  const [name, setName] = useState("");
  const [script, setScript] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r = await postJson<{ uuid: string; message: string }>(base, { name, script });
    if (!r.ok) {
      const inline = fieldErrors(r.error.fields, ["name", "script"]);
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    // $this->reset(['name', 'script'])
    setName("");
    setScript("");
    notify.success(r.data.message);
    onSaved(r.data.uuid);
  }

  return (
    <form className="application-settings-form flex w-full flex-col gap-4" onSubmit={(e) => void save(e)}>
      <FormInput id="name" label="Script name" helper="A recognizable name for this reusable script." required value={name} onChange={setName} error={errors.name} />
      <FormTextarea id="script" label="Script content" rows={12} helper={SCRIPT_HELPER} required value={script} onChange={setScript} error={errors.script} />
      <div className="flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
        <button type="submit" className="button button-highlighted">
          Create script
        </button>
      </div>
    </form>
  );
}

/** Show's state and actions: mount(), save() and delete(). */
function useCloudInitScript(base: string, uuid: string, onMissing: () => void) {
  const [data, setData] = useState<CloudInitScriptShow | null>(null);
  const [name, setName] = useState("");
  const [script, setScript] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const r = await getJson<CloudInitScriptShow>(`${base}/${encodeURIComponent(uuid)}`);
    if (!r.data) {
      // mount() aborts with 404.
      onMissing();
      return;
    }
    setData(r.data);
    setName(r.data.name);
    setScript(r.data.script ?? "");
  }, [base, uuid, onMissing]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(): Promise<boolean> {
    setSaving(true);
    const r = await postJson<{ message: string }>(`${base}/${encodeURIComponent(uuid)}`, { name, script }, "PATCH");
    setSaving(false);
    if (!r.ok) {
      const inline = fieldErrors(r.error.fields, ["name", "script"]);
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return false;
    }
    setErrors({});
    notify.success(r.data.message);
    await load();
    return true;
  }

  async function remove(): Promise<boolean> {
    const r = await postJson<{ deleted: boolean }>(`${base}/${encodeURIComponent(uuid)}`, {}, "DELETE");
    if (!r.ok) {
      notify.error(summarize(r.error.messages));
      return false;
    }
    return true;
  }

  const dirty = data !== null && (name !== data.name || script !== (data.script ?? ""));
  return { data, name, setName, script, setScript, errors, saving, dirty, save, remove };
}

/** The name and the script, with the textarea's rows of the form they are in. */
function ScriptFields({ state, rows }: { state: ReturnType<typeof useCloudInitScript> & { data: CloudInitScriptShow }; rows: number }) {
  const disabled = !state.data.canUpdate;
  return (
    <>
      <FormInput id="name" label="Script name" required value={state.name} onChange={state.setName} disabled={disabled} error={state.errors.name} />
      <FormTextarea id="script" label="Script content" rows={rows} helper={SCRIPT_HELPER} required value={state.script} onChange={state.setScript} disabled={disabled} error={state.errors.script} />
    </>
  );
}

/** show.blade.php in modal mode: the "Edit Cloud-Init Script" dialog. onChanged is securityResourceChanged + close-modal. */
export function CloudInitScriptEditor({ base, uuid, onChanged }: { base: string; uuid: string; onChanged: () => void }) {
  const missing = useCallback(() => {
    notify.error("Cloud-init script not found.");
    onChanged();
  }, [onChanged]);
  const state = useCloudInitScript(base, uuid, missing);
  const { data } = state;
  if (!data) return null;
  return (
    <div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          void state.save().then((saved) => saved && onChanged());
        }}
      >
        <ScriptFields state={{ ...state, data }} rows={16} />
        <div className="flex items-center justify-between gap-2 border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
          {data.canUpdate ? (
            <ModalConfirmation
              title="Confirm Script Deletion?"
              buttonTitle="Delete"
              actions={["This cloud-init script will be permanently deleted."]}
              confirmationText={data.name}
              step2ButtonText="Delete script"
              onSubmit={async () => {
                if (await state.remove()) onChanged();
              }}
            />
          ) : null}
          <button {...({ ishighlighted: "" } as object)} className="button" type="submit" disabled={!data.canUpdate}>
            Save changes
          </button>
        </div>
      </form>
    </div>
  );
}

/** The script's uuid from /security/cloud-init-scripts/{uuid}. */
function uuidFromPath(pathname = window.location.pathname): string {
  return decodeURIComponent(pathname.split("/")[3] ?? "");
}

const toList = () => window.location.replace("/security/cloud-init-scripts");

function CloudInitScriptShowContent() {
  const { me } = useSignedIn();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/cloud-init-scripts`;
  const state = useCloudInitScript(base, uuidFromPath(), toList);
  const { data } = state;
  useEffect(() => {
    if (data) document.title = `${data.name} | Cloud-Init Scripts | Freeploy`;
  }, [data]);
  if (!data) return null;
  const save = () => void state.save();
  return (
    <div>
      <SecurityLayout
        actions={
          data.canUpdate ? (
            <ModalConfirmation
              title="Confirm Script Deletion?"
              buttonTitle="Delete"
              actions={["This cloud-init script will be permanently deleted.", "This action cannot be undone."]}
              confirmationText={data.name}
              confirmationLabel="Enter the script name to confirm deletion"
              shortConfirmationLabel="Script name"
              step2ButtonText="Delete script"
              onSubmit={async () => {
                // redirectRoute($this, 'security.cloud-init-scripts')
                if (await state.remove()) window.location.assign("/security/cloud-init-scripts");
              }}
            />
          ) : undefined
        }
      >
        <form
          className="application-settings-form"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            save();
          }}
        >
          <UnsavedBar dirty={state.dirty && data.canUpdate} saving={state.saving} onSave={save} />
          <SettingsSection title="General" helper="Edit the reusable initialization script used during cloud server creation.">
            <div className="flex flex-col gap-4">
              <ScriptFields state={{ ...state, data }} rows={18} />
            </div>
          </SettingsSection>
        </form>
      </SecurityLayout>
    </div>
  );
}

export function CloudInitScriptShowPage() {
  return (
    <Layout title="Keys & Tokens" href="/security/cloud-init-scripts" documentTitle="Cloud-Init Scripts">
      <CloudInitScriptShowContent />
    </Layout>
  );
}
