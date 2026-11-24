// Derived from coollabsio/coolify@91b7e3e:resources/views/components/forms/env-var-input.blade.php and
// app/View/Components/Forms/EnvVarInput.php (Apache-2.0), modified.
//
// <x-forms.env-var-input>: a value field that suggests shared variables after
// "{{" — the scopes that have variables, then a scope's variables — and warns
// about a value with edge whitespace. Not here: the secret manager ("vault")
// scope.
import { useEffect, useRef, useState } from "react";
import { FieldError, Helper } from "./Coolify";
import { Reicon } from "./Reicon";
import { applySuggestion, hasEdgeSpace, suggestionsFor, type AvailableSharedVariables, type Suggestion, type SuggestionState } from "../lib/environment-variables";

const HIDDEN = { display: "none" as const };
const CLOSED: SuggestionState = { show: false, suggestions: [], currentScope: null };

export function EnvVarInput(props: {
  id: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "password";
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  helper?: string;
  error?: string | undefined;
  availableVars: AvailableSharedVariables;
  /** Where a scope's shared variables are added (the "Add … variables" link). */
  scopeUrls: Record<string, string>;
}) {
  const password = props.type === "password";
  const [type, setType] = useState<"text" | "password">(props.type ?? "text");
  const [state, setState] = useState<SuggestionState>(CLOSED);
  const [selected, setSelected] = useState(0);
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const pendingCursor = useRef<number | null>(null);

  // @click.outside="showDropdown = false"
  useEffect(() => {
    if (!state.show) return;
    const onClick = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setState(CLOSED);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [state.show]);

  // $nextTick(() => input.setSelectionRange(…)) after a suggestion was put in.
  useEffect(() => {
    if (pendingCursor.current === null || !input.current) return;
    input.current.setSelectionRange(pendingCursor.current, pendingCursor.current);
    input.current.focus();
    pendingCursor.current = null;
  }, [props.value]);

  /** handleInput() */
  function update(value: string, position: number) {
    setCursor(position);
    setState(suggestionsFor(value, position, props.availableVars));
    setSelected(0);
  }

  /** selectSuggestion() */
  function select(suggestion: Suggestion) {
    const next = applySuggestion(props.value, cursor, suggestion);
    pendingCursor.current = next.cursor;
    props.onChange(next.value);
    if (next.done) {
      setState(CLOSED);
      setSelected(0);
    } else {
      update(next.value, next.cursor);
    }
  }

  const scopeUrl = (scope: string) => props.scopeUrls[scope] ?? props.scopeUrls.default ?? "/shared-variables";
  const { suggestions } = state;

  return (
    <div className="w-full">
      {props.label ? (
        <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
          <label className="mb-0! flex items-center gap-1 text-sm font-medium leading-4">
            {props.label}
            {props.required ? <span className="text-helper">*</span> : null}
          </label>
          {props.helper ? <Helper helper={props.helper} /> : null}
        </div>
      ) : null}

      <div className="relative" ref={root}>
        <input
          ref={input}
          autoComplete="off"
          type={type}
          className={[password ? "input input-with-password-toggle" : "input", type === "text" && !props.disabled ? "truncate" : ""].filter(Boolean).join(" ")}
          required={props.required}
          disabled={props.disabled}
          id={props.id}
          name={props.id}
          placeholder={props.placeholder ?? ""}
          value={props.value}
          onChange={(e) => {
            props.onChange(e.target.value);
            update(e.target.value, e.target.selectionStart ?? 0);
          }}
          onClick={(e) => update(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            // handleKeydown()
            if (!state.show || suggestions.length === 0) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((selected + 1) % suggestions.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected(selected <= 0 ? suggestions.length - 1 : selected - 1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              const suggestion = suggestions[selected];
              if (suggestion) select(suggestion);
            } else if (e.key === "Escape") {
              setState(CLOSED);
            }
          }}
        />

        {password ? (
          <button
            type="button"
            onClick={() => setType(type === "password" ? "text" : "password")}
            className="password-toggle flex absolute inset-y-0 right-0 z-10 items-center pr-2 cursor-pointer text-neutral-500 hover:text-black dark:text-neutral-400 dark:hover:text-white"
            aria-label="Toggle password visibility"
          >
            <Reicon name="eye" className="size-[18px]" {...(type === "password" ? {} : { style: HIDDEN })} />
            <Reicon name="eye-off2" className="size-[18px]" {...(type === "text" ? {} : { style: HIDDEN })} />
          </button>
        ) : null}

        <div className="listbox-panel top-full! z-[60]! mt-1! w-full! min-w-0! max-w-full!" role="listbox" style={state.show ? undefined : HIDDEN}>
          {suggestions.length === 0 && state.currentScope ? (
            <div className="px-2 py-2 text-sm text-neutral-500 dark:text-fg-dim">
              <div>
                No shared variables found in <span className="font-semibold">{state.currentScope}</span> scope.
              </div>
              <a href={scopeUrl(state.currentScope)} className="mt-1 inline-block text-xs text-coollabs hover:underline dark:text-brand-light" target="_blank" rel="noreferrer">
                Add <span>{state.currentScope}</span> variables →
              </a>
            </div>
          ) : null}

          <div className="max-h-48 overflow-y-auto" style={suggestions.length > 0 ? { scrollbarWidth: "thin" } : HIDDEN}>
            {suggestions.map((suggestion, index) => (
              <div
                key={suggestion.display}
                id={`suggestion-${index}`}
                onClick={() => select(suggestion)}
                className={`listbox-option justify-start! gap-2.5!${index === selected ? " bg-neutral-100 dark:bg-white/[0.08]" : ""}`}
                role="option"
                aria-selected={index === selected}
              >
                {suggestion.type === "scope" ? (
                  <span className="rounded-md border border-warning/25 bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-warning">SCOPE</span>
                ) : (
                  <span className="rounded-md border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-600 dark:text-emerald-400">VAR</span>
                )}
                <span className="min-w-0 truncate font-mono text-sm">{suggestion.display}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <p className="mt-1 text-xs text-warning" style={hasEdgeSpace(props.value) ? undefined : HIDDEN}>
        The value starts or ends with a space. Freeploy keeps the space.
      </p>
      <FieldError message={props.error} />
    </div>
  );
}
