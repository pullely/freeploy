// Shared variables (DP-50): the developer view's parser and formatter against
// Coolify's own cases (tests/Unit/{ParseEnvFormatToArray,EnvDevViewDirective,
// FormatEnvValueForDevView}Test.php), Coolify's rules and messages, the
// operations of each scope, who sees a value, and the handler's routing and
// authorization. The SQL behind the store (and its row-level security) is
// tested in tests/db.
import { route } from "@deploy-core-worker/router";
import type { Env } from "@deploy-core-worker/env";
import { handleSharedVariables, type SharedVariableRunner } from "@deploy-core-worker/handlers/shared-variables";
import { formatEnvValueForDevView, formatEnvVariableForDevView, parseEnvDevView, parseEnvFormatToArray, phpTrim, type DevViewVariable } from "@deploy-core-worker/shared-variables/dev-view";
import type { SharedVariableStore } from "@deploy-core-worker/shared-variables/service";
import { normalizeEnvironmentVariableKey, validateAddVariable, validateUpdateVariable } from "@deploy-core-worker/shared-variables/validation";
import type { KeyCipher } from "@deploy-core-worker/private-keys/service";
import type {
  DeploySharedVariableEnvironmentRow,
  DeploySharedVariableOverviewRow,
  DeploySharedVariableProjectRow,
  DeploySharedVariableServerRow,
  DeploySharedVariableWithSecretRow,
  NewSharedVariable,
  SharedVariableChanges,
  SharedVariableOwner,
} from "@saas/db/deploy";

const ORG = "org_" + "0".repeat(31) + "a";
const ORG_UUID = "00000000-0000-0000-0000-00000000000a";
const BASE = `https://x/v1/organizations/${ORG}/deploy/shared-variables`;
const actor = { subjectId: "usr_1", subjectType: "user" };
const PROJECT = "prjaaaaaaaaaaaaaaaaaaaaa";
const ENVIRONMENT = "envaaaaaaaaaaaaaaaaaaaaa";
const SERVER = "srvaaaaaaaaaaaaaaaaaaaaa";
const KEY_REGEX = "The key must start with a letter or underscore and may only contain letters, numbers, underscores, and dots.";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fetcher(handler: (req: Request) => Promise<Response> | Response): Fetcher {
  return { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(new Request(input as string, init))) } as unknown as Fetcher;
}

const entries = (text: string) => [...parseEnvFormatToArray(text)];
const devEntries = (text: string, defaults?: Record<string, boolean>) => [...parseEnvDevView(text, defaults)];
const line = (value: string, comment: string | null = null) => ({ value, comment });

describe("parseEnvFormatToArray", () => {
  it("parses simple KEY=VALUE pairs, values with equals signs and empty values", () => {
    expect(entries("KEY1=value1\nKEY2=value2")).toEqual([
      ["KEY1", line("value1")],
      ["KEY2", line("value2")],
    ]);
    expect(entries("KEY1=value=with=equals")).toEqual([["KEY1", line("value=with=equals")]]);
    expect(entries("KEY1=\nKEY2=value")).toEqual([
      ["KEY1", line("")],
      ["KEY2", line("value")],
    ]);
  });

  it("skips comment lines, empty lines and lines without an equals sign", () => {
    expect(entries("# This is a comment\nKEY1=value1\n# Another comment\nKEY2=value2")).toEqual([
      ["KEY1", line("value1")],
      ["KEY2", line("value2")],
    ]);
    expect(entries("KEY1=value1\n\nKEY2=value2\n\n")).toEqual([
      ["KEY1", line("value1")],
      ["KEY2", line("value2")],
    ]);
    expect(entries("just words\nKEY=1\n\r")).toEqual([["KEY", line("1")]]);
    expect(entries("")).toEqual([]);
  });

  it("strips an inline comment from an unquoted value only when whitespace precedes the #", () => {
    expect(entries("NIXPACKS_NODE_VERSION=22 #needed for now\nNODE_VERSION=22")).toEqual([
      ["NIXPACKS_NODE_VERSION", line("22", "needed for now")],
      ["NODE_VERSION", line("22")],
    ]);
    expect(entries("KEY1=value1#nocomment\nKEY2=value2 #comment\nKEY3=value3  # comment with spaces")).toEqual([
      ["KEY1", line("value1#nocomment")],
      ["KEY2", line("value2", "comment")],
      ["KEY3", line("value3", "comment with spaces")],
    ]);
    expect(entries("KEY1=value1#not#comment\nKEY2=value2 # comment # with # hashes")).toEqual([
      ["KEY1", line("value1#not#comment")],
      ["KEY2", line("value2", "comment # with # hashes")],
    ]);
    expect(entries("KEY1=value1   #comment\nKEY2=value2\t#comment with tab")).toEqual([
      ["KEY1", line("value1", "comment")],
      ["KEY2", line("value2", "comment with tab")],
    ]);
    expect(entries("PASSWORD=pass#word123\nAPI_KEY=abc#def#ghi")).toEqual([
      ["PASSWORD", line("pass#word123")],
      ["API_KEY", line("abc#def#ghi")],
    ]);
    expect(entries("ASD=asd #asdfgg")).toEqual([["ASD", line("asd", "asdfgg")]]);
    expect(entries("DATABASE_URL=postgres://localhost #this is the database connection string for production")).toEqual([
      ["DATABASE_URL", line("postgres://localhost", "this is the database connection string for production")],
    ]);
  });

  it("gives an empty comment as none", () => {
    expect(entries("KEY1=value #\nKEY2=value # ")).toEqual([
      ["KEY1", line("value")],
      ["KEY2", line("value")],
    ]);
  });

  it("keeps a # inside quotes, and reads a comment after the closing quote", () => {
    expect(entries("KEY1=\"value with # hash\"\nKEY2='another # hash'")).toEqual([
      ["KEY1", line("value with # hash")],
      ["KEY2", line("another # hash")],
    ]);
    expect(entries('KEY1="#starts with hash"\nKEY2="hash # in middle"\nKEY3="ends with hash#"')).toEqual([
      ["KEY1", line("#starts with hash")],
      ["KEY2", line("hash # in middle")],
      ["KEY3", line("ends with hash#")],
    ]);
    expect(entries("KEY1=\"value with spaces\" #comment\nKEY2=\"another value\"")).toEqual([
      ["KEY1", line("value with spaces", "comment")],
      ["KEY2", line("another value")],
    ]);
    expect(entries("UNQUOTED=value1 #comment1\nDOUBLE=\"value2\" #comment2\nSINGLE='value3' #comment3")).toEqual([
      ["UNQUOTED", line("value1", "comment1")],
      ["DOUBLE", line("value2", "comment2")],
      ["SINGLE", line("value3", "comment3")],
    ]);
  });

  it("reads a quote that never closes as the start of an unquoted value, kept whole", () => {
    expect(entries('KEY="abc #not a comment ')).toEqual([["KEY", line("abc #not a comment ")]]);
    expect(entries("KEY='")).toEqual([["KEY", line("")]]);
  });

  it("trims unquoted values and keeps the spaces of quoted values; the key is not trimmed", () => {
    expect(entries("KEY1 = value1  \nKEY2=\" secret \"\nKEY3=' secret'\r")).toEqual([
      ["KEY1 ", line("value1")],
      ["KEY2", line(" secret ")],
      ["KEY3", line(" secret")],
    ]);
    // PHP's trim(): space, tab, newline, carriage return, NUL and vertical tab; not a non-breaking space.
    expect(phpTrim(" \t\n\r\0\x0Bvalue  ")).toBe("value ");
    expect(entries("KEY= x ")).toEqual([["KEY", line(" x ")]]);
  });

  it("a key given twice keeps its first place and its last value, as a PHP array does", () => {
    expect(entries("A=1\nB=2\nA=3 #again")).toEqual([
      ["A", line("3", "again")],
      ["B", line("2")],
    ]);
  });

  it("handles a real file", () => {
    const input = ["# Database Configuration", "DB_HOST=localhost", "DB_PORT=5432 #default postgres port", 'DB_NAME="my_database"', "DB_PASSWORD='p@ssw0rd#123'", "", "# API Keys", "API_KEY=abc123 # Production key", "SECRET_KEY=xyz789"].join("\n");
    expect(entries(input)).toEqual([
      ["DB_HOST", line("localhost")],
      ["DB_PORT", line("5432", "default postgres port")],
      ["DB_NAME", line("my_database")],
      ["DB_PASSWORD", line("p@ssw0rd#123")],
      ["API_KEY", line("abc123", "Production key")],
      ["SECRET_KEY", line("xyz789")],
    ]);
  });
});

