// Derived from coollabsio/coolify@91b7e3e:app/Livewire/SettingsEmail.php, app/Livewire/Concerns/ManagesSmtpServers.php
// (fillSmtpServerSettings), bootstrap/helpers/notifications.php (email_provider_labels, enabled_email_provider) and
// Laravel's validation messages (lang/en/validation.php) (Apache-2.0 / MIT), modified.
//
// SettingsEmail (Transactional Email) as plain operations on the platform's row 0 (DP-101): the instance's email
// provider, which in a hosted Freeploy is its hosted email service. The state is the component's (camelCase
// properties), loaded from the row and overridden by what the page sends. The rules, messages and toasts are
// Coolify's, and so are the SMTP and Resend rules: DP-67's team email page (notifications/settings.ts) holds
// them, and they are reused here.
//
// Not ported, as on DP-67's team page: the named SMTP servers (ManagesSmtpServers' add, switch, rename, delete
// and templates; smtp_servers) — the server in use is the smtp_* columns, which are ported; toggleSmtp(),
// toggleResend(), submitSmtp() and submitResend(), which the page does not call. "Send test" runs Coolify's
// checks, then answers 501 (the hosted email service is not available yet) and stores nothing — Coolify saves
// the page's sender before it sends.
import { hostnameError } from "../servers/ip.js";
import {
  NULLABLE,
  R,
  SettingsError,
  ValidationFailed,
  activeEmailProvider,
  isTrue,
  isBlank,
  propsFromRow,
  snake,
  validate,
  validateResendSettings,
  validateSmtpSettings,
  withMessages,
  type Props,
  type RuleList,
  type SettingsRow,
} from "../notifications/settings.js";
import { INSTANCE_EMAIL_NOT_AVAILABLE } from "../notifications/test-send.js";

export const EMAIL_MESSAGES = {
  saved: "Transactional email settings updated.",
  saveProviderFirst: "Save an email provider first.",
  testNotAvailable: INSTANCE_EMAIL_NOT_AVAILABLE,
};

/** email_provider_labels(). */
export const EMAIL_PROVIDER_LABELS = { none: "None", smtp: "SMTP", resend: "Resend" } as const;

/** The component's #[Validate] rules. */
function propertyRules(): Record<string, RuleList> {
  return {
    smtpEnabled: [R.boolean()],
    smtpFromAddress: [NULLABLE, R.email()],
    smtpFromName: [NULLABLE, R.string()],
    notificationFromAddress: [NULLABLE, R.email()],
    notificationFromName: [NULLABLE, R.string(), R.maxString(255)],
    smtpRecipients: [NULLABLE, R.string()],
    smtpHost: [NULLABLE, R.string()],
    smtpPort: [NULLABLE, R.numeric(), R.minNumeric(1), R.maxNumeric(65535)],
    smtpEncryption: [NULLABLE, R.string(), R.in(["starttls", "tls", "none"])],
    smtpUsername: [NULLABLE, R.string()],
    smtpPassword: [NULLABLE, R.string()],
    smtpTimeout: [NULLABLE, R.numeric()],
    smtpEhloDomain: [NULLABLE, R.string()],
    resendEnabled: [R.boolean()],
    resendApiKey: [NULLABLE, R.string()],
    resendFromAddress: [NULLABLE, R.email()],
    resendFromName: [NULLABLE, R.string()],
    emailProvider: [R.required(), R.in(["none", "smtp", "resend"])],
    testEmailAddress: [NULLABLE, R.email()],
  };
}

/** What syncData(true) writes: smtp_enabled, fillSmtpServerSettings()'s columns, the notification sender, Resend. */
const MODEL_PROPS = [
  "smtpEnabled",
  "smtpFromAddress",
  "smtpFromName",
  "smtpHost",
  "smtpPort",
  "smtpEncryption",
  "smtpUsername",
  "smtpPassword",
  "smtpTimeout",
  "smtpEhloDomain",
  "notificationFromAddress",
  "notificationFromName",
  "resendEnabled",
  "resendApiKey",
  "resendFromAddress",
  "resendFromName",
] as const;

/** The page's fields (and the provider list), as the page may send them. */
const PAGE_PROPS = [...MODEL_PROPS, "emailProvider", "testEmailAddress", "testUsesNotificationSender"];

export interface EmailStore {
  /** Row 0's email columns, decrypted. */
  load(): Promise<SettingsRow>;
  /** save(): the changed columns, plaintext (the store encrypts). Answers the columns as saved, decrypted. */
  save(changes: SettingsRow): Promise<SettingsRow>;
}

/** is_transactional_emails_enabled(): a provider is saved. */
export const transactionalEmailsEnabled = (row: SettingsRow): boolean => activeEmailProvider(row) !== "none";

