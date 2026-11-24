// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/layout-popups.blade.php (Apache-2.0), modified.
// shouldShowMonthlyPopup(): a reminder dismissed at `stored` (a millisecond
// timestamp) stays hidden for the rest of that calendar month.
export function showMonthlyReminder(stored: string | null, now = new Date()): boolean {
  if (!stored || stored === "false") return true;
  const at = parseInt(stored, 10);
  if (Number.isNaN(at)) return true;
  const d = new Date(at);
  return now.getMonth() !== d.getMonth() || now.getFullYear() !== d.getFullYear();
}
