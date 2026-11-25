// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/security/api-tokens.blade.php,
// resources/views/livewire/security/partials/api-token-fields.blade.php, app/Livewire/Security/ApiTokens.php
// and app/Livewire/Forms/ApiTokenForm.php (updatedPermissions) (Apache-2.0), modified.
//
// /security/api-tokens: the user's API tokens in the current team, newest first; a new token is shown
// once, in Coolify's "Copy your token" dialog, in Sanctum's "<id>|<plain text>" form that /api/v1 takes.
// Not ported: tokens limited to selected projects, environments or resources (every token covers the
// whole team, Coolify's "All resources in the team"), and a token's Edit, Pause and Roll actions.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson } from "../lib/api";
import { ago } from "../lib/ago";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Checkbox, CopyButton, Empty, FormInput, Helper, Listbox, ModalConfirmation, ModalInput, SettingsSection, StatusBadge } from "../components/Coolify";
import { SecurityLayout } from "./SecurityLayout";

interface ApiToken {
  id: number;
  name: string;
  abilities: string[];
  lastUsedAt: string | null;
  createdAt: string;
  expiresAt: string | null;
}

interface TokensPage {
  tokens: ApiToken[];
  canUseRootPermissions: boolean;
  canUseWritePermissions: boolean;
  canUseDeployPermissions: boolean;
  canUseSensitivePermissions: boolean;
  canUseDeletePermissions: boolean;
  canUseTeamScope: boolean;
  expirationOptions: Array<{ value: string; label: string }>;
}

/** The permission checkboxes, in the partial's order. */
const PERMISSIONS: Array<{ value: string; label: string; helper: string; can: keyof TokensPage | null }> = [
  { value: "root", label: "Root", helper: "Full access to every API operation.", can: "canUseRootPermissions" },
  { value: "write", label: "Write", helper: "Create and update resources.", can: "canUseWritePermissions" },
  { value: "delete", label: "Delete", helper: "Delete resources and their settings (every DELETE request).", can: "canUseDeletePermissions" },
  {
    value: "deploy",
    label: "Deploy",
    helper: "Deploy, start, stop, and restart resources. With Write, also apply changes that run on servers immediately, such as scheduled tasks, proxy configuration, and imports.",
    can: "canUseDeployPermissions",
  },
  { value: "read", label: "Read", helper: "Read non-sensitive resource data.", can: null },
  { value: "read:sensitive", label: "Read sensitive data", helper: "Include secrets, logs, passwords, and Compose content.", can: "canUseSensitivePermissions" },
];

const NO_PERMISSION: Record<string, string> = {
  root: "You do not have permission to use root permissions.",
  write: "You do not have permission to use write permissions.",
  deploy: "You do not have permission to use deploy permissions.",
  "read:sensitive": "You do not have permission to use read:sensitive permissions.",
  delete: "You do not have permission to use delete permissions.",
};

/** ApiTokenForm::updatedPermissions() for one checkbox. */
export function togglePermission(current: string[], value: string, checked: boolean, page: Pick<TokensPage, "canUseRootPermissions" | "canUseWritePermissions" | "canUseDeployPermissions" | "canUseSensitivePermissions" | "canUseDeletePermissions">): { permissions: string[]; error: string | null } {
  const can = PERMISSIONS.find((p) => p.value === value)?.can;
  if (checked && can && !page[can as keyof typeof page]) return { permissions: current.filter((p) => p !== value), error: NO_PERMISSION[value] ?? null };
  let next = checked ? [...new Set([...current, value])] : current.filter((p) => p !== value);
  if (value === "root" && next.includes("root")) next = ["root"];
  else if (value === "read:sensitive" && checked && !next.includes("read")) next.push("read");
  else if (next.length === 0) next = ["read"];
  return { permissions: next.sort(), error: null };
}

/** The badge colours of an ability. */
function abilityClass(ability: string): string {
  const base = "inline-flex min-h-5 items-center rounded-md border px-2 py-0.5 text-[10px] font-medium";
  if (ability === "root" || ability === "delete") return `${base} border-error/20 bg-error/10 text-error`;
  if (ability === "write" || ability === "write:sensitive") return `${base} border-warning/20 bg-warning/10 text-warning`;
  if (ability === "deploy") return `${base} border-coollabs/20 bg-coollabs/10 text-coollabs dark:border-brand-light/20 dark:bg-brand/15 dark:text-brand-light`;
  return `${base} border-neutral-200 bg-neutral-100 text-neutral-600 dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-fg-dim`;
}

const day = (iso: string) => iso.slice(0, 10);

