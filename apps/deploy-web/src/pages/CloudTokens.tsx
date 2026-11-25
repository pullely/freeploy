// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/security/cloud-tokens.blade.php,
// resources/views/livewire/security/cloud-provider-tokens.blade.php and
// app/Livewire/Security/{CloudTokens,CloudProviderTokens}.php (Apache-2.0), modified.
//
// /security/cloud-tokens: the org's cloud provider tokens. Add one (the
// provider is asked whether it works first) and edit one in Coolify's editor
// dialog. Livewire's dispatch('success' | 'error', …) are the same toasts here.
import { useCallback, useEffect, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Empty, ModalInput, SettingsSection } from "../components/Coolify";
import { CloudTokenEditor, CloudTokenForm } from "./CloudTokenEditor";
import { SecurityLayout } from "./SecurityLayout";

interface CloudTokenItem {
  uuid: string;
  name: string;
  description: string | null;
  provider: string;
  providerName: string;
}

const COLS = "grid-cols-[minmax(0,1fr)_8rem_4.5rem]";
const SM_COLS = "sm:grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)_4.5rem]";

function CloudTokensContent() {
  const { me } = useSignedIn();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/cloud-tokens`;
  const [tokens, setTokens] = useState<CloudTokenItem[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  /** loadTokens(). */
  const reload = useCallback(async () => {
    const r = await getJson<{ tokens: CloudTokenItem[]; canWrite: boolean }>(base);
    if (!r.data) {
      if (r.status !== 401) notify.error("Failed to load cloud tokens.");
      setTokens([]);
      return;
    }
    setTokens(r.data.tokens);
    setCanWrite(r.data.canWrite);
  }, [base]);
  useEffect(() => {
    void reload();
  }, [reload]);

  /** tokenAdded / securityResourceChanged → loadTokens(), and close-modal. */
  const changed = useCallback(() => {
    setAddOpen(false);
    setEditing(null);
    void reload();
  }, [reload]);

  return (
    <div>
      <SecurityLayout>
        <div className="application-settings-form">
          <SettingsSection
            title="Cloud tokens"
            helper="Provider credentials used to provision cloud servers."
            flush
            actions={
              canWrite ? (
                <ModalInput
                  title="New Cloud Token"
                  open={addOpen}
                  onOpenChange={setAddOpen}
                  trigger={
                    <button type="button" className="button button-highlighted">
                      <Reicon name="plus" className="size-3.5" />
                      New token
                    </button>
                  }
                >
                  <CloudTokenForm base={base} onAdded={changed} />
                </ModalInput>
              ) : undefined
            }
          >
            {tokens === null ? null : tokens.length === 0 ? (
              <Empty title="No cloud tokens" description="Add a provider token to provision new cloud servers." iconName="keys" size="sm" />
            ) : (
              <div>
                <div
                  className={`grid ${COLS} items-center gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[13px] font-medium text-neutral-500 ${SM_COLS} dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-faint`}
                >
                  <div className="pl-11">Token</div>
                  <div className="text-center">Provider</div>
                  <div className="hidden sm:block">Description</div>
                  <div className="text-right">Actions</div>
                </div>
                {tokens.map((token) => (
                  <div key={token.uuid} className="border-b border-neutral-200 last:border-b-0 dark:border-white/[0.07]">
                    <div className={`grid min-h-14 w-full ${COLS} items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-neutral-50 ${SM_COLS} dark:hover:bg-white/[0.025]`}>
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim">
                          <Reicon name="keys" className="size-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-[13px]! leading-4! font-semibold! text-black dark:text-fg">{token.name}</h3>
                        </div>
                      </div>
                      <div className="flex justify-center">
                        <span className="inline-flex rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600 dark:bg-white/[0.06] dark:text-fg-dim">{token.providerName}</span>
                      </div>
                      <p className="hidden truncate text-[12px] text-neutral-500 sm:block dark:text-fg-dim">{token.description || "-"}</p>
                      <div className="flex justify-end">
                        <button type="button" className="icon-button" title="Edit cloud token" aria-label={`Edit ${token.name}`} onClick={() => setEditing(token.uuid)}>
                          <Reicon name="settings" className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {/* One dialog for the list: Coolify renders an <x-modal-input> per row around the same editor. */}
            <ModalInput title="Edit Cloud Token" open={editing !== null} onOpenChange={(open) => (open ? undefined : setEditing(null))} trigger={<span className="hidden" aria-hidden="true" />}>
              {editing ? <CloudTokenEditor key={editing} base={base} uuid={editing} onChanged={changed} /> : null}
            </ModalInput>
          </SettingsSection>
        </div>
      </SecurityLayout>
    </div>
  );
}

export function CloudTokensPage() {
  return (
    <Layout title="Keys & Tokens" href="/security/cloud-tokens" documentTitle="Cloud Tokens">
      <CloudTokensContent />
    </Layout>
  );
}