describe("formatEnvValueForDevView", () => {
  it.each([
    ["plain", "plain-value"],
    ["empty", ""],
    ["double quoted", '"abc"'],
    ["single quoted", "'$FOO'"],
    ["leading double quote only", '"abc'],
    ["quotes inside", "He said \"hi\" and 'bye'"],
    ["hash after whitespace", "value #not-a-comment"],
    ["hash without whitespace", "value#hash"],
    ["double quoted with suffix", '"Company :: App" <noreply@example.com>'],
    ["leading space", " secret"],
    ["trailing tab", "secret\t"],
  ])("formats a %s value so that it is read back unchanged", (_name, value) => {
    const formatted = formatEnvValueForDevView(value);
    expect(formatted).not.toBeNull();
    expect(entries(`KEY=${formatted}`)).toEqual([["KEY", line(value)]]);
  });

  it("quotes only what needs it, single quotes first", () => {
    expect(formatEnvValueForDevView("plain")).toBe("plain");
    expect(formatEnvValueForDevView(null)).toBe("");
    expect(formatEnvValueForDevView(" secret")).toBe("' secret'");
    expect(formatEnvValueForDevView("it's #1")).toBe('"it\'s #1"');
    expect(formatEnvValueForDevView("value#hash")).toBe("value#hash");
  });

  it("returns null for a value the format cannot hold", () => {
    expect(formatEnvValueForDevView("'\"Company :: App\" <noreply@example.com>'")).toBeNull();
    expect(formatEnvValueForDevView("first\nsecond")).toBeNull();
  });
});

describe("the developer view's lines and directives", () => {
  const variable = (attributes: Partial<DevViewVariable> = {}): DevViewVariable => ({ key: "KEY", value: "value", isShownOnce: false, isMultiline: false, isLiteral: false, ...attributes });

  it("formats a directive line only for the literal flag, the one a shared variable has", () => {
    expect(formatEnvVariableForDevView(variable(), true)).toBe("KEY=value");
    expect(formatEnvVariableForDevView(variable({ isLiteral: true }), true)).toBe("# coolify: literal\nKEY=value");
  });

  it("formats no directive above a placeholder line", () => {
    expect(formatEnvVariableForDevView(variable({ isLiteral: true }), false)).toBe("KEY=(Hidden, only admins can view)");
    expect(formatEnvVariableForDevView(variable({ isLiteral: true, isShownOnce: true }), true)).toBe("KEY=(Locked Secret, delete and add again to change)");
    expect(formatEnvVariableForDevView(variable({ isLiteral: true, isMultiline: true }), true)).toBe("KEY=(Multiline environment variable, edit in normal view)");
    expect(formatEnvVariableForDevView(variable({ isLiteral: true, value: "'\"a\" b'" }), true)).toBe("KEY=(Value cannot be shown in this view, edit in normal view)");
    // Hidden wins over locked, locked over multiline.
    expect(formatEnvVariableForDevView(variable({ isShownOnce: true, isMultiline: true }), false)).toBe("KEY=(Hidden, only admins can view)");
    expect(formatEnvVariableForDevView(variable({ isShownOnce: true, isMultiline: true }), true)).toBe("KEY=(Locked Secret, delete and add again to change)");
  });

  it.each(["plain", '"abc"', "'$FOO'", "value #not-a-comment"])("reads back the flag and the value %s that it formats", (value) => {
    for (const isLiteral of [false, true]) {
      const text = `${formatEnvVariableForDevView(variable({ value, isLiteral }), true)}\n${formatEnvVariableForDevView(variable({ key: "OTHER", value: "x" }), true)}`;
      const parsed = parseEnvDevView(text);
      expect(parsed.get("KEY")!.value).toBe(value);
      expect({ is_literal: isLiteral, ...parsed.get("KEY")!.settings }).toEqual({ is_literal: isLiteral });
      expect(parsed.get("OTHER")!.settings).toEqual({});
    }
  });

  it("parses explicit and bare directive values", () => {
    expect(devEntries("# coolify: literal=false buildtime runtime=true\nA=1   # a comment\n# other comment\nB=2", { literal: false, buildtime: true, runtime: true })).toEqual([
      ["A", { value: "1", comment: "a comment", settings: { is_literal: false, is_buildtime: true, is_runtime: true } }],
      ["B", { value: "2", comment: null, settings: {} }],
    ]);
    expect(devEntries("# coolify:   literal  \nA=1")).toEqual([["A", { value: "1", comment: null, settings: { is_literal: true } }]]);
    expect(devEntries("")).toEqual([]);
    expect(parseEnvDevView(null).size).toBe(0);
  });

  it.each([
    ["last line", "A=1\n# coolify: literal", 'Line 2: a "# coolify:" line must be directly above a KEY=value line.'],
    ["blank line before key", "# coolify: literal\n\nA=1", 'Line 1: a "# coolify:" line must be directly above a KEY=value line.'],
    ["comment before key", "# coolify: literal\n# note\nA=1", 'Line 1: a "# coolify:" line must be directly above a KEY=value line.'],
    ["two directives", "# coolify: literal\n# coolify: literal=false\nA=1", 'Line 1: a "# coolify:" line must be directly above a KEY=value line.'],
    ["no flags", "# coolify:\nA=1", 'Line 1: the "# coolify:" line has no flags.'],
    ["unknown flag", "# coolify: multiline\nA=1", 'Line 1: unknown flag "multiline". Allowed flags: literal.'],
    ["a resource variable's flag", "# coolify: buildtime=false\nA=1", 'Line 1: unknown flag "buildtime". Allowed flags: literal.'],
    ["bad value", "A=0\n\n# coolify: literal=yes\nB=1", 'Line 3: the value of "literal" must be true or false.'],
  ])("rejects an invalid directive: %s", (_name, text, message) => {
    expect(() => parseEnvDevView(text)).toThrow(message);
  });

  it("names every allowed flag when a variable kind has more than one", () => {
    expect(() => parseEnvDevView("# coolify: multiline\nA=1", { literal: false, buildtime: true, runtime: true })).toThrow('Line 1: unknown flag "multiline". Allowed flags: literal, buildtime, runtime.');
  });

  it("keeps ignoring directive lines in parseEnvFormatToArray", () => {
    expect(entries("# coolify: literal\nA=1\n# coolify: bogus")).toEqual([["A", line("1")]]);
  });

  it("gives a key set twice the directive of its last line", () => {
    expect(devEntries("# coolify: literal\nA=1\nB=2\nA=3")).toEqual([
      ["A", { value: "3", comment: null, settings: {} }],
      ["B", { value: "2", comment: null, settings: {} }],
    ]);
  });
});