function NewTokenForm({ page, onCreate, onCancel }: { page: TokensPage; onCreate: (form: { description: string; expiresInDays: string; permissions: string[] }) => Promise<void>; onCancel: () => void }) {
  const [description, setDescription] = useState("");
  const [expiresInDays, setExpiresInDays] = useState("30");
  const [permissions, setPermissions] = useState<string[]>(["read"]);
  const [scopeMode, setScopeMode] = useState("team");
  const [saving, setSaving] = useState(false);
  const isRoot = permissions.includes("root");
  const summary = permissions.map((p) => p.split(":").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")).join(", ");
  const expiryOptions = [...page.expirationOptions, { value: "", label: "Never" }];
  return (
    <form
      className="lg:w-3xl"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        await onCreate({ description, expiresInDays, permissions });
        setSaving(false);
      }}
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <FormInput id="form.description" label="Description" placeholder="CI deployment token" required value={description} onChange={setDescription} />
        <Listbox id="form.expiresInDays" label="Expires in" options={expiryOptions} value={expiresInDays} onChange={setExpiresInDays} />
      </div>

      <div className="mt-4 border-t border-neutral-200 pt-3 dark:border-white/[0.08]">
        <div className="mb-2 flex items-center gap-2">
          <h4 className="text-[12px] font-semibold text-black dark:text-fg">Permissions</h4>
          <Helper helper="Only grant the abilities this token needs." />
        </div>
        <p className="mb-1 truncate text-[12px] text-neutral-500 dark:text-fg-dim">{`Selected permissions: ${summary}`}</p>
        <div className="flex flex-col">
          {PERMISSIONS.map((p) => (
            <Checkbox
              key={p.value}
              id={`permission-${p.value.replace(":", "-")}`}
              label={p.label}
              helper={p.helper}
              fullWidth
              checked={permissions.includes(p.value)}
              disabled={(p.value !== "root" && isRoot) || (p.can !== null && !page[p.can])}
              onChange={(checked) => {
                const r = togglePermission(permissions, p.value, checked, page);
                if (r.error) notify.error(r.error);
                setPermissions(r.permissions);
              }}
            />
          ))}
        </div>
      </div>

      <div className="mt-4 border-t border-neutral-200 pt-3 dark:border-white/[0.08]">
        <div className="mb-2 flex items-center gap-2">
          <h4 className="text-[12px] font-semibold text-black dark:text-fg">Access</h4>
          <Helper helper="A limited token sees only the selected projects, environments, and resources, and cannot use team-level endpoints such as servers, keys, or notifications." />
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Listbox
            id="form.scopeMode"
            label="Resources"
            options={[
              { value: "team", label: "All resources in the team", disabled: !page.canUseTeamScope },
              // Not ported: tokens limited to some projects, environments or resources.
              { value: "selected", label: "Selected projects, environments, or resources", disabled: true },
            ]}
            value={scopeMode}
            onChange={setScopeMode}
          />
        </div>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-highlighted" disabled={saving}>
          Create token
        </button>
      </div>
    </form>
  );
}

