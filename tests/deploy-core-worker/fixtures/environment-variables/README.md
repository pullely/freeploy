# Environment variable fixtures (DP-51)

What Coolify's own PHP answers, for `src/environment-variables.test.ts`.

- `expected.json` — made by `generate.php` from the source of
  coollabsio/coolify@91b7e3e, run with PHP 8.3.6:

  ```
  php generate.php /path/to/coolify > expected.json
  ```

  The script does not load Laravel. It copies these functions out of the
  Coolify checkout as text and runs them unchanged:
  `parseEnvFormatToArray()`, `formatEnvValueForDevView()`,
  `formatEnvVariableForDevView()` and `parseEnvDevView()` from
  `bootstrap/helpers/shared.php`, `EnvironmentVariable::withoutEdgeLineBreaks()`
  from `app/Models/EnvironmentVariable.php`, and the constants
  `SHARED_VARIABLE_TYPES` and `SHARED_VARIABLE_REFERENCE_PATTERN` from
  `bootstrap/helpers/constants.php`. The two model classes the helpers name in
  their signatures are stubs with `DEV_VIEW_FLAG_DEFAULTS` as the models define
  it. The inputs are in the script.

  Per function, a list of cases with the input and what PHP returned (or the
  message of the `InvalidArgumentException` it threw):
  `sharedVariableReferences` is `preg_match_all()` with the pattern, as
  `EnvironmentVariable::sharedVariableReferences()` calls it, and
  `isSharedReference` is the expression of `EnvironmentVariable::isSharedReference()`.
  PHP arrays keep their order and JSON objects need not, so a parsed text is a
  list of `{ key, value, comment[, settings] }`; PHP writes an empty `settings`
  array as `[]`.

Not from PHP, because they need Laravel: `Str::trim()` behind the key
normalization, and the validator's messages. The tests state those by hand.