describe("the forms' rules", () => {
  const add = (body: Record<string, unknown>) => {
    const v = validateAddVariable({ key: "NODE_ENV", value: "production", is_multiline: false, is_literal: false, ...body });
    return v.ok ? v.input : v.errors;
  };
  const update = (body: Record<string, unknown>) => {
    const v = validateUpdateVariable({ key: "NODE_ENV", value: "production", is_multiline: false, is_literal: false, is_shown_once: false, ...body });
    return v.ok ? v.input : v.errors;
  };

  it("Add: the key trimmed, the value and comment as sent, the flags as booleans", () => {
    expect(add({ key: "  NODE_ENV\n", comment: "what it is for", is_multiline: "1", is_literal: 0 })).toEqual({ key: "NODE_ENV", value: "production", comment: "what it is for", isMultiline: true, isLiteral: false });
    expect(add({ value: null, comment: "" })).toEqual({ key: "NODE_ENV", value: "", comment: null, isMultiline: false, isLiteral: false });
    expect(add({ key: "_a.b.C9" })).toMatchObject({ key: "_a.b.C9" });
    expect(normalizeEnvironmentVariableKey("​﻿ KEY \0")).toBe("KEY");
  });

  it("Add: Coolify's key messages, and Laravel's defaults under Add's attribute names", () => {
    expect(add({ key: "" })).toEqual({ key: ["The key field is required."] });
    expect(add({ key: "   " })).toEqual({ key: ["The key field is required."] });
    expect(add({ key: 12 })).toEqual({ key: ["The key field must be a string."] });
    for (const key of ["1ABC", "MY-KEY", "MY KEY", "KEY=1", "ключ", "A\nB", "$HOME"]) expect(add({ key })).toEqual({ key: [KEY_REGEX] });
    expect(add({ key: "A".repeat(256) })).toEqual({ key: ["The key may not be greater than 255 characters."] });
    expect(add({ key: `1${"A".repeat(255)}` })).toEqual({ key: ["The key may not be greater than 255 characters.", KEY_REGEX] });
    expect(add({ key: "A".repeat(255) })).toMatchObject({ key: "A".repeat(255) });
    expect(add({ comment: "c".repeat(257) })).toEqual({ comment: ["The comment field must not be greater than 256 characters."] });
    expect(add({ comment: "c".repeat(256) })).toMatchObject({ comment: "c".repeat(256) });
    expect(add({ comment: 5 })).toEqual({ comment: ["The comment field must be a string."] });
    expect(add({ value: 5 })).toEqual({ value: ["The value field must be a string."] });
    expect(add({ is_multiline: undefined, is_literal: null })).toEqual({ is_multiline: ["The multiline field is required."], is_literal: ["The literal field is required."] });
    expect(add({ is_multiline: "yes", is_literal: 2 })).toEqual({ is_multiline: ["The multiline field must be true or false."], is_literal: ["The literal field must be true or false."] });
  });

  it("Show: the same key rules, and Laravel's names for the fields Show does not name", () => {
    expect(update({ key: " DB.URL ", comment: "note", is_shown_once: "0", newLockedValue: "next" })).toEqual({
      key: "DB.URL",
      value: "production",
      comment: "note",
      isMultiline: false,
      isLiteral: false,
      isShownOnce: false,
      newLockedValue: "next",
    });
    expect(update({ value: null })).toMatchObject({ value: "", newLockedValue: null });
    expect(update({ key: "no-dash" })).toEqual({ key: [KEY_REGEX] });
    expect(update({ key: null, is_multiline: null, is_literal: "x", is_shown_once: undefined, newLockedValue: 7 })).toEqual({
      key: ["The key field is required."],
      is_multiline: ["The is multiline field is required."],
      is_literal: ["The is literal field must be true or false."],
      is_shown_once: ["The is shown once field is required."],
      newLockedValue: ["The new locked value field must be a string."],
    });
  });
});

type Row = DeploySharedVariableWithSecretRow;

