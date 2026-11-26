// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/deploy/Dropdown.svelte (Apache-2.0), modified.
//
// Our dropdown panel: a searchable list under its trigger, and an optional
// "New …" row. Mounted again for each trigger (see DeployCanvas.tsx).
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ICONS } from "../../../lib/deploy-canvas";
import { Icon } from "./Icon";
import { closeDropdown, toast, type DropdownState } from "./state";

export function Dropdown({ dropdown }: { dropdown: DropdownState }) {
  const { trigger, items, current, onPick, add } = dropdown;
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listBox = useRef<HTMLDivElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(() => Math.max(0, items.findIndex(([v]) => v === current)));
  // The "New …" row: a click shows a name field; Enter creates it.
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  const q = query.trim().toLowerCase();
  const shown = items.filter(([, text]) => !q || String(text).toLowerCase().includes(q));
  const activeIndex = Math.min(active, Math.max(0, shown.length - 1));

  function pick(value: string) {
    closeDropdown();
    onPick(value);
  }
  function keys(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      closeDropdown();
      trigger.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((activeIndex + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % Math.max(1, shown.length));
    } else if (e.key === "Enter" && shown[activeIndex]) {
      e.preventDefault();
      pick(shown[activeIndex]![0]);
    }
  }
  function startAdding() {
    setName(query.trim());
    setAdding(true);
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    const typed = name.trim();
    if (!typed || busy || !add) return;
    setBusy(true);
    try {
      const created = await add.create(typed);
      closeDropdown();
      add.done(created);
      toast(`"${typed}" added.`);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setBusy(false);
      addInput.current?.focus();
    }
  }

  // Keep the active option in view.
  useEffect(() => {
    listBox.current?.children[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, query]);
  useEffect(() => {
    if (adding) addInput.current?.focus();
  }, [adding]);

  useLayoutEffect(() => {
    const el = panel.current!;
    // Under the trigger (or above it when there is no room), as wide as it.
    const r = trigger.getBoundingClientRect();
    const width = Math.max(r.width, 200);
    const below = innerHeight - r.bottom - 12;
    el.style.width = `${width}px`;
    el.style.left = `${Math.min(r.left, innerWidth - width - 12)}px`;
    if (below < Math.min(el.offsetHeight, 260) && r.top > below) el.style.bottom = `${innerHeight - r.top + 6}px`;
    else el.style.top = `${r.bottom + 6}px`;
    ((search.current || listBox.current?.children[active] || el) as HTMLElement).focus?.();
    const outside = (e: Event) => {
      const target = e.target as Node;
      if (!el.contains(target) && target !== trigger && !trigger.contains(target)) closeDropdown();
    };
    addEventListener("pointerdown", outside, true);
    return () => removeEventListener("pointerdown", outside, true);
    // Mounted once per trigger (onMount).
  }, []);

  return (
    <div className="cv-dd" role="listbox" tabIndex={-1} ref={panel} onKeyDown={keys}>
      {items.length > 8 ? (
        <input
          className="cv-dd-search"
          placeholder="Search"
          spellCheck={false}
          ref={search}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
        />
      ) : null}
      <div className="cv-dd-list" ref={listBox}>
        {shown.length ? (
          shown.map(([value, text, badge], i) => (
            <button key={value} type="button" role="option" aria-selected={value === current} className={`cv-dd-opt${value === current ? " on" : ""}${i === activeIndex ? " active" : ""}`} onPointerEnter={() => setActive(i)} onClick={() => pick(value)}>
              <span>{text}</span>
              {badge ? <em className="cv-badge">{badge}</em> : null}
              <Icon name={ICONS.check} />
            </button>
          ))
        ) : (
          <p className="cv-dd-none">{q ? "No match" : "None yet"}</p>
        )}
      </div>
      {add ? (
        <div className="cv-dd-add">
          {adding ? (
            <>
              <form className="cv-dd-form" onSubmit={submit}>
                {/* Enter submits the form, not the list's "pick the active option". */}
                <input
                  className="cv-dd-search"
                  placeholder={add.placeholder}
                  spellCheck={false}
                  ref={addInput}
                  value={name}
                  onChange={(e) => setName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Escape") e.stopPropagation();
                  }}
                />
                <button type="submit" className="button button-highlighted" disabled={busy}>
                  Add
                </button>
              </form>
              <p className="cv-note bad">{problem}</p>
            </>
          ) : (
            <button type="button" className="cv-dd-opt cv-dd-new" onClick={startAdding}>
              <Icon name={ICONS.plus} />
              <span>{add.label}</span>
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
