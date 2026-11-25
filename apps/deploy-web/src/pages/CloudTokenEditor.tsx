// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/security/cloud-provider-token-form.blade.php,
// resources/views/livewire/security/cloud-provider-token/show.blade.php,
// app/Livewire/Security/CloudProviderTokenForm.php and
// app/Livewire/Security/CloudProviderToken/Show.php (Apache-2.0), modified.
//
// A cloud provider token's forms: the "New Cloud Token" form (the provider is
// asked whether the token works before it is stored), the "Edit Cloud Token"
// dialog, and the token's own page /security/cloud-tokens/{uuid}. The token
// itself is never loaded: Coolify does not show it again once stored.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, FormInput, FormTextarea, Listbox, ModalConfirmation, SettingsSection, UnsavedBar } from "../components/Coolify";
import { fieldErrors, formatCreated, SecurityLayout } from "./SecurityLayout";

export interface CloudTokenShow {
  uuid: string;
  name: string;
  description: string | null;
  provider: string;
  providerName: string;
  createdAt: string | null;
  canUpdate: boolean;
}

const PROVIDER_OPTIONS = [
  { value: "hetzner", label: "Hetzner" },
  { value: "digitalocean", label: "DigitalOcean" },
  { value: "vultr", label: "Vultr" },
  { value: "hostinger", label: "Hostinger" },
];

/** The form's Alpine getters: providerName and providerConsoleUrl. */
function providerLabel(provider: string): string {
  return provider === "digitalocean" ? "DigitalOcean" : provider.charAt(0).toUpperCase() + provider.slice(1);
}
function providerConsoleUrl(provider: string): string {
  if (provider === "hetzner") return "https://console.hetzner.com/projects";
  if (provider === "vultr") return "https://console.vultr.com/user/apiaccess/";
  if (provider === "hostinger") return "https://hpanel.hostinger.com/profile/api";
  return "https://cloud.digitalocean.com/account/api/tokens";
}

/**
 * cloud-provider-token-form.blade.php. `provider` locks the provider (the
 * server page adds a token of the server's provider); onAdded is tokenAdded.
 */
export function CloudTokenForm({ base, provider: locked, onAdded }: { base: string; provider?: string; onAdded: (uuid: string) => void }) {
  const [provider, setProvider] = useState(locked ?? "hetzner");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState(false);

  async function addToken(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setAdding(true);
    const r = await postJson<{ uuid: string; message: string }>(base, { provider, token, name, description });
    setAdding(false);
    if (!r.ok) {
      const inline = fieldErrors(r.error.fields, ["provider", "token", "name", "description"]);
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    // $this->reset(['token', 'name', 'description'])
    setToken("");
    setName("");
    setDescription("");
    notify.success(r.data.message);
    onAdded(r.data.uuid);
  }

  return (
    <div className="w-full">
      <form className="application-settings-form flex w-full flex-col gap-4" onSubmit={(e) => void addToken(e)}>
        {locked ? <input type="hidden" value={provider} readOnly /> : <Listbox required id="provider" label="Provider" options={PROVIDER_OPTIONS} value={provider} onChange={setProvider} error={errors.provider} />}

        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-[11px] leading-5 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.05] dark:text-fg-dim">
          Create the token in the{" "}
          <a href={providerConsoleUrl(provider)} target="_blank" rel="noreferrer" className="font-medium text-coollabs hover:underline dark:text-brand-light">
            <span>{`${providerLabel(provider)} console`}</span>
          </a>
          .
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <FormInput required id="name" label="Token name" placeholder={`Production ${providerLabel(provider)} token`} value={name} onChange={setName} error={errors.name} />
          <FormInput required type="password" id="token" label="API token" placeholder="Paste the provider token" value={token} onChange={setToken} error={errors.token} />
          <div className="lg:col-span-2">
            <FormTextarea
              id="description"
              label="Description"
              rows={3}
              monospace={false}
              placeholder="Optional notes about where this token is used"
              value={description}
              onChange={setDescription}
              error={errors.description}
            />
          </div>
        </div>

        <div className="flex justify-end border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
          <Button type="submit" highlighted disabled={adding}>
            Validate and add
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Show's state and actions: mount(), save(), validateToken() and delete(). */
function useCloudToken(base: string, uuid: string, onMissing: () => void) {
  const [data, setData] = useState<CloudTokenShow | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const r = await getJson<CloudTokenShow>(`${base}/${encodeURIComponent(uuid)}`);
    if (!r.data) {
      // mount() aborts with 404.
      onMissing();
      return;
    }
    setData(r.data);
    setName(r.data.name);
    setDescription(r.data.description ?? "");
  }, [base, uuid, onMissing]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save(): Promise<boolean> {
    setSaving(true);
    const r = await postJson<{ message: string }>(`${base}/${encodeURIComponent(uuid)}`, { name, description }, "PATCH");
    setSaving(false);
    if (!r.ok) {
      const inline = fieldErrors(r.error.fields, ["name", "description"]);
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return false;
    }
    setErrors({});
    notify.success(r.data.message);
    await load();
    return true;
  }

  async function validateToken() {
    const r = await postJson<{ valid: boolean; message: string }>(`${base}/${encodeURIComponent(uuid)}/validate`, {});
    if (!r.ok) return notify.error(summarize(r.error.messages));
    if (r.data.valid) notify.success(r.data.message);
    else notify.error(r.data.message);
  }

  async function remove(): Promise<boolean> {
    const r = await postJson<{ deleted: boolean }>(`${base}/${encodeURIComponent(uuid)}`, {}, "DELETE");
    if (!r.ok) {
      notify.error(summarize(r.error.messages));
      return false;
    }
    return true;
  }

  const dirty = data !== null && (name !== data.name || description !== (data.description ?? ""));
  return { data, name, setName, description, setDescription, errors, saving, dirty, save, validateToken, remove };
}

/** The four fields both forms of show.blade.php share. */
function TokenFields({ token }: { token: ReturnType<typeof useCloudToken> & { data: CloudTokenShow } }) {
  const disabled = !token.data.canUpdate;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <FormInput id="name" label="Name" required value={token.name} onChange={token.setName} disabled={disabled} error={token.errors.name} />
      <FormInput id="description" label="Description" value={token.description} onChange={token.setDescription} disabled={disabled} error={token.errors.description} />
      <FormInput readOnly label="Provider" value={token.data.providerName} />
      <FormInput readOnly label="Created" value={formatCreated(token.data.createdAt)} />
    </div>
  );
}

