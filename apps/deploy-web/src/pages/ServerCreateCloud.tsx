// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/{create-page,create}.blade.php,
// resources/views/livewire/server/new/{by-hetzner,by-vultr,by-digital-ocean,by-hostinger}.blade.php,
// resources/views/livewire/server/new/partials/image-scanning.blade.php,
// resources/views/components/server/provider-token-picker.blade.php, resources/views/components/skeleton/form.blade.php
// and app/Livewire/Server/New/{ByHetzner,ByVultr,ByDigitalOcean,ByHostinger}.php (Apache-2.0), modified.
//
// DP-118: /servers/new/{type} and /servers/new/{type}/{token_uuid}, the create-a-cloud-server flow of Hetzner, Vultr,
// DigitalOcean and Hostinger. Step 1 picks one of the provider's tokens (or adds one: CloudProviderTokenForm, then the
// token's page, as handleTokenAdded() → nextStep() redirects); step 2 loads the provider's catalogue (wire:init) and is
// the component's form. Submitting makes the server at the provider and stores it; validating it needs the SSH executor,
// so the API answers 501 after the row is stored, and the server's page opens with that message (Coolify redirects to
// server.show and queues the validation). The components' computed properties are lib/cloud-server.ts. Coolify's
// affiliate links ("New to Hetzner? Create an account through Coolify's affiliate link.") are left out: they are
// Coolify's referral program, not Freeploy's.
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Layout, useSignedIn } from "../layout/Layout";
import { getJson, postJson, summarize } from "../lib/api";
import { flashNotice } from "../lib/flash";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Callout, Checkbox, Empty, FormInput, FormTextarea, Listbox, Loading, ModalInput, SettingsSection } from "../components/Coolify";
import { CloudTokenForm } from "./CloudTokenEditor";
import { CreatePrivateKey } from "./PrivateKeys";
import {
  cloudRoute,
  digitalOceanAdvancedSummary,
  digitalOceanImageOptions,
  digitalOceanInRegion,
  digitalOceanRegionOptions,
  digitalOceanSelectedPrice,
  digitalOceanSizeOptions,
  hetznerAdvancedSummary,
  hetznerAvailableImages,
  hetznerAvailableNetworks,
  hetznerAvailableServerTypes,
  hetznerImageOptions,
  hetznerLocationOptions,
  hetznerSelectedPrice,
  hetznerServerTypeOptions,
  hostingerAppTemplates,
  hostingerDataCenterOptions,
  hostingerOsTemplates,
  hostingerPriceLabel,
  hostingerPriceOptions,
  hostingerTemplateChoice,
  hostingerTemplateOptions,
  PROVIDER_LABEL,
  scriptOptions,
  sshKeyOptions,
  vultrAdvancedSummary,
  vultrAvailablePlans,
  vultrOsOptions,
  vultrPlanOptions,
  vultrRegionOptions,
  vultrSelectedPrice,
  type CloudType,
  type DigitalOceanCatalog,
  type HetznerCatalog,
  type HostingerCatalog,
  type Item,
  type VultrCatalog,
} from "../lib/cloud-server";

interface Mount {
  type: CloudType;
  provider: string;
  providerName: string;
  title: string;
  tokens: Array<{ uuid: string; name: string | null; description: string | null }>;
  selectedTokenUuid: string | null;
  currentStep: 1 | 2;
  serverName: string;
  privateKeys: Array<{ uuid: string; name: string }>;
  privateKeyId: string | null;
  cloudInitScripts: Array<{ uuid: string; name: string }>;
  scanImages: "on" | "off";
  canCreatePrivateKey: boolean;
}

type Toasts = { toasts?: Array<{ type: string; message: string }> };
const showToasts = (data: Toasts | null | undefined) => {
  for (const t of data?.toasts ?? []) (t.type === "success" ? notify.success : notify.error)(t.message);
};

const ACCOUNT_LINK_HELP: Record<CloudType, string> = {
  hetzner: "This key is added to the Hetzner server automatically.",
  vultr: "This key is added to the Vultr server automatically.",
  "digital-ocean": "This key is added to the Droplet automatically.",
  hostinger: "This key is added to the Hostinger VPS automatically.",
};

/** <x-skeleton.form :fields="6">: a label and an input per field, two columns on wide screens. */
function SkeletonForm({ fields, label }: { fields: number; label: string }) {
  return (
    <div role="status" className="grid gap-4 md:grid-cols-2">
      <span className="sr-only">{label}</span>
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} aria-hidden="true" className="flex flex-col gap-2">
          <div aria-hidden="true" className={`animate-pulse bg-neutral-200/80 dark:bg-white/[0.06] h-2.5 ${i % 2 === 0 ? "w-24" : "w-32"} rounded-full`} />
          <div aria-hidden="true" className="animate-pulse bg-neutral-200/80 dark:bg-white/[0.06] h-9 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );
}

