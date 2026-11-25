// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/new/{github-private-repository,
// github-private-repository-deploy-key}.blade.php and app/Livewire/Project/New/{GithubPrivateRepository,
// GithubPrivateRepositoryDeployKey}.php (Apache-2.0), modified.
//
// New Resource's private repositories (DP-72), for ?type=private-gh-app and ?type=private-deploy-key: choose the
// GitHub App (or the SSH key), then the repository and its branch (listed through the App's installation token),
// then the build. Creating stores the application and opens its configuration page; nothing is deployed. Smart
// Scan clones the repository on the server, which Freeploy cannot do yet: its panel stays on "Not scanned yet",
// and the Dockerfile is a path typed into a field.
import { useEffect, useState, type FormEvent } from "react";
import { getJson, postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Callout, Empty, FormInput, Listbox, ModalInput } from "../components/Coolify";
import { applicationPath, applicationsApi } from "./ApplicationChrome";
import { BUILD_PACKS, CheckpointItem, RepositoryPaths } from "./ResourceCreateBuilt";
import { GithubCreateForm, sourcesApi, type SourceItem } from "./Sources";

interface Target {
  orgId: string | undefined;
  projectUuid: string;
  environmentUuid: string;
  destination: string;
  serverUuid: string | null;
}

const targetBody = (t: Target) => ({ project_uuid: t.projectUuid, environment_uuid: t.environmentUuid, ...(t.serverUuid ? { server_uuid: t.serverUuid } : {}), destination_uuid: t.destination });

/** The build step both forms share: build pack, output type, port, publish directory, Dockerfile, paths. */
interface Build {
  buildPack: string;
  isStatic: boolean;
  port: string;
  publishDirectory: string;
  baseDirectory: string;
  dockerComposeLocation: string;
  selectedDockerfile: string;
}

const INITIAL_BUILD: Build = { buildPack: "railpack", isStatic: false, port: "3000", publishDirectory: "", baseDirectory: "/", dockerComposeLocation: "/docker-compose.yaml", selectedDockerfile: "" };

function useBuild() {
  const [build, setBuild] = useState<Build>(INITIAL_BUILD);
  /** updatedBuildPack() */
  const setBuildPack = (value: string) =>
    setBuild((b) => {
      if (value === "nixpacks" || value === "railpack") return { ...b, buildPack: value, port: b.isStatic ? b.port : "3000" };
      if (value === "static") return { ...b, buildPack: value, isStatic: false, port: "80" };
      return { ...b, buildPack: value, isStatic: false };
    });
  /** instantSave(): the output type decides the port and the publish directory. */
  const setOutputType = (value: boolean, toast: boolean) => {
    setBuild((b) => ({ ...b, isStatic: value, port: value ? "80" : "3000", publishDirectory: value ? "/dist" : "" }));
    if (toast) notify.success("Application settings updated!");
  };
  const body = () => ({
    build_pack: build.buildPack,
    port: build.port,
    is_static: build.isStatic,
    publish_directory: build.publishDirectory === "" ? null : build.publishDirectory,
    base_directory: build.baseDirectory,
    docker_compose_location: build.dockerComposeLocation,
    ...(build.buildPack === "dockerfile" ? { selectedDockerfile: build.selectedDockerfile } : {}),
  });
  return { build, setBuild, setBuildPack, setOutputType, body };
}

function BuildFields({ state, errors, toastOnOutput, publishRequired = false }: { state: ReturnType<typeof useBuild>; errors: Record<string, string>; toastOnOutput: boolean; publishRequired?: boolean }) {
  const { build, setBuild, setBuildPack, setOutputType } = state;
  const showIsStatic = build.buildPack === "nixpacks" || build.buildPack === "railpack";
  return (
    <>
      <Listbox id="build_pack" label="Build pack" required options={BUILD_PACKS} value={build.buildPack} onChange={setBuildPack} />
      {showIsStatic ? (
        <>
          <Listbox
            id="is_static"
            label="Output type"
            options={[
              { value: "false", label: "Web application" },
              { value: "true", label: "Static site" },
            ]}
            value={String(build.isStatic)}
            onChange={(v) => setOutputType(v === "true", toastOnOutput)}
          />
          <FormInput id="port" type="number" label="Port" readOnly={build.isStatic} helper="Port the application listens on." value={build.port} onChange={(port) => setBuild((b) => ({ ...b, port }))} error={errors.port} />
        </>
      ) : null}
      {build.isStatic ? (
        <FormInput
          id="publish_directory"
          label="Publish directory"
          required={publishRequired}
          helper="Directory containing the generated static assets."
          value={build.publishDirectory}
          onChange={(publishDirectory) => setBuild((b) => ({ ...b, publishDirectory }))}
          error={errors.publish_directory}
        />
      ) : null}
    </>
  );
}

