// Alpine's dropdowns in Coolify's layout (team switcher, account menu): a
// button followed by a `.listbox-panel` opens and closes it; a click anywhere
// else, or Escape, closes every open panel.
import { useEffect } from "react";

export function useDisclosures(): void {
  useEffect(() => {
    const closeAll = (except?: Element) => {
      document.querySelectorAll<HTMLElement>(".listbox-panel[data-open]").forEach((p) => {
        if (p === except) return;
        p.style.display = "none";
        p.removeAttribute("data-open");
      });
    };
    const onClick = (e: MouseEvent) => {
      const button = (e.target as Element | null)?.closest("button");
      const panel = button?.nextElementSibling;
      if (button && panel?.classList.contains("listbox-panel")) {
        const open = panel.hasAttribute("data-open");
        closeAll(panel);
        (panel as HTMLElement).style.display = open ? "none" : "";
        if (open) panel.removeAttribute("data-open");
        else panel.setAttribute("data-open", "");
        return;
      }
      if (!(e.target as Element | null)?.closest(".listbox-panel")) closeAll();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
}
