// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/project/application/general.blade.php
// (the "Build & deploy" section of the build packs), resources/views/components/forms/repository-paths.blade.php
// and app/Livewire/Project/Application/General.php (Apache-2.0), modified.
//
// The General page's "Build & deploy" section for an application that is
// built — Railpack, Nixpacks, Static, Dockerfile or Docker Compose: the build
// strategy, the site type, the repository paths, the commands, the Dockerfile
// or the Compose file, the Nginx configuration and the image registry.
// ApplicationGeneral.tsx owns the form; this file adds its fields and draws
// them. Not here: loading or reloading the Compose file (it is read from the
// repository on the server), the deployable Compose and the per-service
// domains (the Compose parser), and the builder's fallback sentence (a team
// setting Freeploy does not have).
import type { ReactNode } from "react";
import { Callout, FormInput, FormTextarea, Listbox, ModalConfirmation, SettingsSubsection } from "../components/Coolify";
import { RepositoryPaths } from "./ResourceCreateBuilt";

/** GET …/applications/{uuid}: `build`, the fields of the build packs. */
export interface ApplicationBuild {
  gitBased: boolean;
  hasDockerfile: boolean;
  publicRepository: boolean;
  supportsWatchPaths: boolean;
  couldSetBuildCommands: boolean;
  staticImage: string;
  baseDirectory: string;
  publishDirectory: string | null;
  installCommand: string | null;
  buildCommand: string | null;
  startCommand: string | null;
  dockerfile: string | null;
  dockerfileLocation: string | null;
  dockerfileTargetBuild: string | null;
  dockerComposeLocation: string | null;
  dockerComposeRaw: string | null;
  dockerComposeCustomStartCommand: string | null;
  dockerComposeCustomBuildCommand: string | null;
  dockerComposeBuildCommandPreview: string;
  dockerComposeStartCommandPreview: string;
  customNginxConfiguration: string | null;
  watchPaths: string | null;
  isStatic: boolean;
  isSpa: boolean;
  siteType: "dynamic" | "static" | "spa";
  isBuildServerEnabled: boolean;
  isPreserveRepositoryEnabled: boolean;
  isRawComposeDeploymentEnabled: boolean;
  composeParsingVersion: number;
  hasBuildServers: boolean;
  composeLoadUnavailable: string | null;
}

/** What the application's answers carry beside the application itself. */
export interface WithBuild {
  build?: ApplicationBuild | null;
}

/** General's properties of the build packs that the form edits as text (the two container names apply to Compose). */
export const BUILD_FIELDS = [
  "staticImage",
  "baseDirectory",
  "publishDirectory",
  "installCommand",
  "buildCommand",
  "startCommand",
  "watchPaths",
  "dockerfile",
  "dockerfileLocation",
  "dockerfileTargetBuild",
  "dockerComposeLocation",
  "dockerComposeCustomBuildCommand",
  "dockerComposeCustomStartCommand",
  "customNginxConfiguration",
  "preDeploymentCommandContainer",
  "postDeploymentCommandContainer",
] as const;
export type BuildField = (typeof BUILD_FIELDS)[number];

interface FieldProps {
  id: string;
  value: string;
  onChange: (v: string) => void;
  error: string | undefined;
  disabled: boolean;
}

const BUILD_PACKS = [
  { value: "railpack", label: "Railpack" },
  { value: "nixpacks", label: "Nixpacks (deprecated)" },
  { value: "static", label: "Static" },
  { value: "dockerfile", label: "Dockerfile" },
  { value: "dockercompose", label: "Compose" },
];

const COMPOSE_COMMAND_HELPER =
  "The compose file path (-f flag) and environment variables (--env-file flag) are automatically injected based on your Base Directory and Docker Compose Location settings. You can override by providing your own -f or --env-file flags.\n\nIf you use this, you need to specify paths relatively and should use the same compose file in the custom command, otherwise the automatically configured labels / etc won't work.\n\nExample usage: ";
const WATCH_PATHS_HELPER =
  "Order-based pattern matching to filter Git webhook deployments. Enter one pattern per line. Commas do not separate patterns. Supports wildcards (*, **, ?) and negation (!). Last matching pattern wins.";
const COMPOSE_READONLY_HELPER = "You need to modify the docker compose file in the git repository.";
const TAG_HELPER =
  "If set, Freeploy also tags the built image with this tag. The commit SHA tag stays, and the container runs it. \n\nExample: If you set it to 'latest', Freeploy pushes the image with the commit SHA tag and the latest tag. \n\nTwo applications cannot push the same Docker image name, also with different tags. Use a different image name for each application, for example ghcr.io/your-org/your-app-staging.";

/**
 * The "Build & deploy" section's body above "Deployment commands", for a
 * build pack other than Docker Image.
 */
