// Application environment variables (DP-51): the developer view's text format
// and the shared variable references against what Coolify's own PHP answers
// (fixtures/environment-variables/expected.json), Coolify's rules and
// messages, the list and its order, a variable's value (a locked one is never
// returned), add with its preview copy, update, lock, delete, the switches,
// the developer view and its bulk save, and the handler's routing and
// authorization. The SQL behind the store (and its row-level security) is
// tested in tests/db.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleApplications } from "@deploy-core-worker/handlers/applications";
import { handleEnvironmentVariables, type EnvironmentVariableRunner } from "@deploy-core-worker/handlers/environment-variables";
import {
  formatEnvValueForDevView,
  formatEnvVariableForDevView,
  isMagicEnvironmentVariable,
  isProtectedEnvironmentVariable,
  parseEnvDevView,
  parseEnvFormatToArray,
  withoutEdgeLineBreaks,
  EnvFormatError,
} from "@deploy-core-worker/environment-variables/env-format";
import { isSharedReference, referencedVariableKey, resolveRealValue, sharedVariableReferences, type ResolvedSharedVariable } from "@deploy-core-worker/environment-variables/references";
import {
  ENVIRONMENT_VARIABLE_MESSAGES,
  normalizeEnvironmentVariableKey,
  normalizeEnvironmentVariables,
  validateAdd,
  validateSettings,
  validateUpdate,
  validatedEnvironmentVariableKey,
} from "@deploy-core-worker/environment-variables/validation";
import { ENVIRONMENT_VARIABLE_VERSION, showsPreview, sortsAsManaged, type EnvironmentVariableStore } from "@deploy-core-worker/environment-variables/service";
import type {
  DeployEnvironmentVariableResourceRow,
  DeployEnvironmentVariableRow,
  DeploySharedVariableReferenceRow,
  EnvironmentVariableChanges,
  EnvironmentVariableSettingChanges,
  NewEnvironmentVariable,
  SharedVariableRefScope,
} from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const PUBLIC_ID = /^[a-z0-9]{24}$/;
const KEY_REGEX = "The key must start with a letter or underscore and may only contain letters, numbers, underscores, and dots.";

interface Expected {
  parseEnvFormatToArray: Array<{ name: string; input: string; expected: Array<{ key: string; value: string; comment: string | null }> }>;
  parseEnvDevView: Array<{ name: string; input: string | null; expected?: Array<{ key: string; value: string; comment: string | null; settings: Record<string, boolean> | [] }>; error?: string }>;
  formatEnvValueForDevView: Array<{ input: string | null; expected: string | null; readBack?: string }>;
  formatEnvVariableForDevView: Array<{
    variable: { key: string; value: string | null; is_shown_once: boolean; is_multiline: boolean; is_literal: boolean; is_buildtime: boolean; is_runtime: boolean };
    canView: string;
    cannotView: string;
  }>;
  withoutEdgeLineBreaks: Array<{ input: string; expected: string }>;
  sharedVariableReferences: Array<{ input: string; expected: Array<{ reference: string; type: string; key: string }> }>;
  isSharedReference: Array<{ input: string; expected: boolean }>;
}
/** What Coolify's PHP functions answer (fixtures/environment-variables/README.md). */
const php = JSON.parse(readFileSync(join(process.cwd(), "fixtures", "environment-variables", "expected.json"), "utf8")) as Expected;

const entries = <T>(parsed: Map<string, T>) => [...parsed].map(([key, data]) => ({ key, ...data }));

describe("the developer view's text format, against Coolify's PHP", () => {
  it.each(php.parseEnvFormatToArray.map((c) => [c.name, c] as const))("parseEnvFormatToArray: %s", (_name, c) => {
    expect(entries(parseEnvFormatToArray(c.input))).toEqual(c.expected);
  });

  it.each(php.parseEnvDevView.map((c) => [c.name, c] as const))("parseEnvDevView: %s", (_name, c) => {
    if (c.error !== undefined) {
      expect(() => parseEnvDevView(c.input)).toThrow(EnvFormatError);
      expect(() => parseEnvDevView(c.input)).toThrow(new EnvFormatError(c.error));
    } else {
      // PHP encodes an empty settings array as a list.
      const expected = c.expected!.map((e) => ({ ...e, settings: Array.isArray(e.settings) ? {} : e.settings }));
      expect(entries(parseEnvDevView(c.input))).toEqual(expected);
    }
  });

  it("covers the edge cases the format has: quotes, comments, duplicates, empty values, carriage returns, and what it does not read", () => {
    const names = php.parseEnvFormatToArray.map((c) => c.name);
    for (const name of ["export prefix is part of the key", "backslashes are literal", "multiline quoted value is cut at the line end", "duplicate key: the last value, the first position", "empty value", "carriage returns"]) {
      expect(names).toContain(name);
    }
    expect(php.parseEnvDevView.filter((c) => c.error !== undefined).length).toBeGreaterThanOrEqual(10);
    // Not a dotenv parser: `export` stays in the key, an escape stays two characters, a quoted value ends with its line.
    expect(entries(parseEnvFormatToArray("export FOO=bar"))).toEqual([{ key: "export FOO", value: "bar", comment: null }]);
    expect(parseEnvFormatToArray('A="a\\"b"').get("A")).toEqual({ value: "a\\", comment: null });
    expect(parseEnvFormatToArray("A=x\\ny").get("A")!.value).toBe("x\\ny");
  });

  it("formatEnvValueForDevView: quotes only when needed, and what it writes reads back unchanged", () => {
    for (const c of php.formatEnvValueForDevView) {
      const formatted = formatEnvValueForDevView(c.input);
      expect([c.input, formatted]).toEqual([c.input, c.expected]);
      if (formatted !== null) {
        const readBack = parseEnvFormatToArray(`K=${formatted}`).get("K")!.value;
        expect([c.input, readBack]).toEqual([c.input, c.readBack]);
        expect(readBack).toBe(c.input ?? "");
      }
    }
  });

  it("formatEnvVariableForDevView: the line, its '# coolify:' directive, and the placeholders of what the view cannot edit", () => {
    for (const c of php.formatEnvVariableForDevView) {
      const v = c.variable;
      const variable = { key: v.key, value: v.value, isShownOnce: v.is_shown_once, isMultiline: v.is_multiline, flags: { literal: v.is_literal, buildtime: v.is_buildtime, runtime: v.is_runtime } };
      expect([v.key, formatEnvVariableForDevView(variable, true)]).toEqual([v.key, c.canView]);
      expect([v.key, formatEnvVariableForDevView(variable, false)]).toEqual([v.key, c.cannotView]);
    }
    expect(php.formatEnvVariableForDevView.map((c) => c.cannotView)).toContain("PLAIN=(Hidden, only admins can view)");
    expect(php.formatEnvVariableForDevView.map((c) => c.canView)).toEqual(
      expect.arrayContaining([
        "LOCKED=(Locked Secret, delete and add again to change)",
        "MULTI=(Multiline environment variable, edit in normal view)",
        "BREAK=(Value cannot be shown in this view, edit in normal view)",
        "# coolify: literal buildtime=false runtime=false\nALL='a #b'",
      ]),
    );
  });

  it("withoutEdgeLineBreaks: a single-line value loses its edge line breaks, multiline content is kept", () => {
    for (const c of php.withoutEdgeLineBreaks) expect([c.input, withoutEdgeLineBreaks(c.input)]).toEqual([c.input, c.expected]);
  });

  it("the generated Compose variables (with the underscore) and the magic ones (without)", () => {
    expect(["SERVICE_FQDN_APP", "SERVICE_URL_APP", "SERVICE_NAME_APP", "SERVICE_FQDN", "SERVICE_PASSWORD_X", "service_fqdn_app"].map(isProtectedEnvironmentVariable)).toEqual([true, true, true, false, false, false]);
    expect(["SERVICE_FQDN_APP", "SERVICE_FQDN", "SERVICE_URLS", "SERVICE_NAMED", "SERVICE_PASSWORD_X", "MY_SERVICE_URL"].map(isMagicEnvironmentVariable)).toEqual([true, true, true, true, false, false]);
    // The list's SQL uses LIKE, where "_" is any one character.
    expect(["SERVICE_FQDN_APP", "SERVICE.URL", "SERVICEXNAME", "SERVICEFQDN", "A_SERVICE_URL"].map(sortsAsManaged)).toEqual([true, true, true, false, false]);
  });
});

