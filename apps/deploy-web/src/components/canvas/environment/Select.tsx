// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/environment/Select.svelte (Apache-2.0), modified.
// Our listbox (same look as <x-forms.listbox>) instead of the native <select>.
// The panel is absolute, not fixed: the zoom controls bar has a backdrop filter,
// which makes it the containing block of fixed children.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

export interface SelectOption {
  value: string;
  label: string;
}

export function Select({ options, value, label, className = "", onChange }: { options: SelectOption[]; value: string; label: string; className?: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  function close(focus = false) {
    setOpen(false);
    if (focus) trigger.current?.focus();
  }
  function toggle() {
    if (open) return close();
    const r = trigger.current!.getBoundingClientRect();
    setAbove(innerHeight - r.bottom < 280 && r.top > innerHeight - r.bottom);
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }
  function pick(option: SelectOption) {
    close(true);
    if (option.value !== value) onChange(option.value);
  }
  function keys(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      close(true);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return toggle();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      pick(options[active]!);
    }
  }

  useEffect(() => {
    if (open) list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [open, active]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <div className={`relative ${className}`} ref={root} onKeyDown={keys} role="presentation">
      <button type="button" className="listbox-trigger h-8! text-[12px]!" ref={trigger} onClick={toggle} aria-haspopup="listbox" aria-expanded={open} aria-label={label} title={label}>
        <span className="listbox-trigger-label">{current?.label}</span>
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="size-3.5 shrink-0 opacity-60">
          <path strokeLinecap="round" strokeLinejoin="round" d="m8 9 4-4 4 4m0 6-4 4-4-4" />
        </svg>
      </button>
      {open ? (
        <div className="listbox-panel" style={above ? { top: "auto", bottom: "calc(100% + 0.25rem)" } : undefined} role="listbox" aria-label={label} ref={list}>
          {options.map((option, i) => (
            <button
              key={option.value}
              type="button"
              className="listbox-option text-[13px]!"
              style={i === active ? { background: "var(--coollabs-fill)" } : undefined}
              role="option"
              aria-selected={option.value === value}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(option)}
            >
              <span className="truncate">{option.label}</span>
              {option.value === value ? (
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className="ml-auto size-3.5 shrink-0">
                  <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                </svg>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