export function BuildPipeline(props: {
  buildPack: string;
  build: ApplicationBuild;
  swarm: boolean;
  canUpdate: boolean;
  /** The form's field of this name (ApplicationGeneral's field()). */
  field: (name: BuildField | "dockerRegistryImageName" | "dockerRegistryImageTag") => FieldProps;
  /** updatedBuildPack(): the form is saved with the new build strategy. */
  onBuildPack: (buildPack: string) => void;
  /** instantSave() / generateNginxConfiguration(): a setting that saves itself. */
  onInstant: (body: Record<string, unknown>) => Promise<void>;
}) {
  const { buildPack, build, canUpdate, field } = props;
  const compose = buildPack === "dockercompose";
  const showStatic = build.isStatic || buildPack === "static";
  const base = field("baseDirectory");
  const pathsDisabled = !canUpdate;
  const tool = buildPack === "railpack" ? "railpack.json" : "nixpacks.toml";
  const commandHelper = `If you modify this, you probably need to have a ${tool}`;
  const fileOf = (name: "dockerfileLocation" | "dockerComposeLocation", label: string, defaultFile: string, composeFile = false) => {
    const f = field(name);
    return { value: f.value, onChange: f.onChange, label, defaultFile, error: f.error, compose: composeFile };
  };
  const watchPaths = (placeholder: string): ReactNode => <FormTextarea {...field("watchPaths")} helper={WATCH_PATHS_HELPER} placeholder={placeholder} label="Watch paths" monospace={false} />;

  return (
    <>
      {!build.hasDockerfile ? (
        <div className="application-build-pack-options mb-5 border-b border-neutral-200 pb-5 dark:border-white/[0.07]">
          <div className="grid gap-4 sm:grid-cols-2">
            <Listbox id="buildPack" label="Build strategy" options={BUILD_PACKS} value={buildPack} onChange={(v) => (v === buildPack ? undefined : props.onBuildPack(v))} disabled={!canUpdate} />
            {showStatic ? (
              <Listbox id="staticImage" label="Web server" required options={[{ value: "nginx:alpine", label: "nginx:alpine" }]} value={field("staticImage").value} onChange={field("staticImage").onChange} disabled={!canUpdate} error={field("staticImage").error} />
            ) : null}
          </div>
        </div>
      ) : null}
      {build.couldSetBuildCommands || (build.isStatic && buildPack !== "static") ? (
        <div className="mb-5 w-full border-b border-neutral-200 pb-5 dark:border-white/[0.07]">
          <div className="grid gap-4 sm:grid-cols-2">
            <Listbox
              id="siteType"
              label="Site type"
              options={[
                { value: "dynamic", label: "Dynamic" },
                { value: "static", label: "Static" },
                { value: "spa", label: "SPA (single-page application)" },
              ]}
              helper="Static: the final build assets are served as a static site. SPA: a static site with single-page-app routing."
              value={build.siteType}
              onChange={(siteType) => (siteType === build.siteType ? undefined : void props.onInstant({ instantSave: true, siteType }))}
              disabled={!canUpdate}
            />
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-5">
          {compose ? (
            <div className="flex flex-col gap-2">
              <RepositoryPaths
                className="lg:grid-cols-2"
                base={base.value}
                onBase={base.onChange}
                baseError={base.error}
                file={fileOf("dockerComposeLocation", "Docker compose location", "/docker-compose.yaml", true)}
                disabled={pathsDisabled}
              />
              <div className="w-full sm:w-96">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    id="isPreserveRepositoryEnabled"
                    checked={build.isPreserveRepositoryEnabled}
                    disabled={!canUpdate}
                    onChange={(e) => void props.onInstant({ instantSave: true, isPreserveRepositoryEnabled: e.target.checked })}
                  />
                  <span title="Git repository (based on the base directory settings) will be copied to the deployment directory.">Preserve repository during deployment</span>
                </label>
              </div>
              <div className="grid gap-4 pt-4">
                <div className="grid gap-4 lg:grid-cols-2">
                  <FormInput {...field("dockerComposeCustomBuildCommand")} placeholder="docker compose build" helper={`${COMPOSE_COMMAND_HELPER}docker compose build`} label="Custom build command" />
                  <FormInput {...field("dockerComposeCustomStartCommand")} placeholder="docker compose up -d" helper={`${COMPOSE_COMMAND_HELPER}docker compose up -d`} label="Custom start command" />
                </div>
                {build.dockerComposeCustomBuildCommand ? (
                  <FormInput readOnly value={build.dockerComposeBuildCommandPreview} label="Final build command (preview)" helper="This shows the actual command that will be executed with auto-injected flags." />
                ) : null}
                {build.dockerComposeCustomStartCommand ? (
                  <FormInput readOnly value={build.dockerComposeStartCommandPreview} label="Final start command (preview)" helper="This shows the actual command that will be executed with auto-injected flags." />
                ) : null}
              </div>
              {build.supportsWatchPaths ? <div className="pt-4">{watchPaths("services/api/**")}</div> : null}
            </div>
          ) : (
            <>
              <RepositoryPaths
                className="lg:grid-cols-2"
                base={base.value}
                onBase={base.onChange}
                baseError={base.error}
                file={buildPack === "dockerfile" && !build.hasDockerfile ? fileOf("dockerfileLocation", "Dockerfile location", "/Dockerfile") : undefined}
                disabled={pathsDisabled}
              >
                {build.couldSetBuildCommands ? <FormInput {...field("publishDirectory")} placeholder={build.isStatic ? "/dist" : "/"} label="Publish directory" required={build.isStatic} /> : null}
              </RepositoryPaths>
              {build.supportsWatchPaths ? <div className="pb-4">{watchPaths("src/pages/**")}</div> : null}
              {build.couldSetBuildCommands ? (
                <div className="grid gap-4 lg:grid-cols-3">
                  <FormInput {...field("installCommand")} helper={commandHelper} label="Install command" />
                  <FormInput {...field("buildCommand")} helper={commandHelper} label="Build command" />
                  <FormInput {...field("startCommand")} helper={commandHelper} label="Start command" />
                </div>
              ) : null}
              <div className="grid gap-4 pt-2 sm:grid-cols-2">
                {buildPack === "dockerfile" ? <FormInput {...field("dockerfileTargetBuild")} label="Docker build stage target" helper="Useful if you have multi-staged dockerfile." /> : null}
                <Listbox
                  id="isBuildServerEnabled"
                  label="Builder selection"
                  options={[
                    { value: "false", label: "Deployment server" },
                    { value: "true", label: build.hasBuildServers ? "Available build server (auto-select)" : "No build servers connected" },
                  ]}
                  helper="Build your application on a dedicated build server. If several build servers are connected, Freeploy picks an available one automatically."
                  value={String(build.isBuildServerEnabled)}
                  onChange={(v) => {
                    // The option is disabled in Coolify while no build server is connected.
                    if (v === String(build.isBuildServerEnabled) || (v === "true" && !build.hasBuildServers)) return;
                    void props.onInstant({ instantSave: true, isBuildServerEnabled: v === "true" });
                  }}
                  disabled={!canUpdate}
                />
              </div>
            </>
          )}
        </div>
      </div>
      {showStatic ? (
        <div className="mt-5 border-t border-neutral-200 pt-5 dark:border-white/[0.07]">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <label className="flex w-fit items-center gap-1.5" style={{ marginBottom: 0 }} title="You can add custom Nginx configuration here.">
              Custom Nginx configuration
            </label>
            {canUpdate ? (
              <ModalConfirmation
                title="Confirm Nginx Configuration Generation?"
                buttonTitle="Generate default"
                actions={["This will overwrite your current custom Nginx configuration.", `The default configuration will be generated based on your application type (${build.isSpa ? "SPA" : "static"}).`]}
                confirmationText={null}
                onSubmit={() => props.onInstant({ generateNginxConfiguration: build.isSpa ? "spa" : "static" })}
              />
            ) : null}
          </div>
          <FormTextarea {...field("customNginxConfiguration")} placeholder="Empty means default configuration will be used." rows={10} />
        </div>
      ) : null}
      {compose ? (
        <div className="mt-5">
          {canUpdate ? (
            <>
              <div className="mb-2 flex items-center justify-between gap-4">
                <h3>Docker Compose</h3>
              </div>
              {build.composeLoadUnavailable ? (
                <Callout type="info" title="The Compose file is not loaded" className="mb-4">
                  {build.composeLoadUnavailable}
                </Callout>
              ) : null}
              <FormTextarea
                id="dockerComposeRaw"
                rows={10}
                disabled
                value={build.dockerComposeRaw ?? ""}
                onChange={() => undefined}
                label={build.isRawComposeDeploymentEnabled ? "Docker compose content" : "Docker compose content (raw)"}
                helper={COMPOSE_READONLY_HELPER}
              />
            </>
          ) : (
            <>
              <h3 className="mb-2">Docker Compose</h3>
              <Callout type="info" title="Hidden (only admins can view)" className="mb-4">
                The Docker Compose file can contain secrets.
              </Callout>
            </>
          )}
        </div>
      ) : null}
      {build.hasDockerfile ? (
        <div className="mt-6">
          <FormTextarea {...field("dockerfile")} label="Dockerfile" rows={6} />
        </div>
      ) : null}
      {compose ? null : (
        <SettingsSubsection id="container-image-section" title="Image registry">
          {props.swarm ? (
            <div>
              Docker Swarm requires the image to be available in a registry. More info{" "}
              <a className="underline" href="https://coolify.io/docs/knowledge-base/docker/registry" target="_blank" rel="noreferrer">
                here
              </a>
              .
            </div>
          ) : null}
          <div className="grid gap-4 lg:grid-cols-2">
            {props.swarm || build.isBuildServerEnabled ? (
              <FormInput {...field("dockerRegistryImageName")} required label="Image" placeholder="ghcr.io/your-org/your-app" />
            ) : (
              <FormInput
                {...field("dockerRegistryImageName")}
                helper={"Empty means it won't push the image to a docker registry. Pre-tag the image with your registry url if you want to push it to a private registry (default: Dockerhub). \n\nExample: ghcr.io/myimage"}
                placeholder="ghcr.io/your-org/your-app"
                label="Image"
              />
            )}
            <FormInput {...field("dockerRegistryImageTag")} helper={TAG_HELPER} placeholder="latest" label="Tag" />
          </div>
        </SettingsSubsection>
      )}
    </>
  );
}
