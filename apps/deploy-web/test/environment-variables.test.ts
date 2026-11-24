import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeFilterText,
  applySuggestion,
  buildWarning,
  hasEdgeSpace,
  isManagedKey,
  pageOf,
  suggestionsFor,
  toggleVariableFilter,
  visibleVariables,
  type EnvironmentVariableRow,
  type ListQuery,
} from "../src/lib/environment-variables.ts";

const row = (key: string, over: Partial<EnvironmentVariableRow> = {}): EnvironmentVariableRow => ({
  uuid: `${over.scope ?? "production"}-${key}`, key, comment: null, scope: "production", order: null, isMultiline: false, isLiteral: false, isRuntime: true, isBuildtime: true,
  isRequired: false, isShownOnce: false, isShared: false, isMagic: false, isMissingRequired: false, ...over,
});
const ALL: ListQuery = { search: "", filters: [], environment: "all", sort: "default" };
const keys = (rows: EnvironmentVariableRow[], query: Partial<ListQuery> = {}) => visibleVariables(rows, { ...ALL, ...query }).map((r) => `${r.scope === "preview" ? "p:" : ""}${r.key}`);

// The server's default order: required and empty, managed, then the rest; production before preview.
const ROWS = [
  row("NEEDED", { isMissingRequired: true, isRequired: true }),
  row("SERVICE_URL_APP", { isMagic: true }),
  row("ZED", { isLiteral: true }),
  row("alpha", { isBuildtime: false }),
  row("Beta", { isMultiline: true, isRuntime: false }),
  row("ZED", { scope: "preview" }),
  row("ALPHA", { scope: "preview" }),
];

test("the list's search: the key contains the term, whatever its case", () => {
  assert.deepEqual(keys(ROWS, { search: " ze " }), ["ZED", "p:ZED"]);
  assert.deepEqual(keys(ROWS, { search: "ALPHA" }), ["alpha", "p:ALPHA"]);
  assert.deepEqual(keys(ROWS, { search: "nothing" }), []);
});

test("the list's filters: managed or user-defined, the flags, and the environment", () => {
  assert.deepEqual(keys(ROWS, { filters: ["managed"] }), ["SERVICE_URL_APP"]);
  assert.deepEqual(keys(ROWS, { filters: ["user"], environment: "production" }), ["NEEDED", "ZED", "alpha", "Beta"]);
  assert.deepEqual(keys(ROWS, { filters: ["literal"] }), ["ZED"]);
  assert.deepEqual(keys(ROWS, { filters: ["multiline"] }), ["Beta"]);
  assert.deepEqual(keys(ROWS, { filters: ["buildtime", "runtime"], environment: "production" }), ["NEEDED", "SERVICE_URL_APP", "ZED"]);
  assert.deepEqual(keys(ROWS, { environment: "preview" }), ["p:ZED", "p:ALPHA"]);
  // SQL's LIKE: the underscore is any one character.
  assert.deepEqual(["SERVICE_FQDN_X", "SERVICE.NAME", "SERVICEURL", "MY_SERVICE_URL"].map(isManagedKey), [true, true, false, false]);
});

test("the table sort: by name within the leading groups, production before preview", () => {
  assert.deepEqual(keys(ROWS), ["NEEDED", "SERVICE_URL_APP", "ZED", "alpha", "Beta", "p:ZED", "p:ALPHA"]);
  assert.deepEqual(keys(ROWS, { sort: "name_asc" }), ["NEEDED", "SERVICE_URL_APP", "Beta", "ZED", "alpha", "p:ALPHA", "p:ZED"]);
  assert.deepEqual(keys(ROWS, { sort: "name_desc" }), ["NEEDED", "SERVICE_URL_APP", "alpha", "ZED", "Beta", "p:ZED", "p:ALPHA"]);
});

test("toggling a filter: Managed and User-defined exclude each other", () => {
  assert.deepEqual(toggleVariableFilter([], "managed"), ["managed"]);
  assert.deepEqual(toggleVariableFilter(["managed", "literal"], "user"), ["literal", "user"]);
  assert.deepEqual(toggleVariableFilter(["user"], "managed"), ["managed"]);
  assert.deepEqual(toggleVariableFilter(["literal", "runtime"], "literal"), ["runtime"]);
  assert.equal(activeFilterText(["user", "buildtime"], "all"), "User-defined, Buildtime");
  assert.equal(activeFilterText(["literal"], "preview"), "Literal, Preview");
  assert.equal(activeFilterText([], "production"), "Production");
  assert.equal(activeFilterText([], "all"), "");
});