/** show.blade.php in modal mode: the "Edit Cloud Token" dialog. onChanged is securityResourceChanged + close-modal. */
export function CloudTokenEditor({ base, uuid, onChanged }: { base: string; uuid: string; onChanged: () => void }) {
  const missing = useCallback(() => {
    notify.error("Cloud token not found.");
    onChanged();
  }, [onChanged]);
  const token = useCloudToken(base, uuid, missing);
  const { data } = token;
  if (!data) return null;
  return (
    <div>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          void token.save().then((saved) => saved && onChanged());
        }}
      >
        <TokenFields token={{ ...token, data }} />
        <div className="flex items-center justify-between gap-2 border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
          <div className="flex items-center gap-2">
            {data.canUpdate ? (
              <ModalConfirmation
                title="Confirm Token Deletion?"
                buttonTitle="Delete"
                actions={["This cloud provider token will be permanently deleted."]}
                confirmationText={data.name}
                step2ButtonText="Delete token"
                onSubmit={async () => {
                  if (await token.remove()) onChanged();
                }}
              />
            ) : null}
            <Button disabled={!data.canUpdate} onClick={() => void token.validateToken()}>
              Validate
            </Button>
          </div>
          <button {...({ ishighlighted: "" } as object)} className="button" type="submit" disabled={!data.canUpdate}>
            Save changes
          </button>
        </div>
      </form>
    </div>
  );
}

/** The token's uuid from /security/cloud-tokens/{uuid}. */
function uuidFromPath(pathname = window.location.pathname): string {
  return decodeURIComponent(pathname.split("/")[3] ?? "");
}

const toList = () => window.location.replace("/security/cloud-tokens");

function CloudTokenShowContent() {
  const { me } = useSignedIn();
  const base = `/v1/organizations/${me.team?.id ?? ""}/deploy/cloud-tokens`;
  const token = useCloudToken(base, uuidFromPath(), toList);
  const { data } = token;
  useEffect(() => {
    if (data) document.title = `${data.name} | Cloud Tokens | Freeploy`;
  }, [data]);
  if (!data) return null;
  const save = () => void token.save();
  return (
    <div>
      <SecurityLayout
        actions={
          <>
            <Button disabled={!data.canUpdate} onClick={() => void token.validateToken()}>
              <Reicon name="check-circle" className="size-3.5" />
              Validate
            </Button>
            {data.canUpdate ? (
              <ModalConfirmation
                title="Confirm Token Deletion?"
                buttonTitle="Delete"
                actions={["This cloud provider token will be permanently deleted.", "Servers using this token will need to be reconfigured."]}
                confirmationText={data.name}
                confirmationLabel="Enter the token name to confirm deletion"
                shortConfirmationLabel="Token name"
                step2ButtonText="Delete token"
                onSubmit={async () => {
                  // redirectRoute($this, 'security.cloud-tokens')
                  if (await token.remove()) window.location.assign("/security/cloud-tokens");
                }}
              />
            ) : null}
          </>
        }
      >
        <form
          className="application-settings-form"
          onSubmit={(e: FormEvent<HTMLFormElement>) => {
            e.preventDefault();
            save();
          }}
        >
          <UnsavedBar dirty={token.dirty} saving={token.saving} onSave={save} />
          <SettingsSection title="General" helper="Identity and provider details for this cloud API credential.">
            <TokenFields token={{ ...token, data }} />
          </SettingsSection>
        </form>
      </SecurityLayout>
    </div>
  );
}

export function CloudTokenShowPage() {
  return (
    <Layout title="Keys & Tokens" href="/security/cloud-tokens" documentTitle="Cloud Tokens">
      <CloudTokenShowContent />
    </Layout>
  );
}
