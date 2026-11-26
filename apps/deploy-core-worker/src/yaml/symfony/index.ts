// Derived from symfony/yaml@v8.1.11:Yaml.php (parse) and Parser.php (parse) (MIT), modified.
//
// Yaml::parse($input) with no flags, as Coolify's ValidCloudInitYaml calls it: the PHP value of a document, or a
// SymfonyYamlParseException whose message is Symfony's ParseException message ("… at line N (near "…")"), byte for byte.
// Verified against PHP: tests/deploy-core-worker/fixtures/symfony-yaml (see its README). The MIT licence of symfony/yaml
// is in ./LICENSE.
import { PhpArray, type PhpValue } from "../../compose/php.js";
import { TaggedValue } from "../../compose/yaml.js";
import { SymfonyYamlParseException } from "./exception.js";
import { parseBytes, type YamlValue } from "./parser.js";
import { fromBytes, toBytes } from "./php-string.js";

export { SymfonyYamlParseException } from "./exception.js";
export type { YamlValue } from "./parser.js";

/** The byte strings of a parsed value (keys and values) as UTF-8 text. */
function decode(value: YamlValue): YamlValue {
  if (typeof value === "string") return fromBytes(value);
  if (value instanceof TaggedValue) return new TaggedValue(fromBytes(value.tag), decode(value.value) as PhpValue);
  if (value instanceof PhpArray) {
    const out = new PhpArray();
    for (const [k, v] of value) out.set(typeof k === "string" ? fromBytes(k) : k, decode(v as YamlValue) as PhpValue);
    return out;
  }
  return value;
}

/** Yaml::parse($input): throws SymfonyYamlParseException. */
export function symfonyYamlParse(input: string): YamlValue {
  return decode(parseBytes(toBytes(input)));
}

/** The ParseException message of Yaml::parse($input), or null when Symfony reads it. */
export function symfonyYamlError(input: string): string | null {
  try {
    symfonyYamlParse(input);
    return null;
  } catch (e) {
    if (e instanceof SymfonyYamlParseException) return e.message;
    throw e;
  }
}
