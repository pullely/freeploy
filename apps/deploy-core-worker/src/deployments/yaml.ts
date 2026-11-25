// Derived from symfony/yaml (Dumper.php, Inline.php, Escaper.php; MIT, © Fabien Potencier), modified:
// Yaml::dump($value, 10) — what coollabsio/coolify@91b7e3e's
// ApplicationDeploymentJob::generate_compose_file() calls for the compose file — for the values a PHP array of
// scalars holds. Byte-equal to Symfony's output for the cases of
// tests/deploy-core-worker/fixtures/deployments (yaml.* and every run's compose file).
//
// The dumper itself is ../compose/yaml.ts (DP-59), the one port of Symfony's dumper in this Worker, which the
// service parser's goldens hold to PHP as well; this file keeps the deployment code's value model and hands
// its values over. Symfony's default indentation, 4 spaces, is what the deployment job uses (the service
// parser asks for 2).
//
// PHP tells an int from a float and a list from a map; JavaScript does not. So:
//   - a `number` that is an integer is a PHP int, any other number a PHP float, and PhpFloat is a float whatever
//     its value ((float) "2" dumps as 2.0);
//   - an Array is a PHP list, a Map a PHP array with keys in insertion order (a plain object would reorder
//     integer-like keys). As in PHP, an empty array of either kind dumps as {}, and a Map whose keys are
//     0, 1, 2, … in order is a list.
import { PhpArray, PhpFloat as ComposeFloat, type PhpValue } from "../compose/php.js";
import { dumpYaml } from "../compose/yaml.js";

export class PhpFloat {
  constructor(readonly value: number) {}
}

export type YamlValue = null | boolean | number | string | PhpFloat | YamlValue[] | Map<string, YamlValue>;

/** A Map from [key, value] pairs, for writing a PHP array literal in its order. */
export function ymap(entries: Array<[string, YamlValue]>): Map<string, YamlValue> {
  return new Map(entries);
}

const INDENTATION = 4;

/** The value in the PHP model the dumper works on. */
function phpValue(value: YamlValue): PhpValue {
  if (value instanceof PhpFloat) return new ComposeFloat(value.value);
  if (typeof value === "number") return Number.isInteger(value) ? value : new ComposeFloat(value);
  if (Array.isArray(value)) return PhpArray.list(value.map(phpValue));
  if (value instanceof Map) return PhpArray.from([...value].map(([key, item]) => [key, phpValue(item)] as const));
  return value;
}

/** Yaml::dump($value, $inline): block style down to `inline` levels, 4 spaces a level. */
export function yamlDump(value: YamlValue, inline = 10): string {
  return dumpYaml(phpValue(value), inline, INDENTATION);
}
