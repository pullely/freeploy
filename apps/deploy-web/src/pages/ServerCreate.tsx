// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/{create-page,create}.blade.php,
// resources/views/livewire/server/new/by-ip.blade.php,
// resources/views/livewire/server/new/partials/image-scanning.blade.php,
// resources/views/components/{digital-ocean-icon,hostinger-icon}.blade.php and
// app/Livewire/Server/{CreatePage,Create}.php, app/Livewire/Server/New/ByIp.php (Apache-2.0), modified.
//
// /servers/new: how to add a server; /servers/new/manual: ByIp, a server you
// already manage, by IP address or domain. The server is stored unvalidated,
// then its page opens, as Coolify redirects to server.show.
// DP-118: the method list also offers provisioning with a cloud provider
// (Hetzner, Vultr, DigitalOcean, Hostinger): ServerCreateCloud.tsx.
import { useCallback, useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Collapsible, FormInput, Listbox, ModalInput, SettingsSection } from "../components/Coolify";
import { CreatePrivateKey } from "./PrivateKeys";
import { SERVER_ROLE_OPTIONS as ROLE_OPTIONS } from "./ServerChrome";


/** Alpine's `@click="dropdownOpen = false"`: close the menu the clicked item is in. */
function closeMenu(e: MouseEvent<HTMLElement>): void {
  const panel = e.currentTarget.closest<HTMLElement>(".listbox-panel");
  if (!panel) return;
  panel.style.display = "none";
  panel.removeAttribute("data-open");
}