/** deploy.shared_environment_variables and the owners of one org, in memory. */
class MemoryStore implements SharedVariableStore {
  rows: Row[] = [];
  project = { id: 10, uuid: PROJECT, name: "Shop", description: "the store" };
  emptyProject = { id: 11, uuid: "prjbbbbbbbbbbbbbbbbbbbbb", name: "alpha", description: null };
  environmentRows = [
    { id: 20, uuid: ENVIRONMENT, name: "production", description: null, project_id: 10 },
    { id: 21, uuid: "envstaging00000000000000", name: "staging", description: "pre-production", project_id: 10 },
  ];
  serverRows: DeploySharedVariableServerRow[] = [
    { id: 30, uuid: SERVER, name: "prod-1", description: null, ip: "203.0.113.10", is_reachable: true, is_usable: true, force_disabled: false },
    { id: 31, uuid: "srvbbbbbbbbbbbbbbbbbbbbb", name: "build-1", description: "builds", ip: "203.0.113.11", is_reachable: false, is_usable: false, force_disabled: false },
  ];
  private next = 1;
  private clock = 0;
  private owned(owner: SharedVariableOwner) {
    return this.rows.filter((r) => r.type === owner.type && (owner.type === "team" || String(r[`${owner.type}_id`]) === String(owner.id)));
  }
  private environment(e: (typeof this.environmentRows)[number]): DeploySharedVariableEnvironmentRow {
    return { ...e, project_uuid: this.project.uuid, project_name: this.project.name, project_description: this.project.description };
  }
  async findProject(uuid: string) {
    return [this.project, this.emptyProject].find((p) => p.uuid === uuid) ?? null;
  }
  async findEnvironment(uuid: string) {
    const e = this.environmentRows.find((x) => x.uuid === uuid);
    return e ? this.environment(e) : null;
  }
  async findServer(uuid: string) {
    return this.serverRows.find((s) => s.uuid === uuid) ?? null;
  }
  async projects(): Promise<DeploySharedVariableProjectRow[]> {
    return [this.emptyProject, this.project].map((p) => ({ ...p, variable_count: this.owned({ type: "project", id: p.id }).length }));
  }
  async environments() {
    return this.environmentRows.map((e) => this.environment(e));
  }
  async servers() {
    return [...this.serverRows].sort((a, b) => a.name.localeCompare(b.name));
  }
  async overview(): Promise<DeploySharedVariableOverviewRow[]> {
    return this.rows.map((r) => {
      const environment = this.environmentRows.find((e) => r.type === "environment" && e.id === r.environment_id);
      const server = this.serverRows.find((s) => r.type === "server" && s.id === r.server_id);
      const project = r.type === "project" && r.project_id === this.project.id ? this.project : null;
      return {
        id: r.id, key: r.key, type: r.type, project_id: r.project_id, environment_id: r.environment_id, server_id: r.server_id, updated_at: r.updated_at,
        project_uuid: project?.uuid ?? null, project_name: project?.name ?? null,
        environment_uuid: environment?.uuid ?? null, environment_name: environment?.name ?? null,
        environment_project_uuid: environment ? this.project.uuid : null, environment_project_name: environment ? this.project.name : null,
        server_uuid: server?.uuid ?? null, server_name: server?.name ?? null,
      };
    });
  }
  async list(owner: SharedVariableOwner) {
    return this.owned(owner).map((r) => ({ ...r }));
  }
  async findById(owner: SharedVariableOwner, id: string) {
    const r = this.owned(owner).find((x) => String(x.id) === id);
    return r ? { ...r } : null;
  }
  async findByKey(owner: SharedVariableOwner, key: string) {
    const r = this.owned(owner).find((x) => x.key === key);
    return r ? { ...r } : null;
  }
  async insert(v: Omit<NewSharedVariable, "orgId">) {
    const at = `2026-11-24 10:00:${String(this.clock++).padStart(2, "0")}`;
    const row: Row = {
      id: this.next++, key: v.key, value: v.value, type: v.owner.type,
      project_id: v.owner.type === "project" ? v.owner.id : null,
      environment_id: v.owner.type === "environment" ? v.owner.id : null,
      server_id: v.owner.type === "server" ? v.owner.id : null,
      is_shown_once: false, is_multiline: v.isMultiline ?? false, is_literal: v.isLiteral ?? false, comment: v.comment ?? null, created_at: at, updated_at: at,
    };
    this.rows.push(row);
    return row;
  }
  async update(id: string | number, changes: SharedVariableChanges) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return null;
    if (changes.key !== undefined) row.key = changes.key;
    if (changes.value !== undefined) row.value = changes.value;
    if (changes.comment !== undefined) row.comment = changes.comment;
    if (changes.isMultiline !== undefined) row.is_multiline = changes.isMultiline;
    if (changes.isLiteral !== undefined) row.is_literal = changes.isLiteral;
    // The saving hook: a lock is permanent.
    if (changes.isShownOnce !== undefined) row.is_shown_once = row.is_shown_once || changes.isShownOnce;
    row.updated_at = `2026-11-24 11:00:${String(this.clock++).padStart(2, "0")}`;
    return row;
  }
  async delete(id: string | number) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    return this.rows.length < before;
  }
  async deleteExcept(owner: SharedVariableOwner, keys: string[], protectedKeys: string[]) {
    const gone = this.owned(owner).filter((r) => !keys.includes(r.key) && !protectedKeys.includes(r.key));
    this.rows = this.rows.filter((r) => !gone.includes(r));
    return gone.length;
  }
}

const cipher: KeyCipher = {
  encrypt: async (p) => `enc:${p}`,
  decrypt: async (s) => {
    if (!s.startsWith("enc:")) throw new Error("not encrypted");
    return s.slice(4);
  },
};

interface Variable {
  id: string;
  key: string;
  comment: string | null;
  isMultiline: boolean;
  isLiteral: boolean;
  isShownOnce: boolean;
  readOnly: boolean;
  value: string | null;
}
interface Page {
  scope: { type: string; uuid: string | null; title: string; project: { uuid: string; name: string } | null };
  variables: Variable[];
  readOnlyKeys: string[];
  devView: string;
  canUpdate: boolean;
  canViewValues: boolean;
  message?: string | null;
  changed?: boolean;
}
type Body = { data?: Record<string, unknown>; error?: { code: string; message: string; details: { fields?: Record<string, string[]> } } };

function setup(opts: { write?: boolean; read?: boolean } = {}) {
  const store = new MemoryStore();
  const asked: string[] = [];
  const access = { write: opts.write ?? true, read: opts.read ?? true };
  const env: Env = {
    ENVIRONMENT: "test",
    PLATFORM_DB: { connectionString: "postgres://unused" } as Hyperdrive,
    MEMBERSHIP_WORKER: fetcher(() => json({ data: { memberships: [] } })),
    POLICY_WORKER: fetcher(async (req) => {
      const body = (await req.json()) as { action: string };
      asked.push(body.action);
      const allow = body.action === "deploy.resource.write" ? access.write : access.read;
      return json({ data: { decision: allow ? "allow" : "deny", allow } });
    }),
  };
  const orgs: string[] = [];
  // A failed operation changes nothing, as the transaction of withOrg() guarantees.
  const runner: SharedVariableRunner = async (_env, orgId, fn) => {
    orgs.push(orgId);
    const before = store.rows.map((r) => ({ ...r }));
    try {
      return await fn({ store, cipher });
    } catch (e) {
      store.rows = before;
      throw e;
    }
  };
  const call = async (method: string, path = "", body?: unknown) => {
    const segments = path.split("?")[0]!.split("/").filter(Boolean);
    const init: RequestInit = { method };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await handleSharedVariables(env, "req_1", actor, ORG_UUID, segments, new Request(`${BASE}${path ? `/${path}` : ""}`, init), runner);
    return { status: res.status, body: (await res.json()) as Body };
  };
  const page = async (scope: string) => (await call("GET", scope)).body.data as unknown as Page;
  /** A variable through the API; its id. */
  const add = async (scope: string, key: string, value = "v", extra: Record<string, unknown> = {}) => {
    const r = await call("POST", scope, { key, value, is_multiline: false, is_literal: false, ...extra });
    if (r.status !== 201) throw new Error(`add ${key}: ${r.status} ${JSON.stringify(r.body.error)}`);
    return (r.body.data as unknown as Variable).id;
  };
  const edit = (scope: string, id: string, body: Record<string, unknown>) =>
    call("PATCH", `${scope}/${id}`, { key: "KEY", value: "v", is_multiline: false, is_literal: false, is_shown_once: false, ...body });
  const bulk = (scope: string, variables: string) => call("POST", `${scope}/bulk`, { variables });
  const plain = (scope: SharedVariableOwner["type"], key: string) => {
    const row = store.rows.find((r) => r.type === scope && r.key === key);
    return row ? row.value.replace(/^enc:/, "") : null;
  };
  /** The server's predefined variables, as createServer stores them. */
  const predefine = async () => {
    await store.insert({ owner: { type: "server", id: 30 }, key: "COOLIFY_SERVER_UUID", value: `enc:${SERVER}`, isLiteral: true });
    await store.insert({ owner: { type: "server", id: 30 }, key: "COOLIFY_SERVER_NAME", value: "enc:prod-1", isLiteral: true });
  };
  return { store, asked, orgs, access, call, page, add, edit, bulk, plain, predefine, env };
}

const SCOPES = ["team", `project/${PROJECT}`, `environment/${ENVIRONMENT}`, `server/${SERVER}`];