describe("shared variable references", () => {
  it("finds every reference as Coolify's pattern does", () => {
    for (const c of php.sharedVariableReferences) expect([c.input, sharedVariableReferences(c.input)]).toEqual([c.input, c.expected]);
    expect(sharedVariableReferences(null)).toEqual([]);
  });

  it("is_shared: the whole value is one reference to a team, project, environment or server variable", () => {
    for (const c of php.isSharedReference) expect([c.input, isSharedReference(c.input)]).toEqual([c.input, c.expected]);
    expect(isSharedReference(null)).toBe(false);
  });

  const shared: Record<string, ResolvedSharedVariable> = {
    "team.TOKEN": { value: "t0k3n", isShownOnce: false },
    "team.LOCKED": { value: "hidden", isShownOnce: true },
    "project.DB": { value: "postgres://db", isShownOnce: false },
    "environment.NESTED": { value: "{{server.HOST}}:5432", isShownOnce: false },
    "server.HOST": { value: "10.0.0.5", isShownOnce: false },
    "team.EMPTY": { value: "", isShownOnce: false },
  };
  const find = (type: string, key: string) => shared[`${type}.${key}`] ?? null;

  it("real_value: fills in each reference from its scope, every occurrence, and leaves what it cannot resolve", () => {
    expect(resolveRealValue("{{team.TOKEN}}", { find })).toBe("t0k3n");
    expect(resolveRealValue("Bearer {{ team.TOKEN }} / {{project.DB}}?x={{team.TOKEN}}", { find })).toBe("Bearer t0k3n / postgres://db?x={{team.TOKEN}}".replace("{{team.TOKEN}}", "t0k3n"));
    expect(resolveRealValue("{{team.TOKEN}}{{team.TOKEN}}", { find })).toBe("t0k3nt0k3n");
    expect(resolveRealValue("{{team.MISSING}} {{unknown.TOKEN}} {{vault.TOKEN}} {{TEAM.TOKEN}}", { find })).toBe("{{team.MISSING}} {{unknown.TOKEN}} {{vault.TOKEN}} {{TEAM.TOKEN}}");
    expect(resolveRealValue("{{team.EMPTY}}", { find })).toBe("");
    expect(resolveRealValue("plain $VALUE", { find })).toBe("plain $VALUE");
    // A filled-in value that spells a later reference is filled in too (one str_replace after the other).
    expect(resolveRealValue("{{environment.NESTED}} via {{server.HOST}}", { find })).toBe("10.0.0.5:5432 via 10.0.0.5");
    // …but not one that only the filled-in value has.
    expect(resolveRealValue("{{environment.NESTED}}", { find })).toBe("{{server.HOST}}:5432");
  });

  it("real_value: null and '' stay, a single-line value loses its edge line breaks first", () => {
    expect(resolveRealValue(null, { find })).toBeNull();
    expect(resolveRealValue("", { find })).toBe("");
    expect(resolveRealValue("\n{{team.TOKEN}}\r\n", { find })).toBe("t0k3n");
    expect(resolveRealValue("a\n{{team.TOKEN}}\n", { find })).toBe("a\nt0k3n\n");
  });

  it("real_value: a locked shared variable is revealed to a deployment, not to display or copy; canReveal filters", () => {
    expect(resolveRealValue("{{team.LOCKED}}-{{team.TOKEN}}", { find })).toBe("hidden-t0k3n");
    expect(resolveRealValue("{{team.LOCKED}}-{{team.TOKEN}}", { find, revealLockedSharedVariables: false })).toBe("{{team.LOCKED}}-t0k3n");
    expect(resolveRealValue("{{team.TOKEN}} {{project.DB}}", { find, canReveal: (_shared, type) => type === "project" })).toBe("{{team.TOKEN}} postgres://db");
    expect(resolveRealValue("{{team.TOKEN}}", { find, canReveal: () => false })).toBe("{{team.TOKEN}}");
  });

  it("resolveReferencedValue: '$OTHER' and '${OTHER}' name another variable, unless the value is literal", () => {
    expect(referencedVariableKey("$OTHER", false)).toBe("OTHER");
    expect(referencedVariableKey("${OTHER}", false)).toBe("OTHER");
    expect(referencedVariableKey("${OTHER:-x}", false)).toBe("OTHER:-x");
    expect(referencedVariableKey("$OTHER", true)).toBeNull();
    expect(referencedVariableKey("a$OTHER", false)).toBeNull();
    expect(referencedVariableKey("", false)).toBeNull();
    expect(referencedVariableKey(null, false)).toBeNull();
  });
});

describe("Coolify's rules and messages", () => {
  it("normalizes a key (Str::trim) and validates it against ENVIRONMENT_VARIABLE_KEY_PATTERN", () => {
    expect(normalizeEnvironmentVariableKey("  NODE_ENV\t\n")).toBe("NODE_ENV");
    expect(normalizeEnvironmentVariableKey(" ﻿KEY​")).toBe("KEY");
    expect(normalizeEnvironmentVariableKey("A B")).toBe("A B");
    for (const key of ["A", "_a", "a.b.c", "A1_b", " PADDED "]) expect(validatedEnvironmentVariableKey(key)).toBe(key.trim());
    for (const key of ["", "1A", "A-B", "A B", "export FOO", "É", "A\nB", ".a", "A$"]) expect(() => validatedEnvironmentVariableKey(key)).toThrow(new EnvFormatError(KEY_REGEX));
    expect(ENVIRONMENT_VARIABLE_MESSAGES.keyRegex).toBe(KEY_REGEX);
  });

  it("the developer view's keys: normalized, validated, and refused when two normalize to the same key", () => {
    expect([...normalizeEnvironmentVariables(new Map([[" A ", 1], ["B", 2]]))]).toEqual([["A", 1], ["B", 2]]);
    expect(() => normalizeEnvironmentVariables(new Map([["A", 1], ["A ", 2]]))).toThrow(new EnvFormatError("Duplicate environment variable key after normalization: A."));
    expect(() => normalizeEnvironmentVariables(new Map([["export A", 1]]))).toThrow(new EnvFormatError(KEY_REGEX));
  });

  it("Add: the key's rules with ValidationPatterns' messages, the other fields with Add's attribute names", () => {
    const errors = (body: Record<string, unknown>) => {
      const v = validateAdd(body);
      return v.ok ? {} : v.errors;
    };
    expect(validateAdd({ key: "  NODE_ENV ", value: "production" })).toEqual({
      ok: true,
      input: { key: "NODE_ENV", value: "production", comment: null, isMultiline: false, isLiteral: false, isRuntime: true, isBuildtime: true, isPreview: false },
    });
    expect(errors({})).toEqual({ key: ["The key field is required."] });
    expect(errors({ key: "   " })).toEqual({ key: ["The key field is required."] });
    expect(errors({ key: 5 })).toEqual({ key: ["The key field must be a string."] });
    expect(errors({ key: "my key" })).toEqual({ key: [KEY_REGEX] });
    expect(errors({ key: `A${"b".repeat(255)}` })).toEqual({ key: ["The key may not be greater than 255 characters."] });
    expect(errors({ key: `1${"b".repeat(255)}` })).toEqual({ key: ["The key may not be greater than 255 characters.", KEY_REGEX] });
    expect(errors({ key: "A", comment: "c".repeat(257) })).toEqual({ comment: ["The comment field must not be greater than 256 characters."] });
    expect(errors({ key: "A", comment: 5 })).toEqual({ comment: ["The comment field must be a string."] });
    expect(errors({ key: "A", is_multiline: "yes", is_literal: null, is_runtime: 2, is_buildtime: "" })).toEqual({
      is_multiline: ["The multiline field must be true or false."],
      is_literal: ["The literal field is required."],
      is_runtime: ["The runtime field must be true or false."],
      is_buildtime: ["The buildtime field is required."],
    });
    expect(errors({ key: "A", value: ["x"] })).toEqual({ value: ["The value field must be a string."] });
    // 'value' => 'nullable': null and '' both pass, and Laravel's boolean takes 1, 0, "1", "0".
    expect(validateAdd({ key: "A", value: null, comment: "", is_multiline: "1", is_literal: 1, is_runtime: "0", is_buildtime: 0, is_preview: true })).toEqual({
      ok: true,
      input: { key: "A", value: null, comment: "", isMultiline: true, isLiteral: true, isRuntime: false, isBuildtime: false, isPreview: true },
    });
    expect(validateAdd({ key: "A", value: 5 })).toMatchObject({ ok: true, input: { value: "5" } });
  });

  it("Show: the same key rules; the flags' attributes are the property names", () => {
    const current = { key: "A", comment: "note", isMultiline: false, isLiteral: true, isShownOnce: false, isRuntime: true, isBuildtime: false, isRequired: true };
    // A field left out keeps what is stored.
    expect(validateUpdate({}, current)).toEqual({ ok: true, input: { ...current, value: undefined, newLockedValue: null } });
    expect(validateUpdate({ key: " B ", value: "", comment: null, is_literal: false, newLockedValue: "  " }, current)).toEqual({
      ok: true,
      input: { ...current, key: "B", value: "", comment: null, isLiteral: false, newLockedValue: null },
    });
    const v = validateUpdate({ key: "", comment: "c".repeat(257), is_multiline: "x", is_literal: "x", is_shown_once: "x", is_runtime: "x", is_buildtime: "x", is_required: null, newLockedValue: 5 }, current);
    expect(v).toEqual({
      ok: false,
      errors: {
        key: ["The key field is required."],
        comment: ["The comment field must not be greater than 256 characters."],
        is_multiline: ["The is multiline field must be true or false."],
        is_literal: ["The is literal field must be true or false."],
        is_shown_once: ["The is shown once field must be true or false."],
        is_runtime: ["The is runtime field must be true or false."],
        is_buildtime: ["The is buildtime field must be true or false."],
        newLockedValue: ["The new locked value field must be a string."],
        is_required: ["The is required field is required."],
      },
    });
  });

  it("the switches take Laravel's booleans only", () => {
    expect(validateSettings({ is_env_sorting_enabled: true, use_build_secrets: "0", other: 1 })).toEqual({ ok: true, input: { is_env_sorting_enabled: true, use_build_secrets: false } });
    expect(validateSettings({ include_coolify_default_variables: "no", redact_all_env_values_in_logs: null })).toEqual({
      ok: false,
      errors: {
        include_coolify_default_variables: ["The include coolify default variables field must be true or false."],
        redact_all_env_values_in_logs: ["The redact all env values in logs field must be true or false."],
      },
    });
  });

  it("previews show for an application with a Git repository and no Dockerfile of its own", () => {
    expect(showsPreview("application", { git_repository: "coollabsio/coolify", dockerfile: null })).toBe(true);
    expect(showsPreview("application", { git_repository: "coollabsio/coolify", dockerfile: "FROM nginx" })).toBe(false);
    expect(showsPreview("application", { git_repository: "  ", dockerfile: null })).toBe(false);
    expect(showsPreview("application", { git_repository: null, dockerfile: "" })).toBe(false);
  });
});

