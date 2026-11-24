// Derived from coollabsio/coolify@91b7e3e:bootstrap/helpers/shared.php (new_public_id,
// generate_random_name) (Apache-2.0), modified.
//
// new_public_id(): Str::lower(Str::random(24)). Str::random draws from
// [A-Za-z0-9] (base64 without "/", "+", "="), so after lowercasing a letter is
// twice as likely as a digit; drawing from the same 62 characters keeps that.
//
// generate_random_name(): nubs/random-name-generator's Alliteration ("Adjective
// Noun", both starting with the same letter) plus "-<public id>", in kebab case.
// The word lists here are Freeploy's own, shorter than the library's.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomIndex(n: number): number {
  // Rejection sampling: no modulo bias.
  const limit = Math.floor(256 / n) * n;
  const b = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(b);
    if (b[0]! < limit) return b[0]! % n;
  }
}

function pick<T>(list: readonly T[]): T {
  return list[randomIndex(list.length)]!;
}

/** Coolify's new_public_id(): 24 lowercase letters and digits. */
export function newPublicId(length = 24): string {
  let id = "";
  for (let i = 0; i < Math.max(1, length); i++) id += ALPHABET[randomIndex(ALPHABET.length)];
  return id.toLowerCase();
}

const ADJECTIVES = [
  "Agreeable", "Amazing", "Ancient", "Brave", "Bright", "Busy", "Calm", "Clever", "Cool", "Daring", "Dazzling", "Eager",
  "Elegant", "Fancy", "Fearless", "Gentle", "Glorious", "Happy", "Helpful", "Honest", "Icy", "Idle", "Jolly", "Joyful",
  "Kind", "Keen", "Lively", "Lucky", "Merry", "Mighty", "Nice", "Noble", "Odd", "Orange", "Polite", "Proud", "Quick",
  "Quiet", "Rapid", "Relieved", "Silly", "Smart", "Tender", "Tidy", "Unique", "Upbeat", "Vast", "Vivid", "Wise", "Witty",
  "Young", "Yellow", "Zany", "Zealous",
] as const;

const NOUNS = [
  "Ant", "Antelope", "Badger", "Bear", "Camel", "Cat", "Deer", "Dolphin", "Eagle", "Elephant", "Falcon", "Fox", "Gecko",
  "Giraffe", "Hawk", "Heron", "Ibis", "Iguana", "Jackal", "Jaguar", "Kangaroo", "Koala", "Lemur", "Lion", "Moose", "Mouse",
  "Newt", "Narwhal", "Octopus", "Otter", "Panda", "Parrot", "Quail", "Quokka", "Rabbit", "Raven", "Seal", "Swan", "Tiger",
  "Turtle", "Urchin", "Unicorn", "Vulture", "Viper", "Walrus", "Wolf", "Yak", "Yeti", "Zebra", "Zebu",
] as const;

/** Laravel's Str::kebab: words joined by "-", lower case. */
export function kebab(value: string): string {
  // ucwords() capitalizes after whitespace only, then the whitespace goes.
  const studly = value.replace(/(^|[ \t\r\n\f\v])(\p{Ll})/gu, (_m, s: string, c: string) => s + c.toUpperCase()).replace(/\s+/gu, "");
  return studly.replace(/(.)(?=\p{Lu})/gu, "$1-").toLowerCase();
}

/** Coolify's generate_random_name(): e.g. "brave-bear-k3j2…". */
export function generateRandomName(cuid: string | null = null): string {
  const adjective = pick(ADJECTIVES);
  const nouns = NOUNS.filter((n) => n[0] === adjective[0]);
  const noun = pick(nouns.length ? nouns : NOUNS);
  return kebab(`${adjective} ${noun}-${cuid ?? newPublicId()}`);
}