function BuildExtras({ state, errors }: { state: ReturnType<typeof useBuild>; errors: Record<string, string> }) {
  const { build, setBuild } = state;
  return (
    <>
      {build.buildPack === "nixpacks" ? (
        <Callout type="warning" title="Nixpacks is deprecated">
          Nixpacks is deprecated and is in maintenance mode upstream. We recommend Railpack, the successor of Nixpacks, for new and existing applications.
        </Callout>
      ) : null}
      {build.buildPack === "dockerfile" ? (
        <FormInput
          id="selectedDockerfile"
          label="Dockerfile"
          placeholder="/Dockerfile"
          helper="Select a detected Dockerfile, or type a path relative to the base directory."
          value={build.selectedDockerfile}
          onChange={(selectedDockerfile) => setBuild((b) => ({ ...b, selectedDockerfile }))}
          error={errors.selectedDockerfile}
        />
      ) : null}
    </>
  );
}

function Paths({ state, errors }: { state: ReturnType<typeof useBuild>; errors: Record<string, string> }) {
  const { build, setBuild } = state;
  return build.buildPack === "dockercompose" ? (
    <RepositoryPaths
      className="sm:grid-cols-2"
      base={build.baseDirectory}
      onBase={(baseDirectory) => setBuild((b) => ({ ...b, baseDirectory }))}
      baseError={errors.base_directory}
      file={{ value: build.dockerComposeLocation, onChange: (dockerComposeLocation) => setBuild((b) => ({ ...b, dockerComposeLocation })), label: "Compose file", defaultFile: "/docker-compose.yaml", error: errors.docker_compose_location, compose: true }}
    />
  ) : (
    <FormInput id="base_directory" label="Base directory" placeholder="/" helper="Repository directory used as the build root." value={build.baseDirectory} onChange={(baseDirectory) => setBuild((b) => ({ ...b, baseDirectory }))} error={errors.base_directory} />
  );
}

const SmartScan = () => (
  <div className="overflow-hidden rounded-[10px] border border-neutral-200 dark:border-white/[0.08]">
    <div className="flex min-h-10 items-center justify-between gap-3 border-b border-neutral-200 py-1.5 pr-1.5 pl-4 dark:border-white/[0.08]">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-fg-faint">Smart Scan</p>
    </div>
    <div className="divide-y divide-neutral-200 dark:divide-white/[0.07]">
      <CheckpointItem icon="search" title="Not scanned yet" description="Scan the repository to find Dockerfiles, Compose files, and env files." />
    </div>
  </div>
);

/** The field errors of an answer; the rest as a toast. */
function shown(error: { fields?: Record<string, string[]>; messages: string[] }): Record<string, string> {
  const inline: Record<string, string> = {};
  for (const [k, m] of Object.entries(error.fields ?? {})) if (m[0]) inline[k] = m[0];
  if (!Object.keys(inline).length) notify.error(summarize(error.messages));
  return inline;
}

// ── With a GitHub App ───────────────────────────────────────────────────────────────────────────────────

interface Repository {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch: string | null;
}

