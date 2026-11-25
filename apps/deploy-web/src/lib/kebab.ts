// Derived from coollabsio/coolify@91b7e3e:app/Livewire/Destination/New/Docker.php (generateName) (Apache-2.0), modified.

/**
 * Laravel's Str::kebab, as New/Docker::generateName() names a destination:
 * str("{$server->name}-{$network}")->kebab(). ucwords() capitalizes after
 * whitespace only, the whitespace goes, then "-" before each capital.
 */
export function kebab(value: string): string {
  const studly = value.replace(/(^|[ \t\r\n\f\v])(\p{Ll})/gu, (_m, s: string, c: string) => s + c.toUpperCase()).replace(/\s+/gu, "");
  return studly.replace(/(.)(?=\p{Lu})/gu, "$1-").toLowerCase();
}