// ---------------------------------------------------------------- the page's API

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

type Row = DeployEnvironmentVariableRow & { resourceable_id: number };

const resourceRow = (over: Partial<DeployEnvironmentVariableResourceRow> = {}): DeployEnvironmentVariableResourceRow => ({
  id: 1, uuid: "app1", name: "web", build_pack: "dockerimage", git_repository: "coollabsio/coolify", dockerfile: null, docker_compose: null,
  environment_id: 10, environment_uuid: "env1", project_id: 20, project_uuid: "prj1", server_id: 30, server_uuid: "srv1",
  is_env_sorting_enabled: false, use_build_secrets: false, include_coolify_default_variables: true, redact_all_env_values_in_logs: true, ...over,
});

/** The stored form of a plaintext, and back: stands for the per-org cipher. */
const enc = (plaintext: string) => `fp1:env:${plaintext}`;
const sharedEnc = (plaintext: string) => `fp1:shared:${plaintext}`;

/** One org's application, its variables and its shared variables, in memory. */
class MemoryStore implements EnvironmentVariableStore {
  resources: DeployEnvironmentVariableResourceRow[] = [resourceRow()];
  rows: Row[] = [];
  shared: Array<{ scope: string; key: string; value: string; is_shown_once: boolean }> = [];
  inserted: Array<Omit<NewEnvironmentVariable, "orgId">> = [];
  updates: Array<[number, EnvironmentVariableChanges]> = [];
  settingUpdates: EnvironmentVariableSettingChanges[] = [];
  private next = 100;

  /** A stored row, as an earlier save left it. */
  seed(key: string, value: string | null, over: Partial<Row> = {}): Row {
    const id = this.next++;
    const row: Row = {
      id, uuid: `var${id}`, key, value: value === null ? null : enc(value), comment: null, order: null, is_preview: false, is_multiline: false, is_literal: false, is_runtime: true,
      is_buildtime: true, is_required: false, is_shown_once: false, is_shared: false, version: "4.7.6", created_at: null, updated_at: null, resourceable_id: 1, ...over,
    };
    this.rows.push(row);
    return row;
  }
  share(scope: string, key: string, value: string, locked = false) {
    this.shared.push({ scope, key, value: sharedEnc(value), is_shown_once: locked });
  }
  /** key=value of one set, in id order; a null value as "null". */
  dump(isPreview = false): string[] {
    return this.rows.filter((r) => r.is_preview === isPreview).map((r) => `${r.key}=${r.value === null ? "null" : r.value.replace("fp1:env:", "")}`);
  }
  byKey(key: string, isPreview = false): Row {
    return this.rows.find((r) => r.key === key && r.is_preview === isPreview)!;
  }
  private scopeName(scope: SharedVariableRefScope) {
    return scope.type === "team" ? "team" : `${scope.type}:${scope.id}`;
  }

  async findResource(uuid: string) {
    return this.resources.find((r) => r.uuid === uuid) ?? null;
  }
  async list(resourceId: string | number, isPreview: boolean, orderBy: "order" | "key") {
    const rows = this.rows.filter((r) => r.resourceable_id === resourceId && r.is_preview === isPreview);
    const byId = (a: Row, b: Row) => Number(a.id) - Number(b.id);
    if (orderBy === "key") return rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : byId(a, b)));
    // NULLS LAST, as Postgres orders ascending.
    return rows.sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || byId(a, b));
  }
  async findByUuid(resourceId: string | number, uuid: string) {
    return this.rows.find((r) => r.resourceable_id === resourceId && r.uuid === uuid) ?? null;
  }
  async findByKey(resourceId: string | number, isPreview: boolean, key: string) {
    return this.rows.filter((r) => r.resourceable_id === resourceId && r.is_preview === isPreview && r.key === key);
  }
  async maxOrder(resourceId: string | number) {
    return Math.max(0, ...this.rows.filter((r) => r.resourceable_id === resourceId && !r.is_preview).map((r) => r.order ?? 0));
  }
  async insert(resourceId: string | number, v: Omit<NewEnvironmentVariable, "orgId">) {
    if ((await this.findByKey(resourceId, v.isPreview, v.key)).length) return null;
    this.inserted.push(v);
    const row: Row = {
      id: this.next++, uuid: v.uuid, key: v.key, value: v.value, comment: v.comment, order: v.order, is_preview: v.isPreview, is_multiline: v.isMultiline, is_literal: v.isLiteral,
      is_runtime: v.isRuntime, is_buildtime: v.isBuildtime, is_required: v.isRequired, is_shown_once: v.isShownOnce, is_shared: v.isShared, version: v.version,
      created_at: null, updated_at: null, resourceable_id: Number(resourceId),
    };
    this.rows.push(row);
    return row;
  }
  async update(id: string | number, changes: EnvironmentVariableChanges) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    this.updates.push([Number(id), changes]);
    Object.assign(row, changes);
    return row;
  }
  async delete(ids: Array<string | number>) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !ids.includes(r.id));
    return before - this.rows.length;
  }
  async updateSettings(resourceId: string | number, changes: EnvironmentVariableSettingChanges) {
    const resource = this.resources.find((r) => r.id === resourceId);
    if (!resource) return false;
    this.settingUpdates.push(changes);
    Object.assign(resource, changes);
    return true;
  }
  async sharedVariable(scope: SharedVariableRefScope, key: string): Promise<DeploySharedVariableReferenceRow | null> {
    const found = this.shared.find((s) => s.scope === this.scopeName(scope) && s.key === key);
    return found ? { key: found.key, value: found.value, is_shown_once: found.is_shown_once } : null;
  }
  async sharedVariableKeys(scope: SharedVariableRefScope) {
    return this.shared.filter((s) => s.scope === this.scopeName(scope)).map((s) => s.key);
  }
}

type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details: { fields?: Record<string, string[]> } } };
interface Item {
  uuid: string;
  key: string;
  scope: string;
  [field: string]: unknown;
}

