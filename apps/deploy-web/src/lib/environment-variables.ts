// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Shared/EnvironmentVariable/All.php (the search,
// the filters, the table sort, the paging), app/Traits/EnvironmentVariableAnalyzer.php,
// resources/views/components/environment-variable-warning.blade.php and
// resources/views/components/forms/env-var-input.blade.php (handleInput, selectSuggestion) (Apache-2.0), modified.
//
// What the Environment Variables page works out in the browser: which rows
// the search and the filters leave, in which order, the build warning under a
// value, and the "{{" suggestions of the value field. Coolify asks the server
// for each page of the list; here the whole list is loaded once and these
// functions do the rest.

export interface EnvironmentVariableRow {
  uuid: string;
  key: string;
  comment: string | null;
  scope: "production" | "preview";
  order: number | null;
  isMultiline: boolean;
  isLiteral: boolean;
  isRuntime: boolean;
  isBuildtime: boolean;
  isRequired: boolean;
  isShownOnce: boolean;
  isShared: boolean;
  isMagic: boolean;
  isMissingRequired: boolean;
}

export const VARIABLE_FILTERS = ["managed", "user", "buildtime", "runtime", "multiline", "literal"] as const;
export type VariableFilter = (typeof VARIABLE_FILTERS)[number];
export const FILTER_LABELS: Record<VariableFilter, string> = {
  managed: "Managed",
  user: "User-defined",
  buildtime: "Buildtime",
  runtime: "Runtime",
  multiline: "Multiline",
  literal: "Literal",
};

export type EnvironmentFilter = "all" | "production" | "preview";
export const ENVIRONMENT_FILTERS: Array<[EnvironmentFilter, string]> = [
  ["all", "All environments"],
  ["production", "Production"],
  ["preview", "Preview"],
];

export type TableSort = "default" | "name_asc" | "name_desc";
export const TABLE_SORTS: Array<[TableSort, string]> = [
  ["default", "Default order"],
  ["name_asc", "Name A–Z"],
  ["name_desc", "Name Z–A"],
];

/** All::toggleVariableFilter(): a filter toggles; Managed and User-defined exclude each other. */
export function toggleVariableFilter(filters: VariableFilter[], filter: VariableFilter): VariableFilter[] {
  if (filters.includes(filter)) return filters.filter((f) => f !== filter);
  const other = filter === "managed" ? "user" : filter === "user" ? "managed" : null;
  return [...filters.filter((f) => f !== other), filter];
}

/** The filter button's text: the active filters' labels, then the environment (Str::headline). */
export function activeFilterText(filters: VariableFilter[], environment: EnvironmentFilter): string {
  const labels = filters.map((f) => FILTER_LABELS[f]);
  if (environment !== "all") labels.push(environment === "preview" ? "Preview" : "Production");
  return labels.join(", ");
}

/** SQL's key LIKE 'SERVICE_FQDN%' OR … ("_" is any one character): what the list calls managed. */
export const isManagedKey = (key: string): boolean => /^SERVICE.(?:FQDN|URL|NAME)/s.test(key);

const FLAG_OF = { buildtime: "isBuildtime", runtime: "isRuntime", multiline: "isMultiline", literal: "isLiteral" } as const;

export interface ListQuery {
  search: string;
  filters: VariableFilter[];
  environment: EnvironmentFilter;
  sort: TableSort;
}

/**
 * All::managedEnvironmentVariablesQuery() over the loaded rows: the search
 * (the key contains the term, whatever its case), the filters, and the sort —
 * by name within the list's two leading groups (required and empty, then
 * managed), production before preview. The rows come in the default order.
 */
