// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/boarding/index.blade.php,
// resources/views/components/{boarding-progress,boarding-step,checkpoint-item,highlighted}.blade.php,
// resources/views/layouts/boarding.blade.php and app/Livewire/Boarding/Index.php (Apache-2.0), modified.
//
// /onboarding (DP-75): the steps Coolify shows a new team, over Freeploy's own APIs — private keys (DP-36),
// servers (DP-37) and projects (DP-46). The step is in the URL (`?step=`, Coolify's #[Url(as: 'step')]).
//
// Not available yet, as the convention says: what needs the SSH executor — validating the server and
// installing Docker ("Start validation") — and what needs a server Freeploy does not have: "This machine"
// (Coolify's localhost, the server Coolify runs on) and provisioning a server with a cloud provider. So
// that a team can still reach the project step, the validation step offers "Continue without validation"
// (Freeploy's), and the last step says Docker is not validated instead of "Installed and running".
//
// show_boarding: Freeploy does not store it, and registration does not send a new team here (the parity
// seed skips onboarding, DP-18). The page is reached by its URL; "Skip setup" and "Go to dashboard" go to
// the dashboard, with nothing to turn off. A member (Coolify's isMember()) is sent to the dashboard.
// Generating a key: Coolify shows the new pair and stores it on "Save SSH Key"; Freeploy's API generates
// and stores the key in one call (POST …/private-keys/generate), so the pair is stored when the step opens,
// its private key stays on the server (revealed on the key's page with the password), and "Save SSH Key"
// saves the name and description.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useMe } from "../layout/Layout";
import { Toasts } from "../layout/Toasts";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Callout, Collapsible, FormInput, FormTextarea, Listbox, SettingsSection } from "../components/Coolify";
import { boardingStep, boardingUrl, NOT_AVAILABLE, type BoardingStep as Step } from "../lib/boarding";
import { projectsApi, type ProjectListItem } from "./ProjectChrome";

interface KeyItem {
  uuid: string;
  name: string;
  isGitRelated: boolean;
}

/** <x-highlighted>. */
const Highlighted = ({ text }: { text: string }) => <span className="text-helper">{text}</span>;

