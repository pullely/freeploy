// Derived from coollabsio/coolify@91b7e3e:app/Services/ImageScan/ImageRef.php, app/Services/ImageScan/ComposeImageVariable.php,
// app/Rules/DockerImageFormat.php, app/Support/ValidationPatterns.php (isValidDockerImageName, isValidDockerImageTag) and
// app/Actions/ImageScan/ScanImage.php (imageName) (Apache-2.0), modified.
import { DOCKER_IMAGE_NAME_PATTERN } from "../applications/validation.js";
import { blank } from "./php.js";

export class InvalidImageRef extends Error {}

const LITERAL_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** DockerImageFormat (no variable tags): whether Coolify's rule accepts the reference. */
function dockerImageFormatOk(value: string): boolean {
  if (/:sha256?:/i.test(value)) return false;
  let imageName = value;
  let tag: string | null = null;
  const digest = /^(.+)@sha256:([a-f0-9]{64})$/i.exec(value);
  if (digest) imageName = digest[1]!;
  else {
    const lastSlash = value.lastIndexOf("/");
    const tagColon = value.indexOf(":", lastSlash === -1 ? 0 : lastSlash + 1);
    if (tagColon !== -1) {
      imageName = value.slice(0, tagColon);
      tag = value.slice(tagColon + 1);
    }
  }
  const nameOk = blank(imageName) || DOCKER_IMAGE_NAME_PATTERN.test(imageName);
  const tagOk = blank(tag) || LITERAL_TAG.test(tag!);
  return nameOk && tagOk;
}

/**
 * A validated image reference, split by the Docker reference grammar: the first path component is a registry only when it
 * contains '.' or ':' or is 'localhost'; Docker Hub names get `library/`.
 */
export class ImageRef {
  private constructor(
    readonly registry: string,
    readonly repository: string,
    readonly tag: string | null,
    readonly digest: string | null,
  ) {}

  /** ImageRef::parse(): throws InvalidImageRef. */
  static parse(input: string): ImageRef {
    let ref = input;
    const tagged = /^([^@]+):([^:/@]+)(@[^@]+)$/.exec(ref);
    if (tagged) {
      if (!ImageRef.isValidTag(tagged[2]!)) throw new InvalidImageRef("Invalid image tag.");
      ref = tagged[1]! + tagged[3]!;
    }
    if (ref === "" || !dockerImageFormatOk(ref)) throw new InvalidImageRef("Invalid image reference.");

    let name = ref;
    let tag: string | null = null;
    let digest: string | null = null;
    if (ref.includes("@")) {
      const at = ref.indexOf("@");
      name = ref.slice(0, at);
      digest = ref.slice(at + 1);
      if (!ImageRef.isValidDigest(digest)) throw new InvalidImageRef("Invalid image digest.");
    } else {
      const lastColon = ref.lastIndexOf(":");
      const lastSlash = ref.lastIndexOf("/");
      if (lastColon !== -1 && (lastSlash === -1 || lastColon > lastSlash)) {
        name = ref.slice(0, lastColon);
        tag = ref.slice(lastColon + 1);
        if (!ImageRef.isValidTag(tag)) throw new InvalidImageRef("Invalid image tag.");
      }
    }

    let registry = "docker.io";
    let repository = name;
    const slash = name.indexOf("/");
    if (slash !== -1) {
      const first = name.slice(0, slash);
      if (first.includes(".") || first.includes(":") || first === "localhost") {
        registry = first;
        repository = name.slice(slash + 1);
      }
    }
    if (registry === "index.docker.io") registry = "docker.io";
    if (registry === "docker.io" && !repository.includes("/")) repository = `library/${repository}`;
    return new ImageRef(registry, repository, tag, digest);
  }

  /** parse() or null. */
  static tryParse(ref: string): ImageRef | null {
    try {
      return ImageRef.parse(ref);
    } catch (e) {
      if (e instanceof InvalidImageRef) return null;
      throw e;
    }
  }

  static isValidTag(tag: string): boolean {
    return /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/.test(tag);
  }

