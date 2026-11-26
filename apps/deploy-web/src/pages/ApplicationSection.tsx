// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Configuration.php and
// resources/views/livewire/project/application/configuration.blade.php (Apache-2.0), modified.
//
// What the configuration pages below General share (Domains, Advanced,
// Healthcheck, Resource Limits, …): the page's data from
// /applications/{uuid}/{section} — or, for a page Coolify shares with a
// standalone database (its components take `:resource`), from
// /databases/{uuid}/{section} — the resource for the frame and the section's
// own data, and its PATCH, whose answer keeps the details of a refusal (a
// domain conflict, an unknown port).
import { useCallback, useEffect, useState } from "react";
import { useSignedIn } from "../layout/Layout";
import { edgeBase, getJson, sessionToken } from "../lib/api";
import { environmentPath, environmentUuidFromPath, limit, projectUuidFromPath } from "./ProjectChrome";
import { applicationsApi, applicationUuidFromPath, type ApplicationInfo } from "./ApplicationChrome";
import { databasesApi, databaseUuidFromPath, type DatabaseInfo } from "./DatabaseChrome";
import { serviceApi, type ServiceInfo } from "./ServiceChrome";
import { serviceUuidFromPath } from "../lib/service-templates";

/** What every section's GET answers beside its own data. */
export interface ApplicationSectionData {
  application: ApplicationInfo;
  canUpdate: boolean;
  canDeploy: boolean;
}

/** The resources whose configuration pages share Coolify's components. */
export type ResourceKind = "application" | "database" | "service";

/** What a database's section GET answers beside its own data. */
export interface DatabaseSectionData {
  database: DatabaseInfo;
  canUpdate: boolean;
  canManage: boolean;
  canDelete: boolean;
}

/** What a service's section GET answers beside its own data (DP-66). */
export interface ServiceSectionData {
  service: ServiceInfo;
  canUpdate: boolean;
  canManage: boolean;
  canDelete: boolean;
}

export type ResourceSectionData = ApplicationSectionData | DatabaseSectionData | ServiceSectionData;

/** The resource of a section's answer: what both kinds have (uuid, name, project, environment, destination, server). */
export const resourceFrame = (data: ResourceSectionData): ApplicationInfo | DatabaseInfo | ServiceInfo => ("application" in data ? data.application : "database" in data ? data.database : data.service);

/** The API base of one resource: /applications/{uuid} or /databases/{uuid}. */
export const resourceApi = (kind: ResourceKind, orgId: string | undefined, uuid: string): string =>
  kind === "service" ? serviceApi(orgId, uuid) : `${kind === "application" ? applicationsApi(orgId) : databasesApi(orgId)}/${encodeURIComponent(uuid)}`;

/** The resource's uuid from its page's path (…/application/{uuid}/… or …/database/{uuid}/…). */
export const resourceUuidFromPath = (kind: ResourceKind): string => (kind === "application" ? applicationUuidFromPath() : kind === "database" ? databaseUuidFromPath() : serviceUuidFromPath());

export interface PatchError {
  status: number;
  /** The error's own message (a toast). */
  message: string;
  /** Laravel's messages per field, when the answer is a validation error. */
  fields: Record<string, string[]>;
  /** Every field message, in order ($errors->all()). */
  messages: string[];
  details: Record<string, unknown>;
}

export type PatchResult<T> = { ok: true; data: T } | { ok: false; error: PatchError };

/** PATCH JSON to the edge, keeping the error's details. */
async function patchJson<T>(path: string, body: unknown): Promise<PatchResult<T>> {
  const token = sessionToken();
  let res: Response;
  try {
    res = await fetch(edgeBase() + path, { method: "PATCH", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, error: { status: 0, message: "Network error. Please try again.", fields: {}, messages: [], details: {} } };
  }
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string; details?: Record<string, unknown> } } | null;
  if (res.ok && json?.data !== undefined) return { ok: true, data: json.data };
  const details = json?.error?.details ?? {};
  const fields = (details.fields as Record<string, string[]> | undefined) ?? {};
  return { ok: false, error: { status: res.status, message: json?.error?.message ?? "Something went wrong.", fields, messages: Object.values(fields).flat(), details } };
}

/** The first message of each field, for the inputs. */
export function inlineErrors(error: PatchError): Record<string, string> {
  const inline: Record<string, string> = {};
  for (const [field, messages] of Object.entries(error.fields)) if (messages[0]) inline[field] = messages[0];
  return inline;
}

/**
 * One configuration page of an application. Configuration::mount(): the
 * application through its project and environment, or back to the
 * environment; the title is Configuration's for every page.
 */
export function useApplicationSection<D extends ApplicationSectionData>(section: string) {
  return useResourceSection<D>("application", section);
}

/**
 * One configuration page of an application or a standalone database: the
 * application's or the database's Configuration::mount() — the resource
 * through its project and environment, or back to the environment; the title
 * is Configuration's for every page.
 */
export function useResourceSection<D extends ResourceSectionData>(kind: ResourceKind, section: string) {
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const uuid = resourceUuidFromPath(kind);
  // An empty section is the resource's own GET (a database's Servers page, DP-97).
  const base = section ? `${resourceApi(kind, me.team?.id, uuid)}/${section}` : resourceApi(kind, me.team?.id, uuid);
  const [data, setData] = useState<D | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const r = await getJson<D>(base);
    if (!r.data) {
      if (r.status === 404) window.location.replace(environmentPath(projectUuid, environmentUuid));
      return;
    }
    const frame = resourceFrame(r.data);
    if (frame.project.uuid !== projectUuid || frame.environment.uuid !== environmentUuid) return window.location.replace("/projects");
    setData(r.data);
  }, [base, projectUuid, environmentUuid]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (data) document.title = `${limit(resourceFrame(data).name, 10)} > Configuration | Freeploy`;
  }, [data]);

  const patch = useCallback(
    async <T,>(body: Record<string, unknown>): Promise<PatchResult<T>> => {
      setSaving(true);
      const r = await patchJson<T>(base, body);
      setSaving(false);
      return r;
    },
    [base],
  );
  return { me, data, setData, saving, patch, reload: load };
}

/** A boolean listbox's value. */
export const yesNo = (v: boolean): string => (v ? "true" : "false");
