// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/security/cloud-init-scripts.blade.php and
// app/Livewire/Security/CloudInitScripts.php (Apache-2.0), modified.
//
// /security/cloud-init-scripts: the org's reusable cloud-init scripts, newest
// first. Create one and edit one in Coolify's editor dialog. Livewire's
// dispatch('success' | 'error', …) are the same toasts here.
import { useCallback, useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { ago } from "../lib/ago";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Empty, ModalInput, SettingsSection } from "../components/Coolify";
import { CloudInitScriptEditor, CloudInitScriptForm } from "./CloudInitScriptEditor";
import { SecurityLayout } from "./SecurityLayout";

interface CloudInitScriptItem {
  uuid: string;
  name: string;
  updatedAt: string | null;
}

const COLS = "grid-cols-[minmax(0,1fr)_12rem_4.5rem]";

function CloudInitScriptsContent() {
  const { me } = useSignedIn();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/cloud-init-scripts`;
  const [scripts, setScripts] = useState<CloudInitScriptItem[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  /** loadScripts(). */
  const reload = useCallback(async () => {
    const r = await getJson<{ scripts: CloudInitScriptItem[]; canWrite: boolean }>(base);
    if (!r.data) {
      if (r.status !== 401) notify.error("Failed to load cloud-init scripts.");
      setScripts([]);
      return;
    }
    setScripts(r.data.scripts);
    setCanWrite(r.data.canWrite);
  }, [base]);
  useEffect(() => {
    void reload();
  }, [reload]);

  /** scriptSaved / securityResourceChanged → loadScripts(), and closeModal. */
  const changed = useCallback(() => {
    setAddOpen(false);
    setEditing(null);
    void reload();
  }, [reload]);

  return (
    <div>
      <SecurityLayout>
        <SettingsSection
          title="Cloud-init scripts"
          helper="Reusable initialization scripts for cloud servers."
          flush
          actions={
            canWrite ? (
              <ModalInput
                title="New Cloud-Init Script"
                open={addOpen}
                onOpenChange={setAddOpen}
                trigger={
                  <button type="button" className="button button-highlighted">
                    <Reicon name="plus" className="size-3.5" />
                    New script
                  </button>
                }
              >
                <CloudInitScriptForm base={base} onSaved={changed} />
              </ModalInput>
            ) : undefined
          }
        >
          {scripts === null ? null : scripts.length === 0 ? (
            <Empty title="No cloud-init scripts" description="Create a script to reuse it during server provisioning." iconName="file-content" size="sm" />
          ) : (
            <div>
              <div
                className={`grid ${COLS} items-center gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[13px] font-medium text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint`}
              >
                <div className="pl-11">Script</div>
                <div>Last updated</div>
                <div className="text-right">Actions</div>
              </div>
              {scripts.map((script) => (
                <div key={script.uuid} className="border-b border-neutral-200 last:border-b-0 dark:border-white/[0.07]">
                  <div className={`grid min-h-14 w-full ${COLS} items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-white/[0.025]`}>
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim">
                        <Reicon name="file-content" className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{script.name}</h3>
                      </div>
                    </div>
                    <div className="flex items-center">
                      <span className="text-[10px] text-neutral-400 dark:text-fg-faint">{script.updatedAt ? `Updated ${ago(script.updatedAt)}` : "Updated"}</span>
                    </div>
                    <div className="flex justify-end">
                      <button type="button" className="icon-button" title="Edit cloud-init script" aria-label={`Edit ${script.name}`} onClick={() => setEditing(script.uuid)}>
                        <Reicon name="settings" className="size-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* One dialog for the list: Coolify renders an <x-modal-input> per row around the same editor. */}
          <ModalInput title="Edit Cloud-Init Script" open={editing !== null} onOpenChange={(open) => (open ? undefined : setEditing(null))} trigger={<span className="hidden" aria-hidden="true" />}>
            {editing ? <CloudInitScriptEditor key={editing} base={base} uuid={editing} onChanged={changed} /> : null}
          </ModalInput>
        </SettingsSection>
      </SecurityLayout>
    </div>
  );
}

export function CloudInitScriptsPage() {
  return (
    <Layout title="Keys & Tokens" href="/security/cloud-init-scripts" documentTitle="Cloud-Init Scripts">
      <CloudInitScriptsContent />
    </Layout>
  );
}