describe("a scope's variables", () => {
  it("each scope has its own: the editor's title, the variables in the order they were created, never a value", async () => {
    const t = setup();
    for (const scope of SCOPES) {
      await t.add(scope, "ZED", `secret of ${scope}`, { comment: "last by key" });
      await t.add(scope, "ALPHA", "a", { is_multiline: true, is_literal: true });
    }
    const titles: Record<string, Page["scope"]> = {
      team: { type: "team", uuid: null, title: "Team variables", project: null },
      [`project/${PROJECT}`]: { type: "project", uuid: PROJECT, title: "Shop", project: null },
      [`environment/${ENVIRONMENT}`]: { type: "environment", uuid: ENVIRONMENT, title: "Shop / production", project: { uuid: PROJECT, name: "Shop" } },
      [`server/${SERVER}`]: { type: "server", uuid: SERVER, title: "prod-1", project: null },
    };
    for (const scope of SCOPES) {
      const page = await t.page(scope);
      expect(page.scope).toEqual(titles[scope]);
      expect(page.variables.map((v) => [v.key, v.comment, v.isMultiline, v.isLiteral, v.isShownOnce, v.readOnly, v.value])).toEqual([
        ["ZED", "last by key", false, false, false, false, null],
        ["ALPHA", null, true, true, false, false, null],
      ]);
      expect(page).toMatchObject({ canUpdate: true, canViewValues: true, readOnlyKeys: scope.startsWith("server") ? ["COOLIFY_SERVER_UUID", "COOLIFY_SERVER_NAME"] : [] });
      // The developer view: by key; a multiline variable is edited in the normal view.
      expect(page.devView).toBe(`ALPHA=(Multiline environment variable, edit in normal view)\nZED=secret of ${scope}`);
    }
    expect(t.store.rows).toHaveLength(8);
    expect(t.store.rows.every((r) => r.value.startsWith("enc:"))).toBe(true);
    expect(t.store.rows.filter((r) => r.type === "environment").every((r) => r.environment_id === 20 && r.project_id === null)).toBe(true);
    expect(t.orgs.every((o) => o === ORG_UUID)).toBe(true);
  });

  it("saveKey: 'Variable already exists.' within the scope only; the rules run first", async () => {
    const t = setup();
    await t.add("team", "NODE_ENV", "production");
    const again = await t.call("POST", "team", { key: " NODE_ENV ", value: "x", is_multiline: false, is_literal: false });
    expect(again.status).toBe(422);
    expect(again.body.error?.message).toBe("Variable already exists.");
    expect(again.body.error?.details.fields).toBeUndefined();
    // The same key in another scope is another variable.
    await t.add(`project/${PROJECT}`, "NODE_ENV", "staging");
    expect(t.plain("team", "NODE_ENV")).toBe("production");
    expect(t.plain("project", "NODE_ENV")).toBe("staging");

    const invalid = await t.call("POST", "team", { key: "NODE-ENV", value: "x" });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error?.details.fields).toEqual({ key: [KEY_REGEX], is_multiline: ["The multiline field is required."], is_literal: ["The literal field is required."] });
    const nul = await t.call("POST", "team", { key: "BIN", value: "a\0b", is_multiline: false, is_literal: false });
    expect(nul.status).toBe(422);
    expect(nul.body.error?.message).toBe("The value cannot contain a NUL character.");
    expect(t.store.rows.map((r) => r.key)).toEqual(["NODE_ENV", "NODE_ENV"]);
    // An empty value is a value.
    await t.add("team", "EMPTY", "");
    expect(t.plain("team", "EMPTY")).toBe("");
  });

  it("loads a value only when the edit dialog asks for it", async () => {
    const t = setup();
    const id = await t.add("team", "TOKEN", "s3cret", { comment: "api" });
    const shown = await t.call("GET", `team/${id}`);
    expect(shown.status).toBe(200);
    expect(shown.body.data).toEqual({ id, key: "TOKEN", comment: "api", isMultiline: false, isLiteral: false, isShownOnce: false, readOnly: false, value: "s3cret", isValueHidden: false });
    // An id of another scope, or of none, is not found.
    expect((await t.call("GET", `project/${PROJECT}/${id}`)).status).toBe(404);
    expect((await t.call("GET", "team/999")).status).toBe(404);
  });

  it("Show::submit: renames, replaces the value and the flags; 'Environment variable updated.'", async () => {
    const t = setup();
    const id = await t.add("team", "OLD", "one");
    const other = await t.add("team", "TAKEN", "x");
    const r = await t.edit("team", id, { key: " NEW_NAME ", value: "line one\nline two", comment: "two lines", is_multiline: true, is_literal: true });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ id, key: "NEW_NAME", comment: "two lines", isMultiline: true, isLiteral: true, isShownOnce: false, readOnly: false, value: null, message: "Environment variable updated." });
    expect(t.plain("team", "NEW_NAME")).toBe("line one\nline two");

    // A key another variable of the scope has: Coolify's unique index, here for every scope.
    const taken = await t.edit("team", id, { key: "TAKEN" });
    expect(taken.status).toBe(409);
    expect(taken.body.error).toMatchObject({ code: "conflict", message: "Duplicate entry found. Please use a different name." });
    // Its own key is no conflict.
    expect((await t.edit("team", other, { key: "TAKEN", value: "y" })).status).toBe(200);

    const invalid = await t.edit("team", id, { key: "9lives", is_shown_once: "maybe" });
    expect(invalid.body.error?.details.fields).toEqual({ key: [KEY_REGEX], is_shown_once: ["The is shown once field must be true or false."] });
    const nul = await t.edit("team", id, { key: "NEW_NAME", value: "\0" });
    expect(nul.status).toBe(422);
    expect(nul.body.error?.details.fields).toEqual({ value: ["The value cannot contain a NUL character."] });
    expect(t.plain("team", "NEW_NAME")).toBe("line one\nline two");
    expect((await t.edit("team", "999", {})).status).toBe(404);
    expect((await t.edit(`server/${SERVER}`, id, {})).status).toBe(404);
  });

  it("a lock is permanent: the value is in no answer, it can be replaced but never read or unlocked", async () => {
    const t = setup();
    const id = await t.add("team", "API_KEY", "first");
    const locked = await t.call("POST", `team/${id}/lock`);
    expect(locked.status).toBe(200);
    expect(locked.body.data).toMatchObject({ id, isShownOnce: true, value: null });
    expect((await t.call("GET", `team/${id}`)).body.data).toMatchObject({ isShownOnce: true, value: null, isValueHidden: false });
    expect((await t.page("team")).devView).toBe("API_KEY=(Locked Secret, delete and add again to change)");

    // The form never holds a locked value: what it sends as value is not stored, and the lock stays.
    const kept = await t.edit("team", id, { key: "API_KEY", value: "from the form", comment: "rotated", is_shown_once: false, newLockedValue: "  " });
    expect(kept.body.data).toMatchObject({ comment: "rotated", isShownOnce: true });
    expect(t.plain("team", "API_KEY")).toBe("first");
    const replaced = await t.edit("team", id, { key: "API_KEY", is_shown_once: false, newLockedValue: "second" });
    expect(replaced.body.data).toMatchObject({ isShownOnce: true, value: null });
    expect(t.plain("team", "API_KEY")).toBe("second");
    expect(JSON.stringify((await t.call("GET", `team/${id}`)).body)).not.toContain("second");
    expect(JSON.stringify(await t.page("team"))).not.toContain("second");

    // Locking through the form (is_shown_once) works too; the value sent with it is the last one stored.
    const viaForm = await t.add("team", "OTHER", "o");
    expect((await t.edit("team", viaForm, { key: "OTHER", value: "final", is_shown_once: true })).body.data).toMatchObject({ isShownOnce: true });
    expect(t.plain("team", "OTHER")).toBe("final");
    expect((await t.call("POST", "team/999/lock")).status).toBe(404);
  });

  it("deletes a variable: 'Environment variable deleted successfully.'", async () => {
    const t = setup();
    const id = await t.add(`environment/${ENVIRONMENT}`, "GONE");
    expect((await t.call("DELETE", `team/${id}`)).status).toBe(404);
    const r = await t.call("DELETE", `environment/${ENVIRONMENT}/${id}`);
    expect(r.body.data).toEqual({ deleted: true, message: "Environment variable deleted successfully." });
    expect(t.store.rows).toHaveLength(0);
    expect((await t.call("DELETE", `environment/${ENVIRONMENT}/${id}`)).status).toBe(404);
  });

  it("404s a project, environment or server the org does not have", async () => {
    const t = setup();
    for (const scope of ["project/nope", "environment/nope", "server/nope"]) {
      expect((await t.call("GET", scope)).status).toBe(404);
      expect((await t.call("POST", scope, { key: "A", value: "1", is_multiline: false, is_literal: false })).status).toBe(404);
      expect((await t.bulk(scope, "A=1")).status).toBe(404);
      expect((await t.call("PATCH", `${scope}/1`, { key: "A", value: "1", is_multiline: false, is_literal: false, is_shown_once: false })).status).toBe(404);
      expect((await t.call("POST", `${scope}/1/lock`)).status).toBe(404);
      expect((await t.call("DELETE", `${scope}/1`)).status).toBe(404);
    }
    expect(t.store.rows).toHaveLength(0);
  });
});

