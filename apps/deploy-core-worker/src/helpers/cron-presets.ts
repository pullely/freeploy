// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/constants.php (VALID_CRON_STRINGS) and
// bootstrap/helpers/shared.php (translate_cron_expression) (Apache-2.0), modified.
//
// The schedule words Coolify accepts in place of a cron expression. Kept apart from the
// validators so helpers/cron.ts and servers/settings-validation.ts can both use them without
// importing each other.

/** VALID_CRON_STRINGS */
export const VALID_CRON_STRINGS: Readonly<Record<string, string>> = {
  every_minute: "* * * * *",
  hourly: "0 * * * *",
  daily: "0 0 * * *",
  weekly: "0 0 * * 0",
  monthly: "0 0 1 * *",
  yearly: "0 0 1 1 *",
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
};

/** translate_cron_expression(): a preset becomes its expression. */
export function translateCronExpression(expression: string): string {
  return VALID_CRON_STRINGS[expression] ?? expression;
}
