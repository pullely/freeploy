// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/deploy/Field.svelte (Apache-2.0), modified.
//
// One field of a card: a note, segmented buttons, our dropdown, or a text input.
import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { ICONS, lists, loaderKey, type Field as FieldDef, type FlowNode, type Option } from "../../../lib/deploy-canvas";
import { Icon } from "./Icon";
import { cv, openDropdown, setField, useDeployCanvas } from "./state";

const stop = (e: PointerEvent | KeyboardEvent) => e.stopPropagation();

export function Field({ n, f }: { n: FlowNode; f: FieldDef }) {
  useDeployCanvas();
  const trigger = useRef<HTMLButtonElement>(null);
  const set = (value: string) => setField(n, f, value);

  // Select options: null while loading; undefined when the field above is empty.
  const list: Option[] | null | undefined = f.kind === "select" ? (f.load ? f.load(n.data) : f.options) : null;
  const key = f.load ? loaderKey(f, n.data) : undefined;
  const error = key ? lists.errors[key] : null;
  const value = n.data[f.key] ?? "";
  // An optional field's default ("Default") is a real choice, not a placeholder.
  const chosen: Option | null = (list || []).find(([v]) => v === value) || (list && f.optional && !value ? ["", f.optional] : null);
  const placeholder = list ? f.optional || `Choose ${(f.label ?? "").toLowerCase()}` : list === null ? "Loading…" : "Pick the field above first";
  // `add`: a "New …" row at the end of the list creates one and selects it.
  const add =
    f.add && cv.canAdd
      ? {
          label: f.add.label,
          placeholder: f.add.placeholder,
          create: (name: string) => f.add!.create(name, n.data),
          // Load the list again (it has the new one), then select it.
          done: (picked: string) => {
            delete lists.cache[f.add!.list(n.data)];
            cv.listsVersion++;
            set(picked);
          },
        }
      : null;

  function open() {
    openDropdown(trigger.current!, [...(f.optional ? [["", f.optional] as Option] : []), ...(list || [])], value, set, add);
  }
  function keys(e: KeyboardEvent) {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      trigger.current?.click();
    }
  }

  if (f.kind === "note") return <p className="cv-note">{f.text}</p>;
  return (
    <div className="cv-field">
      <label>
        {f.label}
        {f.required ? <em>{" *"}</em> : null}
      </label>
      {f.kind === "segmented" ? (
        <div className="cv-seg">
          {(f.options ?? []).map(([option, text]) => (
            <button key={option} type="button" className={(n.data[f.key] ?? f.value) === option ? "on" : ""} onClick={() => set(option)} onPointerDown={stop}>
              {text}
            </button>
          ))}
        </div>
      ) : f.kind === "select" ? (
        <>
          <button
            ref={trigger}
            type="button"
            className={`cv-input cv-select${chosen ? "" : " empty"}${trigger.current && cv.dropdown?.trigger === trigger.current ? " open" : ""}`}
            disabled={!list}
            aria-haspopup="listbox"
            onPointerDown={stop}
            onClick={open}
            onKeyDown={keys}
          >
            <span>{chosen ? chosen[1] : placeholder}</span>
            {chosen?.[2] ? <em className="cv-badge">{chosen[2]}</em> : null}
            <Icon name={ICONS.chevron} />
          </button>
          {error ? <span className="cv-note bad">{error}</span> : null}
        </>
      ) : f.kind === "textarea" ? (
        <textarea className={`cv-input${f.mono ? " mono" : ""}`} rows={f.rows || 3} placeholder={f.placeholder || ""} spellCheck={false} value={n.data[f.key] ?? ""} onChange={(e) => set(e.currentTarget.value)} onPointerDown={stop} onKeyDown={stop}></textarea>
      ) : (
        <input type="text" className={`cv-input${f.mono ? " mono" : ""}`} placeholder={f.placeholder || ""} spellCheck={false} value={n.data[f.key] ?? ""} onChange={(e) => set(e.currentTarget.value)} onPointerDown={stop} onKeyDown={stop} />
      )}
    </div>
  );
}
