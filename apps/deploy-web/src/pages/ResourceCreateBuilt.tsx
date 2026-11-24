// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/new/{simple-dockerfile,public-git-repository}.blade.php,
// resources/views/livewire/project/new/partials/smart-scan-summary.blade.php,
// resources/views/components/{checkpoint-item,nixpacks-deprecated-callout}.blade.php,
// resources/views/components/forms/repository-paths.blade.php, lang/en.json (repository.url),
// config/deprecations.php and app/Livewire/Project/New/{SimpleDockerfile,PublicGitRepository}.php
// (Apache-2.0), modified.
//
// The New Resource page's forms for the Dockerfile and Public Git Repository
// types (ResourceCreate.tsx shows them for ?type=dockerfile and ?type=public).
// Creating stores the application and opens its configuration page; nothing
// is deployed. Smart Scan clones the repository on the server, which Freeploy
// cannot do yet: its panel stays on "Not scanned yet" and the button answers
// so; with nothing detected, the Dockerfile is a path typed into a field and
// the detected Compose file and env file pickers do not show.
import { useState, type FormEvent, type ReactNode } from "react";
import { postJson, summarize } from "../lib/api";
import { notify } from "../lib/toast";
import { Reicon } from "../components/Reicon";
import { Button, Callout, FormInput, FormTextarea, Listbox } from "../components/Coolify";
import { applicationPath, applicationsApi } from "./ApplicationChrome";

interface Target {
  orgId: string | undefined;
  projectUuid: string;
  environmentUuid: string;
  destination: string;
  serverUuid: string | null;
}

interface Created {
  uuid: string;
  projectUuid: string;
  environmentUuid: string;
}

const targetBody = (t: Target) => ({
  project_uuid: t.projectUuid,
  environment_uuid: t.environmentUuid,
  ...(t.serverUuid ? { server_uuid: t.serverUuid } : {}),
  destination_uuid: t.destination,
});

/** The first message of each of `names` among an answer's field errors. */
function inlineErrors(fields: Record<string, string[]> | undefined, names: readonly string[]): Record<string, string> {
  const inline: Record<string, string> = {};
  for (const name of names) if (fields?.[name]?.[0]) inline[name] = fields[name][0];
  return inline;
}

const DOCKERFILE_PLACEHOLDER = 'FROM nginx\nEXPOSE 80\nCMD ["nginx", "-g", "daemon off;"]\n';

/** <livewire:project.new.simple-dockerfile>: the Dockerfile's text. */
export function DockerfileForm(props: Target) {
  const [dockerfile, setDockerfile] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  /** SimpleDockerfile::submit(): the application is created, not deployed; then its configuration page. */
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    const r = await postJson<Created>(applicationsApi(props.orgId), { type: "dockerfile", ...targetBody(props), dockerfile });
    if (!r.ok) {
      setSaving(false);
      const inline = inlineErrors(r.error.fields, ["dockerfile"]);
      setError(inline.dockerfile);
      if (!inline.dockerfile) notify.error(summarize(r.error.messages));
      return;
    }
    window.location.assign(applicationPath(r.data.projectUuid, r.data.environmentUuid, r.data.uuid));
  }

  return (
    <div className="mt-8 w-full max-w-none lg:mt-3">
      <form onSubmit={(e) => void submit(e)}>
        <section className="application-settings-section">
          <div className="application-settings-section-header">
            <div>
              <h2>Dockerfile</h2>
              <p>Create an application directly from a Dockerfile without connecting a Git repository.</p>
            </div>
            <button type="submit" className="button button-highlighted" disabled={saving}>
              Create application
            </button>
          </div>
          <div className="application-settings-section-body p-0!">
            <FormTextarea id="dockerfile" rows={20} value={dockerfile} onChange={setDockerfile} placeholder={DOCKERFILE_PLACEHOLDER} error={error} />
          </div>
        </section>
      </form>
    </div>
  );
}

/** <x-checkpoint-item>: an icon in a bordered square, a title and a description. */
function CheckpointItem({ title, description, icon }: { title: string; description?: string; icon?: string }) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-fg-dim">
        {icon ? <Reicon name={icon} className="size-4" /> : <span className="size-1.5 rounded-full bg-current opacity-50" />}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold">{title}</span>
        {description ? <span className="mt-0.5 block text-[11px] text-neutral-500 dark:text-fg-faint">{description}</span> : null}
      </span>
    </div>
  );
}