/** <livewire:project.new.github-private-repository>. */
export function GithubPrivateRepositoryForm(props: Target) {
  const [apps, setApps] = useState<SourceItem[] | null>(null);
  const [defaultName, setDefaultName] = useState("");
  const [canCreate, setCanCreate] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [app, setApp] = useState<SourceItem | null>(null);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [repositoryId, setRepositoryId] = useState<string>("");
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState("main");
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const state = useBuild();
  const sources = sourcesApi(props.orgId);

  useEffect(() => {
    void (async () => {
      const r = await getJson<{ sources: SourceItem[]; canCreate: boolean; defaultName: string }>(sources);
      // GithubApp::ownedByCurrentTeam()->where('is_public', false)->whereNotNull('app_id').
      setApps((r.data?.sources ?? []).filter((s) => s.kind === "github" && s.registered));
      setDefaultName(r.data?.defaultName ?? "");
      setCanCreate(r.data?.canCreate ?? false);
    })();
  }, [sources]);

  /** loadRepositories($github_app_id) */
  async function loadRepositories(source: SourceItem) {
    setLoading(true);
    const r = await postJson<{ repositories: Repository[] }>(`${sources}/github/${source.uuid}/repositories`, null, "GET");
    setLoading(false);
    setRepositories([]);
    setBranches([]);
    if (!r.ok) return notify.error(summarize(r.error.messages));
    setApp(source);
    setRepositories(r.data.repositories);
    setRepositoryId(r.data.repositories[0] ? String(r.data.repositories[0].id) : "");
  }

  /** loadBranches(): the branches, main and master first; the repository's default branch is chosen. */
  async function loadBranches() {
    const repository = repositories.find((r) => String(r.id) === repositoryId);
    if (!app || !repository) return;
    setLoading(true);
    const query = new URLSearchParams({ default_branch: repository.default_branch ?? "main" });
    const r = await postJson<{ branches: string[]; selected: string }>(`${sources}/github/${app.uuid}/repositories/${encodeURIComponent(repository.owner.login)}/${encodeURIComponent(repository.name)}/branches?${query}`, null, "GET");
    setLoading(false);
    if (!r.ok) {
      setBranches([]);
      return notify.error(summarize(r.error.messages));
    }
    setBranches(r.data.branches);
    setBranch(r.data.selected);
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const repository = repositories.find((r) => String(r.id) === repositoryId);
    if (saving || !app || !repository) return;
    setSaving(true);
    const r = await postJson<{ uuid: string; projectUuid: string; environmentUuid: string }>(applicationsApi(props.orgId), {
      type: "private-gh-app",
      ...targetBody(props),
      github_app_uuid: app.uuid,
      repository_id: repository.id,
      repository_owner: repository.owner.login,
      repository_repo: repository.name,
      git_branch: branch,
      ...state.body(),
    });
    if (!r.ok) {
      setSaving(false);
      return setErrors(shown(r.error));
    }
    window.location.assign(applicationPath(r.data.projectUuid, r.data.environmentUuid, r.data.uuid));
  }

  if (apps === null) return null;
  const addApp = (
    <ModalInput
      title="New GitHub App"
      open={addOpen}
      onOpenChange={setAddOpen}
      closeOutside={false}
      trigger={
        <button type="button" className="button">
          + Add GitHub App
        </button>
      }
    >
      <GithubCreateForm defaultName={defaultName} canCreate={canCreate} />
    </ModalInput>
  );
  return (
    <div className="mt-8 flex w-full max-w-none flex-col gap-6 lg:mt-3">
      {apps.length === 0 ? (
        <section className="application-settings-section">
          <div className="application-settings-section-header">
            <div>
              <h2>GitHub App</h2>
              <p>Connect a GitHub App before selecting a private repository.</p>
            </div>
          </div>
          <Empty title="No GitHub Apps" description="Create an app to grant Freeploy access to selected repositories." iconName="sources">
            {addApp}
          </Empty>
        </section>
      ) : !app ? (
        <section className="application-settings-section">
          <div className="application-settings-section-header">
            <div>
              <h2>Choose GitHub App</h2>
              <p>Select the installation that can access the repository you want to deploy.</p>
            </div>
            {addApp}
          </div>
          <div className="application-settings-section-body p-0!">
            {apps.map((a) => (
              <button
                key={a.uuid}
                type="button"
                disabled={loading}
                onClick={() => void loadRepositories(a)}
                className="group relative flex w-full items-center gap-3 border-b border-neutral-200 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-neutral-50 dark:border-white/[0.06] dark:hover:bg-white/[0.025]"
              >
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-white/[0.06] dark:text-fg-dim">
                  <Reicon name="sources" className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-black dark:text-fg">{a.name}</div>
                  <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-fg-dim">
                    {a.htmlUrl}
                    {a.account ? ` · ${a.account}` : ""}
                  </p>
                </div>
              </button>
            ))}
          </div>
        </section>
      ) : (
        <>
          <section className="application-settings-section">
            <div className="application-settings-section-header">
              <div>
                <h2>Choose repository</h2>
                <p>Search repositories available through {app.name}.</p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" className="button" onClick={() => void loadRepositories(app)} disabled={loading}>
                  Refresh
                </button>
                <a target="_blank" rel="noreferrer" className="button" href={`/source/github/${app.uuid}`}>
                  GitHub access
                  <Reicon name="arrow-right" className="size-3.5 -rotate-45" />
                </a>
              </div>
            </div>
            <div className="application-settings-section-body">
              {repositories.length ? (
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <Listbox
                      id="selected_repository_id"
                      label="Repository"
                      required
                      options={repositories.map((r) => ({ value: String(r.id), label: r.full_name || r.name }))}
                      value={repositoryId}
                      onChange={(v) => {
                        setRepositoryId(v);
                        setBranches([]);
                      }}
                    />
                  </div>
                  <button type="button" className="button" onClick={() => void loadBranches()} disabled={loading}>
                    Load repository
                  </button>
                </div>
              ) : (
                <Empty size="sm" title="No repositories available" description="Review this GitHub App installation and grant access to a repository." />
              )}
            </div>
          </section>
          {branches.length ? (
            <form onSubmit={(e) => void submit(e)}>
              <section className="application-settings-section">
                <div className="application-settings-section-header">
                  <div>
                    <h2>Build configuration</h2>
                    <p>Choose the branch and build strategy for this application.</p>
                  </div>
                  <button type="submit" className="button button-highlighted" disabled={saving}>
                    Continue
                  </button>
                </div>
                <div className="application-settings-section-body space-y-5">
                  <SmartScan />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Listbox id="selected_branch_name" label="Branch" required options={branches.map((b) => ({ value: b, label: b }))} value={branch} onChange={setBranch} />
                    <BuildFields state={state} errors={errors} toastOnOutput />
                  </div>
                  <BuildExtras state={state} errors={errors} />
                  <Paths state={state} errors={errors} />
                </div>
              </section>
            </form>
          ) : null}
        </>
      )}
    </div>
  );
}

