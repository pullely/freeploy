// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/server/ca-certificate/show.blade.php (Apache-2.0), modified.
const DAY = 86_400_000;

/**
 * The CA certificate badge: now()->gt($validUntil) is "Expired",
 * now()->addDays(30)->gt($validUntil) is "Expiring soon" (both error), else "Valid".
 */
export function certificateStatus(validUntil: string, now = Date.now()): { label: string; type: "error" | "success" } {
  const end = Date.parse(validUntil);
  if (now > end) return { label: "Expired", type: "error" };
  if (now + 30 * DAY > end) return { label: "Expiring soon", type: "error" };
  return { label: "Valid", type: "success" };
}