function setup(opts: { write?: boolean; read?: boolean } = {}) {
  const store = new MemoryStore();
  const asked: string[] = [];
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const allow = body.action === "deploy.resource.write" ? (opts.write ?? true) : (opts.read ?? true);
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  };
  const orgs: string[] = [];
  const decrypted: string[] = [];
  const runner: EnvironmentVariableRunner = async (_env, orgId, type, fn) => {
    orgs.push(orgId);
    return fn({
      resourceType: type,
      store,
      cipher: {
        encrypt: async (plaintext) => enc(plaintext),
        decrypt: async (stored) => {
          if (!stored.startsWith("fp1:env:")) throw new Error("not an environment variable ciphertext");
          decrypted.push(stored);
          return stored.slice("fp1:env:".length);
        },
      },
      sharedCipher: {
        encrypt: async (plaintext) => sharedEnc(plaintext),
        decrypt: async (stored) => {
          if (!stored.startsWith("fp1:shared:")) throw new Error("not a shared variable ciphertext");
          return stored.slice("fp1:shared:".length);
        },
      },
    });
  };
  const call = async (method: string, path = "", body?: unknown, application = "app1") => {
    const segments = path.split("/").filter(Boolean);
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const url = `${BASE}/applications/${application}/environment-variables${path ? `/${path}` : ""}`;
    const res = await handleEnvironmentVariables(env, "req_1", actor, ORG_UUID, { type: "application", uuid: application }, segments, new Request(url, init), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  const list = async () => ((await call("GET")).body.data!.variables as Item[]).map((v) => `${v.scope}:${v.key}`);
  const dev = async () => (await call("GET", "dev")).body.data as { variables: string; variablesPreview: string | null };
  const save = (variables: string | null, variablesPreview: string | null = null) => call("PUT", "dev", { variables, variablesPreview });
  return { store, asked, orgs, decrypted, call, list, dev, save, env };
}

describe("the list (All)", () => {
  it("answers the settings, the production then the preview variables with their flags, and never a value", async () => {
    const t = setup();
    t.store.seed("NODE_ENV", "prod-value", { order: 1, comment: "the mode", is_literal: true, is_buildtime: false });
    t.store.seed("TOKEN", "{{team.TOKEN}}", { order: 2, is_shared: true, is_shown_once: true });
    t.store.seed("NODE_ENV", "preview-value", { is_preview: true });
    t.store.share("team", "TOKEN", "t0k3n");
    t.store.share("project:20", "DB_URL", "postgres://db");
    t.store.share("environment:10", "REGION", "eu");
    t.store.share("server:30", "HOST", "10.0.0.5");
    const r = await t.call("GET");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      resource: { type: "application", uuid: "app1", name: "web", buildPack: "dockerimage" },
      showPreview: true,
      settings: { isEnvSortingEnabled: false, useBuildSecrets: false, includeCoolifyDefaultVariables: true, redactAllEnvValuesInLogs: true },
      variables: [
        {
          uuid: "var100", key: "NODE_ENV", comment: "the mode", scope: "production", order: 1, isMultiline: false, isLiteral: true, isRuntime: true, isBuildtime: false,
          isRequired: false, isShownOnce: false, isShared: false, isMagic: false, isMissingRequired: false,
        },
        {
          uuid: "var101", key: "TOKEN", comment: null, scope: "production", order: 2, isMultiline: false, isLiteral: false, isRuntime: true, isBuildtime: true,
          isRequired: false, isShownOnce: true, isShared: true, isMagic: false, isMissingRequired: false,
        },
        {
          uuid: "var102", key: "NODE_ENV", comment: null, scope: "preview", order: null, isMultiline: false, isLiteral: false, isRuntime: true, isBuildtime: true,
          isRequired: false, isShownOnce: false, isShared: false, isMagic: false, isMissingRequired: false,
        },
      ],
      availableSharedVariables: { team: ["TOKEN"], project: ["DB_URL"], environment: ["REGION"], server: ["HOST"] },
      canManage: true,
      canViewValues: true,
    });
    expect(JSON.stringify(r.body)).not.toMatch(/prod-value|preview-value|t0k3n|fp1:/);
    // The list decrypts nothing: no variable is required.
    expect(t.decrypted).toEqual([]);
    expect(t.orgs).toEqual([ORG_UUID]);
  });

  it("orders as Coolify does: required and empty first, then the managed ones, then by order and id", async () => {
    const t = setup();
    t.store.seed("LAST", "x");
    t.store.seed("B", "x", { order: 2 });
    t.store.seed("A", "x", { order: 2 });
    t.store.seed("SERVICE_URL_APP", "http://a", { order: 9 });
    t.store.seed("FIRST", "x", { order: 1 });
    t.store.seed("NEEDED", "", { order: 5, is_required: true });
    t.store.seed("NEEDED_NULL", null, { order: 6, is_required: true });
    t.store.seed("NEEDED_SET", "v", { order: 7, is_required: true });
    t.store.seed("SERVICE_FQDN_APP", null, { order: 8, is_required: true });
    expect(await t.list()).toEqual([
      "production:SERVICE_FQDN_APP", "production:NEEDED", "production:NEEDED_NULL", "production:SERVICE_URL_APP", "production:FIRST", "production:B", "production:A",
      "production:NEEDED_SET", "production:LAST",
    ]);
    const items = (await t.call("GET")).body.data!.variables as Item[];
    expect(items.filter((i) => i.isMissingRequired).map((i) => i.key)).toEqual(["SERVICE_FQDN_APP", "NEEDED", "NEEDED_NULL"]);
    expect(items.filter((i) => i.isMagic).map((i) => i.key)).toEqual(["SERVICE_FQDN_APP", "SERVICE_URL_APP"]);
  });

  it("a required variable is missing by its resolved value: a reference to an empty shared variable counts", async () => {
    const t = setup();
    t.store.seed("FILLED", "{{team.SET}}", { order: 1, is_required: true, is_shared: true });
    t.store.seed("HOLLOW", "{{team.EMPTY}}", { order: 2, is_required: true, is_shared: true });
    t.store.seed("UNRESOLVED", "{{team.MISSING}}", { order: 3, is_required: true, is_shared: true });
    t.store.share("team", "SET", "v", true);
    t.store.share("team", "EMPTY", "");
    const items = (await t.call("GET")).body.data!.variables as Item[];
    expect(items.map((i) => [i.key, i.isMissingRequired])).toEqual([["HOLLOW", true], ["FILLED", false], ["UNRESOLVED", false]]);
  });

  it("sorts by key when the application's order is Alphabetical", async () => {
    const t = setup();
    t.store.resources[0]!.is_env_sorting_enabled = true;
    t.store.seed("ZED", "x", { order: 1 });
    t.store.seed("ALPHA", "x", { order: 2 });
    t.store.seed("SERVICE_NAME_APP", "x", { order: 3 });
    t.store.seed("MID", "x", { order: 4, is_preview: true });
    expect(await t.list()).toEqual(["production:SERVICE_NAME_APP", "production:ALPHA", "production:ZED", "preview:MID"]);
  });

  it("an application with its own Dockerfile has no preview variables; one whose server is gone has no server suggestions", async () => {
    const t = setup();
    t.store.resources[0] = resourceRow({ dockerfile: "FROM nginx", server_id: null, server_uuid: null });
    t.store.seed("A", "x");
    t.store.seed("A", "x", { is_preview: true });
    t.store.share("server:30", "HOST", "10.0.0.5");
    const r = await t.call("GET");
    expect(r.body.data).toMatchObject({ showPreview: false, availableSharedVariables: { team: [], project: [], environment: [], server: [] } });
    expect(await t.list()).toEqual(["production:A"]);
  });

  it("a reader lists with canManage and canViewValues false; an unknown application is 404", async () => {
    const t = setup({ write: false });
    t.store.seed("A", "secret");
    const r = await t.call("GET");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ canManage: false, canViewValues: false });
    expect((await t.call("GET", "", undefined, "nope")).status).toBe(404);
  });
});