test("paging: the page stays in range and counts from–to of total", () => {
  const rows = Array.from({ length: 23 }, (_, i) => i);
  assert.deepEqual(pageOf(rows, 1, 10), { rows: rows.slice(0, 10), page: 1, lastPage: 3, from: 1, to: 10 });
  assert.deepEqual(pageOf(rows, 3, 10), { rows: [20, 21, 22], page: 3, lastPage: 3, from: 21, to: 23 });
  assert.deepEqual(pageOf(rows, 9, 10).page, 3);
  assert.deepEqual(pageOf([], 2, 10), { rows: [], page: 1, lastPage: 1, from: 0, to: 0 });
});

test("the build warning: a build-time variable with a known problematic value", () => {
  assert.deepEqual(buildWarning("NODE_ENV", "Production", true), {
    issue: "Skips devDependencies installation which are often required for building (webpack, typescript, etc.)",
    recommendation: 'Recommendation: Uncheck "Available at Buildtime" or use "development" during build',
  });
  assert.equal(buildWarning("NODE_ENV", "production", false), null);
  assert.equal(buildWarning("NODE_ENV", "development", true), null);
  assert.equal(buildWarning("CI", "1", true)?.recommendation, "Recommendation: Usually beneficial for builds, but be aware of behavior changes");
  // No problematic values listed: never warned about in the form.
  assert.equal(buildWarning("DJANGO_SETTINGS_MODULE", "app.settings.production", true), null);
  assert.equal(buildWarning("toString", "x", true), null);
  assert.equal(buildWarning("", "production", true), null);
});

test("the value field's suggestions after '{{': scopes that have variables, then a scope's variables", () => {
  const available = { team: ["TOKEN", "API_URL"], project: [], environment: ["DB_URL"], server: [] };
  const at = (value: string) => suggestionsFor(value, value.length, available);
  assert.deepEqual(at("{{").suggestions.map((s) => s.display), ["team", "environment"]);
  assert.deepEqual(at("x {{ te").suggestions, [{ type: "scope", value: "team", display: "team" }]);
  assert.deepEqual(at("{{ team.").suggestions.map((s) => s.display), ["team.TOKEN", "team.API_URL"]);
  assert.deepEqual(at("{{team.url"), { show: true, suggestions: [{ type: "variable", value: "API_URL", display: "team.API_URL" }], currentScope: "team" });
  assert.equal(at("{{team.nothing").show, false);
  // A scope without variables is not offered; neither is anything once the reference is closed or the brace is tripled.
  assert.equal(at("{{project.").show, false);
  assert.equal(at("{{team.TOKEN}} and").show, false);
  assert.equal(at("{{{").show, false);
  assert.equal(at("plain").show, false);
  assert.equal(suggestionsFor("{{", 2, { team: [], project: [], environment: [], server: [] }).show, false);
  // Only what is before the cursor counts.
  assert.equal(suggestionsFor("ab {{team.", 2, available).show, false);
});

test("choosing a suggestion writes '{{ scope.' and then '{{ scope.KEY }}'", () => {
  const scope = applySuggestion("a {{te tail", 6, { type: "scope", value: "team", display: "team" });
  assert.deepEqual(scope, { value: "a {{ team. tail", cursor: 10, done: false });
  const variable = applySuggestion(scope.value, scope.cursor, { type: "variable", value: "TOKEN", display: "team.TOKEN" });
  assert.deepEqual(variable, { value: "a {{ team.TOKEN }} tail", cursor: 18, done: true });
  assert.equal(variable.value.slice(0, variable.cursor), "a {{ team.TOKEN }}");
});

test("a value with edge whitespace is pointed out", () => {
  assert.deepEqual([" a", "a ", "a\t", "a b", ""].map(hasEdgeSpace), [true, true, true, false, false]);
});