describe("a server's predefined variables", () => {
  it("are read-only rows whose values every reader sees, and are left out of the developer view", async () => {
    const t = setup({ write: false });
    await t.predefine();
    const page = await t.page(`server/${SERVER}`);
    expect(page.variables).toEqual([
      { id: "1", key: "COOLIFY_SERVER_UUID", comment: null, isMultiline: false, isLiteral: true, isShownOnce: false, readOnly: true, value: SERVER },
      { id: "2", key: "COOLIFY_SERVER_NAME", comment: null, isMultiline: false, isLiteral: true, isShownOnce: false, readOnly: true, value: "prod-1" },
    ]);
    expect(page).toMatchObject({ devView: "", canUpdate: false, canViewValues: false });
    expect((await t.call("GET", `server/${SERVER}/1`)).body.data).toMatchObject({ value: SERVER, readOnly: true, isValueHidden: false });
  });

  it("cannot be created, changed, locked or deleted: 'Cannot create predefined variable.'", async () => {
    const t = setup();
    await t.predefine();
    for (const key of ["COOLIFY_SERVER_UUID", "COOLIFY_SERVER_NAME"]) {
      const r = await t.call("POST", `server/${SERVER}`, { key, value: "x", is_multiline: false, is_literal: false });
      expect(r.status).toBe(422);
      expect(r.body.error?.message).toBe("Cannot create predefined variable.");
    }
    // Only a server has them: the same key is an ordinary variable of the team.
    await t.add("team", "COOLIFY_SERVER_UUID", "mine");
    expect((await t.edit(`server/${SERVER}`, "1", { key: "RENAMED" })).status).toBe(404);
    expect((await t.call("POST", `server/${SERVER}/1/lock`)).status).toBe(404);
    expect((await t.call("DELETE", `server/${SERVER}/2`)).status).toBe(404);
    // Nor can another variable take their key.
    const id = await t.add(`server/${SERVER}`, "REGION", "eu");
    expect((await t.edit(`server/${SERVER}`, id, { key: "COOLIFY_SERVER_NAME" })).status).toBe(409);
    expect(t.store.rows.filter((r) => r.type === "server").map((r) => [r.key, r.value])).toEqual([
      ["COOLIFY_SERVER_UUID", `enc:${SERVER}`],
      ["COOLIFY_SERVER_NAME", "enc:prod-1"],
      ["REGION", "enc:eu"],
    ]);
  });

  it("the developer view neither deletes nor writes them", async () => {
    const t = setup();
    await t.predefine();
    await t.add(`server/${SERVER}`, "REGION", "eu");
    const r = await t.bulk(`server/${SERVER}`, "COOLIFY_SERVER_NAME=hijacked\nZONE=b");
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ changed: true, message: "Environment variables updated.", devView: "ZONE=b" });
    expect(t.store.rows.map((r2) => [r2.key, r2.value])).toEqual([
      ["COOLIFY_SERVER_UUID", `enc:${SERVER}`],
      ["COOLIFY_SERVER_NAME", "enc:prod-1"],
      ["ZONE", "enc:b"],
    ]);
    // An empty text leaves exactly them.
    expect((await t.bulk(`server/${SERVER}`, "")).body.data).toMatchObject({ changed: true, devView: "" });
    expect(t.store.rows.map((r2) => r2.key)).toEqual(["COOLIFY_SERVER_UUID", "COOLIFY_SERVER_NAME"]);
  });
});