/** <x-server.provider-token-picker>: the provider's tokens as cards, or the empty state with Add token. */
function TokenPicker({ mount, orgBase }: { mount: Mount; orgBase: string }) {
  const label = mount.providerName;
  const [open, setOpen] = useState(false);
  return (
    <SettingsSection title={`${label} account`} helper="Choose the cloud credential Freeploy should use for this server." flush>
      {mount.tokens.length === 0 ? (
        <Empty title={`No ${label} tokens`} description="Add an API token to continue provisioning." iconName="keys" size="sm">
          <ModalInput
            title={`Add ${label} Token`}
            open={open}
            onOpenChange={setOpen}
            trigger={
              <button type="button" className="button button-highlighted">
                <Reicon name="plus" className="size-3.5" />
                Add token
              </button>
            }
          >
            {/* handleTokenAdded() → nextStep(): the token's page. */}
            <CloudTokenForm base={`${orgBase}/cloud-tokens`} provider={mount.provider} onAdded={(uuid) => window.location.assign(`/servers/new/${mount.type}/${encodeURIComponent(uuid)}`)} />
          </ModalInput>
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
          {mount.tokens.map((token) => (
            <a
              key={token.uuid}
              className="group flex min-h-28 min-w-0 flex-col rounded-xl border border-neutral-200 bg-white p-3 shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:no-underline hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14]"
              href={`/servers/new/${mount.type}/${encodeURIComponent(token.uuid)}`}
            >
              <div className="flex items-start gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-fg-dim">
                  <Reicon name="keys" className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-[13px]! font-semibold! text-black dark:text-fg">{token.name ?? `${label} token`}</h3>
                  <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-neutral-500 dark:text-fg-faint">{token.description || "Use this token to provision the server."}</p>
                </div>
              </div>
            </a>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

/** The private key listbox, or "A private key is required." with Create key (livewire:security.private-key.create). */
function PrivateKeyField(props: { mount: Mount; orgBase: string; value: string | null; onChange: (v: string) => void; onCreated: (uuid: string) => void; error?: string | undefined }) {
  const [open, setOpen] = useState(false);
  if (props.mount.privateKeys.length === 0) {
    return (
      <div>
        <label className="mb-1.5 flex w-fit items-center gap-1.5">
          Private key <span className="text-helper">*</span>
        </label>
        <div className="flex min-h-8 items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2">
          <span className="text-[11px] text-neutral-600 dark:text-fg-dim">A private key is required.</span>
          <ModalInput
            title="New Private Key"
            open={open}
            onOpenChange={setOpen}
            trigger={
              <button type="button" className="button">
                Create key
              </button>
            }
          >
            <CreatePrivateKey
              base={`${props.orgBase}/private-keys`}
              onCreated={(uuid) => {
                setOpen(false);
                props.onCreated(uuid);
              }}
            />
          </ModalInput>
        </div>
      </div>
    );
  }
  return (
    <Listbox
      id="private_key_id"
      label="Private key"
      required
      placeholder="Select a private key"
      options={props.mount.privateKeys.map((k) => ({ value: k.uuid, label: k.name }))}
      value={props.value}
      onChange={props.onChange}
      helper={ACCOUNT_LINK_HELP[props.mount.type]}
      error={props.error}
    />
  );
}

/** livewire.server.new.partials.image-scanning */
function ImageScanningSection({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <SettingsSection title="Image scanning" helper="Scan the images on this server for known vulnerabilities. You can change this later in the security settings of the server.">
      <Listbox
        id="scan_images"
        label="Scan images for vulnerabilities"
        helper="By default, scans use up to 1 CPU and 1 GB of memory while they run, and about 1.2 GB of disk, plus temporary space for one image."
        options={[
          { value: "off", label: "Off" },
          { value: "on", label: "On" },
        ]}
        value={value}
        onChange={onChange}
      />
    </SettingsSection>
  );
}

function SummaryChips({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span key={item} className="rounded-full bg-neutral-100 px-2 py-0.5 text-[10px] font-medium text-neutral-600 dark:bg-white/[0.06] dark:text-fg-dim">
          {item}
        </span>
      ))}
    </div>
  );
}

/** The cloud-init part of the advanced options (Hetzner and DigitalOcean behind "Add cloud-init script"; Vultr always open). */
interface CloudInit {
  show: boolean;
  script: string;
  save: boolean;
  name: string;
  selected: string;
}
const NO_CLOUD_INIT: CloudInit = { show: false, script: "", save: false, name: "", selected: "" };

function CloudInitFields(props: { state: CloudInit; set: (patch: Partial<CloudInit>) => void; scripts: Mount["cloudInitScripts"]; orgBase: string; alwaysOpen: boolean; errors: Record<string, string> }) {
  const { state, set } = props;
  /** updatedSelectedCloudInitScriptId(): the saved script's text and name. */
  async function choose(uuid: string) {
    set({ selected: uuid });
    if (!uuid) return;
    const r = await getJson<{ name: string; script: string | null }>(`${props.orgBase}/cloud-init-scripts/${encodeURIComponent(uuid)}`);
    if (!r.data) return;
    set({ selected: uuid, script: r.data.script ?? "", name: r.data.name, ...(props.alwaysOpen ? {} : { show: true }) });
  }
  if (!props.alwaysOpen && !state.show && state.script.trim() === "" && state.selected === "") {
    return (
      <div className="border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
        <button type="button" className="button" onClick={() => set({ show: true })}>
          <Reicon name="plus" className="size-3.5" />
          Add cloud-init script
        </button>
      </div>
    );
  }
  return (
    <div className="border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
      <div className="flex flex-col gap-4">
        <div className="grid items-end gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
          <Listbox id="selected_cloud_init_script_id" label="Saved cloud-init script" options={scriptOptions(props.scripts)} value={state.selected} onChange={(v) => void choose(v)} error={props.errors.selected_cloud_init_script_id} />
          {/* clearCloudInitScript() */}
          <button type="button" className="button" onClick={() => set({ selected: "", script: "", name: "", save: false, ...(props.alwaysOpen ? {} : { show: false }) })}>
            Clear
          </button>
        </div>
        <FormTextarea id="cloud_init_script" label="Cloud-init script" rows={8} monospace value={state.script} onChange={(v) => set({ script: v })} error={props.errors.cloud_init_script} />
        <div className="grid items-end gap-4 lg:grid-cols-2">
          {/* updatedSaveCloudInitScript(false): the name cleared (Vultr keeps it). */}
          <Checkbox id="save_cloud_init_script" label="Save this script for later" checked={state.save} onChange={(v) => set(v || props.alwaysOpen ? { save: v } : { save: v, name: "" })} />
          {state.save ? <FormInput id="cloud_init_script_name" label="Saved script name" value={state.name} onChange={(v) => set({ name: v })} error={props.errors.cloud_init_script_name} /> : null}
        </div>
      </div>
    </div>
  );
}

/** The submit button: "Buy and create", with the monthly price when the component has one. */
function BuyButton({ disabled, price }: { disabled: boolean; price: string | null }) {
  return (
    <button type="submit" className="button button-highlighted" disabled={disabled}>
      Buy and create
      {price ? <span className="opacity-70">· {price}/mo</span> : null}
    </button>
  );
}

const cloudInitBody = (c: CloudInit, withShow: boolean) => ({
  ...(withShow ? { show_cloud_init_script: c.show } : {}),
  cloud_init_script: c.script === "" ? null : c.script,
  save_cloud_init_script: c.save,
  cloud_init_script_name: c.name === "" ? null : c.name,
  selected_cloud_init_script_id: c.selected === "" ? null : c.selected,
});

/** What every form shares: the name, the key, image scanning, the errors and the submit. */
function useCommon(mount: Mount, orgBase: string, reloadKeys: (select: string) => void) {
  const [serverName, setServerName] = useState(mount.serverName);
  const [privateKey, setPrivateKey] = useState<string | null>(mount.privateKeyId);
  const [scanImages, setScanImages] = useState<string>(mount.scanImages);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const base = `${orgBase}/servers/new/${mount.type}/${encodeURIComponent(mount.selectedTokenUuid ?? "")}`;

  /** submit(): a 422's fields inline, toasts, or the stored server's page with the 501's message. */
  const submit = useCallback(
    async (e: FormEvent<HTMLFormElement>, body: Record<string, unknown>, shown: readonly string[]) => {
      e.preventDefault();
      if (e.target !== e.currentTarget) return;
      setSubmitting(true);
      const r = await postJson<Toasts>(base, { server_name: serverName, private_key_id: privateKey, scan_images: scanImages, ...body });
      setSubmitting(false);
      if (r.ok) {
        setErrors({});
        return showToasts(r.data);
      }
      const uuid = r.error.details?.uuid;
      if (r.error.status === 501 && typeof uuid === "string") {
        flashNotice(r.error.messages[0] ?? "");
        return window.location.assign(`/server/${encodeURIComponent(uuid)}`);
      }
      const inline: Record<string, string> = {};
      const elsewhere: string[] = [];
      for (const [field, messages] of Object.entries(r.error.fields ?? {})) {
        const key = field.replace(/\.\d+$/, "");
        if (shown.includes(key) || ["server_name", "private_key_id"].includes(key)) inline[key] ??= messages[0] ?? "";
        else elsewhere.push(...messages);
      }
      setErrors(inline);
      if (!r.error.fields) notify.error(summarize(r.error.messages));
      else if (elsewhere.length) notify.error(summarize(elsewhere));
    },
    [base, serverName, privateKey, scanImages],
  );

  const nameField = (helper: string) => (
    <div className="lg:col-span-2">
      <FormInput id="server_name" label="Server name" helper={helper} value={serverName} onChange={setServerName} error={errors.server_name} />
    </div>
  );
  const keyField = (
    <PrivateKeyField
      mount={mount}
      orgBase={orgBase}
      value={privateKey}
      onChange={setPrivateKey}
      onCreated={(uuid) => {
        // handlePrivateKeyCreated(): the keys again, the new one selected, its error cleared.
        setPrivateKey(uuid);
        setErrors((x) => {
          const rest = { ...x };
          delete rest.private_key_id;
          return rest;
        });
        reloadKeys(uuid);
      }}
      error={errors.private_key_id}
    />
  );
  const scanning = <ImageScanningSection value={scanImages} onChange={setScanImages} />;
  return { errors, submit, submitting, nameField, keyField, scanning, noKey: !privateKey };
}

type FormProps<C> = { mount: Mount; orgBase: string; catalog: C; reloadKeys: (select: string) => void };

function HetznerForm({ mount, orgBase, catalog, reloadKeys }: FormProps<HetznerCatalog>) {
  const common = useCommon(mount, orgBase, reloadKeys);
  const [location, setLocation] = useState<string | null>(null);
  const [serverType, setServerType] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [sshKeys, setSshKeys] = useState<string[]>([]);
  const [firewalls, setFirewalls] = useState<string[]>([]);
  const [networks, setNetworks] = useState<string[]>([]);
  const [ipv4, setIpv4] = useState(true);
  const [ipv6, setIpv6] = useState(true);
  const [backups, setBackups] = useState(false);
  const [cloudInit, setCloudInit] = useState<CloudInit>(NO_CLOUD_INIT);
  const types = useMemo(() => hetznerAvailableServerTypes(catalog.serverTypes, location), [catalog, location]);
  const images = useMemo(() => hetznerAvailableImages(catalog.images, catalog.serverTypes, serverType), [catalog, serverType]);
  const availableNetworks = useMemo(() => hetznerAvailableNetworks(catalog.hetznerNetworks, catalog.locations, location), [catalog, location]);
  const summary = hetznerAdvancedSummary({ sshKeys, firewalls, networks, enableBackups: backups, enableIpv4: ipv4, enableIpv6: ipv6, showCloudInit: cloudInit.show, cloudInitScript: cloudInit.script, selectedScript: cloudInit.selected });
  const e = common.errors;

  /** updatedSelectedLocation(): the type and image reset, the networks kept only where still available. */
  function chooseLocation(v: string) {
    setLocation(v);
    setServerType(null);
    setImage(null);
    const still = hetznerAvailableNetworks(catalog.hetznerNetworks, catalog.locations, v).map((n: Item) => String(n.id));
    setNetworks((ids) => ids.filter((id) => still.includes(id)));
  }

  const shown = ["selected_location", "selected_server_type", "selected_image", "selectedHetznerSshKeyIds", "selectedHetznerFirewallIds", "selectedHetznerNetworkIds", "cloud_init_script", "cloud_init_script_name", "selected_cloud_init_script_id"];
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(ev) =>
        void common.submit(
          ev,
          {
            selected_location: location,
            selected_server_type: serverType,
            selected_image: image,
            selectedHetznerSshKeyIds: sshKeys,
            selectedHetznerFirewallIds: firewalls,
            selectedHetznerNetworkIds: networks,
            enable_ipv4: ipv4,
            enable_ipv6: ipv6,
            enable_backups: backups,
            ...cloudInitBody(cloudInit, true),
          },
          shown,
        )
      }
    >
      <SettingsSection title="Hetzner server" helper="Choose the location, hardware, operating system, and Freeploy SSH key." actions={<BuyButton disabled={common.noKey || common.submitting} price={hetznerSelectedPrice(catalog.serverTypes, serverType)} />}>
        <div className="grid gap-4 lg:grid-cols-2">
          {common.nameField("A friendly name shown in Freeploy.")}
          <Listbox id="selected_location" label="Location" required placeholder="Select a location" options={hetznerLocationOptions(catalog.locations)} value={location} onChange={chooseLocation} error={e.selected_location} />
          {/* updatedSelectedServerType(): the image reset. */}
          <Listbox
            id="selected_server_type"
            label="Server type"
            required
            disabled={!location}
            placeholder="Select a server type"
            options={hetznerServerTypeOptions(types)}
            value={serverType}
            onChange={(v) => (setServerType(v), setImage(null))}
            error={e.selected_server_type}
          />
          <Listbox id="selected_image" label="Image" required disabled={!serverType} placeholder="Select an image" options={hetznerImageOptions(images)} value={image} onChange={setImage} error={e.selected_image} />
          {common.keyField}
        </div>
      </SettingsSection>

      <SettingsSection title="Advanced options" helper="Provider SSH keys, networking, backups, and cloud-init.">
        <SummaryChips items={summary} />
        <div className="flex flex-col gap-4">
          <Listbox
            id="selectedHetznerSshKeyIds"
            label="Extra SSH keys"
            helper="Existing keys from the Hetzner account."
            searchable
            disabled={catalog.hetznerSshKeys.length === 0}
            searchPlaceholder="Search SSH keys…"
            placeholder={catalog.hetznerSshKeys.length ? "Select SSH keys" : "No account keys found"}
            options={sshKeyOptions(catalog.hetznerSshKeys)}
            value={null}
            onChange={() => undefined}
            values={sshKeys}
            onValues={setSshKeys}
            error={e.selectedHetznerSshKeyIds}
          />
          <div className="grid gap-4 lg:grid-cols-2">
            <Listbox
              id="selectedHetznerFirewallIds"
              label="Firewalls"
              searchable
              disabled={catalog.hetznerFirewalls.length === 0}
              searchPlaceholder="Search firewalls…"
              placeholder={catalog.hetznerFirewalls.length ? "Select firewalls" : "No firewalls found"}
              options={catalog.hetznerFirewalls.map((f: Item) => ({ value: String(f.id), label: String(f.name) }))}
              value={null}
              onChange={() => undefined}
              values={firewalls}
              onValues={setFirewalls}
              error={e.selectedHetznerFirewallIds}
            />
            <Listbox
              id="selectedHetznerNetworkIds"
              label="Private networks"
              searchable
              disabled={availableNetworks.length === 0}
              searchPlaceholder="Search networks…"
              placeholder={availableNetworks.length ? "Select networks" : "No compatible networks"}
              options={availableNetworks.map((n: Item) => ({ value: String(n.id), label: String(n.name), description: String(n.ip_range ?? "") }))}
              value={null}
              onChange={() => undefined}
              values={networks}
              onValues={setNetworks}
              error={e.selectedHetznerNetworkIds}
            />
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            <Checkbox id="enable_ipv4" label="Enable IPv4" fullWidth checked={ipv4} onChange={setIpv4} />
            <Checkbox id="enable_ipv6" label="Enable IPv6" fullWidth checked={ipv6} onChange={setIpv6} />
            <Checkbox id="enable_backups" label="Enable Hetzner backups" fullWidth helper="Adds 20% to the provider server price." checked={backups} onChange={setBackups} />
          </div>
          <CloudInitFields state={cloudInit} set={(p) => setCloudInit((c) => ({ ...c, ...p }))} scripts={mount.cloudInitScripts} orgBase={orgBase} alwaysOpen={false} errors={e} />
        </div>
      </SettingsSection>
      {common.scanning}
    </form>
  );
}

function VultrForm({ mount, orgBase, catalog, reloadKeys }: FormProps<VultrCatalog>) {
  const common = useCommon(mount, orgBase, reloadKeys);
  const [region, setRegion] = useState<string | null>(null);
  const [plan, setPlan] = useState<string | null>(null);
  const [os, setOs] = useState<string | null>(null);
  const [sshKeys, setSshKeys] = useState<string[]>([]);
  const [ipv6, setIpv6] = useState(true);
  const [noIpv4, setNoIpv4] = useState(false);
  const [cloudInit, setCloudInit] = useState<CloudInit>(NO_CLOUD_INIT);
  const plans = useMemo(() => vultrAvailablePlans(catalog.plans, region), [catalog, region]);
  const summary = vultrAdvancedSummary({ sshKeys, enableIpv6: ipv6, disablePublicIpv4: noIpv4, cloudInitScript: cloudInit.script });
  const e = common.errors;
  const shown = ["selected_region", "selected_plan", "selected_os_id", "selectedVultrSshKeyIds", "enable_ipv6", "cloud_init_script", "cloud_init_script_name", "selected_cloud_init_script_id"];
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(ev) =>
        void common.submit(
          ev,
          { selected_region: region, selected_plan: plan, selected_os_id: os, selectedVultrSshKeyIds: sshKeys, enable_ipv6: ipv6, disable_public_ipv4: noIpv4, ...cloudInitBody(cloudInit, false) },
          shown,
        )
      }
    >
      <SettingsSection title="Vultr server" helper="Choose the region, plan, operating system, and Freeploy SSH key." actions={<BuyButton disabled={common.noKey || common.submitting} price={vultrSelectedPrice(catalog.plans, plan)} />}>
        <div className="grid gap-4 lg:grid-cols-2">
          {common.nameField("A friendly name shown in Freeploy.")}
          {/* updatedSelectedRegion(): the plan reset. */}
          <Listbox id="selected_region" label="Region" required placeholder="Select a region" options={vultrRegionOptions(catalog.regions)} value={region} onChange={(v) => (setRegion(v), setPlan(null))} error={e.selected_region} />
          <Listbox id="selected_plan" label="Plan" required disabled={!region} placeholder="Select a plan" options={vultrPlanOptions(plans)} value={plan} onChange={setPlan} error={e.selected_plan} />
          <Listbox id="selected_os_id" label="Operating system" required placeholder="Select an operating system" options={vultrOsOptions(catalog.operatingSystems)} value={os} onChange={setOs} error={e.selected_os_id} />
          {common.keyField}
        </div>
      </SettingsSection>

      <SettingsSection title="Advanced options" helper="Provider SSH keys, networking, and cloud-init.">
        <SummaryChips items={summary} />
        <div className="flex flex-col gap-4">
          <Listbox
            id="selectedVultrSshKeyIds"
            label="Extra SSH keys"
            helper="Existing keys from the Vultr account."
            searchable
            disabled={catalog.vultrSshKeys.length === 0}
            searchPlaceholder="Search SSH keys…"
            placeholder={catalog.vultrSshKeys.length ? "Select SSH keys" : "No account keys found"}
            options={sshKeyOptions(catalog.vultrSshKeys)}
            value={null}
            onChange={() => undefined}
            values={sshKeys}
            onValues={setSshKeys}
            error={e.selectedVultrSshKeyIds}
          />
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <Checkbox id="enable_ipv6" label="Enable IPv6" fullWidth checked={ipv6} onChange={setIpv6} />
              {e.enable_ipv6 ? <p className="mt-1 text-xs text-error">{e.enable_ipv6}</p> : null}
            </div>
            <Checkbox id="disable_public_ipv4" label="Disable public IPv4" fullWidth checked={noIpv4} onChange={setNoIpv4} />
          </div>
          <CloudInitFields state={cloudInit} set={(p) => setCloudInit((c) => ({ ...c, ...p }))} scripts={mount.cloudInitScripts} orgBase={orgBase} alwaysOpen errors={e} />
        </div>
      </SettingsSection>
      {common.scanning}
    </form>
  );
}