export function visibleVariables<T extends EnvironmentVariableRow>(rows: T[], query: ListQuery): T[] {
  const term = query.search.trim().toLowerCase();
  const kept = rows.filter((row) => {
    if (query.environment !== "all" && row.scope !== query.environment) return false;
    if (term !== "" && !row.key.toLowerCase().includes(term)) return false;
    if (query.filters.includes("managed") && !isManagedKey(row.key)) return false;
    if (query.filters.includes("user") && isManagedKey(row.key)) return false;
    for (const filter of ["buildtime", "runtime", "multiline", "literal"] as const) if (query.filters.includes(filter) && !row[FLAG_OF[filter]]) return false;
    return true;
  });
  if (query.sort === "default") return kept;
  const direction = query.sort === "name_desc" ? -1 : 1;
  const rank = (row: T) => (row.scope === "preview" ? 4 : 0) + (row.isMissingRequired ? 0 : 2) + (isManagedKey(row.key) ? 0 : 1);
  return [...kept].sort((a, b) => rank(a) - rank(b) || direction * (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The table's paging: the page in range, its rows, and "from–to of total". */
export function pageOf<T>(rows: T[], page: number, perPage: number): { rows: T[]; page: number; lastPage: number; from: number; to: number } {
  const lastPage = Math.max(1, Math.ceil(rows.length / perPage));
  const current = Math.max(1, Math.min(page, lastPage));
  const start = (current - 1) * perPage;
  return { rows: rows.slice(start, start + perPage), page: current, lastPage, from: rows.length === 0 ? 0 : start + 1, to: Math.min(current * perPage, rows.length) };
}

interface ProblematicVariable {
  problematicValues: string[];
  affects: string;
  issue: string;
  recommendation: string;
}

/** EnvironmentVariableAnalyzer::getProblematicBuildVariables(): variables that commonly break a build when set to production values. */
export const PROBLEMATIC_BUILD_VARIABLES: Record<string, ProblematicVariable> = {
  NODE_ENV: {
    problematicValues: ["production", "prod"],
    affects: "Node.js/npm/yarn/bun/pnpm",
    issue: "Skips devDependencies installation which are often required for building (webpack, typescript, etc.)",
    recommendation: 'Uncheck "Available at Buildtime" or use "development" during build',
  },
  NPM_CONFIG_PRODUCTION: { problematicValues: ["true", "1", "yes"], affects: "npm/pnpm", issue: "Forces npm to skip devDependencies", recommendation: "Remove from build-time variables or set to false" },
  YARN_PRODUCTION: { problematicValues: ["true", "1", "yes"], affects: "Yarn/pnpm", issue: "Forces yarn to skip devDependencies", recommendation: "Remove from build-time variables or set to false" },
  COMPOSER_NO_DEV: {
    problematicValues: ["1", "true", "yes"],
    affects: "PHP/Composer",
    issue: "Skips require-dev packages which may include build tools",
    recommendation: 'Set as "Runtime only" or remove from build-time variables',
  },
  MIX_ENV: {
    problematicValues: ["prod", "production"],
    affects: "Elixir/Phoenix",
    issue: "Production mode may skip development dependencies needed for compilation",
    recommendation: 'Use "dev" for build or set as "Runtime only"',
  },
  RAILS_ENV: { problematicValues: ["production"], affects: "Ruby on Rails", issue: "May affect asset precompilation and dependency handling", recommendation: 'Consider using "development" for build phase' },
  RACK_ENV: { problematicValues: ["production"], affects: "Ruby/Rack", issue: "May affect dependency handling and build behavior", recommendation: 'Consider using "development" for build phase' },
  BUNDLE_WITHOUT: {
    problematicValues: ["development", "test", "development:test"],
    affects: "Ruby/Bundler",
    issue: "Excludes gem groups that may contain build dependencies",
    recommendation: "Remove from build-time variables or adjust groups",
  },
  FLASK_ENV: {
    problematicValues: ["production"],
    affects: "Python/Flask",
    issue: "May affect debug mode and development tools availability",
    recommendation: 'Usually safe, but consider "development" for complex builds',
  },
  DJANGO_SETTINGS_MODULE: {
    problematicValues: [],
    affects: "Python/Django",
    issue: "Production settings may disable debug tools needed during build",
    recommendation: "Use development settings for build phase",
  },
  APP_ENV: {
    problematicValues: ["production", "prod"],
    affects: "Laravel/Symfony",
    issue: "May affect dependency installation and build optimizations",
    recommendation: 'Consider using "local" or "development" for build',
  },
  ASPNETCORE_ENVIRONMENT: {
    problematicValues: ["Production"],
    affects: ".NET/ASP.NET Core",
    issue: "May affect build-time configurations and optimizations",
    recommendation: "Usually safe, but verify build requirements",
  },
  CI: {
    problematicValues: ["true", "1", "yes"],
    affects: "Various tools",
    issue: "Changes behavior in many tools (disables interactivity, changes caching)",
    recommendation: "Usually beneficial for builds, but be aware of behavior changes",
  },
};

/**
 * <x-environment-variable-warning>: the caution for a build-time variable
 * whose value is one of the known problematic ones (whatever its case).
 */
export function buildWarning(key: string, value: string | null, isBuildtime: boolean): { issue: string; recommendation: string } | null {
  if (!isBuildtime || !key || !Object.hasOwn(PROBLEMATIC_BUILD_VARIABLES, key)) return null;
  const config = PROBLEMATIC_BUILD_VARIABLES[key]!;
  const lower = String(value).toLowerCase();
  if (!config.problematicValues.some((v) => v.toLowerCase() === lower)) return null;
  return { issue: config.issue, recommendation: `Recommendation: ${config.recommendation}` };
}

export const SHARED_SCOPES = ["team", "project", "environment", "server"] as const;
export type SharedScope = (typeof SHARED_SCOPES)[number];
export type AvailableSharedVariables = Record<SharedScope, string[]>;

export interface Suggestion {
  type: "scope" | "variable";
  value: string;
  display: string;
}

export interface SuggestionState {
  show: boolean;
  suggestions: Suggestion[];
  /** The scope typed before the dot, when it has no variables to offer. */
  currentScope: string | null;
}

const HIDDEN: SuggestionState = { show: false, suggestions: [], currentScope: null };

/**
 * handleInput(): after "{{" before the cursor (and no "}}" yet), the scopes
 * that have variables; after "scope.", that scope's variables containing what
 * follows.
 */
export function suggestionsFor(value: string, cursor: number, available: AvailableSharedVariables): SuggestionState {
  const before = value.substring(0, cursor);
  const brace = before.lastIndexOf("{{");
  if (brace === -1) return HIDDEN;
  if (brace > 0 && before[brace - 1] === "{") return HIDDEN;
  const afterBrace = before.substring(brace);
  if (afterBrace.includes("}}")) return HIDDEN;
  const content = afterBrace.substring(2).trim();
  const scopes = SHARED_SCOPES.filter((scope) => available[scope].length > 0);
  const scopeSuggestions = (list: readonly SharedScope[]): Suggestion[] => list.map((scope) => ({ type: "scope", value: scope, display: scope }));
  if (content === "") return scopes.length === 0 ? HIDDEN : { show: true, suggestions: scopeSuggestions(scopes), currentScope: null };
  if (content.includes(".")) {
    const [scope = "", partial = ""] = content.split(".");
    if (!(scopes as string[]).includes(scope)) return HIDDEN;
    const variables = available[scope as SharedScope].filter((name) => name.toLowerCase().includes(partial.toLowerCase()));
    return { show: variables.length > 0, suggestions: variables.map((name) => ({ type: "variable", value: name, display: `${scope}.${name}` })), currentScope: scope };
  }
  const matching = scopes.filter((scope) => scope.includes(content.toLowerCase()));
  return { show: matching.length > 0, suggestions: scopeSuggestions(matching), currentScope: null };
}

/** selectSuggestion(): a scope becomes "{{ scope." and a variable "{{ scope.KEY }}", in place of what was typed since "{{". */
export function applySuggestion(value: string, cursor: number, suggestion: Suggestion): { value: string; cursor: number; done: boolean } {
  const before = value.substring(0, cursor);
  const after = value.substring(cursor);
  const brace = before.lastIndexOf("{{");
  const head = value.substring(0, brace);
  if (suggestion.type === "scope") return { value: `${head}{{ ${suggestion.value}.${after}`, cursor: brace + 3 + suggestion.value.length + 1, done: false };
  return { value: `${head}{{ ${suggestion.display} }}${after}`, cursor: brace + 3 + suggestion.display.length + 3, done: true };
}

/** checkEdgeSpace(): the value starts or ends with whitespace, which is kept. */
export const hasEdgeSpace = (value: string): boolean => /^\s|\s$/.test(value);
