// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Security/CloudInitScriptForm.php,
// app/Livewire/Security/CloudInitScript/Show.php (rules, messages) and
// app/Rules/ValidCloudInitYaml.php (Apache-2.0), modified.
//
// Laravel's validator for the cloud-init script forms, rule by rule, with the
// components' messages. All failing rules of a field are reported in rule
// order (no `bail`); the form shows the first.
//
// ValidCloudInitYaml parses the script with symfony/yaml unless it starts with
// "#!": the parse is ../yaml/symfony's port of Symfony's Parser (DP-110), so
// every ParseException message — its line and snippet included — is
// Symfony's, and the console and /api/v1 refuse the same scripts.
import { add, blank, length, type FieldErrors } from "../private-keys/validation.js";
import { LARAVEL } from "../servers/settings-validation.js";
import { symfonyYamlError } from "../yaml/symfony/index.js";

export const CLOUD_INIT_VALIDATION_MESSAGES = {
  /** CloudInitScriptForm::messages() and Show::messages() */
  nameRequired: "Script name is required.",
  nameMax: "Script name cannot exceed 255 characters.",
  scriptRequired: "Cloud-init script content is required.",
} as const;

/** PHP's trim(): space, \t, \n, \r, \0, \x0B. */
const phpTrim = (s: string): string => s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");

/** ValidCloudInitYaml's two messages, ":attribute" left for the caller's attribute name. */
export const VALID_CLOUD_INIT_YAML = {
  cloudConfigYaml: (error: string) => `The :attribute must be valid YAML format. Error: ${error}`,
  scriptOrYaml: (error: string) => `The :attribute must be either a valid bash script (starting with #!) or valid cloud-config YAML. YAML parse error: ${error}`,
} as const;

/**
 * ValidCloudInitYaml::validate(): the failure message with ":attribute" in it, or null. Laravel replaces ":attribute"
 * with the field's display name: "script" on the console's forms and the API's scripts, "cloud init script" for the
 * field of a server create.
 */
export function validCloudInitYaml(value: string): string | null {
  // empty($value)
  if (value === "" || value === "0") return null;
  const script = phpTrim(value);
  // a bash script (starts with a shebang) is not parsed
  if (script.startsWith("#!")) return null;
  if (script.startsWith("#cloud-config")) {
    // preg_replace('/^#cloud-config\s*/m', '', $script, 1): the first line that starts with the header, and the white space after it.
    const error = symfonyYamlError(script.replace(/^#cloud-config[ \t\n\x0B\f\r]*/m, ""));
    return error === null ? null : VALID_CLOUD_INIT_YAML.cloudConfigYaml(error);
  }
  const error = symfonyYamlError(script);
  return error === null ? null : VALID_CLOUD_INIT_YAML.scriptOrYaml(error);
}

/** ValidCloudInitYaml::validate() on the console's forms (":attribute" is "script"), or null. */
export function cloudInitYamlError(value: string): string | null {
  return validCloudInitYaml(value)?.replaceAll(":attribute", "script") ?? null;
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