describe("the developer view's save", () => {
  it("creates, updates and deletes by key: 'Environment variables updated.' only when something changed", async () => {
    const t = setup();
    await t.add("team", "KEEP", "same", { comment: "kept", is_literal: true });
    await t.add("team", "CHANGE", "old", { comment: "also kept" });
    await t.add("team", "REMOVE", "bye");
    const text = "# coolify: literal\nKEEP=same\nCHANGE=new   # an inline comment\nADDED=\" spaced \"\n# coolify: literal\nLITERAL=$HOME";
    const r = await t.bulk("team", text);
    expect(r.status).toBe(200);
    const page = r.body.data as unknown as Page;
    expect(page).toMatchObject({ changed: true, message: "Environment variables updated.", canUpdate: true, canViewValues: true });
    expect(page.variables.map((v) => [v.key, v.comment, v.isLiteral, v.isMultiline])).toEqual([
      ["KEEP", "kept", true, false],
      // Only the server view writes the inline comment: the comment stays.
      ["CHANGE", "also kept", false, false],
      ["ADDED", null, false, false],
      ["LITERAL", null, true, false],
    ]);
    expect([t.plain("team", "KEEP"), t.plain("team", "CHANGE"), t.plain("team", "ADDED"), t.plain("team", "LITERAL")]).toEqual(["same", "new", " spaced ", "$HOME"]);
    expect(page.devView).toBe("ADDED=' spaced '\nCHANGE=new\n# coolify: literal\nKEEP=same\n# coolify: literal\nLITERAL=$HOME");

    // Saving what the view shows changes nothing, and says nothing.
    const again = await t.bulk("team", page.devView);
    expect(again.body.data).toMatchObject({ changed: false, message: null, devView: page.devView });
  });

  it("a directive changes the flag; no directive keeps it", async () => {
    const t = setup();
    await t.add("team", "A", "1", { is_literal: true });
    await t.add("team", "B", "2");
    expect((await t.bulk("team", "A=1\nB=2")).body.data).toMatchObject({ changed: false });
    expect(t.store.rows.map((r) => r.is_literal)).toEqual([true, false]);
    expect((await t.bulk("team", "# coolify: literal=false\nA=1\n# coolify: literal\nB=2")).body.data).toMatchObject({ changed: true });
    expect(t.store.rows.map((r) => r.is_literal)).toEqual([false, true]);
  });

  it("leaves a locked or multiline variable, and one the view cannot hold, as it is while its line stays", async () => {
    const t = setup();
    const locked = await t.add("team", "LOCKED", "secret");
    await t.call("POST", `team/${locked}/lock`);
    await t.add("team", "MULTI", "a\nb", { is_multiline: true });
    await t.add("team", "BOTH_QUOTES", "'\"a\" b'");
    const view = (await t.page("team")).devView;
    expect(view).toBe(
      "BOTH_QUOTES=(Value cannot be shown in this view, edit in normal view)\nLOCKED=(Locked Secret, delete and add again to change)\nMULTI=(Multiline environment variable, edit in normal view)",
    );
    expect((await t.bulk("team", view)).body.data).toMatchObject({ changed: false, message: null });
    expect((await t.bulk("team", "# coolify: literal\nLOCKED=overwritten\n# coolify: literal\nMULTI=overwritten\n# coolify: literal\nBOTH_QUOTES=overwritten")).body.data).toMatchObject({ changed: false });
    expect([t.plain("team", "LOCKED"), t.plain("team", "MULTI"), t.plain("team", "BOTH_QUOTES")]).toEqual(["secret", "a\nb", "'\"a\" b'"]);
    expect(t.store.rows.every((r) => !r.is_literal)).toBe(true);
    // Removing its line deletes even a locked variable.
    expect((await t.bulk("team", "MULTI=x")).body.data).toMatchObject({ changed: true });
    expect(t.store.rows.map((r) => r.key)).toEqual(["MULTI"]);
  });

  it("an invalid directive or key changes nothing, and the message is the toast", async () => {
    const t = setup();
    await t.add("team", "A", "1");
    await t.add("team", "B", "2");
    const before = JSON.stringify(t.store.rows);
    for (const [text, message] of [
      ["A=changed\n# coolify: literal", 'Line 2: a "# coolify:" line must be directly above a KEY=value line.'],
      ["# coolify: runtime=false\nA=changed", 'Line 1: unknown flag "runtime". Allowed flags: literal.'],
      ["# coolify: literal=1\nA=changed", 'Line 1: the value of "literal" must be true or false.'],
      // The parse passes; the key fails after B was deleted and A changed, and all of it is undone.
      ["A=changed\nMY-KEY=1", KEY_REGEX],
      ["A=changed\n=no key", KEY_REGEX],
      [`A=changed\n${"K".repeat(256)}=1`, "The key may not be greater than 255 characters."],
      ["A=a\0b", "The value cannot contain a NUL character."],
    ] as const) {
      const r = await t.bulk("team", text);
      expect(r.status).toBe(422);
      expect(r.body.error?.message).toBe(message);
      expect(r.body.error?.details.fields).toBeUndefined();
      expect(JSON.stringify(t.store.rows)).toBe(before);
    }
  });

  it("a key is matched as typed and stored trimmed, as Coolify's key mutator stores it", async () => {
    const t = setup();
    await t.add("team", "FOO", "1", { is_literal: true });
    // " FOO" is not the key FOO: FOO's line is gone, so FOO is deleted, and a new FOO is created.
    expect((await t.bulk("team", " FOO=2")).body.data).toMatchObject({ changed: true, devView: "FOO=2" });
    expect(t.store.rows).toHaveLength(1);
    expect(t.store.rows[0]).toMatchObject({ key: "FOO", value: "enc:2", is_literal: false });
    // Both lines: the second would be a second FOO.
    const r = await t.bulk("team", "FOO=2\n FOO=3");
    expect(r.status).toBe(409);
    expect(r.body.error?.message).toBe("Duplicate entry found. Please use a different name.");
    expect(t.store.rows).toHaveLength(1);
  });

  it("only the server view writes the inline comment, and so clears one a line does not carry", async () => {
    const t = setup();
    await t.add(`server/${SERVER}`, "REGION", "eu", { comment: "where it runs" });
    await t.add(`server/${SERVER}`, "ZONE", "a");
    const r = await t.bulk(`server/${SERVER}`, "REGION=eu\nZONE=a # the zone\nNEW=1 #fresh");
    expect(r.body.data).toMatchObject({ changed: true, message: "Environment variables updated." });
    expect(t.store.rows.map((row) => [row.key, row.comment])).toEqual([
      ["REGION", null],
      ["ZONE", "the zone"],
      ["NEW", "fresh"],
    ]);
    const long = await t.bulk(`server/${SERVER}`, `REGION=eu #${"c".repeat(257)}`);
    expect(long.status).toBe(422);
    expect(long.body.error?.message).toBe("The comment field must not be greater than 256 characters.");
    expect(t.store.rows).toHaveLength(3);

    // A project's view leaves comments alone, on old and new variables.
    await t.add(`project/${PROJECT}`, "P", "1", { comment: "kept" });
    await t.bulk(`project/${PROJECT}`, "P=2 # ignored\nQ=3 # ignored");
    expect(t.store.rows.filter((row) => row.type === "project").map((row) => [row.key, row.comment])).toEqual([
      ["P", "kept"],
      ["Q", null],
    ]);
  });

  it("reads a missing or non-text body as an empty view", async () => {
    const t = setup();
    await t.add("team", "A", "1");
    expect((await t.call("POST", "team/bulk", { variables: 5 })).body.data).toMatchObject({ changed: true, devView: "" });
    expect(t.store.rows).toHaveLength(0);
    expect((await t.call("POST", "team/bulk")).body.data).toMatchObject({ changed: false });
  });
});

describe("who sees a value", () => {
  it("a reader sees keys, comments and flags; values are hidden in both views and in the edit dialog", async () => {
    const t = setup();
    const id = await t.add("team", "TOKEN", "s3cret", { comment: "api", is_literal: true });
    const locked = await t.add("team", "LOCKED", "l0cked");
    await t.call("POST", `team/${locked}/lock`);
    await t.add(`project/${PROJECT}`, "DB_URL", "postgres://secret");
    t.access.write = false;

    const page = await t.page("team");
    expect(page).toMatchObject({ canUpdate: false, canViewValues: false });
    expect(page.variables.map((v) => [v.key, v.comment, v.isLiteral, v.isShownOnce, v.value])).toEqual([
      ["TOKEN", "api", true, false, null],
      ["LOCKED", null, false, true, null],
    ]);
    // No directive and no "locked" either: a reader's line says only that it is hidden.
    expect(page.devView).toBe("LOCKED=(Hidden, only admins can view)\nTOKEN=(Hidden, only admins can view)");
    expect((await t.call("GET", `team/${id}`)).body.data).toMatchObject({ key: "TOKEN", value: null, isValueHidden: true });
    expect((await t.page(`project/${PROJECT}`)).devView).toBe("DB_URL=(Hidden, only admins can view)");
    for (const path of ["team", `team/${id}`, `team/${locked}`, `project/${PROJECT}`, "", "projects"]) {
      const text = JSON.stringify((await t.call("GET", path)).body);
      expect(text).not.toContain("s3cret");
      expect(text).not.toContain("l0cked");
      expect(text).not.toContain("postgres://secret");
    }
  });

  it("404s every change when policy denies deploy.resource.write", async () => {
    const t = setup();
    const id = await t.add("team", "A", "1");
    t.access.write = false;
    t.asked.length = 0;
    expect((await t.call("POST", "team", { key: "B", value: "2", is_multiline: false, is_literal: false })).status).toBe(404);
    expect((await t.edit("team", id, { key: "A", value: "2" })).status).toBe(404);
    expect((await t.call("POST", `team/${id}/lock`)).status).toBe(404);
    expect((await t.call("DELETE", `team/${id}`)).status).toBe(404);
    expect((await t.bulk("team", "")).status).toBe(404);
    expect(t.asked.every((a) => a === "deploy.resource.write")).toBe(true);
    expect(t.store.rows.map((r) => [r.key, r.value, r.is_shown_once])).toEqual([["A", "enc:1", false]]);
  });

  it("404s reads when policy denies deploy.resource.read", async () => {
    const t = setup({ read: false });
    for (const path of ["", "projects", "environments", "servers", "team", "team/1", `project/${PROJECT}`, `environment/${ENVIRONMENT}`, `server/${SERVER}`]) {
      expect((await t.call("GET", path)).status).toBe(404);
    }
    expect(t.asked).toContain("deploy.resource.read");
  });
});