/** <x-forms.repository-paths>'s normalize(): trimmed, no trailing slash, a leading one unless empty. */
function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  return trimmed === "" || trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/**
 * <x-forms.repository-paths>: the base directory and, with `file`, a file
 * relative to it — with the resolved path, and the hints when the file
 * repeats the base directory or (for Compose) sits in a subdirectory.
 */
export function RepositoryPaths(props: {
  className?: string;
  base: string;
  onBase: (value: string) => void;
  baseError?: string | undefined;
  file?: { value: string; onChange: (value: string) => void; label: string; defaultFile: string; error?: string | undefined; compose?: boolean } | undefined;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const { file } = props;
  const directory = normalizePath(props.base);
  const location = file ? normalizePath(file.value) || file.defaultFile : "";
  const repeatsBase = directory !== "" && location.startsWith(`${directory}/`);
  const suggestion = location.slice(directory.length);
  const fileDirectory = location.slice(0, location.lastIndexOf("/"));
  const code = "rounded bg-black/10 px-1 dark:bg-white/10";
  return (
    <div className={`grid gap-4 ${props.className ?? ""}`.trimEnd()}>
      <div onBlur={() => props.onBase(directory || "/")}>
        <FormInput label="Base directory" placeholder="/" helper="Repository directory used as the build root. Useful for monorepos." value={props.base} onChange={props.onBase} disabled={props.disabled === true} error={props.baseError} />
      </div>
      {file ? (
        <>
          <div onBlur={() => file.onChange(location)}>
            <FormInput label={file.label} placeholder={file.defaultFile} helper="Path relative to the base directory." value={file.value} onChange={file.onChange} disabled={props.disabled === true} error={file.error} />
          </div>
          <p className="col-span-full text-xs text-neutral-500 dark:text-fg-dim">
            Resolved file: <code className="font-mono text-coollabs dark:text-brand-light">{directory + location}</code>
          </p>
          {repeatsBase ? (
            <Callout className="col-span-full" title="Base directory is repeated">
              {file.label} is relative to the base directory, so it should not start with <code className={code}>{directory}</code> again.{" "}
              {props.disabled ? null : (
                <button type="button" className="font-medium underline" onClick={() => file.onChange(suggestion)}>
                  Use {suggestion}
                </button>
              )}
            </Callout>
          ) : null}
          {file.compose && fileDirectory !== "" && !repeatsBase ? (
            <Callout className="col-span-full" title="Relative paths resolve from the base directory">
              Docker Compose runs in the base directory <code className={code}>{directory || "/"}</code>, not in the directory of the Compose file. Relative paths in the file, such as a build context of{" "}
              <code className={code}>..</code>, resolve from the base directory. If these paths are relative to the Compose file, set the base directory to <code className={code}>{directory + fileDirectory}</code>.{" "}
              {props.disabled ? null : (
                <button
                  type="button"
                  className="font-medium underline"
                  onClick={() => {
                    file.onChange(location.slice(fileDirectory.length));
                    props.onBase(directory + fileDirectory);
                  }}
                >
                  Use {directory + fileDirectory} as base directory
                </button>
              )}
            </Callout>
          ) : null}
        </>
      ) : null}
      {props.children}
    </div>
  );
}

/** POST …/applications/git/check: PublicGitRepository::loadBranch(). */
interface RepositoryCheck {
  repositoryUrl: string;
  gitSource: "github" | "other";
  gitBranch: string;
  baseDirectory: string;
  rateLimitRemaining: number;
  rateLimitReset: string | 0;
}

const BUILD_PACKS = [
  { value: "railpack", label: "Railpack" },
  { value: "nixpacks", label: "Nixpacks (deprecated)" },
  { value: "static", label: "Static" },
  { value: "dockerfile", label: "Dockerfile" },
  { value: "dockercompose", label: "Docker Compose" },
];

/** lang/en.json repository.url, its markup left out. */
const REPOSITORY_URL_HELPER =
  "Examples\nFor Public repositories, use https://....\nFor Private repositories, use git@....\n\nhttps://github.com/coollabsio/coolify-examples main branch will be selected\nhttps://github.com/coollabsio/coolify-examples/tree/nodejs-fastify nodejs-fastify branch will be selected.\nhttps://gitea.com/sedlav/expressjs.git main branch will be selected.\nhttps://gitlab.com/andrasbacsai/nodejs-example.git main branch will be selected.";

const FIELDS = ["repository_url", "git_branch", "build_pack", "port", "isStatic", "publish_directory", "base_directory", "docker_compose_location", "selectedDockerfile"] as const;

/** <livewire:project.new.public-git-repository>: "Check repository", then the build configuration. */
export function PublicGitRepositoryForm(props: Target) {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [checking, setChecking] = useState(false);
  const [found, setFound] = useState<RepositoryCheck | null>(null);
  // The component's rate_limit_remaining: 0 until GitHub has answered once.
  const [rateLimitRemaining, setRateLimitRemaining] = useState(0);
  const [gitBranch, setGitBranch] = useState("main");
  const [buildPack, setBuildPackValue] = useState("railpack");
  const [isStatic, setIsStatic] = useState(false);
  const [port, setPort] = useState("3000");
  const [publishDirectory, setPublishDirectory] = useState("");
  const [baseDirectory, setBaseDirectory] = useState("/");
  const [dockerComposeLocation, setDockerComposeLocation] = useState("/docker-compose.yaml");
  const [selectedDockerfile, setSelectedDockerfile] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const api = applicationsApi(props.orgId);
  const showIsStatic = buildPack === "nixpacks" || buildPack === "railpack";

  /** loadBranch(): the URL as Coolify rewrites it, its branch and base directory. */
  async function loadBranch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (checking) return;
    setChecking(true);
    const r = await postJson<RepositoryCheck>(`${api}/git/check`, { repository_url: repositoryUrl, rate_limit_remaining: rateLimitRemaining });
    setChecking(false);
    if (!r.ok) return notify.error(summarize(r.error.messages));
    setFound(r.data);
    setRepositoryUrl(r.data.repositoryUrl);
    setRateLimitRemaining(r.data.rateLimitRemaining);
    setGitBranch(r.data.gitBranch);
    setBaseDirectory(r.data.baseDirectory);
    setErrors({});
  }

  /** updatedBuildPack() */
  function setBuildPack(value: string) {
    setBuildPackValue(value);
    if (value === "nixpacks" || value === "railpack") {
      if (!isStatic) setPort("3000");
    } else {
      setIsStatic(false);
      if (value === "static") setPort("80");
    }
  }

  /** instantSave(): the output type decides the port and the publish directory. */
  function setOutputType(value: boolean) {
    setIsStatic(value);
    setPort(value ? "80" : "3000");
    setPublishDirectory(value ? "/dist" : "");
    notify.success("Application settings updated!");
  }

  /** detectRepository(): Smart Scan runs on the server. */
  async function scan() {
    if (scanning) return;
    setScanning(true);
    const r = await postJson<never>(`${api}/git/scan`, { git_branch: gitBranch, base_directory: baseDirectory, destination_uuid: props.destination });
    setScanning(false);
    if (!r.ok) notify.error(summarize(r.error.messages));
  }

  /** submit(): the application is created, not deployed; then its configuration page. */
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    const r = await postJson<Created>(api, {
      type: "public",
      ...targetBody(props),
      repository_url: repositoryUrl,
      git_branch: gitBranch,
      build_pack: buildPack,
      port,
      isStatic,
      publish_directory: publishDirectory === "" ? null : publishDirectory,
      base_directory: baseDirectory,
      docker_compose_location: dockerComposeLocation,
      ...(buildPack === "dockerfile" ? { selectedDockerfile } : {}),
    });
    if (!r.ok) {
      setSaving(false);
      const inline = inlineErrors(r.error.fields, FIELDS);
      setErrors(inline);
      // Fields this step does not show (the repository, the build pack) and errors without a field are toasts.
      const hidden = ["repository_url", "build_pack", "isStatic"].filter((f) => inline[f]).map((f) => inline[f]!);
      if (hidden.length || !Object.keys(inline).length) notify.error(summarize(hidden.length ? hidden : r.error.messages));
      return;
    }
    window.location.assign(applicationPath(r.data.projectUuid, r.data.environmentUuid, r.data.uuid));
  }

  return (
    <div className="mt-8 flex w-full max-w-none flex-col gap-6 lg:mt-3">
      <form onSubmit={(e) => void loadBranch(e)}>
        <section className="application-settings-section">
          <div className="application-settings-section-header">
            <div>
              <h2>Public Git repository</h2>
              <p>Connect a public repository over HTTPS and inspect its default branch.</p>
            </div>
          </div>
          <div className="application-settings-section-body">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <FormInput
                  id="repository_url"
                  label="Repository URL"
                  required
                  helper={REPOSITORY_URL_HELPER}
                  placeholder="https://github.com/owner/repository"
                  value={repositoryUrl}
                  onChange={setRepositoryUrl}
                />
              </div>
              <button type="submit" className="button w-full justify-center sm:w-auto" disabled={checking}>
                {checking ? (
                  <svg className="size-3.5 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-75" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                ) : null}
                Check repository
              </button>
            </div>
            <p className="mt-2 text-xs text-neutral-500 dark:text-fg-dim">
              Need a sample? Browse{" "}
              <a className="font-medium text-coollabs hover:underline dark:text-brand-light" href="https://github.com/coollabsio/coolify-examples/" target="_blank" rel="noreferrer">
                Coolify Examples
              </a>
              .
            </p>
          </div>
        </section>
      </form>

      {found ? (
        <form onSubmit={(e) => void submit(e)}>
          <section className="application-settings-section">
            <div className="application-settings-section-header">
              <div>
                <h2>Build configuration</h2>
                <p>Choose how Freeploy builds and runs this repository.</p>
              </div>
              <button type="submit" className="button button-highlighted" disabled={saving}>
                Continue
              </button>
            </div>
            <div className="application-settings-section-body space-y-5">
              {found.rateLimitRemaining && found.rateLimitReset ? (
                <Callout type="info" title="Git provider rate limit">
                  {found.rateLimitRemaining} requests remain. The limit resets at {found.rateLimitReset} UTC.
                </Callout>
              ) : null}

              <div className="overflow-hidden rounded-[10px] border border-neutral-200 dark:border-white/[0.08]">
                <div className="flex min-h-10 items-center justify-between gap-3 border-b border-neutral-200 py-1.5 pr-1.5 pl-4 dark:border-white/[0.08]">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-neutral-400 dark:text-fg-faint">Smart Scan</p>
                  <Button onClick={() => void scan()} disabled={scanning}>
                    <Reicon name="search" className="size-3.5" />
                    Scan repository
                  </Button>
                </div>
                <div className="divide-y divide-neutral-200 dark:divide-white/[0.07]">
                  <CheckpointItem icon="search" title="Not scanned yet" description="Scan the repository to find Dockerfiles, Compose files, and env files." />
                </div>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <FormInput
                  id="git_branch"
                  label="Branch"
                  disabled={found.gitSource !== "other"}
                  helper="You can choose another branch after the application is created."
                  value={gitBranch}
                  onChange={setGitBranch}
                  error={errors.git_branch}
                />
                <Listbox id="build_pack" label="Build pack" required options={BUILD_PACKS} value={buildPack} onChange={setBuildPack} />
                {showIsStatic ? (
                  <>
                    <Listbox
                      id="isStatic"
                      label="Output type"
                      options={[
                        { value: "false", label: "Web application" },
                        { value: "true", label: "Static site" },
                      ]}
                      value={String(isStatic)}
                      onChange={(v) => setOutputType(v === "true")}
                    />
                    <FormInput id="port" type="number" label="Port" readOnly={isStatic} helper="Port the application listens on." value={port} onChange={setPort} error={errors.port} />
                  </>
                ) : null}
                {isStatic ? (
                  <FormInput
                    id="publish_directory"
                    label="Publish directory"
                    helper="Directory containing the generated static assets."
                    value={publishDirectory}
                    onChange={setPublishDirectory}
                    error={errors.publish_directory}
                  />
                ) : null}
              </div>

              {buildPack === "nixpacks" ? (
                <Callout type="warning" title="Nixpacks is deprecated">
                  Nixpacks is deprecated and is in maintenance mode upstream. We recommend Railpack, the successor of Nixpacks, for new and existing applications.
                </Callout>
              ) : null}

              {buildPack === "dockerfile" ? (
                <FormInput
                  id="selectedDockerfile"
                  label="Dockerfile"
                  placeholder="/Dockerfile"
                  helper="Select a detected Dockerfile, or type a path relative to the base directory."
                  value={selectedDockerfile}
                  onChange={setSelectedDockerfile}
                  error={errors.selectedDockerfile}
                />
              ) : null}

              {buildPack === "dockercompose" ? (
                <RepositoryPaths
                  className="sm:grid-cols-2"
                  base={baseDirectory}
                  onBase={setBaseDirectory}
                  baseError={errors.base_directory}
                  file={{ value: dockerComposeLocation, onChange: setDockerComposeLocation, label: "Compose file", defaultFile: "/docker-compose.yaml", error: errors.docker_compose_location, compose: true }}
                />
              ) : (
                <FormInput
                  id="base_directory"
                  label="Base directory"
                  placeholder="/"
                  helper="Repository directory used as the build root."
                  value={baseDirectory}
                  onChange={setBaseDirectory}
                  error={errors.base_directory}
                />
              )}
            </div>
          </section>
        </form>
      ) : null}
    </div>
  );
}
