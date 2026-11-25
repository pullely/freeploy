// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/New/DockerImage.php (updatedImageName)
// and app/Services/DockerImageParser.php (Apache-2.0), modified.
//
// The Docker Image form splits a complete image reference pasted into the
// image name, as Coolify does while you type. The API parses the submitted
// fields again (deploy-core-worker's applications/docker-image.ts).

export interface ImageForm {
  imageName: string;
  imageTag: string;
  imageSha256: string;
}

const SHA256_RE = /^[a-f0-9]{64}$/i;

/**
 * DockerImage::updatedImageName(): the name, and the tag or the digest (a
 * digest wins) — unless a tag or digest is already filled in, or the name
 * holds neither ":" nor "@".
 */
export function splitPastedImageName(form: ImageForm): ImageForm {
  const { imageName, imageTag, imageSha256 } = form;
  if (imageName === "" || imageTag !== "" || imageSha256 !== "") return form;
  if (!imageName.includes(":") && !imageName.includes("@")) return form;
  const digest = imageName.match(/^(.+)@sha256:([a-f0-9]{64})$/i);
  if (digest) return { imageName: digest[1]!, imageTag: "", imageSha256: digest[2]! };
  // The tag starts at the first colon after the last slash (a colon before it is a registry port).
  const tagColon = imageName.indexOf(":", imageName.lastIndexOf("/") + 1);
  if (tagColon === -1) return form;
  const base = imageName.slice(0, tagColon);
  const tag = imageName.slice(tagColon + 1);
  return SHA256_RE.test(tag) ? { imageName: base, imageTag: "", imageSha256: tag } : { imageName: base, imageTag: tag, imageSha256: "" };
}