  static isValidDigest(digest: string): boolean {
    return /^sha256:[a-f0-9]{64}$/.test(digest);
  }

  isDockerOfficial(): boolean {
    return this.registry === "docker.io" && /^library\/[^/]+$/.test(this.repository);
  }

  withTag(tag: string): ImageRef {
    if (!ImageRef.isValidTag(tag)) throw new InvalidImageRef("Invalid image tag.");
    return new ImageRef(this.registry, this.repository, tag, null);
  }

  /** Registry and repository without tag or digest, for example `docker.io/library/nginx`. */
  qualifiedName(): string {
    return `${this.registry}/${this.repository}`;
  }

  /** The short form Docker shows (`nginx:1.27`, `grafana/grafana`, `ghcr.io/a/b@sha256:…`). */
  toString(): string {
    const name = this.isDockerOfficial() ? this.repository.slice("library/".length) : this.registry === "docker.io" ? this.repository : this.qualifiedName();
    if (this.digest !== null) return `${name}@${this.digest}`;
    if (this.tag !== null) return `${name}:${this.tag}`;
    return name;
  }
}

/** The tag of a reference, or null (also for one that does not parse). */
export const tagOf = (ref: string): string | null => ImageRef.tryParse(ref)?.tag ?? null;

/** ScanImage::imageName(): the lower-case name without tag or digest. */
export function imageName(imageRef: string): string {
  const name = imageRef.split("@")[0]!.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "").toLowerCase();
  return name.replace(/:[^/]*$/, "");
}

// ── ComposeImageVariable ────────────────────────────────────────────────────

const VARIABLE = "\\$\\{(?<key>[A-Za-z_][A-Za-z0-9_]*)(?:(?<op>:?[-?])(?<default>[^}]*))?\\}|\\$(?<bare>[A-Za-z_][A-Za-z0-9_]*)";
const WHOLE = new RegExp(`^(?:${VARIABLE})$`);
const TAG_ONLY = new RegExp(`^(?<prefix>[^$:@\\s]+(?::[0-9]+)?(?:\\/[^$:@\\s]+)*):(?:${VARIABLE})$`);

/**
 * An image of a compose file that a variable sets, in one of the two forms a security update can change through the
 * environment variable: the whole image (`${N8N_IMAGE}`, `${N8N_IMAGE:-n8nio/n8n:1.0}`) or the tag only
 * (`n8nio/n8n:${N8N_VERSION:-1.0}`).
 */
export class ComposeImageVariable {
  private constructor(
    readonly key: string,
    readonly tagOnly: boolean,
    readonly prefix: string,
    readonly defaultValue: string | null,
  ) {}

  /** Null for an image without a variable, or with one in a form Coolify cannot change. */
  static parse(input: string): ComposeImageVariable | null {
    const image = input.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");
    const whole = WHOLE.exec(image);
    if (whole) return ComposeImageVariable.from(whole.groups ?? {}, false, "");
    const tagOnly = TAG_ONLY.exec(image);
    if (tagOnly) return ComposeImageVariable.from(tagOnly.groups ?? {}, true, tagOnly.groups?.prefix ?? "");
    return null;
  }

  static hasVariable(image: string): boolean {
    return image.includes("$");
  }

  /** The image Compose starts when the variable has this value (null: not set, so the default applies). */
  resolve(value: string | null): string | null {
    const v = value !== null && value !== "" ? value : this.defaultValue;
    if (v === null || v === "") return null;
    return this.tagOnly ? `${this.prefix}:${v}` : v;
  }

  private static from(groups: Record<string, string | undefined>, tagOnly: boolean, prefix: string): ComposeImageVariable {
    const key = (groups.bare ?? "") !== "" ? groups.bare! : (groups.key ?? "");
    const op = groups.op ?? "";
    const defaultValue = op !== "" && op.endsWith("-") ? (groups.default ?? "") : null;
    return new ComposeImageVariable(key, tagOnly, prefix, defaultValue);
  }
}
