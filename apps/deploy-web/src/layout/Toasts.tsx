// Derived from coollabsio/coolify@91b7e3e:resources/views/components/toast.blade.php (Apache-2.0), modified.
// The toast stack: newest first, at most four, each gone after four seconds
// unless hovered.
import { useEffect, useRef, useState } from "react";
import { Reicon } from "../components/Reicon";
import type { ToastDetail } from "../lib/toast";

interface Item extends ToastDetail {
  id: string;
}

const ICON_CLASS: Record<string, string> = {
  success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400",
  info: "bg-coollabs/10 text-coollabs dark:bg-brand/15 dark:text-brand-light",
  warning: "bg-amber-100 text-amber-700 dark:bg-warning/10 dark:text-warning",
  danger: "bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-400",
  default: "bg-neutral-100 text-neutral-600 dark:bg-white/[0.06] dark:text-fg-dim",
};
const ICON: Record<string, string> = { success: "check-circle", info: "info-circle", default: "info-circle", warning: "alert-triangle", danger: "alert-circle" };

export function Toasts() {
  const [items, setItems] = useState<Item[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const remove = (id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  };
  const schedule = (id: string, delay: number) => {
    clearTimeout(timers.current.get(id));
    timers.current.set(id, setTimeout(() => remove(id), delay));
  };
  useEffect(() => {
    const onShow = (e: Event) => {
      const detail = (e as CustomEvent<ToastDetail>).detail;
      const id = `toast-${Math.random().toString(16).slice(2)}`;
      setItems((xs) => [{ ...detail, id }, ...xs].slice(0, 4));
      schedule(id, 4000);
    };
    window.addEventListener("toast-show", onShow);
    return () => window.removeEventListener("toast-show", onShow);
  }, []);
  return (
    <>
      {items.map((t) => (
        <li
          key={t.id}
          onMouseEnter={() => clearTimeout(timers.current.get(t.id))}
          onMouseLeave={() => schedule(t.id, 2000)}
          className="surface-popover toast-card relative flex w-full items-start rounded-lg group p-3.5 pr-20"
        >
          <div className="flex min-w-0 items-start gap-3">
            <div className={`toast-icon flex size-8 shrink-0 items-center justify-center rounded-lg ${ICON_CLASS[t.type] ?? ICON_CLASS.default}`}>
              <Reicon name={ICON[t.type] ?? "info-circle"} className="size-4" />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-sm font-semibold leading-5 text-neutral-950 dark:text-fg">{t.message}</p>
              {t.description ? <div className="mt-0.5 w-full whitespace-pre-wrap break-words text-xs leading-5 text-neutral-600 dark:text-fg-dim">{t.description}</div> : null}
            </div>
          </div>
          <button
            type="button"
            onClick={() => remove(t.id)}
            aria-label="Dismiss"
            className="absolute right-2.5 top-2.5 flex size-7 items-center justify-center rounded-md text-neutral-400 transition-colors hover:bg-black/5 hover:text-neutral-700 dark:text-fg-faint dark:hover:bg-white/[0.06] dark:hover:text-fg"
          >
            <Reicon name="x" className="size-3.5" />
          </button>
        </li>
      ))}
    </>
  );
}