describe("a variable's value (Show::loadValues, copyValue)", () => {
  it("answers the value to who may read values, and what the copy button copies", async () => {
    const t = setup();
    const plain = t.store.seed("PLAIN", "\nhello world\n");
    const r = await t.call("GET", plain.uuid!);
    expect(r.status).toBe(200);
    // The accessor drops a single-line value's edge line breaks.
    expect(r.body.data).toEqual({ value: "hello world", realValue: null, isShared: false, isReallyRequired: false, isValueHidden: false, copyValue: "hello world" });
  });

  it("never returns a locked value, even to who may write", async () => {
    const t = setup();
    const locked = t.store.seed("SECRET", "s3cr3t", { is_shown_once: true, is_required: true });
    const r = await t.call("GET", locked.uuid!);
    expect(r.body.data).toEqual({ value: null, realValue: null, isShared: false, isReallyRequired: false, isValueHidden: false, copyValue: null });
    expect(JSON.stringify(r.body)).not.toContain("s3cr3t");
    expect(JSON.stringify((await t.call("GET")).body)).not.toContain("s3cr3t");
    expect((await t.dev()).variables).toBe("SECRET=(Locked Secret, delete and add again to change)");
  });

  it("hides every value from a reader and decrypts nothing for one", async () => {
    const t = setup({ write: false });
    const row = t.store.seed("PLAIN", "hello", { is_required: true, is_shared: true });
    const r = await t.call("GET", row.uuid!);
    expect(r.body.data).toEqual({ value: null, realValue: null, isShared: true, isReallyRequired: true, isValueHidden: true, copyValue: null });
    t.decrypted.length = 0;
    expect(await t.dev()).toMatchObject({ variables: "PLAIN=(Hidden, only admins can view)" });
    expect(t.decrypted).toEqual([]);
  });

  it("a shared reference: the resolved value from the application's team, project, environment and server", async () => {
    const t = setup();
    t.store.share("team", "TOKEN", "t0k3n");
    t.store.share("project:20", "TOKEN", "project-token");
    t.store.share("project:99", "ELSEWHERE", "other project");
    t.store.share("environment:10", "REGION", "eu");
    t.store.share("server:30", "HOST", "10.0.0.5");
    t.store.share("team", "LOCKED", "hidden", true);
    const value = async (stored: string) => (await t.call("GET", t.store.seed(`K${t.store.rows.length}`, stored).uuid!)).body.data!;
    expect(await value("{{team.TOKEN}}")).toMatchObject({ value: "{{team.TOKEN}}", realValue: "t0k3n", isShared: true, copyValue: "t0k3n" });
    expect(await value("{{ project.TOKEN }}")).toMatchObject({ realValue: "project-token", isShared: true });
    expect(await value("{{environment.REGION}}")).toMatchObject({ realValue: "eu" });
    expect(await value("{{server.HOST}}")).toMatchObject({ realValue: "10.0.0.5" });
    // Another project's variable, and a missing one, keep their reference text.
    expect(await value("{{project.ELSEWHERE}}")).toMatchObject({ realValue: "{{project.ELSEWHERE}}", isShared: true });
    // A locked shared variable is not revealed for display or copy.
    expect(await value("{{team.LOCKED}}")).toMatchObject({ realValue: "{{team.LOCKED}}", copyValue: "{{team.LOCKED}}" });
    // Not one reference: no resolved value shown, but the copy fills it in.
    expect(await value("https://{{server.HOST}}/x")).toMatchObject({ realValue: null, isShared: false, copyValue: "https://10.0.0.5/x" });
  });

  it("is_really_required: required and the (resolved) value is blank", async () => {
    const t = setup();
    t.store.share("team", "EMPTY", "");
    const required = async (stored: string | null) => (await t.call("GET", t.store.seed(`K${t.store.rows.length}`, stored, { is_required: true }).uuid!)).body.data!.isReallyRequired;
    expect(await required(null)).toBe(true);
    expect(await required("")).toBe(true);
    expect(await required("   ")).toBe(true);
    expect(await required("v")).toBe(false);
    expect(await required("{{team.EMPTY}}")).toBe(true);
    expect(await required("{{team.MISSING}}")).toBe(false);
  });

  it("copy: '$OTHER' copies the other variable's value, unless that one is locked or this one is literal", async () => {
    const t = setup();
    t.store.share("team", "TOKEN", "t0k3n");
    t.store.seed("OTHER", "{{team.TOKEN}}!");
    t.store.seed("LOCKED", "s3cr3t", { is_shown_once: true });
    t.store.seed("OTHER", "preview value", { is_preview: true });
    const copy = async (stored: string, over: Partial<Row> = {}) => (await t.call("GET", t.store.seed(`K${t.store.rows.length}`, stored, over).uuid!)).body.data!.copyValue;
    expect(await copy("$OTHER")).toBe("t0k3n!");
    expect(await copy("${OTHER}")).toBe("t0k3n!");
    expect(await copy("$OTHER", { is_preview: true })).toBe("preview value");
    expect(await copy("$OTHER", { is_literal: true })).toBe("$OTHER");
    expect(await copy("$LOCKED")).toBe("$LOCKED");
    expect(await copy("$MISSING")).toBe("$MISSING");
  });

  it("404 for a variable that is not the application's", async () => {
    const t = setup();
    t.store.seed("ELSEWHERE", "x", { resourceable_id: 2 });
    expect((await t.call("GET", "var100")).status).toBe(404);
    expect((await t.call("GET", "missing")).status).toBe(404);
    expect((await t.call("PATCH", "var100", { comment: "x" })).status).toBe(404);
    expect((await t.call("DELETE", "var100")).status).toBe(404);
    expect((await t.call("POST", "var100/lock")).status).toBe(404);
    expect(t.store.rows).toHaveLength(1);
  });
});

describe("adding a variable (Add::submit, All::handleSingleSubmit)", () => {
  it("stores the variable after the last one, with Coolify's version, and gives it a preview copy without an order", async () => {
    const t = setup();
    t.store.seed("FIRST", "x", { order: 4 });
    const r = await t.call("POST", "", { key: "  NODE_ENV ", value: "production\n", comment: "the mode", is_multiline: false, is_literal: true, is_runtime: true, is_buildtime: false });
    expect(r.status).toBe(201);
    expect(r.body.data).toEqual({ uuid: expect.stringMatching(PUBLIC_ID), message: "Environment variable added." });
    expect(t.store.inserted).toEqual([
      {
        uuid: r.body.data!.uuid, key: "NODE_ENV", value: enc("production"), comment: "the mode", order: 5, isPreview: false, isMultiline: false, isLiteral: true, isRuntime: true,
        isBuildtime: false, isRequired: false, isShownOnce: false, isShared: false, version: ENVIRONMENT_VARIABLE_VERSION,
      },
      {
        uuid: expect.stringMatching(PUBLIC_ID), key: "NODE_ENV", value: enc("production"), comment: "the mode", order: null, isPreview: true, isMultiline: false, isLiteral: true,
        isRuntime: true, isBuildtime: false, isRequired: false, isShownOnce: false, isShared: false, version: "4.7.6",
      },
    ]);
    expect(t.store.inserted[1]!.uuid).not.toBe(t.store.inserted[0]!.uuid);
    expect(await t.list()).toEqual(["production:FIRST", "production:NODE_ENV", "preview:NODE_ENV"]);
  });

  it("keeps an existing preview variable of the key, and a preview variable gets no copy", async () => {
    const t = setup();
    t.store.seed("A", "preview's own", { is_preview: true });
    expect((await t.call("POST", "", { key: "A", value: "prod" })).status).toBe(201);
    expect(t.store.dump(true)).toEqual(["A=preview's own"]);
    expect((await t.call("POST", "", { key: "B", value: "only preview", is_preview: true })).status).toBe(201);
    expect(t.store.dump()).toEqual(["A=prod"]);
    expect(t.store.dump(true)).toEqual(["A=preview's own", "B=only preview"]);
    // The order comes from the production variables, for a preview one too.
    expect(t.store.byKey("B", true).order).toBe(2);
  });

  it("stores a null value as null, an empty one encrypted, and marks a shared reference", async () => {
    const t = setup();
    await t.call("POST", "", { key: "NOTHING", value: null });
    await t.call("POST", "", { key: "EMPTY", value: "" });
    await t.call("POST", "", { key: "SHARED", value: " {{ team.TOKEN }} " });
    await t.call("POST", "", { key: "MULTI", value: "line 1\nline 2\n", is_multiline: true });
    expect(t.store.inserted.filter((v) => !v.isPreview).map((v) => [v.key, v.value, v.isShared])).toEqual([
      ["NOTHING", null, false],
      ["EMPTY", enc(""), false],
      ["SHARED", enc(" {{ team.TOKEN }} "), true],
      // Multiline content keeps its trailing newline.
      ["MULTI", enc("line 1\nline 2\n"), false],
    ]);
  });

  it("refuses a key the application already has: 'Environment variable already exists.'", async () => {
    const t = setup();
    t.store.seed("NODE_ENV", "x");
    const r = await t.call("POST", "", { key: " NODE_ENV ", value: "y" });
    expect([r.status, r.body.error]).toEqual([409, expect.objectContaining({ code: "conflict", message: "Environment variable already exists." })]);
    // A key is case sensitive.
    expect((await t.call("POST", "", { key: "node_env", value: "y" })).status).toBe(201);
    expect(t.store.dump()).toEqual(["NODE_ENV=x", "node_env=y"]);
  });

  it("answers the form's field errors, and refuses a NUL in the value, before anything is stored", async () => {
    const t = setup();
    const bad = await t.call("POST", "", { key: "my key", comment: "c".repeat(257), is_literal: "maybe" });
    expect(bad.status).toBe(422);
    expect(bad.body.error!.details.fields).toEqual({
      key: [KEY_REGEX],
      comment: ["The comment field must not be greater than 256 characters."],
      is_literal: ["The literal field must be true or false."],
    });
    const nul = await t.call("POST", "", { key: "A", value: "a\0b" });
    expect([nul.status, nul.body.error!.details.fields]).toEqual([422, { value: ["The value cannot contain a NUL character."] }]);
    expect(t.store.rows).toEqual([]);
    expect(t.orgs).toHaveLength(1);
  });
});

