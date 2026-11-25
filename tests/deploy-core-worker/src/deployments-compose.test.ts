// generate_compose_file() and the runtime .env file (DP-56), as pure functions of plain row data, against
// Coolify's own PHP: for every golden run (fixtures/deployments) the compose file is the text
// coollabsio/coolify@91b7e3e's job piped into `tee …/docker-compose.yaml` — Symfony's Yaml::dump($compose, 10),
// byte for byte — and the .env file is the text it wrote base64-encoded into `tee …/.env`.
import { goldenRun, runCases, type RunCase } from "./deployment-goldens";
import { applicationRow, contextOf } from "./deployment-fixtures";
import { generateApplicationContainerName, generateComposeFile, ComposeError, productionImageName, resolveDockerImageTag, type ComposeInput } from "@deploy-core-worker/deployments/compose";
import { generateRuntimeEnvironmentVariables, logRedactionSecretsFor, NO_SECRET_MANAGER_MESSAGE, RuntimeEnvError } from "@deploy-core-worker/deployments/runtime-env";
import { GOLDEN_NOW } from "./deployment-goldens";

const NOW = new Date(GOLDEN_NOW);

function composeInput(run: RunCase): ComposeInput {
  const ctx = contextOf(run);
  const app = ctx.application;
  return {
    application: app,
    settings: app,
    containerName: generateApplicationContainerName(app, app, NOW),
    productionImageName: productionImageName(app.docker_registry_image_name, resolveDockerImageTag(app, ctx.deployment)),
    network: app.destination_network!,
    primaryNetwork: app.destination_network!,
    projectName: app.project_name,
    environmentName: app.environment_name,
    logDrain: app,
    persistentStorages: ctx.persistentStorages,
    fileStorages: ctx.fileStorages,
    generateLabels: ctx.generateLabels,
  };
}

/**
 * The Docker image runs: their compose file and .env file are functions of the rows alone. Those of a build
 * (DP-61) also depend on what the job found on the way — the commit, a Dockerfile's HEALTHCHECK, the variables
 * Nixpacks needs — so they are compared where the job runs: deployments-engine.test.ts replays every one of
 * them and compares the same two files, byte for byte, as the standard input and the command the job wrote.
 */
const imageRuns = runCases.filter((run) => run.application.build_pack === "dockerimage");

/** The runs in which Coolify wrote a compose file, with the text it wrote. */
const composed = imageRuns.flatMap((run) => {
  const written = goldenRun(run.id).processes.find((p) => /^docker exec -i \S+ tee \/artifacts\/\S+\/docker-compose\.yaml > \/dev\/null$/.test(p.script));
  return written ? [[run.id, run, written.input ?? ""] as const] : [];
});

/** The runs in which Coolify wrote a .env file with content, with that content. */
const envs = imageRuns.flatMap((run) => {
  const written = goldenRun(run.id).processes.find((p) => /^echo '[A-Za-z0-9+/=]*' \| base64 -d \| tee \/data\/coolify\/applications\/\S+\/\.env > \/dev\/null$/.test(p.script));
  return written ? [[run.id, run, Buffer.from(written.script.split("'")[1]!, "base64").toString("utf8")] as const] : [];
});

