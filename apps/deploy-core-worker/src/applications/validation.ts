// Derived from coollabsio/coolify@91b7e3e:app/Support/ValidationPatterns.php (the Docker image, port
// mapping, shell-safe command and container name patterns and rules), app/Livewire/Project/New/DockerImage.php
// (submit) and app/Livewire/Project/Application/General.php (rules, messages, validationAttributes)
// (Apache-2.0), modified.
//
// Laravel's validator for the Docker Image form and for General's fields of a
// Docker image application, rule by rule. DockerImage::submit() has no
// messages of its own: Laravel's defaults with the Livewire property as the
// attribute ("image name"). General has messages() and validationAttributes
// ("The Docker registry image name field …"). All failing rules of a field
// are reported in rule order (no `bail`); a blank value skips every rule but
// `required`.
import { add, blank, descriptionRules, length, nameRules, type FieldErrors } from "../private-keys/validation.js";
import { LARAVEL } from "../servers/settings-validation.js";
import { validateApplicationDomains } from "./domains.js";

/** ValidationPatterns::DOCKER_IMAGE_NAME_PATTERN: a repository with an optional registry, no tag; "@sha256" may end it. */
export const DOCKER_IMAGE_NAME_PATTERN =
  /^(?=.{1,255}$)(?:(?:(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:.]+\])(?::[0-9]+)?\/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*)(?:@sha256)?$/;

const TAG_VARIABLE = "\\$(?:[A-Za-z_][A-Za-z0-9_]*|\\{[A-Za-z_][A-Za-z0-9_]*(?::?-[A-Za-z0-9_.-]*)?\\})";
/** ValidationPatterns::DOCKER_IMAGE_TAG_PATTERN: a Docker tag; $VAR, ${VAR}, ${VAR:-default} and ${VAR-default} are allowed in it. */
export const DOCKER_IMAGE_TAG_PATTERN = new RegExp(`^(?=.{1,128}$)(?:[A-Za-z0-9_]|${TAG_VARIABLE})(?:[A-Za-z0-9_.-]|${TAG_VARIABLE})*$`);

/** DockerImage::submit(): 'regex:/^[a-f0-9]{64}$/i'. */
export const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

/** General::rules(): portsExposes 'regex:/^(\d+)(,\d+)*$/'. */
export const PORTS_EXPOSES_PATTERN = /^(\d+)(,\d+)*$/;

const MAPPING_IP = "(?:(?:\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|\\[[\\da-fA-F:]+\\]):)?";
const MAPPING_PORT = "\\d+(?:-\\d+)?(?:\\/(?:tcp|udp|sctp))?";
const MAPPING = `${MAPPING_IP}(?:${MAPPING_PORT})?:${MAPPING_IP}${MAPPING_PORT}`;
/** ValidationPatterns::PORT_MAPPINGS_PATTERN: [ip:][host port]:[ip:]container port, comma separated. */
export const PORT_MAPPINGS_PATTERN = new RegExp(`^${MAPPING}(?:,${MAPPING})*$`);

