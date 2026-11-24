// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Project/Application/General.php (mount, submit,
// instantSave, resetDefaultLabels) (Apache-2.0), modified.
//
// The container labels and HTTP Basic Authentication of an application's General page, for
// handlers/applications.ts, which owns the routes and the authorization:
//
//   GET    /applications/{uuid}                the application also carries its labels text, the two label
//                                              settings and the authentication fields (General::mount)
//   PATCH  /applications/{uuid}                … and saves them (General::submit): customLabels while labels
//                                              are edited by hand, isContainerLabelEscapeEnabled,
//                                              isContainerLabelReadonlyEnabled, isHttpBasicAuthEnabled,
//                                              httpBasicAuthUsername, httpBasicAuthPassword,
//                                              httpBasicAuthHashAlgorithm, httpBasicAuthBcryptCost,
//                                              httpBasicAuthArgon2idMemoryCost, httpBasicAuthArgon2idTimeCost.
//                                              With instantSave: true it is General::instantSave: only the
//                                              listbox fields, answered with "Settings saved."
//   POST   /applications/{uuid}/labels/reset   General::resetDefaultLabels(true)
import type { SqlExecutor } from "@saas/db/hyperdrive";
import { findApplicationLabelSource, updateApplicationLabels, updateApplicationLabelSettings } from "@saas/db/deploy";
import type { FieldErrors } from "../private-keys/validation.js";
import { ApplicationError, showApplication, type ApplicationContext, type ApplicationShow, type GeneralSaved } from "../applications/service.js";
import {
  LABEL_SERVICE_MESSAGES,
  LabelError,
  assertLabelFields,
  instantSaveLabelFields,
  loadLabelFields,
  resetDefaultLabels,
  saveLabelFields,
  type ApplicationLabelContext,
  type ApplicationLabelFields,
  type ApplicationLabelStore,
} from "../applications/labels-service.js";
import { validateLabelFields, type LabelFieldsInput } from "../applications/labels-validation.js";
import { columnCipher } from "./cloud-tokens.js";

/** The `encrypted` column the Authentication section writes; its cipher is bound to this name. */
export const HTTP_BASIC_AUTH_PASSWORD_COLUMN = "applications.http_basic_auth_password";

export function labelSqlStore(tx: SqlExecutor): ApplicationLabelStore {
  return {
    findSource: (uuid) => findApplicationLabelSource(tx, uuid),
    updateLabels: (id, changes) => updateApplicationLabels(tx, id, changes),
    updateSettings: (applicationId, changes) => updateApplicationLabelSettings(tx, applicationId, changes),
  };
}

/** One org's label store and password cipher, in the transaction of the applications runner. */
export function labelSqlContext(tx: SqlExecutor, orgId: string, secret: string | undefined): ApplicationLabelContext {
  return { store: labelSqlStore(tx), cipher: columnCipher(tx, orgId, secret, HTTP_BASIC_AUTH_PASSWORD_COLUMN) };
}

export type ApplicationWithLabels = ApplicationShow & Partial<ApplicationLabelFields>;

const merged = (application: ApplicationShow, fields: ApplicationLabelFields | null): ApplicationWithLabels => (fields ? { ...application, ...fields } : application);

/** General's exceptions reach the user as an error toast: a 422 here. */
async function reported<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof LabelError) throw new ApplicationError(e.message, 422);
    throw e;
  }
}

/** Configuration + General::mount(): the application with its label fields. */
export async function showApplicationWithLabels(ctx: ApplicationContext, uuid: string, canUpdate: boolean): Promise<ApplicationWithLabels | null> {
  const application = await showApplication(ctx, uuid, canUpdate);
  if (!application || !ctx.labels) return application;
  return merged(application, await loadLabelFields(ctx.labels, uuid, canUpdate));
}

/** validate() for the label fields of a PATCH body. */
export function validateLabelBody(body: Record<string, unknown>): { input: LabelFieldsInput; errors: FieldErrors } {
  const v = validateLabelFields(body);
  return v.ok ? { input: v.input, errors: {} } : { input: { instantSave: body.instantSave === true }, errors: v.errors };
}

/** Before anything is written: what syncData(toModel: true) refuses. */
export async function assertLabelInput(ctx: ApplicationContext, uuid: string, input: LabelFieldsInput): Promise<void> {
  if (ctx.labels) await reported(() => assertLabelFields(ctx.labels!, uuid, input));
}

/** General::submit(), after the application's other fields: the label fields, and the answer with them. */
export async function saveLabelsAfterGeneral(ctx: ApplicationContext, uuid: string, saved: GeneralSaved | null, input: LabelFieldsInput, before: { portsExposes: string | null }): Promise<(Omit<GeneralSaved, "application"> & { application: ApplicationWithLabels }) | null> {
  if (!saved || !ctx.labels) return saved;
  const fields = await reported(() => saveLabelFields(ctx.labels!, uuid, input, before));
  return { ...saved, application: merged(saved.application, fields) };
}

/** General::instantSave() for a PATCH with instantSave: true. Null when the application is not the org's. */
export async function instantSaveLabels(ctx: ApplicationContext, uuid: string, body: Record<string, unknown>): Promise<{ errors: FieldErrors } | { application: ApplicationWithLabels; message: string; warning: false } | null> {
  const application = await showApplication(ctx, uuid, true);
  if (!application || !ctx.labels) return null;
  const v = validateLabelFields(body);
  if (!v.ok) return { errors: v.errors };
  const labels = ctx.labels;
  const fields = await reported(async () => {
    await assertLabelFields(labels, uuid, v.input);
    return instantSaveLabelFields(labels, uuid, v.input);
  });
  return { application: merged(application, fields), message: LABEL_SERVICE_MESSAGES.settingsSaved, warning: false };
}

/** General::resetDefaultLabels(true). Null when the application is not the org's. */
export async function resetLabels(ctx: ApplicationContext, uuid: string): Promise<{ application: ApplicationWithLabels } | null> {
  const application = await showApplication(ctx, uuid, true);
  if (!application || !ctx.labels) return null;
  return { application: merged(application, await reported(() => resetDefaultLabels(ctx.labels!, uuid))) };
}