describe("generate_compose_file()", () => {
  it("has at least 40 golden compose files", () => {
    expect(composed.length).toBeGreaterThanOrEqual(40);
    // … and they are not one file forty times.
    expect(new Set(composed.map(([, , yaml]) => yaml)).size).toBeGreaterThanOrEqual(40);
  });

  it.each(composed)("%s", (id, run, yaml) => {
    const result = generateComposeFile(composeInput(run));
    expect(result.yaml).toBe(yaml);
    // What the job saves back to applications.custom_labels (nothing when no labels are stored).
    const saved = goldenRun(id).application.custom_labels;
    expect(result.customLabels ?? null).toBe(run.application.custom_labels == null ? null : saved);
  });

  it("stops where Coolify stops with a PHP error: no stored labels while labels are edited by hand", () => {
    const run = JSON.parse(JSON.stringify(runCases.find((r) => r.id === "run.first")!)) as RunCase;
    run.settings.is_container_label_readonly_enabled = false;
    expect(() => generateComposeFile(composeInput(run))).toThrow(ComposeError);
  });

  it("names the container after the application and the second it was queued for, or consistently", () => {
    const app = applicationRow(runCases.find((r) => r.id === "run.first")!);
    expect(generateApplicationContainerName(app, app, NOW)).toBe("app0000000000000000000001-20261120T101112");
    expect(generateApplicationContainerName(app, { ...app, custom_container_name_prefix: "api" }, NOW)).toBe("api-20261120T101112");
    expect(generateApplicationContainerName(app, { ...app, is_consistent_container_name_enabled: true }, NOW)).toBe("app0000000000000000000001");
    expect(generateApplicationContainerName(app, { ...app, is_consistent_container_name_enabled: true, custom_internal_name: "my-api" }, NOW)).toBe("my-api");
  });

  it("deploys the tag of the application, the commit of a rollback, or latest", () => {
    expect(resolveDockerImageTag({ docker_registry_image_tag: "1.27" }, { rollback: false, commit: "abc" })).toBe("1.27");
    expect(resolveDockerImageTag({ docker_registry_image_tag: "1.27" }, { rollback: true, commit: "1.26" })).toBe("1.26");
    expect(resolveDockerImageTag({ docker_registry_image_tag: "1.27" }, { rollback: true, commit: "" })).toBe("1.27");
    expect(resolveDockerImageTag({ docker_registry_image_tag: null }, { rollback: false, commit: "HEAD" })).toBe("latest");
    expect(productionImageName("ghcr.io/a/b", "sha256-" + "ab".repeat(32))).toBe("ghcr.io/a/b@sha256:" + "ab".repeat(32));
  });
});

describe("the runtime .env file (generate_runtime_environment_variables)", () => {
  it("has at least 40 golden .env files", () => {
    expect(envs.length).toBeGreaterThanOrEqual(40);
  });

  it.each(envs)("%s", (_id, run, content) => {
    const ctx = contextOf(run);
    const app = ctx.application;
    const env = generateRuntimeEnvironmentVariables({
      application: app,
      settings: app,
      commit: ctx.deployment.commit,
      containerName: generateApplicationContainerName(app, app, NOW),
      projectName: app.project_name,
      environmentName: app.environment_name,
      serverIp: app.server_ip,
      variables: ctx.variables,
    });
    expect(env.lines.join("\n")).toBe(content);
  });

  it("an empty file when every generated variable is the user's own and none is a runtime variable", () => {
    const ctx = contextOf(runCases.find((r) => r.id === "env.empty")!);
    const app = ctx.application;
    expect(generateRuntimeEnvironmentVariables({ application: app, settings: app, commit: "HEAD", containerName: "c", projectName: "p", environmentName: "e", serverIp: app.server_ip, variables: ctx.variables }).lines).toEqual([]);
  });

  it("a {{vault.KEY}} reference has no source: Coolify's message", () => {
    const ctx = contextOf(runCases.find((r) => r.id === "env.vault")!);
    const app = ctx.application;
    const generate = () => generateRuntimeEnvironmentVariables({ application: app, settings: app, commit: "HEAD", containerName: "c", projectName: "p", environmentName: "e", serverIp: app.server_ip, variables: ctx.variables });
    expect(generate).toThrow(RuntimeEnvError);
    expect(generate).toThrow(NO_SECRET_MANAGER_MESSAGE);
  });

  it("hides every value in the log, or only the locked ones", () => {
    const variables = contextOf(runCases.find((r) => r.id === "env.redaction.locked-only")!).variables;
    expect(logRedactionSecretsFor(variables, false)).toEqual({
      known: [],
      locked: ["pw-locked-1", "'first line\nsecond line'", "first line\nsecond line", "'first line\nsecond line'", "first line\\nsecond line", "first line", "second line"].filter((v, i, all) => all.indexOf(v) === i),
    });
    expect(logRedactionSecretsFor(variables, true).known).toEqual(["tok_live_0123456789"]);
  });
});