/** ValidationPatterns::SHELL_SAFE_COMMAND_PATTERN */
export const SHELL_SAFE_COMMAND_PATTERN = /^(?:[ \t]+|&&|\|\||"[^"$`\\\n\r]*"|'[^'\n\r]*'|[a-zA-Z0-9._\-/=:@,+[\]{}#%^~*?!]+)+$/;

/** ValidationPatterns::CONTAINER_NAME_PATTERN */
export const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Laravel's default messages for an attribute given as it is displayed. */
const DEFAULT = {
  required: (attribute: string) => `The ${attribute} field is required.`,
  string: (attribute: string) => `The ${attribute} field must be a string.`,
  max: (attribute: string, n: number) => `The ${attribute} field must not be greater than ${n} characters.`,
  regex: (attribute: string) => `The ${attribute} field format is invalid.`,
} as const;

const SHELL_SAFE_TAIL =
  "Allowed: alphanumerics, && / || chaining, balanced quotes, globs (*, ?), !, and safe path/arg chars. Blocked: bare &, bare |, ;, $, backtick, (, ), <, >, \\, newlines.";

export const APPLICATION_MESSAGES = {
  /** DockerImage::submit() */
  tagOrDigest: "Provide either a tag or SHA256 digest, not both.",
  /** General::messages() */
  nameRequired: "The Name field is required.",
  portsExposesRegex: "Ports exposes must be a comma-separated list of port numbers (e.g. 3000,3001).",
  /** ValidationPatterns::portMappingMessages() */
  portsMappingsRegex: "Port mappings must be a comma-separated list of port pairs or ranges with optional IP and protocol (e.g. 3000:3000, 8080:80/udp, 127.0.0.1:8080:80, [::1]::80).",
  customDockerRunOptionsRegex: `The custom Docker run options contain invalid characters. ${SHELL_SAFE_TAIL}`,
  preDeploymentCommandContainerRegex: "The pre-deployment command container name must contain only alphanumeric characters, dots, hyphens, and underscores.",
  postDeploymentCommandContainerRegex: "The post-deployment command container name must contain only alphanumeric characters, dots, hyphens, and underscores.",
} as const;

/** General's $validationAttributes for the fields of a Docker image application. */
export const GENERAL_ATTRIBUTES = {
  fqdn: "FQDN",
  portsExposes: "Ports exposes",
  portsMappings: "Ports mappings",
  dockerRegistryImageName: "Docker registry image name",
  dockerRegistryImageTag: "Docker registry image tag",
  customDockerRunOptions: "Custom docker run commands",
  customNetworkAliases: "Custom docker network aliases",
  // No entry in $validationAttributes: Laravel derives these from the property.
  preDeploymentCommand: "pre deployment command",
  preDeploymentCommandContainer: "pre deployment command container",
  postDeploymentCommand: "post deployment command",
  postDeploymentCommandContainer: "post deployment command container",
} as const;

type Result<T> = { ok: true; input: T } | { ok: false; errors: FieldErrors };
type Body = Record<string, unknown>;

/** nullable|string|max:n|regex with the given messages: the string, or null for a blank value. */
function nullableString(errors: FieldErrors, field: string, value: unknown, attribute: string, rules: { max?: number; regex?: RegExp; regexMessage?: string } = {}): string | null {
  if (blank(value)) return typeof value === "string" ? value : null;
  if (typeof value !== "string") {
    add(errors, field, DEFAULT.string(attribute));
    return null;
  }
  if (rules.max !== undefined && length(value) > rules.max) add(errors, field, DEFAULT.max(attribute, rules.max));
  if (rules.regex && !rules.regex.test(value)) add(errors, field, rules.regexMessage ?? DEFAULT.regex(attribute));
  return value;
}

export interface CreateDockerImageInput {
  projectUuid: string;
  environmentUuid: string;
  /** Optional: when given, the destination must be one of this server's. */
  serverUuid: string | null;
  destinationUuid: string | null;
  imageName: string;
  imageTag: string;
  imageSha256: string;
}

const UUID_RE = /^[A-Za-z0-9-]{1,255}$/;

/**
 * DockerImage::submit(): imageName ValidationPatterns::dockerImageNameRules(required: true),
 * imageTag dockerImageTagRules(), imageSha256 nullable|string|regex — then
 * "either a tag or a digest, not both". The route parameters and the query
 * string of Coolify's page are the body's project_uuid, environment_uuid,
 * server_uuid and destination_uuid; `type` must be "dockerimage".
 */
export function validateCreateDockerImage(body: Body): Result<CreateDockerImageInput> {
  const errors: FieldErrors = {};
  if (body.type !== "dockerimage") add(errors, "type", LARAVEL.in("type"));
  for (const field of ["project_uuid", "environment_uuid"] as const) {
    if (blank(body[field])) add(errors, field, `The ${field.replace("_", " ")} field is required.`);
    else if (typeof body[field] !== "string" || !UUID_RE.test(body[field])) add(errors, field, `The selected ${field.replace("_", " ")} is invalid.`);
  }

  if (blank(body.imageName)) add(errors, "imageName", LARAVEL.required("imageName"));
  else if (typeof body.imageName !== "string") add(errors, "imageName", LARAVEL.string("imageName"));
  else {
    if (length(body.imageName) > 255) add(errors, "imageName", LARAVEL.maxString("imageName", 255));
    if (!DOCKER_IMAGE_NAME_PATTERN.test(body.imageName)) add(errors, "imageName", LARAVEL.regex("imageName"));
  }
  const imageTag = nullableString(errors, "imageTag", body.imageTag, "image tag", { max: 128, regex: DOCKER_IMAGE_TAG_PATTERN }) ?? "";
  const imageSha256 = nullableString(errors, "imageSha256", body.imageSha256, "image sha256", { regex: SHA256_PATTERN }) ?? "";
  if (Object.keys(errors).length) return { ok: false, errors };

  // "Validate that either tag or sha256 is provided, but not both".
  if (imageTag && imageSha256) {
    return { ok: false, errors: { imageTag: [APPLICATION_MESSAGES.tagOrDigest], imageSha256: [APPLICATION_MESSAGES.tagOrDigest] } };
  }
  const uuid = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  return {
    ok: true,
    input: {
      projectUuid: body.project_uuid as string,
      environmentUuid: body.environment_uuid as string,
      serverUuid: uuid(body.server_uuid),
      destinationUuid: uuid(body.destination_uuid),
      imageName: body.imageName as string,
      imageTag,
      imageSha256,
    },
  };
}

/**
 * General's fields that apply to a Docker image application. A field the body
 * leaves out is undefined: it keeps its stored value (Livewire always sends
 * every property; this API is a PATCH).
 */
export interface GeneralInput {
  name?: string;
  description?: string | null;
  fqdn?: string | null;
  dockerRegistryImageName?: string | null;
  dockerRegistryImageTag?: string | null;
  portsExposes?: string | null;
  portsMappings?: string | null;
  customNetworkAliases?: string | null;
  customDockerRunOptions?: string | null;
  preDeploymentCommand?: string | null;
  preDeploymentCommandContainer?: string | null;
  postDeploymentCommand?: string | null;
  postDeploymentCommandContainer?: string | null;
  /** confirmDomainUsage(): save although another resource uses one of the domains. */
  forceSaveDomains: boolean;
}

/** str($value)->replace(' ', '')->trim(): what submit() does to both port fields before it validates. */
const withoutSpaces = (value: unknown): unknown => (typeof value === "string" ? value.replace(/ /g, "").trim() : value);

/**
 * General::submit() → validate() with rules() and messages(), for the fields
 * of a Docker image application, then the build pack's own
 * 'dockerRegistryImageName' => dockerImageNameRules(required: true).
 * `stored` is what the application has now: an unchanged fqdn is only
 * 'nullable' (General::rules()).
 */
export function validateGeneral(body: Body, stored: { fqdn: string | null }): Result<GeneralInput> {
  const errors: FieldErrors = {};
  const input: GeneralInput = { forceSaveDomains: body.forceSaveDomains === true };
  const has = (field: string): boolean => body[field] !== undefined;
  const A = GENERAL_ATTRIBUTES;

  if (has("name")) {
    nameRules(errors, body.name, APPLICATION_MESSAGES.nameRequired);
    if (typeof body.name === "string") input.name = body.name;
  }
  if (has("description")) {
    descriptionRules(errors, body.description);
    input.description = typeof body.description === "string" ? body.description : null;
  }
  if (has("fqdn")) {
    const fqdn = body.fqdn;
    if (fqdn === stored.fqdn || blank(fqdn)) {
      input.fqdn = typeof fqdn === "string" ? fqdn : null;
    } else if (typeof fqdn !== "string") {
      add(errors, "fqdn", DEFAULT.string(A.fqdn));
    } else {
      if (length(fqdn) > 2048) add(errors, "fqdn", DEFAULT.max(A.fqdn, 2048));
      for (const message of validateApplicationDomains(fqdn)) add(errors, "fqdn", message);
      input.fqdn = fqdn;
    }
  }
  if (has("dockerRegistryImageName")) {
    // The second validate() of a dockerimage application: the name is required.
    if (blank(body.dockerRegistryImageName)) add(errors, "dockerRegistryImageName", DEFAULT.required(A.dockerRegistryImageName));
    else input.dockerRegistryImageName = nullableString(errors, "dockerRegistryImageName", body.dockerRegistryImageName, A.dockerRegistryImageName, { max: 255, regex: DOCKER_IMAGE_NAME_PATTERN });
  }
  if (has("dockerRegistryImageTag")) {
    input.dockerRegistryImageTag = nullableString(errors, "dockerRegistryImageTag", body.dockerRegistryImageTag, A.dockerRegistryImageTag, { max: 128, regex: DOCKER_IMAGE_TAG_PATTERN });
  }
  if (has("portsExposes")) {
    // "… ?: null": an empty list is stored as null.
    const ports = nullableString(errors, "portsExposes", withoutSpaces(body.portsExposes), A.portsExposes, { regex: PORTS_EXPOSES_PATTERN, regexMessage: APPLICATION_MESSAGES.portsExposesRegex });
    input.portsExposes = ports === "" ? null : ports;
  }
  if (has("portsMappings")) {
    input.portsMappings = nullableString(errors, "portsMappings", withoutSpaces(body.portsMappings), A.portsMappings, { regex: PORT_MAPPINGS_PATTERN, regexMessage: APPLICATION_MESSAGES.portsMappingsRegex });
  }
  // 'customNetworkAliases', 'preDeploymentCommand' and 'postDeploymentCommand' are only 'nullable'; the properties are ?string.
  for (const field of ["customNetworkAliases", "preDeploymentCommand", "postDeploymentCommand"] as const) {
    if (has(field)) input[field] = nullableString(errors, field, body[field], A[field]);
  }
  if (has("customDockerRunOptions")) {
    input.customDockerRunOptions = nullableString(errors, "customDockerRunOptions", body.customDockerRunOptions, A.customDockerRunOptions, {
      max: 2000,
      regex: SHELL_SAFE_COMMAND_PATTERN,
      regexMessage: APPLICATION_MESSAGES.customDockerRunOptionsRegex,
    });
  }
  if (has("preDeploymentCommandContainer")) {
    input.preDeploymentCommandContainer = nullableString(errors, "preDeploymentCommandContainer", body.preDeploymentCommandContainer, A.preDeploymentCommandContainer, {
      max: 255,
      regex: CONTAINER_NAME_PATTERN,
      regexMessage: APPLICATION_MESSAGES.preDeploymentCommandContainerRegex,
    });
  }
  if (has("postDeploymentCommandContainer")) {
    input.postDeploymentCommandContainer = nullableString(errors, "postDeploymentCommandContainer", body.postDeploymentCommandContainer, A.postDeploymentCommandContainer, {
      max: 255,
      regex: CONTAINER_NAME_PATTERN,
      regexMessage: APPLICATION_MESSAGES.postDeploymentCommandContainerRegex,
    });
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, input };
}
