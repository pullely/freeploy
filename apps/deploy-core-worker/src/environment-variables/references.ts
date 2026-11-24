// Derived from coollabsio/coolify@91b7e3e:app/Models/EnvironmentVariable.php (isSharedReference,
// sharedVariableReferences, get_real_environment_variables_internal, resolveReferencedValue) and
// bootstrap/helpers/constants.php (SHARED_VARIABLE_TYPES, SHARED_VARIABLE_REFERENCE_PATTERN)
// (Apache-2.0), modified.
//
// References to shared variables in an environment variable's value —
// {{team.KEY}}, {{project.KEY}}, {{environment.KEY}}, {{server.KEY}} — and the
// value a container gets once they are filled in (Coolify's real_value). Pure
// functions: the caller looks the shared variables up and hands them in.
import { blankString, phpTrim, withoutEdgeLineBreaks } from "./env-format.js";

/** SHARED_VARIABLE_TYPES. In Freeploy the team is the organization. */
export const SHARED_VARIABLE_TYPES = ["team", "project", "environment", "server"] as const;
export type SharedVariableType = (typeof SHARED_VARIABLE_TYPES)[number];

const isSharedVariableType = (type: string): type is SharedVariableType => (SHARED_VARIABLE_TYPES as readonly string[]).includes(type);

/** PCRE's \s without the u modifier. */
const S = " \\t\\n\\v\\f\\r";
/** SHARED_VARIABLE_REFERENCE_PATTERN: '/{{\s*(\w+)\.([^}\s]+)\s*}}/' */
const REFERENCE_SOURCE = `\\{\\{[${S}]*([A-Za-z0-9_]+)\\.([^}${S}]+)[${S}]*\\}\\}`;
/** isSharedReference(): '/^{{\s*(?:team|project|environment|server)\..*}}$/s' */
const WHOLE_REFERENCE = new RegExp(`^\\{\\{[${S}]*(?:${SHARED_VARIABLE_TYPES.join("|")})\\..*\\}\\}$`, "s");

export interface SharedVariableReference {
  /** The reference as written, braces included. */
  reference: string;
  /** The scope as written: any word, not only a shared variable type. */
  type: string;
  key: string;
}

/** EnvironmentVariable::sharedVariableReferences(): every reference in the value, in order (preg_match_all). */
export function sharedVariableReferences(value: string | null): SharedVariableReference[] {
  return [...(value ?? "").matchAll(new RegExp(REFERENCE_SOURCE, "g"))].map((m) => ({ reference: m[0], type: m[1]!, key: m[2]! }));
}

/** EnvironmentVariable::isSharedReference(): the whole value is one reference (what the is_shared column holds). */
export function isSharedReference(value: string | null): boolean {
  if (blankString(value)) return false;
  return WHOLE_REFERENCE.test(phpTrim(value!));
}

/** A shared variable as the resolution needs it: its decrypted value and whether it is locked. */
export interface ResolvedSharedVariable {
  value: string;
  isShownOnce: boolean;
}

export interface ResolveOptions {
  /**
   * The shared variable a reference names within the resource's scopes, or
   * null: there is none, or the resource has no such scope (an application
   * without a server has no `server` variables).
   */
  find(type: SharedVariableType, key: string): ResolvedSharedVariable | null;
  /** false keeps the reference text of a locked shared variable (display and copy); true fills it in (deployments). */
  revealLockedSharedVariables?: boolean;
  /** Fill in only the shared variables that pass this filter (the ones whose value the user can read). */
  canReveal?: (shared: ResolvedSharedVariable, type: SharedVariableType, key: string) => boolean;
}

/**
 * get_real_environment_variables_internal(): the value with its shared
 * variable references filled in. Every occurrence of a reference text is
 * replaced (str_replace), one reference after the other, so a filled-in value
 * that itself spells a later reference is filled in too. An unknown scope, a
 * missing variable, or one that may not be revealed keeps its reference text.
 */
export function resolveRealValue(value: string | null, options: ResolveOptions): string | null {
  if (value === null || value === "") return value;
  let resolved = withoutEdgeLineBreaks(value);
  for (const { reference, type, key } of sharedVariableReferences(resolved)) {
    if (!isSharedVariableType(type)) continue;
    const found = options.find(type, key);
    if (!found) continue;
    if (!(options.revealLockedSharedVariables ?? true) && found.isShownOnce) continue;
    if (options.canReveal && !options.canReveal(found, type, key)) continue;
    resolved = resolved.split(reference).join(found.value);
  }
  return resolved;
}

/**
 * The key resolveReferencedValue() looks up for a value that starts with "$"
 * — "$OTHER" or "${OTHER}" name the variable OTHER of the same resource — or
 * null when the value is taken as it is (literal, blank, or no "$" first).
 */
export function referencedVariableKey(value: string | null, isLiteral: boolean): string | null {
  if (isLiteral || blankString(value) || !value!.startsWith("$")) return null;
  // str($value)->after('$')->trim('{}')
  return phpTrim(value!.slice(1), "{}");
}