/** <x-boarding-progress>: Server, Connection, Complete. */
function Progress({ current }: { current: number }) {
  return (
    <div className="mx-auto mb-6 w-full max-w-3xl">
      <div className="grid grid-cols-3 overflow-hidden rounded-[10px] border border-neutral-200 bg-white dark:border-white/[0.08] dark:bg-white/[0.05]">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className={`flex min-h-10 items-center justify-center gap-2 border-r border-neutral-200 px-3 text-[11px] font-medium last:border-r-0 dark:border-white/[0.08] ${i === current ? "bg-coollabs/[0.07] text-coollabs dark:bg-brand/10 dark:text-brand-light" : "text-neutral-500 dark:text-fg-dim"}`}
          >
            <span
              className={`flex size-5 items-center justify-center rounded-full border text-[10px] font-semibold ${i === current ? "border-coollabs/25 bg-coollabs/10 dark:border-brand-light/25 dark:bg-brand/15" : i < current ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-neutral-200 dark:border-white/[0.1]"}`}
            >
              {i < current ? <Reicon name="check-circle" className="size-3" /> : i}
            </span>
            <span className="hidden sm:inline">{i === 1 ? "Server" : i === 2 ? "Connection" : "Complete"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** <x-boarding-step>: the title, the question, the actions and the "Technical details". */
function BoardingStep({ title, question, explanation, children }: { title: string; question: ReactNode; explanation?: ReactNode; children?: ReactNode }) {
  return (
    <div className="application-settings-form w-full max-w-3xl">
      <section className="application-settings-section">
        <div className="application-settings-section-header">
          <div>
            <h2>{title}</h2>
            <p>{question}</p>
          </div>
        </div>
        <div className="application-settings-section-body">{children ? <div className="flex flex-col gap-4">{children}</div> : null}</div>
        {explanation ? (
          <div className="border-t border-neutral-200 bg-neutral-50 px-4 py-3 dark:border-white/[0.08] dark:bg-white/[0.02]">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-fg-faint">Technical details</p>
            <div className="space-y-2 text-[12px] leading-5 text-neutral-500 dark:text-fg-dim">{explanation}</div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** <x-checkpoint-item>. */
function Checkpoint({ title, description, status = "idle", icon }: { title: string; description?: string; status?: "idle" | "success"; icon?: string }) {
  const classes = status === "success" ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-fg-dim";
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-3">
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg border ${classes}`}>
        {status === "success" ? <Reicon name="check-circle" className="size-4" /> : icon ? <Reicon name={icon} className="size-4" /> : <span className="size-1.5 rounded-full bg-current opacity-50" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold">{title}</span>
        {description ? <span className="mt-0.5 block text-[11px] text-neutral-500 dark:text-fg-faint">{description}</span> : null}
      </span>
    </div>
  );
}

const PILL = "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium text-neutral-500 transition-colors hover:bg-white hover:text-coollabs dark:text-fg-dim dark:hover:bg-white/[0.06] dark:hover:text-brand-light";
const PILLS = "inline-flex flex-wrap items-center justify-center gap-0.5 rounded-lg border border-neutral-200 bg-neutral-50 p-0.5 dark:border-white/[0.08] dark:bg-white/[0.05]";
const CARD = "group relative cursor-pointer min-h-36 rounded-[10px] border border-neutral-200 bg-white p-4 text-left shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14]";
const CHOICE = "group flex h-full min-h-28 items-start gap-3 rounded-[10px] border border-neutral-200 bg-white p-4 text-left shadow-sm transition-all hover:-translate-y-px hover:border-neutral-300 hover:shadow-md dark:border-white/[0.08] dark:bg-white/[0.05] dark:hover:border-white/[0.14]";
const CODE = <code className="text-xs bg-coolgray-300 dark:bg-coolgray-400 px-1 py-0.5 rounded">~/.ssh/authorized_keys</code>;

function fieldErrors(fields: Record<string, string[]> | undefined, map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [api, ours] of Object.entries(map)) if (fields?.[api]?.[0]) out[ours] = fields[api][0];
  return out;
}

export function BoardingPage() {
  const [me] = useMe();
  const orgBase = `/v1/organizations/${me?.team?.id ?? ""}/deploy`;
  const [step, setStepState] = useState<Step>(() => boardingStep(window.location.search));
  const [ready, setReady] = useState(false);
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [keyType, setKeyType] = useState<"own" | "create" | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [key, setKey] = useState({ name: "", description: "", privateKey: "", publicKey: "" });
  const [server, setServer] = useState({ name: "", host: "", description: "", port: "22", user: "root" });
  const [createdServer, setCreatedServer] = useState<{ uuid: string; name: string; ip: string } | null>(null);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [createdProject, setCreatedProject] = useState<{ uuid: string; name: string; environmentUuid: string | null } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  /** currentState with #[Url(as: 'step', history: true)]. */
  const setStep = useCallback((next: Step) => {
    setStepState(next);
    window.history.pushState(null, "", boardingUrl(window.location.href, next));
  }, []);
  useEffect(() => {
    const onPop = () => setStepState(boardingStep(window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const loadProjects = useCallback(async () => {
    const r = await getJson<{ projects: ProjectListItem[] }>(projectsApi(me?.team?.id));
    const list = r.data?.projects ?? [];
    setProjects(list);
    setSelectedProject((s) => s ?? list[0]?.uuid ?? null);
  }, [me?.team?.id]);

  /** mount(): a member goes to the dashboard; random names for the key and the server. */
  useEffect(() => {
    if (!me?.team) return;
    void (async () => {
      const role = await getJson<{ role: string }>(`/v1/organizations/${me.team!.id}/team/members`);
      if (role.data?.role === "member") return window.location.replace("/");
      const fresh = await getJson<{ name: string }>(`${orgBase}/servers/new`);
      setServer((s) => ({ ...s, name: s.name || fresh.data?.name || "" }));
      setKey((k) => ({ ...k, name: k.name || fresh.data?.name || "" }));
      // Load projects when on create-project state (for page refresh).
      if (boardingStep(window.location.search) === "create-project") await loadProjects();
      setReady(true);
    })();
  }, [me?.team, orgBase, loadProjects]);

  /** skipBoarding(): Freeploy stores no show_boarding; to the dashboard. */
  const skip = () => window.location.assign("/");

  /** setServerType(): localhost is not available yet; remote lists the SSH keys (not the Git ones). */
  async function setServerType(type: "localhost" | "remote") {
    if (type === "localhost") return notify.error(NOT_AVAILABLE.localhost);
    const r = await getJson<{ privateKeys: KeyItem[] }>(`${orgBase}/private-keys`);
    const list = (r.data?.privateKeys ?? []).filter((k) => !k.isGitRelated);
    setKeys(list);
    setSelectedKey(list[0]?.uuid ?? null);
    setStep("private-key");
  }

  /** setPrivateKey('own' | 'create'). */
  async function setPrivateKey(type: "own" | "create") {
    setKeyType(type);
    setErrors({});
    if (type === "own") {
      setKey((k) => ({ ...k, privateKey: "", publicKey: "" }));
      return setStep("create-private-key");
    }
    const r = await postJson<{ uuid: string }>(`${orgBase}/private-keys/generate`, { type: "ed25519" });
    if (!r.ok) return notify.error(summarize(r.error.messages));
    const shown = await getJson<{ name: string; description: string | null; publicKey: string }>(`${orgBase}/private-keys/${encodeURIComponent(r.data.uuid)}`);
    setCreatedKey(r.data.uuid);
    setKey({ name: shown.data?.name ?? "", description: shown.data?.description ?? "", privateKey: "", publicKey: shown.data?.publicKey ?? "" });
    setStep("create-private-key");
  }

  function selectExistingPrivateKey(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selectedKey) return notify.error("Please select a private key.");
    setCreatedKey(selectedKey);
    setStep("create-server");
  }

  /** savePrivateKey(). */
  async function savePrivateKey(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const r =
      keyType === "create" && createdKey
        ? await postJson<{ message: string }>(`${orgBase}/private-keys/${encodeURIComponent(createdKey)}`, { name: key.name, description: key.description, newPrivateKey: null }, "PATCH")
        : await postJson<{ uuid: string }>(`${orgBase}/private-keys`, { name: key.name, description: key.description, value: key.privateKey });
    if (!r.ok) {
      const inline = fieldErrors(r.error.fields, { name: "privateKeyName", description: "privateKeyDescription", value: "privateKey", private_key: "privateKey" });
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    if (keyType !== "create") setCreatedKey((r.data as { uuid: string }).uuid);
    setErrors({});
    setStep("create-server");
  }

  /** saveServer(). */
  async function saveServer(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!createdKey) return setStep("private-key");
    const r = await postJson<{ uuid: string }>(`${orgBase}/servers`, {
      private_key_uuid: createdKey,
      name: server.name,
      description: server.description,
      ip: server.host,
      user: server.user,
      port: server.port,
      server_role: "both",
      scan_images: "off",
    });
    if (!r.ok) {
      const inline = fieldErrors(r.error.fields, { name: "remoteServerName", ip: "remoteServerHost", description: "remoteServerDescription", port: "remoteServerPort", user: "remoteServerUser" });
      setErrors(inline);
      if (!Object.keys(inline).length) notify.error(summarize(r.error.messages));
      return;
    }
    setErrors({});
    setCreatedServer({ uuid: r.data.uuid, name: server.name, ip: server.host });
    setStep("validate-server");
  }

  /** getProjects(). */
  async function toProjects() {
    await loadProjects();
    setStep("create-project");
  }

  /** createNewProject(): "My first project". */
  async function createNewProject() {
    const r = await postJson<{ uuid: string; environmentUuid: string }>(projectsApi(me?.team?.id), { name: "My first project", description: "" });
    if (!r.ok) return notify.error(summarize(r.error.messages));
    setCreatedProject({ uuid: r.data.uuid, name: "My first project", environmentUuid: r.data.environmentUuid });
    setStep("create-resource");
  }

  function selectExistingProject(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const found = projects.find((p) => p.uuid === selectedProject);
    if (!found) return notify.error("Project not found.");
    setCreatedProject({ uuid: found.uuid, name: found.name, environmentUuid: found.firstEnvironmentUuid });
    setStep("create-resource");
  }

  /** showNewResource(): to the new resource page of the project's first environment, with the server. */
  function showNewResource() {
    if (!createdProject?.environmentUuid) return notify.error("Project not found.");
    const query = createdServer ? `?${new URLSearchParams({ server: createdServer.uuid }).toString()}` : "";
    window.location.assign(`/project/${encodeURIComponent(createdProject.uuid)}/environment/${encodeURIComponent(createdProject.environmentUuid)}/new${query}`);
  }

  useEffect(() => {
    document.title = "Onboarding | Freeploy";
  }, []);
  if (!me || !ready) return null;

  let body: ReactNode = null;
  if (step === "welcome") {
    body = (
      <div className="w-full max-w-3xl">
        <div className="mb-6 text-center">
          <h1 className="text-2xl! font-semibold!">Welcome to Freeploy</h1>
          <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">Connect your first server and start deploying in minutes.</p>
        </div>
        <SettingsSection title="What you will set up" flush>
          <div className="divide-y divide-neutral-200 dark:divide-white/[0.07]">
            {[
              ["servers", "Server connection", "Connect through SSH to host your resources."],
              ["settings", "Docker environment", "Validate and configure the deployment runtime."],
              ["projects", "Project structure", "Create a project and its first environment."],
            ].map(([icon, title, description]) => (
              <div key={title} className="flex min-h-14 items-center gap-3 px-4 py-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-fg-dim">
                  <Reicon name={icon!} className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold">{title}</span>
                  <span className="mt-0.5 block text-[11px] text-neutral-500 dark:text-fg-faint">{description}</span>
                </span>
              </div>
            ))}
          </div>
        </SettingsSection>
        <div className="mt-5 flex flex-col items-center gap-4">
          <button type="button" className="button button-highlighted w-full justify-center sm:w-auto sm:min-w-36" onClick={() => setStep("select-server-type")}>
            Continue
          </button>
          <div className={PILLS}>
            <button type="button" className={PILL} onClick={skip}>
              <Reicon name="arrow-right" className="size-3.5 shrink-0" />
              Skip setup
            </button>
          </div>
        </div>
      </div>
    );
  } else if (step === "explanation") {
    body = (
      <>
        <Progress current={0} />
        <BoardingStep
          title="Platform Overview"
          question="Freeploy automates deployment and infrastructure management on your own servers. Deploy applications from Git, manage databases, and monitor everything without vendor lock-in."
          explanation={
            <>
              <p>
                <Highlighted text="Automation:" /> Freeploy handles server configuration, Docker management, and deployments automatically.
              </p>
              <p>
                <Highlighted text="Self-hosted:" /> All data and configurations live on your infrastructure. Works offline except for external integrations.
              </p>
              <p>
                <Highlighted text="Monitoring & Alerts:" /> Get real-time notifications via Discord, Telegram, Email, and other platforms.
              </p>
            </>
          }
        >
          <button type="button" className="button button-highlighted w-full justify-center lg:w-auto" onClick={() => setStep("select-server-type")}>
            Continue
          </button>
        </BoardingStep>
      </>
    );
  } else if (step === "select-server-type") {
    body = (
      <>
        <Progress current={1} />
        <BoardingStep title="Choose Server Type" question="Select where to deploy your applications and databases. You can add more servers later.">
          <div className="w-full space-y-6">
            <section>
              <h3 className="text-base font-semibold">Add a server</h3>
              <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">Use this machine or connect a server you already manage.</p>
              <div className="grid w-full grid-cols-1 gap-4 lg:grid-cols-2">
                <button type="button" className={CARD} onClick={() => void setServerType("localhost")}>
                  <div className="flex flex-col gap-4 text-left">
                    <svg className="size-10" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.737 5.1a3.375 3.375 0 012.7-1.35h7.126c1.062 0 2.062.5 2.7 1.35l2.587 3.45a4.5 4.5 0 01.9 2.7m0 0a3 3 0 01-3 3m0 3h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008zm-3 6h.008v.008h-.008v-.008zm0-6h.008v.008h-.008v-.008z"
                      />
                    </svg>
                    <div>
                      <h3 className="mb-1 text-[14px] font-semibold">This machine</h3>
                      <p className="text-sm dark:text-neutral-400">Deploy on the server running Freeploy. Best for testing and single-server setups.</p>
                    </div>
                  </div>
                </button>
                <button type="button" className={CARD} onClick={() => void setServerType("remote")}>
                  <div className="flex flex-col gap-4 text-left">
                    <svg className="size-10" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" />
                    </svg>
                    <div>
                      <h3 className="mb-1 text-[14px] font-semibold">IP address or domain</h3>
                      <p className="text-sm dark:text-neutral-400">Connect via SSH using a server IP address or domain.</p>
                    </div>
                  </div>
                </button>
              </div>
            </section>
            <section>
              <h3 className="text-base font-semibold">Provision a server</h3>
              <p className="mb-3 text-sm text-neutral-500 dark:text-neutral-400">Create a server with a cloud provider.</p>
              <div className="grid w-full grid-cols-1 gap-4 lg:grid-cols-2">
                {[
                  ["Hetzner Cloud", "Deploy servers directly from your Hetzner Cloud account."],
                  ["Vultr Cloud", "Deploy servers directly from your Vultr account."],
                  ["DigitalOcean", "Deploy servers directly from your DigitalOcean account."],
                  ["Hostinger", "Deploy servers directly from your Hostinger account."],
                ].map(([title, description]) => (
                  <button key={title} type="button" className={`${CARD} flex h-full flex-col`} onClick={() => notify.error(NOT_AVAILABLE.provider)}>
                    <div className="min-h-0 flex-1">
                      <h3 className="mb-1 text-[14px] font-semibold">{title}</h3>
                      <p className="text-sm dark:text-neutral-400">{description}</p>
                    </div>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </BoardingStep>
      </>
    );
  } else if (step === "private-key") {
    body = (
      <>
        <Progress current={2} />
        <BoardingStep
          title="SSH Authentication"
          question="Configure SSH key-based authentication for secure server access."
          explanation={
            <>
              <p>
                <Highlighted text="SSH Key Authentication:" /> Uses public-key cryptography for secure, password-less server access.
              </p>
              <p>
                <Highlighted text="Public Key Deployment:" /> Add the public key to your server's {CODE} file.
              </p>
              <p>
                <Highlighted text="Key Generation:" /> Freeploy generates ED25519 keys by default for optimal security and performance.
              </p>
            </>
          }
        >
          {keys.length > 0 ? (
            <div className="w-full space-y-4">
              <div className="rounded-[10px] border border-neutral-200 bg-neutral-50 p-4 dark:border-white/[0.08] dark:bg-white/[0.05]">
                <form onSubmit={selectExistingPrivateKey} className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1">
                    <Listbox id="selectedExistingPrivateKey" label="Existing SSH key" options={keys.map((k) => ({ value: k.uuid, label: k.name }))} value={selectedKey ?? ""} onChange={setSelectedKey} />
                  </div>
                  <button type="submit" className="button">
                    Use selected key
                  </button>
                </form>
              </div>
              <div className="relative py-1">
                <div className="absolute inset-0 flex items-center" aria-hidden="true">
                  <div className="w-full border-t border-neutral-200 dark:border-white/[0.07]" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-[var(--coollabs-base)] px-2.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-fg-faint">Or</span>
                </div>
              </div>
            </div>
          ) : null}
          <div className="grid w-full grid-cols-1 gap-3 lg:grid-cols-2">
            <button type="button" className={CHOICE} onClick={() => void setPrivateKey("own")}>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-fg-dim">
                <Reicon name="keys" className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold">Use existing key</span>
                <span className="mt-0.5 block text-[12px] leading-5 text-neutral-500 dark:text-fg-dim">Paste a private key you already manage.</span>
              </span>
            </button>
            <button type="button" className={CHOICE} onClick={() => void setPrivateKey("create")}>
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-fg-dim">
                <Reicon name="plus" className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-semibold">Generate new key</span>
                <span className="mt-0.5 block text-[12px] leading-5 text-neutral-500 dark:text-fg-dim">Create an ED25519 key pair in Freeploy.</span>
              </span>
            </button>
          </div>
        </BoardingStep>
      </>
    );
  } else if (step === "create-private-key") {
    body = (
      <>
        <Progress current={2} />
        <BoardingStep
          title="SSH Key Configuration"
          question="Configure your SSH key for server authentication."
          explanation={
            <>
              <p>
                <Highlighted text="Key Storage:" /> Private keys are encrypted at rest in Freeploy's database.
              </p>
              <p>
                <Highlighted text="Public Key Distribution:" /> Deploy the public key to {CODE} on your target server for the specified user.
              </p>
              <p>
                <Highlighted text="Key Format:" /> Supports ED25519, ECDSA, and RSA (2048 bits or more) key types in OpenSSH format.
              </p>
            </>
          }
        >
          <form onSubmit={(e) => void savePrivateKey(e)} className="flex flex-col w-full gap-4">
            <FormInput id="privateKeyName" label="Key Name" required placeholder="e.g., production-server-key" value={key.name} onChange={(name) => setKey({ ...key, name })} error={errors.privateKeyName} />
            <FormInput id="privateKeyDescription" label="Description" placeholder="Optional: Note what this key is used for" value={key.description} onChange={(description) => setKey({ ...key, description })} error={errors.privateKeyDescription} />
            {keyType === "create" ? (
              <>
                <FormTextarea id="publicKey" label="Public Key" rows={7} disabled value={key.publicKey} onChange={() => undefined} />
                <div className="p-4 bg-warning/10 border border-warning rounded-lg">
                  <div className="flex gap-3">
                    <svg className="size-5 text-warning flex-shrink-0 mt-0.5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        fillRule="evenodd"
                        d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z"
                        clipRule="evenodd"
                      />
                    </svg>
                    <div>
                      <p className="font-bold text-warning mb-1">Action Required</p>
                      <p className="text-sm dark:text-white text-black">Copy the public key above and add it to your server's {CODE} file.</p>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <FormTextarea id="privateKey" label="Private Key" required rows={8} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={key.privateKey} onChange={(privateKey) => setKey({ ...key, privateKey })} error={errors.privateKey} />
            )}
            <button type="submit" className="button w-full lg:w-auto">
              Save SSH Key
            </button>
          </form>
        </BoardingStep>
      </>
    );
  } else if (step === "create-server") {
    body = (
      <>
        <Progress current={2} />
        <BoardingStep title="Server Configuration" question="Provide connection details for your remote server.">
          <form onSubmit={(e) => void saveServer(e)} className="flex flex-col w-full gap-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <FormInput id="remoteServerName" label="Server Name" required placeholder="e.g., production-app-server" value={server.name} onChange={(name) => setServer({ ...server, name })} error={errors.remoteServerName} />
              <FormInput id="remoteServerHost" label="IP Address/Hostname" required placeholder="IP address or hostname" value={server.host} onChange={(host) => setServer({ ...server, host })} error={errors.remoteServerHost} />
            </div>
            <FormInput id="remoteServerDescription" label="Description" placeholder="Optional: Note what this server hosts" value={server.description} onChange={(description) => setServer({ ...server, description })} error={errors.remoteServerDescription} />
            <Collapsible title="Advanced Settings" contentClassName="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <FormInput id="remoteServerPort" label="SSH Port" type="number" placeholder="Default: 22" value={server.port} onChange={(port) => setServer({ ...server, port })} error={errors.remoteServerPort} />
              <div>
                <FormInput id="remoteServerUser" label="SSH User" placeholder="Default: root" value={server.user} onChange={(user) => setServer({ ...server, user })} error={errors.remoteServerUser} />
              </div>
            </Collapsible>
            <button type="submit" className="button w-full lg:w-auto">
              Validate Connection
            </button>
          </form>
        </BoardingStep>
      </>
    );
  } else if (step === "validate-server") {
    body = (
      <>
        <Progress current={2} />
        <BoardingStep
          title="Server Validation"
          question="Freeploy will automatically install Docker 24+ if not present."
          explanation={
            <>
              <p>
                <Highlighted text="Automated Setup:" /> Freeploy installs Docker Engine, Docker Compose, and configures system requirements automatically.
              </p>
              <p>
                <Highlighted text="Version Requirements:" /> Minimum Docker Engine 24.x required.{" "}
                <a target="_blank" rel="noreferrer" className="underline hover:text-coollabs" href="https://docs.docker.com/engine/install/#server">
                  Manual installation guide
                </a>
              </p>
              <p>
                <Highlighted text="System Configuration:" /> Sets up Docker networks, proxy configuration, and resource monitoring.
              </p>
            </>
          }
        >
          <div className="flex w-full flex-col gap-4">
            <div className="overflow-hidden rounded-[10px] border border-neutral-200 dark:border-white/[0.08]">
              <div className="border-b border-neutral-200 px-4 py-2.5 dark:border-white/[0.08]">
                <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-fg-faint">Validation checkpoints</p>
              </div>
              <div className="divide-y divide-neutral-200 dark:divide-white/[0.07]">
                <Checkpoint icon="keys" title="Test SSH connection" description="Verify key-based authentication" />
                <Checkpoint icon="servers" title="Check OS compatibility" description="Verify supported Linux distribution" />
                <Checkpoint icon="layers" title="Install Docker Engine" description="Auto-install if version 24+ not found" />
                <Checkpoint icon="globe" title="Configure network" description="Set up Docker networks and proxy" />
              </div>
            </div>
            <Callout type="warning" title="Not available yet">
              {NOT_AVAILABLE.validation}
            </Callout>
            <button type="button" className="button button-highlighted w-full justify-center" onClick={() => notify.error(NOT_AVAILABLE.validation)}>
              Start validation
            </button>
            <button type="button" className="button w-full justify-center" onClick={() => void toProjects()}>
              Continue without validation
            </button>
          </div>
        </BoardingStep>
      </>
    );
  } else if (step === "create-project") {
    body = (
      <>
        <Progress current={3} />
        <BoardingStep
          title="Project Setup"
          question={projects.length > 0 ? "You have existing projects. Select one or create a new project to organize your resources." : "Create your first project to organize applications, databases, and services."}
        >
          <div className="w-full space-y-4">
            <button type="button" className="button button-highlighted w-full justify-center" onClick={() => void createNewProject()}>
              Create "My First Project"
            </button>
            {projects.length > 0 ? (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-neutral-300 dark:border-coolgray-400" />
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="px-2 text-neutral-500 dark:text-neutral-400">Or use existing</span>
                  </div>
                </div>
                <form onSubmit={selectExistingProject} className="flex flex-col gap-3 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1">
                    <Listbox id="selectedProject" label="Existing project" options={projects.map((p) => ({ value: p.uuid, label: p.name }))} value={selectedProject ?? ""} onChange={setSelectedProject} />
                  </div>
                  <button type="submit" className="button">
                    Use selected project
                  </button>
                </form>
              </>
            ) : null}
          </div>
        </BoardingStep>
      </>
    );
  } else {
    body = (
      <>
        <Progress current={3} />
        <div className="w-full max-w-3xl">
          <div className="mb-6 text-center">
            <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-[10px] border border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <Reicon name="check-circle" className="size-6" />
            </div>
            <h1 className="text-2xl! font-semibold!">Setup complete</h1>
            <p className="mt-1 text-[13px] text-neutral-500 dark:text-fg-dim">Your server is connected and ready. Start deploying your first resource.</p>
          </div>
          <div className="overflow-hidden rounded-[10px] border border-neutral-200 dark:border-white/[0.08]">
            <div className="border-b border-neutral-200 px-4 py-2.5 dark:border-white/[0.08]">
              <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-fg-faint">What's configured</p>
            </div>
            <div className="divide-y divide-neutral-200 dark:divide-white/[0.07]">
              {createdServer ? <Checkpoint status="success" title={`Server: ${createdServer.name}`} description={createdServer.ip} /> : null}
              {createdProject ? <Checkpoint status="success" title={`Project: ${createdProject.name}`} description="Production environment ready" /> : null}
              {/* Freeploy: the server is not validated (the SSH executor is not available yet). */}
              <Checkpoint title="Docker Engine" description="Not validated yet." />
            </div>
          </div>
          <div className="mt-5 flex flex-col items-center gap-4">
            <button type="button" className="button button-highlighted justify-center px-6" onClick={showNewResource}>
              Deploy your first resource
            </button>
            <div className={PILLS}>
              <button type="button" className={PILL} onClick={skip}>
                <Reicon name="arrow-right" className="size-3.5 shrink-0" />
                Go to dashboard
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <main className="min-h-screen flex items-center justify-center p-4">
        <section className="application-settings-form w-full py-6">
          <div className="flex w-full flex-col items-center space-y-6">{body}</div>
          {step !== "welcome" && step !== "create-resource" ? (
            <div className="mx-auto mt-6 flex w-full max-w-3xl flex-col items-center gap-3">
              <div className={PILLS}>
                <button type="button" className={PILL} onClick={skip}>
                  <Reicon name="arrow-right" className="size-3.5 shrink-0" />
                  Skip setup
                </button>
                {/* restartBoarding(): redirect()->route('onboarding'). */}
                <button type="button" className={PILL} onClick={() => window.location.assign("/onboarding")}>
                  <Reicon name="restart" className="size-3.5 shrink-0" />
                  Restart
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </main>
      <Toasts />
    </>
  );
}
