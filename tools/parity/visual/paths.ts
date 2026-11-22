// Route path parameters, filled from the captured fixture ids.

/** Fill {param} from captured fixture ids; drop optional {param?}. Null if a required one is missing. */
export function resolvePath(path: string, values: Record<string, string>): { url: string | null; missing: string[] } {
  const missing: string[] = [];
  const url = path
    .replace(/\/\{(\w+)\?\}/g, (_, k: string) => (values[k] ? `/${values[k]}` : ""))
    .replace(/\{(\w+)\}/g, (_, k: string) => {
      if (values[k]) return values[k];
      missing.push(k);
      return `{${k}}`;
    });
  return { url: missing.length ? null : url || "/", missing };
}

/** A route id as a directory name: artefact stores and NTFS refuse `: " < > | * ?`. */
export function safeId(id: string): string {
  return id.replace(/[:"<>|*?\\/\r\n]/g, "__");
}
