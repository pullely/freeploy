// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Settings/Updates.php, app/Livewire/Upgrade.php,
// app/Models/InstanceSettings.php (switchUpdateChannel) and Laravel's validation messages (lang/en/validation.php)
// (Apache-2.0 / MIT), modified.
//
// Settings\Updates as plain operations on the platform's row 0 (DP-101). The state is the component's: its
// properties (the columns' names), loaded from the row and overridden by what the page sends. Every rule and
// message is Coolify's.
//
// Freeploy has no server 0 (DP-79: it runs on no host of its own), so, as on Coolify Cloud, instantSave()
// syncs no REGISTRY_URL into a .env and submit() writes no dynamic proxy configuration. The Docker registry
// is the deployment's configuration (DP-79) and is not here. A changed channel does not run
// CheckForUpdatesJob (it answers false on Coolify Cloud too). "Check now" and "Upgrade now" answer 501.
import { validateCronExpressionStrict } from "../helpers/cron.js";
import { NULLABLE, R, SettingsError, isTrue, validate, type Props, type Rule, type RuleList } from "../notifications/settings.js";

export const UPDATES_MESSAGES = {
  saved: "Settings updated!",
  invalidAutoUpdateFrequency: "Invalid Cron / Human expression for Auto Update Frequency.",
  invalidUpdateCheckFrequency: "Invalid Cron / Human expression for Update Check Frequency.",
  /** checkManually(): CheckForUpdatesJob fetches versions.json for an installed instance; Freeploy is not one. */
  checkNotAvailable: "Checking for updates is not available yet: Freeploy is not an installed instance, and a merge to main deploys it.",
  /** Upgrade::upgrade(): UpdateCoolify runs the upgrade script on server 0. */
  upgradeNeedsExecutor: "Upgrading the instance needs the SSH executor, which is not available yet.",
};

export const UPDATE_CHANNELS = ["stable", "preview", "nightly", "custom"] as const;

/** The page's properties: the columns' names. */
export const UPDATES_PROPS = ["auto_update_frequency", "update_check_frequency", "is_auto_update_enabled", "update_channel", "update_custom_tag"] as const;

/** Laravel's `regex:/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/`: ":attribute field format is invalid." */
const tagFormat = (): Rule => ({ check: (v, _s, p) => (typeof v === "string" && /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(v) ? null : `The ${p.replace(/_/g, " ")} field format is invalid.`) });
/** `required_if:update_channel,custom`. */
const requiredIfCustom = (): Rule => ({
  implicit: true,
  check: (v, s, p) => (s.update_channel === "custom" && (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) ? `The ${p.replace(/_/g, " ")} field is required when update channel is custom.` : null),
});

/** The component's #[Validate] rules (docker_registry_url: not ported). */
function propertyRules(): Record<string, RuleList> {
  return {
    auto_update_frequency: [R.string()],
    update_check_frequency: [R.string(), R.required()],
    is_auto_update_enabled: [R.boolean()],
    update_channel: [R.required(), R.string(), R.in([...UPDATE_CHANNELS])],
    update_custom_tag: [NULLABLE, requiredIfCustom(), R.string(), R.maxString(128), tagFormat()],
  };
}

/** instantSave()'s validate([...]) of the channel and tag. */
function channelRules(): Record<string, RuleList> {
  const { update_channel, update_custom_tag } = propertyRules();
  return { update_channel: update_channel!, update_custom_tag: update_custom_tag! };
}

export interface UpdatesStore {
  load(): Promise<Props>;
  save(changes: Props): Promise<Props>;
}

/** InstanceSettings::switchUpdateChannel(): the channel, and the channel the instance keeps following after a switch to a more stable one. */
export function switchUpdateChannel(row: Props, channel: string): { update_channel: string; previous_update_channel: string | null } {
  const from = row.update_channel as string;
  const followed = (row.previous_update_channel as string | null) ?? null;
  if (channel === from) return { update_channel: channel, previous_update_channel: followed };
  const channels = ["stable", "preview", "nightly"];
  const fromRank = channels.indexOf(from);
  const toRank = channels.indexOf(channel);
  let previous: string | null;
  if (fromRank < 0 || toRank < 0 || toRank >= fromRank) previous = null;
  else if (followed !== null && channels.indexOf(followed) > fromRank) previous = followed;
  else previous = from;
  return { update_channel: channel, previous_update_channel: previous };
}

/** The page's view: its properties, and Upgrade's isUpgradeAvailable (only a custom image with a tag; no version check runs). */
export function updatesView(row: Props): Props {
  const props: Props = {};
  for (const p of UPDATES_PROPS) props[p] = row[p] ?? null;
  props.docker_registry_url = null;
  const custom = row.update_channel === "custom" && typeof row.update_custom_tag === "string" && row.update_custom_tag !== "";
  props.isUpgradeAvailable = custom;
  props.latestVersion = custom ? row.update_custom_tag : null;
  return props;
}

const blankToNull = (v: unknown) => (typeof v === "string" && v === "" ? null : v);

export type UpdatesAction = "instantSave" | "submit" | "checkManually" | "upgrade";
export const isUpdatesAction = (a: unknown): a is UpdatesAction => a === "instantSave" || a === "submit" || a === "checkManually" || a === "upgrade";

/**
 * One of the page's actions with its state (`body`). Answers the saved row and the toast; throws ValidationFailed
 * (the fields' messages) or SettingsError (an error toast, or a 501 that stored nothing).
 */
export async function runUpdatesAction(store: UpdatesStore, action: UpdatesAction, body: Props): Promise<{ row: Props; message: string }> {
  const row = await store.load();
  const state: Props = {};
  for (const p of UPDATES_PROPS) state[p] = p in body ? blankToNull(body[p]) : row[p];
  // A string property Livewire holds as "" when the input is empty.
  if (state.auto_update_frequency === null) state.auto_update_frequency = "";
  if (state.update_check_frequency === null) state.update_check_frequency = "";

  const instantSave = async () => {
    // `$this->settings->is_auto_update_enabled === true`: the saved value, not the page's.
    if (row.is_auto_update_enabled === true) {
      validate(state, { auto_update_frequency: [R.required(), R.string()] });
    }
    validate(state, channelRules());
    const changes: Props = {
      auto_update_frequency: state.auto_update_frequency,
      update_check_frequency: state.update_check_frequency,
      is_auto_update_enabled: isTrue(state.is_auto_update_enabled),
      ...switchUpdateChannel(row, String(state.update_channel)),
      update_custom_tag: state.update_custom_tag ?? null,
    };
    for (const k of Object.keys(changes)) if (Object.is(changes[k], row[k])) delete changes[k];
    const saved = Object.keys(changes).length ? await store.save(changes) : row;
    return { row: saved, message: UPDATES_MESSAGES.saved };
  };

  switch (action) {
    case "instantSave":
      return instantSave();
    case "submit":
      validate(state, propertyRules());
      if (isTrue(state.is_auto_update_enabled) && !validateCronExpressionStrict(state.auto_update_frequency)) throw new SettingsError(UPDATES_MESSAGES.invalidAutoUpdateFrequency);
      if (!validateCronExpressionStrict(state.update_check_frequency)) throw new SettingsError(UPDATES_MESSAGES.invalidUpdateCheckFrequency);
      return instantSave();
    case "checkManually":
      throw new SettingsError(UPDATES_MESSAGES.checkNotAvailable, 501);
    case "upgrade":
      throw new SettingsError(UPDATES_MESSAGES.upgradeNeedsExecutor, 501);
  }
}