function ApiTokensContent() {
  const { me } = useSignedIn();
  const base = `/v1/organizations/${me.team?.id ?? ""}/api-tokens`;
  const [page, setPage] = useState<TokensPage | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  /** getTokens() */
  const reload = useCallback(async () => {
    const r = await getJson<TokensPage>(base);
    if (!r.data) {
      if (r.status !== 401) notify.error("Failed to load API tokens.");
      return;
    }
    setPage(r.data);
  }, [base]);
  useEffect(() => {
    void reload();
  }, [reload]);

  /** tokenSearchIndex: the name, the abilities and "All resources in the team". */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const tokens = page?.tokens ?? [];
    return q ? tokens.filter((t) => [t.name, ...t.abilities, "All resources in the team"].join(" ").toLowerCase().includes(q)) : tokens;
  }, [page, search]);

  /** addNewToken() */
  const create = async (form: { description: string; expiresInDays: string; permissions: string[] }) => {
    const r = await postJson<{ token: string }>(base, { description: form.description, expiresInDays: form.expiresInDays === "" ? null : form.expiresInDays, permissions: form.permissions, scopeMode: "team" });
    if (!r.ok) {
      notify.error(r.error.messages[0] ?? "Something went wrong.");
      return;
    }
    setCreateOpen(false);
    setIssued(r.data.token);
    await reload();
  };

  /** revoke($id) */
  const revoke = async (id: number) => {
    const r = await postJson<{ revoked: boolean }>(`${base}/${id}`, {}, "DELETE");
    if (!r.ok) notify.error(r.error.messages[0] ?? "Something went wrong.");
    await reload();
  };

  if (!page) return <SecurityLayout>{null}</SecurityLayout>;
  return (
    <div>
      <SecurityLayout>
        <div className="application-settings-form flex flex-col gap-6">
          <SettingsSection
            title="Issued tokens"
            flush
            actions={
              <button type="button" className="button button-highlighted" onClick={() => setCreateOpen(true)}>
                <Reicon name="plus" className="size-3.5" />
                New token
              </button>
            }
          >
            <div>
              {page.tokens.length > 1 ? (
                <div className="flex items-center gap-2 border-b border-neutral-200 p-3 dark:border-white/[0.08]">
                  <div className="relative w-full max-w-sm">
                    <Reicon name="search" className="pointer-events-none absolute top-1/2 left-2.5 z-10 size-3.5 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      type="search"
                      placeholder="Search tokens"
                      aria-label="Search tokens"
                      className="h-8! w-full rounded-lg! border-neutral-200! bg-white! py-0! pr-8! pl-8! text-[12px]! shadow-none! placeholder:text-neutral-400 focus:border-accent! focus:ring-0! dark:border-white/[0.08]! dark:bg-white/[0.035]! dark:text-fg! dark:placeholder:text-fg-faint"
                    />
                    {search ? (
                      <button
                        type="button"
                        onClick={() => setSearch("")}
                        className="absolute top-1/2 right-2 flex size-5 -translate-y-1/2 items-center justify-center rounded text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.07] dark:hover:text-fg"
                        aria-label="Clear search"
                      >
                        <Reicon name="x" className="size-3" />
                      </button>
                    ) : null}
                  </div>
                  <Helper label="Search help" helper="Search by token name, ability, or the name of a project, environment, or resource that the token can use." />
                </div>
              ) : null}

              {page.tokens.length === 0 ? (
                <div className="p-4">
                  <Empty title="No API tokens" description="Create a token when an external client needs access." iconName="keys" size="sm" />
                </div>
              ) : filtered.length === 0 ? (
                <div className="p-4">
                  <Empty size="sm" title="No matching tokens" description="Try a different description or permission." />
                </div>
              ) : (
                <div className="data-table">
                  <div className="data-table-header api-tokens-table-grid">
                    <span>Description</span>
                    <span>Permissions</span>
                    <span>Last used</span>
                    <span>Created</span>
                    <span>Expires</span>
                    <span className="text-right">Actions</span>
                  </div>
                  {filtered.map((token) => (
                    <div key={token.id} className="data-table-row api-tokens-table-grid border-b border-neutral-200 last:border-b-0 dark:border-white/[0.07]">
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-[12px] font-medium text-black dark:text-fg">{token.name}</span>
                        </div>
                        <div className="truncate text-[11px] text-neutral-500 dark:text-fg-dim">All resources in the team</div>
                      </div>
                      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                        {token.abilities.map((ability) => (
                          <span key={ability} className={abilityClass(ability)}>
                            {ability}
                          </span>
                        ))}
                      </div>
                      <div className="text-[11px] text-neutral-500 dark:text-fg-dim">{token.lastUsedAt ? ago(token.lastUsedAt) : "Never"}</div>
                      <div className="text-[11px] text-neutral-500 dark:text-fg-dim">{day(token.createdAt)}</div>
                      <div className="text-[11px] text-neutral-500 dark:text-fg-dim">
                        {!token.expiresAt ? "Never" : Date.parse(token.expiresAt) < Date.now() ? <StatusBadge label="Expired" type="error" /> : day(token.expiresAt)}
                      </div>
                      <div className="flex items-center justify-end gap-1">
                        <ModalConfirmation
                          title="Confirm API Token Revocation?"
                          actions={["This API token will be permanently revoked."]}
                          confirmationText={token.name}
                          confirmationLabel="Enter the token description to confirm"
                          shortConfirmationLabel="Token description"
                          step2ButtonText="Revoke token"
                          trigger={
                            <button type="button" className="button text-error!">
                              Revoke
                            </button>
                          }
                          onSubmit={() => revoke(token.id)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </SettingsSection>
        </div>

        <ModalInput title="New API token" open={createOpen} onOpenChange={setCreateOpen} closeOutside={false} trigger={<span className="hidden" aria-hidden="true" />}>
          <NewTokenForm page={page} onCreate={create} onCancel={() => setCreateOpen(false)} />
        </ModalInput>

        <ModalInput title="Copy your token" open={issued !== null} onOpenChange={(open) => (open ? undefined : setIssued(null))} closeOutside={false} trigger={<span className="hidden" aria-hidden="true" />}>
          <div className="flex flex-col gap-3 lg:w-2xl">
            <p className="text-sm text-neutral-500 dark:text-fg-dim">Copy the token now. It is not shown again after you close this window.</p>
            <div className="relative">
              <input type="text" value={issued ?? ""} readOnly onFocus={(e) => e.currentTarget.select()} className="input w-full pr-12! font-mono text-[12px] text-black dark:text-fg" />
              <CopyButton value={issued ?? ""} label="Copy token" className="absolute top-1/2 right-2 -translate-y-1/2" />
            </div>
            <div className="flex justify-end">
              <button type="button" className="button button-highlighted" onClick={() => setIssued(null)}>
                Done
              </button>
            </div>
          </div>
        </ModalInput>
      </SecurityLayout>
    </div>
  );
}

export function ApiTokensPage() {
  return (
    <Layout title="Keys & Tokens" href="/security/api-tokens" documentTitle="API Tokens">
      <ApiTokensContent />
    </Layout>
  );
}