/** livewire/server/new/by-ip. */
function ByIp() {
  const { me } = useSignedIn();
  const orgBase = `/v1/organizations/${me.team?.id ?? ""}/deploy`;
  const [loaded, setLoaded] = useState(false);
  const [keys, setKeys] = useState<Array<{ uuid: string; name: string }>>([]);
  const [canCreateKey, setCanCreateKey] = useState(false);
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [ip, setIp] = useState("");
  const [user, setUser] = useState("root");
  const [port, setPort] = useState("22");
  const [role, setRole] = useState("both");
  const [scanImages, setScanImages] = useState("off");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [addOpen, setAddOpen] = useState(false);

  /** mount(): a random name, the first key preselected; handlePrivateKeyCreated() selects a new one. */
  const load = useCallback(
    async (select?: string) => {
      const r = await getJson<{ name: string; privateKeys: Array<{ uuid: string; name: string }>; canCreatePrivateKey: boolean }>(`${orgBase}/servers/new`);
      if (!r.data) {
        if (r.status === 404) window.location.replace("/servers");
        return;
      }
      setKeys(r.data.privateKeys);
      setCanCreateKey(r.data.canCreatePrivateKey);
      if (select) {
        setPrivateKey(select);
        setErrors((e) => {
          const rest = { ...e };
          delete rest.private_key_uuid;
          return rest;
        });
      } else {
        setName((n) => n || r.data!.name);
        setPrivateKey((k) => k ?? r.data!.privateKeys[0]?.uuid ?? null);
      }
      setLoaded(true);
    },
    [orgBase],
  );
  useEffect(() => {
    void load();
  }, [load]);

  async function generate(type: "ed25519" | "rsa") {
    const r = await postJson<{ uuid: string }>(`${orgBase}/private-keys/generate`, { type });
    if (!r.ok) return notify.error(summarize(r.error.messages));
    await load(r.data.uuid);
    notify.success("Private key created successfully.");
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // The key dialog's own form submits through the React tree too.
    if (e.target !== e.currentTarget) return;
    const r = await postJson<{ uuid: string }>(`${orgBase}/servers`, {
      private_key_uuid: privateKey,
      name,
      description,
      ip,
      user,
      port,
      server_role: role,
      scan_images: scanImages,
    });
    if (!r.ok) {
      const fields = r.error.fields ?? {};
      const inline: Record<string, string> = {};
      for (const [f, m] of Object.entries(fields)) if (m[0]) inline[f] = m[0];
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    window.location.assign(`/server/${r.data.uuid}`);
  }

  if (!loaded) return null;
  return (
    <div className="w-full">
      <form onSubmit={(e) => void submit(e)}>
        <SettingsSection
          title="Connect a server"
          helper="Add an existing Linux server using its SSH connection details."
          actions={
            <button type="submit" className="button button-highlighted">
              Continue
              <Reicon name="arrow-right" className="size-3.5" />
            </button>
          }
        >
          <div className="mb-5">
            <FormInput id="ip" label="IP address or domain" required helper="For example 127.0.0.1 or server.example.com." value={ip} onChange={setIp} error={errors.ip} />
          </div>
          <div className="mb-5">
            <div className="flex items-end gap-3">
              <div className="min-w-0 flex-1">
                <Listbox
                  id="private_key_id"
                  label="Private key"
                  placeholder="Select a private key"
                  options={keys.map((k) => ({ value: k.uuid, label: k.name }))}
                  value={privateKey}
                  onChange={setPrivateKey}
                  error={errors.private_key_uuid}
                />
              </div>
              {canCreateKey ? (
                <div className="relative shrink-0">
                  <button type="button" className="button" aria-haspopup="menu" aria-expanded="false">
                    <Reicon name="plus" className="size-3.5" />
                    New key
                    <Reicon name="chevron-down" className="size-3 opacity-55" />
                  </button>
                  <div role="menu" className="listbox-panel left-auto! right-0! z-[90]! w-52! min-w-52!" style={{ display: "none" }}>
                    <button type="button" className="listbox-option justify-start! gap-2.5!" role="menuitem" onClick={(e) => (closeMenu(e), void generate("ed25519"))}>
                      <Reicon name="keys" className="size-3.5 shrink-0 opacity-70" />
                      Generate ED25519
                    </button>
                    <button type="button" className="listbox-option justify-start! gap-2.5!" role="menuitem" onClick={(e) => (closeMenu(e), void generate("rsa"))}>
                      <Reicon name="keys" className="size-3.5 shrink-0 opacity-70" />
                      Generate RSA
                    </button>
                    <ModalInput
                      title="Add Private Key Manually"
                      open={addOpen}
                      onOpenChange={setAddOpen}
                      trigger={
                        <button type="button" className="listbox-option justify-start! gap-2.5!" role="menuitem" onClick={closeMenu}>
                          <Reicon name="plus" className="size-3.5 shrink-0 opacity-70" />
                          Add manually
                        </button>
                      }
                    >
                      <CreatePrivateKey
                        base={`${orgBase}/private-keys`}
                        onCreated={(uuid) => {
                          setAddOpen(false);
                          void load(uuid);
                        }}
                      />
                    </ModalInput>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <div className="grid gap-4 border-t border-neutral-200 pt-4 lg:grid-cols-2 dark:border-white/[0.08]">
            <FormInput id="name" label="Name" required value={name} onChange={setName} error={errors.name} />
            <FormInput id="description" label="Description" value={description} onChange={setDescription} error={errors.description} />
          </div>
          <Collapsible className="mt-5 border-t border-neutral-200 pt-4 dark:border-white/[0.08]" contentClassName="flex flex-col gap-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <FormInput id="user" label="User" required helper="Non-root SSH users are experimental." value={user} onChange={setUser} error={errors.user} />
              <FormInput id="port" type="number" label="Port" required value={port} onChange={setPort} error={errors.port} />
            </div>
            <Listbox
              id="server_role"
              label="Server role"
              helper="Choose whether this server runs deployments, application builds, or both. GitHub Actions runners need the Builds only or the Deployments and builds role."
              options={ROLE_OPTIONS}
              value={role}
              onChange={setRole}
              error={errors.server_role}
            />
          </Collapsible>
        </SettingsSection>
        <SettingsSection title="Image scanning" helper="Scan the images on this server for known vulnerabilities. You can change this later in the security settings of the server.">
          <Listbox
            id="scan_images"
            label="Scan images for vulnerabilities"
            helper="By default, scans use up to 1 CPU and 1 GB of memory while they run, and about 1.2 GB of disk, plus temporary space for one image."
            options={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
            value={scanImages}
            onChange={setScanImages}
          />
        </SettingsSection>
      </form>
    </div>
  );
}

/** livewire/server/create: the method list, or the chosen method's form. */
function CreateContent({ manual }: { manual: boolean }) {
  return (
    <div className="w-full">
      <div className="mb-5 flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="min-w-0 text-[24px]! leading-7! font-semibold! tracking-tight!">New server</h1>
        <div className="flex flex-wrap items-center gap-2">
          {manual ? (
            <a href="/servers/new" className="button">
              Change method
            </a>
          ) : null}
        </div>
      </div>
      {manual ? (
        <div className="application-settings-form">
          <ByIp />
        </div>
      ) : (
        <div className="application-settings-form flex flex-col gap-6">
          <section className="application-settings-section">
            <div className="application-settings-section-header">
              <h2 className="application-settings-section-title">Add a server</h2>
              <p className="application-settings-section-description">Connect a server you already manage.</p>
            </div>
            <div className="application-settings-section-body is-flush">
              <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
                <a
                  href="/servers/new/manual"
                  className="group flex min-h-32 flex-col rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:no-underline hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14]"
                >
                  <div className="flex items-start">
                    <span className="flex size-8 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim">
                      <Reicon name="servers" className="size-4" />
                    </span>
                  </div>
                  <div className="mt-auto pt-5">
                    <h3 className="text-[13px]! font-semibold! text-black dark:text-fg">IP address or domain</h3>
                    <p className="mt-1 text-[11px] leading-4 text-neutral-500 dark:text-fg-faint">Connect an existing server over SSH.</p>
                  </div>
                </a>
              </div>
            </div>
          </section>
          {/* @can('viewAny', CloudProviderToken::class): a team admin's, as the page itself (DP-118). */}
          <section className="application-settings-section">
            <div className="application-settings-section-header">
              <h2 className="application-settings-section-title">Provision a server</h2>
              <p className="application-settings-section-description">Create a server with a cloud provider.</p>
            </div>
            <div className="application-settings-section-body is-flush">
              <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
                <ProviderCard href="/servers/new/hetzner" title="Hetzner" text="Provision from Hetzner Cloud." icon={<img src="/svgs/hetzner.svg" alt="Hetzner" className="size-8" />} />
                <ProviderCard href="/servers/new/vultr" title="Vultr" text="Provision from Vultr Cloud." icon={<span aria-hidden="true" className="flex size-8 items-center justify-center rounded bg-[#007bfc] text-sm font-bold text-white">V</span>} />
                <ProviderCard href="/servers/new/digital-ocean" title="DigitalOcean" text="Provision a new Droplet." icon={<DigitalOceanIcon className="size-8" />} />
                <ProviderCard href="/servers/new/hostinger" title="Hostinger" text="Purchase and provision a new VPS." icon={<HostingerIcon className="size-8 text-[#673de6]" />} darker={false} />
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/** A provider's card of "Provision a server" (Hostinger's is a little lighter in dark mode, as Coolify's). */
function ProviderCard({ href, title, text, icon, darker = true }: { href: string; title: string; text: string; icon: ReactNode; darker?: boolean }) {
  return (
    <a
      href={href}
      className={`group flex min-h-32 flex-col rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:no-underline hover:shadow-md dark:border-white/[0.08] ${darker ? "dark:bg-white/[0.05]" : "dark:bg-white/[0.025]"} dark:hover:border-white/[0.14]`}
    >
      <div className="flex items-start">{icon}</div>
      <div className="mt-auto pt-5">
        <h3 className="text-[13px]! font-semibold! text-black dark:text-fg">{title}</h3>
        <p className="mt-1 text-[11px] leading-4 text-neutral-500 dark:text-fg-faint">{text}</p>
      </div>
    </a>
  );
}

/** <x-digital-ocean-icon> */
function DigitalOceanIcon({ className }: { className: string }) {
  return (
    <svg className={`${className} shrink-0`} fill="#0080FF" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <title>DigitalOcean</title>
      <path d="M12.04 0C5.408-.02.005 5.37.005 11.992h4.638c0-4.923 4.882-8.731 10.064-6.855a6.95 6.95 0 014.147 4.148c1.889 5.177-1.924 10.055-6.84 10.064v-4.61H7.391v4.623h4.61V24c7.86 0 13.967-7.588 11.397-15.83-1.115-3.59-3.985-6.446-7.575-7.575A12.8 12.8 0 0012.039 0zM7.39 19.362H3.828v3.564H7.39zm-3.563 0v-2.978H.85v2.978z" />
    </svg>
  );
}

/** <x-hostinger-icon> */
function HostingerIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 26 30" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Hostinger">
      <title>Hostinger</title>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M0.000249566 14.046V0.000497794L6.99464 3.78046V10.1086L16.2538 10.1132L23.3617 14.046H0.000249566ZM18.1472 8.95059V0L25.3302 3.68591V13.1797L18.1472 8.95059ZM18.1472 26.1177V19.8441L8.81663 19.8376C8.82534 19.8793 1.59081 15.8418 1.59081 15.8418L25.3302 15.9547V30L18.1472 26.1177ZM0 26.1177L0.000248849 16.9393L6.99464 21.0683V29.8033L0 26.1177Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** CreatePage: /servers/new and /servers/new/manual ("Manual"). */
export function ServerCreatePage({ manual }: { manual: boolean }) {
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle={manual ? "Manual" : "New Server"}>
      <CreateContent manual={manual} />
    </Layout>
  );
}