function DigitalOceanForm({ mount, orgBase, catalog, reloadKeys }: FormProps<DigitalOceanCatalog>) {
  const common = useCommon(mount, orgBase, reloadKeys);
  const [region, setRegion] = useState<string | null>(null);
  const [size, setSize] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [sshKeys, setSshKeys] = useState<string[]>([]);
  const [ipv6, setIpv6] = useState(true);
  const [monitoring, setMonitoring] = useState(true);
  const [cloudInit, setCloudInit] = useState<CloudInit>(NO_CLOUD_INIT);
  const sizes = useMemo(() => digitalOceanInRegion(catalog.sizes, region), [catalog, region]);
  const images = useMemo(() => digitalOceanInRegion(catalog.images, region), [catalog, region]);
  const summary = digitalOceanAdvancedSummary({ sshKeys, enableIpv6: ipv6, monitoring, showCloudInit: cloudInit.show, cloudInitScript: cloudInit.script, selectedScript: cloudInit.selected });
  const e = common.errors;
  const shown = ["selected_region", "selected_size", "selected_image", "selectedDigitalOceanSshKeyIds", "cloud_init_script", "cloud_init_script_name", "selected_cloud_init_script_id"];
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(ev) =>
        void common.submit(
          ev,
          { selected_region: region, selected_size: size, selected_image: image, selectedDigitalOceanSshKeyIds: sshKeys, enable_ipv6: ipv6, monitoring, ...cloudInitBody(cloudInit, true) },
          shown,
        )
      }
    >
      <SettingsSection title="DigitalOcean Droplet" helper="Choose the region, size, image, and Freeploy SSH key." actions={<BuyButton disabled={common.noKey || common.submitting} price={digitalOceanSelectedPrice(catalog.sizes, size)} />}>
        <div className="grid gap-4 lg:grid-cols-2">
          {common.nameField("A friendly name shown in Freeploy.")}
          {/* updatedSelectedRegion(): the size and image reset; updatedSelectedSize(): the image reset. */}
          <Listbox id="selected_region" label="Region" required placeholder="Select a region" options={digitalOceanRegionOptions(catalog.regions)} value={region} onChange={(v) => (setRegion(v), setSize(null), setImage(null))} error={e.selected_region} />
          <Listbox id="selected_size" label="Size" required disabled={!region} placeholder="Select a size" options={digitalOceanSizeOptions(sizes)} value={size} onChange={(v) => (setSize(v), setImage(null))} error={e.selected_size} />
          <Listbox id="selected_image" label="Image" required disabled={!size} placeholder="Select an image" options={digitalOceanImageOptions(images)} value={image} onChange={setImage} error={e.selected_image} />
          {common.keyField}
        </div>
      </SettingsSection>

      <SettingsSection title="Advanced options" helper="Provider SSH keys, networking, monitoring, and cloud-init.">
        <SummaryChips items={summary} />
        <div className="flex flex-col gap-4">
          <Listbox
            id="selectedDigitalOceanSshKeyIds"
            label="Extra SSH keys"
            helper="Existing keys from the DigitalOcean account."
            searchable
            disabled={catalog.digitalOceanSshKeys.length === 0}
            searchPlaceholder="Search SSH keys…"
            placeholder={catalog.digitalOceanSshKeys.length ? "Select SSH keys" : "No account keys found"}
            options={sshKeyOptions(catalog.digitalOceanSshKeys, "fingerprint")}
            value={null}
            onChange={() => undefined}
            values={sshKeys}
            onValues={setSshKeys}
            error={e.selectedDigitalOceanSshKeyIds}
          />
          <div className="grid gap-3 lg:grid-cols-2">
            <Checkbox id="enable_ipv6" label="Enable IPv6" fullWidth checked={ipv6} onChange={setIpv6} />
            <Checkbox id="monitoring" label="Enable DigitalOcean monitoring" fullWidth checked={monitoring} onChange={setMonitoring} />
          </div>
          <CloudInitFields state={cloudInit} set={(p) => setCloudInit((c) => ({ ...c, ...p }))} scripts={mount.cloudInitScripts} orgBase={orgBase} alwaysOpen={false} errors={e} />
        </div>
      </SettingsSection>
      {common.scanning}
    </form>
  );
}