describe("the overview and the index pages", () => {
  it("counts variables and owners per scope, lists the six changed last and the unused by key", async () => {
    const t = setup();
    await t.predefine();
    await t.add("team", "T_ONE");
    await t.add("team", "T_TWO");
    await t.add(`project/${PROJECT}`, "P_ONE");
    await t.add(`environment/${ENVIRONMENT}`, "E_ONE");
    await t.add("environment/envstaging00000000000000", "E_TWO");
    await t.add(`server/${SERVER}`, "S_ONE");
    const first = await t.add("team", "A_LAST_ADDED");
    await t.edit("team", first, { key: "A_LAST_ADDED", value: "changed" });

    const r = await t.call("GET");
    expect(r.status).toBe(200);
    const data = r.body.data as unknown as {
      scopes: Record<string, { variables: number; owners: number }>;
      recent: Array<Record<string, unknown>>;
      used: unknown[];
      unused: Array<Record<string, unknown>>;
      missing: number;
    };
    // A server's predefined variables are not counted.
    expect(data.scopes).toEqual({
      team: { variables: 3, owners: 1 },
      project: { variables: 1, owners: 1 },
      environment: { variables: 2, owners: 2 },
      server: { variables: 1, owners: 1 },
    });
    expect(data.recent.map((v) => v.key)).toEqual(["A_LAST_ADDED", "S_ONE", "E_TWO", "E_ONE", "P_ONE", "T_TWO"]);
    expect(data.unused.map((v) => v.key)).toEqual(["A_LAST_ADDED", "E_ONE", "E_TWO", "P_ONE", "S_ONE", "T_ONE", "T_TWO"]);
    expect(data.used).toEqual([]);
    expect(data.missing).toBe(0);
    const row = (key: string) => data.unused.find((v) => v.key === key);
    expect(row("T_ONE")).toEqual({ id: "3", key: "T_ONE", scope: "team", owner: "Team", ownerUuid: null, projectUuid: null, resources: 0, updatedAt: "2026-11-24T10:00:02.000Z" });
    expect(row("P_ONE")).toMatchObject({ scope: "project", owner: "Shop", ownerUuid: PROJECT, projectUuid: PROJECT });
    expect(row("E_TWO")).toMatchObject({ scope: "environment", owner: "Shop / staging", ownerUuid: "envstaging00000000000000", projectUuid: PROJECT });
    expect(row("S_ONE")).toMatchObject({ scope: "server", owner: "prod-1", ownerUuid: SERVER, projectUuid: null });
    expect(JSON.stringify(r.body)).not.toContain("COOLIFY_SERVER");
  });

  it("an org without variables: zero everywhere", async () => {
    const t = setup();
    expect((await t.call("GET")).body.data).toEqual({
      scopes: { team: { variables: 0, owners: 0 }, project: { variables: 0, owners: 0 }, environment: { variables: 0, owners: 0 }, server: { variables: 0, owners: 0 } },
      recent: [],
      used: [],
      unused: [],
      missing: 0,
    });
  });

  it("lists the projects with their variable counts, the projects with their environments, and the servers", async () => {
    const t = setup();
    await t.add(`project/${PROJECT}`, "A");
    await t.add(`project/${PROJECT}`, "B");
    expect((await t.call("GET", "projects")).body.data).toEqual({
      projects: [
        { uuid: "prjbbbbbbbbbbbbbbbbbbbbb", name: "alpha", description: null, variableCount: 0 },
        { uuid: PROJECT, name: "Shop", description: "the store", variableCount: 2 },
      ],
    });
    // A project without environments is not listed.
    expect((await t.call("GET", "environments")).body.data).toEqual({
      projects: [
        {
          uuid: PROJECT,
          name: "Shop",
          description: "the store",
          environments: [
            { uuid: ENVIRONMENT, name: "production", description: null },
            { uuid: "envstaging00000000000000", name: "staging", description: "pre-production" },
          ],
        },
      ],
    });
    expect((await t.call("GET", "servers")).body.data).toEqual({
      servers: [
        { uuid: "srvbbbbbbbbbbbbbbbbbbbbb", name: "build-1", description: "builds", ip: "203.0.113.11", isFunctional: false },
        { uuid: SERVER, name: "prod-1", description: null, ip: "203.0.113.10", isFunctional: true },
      ],
    });
  });
});

describe("routing", () => {
  it("405s a method a path does not take, 404s an unknown path", async () => {
    const t = setup();
    expect((await t.call("POST", "")).status).toBe(405);
    expect((await t.call("DELETE", "projects")).status).toBe(405);
    expect((await t.call("PATCH", "team")).status).toBe(405);
    expect((await t.call("GET", "team/bulk")).status).toBe(405);
    expect((await t.call("GET", "team/1/lock")).status).toBe(405);
    expect((await t.call("POST", "team/1")).status).toBe(405);
    for (const path of ["nope", "project", "team/abc", "team/0", "team/1/unlock", "team/1/lock/now", `project/${PROJECT}/abc`, "projects/extra", `server/${SERVER}/1/lock/x`, "canvas"]) {
      expect((await t.call("GET", path)).status).toBe(404);
    }
    expect(t.asked).toEqual([]);
  });

  it("401s without an actor and 404s an org id that does not parse", async () => {
    const t = setup();
    expect((await route(new Request(BASE), t.env)).status).toBe(401);
    expect((await route(new Request(`${BASE}/team/1/lock`, { method: "POST" }), t.env)).status).toBe(401);
    expect((await route(new Request(`${BASE}/project/${PROJECT}/1/lock`, { method: "POST" }), t.env)).status).toBe(401);
    expect((await route(new Request(BASE.replace(ORG, "nope"), { headers: { "x-actor-subject-id": "usr_1", "x-actor-subject-type": "user" } }), t.env)).status).toBe(404);
    // Five segments below the collection is no route.
    expect((await route(new Request(`${BASE}/project/${PROJECT}/1/lock/x`, { method: "POST" }), t.env)).status).toBe(404);
  });
});