describe("updating a variable (Show::submit)", () => {
  it("saves what changed and answers 'Environment variable updated.' with the row", async () => {
    const t = setup();
    const row = t.store.seed("NODE_ENV", "production", { order: 1 });
    const r = await t.call("PATCH", row.uuid!, { key: " APP_ENV ", value: "staging", comment: "renamed", is_multiline: false, is_literal: true, is_shown_once: false, is_runtime: false, is_buildtime: true, is_required: true });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      message: "Environment variable updated.",
      variable: {
        uuid: row.uuid, key: "APP_ENV", comment: "renamed", scope: "production", order: 1, isMultiline: false, isLiteral: true, isRuntime: false, isBuildtime: true, isRequired: true,
        isShownOnce: false, isShared: false, isMagic: false, isMissingRequired: false,
      },
    });
    // Only the dirty columns are written.
    expect(t.store.updates).toEqual([[100, { key: "APP_ENV", value: enc("staging"), comment: "renamed", is_literal: true, is_runtime: false, is_required: true }]]);
  });

  it("a field left out keeps what is stored, and an unchanged form writes nothing", async () => {
    const t = setup();
    const row = t.store.seed("A", "v", { comment: "note", is_literal: true });
    expect((await t.call("PATCH", row.uuid!, { comment: "new note" })).status).toBe(200);
    expect(t.store.updates).toEqual([[100, { comment: "new note" }]]);
    expect((await t.call("PATCH", row.uuid!, { key: "A", value: "v", comment: "new note", is_literal: true })).status).toBe(200);
    expect(t.store.updates).toHaveLength(1);
    expect(t.store.dump()).toEqual(["A=v"]);
  });

  it("sets is_shared from the value, and clears the value to null or ''", async () => {
    const t = setup();
    const row = t.store.seed("A", "v");
    await t.call("PATCH", row.uuid!, { value: "{{project.DB_URL}}" });
    expect(t.store.updates.at(-1)).toEqual([100, { value: enc("{{project.DB_URL}}"), is_shared: true }]);
    await t.call("PATCH", row.uuid!, { value: "" });
    expect(t.store.updates.at(-1)).toEqual([100, { value: enc(""), is_shared: false }]);
    await t.call("PATCH", row.uuid!, { value: null });
    expect(t.store.updates.at(-1)).toEqual([100, { value: null }]);
  });

  it("refuses a key another variable of the same set has — before the form is validated", async () => {
    const t = setup();
    t.store.seed("TAKEN", "x");
    const row = t.store.seed("MINE", "y");
    t.store.seed("PREVIEW_ONLY", "z", { is_preview: true });
    const r = await t.call("PATCH", row.uuid!, { key: " TAKEN ", comment: "c".repeat(257) });
    expect([r.status, r.body.error]).toEqual([409, expect.objectContaining({ code: "conflict", message: "Environment variable already exists." })]);
    // The preview set is another set.
    expect((await t.call("PATCH", row.uuid!, { key: "PREVIEW_ONLY" })).status).toBe(200);
    expect(t.store.dump()).toEqual(["TAKEN=x", "PREVIEW_ONLY=y"]);
  });

  it("a required variable cannot be emptied: 'Required environment variables cannot be empty.'", async () => {
    const t = setup();
    const row = t.store.seed("NEEDED", "v", { is_required: true });
    for (const body of [{ value: "" }, { value: null }, { value: "", key: "not valid" }]) {
      const r = await t.call("PATCH", row.uuid!, body);
      expect([r.status, r.body.error]).toEqual([422, expect.objectContaining({ code: "validation_failed", message: "Required environment variables cannot be empty." })]);
    }
    // Whitespace is not empty (str()->isEmpty()), and a variable that stops being required can be emptied.
    expect((await t.call("PATCH", row.uuid!, { value: " " })).status).toBe(200);
    expect((await t.call("PATCH", row.uuid!, { value: "", is_required: false })).status).toBe(200);
    // Making an empty variable required is refused too.
    expect((await t.call("PATCH", row.uuid!, { is_required: true })).status).toBe(422);
    expect(t.store.updates).toHaveLength(2);
  });

  it("answers Show's field errors and stores nothing", async () => {
    const t = setup();
    const row = t.store.seed("A", "v");
    const r = await t.call("PATCH", row.uuid!, { key: "1A", is_runtime: "x", value: "a\0b" });
    expect(r.status).toBe(422);
    expect(r.body.error!.details.fields).toEqual({ key: [KEY_REGEX], is_runtime: ["The is runtime field must be true or false."] });
    const nul = await t.call("PATCH", row.uuid!, { value: "a\0b" });
    expect([nul.status, nul.body.error!.details.fields]).toEqual([422, { value: ["The value cannot contain a NUL character."] }]);
    expect(t.store.updates).toEqual([]);
  });

  it("a locked variable: the value sent is ignored, newLockedValue replaces it, and nothing unlocks it", async () => {
    const t = setup();
    const row = t.store.seed("SECRET", "old", { is_shown_once: true });
    expect((await t.call("PATCH", row.uuid!, { value: "ignored", is_shown_once: false, comment: "still locked" })).status).toBe(200);
    expect(t.store.updates).toEqual([[100, { comment: "still locked" }]]);
    expect(row.is_shown_once).toBe(true);
    // An empty or blank new value keeps the stored one.
    await t.call("PATCH", row.uuid!, { newLockedValue: "  " });
    expect(t.store.dump()).toEqual(["SECRET=old"]);
    const r = await t.call("PATCH", row.uuid!, { newLockedValue: "new" });
    expect(r.body.data!.variable).toMatchObject({ isShownOnce: true });
    expect(t.store.dump()).toEqual(["SECRET=new"]);
    expect(JSON.stringify(r.body)).not.toContain("new\"");
    // A required locked variable is judged by its stored value.
    row.is_required = true;
    expect((await t.call("PATCH", row.uuid!, { comment: "x" })).status).toBe(200);
  });

  it("is_shown_once in the form locks a variable that is not locked", async () => {
    const t = setup();
    const row = t.store.seed("A", "v");
    await t.call("PATCH", row.uuid!, { is_shown_once: true, value: "final" });
    expect(t.store.updates).toEqual([[100, { value: enc("final"), is_shown_once: true }]]);
  });
});

describe("lock and delete", () => {
  it("Show::lock: locks for good", async () => {
    const t = setup();
    const row = t.store.seed("A", "v");
    const r = await t.call("POST", `${row.uuid!}/lock`);
    expect([r.status, r.body.data]).toEqual([200, { locked: true }]);
    expect(t.store.updates).toEqual([[100, { is_shown_once: true }]]);
    // Again: nothing to write.
    expect((await t.call("POST", `${row.uuid!}/lock`)).status).toBe(200);
    expect(t.store.updates).toHaveLength(1);
    expect((await t.call("GET", row.uuid!)).body.data).toMatchObject({ value: null, copyValue: null });
  });

  it("Show::delete: 'Environment variable deleted successfully.'; the preview copy stays", async () => {
    const t = setup();
    await t.call("POST", "", { key: "A", value: "v" });
    const row = t.store.byKey("A");
    const r = await t.call("DELETE", row.uuid!);
    expect([r.status, r.body.data]).toEqual([200, { deleted: true, message: "Environment variable deleted successfully." }]);
    expect(await t.list()).toEqual(["preview:A"]);
    expect((await t.call("DELETE", row.uuid!)).status).toBe(404);
  });
});

describe("the switches above the list", () => {
  it("saves the given switches and answers Coolify's toast for each action", async () => {
    const t = setup();
    const sorting = await t.call("PATCH", "settings", { is_env_sorting_enabled: true, use_build_secrets: true });
    expect([sorting.status, sorting.body.data]).toEqual([
      200,
      { message: "Environment variable settings updated.", settings: { isEnvSortingEnabled: true, useBuildSecrets: true, includeCoolifyDefaultVariables: true, redactAllEnvValuesInLogs: true } },
    ]);
    expect((await t.call("PATCH", "settings", { include_coolify_default_variables: false })).body.data!.message).toBe("Environment variable settings updated.");
    const redaction = await t.call("PATCH", "settings", { redact_all_env_values_in_logs: false });
    expect(redaction.body.data).toEqual({
      message: "Log redaction setting updated.",
      settings: { isEnvSortingEnabled: true, useBuildSecrets: true, includeCoolifyDefaultVariables: false, redactAllEnvValuesInLogs: false },
    });
    expect(t.store.settingUpdates).toEqual([{ is_env_sorting_enabled: true, use_build_secrets: true }, { include_coolify_default_variables: false }, { redact_all_env_values_in_logs: false }]);
    expect((await t.call("GET")).body.data!.settings).toEqual({ isEnvSortingEnabled: true, useBuildSecrets: true, includeCoolifyDefaultVariables: false, redactAllEnvValuesInLogs: false });
  });

  it("refuses what is not a boolean, and 404s for an unknown application", async () => {
    const t = setup();
    const r = await t.call("PATCH", "settings", { use_build_secrets: "yes" });
    expect([r.status, r.body.error!.details.fields]).toEqual([422, { use_build_secrets: ["The use build secrets field must be true or false."] }]);
    expect((await t.call("PATCH", "settings", { use_build_secrets: true }, "nope")).status).toBe(404);
    expect(t.store.settingUpdates).toEqual([]);
  });
});

