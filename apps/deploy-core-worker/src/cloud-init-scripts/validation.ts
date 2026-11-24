// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Security/CloudInitScriptForm.php,
// app/Livewire/Security/CloudInitScript/Show.php (rules, messages) and
// app/Rules/ValidCloudInitYaml.php (Apache-2.0), modified.
//
// Laravel's validator for the cloud-init script forms, rule by rule, with the
// components' messages. All failing rules of a field are reported in rule
// order (no `bail`); the form shows the first.
//
// ValidCloudInitYaml parses the script with symfony/yaml unless it starts with
// "#!". This Worker has no YAML parser, so only one of Symfony's parse errors
// is reproduced: a first content line indented with a tab. Any other script is
// accepted, also YAML that Symfony would refuse.
import { add, blank, length, type FieldErrors } from "../private-keys/validation.js";
import { LARAVEL } from "../servers/settings-validation.js";

export const CLOUD_INIT_VALIDATION_MESSAGES = {
  /** CloudInitScriptForm::messages() and Show::messages() */
  nameRequired: "Script name is required.",
  nameMax: "Script name cannot exceed 255 characters.",
  scriptRequired: "Cloud-init script content is required.",
  /** ValidCloudInitYaml, with :attribute as Laravel fills it. */
  cloudConfigYaml: (error: string) => `The script must be valid YAML format. Error: ${error}`,
  scriptOrYaml: (error: string) => `The script must be either a valid bash script (starting with #!) or valid cloud-config YAML. YAML parse error: ${error}`,
} as const;

/** PHP's trim(): space, \t, \n, \r, \0, \x0B. */
const phpTrim = (s: string): string => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");

/**
 * Symfony's Parser on the first line it reads: comment and blank lines are
 * skipped, and a line that starts with a tab is "A YAML file cannot contain
 * tabs as indentation at line N (near "…")." Null when that line is fine.
 */
function yamlTabError(yaml: string): string | null {
  const lines = yaml.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const afterSpaces = line.replace(/^ +/, "");
    if (afterSpaces === "" || afterSpaces.startsWith("#")) continue;
    return line.startsWith("\t") ? `A YAML file cannot contain tabs as indentation at line ${i + 1} (near "${line}").` : null;
  }
  return null;
}

/** ValidCloudInitYaml::validate(): the failure message, or null. */
export function cloudInitYamlError(value: string): string | null {
  // empty($value)
  if (value === "" || value === "0") return null;
  const script = phpTrim(value);
  if (script.startsWith("#!")) return null;
  if (script.startsWith("#cloud-config")) {
    // preg_replace('/^#cloud-config\s*/m', '', $script, 1)
    const error = yamlTabError(script.replace(/^#cloud-config[ \t\n\x0B\f\r]*/m, ""));
    return error === null ? null : CLOUD_INIT_VALIDATION_MESSAGES.cloudConfigYaml(error);
  }
  const error = yamlTabError(script);
  return error === null ? null : CLOUD_INIT_VALIDATION_MESSAGES.scriptOrYaml(error);
}

export interface ScriptInput {
  name: string;
  script: string;
}

/**
 * The rules of both forms: name required|string|max:255, script
 * required|string|ValidCloudInitYaml.
 */
export function validateScript(body: Record<string, unknown>): { ok: true; input: ScriptInput } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  if (blank(body.name)) add(errors, "name", CLOUD_INIT_VALIDATION_MESSAGES.nameRequired);
  else if (typeof body.name !== "string") add(errors, "name", LARAVEL.string("name"));
  else if (length(body.name) > 255) add(errors, "name", CLOUD_INIT_VALIDATION_MESSAGES.nameMax);
  if (blank(body.script)) add(errors, "script", CLOUD_INIT_VALIDATION_MESSAGES.scriptRequired);
  else if (typeof body.script !== "string") add(errors, "script", LARAVEL.string("script"));
  else {
    const yaml = cloudInitYamlError(body.script);
    if (yaml !== null) add(errors, "script", yaml);
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  return { ok: true, input: { name: body.name as string, script: body.script as string } };
}