function HostingerForm({ mount, orgBase, catalog, reloadKeys }: FormProps<HostingerCatalog>) {
  const common = useCommon(mount, orgBase, reloadKeys);
  const initial = catalog.selected_os_template_id === null ? null : String(catalog.selected_os_template_id);
  const [dataCenter, setDataCenter] = useState<string | null>(null);
  const [price, setPrice] = useState<string | null>(null);
  const [choice, setChoice] = useState<{ os: string | null; app: string | null; template: string | null }>({ os: initial, app: null, template: catalog.selected_template_id === null ? null : String(catalog.selected_template_id) });
  const [backups, setBackups] = useState(false);
  const [publicKeys, setPublicKeys] = useState<string[]>([]);
  const [postInstall, setPostInstall] = useState<string | null>(null);
  const priceOptions = useMemo(() => hostingerPriceOptions(catalog.catalog_items), [catalog]);
  const e = common.errors;
  const shown = ["selected_data_center_id", "selected_price_id", "selected_template_id", "selected_public_key_ids", "selected_post_install_script_id"];
  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(ev) =>
        void common.submit(
          ev,
          { selected_data_center_id: dataCenter, selected_template_id: choice.template, selected_price_id: price, enable_backups: backups, selected_public_key_ids: publicKeys, selected_post_install_script_id: postInstall },
          shown,
        )
      }
    >
      <SettingsSection
        title="Hostinger server"
        helper="Choose the data center, plan, operating system, and Freeploy SSH key."
        actions={
          <button type="submit" className="button button-highlighted" disabled={common.submitting || common.noKey}>
            Buy and create
            {common.submitting ? <Loading text="" /> : null}
          </button>
        }
      >
        <div className="grid gap-4 lg:grid-cols-2">
          {common.nameField("A friendly name shown in Freeploy and used as the VPS hostname.")}
          <Listbox id="selected_data_center_id" label="Data center" required placeholder="Select a data center" options={hostingerDataCenterOptions(catalog.data_centers)} value={dataCenter} onChange={setDataCenter} error={e.selected_data_center_id} />
          <Listbox
            id="selected_price_id"
            label="Plan and billing period"
            required
            disabled={!dataCenter}
            placeholder="Select a plan"
            options={priceOptions.map((p) => ({ value: String(p.id), label: hostingerPriceLabel(p) }))}
            value={price}
            onChange={setPrice}
            error={e.selected_price_id}
          />
          <Listbox
            id="selected_os_template_id"
            label="Operating system"
            required
            disabled={!price}
            placeholder="Select an operating system"
            options={hostingerTemplateOptions(hostingerOsTemplates(catalog.templates))}
            value={choice.os}
            onChange={(v) => setChoice((c) => hostingerTemplateChoice({ ...c, os: v }, "os"))}
            error={e.selected_template_id}
          />
          <Listbox
            id="selected_app_template_id"
            label="Operating system with application"
            disabled={!price}
            placeholder="Or select an operating system with an application"
            options={hostingerTemplateOptions(hostingerAppTemplates(catalog.templates))}
            value={choice.app}
            onChange={(v) => setChoice((c) => hostingerTemplateChoice({ ...c, app: v }, "app"))}
            helper="Replaces the operating system selected above. Applications and panels, such as another Coolify or CyberPanel, can conflict with the Freeploy proxy on ports 80 and 443."
          />
          {common.keyField}
        </div>
      </SettingsSection>

      <SettingsSection title="Advanced options" helper="Provider backups, account SSH keys, and post-install automation.">
        <div className="flex flex-col gap-4">
          <div className="-mx-2.5 grid gap-3 lg:grid-cols-2">
            <Checkbox
              id="enable_backups"
              label="Enable weekly Hostinger backups (extra cost)"
              fullWidth
              helper="Hostinger charges extra for backups. Check the price in hPanel before you enable them."
              checked={backups}
              onChange={setBackups}
            />
          </div>
          <Listbox
            id="selected_public_key_ids"
            label="Extra SSH keys"
            helper="Existing keys from the Hostinger account."
            searchable
            disabled={catalog.hostinger_public_keys.length === 0}
            searchPlaceholder="Search SSH keys…"
            placeholder={catalog.hostinger_public_keys.length ? "Select SSH keys" : "No account keys found"}
            options={sshKeyOptions(catalog.hostinger_public_keys)}
            value={null}
            onChange={() => undefined}
            values={publicKeys}
            onValues={setPublicKeys}
            error={e.selected_public_key_ids}
          />
          {catalog.post_install_scripts.length ? (
            <Listbox
              id="selected_post_install_script_id"
              label="Hostinger post-install script"
              placeholder="No post-install script"
              options={catalog.post_install_scripts.map((x: Item) => ({ value: String(x.id), label: String(x.name) }))}
              value={postInstall}
              onChange={setPostInstall}
              helper="Hostinger runs this as /post_install after setup and writes output to /post_install.log."
              error={e.selected_post_install_script_id}
            />
          ) : null}
          <Callout type="warning" title="This purchase is billed by Hostinger">
            The VPS is purchased with your Hostinger account&apos;s default payment method. Review the selected plan and billing period before continuing.
          </Callout>
        </div>
      </SettingsSection>
      {common.scanning}
    </form>
  );
}