describe("the developer view (All::getDevView)", () => {
  it("writes each set as text: the order of the list's setting, directives for flags, placeholders, no generated Compose variables", async () => {
    const t = setup();
    t.store.seed("B", "two", { order: 2 });
    t.store.seed("A", " padded ", { order: 3, is_literal: true });
    t.store.seed("SERVICE_FQDN_APP", "app.example.com", { order: 1 });
    t.store.seed("SERVICE_PASSWORD_DB", "generated", { order: 4 });
    t.store.seed("CERT", "-----BEGIN-----\nabc\n", { order: 5, is_multiline: true });
    t.store.seed("LOCKED", "s3cr3t", { order: 6, is_shown_once: true });
    t.store.seed("BOTH", ` "a" 'b' `, { order: 7 });
    t.store.seed("NOTHING", null, { order: 8, is_runtime: false });
    t.store.seed("NEEDED", null, { order: 9, is_required: true });
    t.store.seed("NEEDED_EMPTY", "", { order: 10, is_required: true });
    t.store.seed("P", "preview", { is_preview: true, is_buildtime: false });
    const r = await t.call("GET", "dev");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      showPreview: true,
      variables: [
        // Required with no stored value first (a stored empty string is a ciphertext, so NEEDED_EMPTY is not).
        "NEEDED=",
        "B=two",
        "# coolify: literal\nA=' padded '",
        "SERVICE_PASSWORD_DB=generated",
        "CERT=(Multiline environment variable, edit in normal view)",
        "LOCKED=(Locked Secret, delete and add again to change)",
        "BOTH=(Value cannot be shown in this view, edit in normal view)",
        "# coolify: runtime=false\nNOTHING=",
        "NEEDED_EMPTY=",
      ].join("\n"),
      variablesPreview: "# coolify: buildtime=false\nP=preview",
      canManage: true,
    });
    // Only the lines that show a value were decrypted.
    expect(t.decrypted.some((c) => c.includes("s3cr3t") || c.includes("BEGIN"))).toBe(false);
    t.store.resources[0]!.is_env_sorting_enabled = true;
    expect((await t.dev()).variables.split("\n").filter((l) => !l.startsWith("#")).map((l) => l.split("=")[0])).toEqual([
      "NEEDED", "A", "B", "BOTH", "CERT", "LOCKED", "NEEDED_EMPTY", "NOTHING", "SERVICE_PASSWORD_DB",
    ]);
  });

  it("has no preview text for an application without previews, and an empty text without variables", async () => {
    const t = setup();
    expect(await t.dev()).toMatchObject({ variables: "", variablesPreview: "" });
    t.store.resources[0] = resourceRow({ dockerfile: "FROM nginx" });
    t.store.seed("P", "x", { is_preview: true });
    expect(await t.dev()).toMatchObject({ showPreview: false, variables: "", variablesPreview: null });
  });
});

describe("the developer view's save (All::submit, handleBulkSubmit, updateOrder)", () => {
  it("creates, updates and deletes by the text, orders by line, and answers 'Environment variables updated.' with the new text", async () => {
    const t = setup();
    t.store.seed("KEEP", "same", { order: 1 });
    t.store.seed("CHANGE", "old", { order: 2, comment: "kept comment" });
    t.store.seed("GONE", "bye", { order: 3 });
    t.store.seed("PREVIEW_GONE", "bye", { is_preview: true });
    const r = await t.save("NEW=fresh #a new one\nCHANGE=new\n\n# just a note\nKEEP=same", "ONLY_PREVIEW='quoted value'");
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({
      message: "Environment variables updated.",
      showPreview: true,
      variables: "NEW=fresh\nCHANGE=new\nKEEP=same",
      variablesPreview: "ONLY_PREVIEW=quoted value",
    });
    expect(t.store.dump()).toEqual(["KEEP=same", "CHANGE=new", "NEW=fresh"]);
    expect(t.store.rows.filter((v) => !v.is_preview).map((v) => [v.key, v.order, v.comment])).toEqual([["KEEP", 3, null], ["CHANGE", 2, "kept comment"], ["NEW", 1, "a new one"]]);
    // NEW's preview copy came with it (the created hook) and went with the preview text, which does not have it.
    expect(t.store.dump(true)).toEqual(["ONLY_PREVIEW=quoted value"]);
    expect(t.store.byKey("ONLY_PREVIEW", true)).toMatchObject({ order: 1, is_multiline: false, is_literal: false, is_runtime: true, is_buildtime: true, version: "4.7.6" });
    expect(t.store.inserted.map((v) => [v.key, v.isPreview, v.order])).toEqual([["NEW", false, null], ["NEW", true, null], ["ONLY_PREVIEW", true, null]]);
  });

  it("saving the text as it was shown changes nothing and answers no message", async () => {
    const t = setup();
    t.store.seed("A", "one", { order: 1, is_literal: true });
    t.store.seed("B", " padded ", { order: 2 });
    t.store.seed("LOCKED", "s3cr3t", { order: 3, is_shown_once: true });
    t.store.seed("CERT", "a\nb\n", { order: 4, is_multiline: true });
    t.store.seed("BOTH", ` "a" 'b' `, { order: 5 });
    t.store.seed("SERVICE_FQDN_APP", "app.example.com", { order: 6 });
    t.store.seed("P", "x", { order: 1, is_preview: true });
    const before = JSON.stringify(t.store.rows);
    const shown = await t.dev();
    const r = await t.save(shown.variables, shown.variablesPreview);
    expect(r.body.data).toEqual({ message: null, showPreview: true, variables: shown.variables, variablesPreview: shown.variablesPreview });
    expect(JSON.stringify(t.store.rows)).toBe(before);
    expect(t.store.updates).toEqual([]);
  });

  it("a variable stored without a value takes the text's empty value (null is not '')", async () => {
    const t = setup();
    t.store.seed("NOTHING", null, { order: 1 });
    const r = await t.save("NOTHING=", "");
    expect(r.body.data!.message).toBe("Environment variables updated.");
    expect(t.store.updates).toEqual([[100, { value: enc("") }]]);
    expect((await t.save("NOTHING=", "")).body.data!.message).toBeNull();
  });

  it("leaves what the view cannot edit alone: locked, multiline and unshowable values, and magic variables", async () => {
    const t = setup();
    t.store.seed("LOCKED", "s3cr3t", { order: 1, is_shown_once: true });
    t.store.seed("CERT", "a\nb\n", { order: 2, is_multiline: true });
    t.store.seed("BOTH", ` "a" 'b' `, { order: 3 });
    t.store.seed("SERVICE_FQDN_APP", "app.example.com", { order: 4 });
    t.store.seed("SERVICE_URL_APP", "https://app.example.com", { order: 5 });
    const r = await t.save("# coolify: literal\nLOCKED=typed over\nCERT=typed over #c\nBOTH=typed over\nSERVICE_FQDN_APP=typed over\nSERVICE_NAME_NEW=typed");
    expect(r.status).toBe(200);
    // SERVICE_URL_APP is not in the text and stays: the generated Compose variables survive a bulk save.
    expect(t.store.dump()).toEqual(["LOCKED=s3cr3t", "CERT=a\nb\n", `BOTH= "a" 'b' `, "SERVICE_FQDN_APP=app.example.com", "SERVICE_URL_APP=https://app.example.com"]);
    expect(t.store.rows.map((v) => [v.is_literal, v.comment])).toEqual(Array(5).fill([false, null]));
    // Nothing but the order was written, so there is no toast; SERVICE_NAME_NEW was not created.
    expect(r.body.data!.message).toBeNull();
    expect(t.store.rows.map((v) => v.order)).toEqual([1, 2, 3, 4, 5]);
    expect(t.store.inserted).toEqual([]);
  });

  it("sets flags only from a '# coolify:' line, a comment only from an inline one, and every copy of a key", async () => {
    const t = setup();
    t.store.seed("A", "v", { order: 1, is_literal: true, is_buildtime: false, comment: "old" });
    t.store.seed("B", "v", { order: 2, is_literal: true });
    t.store.seed("B", "copy", { order: 2, is_runtime: false });
    const r = await t.save("A=v\n# coolify: literal=false runtime=false\nB=new #both");
    expect(r.body.data!.message).toBe("Environment variables updated.");
    expect(t.store.rows.map((v) => [v.key, v.value, v.is_literal, v.is_buildtime, v.is_runtime, v.comment])).toEqual([
      ["A", enc("v"), true, false, true, "old"],
      ["B", enc("new"), false, true, false, "both"],
      ["B", enc("new"), false, true, false, "both"],
    ]);
    // A new variable takes the directive's flags, and the model's defaults for the rest.
    await t.save("# coolify: literal buildtime=false\nC=1\nD=2", "");
    expect(t.store.inserted.filter((v) => !v.isPreview).map((v) => [v.key, v.isLiteral, v.isBuildtime, v.isRuntime, v.isMultiline, v.isRequired])).toEqual([
      ["C", true, false, true, false, false],
      ["D", false, true, true, false, false],
    ]);
  });

  it("an empty text deletes every variable but the generated Compose ones", async () => {
    const t = setup();
    t.store.seed("A", "v");
    t.store.seed("LOCKED", "v", { is_shown_once: true });
    t.store.seed("SERVICE_FQDN_APP", "v");
    t.store.seed("SERVICE_PASSWORD_DB", "v");
    t.store.seed("P", "v", { is_preview: true });
    const r = await t.save(null, null);
    expect(r.body.data).toMatchObject({ message: "Environment variables updated.", variables: "", variablesPreview: "" });
    expect(await t.list()).toEqual(["production:SERVICE_FQDN_APP"]);
  });

  it("without previews the preview text is not read and the preview variables stay", async () => {
    const t = setup();
    t.store.resources[0] = resourceRow({ dockerfile: "FROM nginx" });
    t.store.seed("P", "stays", { is_preview: true });
    const r = await t.save("A=1", "# coolify: nonsense\nQ=1");
    expect(r.body.data).toEqual({ message: "Environment variables updated.", showPreview: false, variables: "A=1", variablesPreview: null });
    // A's preview copy is still made (the created hook does not ask whether previews show).
    expect(t.store.dump(true)).toEqual(["P=stays", "A=1"]);
  });

  it("an invalid text changes nothing and answers PHP's message, the preview's with its prefix", async () => {
    const t = setup();
    t.store.seed("A", "v", { order: 1 });
    const cases: Array<[string | null, string | null, string]> = [
      ["# coolify: literal\n\nA=1", "", 'Line 1: a "# coolify:" line must be directly above a KEY=value line.'],
      ["A=1\n# coolify: nope\nB=2", "", 'Line 2: unknown flag "nope". Allowed flags: literal, buildtime, runtime.'],
      ["# coolify: literal=1\nA=1", "", 'Line 1: the value of "literal" must be true or false.'],
      ["A=1\n# coolify:", "", 'Line 2: the "# coolify:" line has no flags.'],
      ["export A=1", "", KEY_REGEX],
      ["A=1\n A =2", "", "Duplicate environment variable key after normalization: A."],
      ["=nokey", "", KEY_REGEX],
      ["A=1", "B=1\n# coolify: literal", 'Preview deployments: Line 2: a "# coolify:" line must be directly above a KEY=value line.'],
      ["A=1", "my key=1", `Preview deployments: ${KEY_REGEX}`],
    ];
    for (const [variables, preview, message] of cases) {
      const r = await t.save(variables, preview);
      expect([variables, r.status, r.body.error]).toEqual([variables, 422, expect.objectContaining({ code: "validation_failed", message })]);
    }
    expect(t.store.dump()).toEqual(["A=v"]);
    expect(t.store.updates).toEqual([]);
    // A NUL in a value is the model's ValidationException.
    const nul = await t.save("A=a\0b", "");
    expect([nul.status, nul.body.error!.details.fields]).toEqual([422, { value: ["The value cannot contain a NUL character."] }]);
    const text = await t.call("PUT", "dev", { variables: ["A=1"] });
    expect([text.status, text.body.error!.details.fields]).toEqual([422, { variables: ["The variables field must be a string."] }]);
  });

  it("normalizes a key's edge whitespace, and a line with a carriage return reads as without", async () => {
    const t = setup();
    const r = await t.save(" SPACED =1\r\nB=\"two\"\r\n", "");
    expect(r.body.data).toMatchObject({ message: "Environment variables updated.", variables: "SPACED=1\nB=two" });
    expect(t.store.rows.filter((v) => !v.is_preview).map((v) => [v.key, v.order])).toEqual([["SPACED", 1], ["B", 2]]);
  });
});

