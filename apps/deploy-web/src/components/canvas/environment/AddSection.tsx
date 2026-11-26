// Derived from coollabsio/coolify@91b7e3e:resources/js/canvas/environment/AddSection.svelte (Apache-2.0), modified.
// Searchable list of cards, each with an Add button (connect view side panels).
import { useState } from "react";
import type { CanvasNode } from "../../../lib/environment-canvas";
import { CanvasIcon } from "./Icon";

export function AddSection(props: { title: string; placeholder: string; empty: string; candidates: CanvasNode[]; describe: (candidate: CanvasNode) => { title: string; sub: string }; onAdd: (candidate: CanvasNode) => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const search = query.trim().toLowerCase();

  async function add(candidate: CanvasNode) {
    setBusy((b) => ({ ...b, [candidate.id]: true }));
    await props.onAdd(candidate);
    setBusy((b) => ({ ...b, [candidate.id]: false }));
  }

  return (
    <section className="border-t border-neutral-100 px-4 py-3 dark:border-white/[0.06]">
      <h3 className="mb-1.5 text-[11px]! leading-4! font-medium! text-neutral-400 dark:text-fg-faint">{props.title}</h3>
      <div className="flex flex-col gap-2">
        {props.candidates.length ? <input value={query} onChange={(e) => setQuery(e.target.value)} className="input h-8 w-full text-[12px]" type="search" placeholder={props.placeholder} aria-label={props.placeholder} /> : null}
        <ul className="flex flex-col gap-1.5">
          {!props.candidates.length ? <li className="text-[12px] text-neutral-400 dark:text-fg-faint">{props.empty}</li> : null}
          {props.candidates.map((candidate) => {
            const { title: addTitle, sub } = props.describe(candidate);
            const hidden = !!search && !`${candidate.name} ${sub}`.toLowerCase().includes(search);
            return (
              <li key={candidate.id} className={`flex items-center gap-1 ${hidden ? "hidden" : ""}`.trimEnd()}>
                <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-[12px]">
                  <CanvasIcon name={candidate.type} className="size-3.5 text-neutral-400 dark:text-fg-faint" />
                  <div className="min-w-0 flex-1">
                    <div className={`truncate ${candidate.type === "variable" ? "font-mono" : ""}`.trimEnd()}>{candidate.name}</div>
                    {sub ? <div className="truncate text-[11px] text-neutral-400 dark:text-fg-faint">{sub}</div> : null}
                  </div>
                </div>
                <button type="button" className="button h-6! shrink-0 px-2! text-[11px]!" title={addTitle} disabled={!!busy[candidate.id]} onClick={() => void add(candidate)}>
                  Add
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