/** The page's view: the properties (the SMTP password and Resend API key only for who can update), the provider, the test's state. */
export function emailSettingsView(row: SettingsRow, canUpdate: boolean, testEmailAddress: string | null): Props {
  const props: Props = {};
  for (const prop of [...MODEL_PROPS, "smtpServerName"]) props[prop] = row[snake(prop)] ?? null;
  props.smtpPort = row.smtp_port === null || row.smtp_port === undefined ? null : String(row.smtp_port);
  props.smtpTimeout = row.smtp_timeout === null || row.smtp_timeout === undefined ? null : String(row.smtp_timeout);
  if (!canUpdate) {
    props.smtpPassword = null;
    props.resendApiKey = null;
  }
  props.emailProvider = activeEmailProvider(row);
  props.activeEmailProvider = activeEmailProvider(row);
  props.testEmailAddress = testEmailAddress;
  props.sendTestReason = transactionalEmailsEnabled(row) ? null : EMAIL_MESSAGES.saveProviderFirst;
  return props;
}

export type EmailAction = "submit" | "selectEmailProvider" | "sendTestEmail";
export const isPlatformEmailAction = (a: unknown): a is EmailAction => a === "submit" || a === "selectEmailProvider" || a === "sendTestEmail";

/**
 * One of the page's actions with its state (`body`). Answers the saved row and the toast (null: nothing to say,
 * the page only shows the provider's fields); throws ValidationFailed or SettingsError (an error toast, or the
 * test's 501, which stored nothing).
 */
export async function runPlatformEmailAction(store: EmailStore, action: EmailAction, body: Props): Promise<{ row: SettingsRow; message: string | null; saved: boolean }> {
  const row = await store.load();
  const state: Props = { ...propsFromRow(row), emailProvider: activeEmailProvider(row), testEmailAddress: null, testUsesNotificationSender: false };
  state.smtpPort = row.smtp_port === null || row.smtp_port === undefined ? null : String(row.smtp_port);
  state.smtpTimeout = row.smtp_timeout === null || row.smtp_timeout === undefined ? null : String(row.smtp_timeout);
  if (state.smtpEncryption === null || state.smtpEncryption === undefined) state.smtpEncryption = "starttls";
  for (const prop of PAGE_PROPS) if (prop in body) state[prop] = body[prop] === "" ? null : body[prop];

  /** enableSelectedEmailProvider(): the provider of the list on, then its rules; on a failure the saved provider stays on. */
  const enableSelected = () => {
    state.smtpEnabled = state.emailProvider === "smtp";
    state.resendEnabled = state.emailProvider === "resend";
    if (isTrue(state.smtpEnabled)) validateSmtpSettings(state);
    else if (isTrue(state.resendEnabled)) validateResendSettings(state);
  };

  /** submit(): enableSelectedEmailProvider(), then syncData(true) — every rule, the EHLO hostname, every column — and the toast. */
  const submit = async () => {
    enableSelected();
    validate(state, propertyRules());
    const ehlo = state.smtpEhloDomain;
    if (typeof ehlo === "string" && ehlo !== "") {
      const e = hostnameError("smtp ehlo domain", ehlo);
      if (e) throw new ValidationFailed({ smtpEhloDomain: [e] });
    }
    const changes: SettingsRow = {};
    for (const prop of MODEL_PROPS) {
      const column = snake(prop);
      let value = state[prop];
      if (prop === "smtpEnabled" || prop === "resendEnabled") value = isTrue(value);
      if (prop === "smtpPort" || prop === "smtpTimeout") value = isBlank(value) ? null : Math.trunc(Number(value));
      if (!Object.is(row[column], value ?? null)) changes[column] = value ?? null;
    }
    const saved = Object.keys(changes).length ? await store.save(changes) : row;
    return { row: saved, message: EMAIL_MESSAGES.saved, saved: true };
  };

  switch (action) {
    case "submit":
      return submit();
    case "selectEmailProvider":
      try {
        enableSelected();
      } catch (e) {
        // Not complete yet: the page shows the provider's fields and "Not active yet", without an error.
        if (e instanceof ValidationFailed) return { row, message: null, saved: false };
        throw e;
      }
      return submit();
    case "sendTestEmail": {
      const withSender = isTrue(state.testUsesNotificationSender);
      const { rules, names } = withMessages({
        testEmailAddress: [[R.required(), "required"], [R.email(), "email"]],
        notificationFromAddress: withSender ? [[R.required(), "required"], [R.email()]] : [[NULLABLE], [R.email()]],
        notificationFromName: [[NULLABLE], [R.string()], [R.maxString(255)]],
      });
      validate(
        state,
        rules,
        {
          "notificationFromAddress.required": "Notification from address is required to test the notification sender.",
          "testEmailAddress.required": "Test email address is required.",
          "testEmailAddress.email": "Please enter a valid email address.",
        },
        names,
      );
      // The saved provider's rules, with the sender on the page.
      if (row.resend_enabled) validateResendSettings(state);
      else validateSmtpSettings(state);
      // Coolify saves the page's sender and sends the Test email here; nothing is stored or sent.
      throw new SettingsError(EMAIL_MESSAGES.testNotAvailable, 501);
    }
  }
}