describe("routing and authorization", () => {
  it("unknown paths are 404 and unknown methods 405", async () => {
    const t = setup();
    const row = t.store.seed("A", "v");
    expect((await t.call("DELETE")).status).toBe(405);
    expect((await t.call("PUT")).status).toBe(405);
    expect((await t.call("POST", "dev")).status).toBe(405);
    expect((await t.call("DELETE", "dev")).status).toBe(405);
    expect((await t.call("GET", "settings")).status).toBe(405);
    expect((await t.call("PUT", row.uuid!)).status).toBe(405);
    expect((await t.call("GET", `${row.uuid!}/lock`)).status).toBe(405);
    expect((await t.call("POST", `${row.uuid!}/unlock`)).status).toBe(404);
    expect((await t.call("POST", "dev/lock")).status).toBe(404);
    expect((await t.call("POST", `${row.uuid!}/lock/more`)).status).toBe(404);
    expect((await t.call("GET", "bad uuid")).status).toBe(404);
    expect((await t.call("GET", "", undefined, "bad uuid")).status).toBe(404);
    expect(t.store.rows).toHaveLength(1);
  });

  it("a member without deploy.resource.write gets 404 on every change", async () => {
    const t = setup({ write: false });
    const row = t.store.seed("A", "v");
    const writes: Array<[string, string]> = [["POST", ""], ["PUT", "dev"], ["PATCH", "settings"], ["PATCH", row.uuid!], ["DELETE", row.uuid!], ["POST", `${row.uuid!}/lock`]];
    for (const [method, path] of writes) {
      const r = await t.call(method, path, { key: "B", value: "x", variables: "", use_build_secrets: true });
      expect([method, path, r.status, r.body.error?.code]).toEqual([method, path, 404, "not_found"]);
    }
    expect(t.orgs).toHaveLength(0);
    expect(t.store.dump()).toEqual(["A=v"]);
    expect([t.store.updates, t.store.settingUpdates]).toEqual([[], []]);
  });

  it("a member without deploy.resource.read gets 404 on every read", async () => {
    const t = setup({ read: false });
    const row = t.store.seed("A", "v");
    for (const path of ["", "dev", row.uuid!]) expect([path, (await t.call("GET", path)).status]).toEqual([path, 404]);
    expect(t.orgs).toHaveLength(0);
  });

  it("handleApplications and route() send the environment variable paths to the handler behind the same checks", async () => {
    const t = setup();
    // Through handleApplications with its default runner: the handler is reached and has no database to run against.
    const res = await handleApplications({ ENVIRONMENT: "test" }, "req_1", actor, ORG_UUID, ["app1", "environment-variables"], new Request(`${BASE}/applications/app1/environment-variables`));
    expect(res.status).toBe(503);
    const unknown = await handleApplications(t.env, "req_1", actor, ORG_UUID, ["app1", "environment-variables", "a", "b", "c"], new Request(`${BASE}/applications/app1/environment-variables/a/b/c`));
    expect(unknown.status).toBe(404);

    const bare: Env = { ENVIRONMENT: "test" };
    const headers = { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" };
    const paths: Array<[string, string]> = [
      ["GET", "/applications/app1/environment-variables"],
      ["POST", "/applications/app1/environment-variables"],
      ["GET", "/applications/app1/environment-variables/dev"],
      ["PUT", "/applications/app1/environment-variables/dev"],
      ["PATCH", "/applications/app1/environment-variables/settings"],
      ["GET", "/applications/app1/environment-variables/var1"],
      ["PATCH", "/applications/app1/environment-variables/var1"],
      ["DELETE", "/applications/app1/environment-variables/var1"],
      ["POST", "/applications/app1/environment-variables/var1/lock"],
    ];
    for (const [method, path] of paths) {
      expect([method, path, (await route(new Request(`${BASE}${path}`, { method }), bare)).status]).toEqual([method, path, 401]);
      expect([method, path, (await route(new Request(`https://x/v1/organizations/not-an-org/deploy${path}`, { method, headers }), bare)).status]).toEqual([method, path, 404]);
      // Routed to the handler: without bindings it answers 503.
      expect([method, path, (await route(new Request(`${BASE}${path}`, { method, headers }), bare)).status]).toEqual([method, path, 503]);
    }
    expect((await route(new Request(`${BASE}/applications/app1/environment-variables/var1/lock/more`, { headers }), bare)).status).toBe(404);
    expect((await route(new Request(`${BASE}/applications/app1/environment-variables/var1/unlock`, { method: "POST", headers }), bare)).status).toBe(404);
    expect((await route(new Request(`${BASE}/applications/app1/environment-variables`, { method: "DELETE", headers }), bare)).status).toBe(405);
    // The application's own paths are as before.
    expect((await route(new Request(`${BASE}/applications/app1/deploy/more`, { headers }), bare)).status).toBe(404);
    expect((await route(new Request(`${BASE}/applications/app1/other/more/than/that`, { headers }), bare)).status).toBe(404);
  });
});