// ── With a deploy key ───────────────────────────────────────────────────────────────────────────────────

interface PrivateKeyItem {
  uuid: string;
  name: string;
  description: string | null;
}

/** <livewire:project.new.github-private-repository-deploy-key>. */
export function DeployKeyRepositoryForm(props: Target) {
  const [keys, setKeys] = useState<PrivateKeyItem[] | null>(null);
  const [key, setKey] = useState<PrivateKeyItem | null>(null);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const state = useBuild();

  useEffect(() => {
    void (async () => {
      const r = await getJson<{ privateKeys: PrivateKeyItem[] }>(`/v1/organizations/${props.orgId ?? ""}/deploy/private-keys`);
      setKeys(r.data?.privateKeys ?? []);
    })();
  }, [props.orgId]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving || !key) return;
    setSaving(true);
    const r = await postJson<{ uuid: string; projectUuid: string; environmentUuid: string }>(applicationsApi(props.orgId), {
      type: "private-deploy-key",
      ...targetBody(props),
      private_key_uuid: key.uuid,
      repository_url: repositoryUrl,
      git_branch: branch,
      ...state.body(),
    });
    if (!r.ok) {
      setSaving(false);
      return setErrors(shown(r.error));
    }
    window.location.assign(applicationPath(r.data.projectUuid, r.data.environmentUuid, r.data.uuid));
  }

  if (keys === null) return null;
  return (
    <div className="mt-8 flex w-full max-w-none flex-col gap-6 lg:mt-3">
      {!key ? (
        <section className="application-settings-section">
          <div className="application-settings-section-header">
            <div>
              <h2>Private repository</h2>
              <p>Choose the SSH key Freeploy will use to clone this repository.</p>
            </div>
          </div>
          <div className="application-settings-section-body p-0!">
            {keys.length ? (
              keys.map((k) => (
                <button
                  key={k.uuid}
                  type="button"
                  onClick={() => setKey(k)}
                  className="group flex w-full items-center gap-3 border-b border-neutral-200 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-neutral-50 dark:border-white/[0.06] dark:hover:bg-white/[0.025]"
                >
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500 dark:bg-white/[0.06] dark:text-fg-dim">
                    <Reicon name="keys" className="size-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-black dark:text-fg">{k.name}</div>
                    <p className="mt-0.5 truncate text-xs text-neutral-500 dark:text-fg-dim">{k.description || "SSH deploy key"}</p>
                  </div>
                </button>
              ))
            ) : (
              <Empty title="No private keys" description="Create an SSH key before connecting a private repository." iconName="keys">
                <a className="button" href="/security/private-key">
                  Create private key
                </a>
              </Empty>
            )}
          </div>
        </section>
      ) : (
        <form onSubmit={(e) => void submit(e)}>
          <section className="application-settings-section">
            <div className="application-settings-section-header">
              <div>
                <h2>Repository configuration</h2>
                <p>Enter the repository location and choose how Freeploy should build it.</p>
              </div>
              <button type="submit" className="button button-highlighted" disabled={saving}>
                Continue
              </button>
            </div>
            <div className="application-settings-section-body space-y-5">
              <FormInput id="repository_url" required label="Repository URL" placeholder="git@github.com:owner/repository.git" value={repositoryUrl} onChange={setRepositoryUrl} error={errors.repository_url} />
              <div className="grid gap-4 sm:grid-cols-2">
                <FormInput id="branch" required label="Branch" value={branch} onChange={setBranch} error={errors.git_branch} />
                <BuildFields state={state} errors={errors} toastOnOutput={false} publishRequired />
              </div>
              <BuildExtras state={state} errors={errors} />
              <Paths state={state} errors={errors} />
              <SmartScan />
            </div>
          </section>
        </form>
      )}
    </div>
  );
}
