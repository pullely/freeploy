// Derived from coollabsio/coolify@91b7e3e:app/Services/DockerImageParser.php and
// app/Livewire/Project/New/DockerImage.php (updatedImageName, the image reference submit() builds)
// (Apache-2.0), modified.
//
// Coolify's parser for a Docker image reference: an optional registry, the
// image name, and a tag or a sha256 digest.

const SHA256_RE = /^[a-f0-9]{64}$/i;

export interface ParsedDockerImage {
  /** The registry host (with its port), or "". */
  registryUrl: string;
  /** The image name without the registry. */
  imageName: string;
  /** The tag, or the 64 hex characters of a digest; "latest" when the reference has neither. */
  tag: string;
  /** isImageHash(): the tag is a sha256 digest. */
  isImageHash: boolean;
}

/** DockerImageParser::parse(). */
export function parseDockerImage(imageString: string): ParsedDockerImage {
  let mainPart: string;
  let tag = "latest";
  let isImageHash = false;
  // The @sha256: form first (nginx@sha256:abc123…).
  const digest = imageString.match(/^(.+)@sha256:([a-f0-9]{64})$/i);
  if (digest) {
    mainPart = digest[1]!;
    tag = digest[2]!;
    isImageHash = true;
  } else {
    // The tag starts at the first colon after the last slash. A colon before
    // the last slash is a registry port, and a later colon can be part of a
    // ${VAR:-default} tag.
    const lastSlash = imageString.lastIndexOf("/");
    const tagColon = imageString.indexOf(":", lastSlash === -1 ? 0 : lastSlash + 1);
    if (tagColon !== -1) {
      mainPart = imageString.slice(0, tagColon);
      tag = imageString.slice(tagColon + 1);
      isImageHash = SHA256_RE.test(tag);
    } else {
      mainPart = imageString;
    }
  }
  // More than one path part whose first holds a dot or a colon: that part is a registry.
  const pathParts = mainPart.split("/");
  if (pathParts.length > 1 && (pathParts[0]!.includes(".") || pathParts[0]!.includes(":"))) {
    return { registryUrl: pathParts[0]!, imageName: pathParts.slice(1).join("/"), tag, isImageHash };
  }
  return { registryUrl: "", imageName: mainPart, tag, isImageHash };
}

/** getFullImageNameWithoutTag(). */
export function fullImageNameWithoutTag(image: ParsedDockerImage): string {
  return image.registryUrl ? `${image.registryUrl}/${image.imageName}` : image.imageName;
}

export interface DockerImageFields {
  imageName: string;
  imageTag: string;
  imageSha256: string;
}

/**
 * DockerImage::updatedImageName(): a complete reference pasted into the image
 * name is split into its name and its tag or digest — unless a tag or digest
 * is already filled in, or the name holds neither ":" nor "@".
 */
export function splitPastedImageName(fields: DockerImageFields): DockerImageFields {
  const { imageName, imageTag, imageSha256 } = fields;
  if (imageName === "" || imageTag !== "" || imageSha256 !== "") return fields;
  if (!imageName.includes(":") && !imageName.includes("@")) return fields;
  const parsed = parseDockerImage(imageName);
  const base = fullImageNameWithoutTag(parsed);
  if (base === imageName) return fields;
  // A digest takes priority over a tag.
  if (parsed.isImageHash) return { imageName: base, imageTag: "", imageSha256: parsed.tag };
  if (parsed.tag !== "latest" || imageName.includes(":")) return { imageName: base, imageTag: parsed.tag, imageSha256: "" };
  return { ...fields, imageName: base };
}

/**
 * DockerImage::submit(): what the form's three fields are stored as. A digest
 * is kept as the name with "@sha256" appended and the tag "sha256-<hash>";
 * no tag at all is "latest".
 */
export function storedDockerImage(fields: DockerImageFields): { name: string; tag: string } {
  let reference: string;
  if (fields.imageSha256) {
    // Strip a pasted 'sha256:' prefix.
    reference = `${fields.imageName}@sha256:${fields.imageSha256.trim().replace(/^sha256:/i, "")}`;
  } else if (fields.imageTag) {
    reference = `${fields.imageName}:${fields.imageTag}`;
  } else {
    reference = `${fields.imageName}:latest`;
  }
  const parsed = parseDockerImage(reference);
  let name = fullImageNameWithoutTag(parsed);
  if (parsed.isImageHash && !name.endsWith("@sha256")) name += "@sha256";
  return { name, tag: parsed.isImageHash ? `sha256-${parsed.tag}` : parsed.tag };
}