type Load = { catalog?: unknown; providerDataError?: string } & Toasts;

/** Step 2: wire:init="load{Provider}Data", then the loading section, the provider's error, or the form. */
function Step2({ mount, orgBase, reloadKeys }: { mount: Mount; orgBase: string; reloadKeys: (select: string) => void }) {
  const [state, setState] = useState<{ loading: true } | { loading: false; error: string | null; catalog: unknown }>({ loading: true });
  const label = mount.providerName;
  useEffect(() => {
    void (async () => {
      const r = await postJson<Load>(`${orgBase}/servers/new/${mount.type}/${encodeURIComponent(mount.selectedTokenUuid ?? "")}/catalog`, null, "GET");
      if (!r.ok) {
        notify.error(summarize(r.error.messages));
        return setState({ loading: false, error: null, catalog: null });
      }
      showToasts(r.data);
      setState({ loading: false, error: r.data.providerDataError ?? null, catalog: r.data.catalog ?? null });
    })();
  }, [orgBase, mount.type, mount.selectedTokenUuid]);

  const what: Record<CloudType, string> = {
    hetzner: "Fetching locations, server types, images, and account resources.",
    vultr: "Fetching regions, plans, operating systems, and account resources.",
    "digital-ocean": "Fetching regions, sizes, images, and account resources.",
    hostinger: "Fetching data centers, plans, billing periods, and operating systems.",
  };
  if (state.loading) {
    return (
      <SettingsSection title={`Loading ${label}`} helper={what[mount.type]}>
        {mount.type === "hostinger" ? (
          <div className="flex min-h-40 items-center justify-center">
            <Loading text="Loading Hostinger data..." />
          </div>
        ) : (
          <SkeletonForm fields={6} label={`Loading ${label} data`} />
        )}
      </SettingsSection>
    );
  }
  if (state.error) {
    return (
      <SettingsSection title={`Unable to load ${label}`} helper="The selected token could not access the provider API.">
        {/* <x-callout type="error">: a type the callout does not have, so its warning style. */}
        <Callout type="warning" title="Provider request failed">
          <pre className="mt-2 whitespace-pre-wrap break-words text-[11px]">{state.error}</pre>
        </Callout>
        <div className="mt-4">
          <a className="button" href={`/servers/new/${mount.type}`}>
            Select another token
          </a>
        </div>
      </SettingsSection>
    );
  }
  const empty: Record<CloudType, Record<string, unknown>> = {
    hetzner: { locations: [], serverTypes: [], images: [], hetznerSshKeys: [], hetznerFirewalls: [], hetznerNetworks: [] },
    vultr: { regions: [], plans: [], operatingSystems: [], vultrSshKeys: [] },
    "digital-ocean": { regions: [], sizes: [], images: [], digitalOceanSshKeys: [] },
    hostinger: { data_centers: [], templates: [], catalog_items: [], hostinger_public_keys: [], post_install_scripts: [], selected_os_template_id: null, selected_template_id: null },
  };
  const catalog = { ...empty[mount.type], ...((state.catalog as Record<string, unknown> | null) ?? {}) };
  const props = { mount, orgBase, reloadKeys };
  if (mount.type === "hetzner") return <HetznerForm {...props} catalog={catalog as unknown as HetznerCatalog} />;
  if (mount.type === "vultr") return <VultrForm {...props} catalog={catalog as unknown as VultrCatalog} />;
  if (mount.type === "digital-ocean") return <DigitalOceanForm {...props} catalog={catalog as unknown as DigitalOceanCatalog} />;
  return <HostingerForm {...props} catalog={catalog as unknown as HostingerCatalog} />;
}

