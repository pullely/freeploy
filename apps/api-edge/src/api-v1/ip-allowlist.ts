// Derived from coollabsio/coolify@91b7e3e:app/Http/Middleware/ApiIpAllowed.php and
// bootstrap/helpers/shared.php (checkIPAgainstAllowlist, normalizeIpAddress) (Apache-2.0), modified.

/** An IPv4 address as a 32-bit number, or null (ip2long). */
function ipv4(ip: string): number | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** An IPv6 (or IPv4-mapped) address as 16 bytes, or null (inet_pton). */
function ipv6(ip: string): Uint8Array | null {
  if (!ip.includes(":")) return null;
  let text = ip;
  let tail: number[] = [];
  const v4 = text.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const n = ipv4(v4[2]!);
    if (n === null) return null;
    tail = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    text = `${v4[1]}0:0`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i]!)) return null;
    const g = parseInt(groups[i]!, 16);
    bytes[i * 2] = g >> 8;
    bytes[i * 2 + 1] = g & 255;
  }
  if (tail.length) bytes.set(tail, 12);
  return bytes;
}

/** normalizeIpAddress(): one spelling per address. */
function normalize(ip: string): string {
  const b = ipv6(ip);
  return b ? Array.from(b).join(".") : ip;
}

/** checkIPAgainstAllowlist() */
export function checkIpAgainstAllowlist(ip: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false;
  for (const raw of allowlist) {
    const allowed = raw.trim();
    if (!allowed) continue;
    if (allowed.includes("/")) {
      const [subnet, maskText] = allowed.split("/") as [string, string];
      if (subnet === "0.0.0.0") return true;
      const mask = Number.parseInt(maskText, 10) || 0;
      const v6 = ipv6(subnet);
      if (v6) {
        if (mask < 0 || mask > 128) continue;
        const addr = ipv6(ip);
        if (!addr) continue;
        let ok = true;
        for (let bit = 0; bit < mask && ok; bit++) {
          const byte = bit >> 3;
          const m = 0x80 >> (bit & 7);
          if ((addr[byte]! & m) !== (v6[byte]! & m)) ok = false;
        }
        if (ok) return true;
      } else {
        if (mask < 0 || mask > 32) continue;
        const a = ipv4(ip);
        const s = ipv4(subnet);
        if (a === null || s === null) continue;
        const m = mask === 0 ? 0 : (~((1 << (32 - mask)) - 1)) >>> 0;
        if (((a & m) >>> 0) === ((s & m) >>> 0)) return true;
      }
    } else {
      if (allowed === "0.0.0.0") return true;
      if (normalize(ip) === normalize(allowed)) return true;
    }
  }
  return false;
}

/** ApiIpAllowed: an empty list or 0.0.0.0 allows every address. */
export function ipAllowed(ip: string, setting: string | undefined): boolean {
  const list = (setting ?? "").trim();
  if (list === "" || list === "0.0.0.0") return true;
  const entries = list.split(",").map((s) => s.trim()).filter(Boolean);
  return entries.length === 0 || checkIpAgainstAllowlist(ip, entries);
}
