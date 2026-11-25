// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/Configuration.php and
// resources/views/livewire/project/application/configuration.blade.php (Apache-2.0), modified.
//
// What the configuration pages below General share (Domains, Advanced,
// Healthcheck, Resource Limits): the page's data from
// /applications/{uuid}/{section} — the application for the frame and the
// section's own data — and its PATCH, whose answer keeps the details of a
// refusal (a domain conflict, an unknown port).
import { useCallback, useEffect, useState } from "react";
import { useSignedIn } from "../layout/Layout";
import { edgeBase, getJson, sessionToken } from "../lib/api";
import { environmentPath, environmentUuidFromPath, limit, projectUuidFromPath } from "./ProjectChrome";
import { applicationsApi, applicationUuidFromPath, type ApplicationInfo } from "./ApplicationChrome";

/** What every section's GET answers beside its own data. */
export interface ApplicationSectionData {
  application: ApplicationInfo;
  canUpdate: boolean;
  canDeploy: boolean;
}

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
  const { me } = useSignedIn();
  const projectUuid = projectUuidFromPath();
  const environmentUuid = environmentUuidFromPath();
  const uuid = applicationUuidFromPath();
  const base = `${applicationsApi(me.team?.id)}/${encodeURIComponent(uuid)}/${section}`;
  const [data, setData] = useState<D | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const r = await getJson<D>(base);
    if (!r.data) {
      if (r.status === 404) window.location.replace(environmentPath(projectUuid, environmentUuid));
      return;
    }
    if (r.data.application.project.uuid !== projectUuid || r.data.application.environment.uuid !== environmentUuid) return window.location.replace("/projects");
    setData(r.data);
  }, [base, projectUuid, environmentUuid]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (data) document.title = `${limit(data.application.name, 10)} > Configuration | Freeploy`;
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