/** livewire:server.new.by-{provider} */
function CloudContent({ type, tokenUuid }: { type: CloudType; tokenUuid: string | null }) {
  const { me } = useSignedIn();
  const orgBase = `/v1/organizations/${me.team?.id ?? ""}/deploy`;
  const [mount, setMount] = useState<Mount | null>(null);
  const url = `${orgBase}/servers/new/${type}${tokenUuid ? `/${encodeURIComponent(tokenUuid)}` : ""}`;

  useEffect(() => {
    void (async () => {
      const r = await getJson<Mount>(url);
      if (!r.data) {
        if (r.status === 404) window.location.replace("/servers");
        return;
      }
      setMount(r.data);
    })();
  }, [url]);

  /** handlePrivateKeyCreated(): the SSH keys again (PrivateKey::ownedAndOnlySShKeys()). */
  const reloadKeys = useCallback(
    (select: string) => {
      void (async () => {
        const r = await getJson<Mount>(url);
        if (r.data) setMount((m) => (m ? { ...m, privateKeys: r.data!.privateKeys, privateKeyId: select } : m));
      })();
    },
    [url],
  );

  if (!mount) return null;
  let body: ReactNode;
  if (mount.currentStep === 1) {
    body = (
      <div className="flex flex-col gap-6">
        <TokenPicker mount={mount} orgBase={orgBase} />
      </div>
    );
  } else {
    body = <Step2 mount={mount} orgBase={orgBase} reloadKeys={reloadKeys} />;
  }
  return <div className="w-full">{body}</div>;
}

/** CreatePage with a cloud {type}: "Hetzner | Freeploy", … */
export function ServerCreateCloudPage() {
  const route = cloudRoute(window.location.pathname);
  if (!route) return null;
  return (
    <Layout title="Servers" href="/servers" navHref="/servers" documentTitle={PROVIDER_LABEL[route.type]}>
      <div className="w-full">
        <div className="mb-5 flex min-h-9 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h1 className="min-w-0 text-[24px]! leading-7! font-semibold! tracking-tight!">New server</h1>
          <div className="flex flex-wrap items-center gap-2">
            <a href="/servers/new" className="button">
              Change method
            </a>
          </div>
        </div>
        <div className="application-settings-form">
          <CloudContent type={route.type} tokenUuid={route.tokenUuid} />
        </div>
      </div>
    </Layout>
  );
}
