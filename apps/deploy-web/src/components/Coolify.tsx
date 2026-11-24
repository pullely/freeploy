// Derived from coollabsio/coolify@91b7e3e:resources/views/components/{helper,modal-input,
// modal-confirmation,status-badge,empty,callout,copy-button,loading,danger-zone,unsaved-bar,deprecated-badge}.blade.php,
// resources/views/components/application/{settings-section,settings-subsection}.blade.php and
// resources/views/components/forms/{input,textarea,button,listbox,collapsible}.blade.php (Apache-2.0), modified.
//
// Coolify's Blade components as React components: the same DOM, classes and copy;
// Alpine's state (open, step, …) as React state. Overlays teleport to <body>
// as x-teleport="body" does.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Reicon } from "./Reicon";

const HIDDEN = { display: "none" as const };
const shown = (open: boolean) => (open ? undefined : HIDDEN);

/** <x-helper>: an info button with a popup on hover or focus. */
export function Helper({ helper, label = "More information", trigger }: { helper: string; label?: string; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = () => {
    if (timer.current) clearTimeout(timer.current);
    const r = button.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 328)), top: r.bottom + 8 });
    setOpen(true);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 150);
  };
  return (
    <div className="relative inline-flex align-middle">
      <button
        ref={button}
        type="button"
        data-icon-tooltip-ignore=""
        className={`info-helper relative inline-flex shrink-0 items-center justify-center border-0 bg-transparent p-0 leading-none${trigger ? "" : " size-3.5"}`}
        aria-label={label}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => (open ? setOpen(false) : show())}
      >
        {trigger ?? <Reicon name="info-circle" className="size-3.5 text-neutral-400 transition-colors hover:text-neutral-600 dark:text-fg-faint dark:hover:text-fg-dim" />}
      </button>
      {createPortal(
        <div
          role="tooltip"
          className="info-helper-popup fixed z-[10000] w-max max-w-[min(20rem,calc(100vw-2rem))] whitespace-normal"
          data-teleport-target="true"
          style={open ? { left: `${pos.left}px`, top: `${pos.top}px` } : HIDDEN}
          onMouseEnter={show}
          onMouseLeave={hide}
        >
          <div className="px-3 py-2.5 text-[13px] leading-5">{helper}</div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** <x-status-badge> (span, md). */
export function StatusBadge({ label, type = "neutral" }: { label: string; type?: "neutral" | "success" | "warning" | "error" }) {
  const dot = { neutral: "bg-neutral-400 dark:bg-neutral-500", success: "bg-emerald-500", warning: "bg-warning", error: "bg-red-500" }[type];
  return (
    <span className="inline-flex max-w-full items-center whitespace-nowrap text-neutral-700 dark:text-fg gap-1.5 text-[13px]">
      <span className="relative flex size-1.5 shrink-0">
        <span className={`relative inline-flex size-1.5 rounded-full ${dot}`} />
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}

/** <x-empty> (base size, with an icon name). */
export function Empty({ title, description, iconName }: { title: string; description?: string; iconName?: string }) {
  return (
    <div className="empty-state w-full">
      <div className="empty-state-well min-h-40">
        {iconName ? (
          <div className="mb-4 size-11 flex items-center justify-center rounded-xl border border-neutral-200 bg-white text-neutral-400 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.035] dark:text-fg-faint">
            <Reicon name={iconName} className="size-5" />
          </div>
        ) : null}
        <h2 className="empty-state-title">{title}</h2>
        {description ? <p className="empty-state-description text-[13px]">{description}</p> : null}
      </div>
    </div>
  );
}

/** <x-loading>. */
export function Loading({ text = "Loading..." }: { text?: string }) {
  return (
    <div className="inline-flex items-center justify-center gap-2 text-[13px] text-neutral-500 dark:text-fg-dim" role="status" aria-live="polite">
      <svg className="loading-indicator shrink-0 animate-spin size-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle className="opacity-20" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
        <path className="opacity-80" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <span>{text}</span>
    </div>
  );
}

/** <x-loading-on-button>. */
function LoadingOnButton({ show }: { show: boolean }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5" style={shown(show)}>
      <svg className="size-3.5 shrink-0 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle className="opacity-25" cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" />
        <path className="opacity-75" d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </span>
  );
}

/** <x-callout type="danger">. */
export function DangerCallout({ title, children, className = "mb-4" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={`relative rounded-lg border px-3 py-2.5 border-red-300/60 bg-red-50 dark:border-red-500/20 dark:bg-red-500/[0.07] ${className}`}>
      <div className="flex items-start gap-2.5">
        <Reicon name="alert-circle" className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
        <div className="min-w-0 flex-1 ">
          <div className="text-[12px] font-semibold text-red-800 dark:text-red-300">{title}</div>
          <div className="mt-0.5 text-[12px] leading-5 text-red-700/80 dark:text-red-300/75">{children}</div>
        </div>
      </div>
    </div>
  );
}

const CALLOUT_STYLES = {
  warning: {
    icon: "alert-triangle",
    shell: "border-warning-700/25 bg-warning-700/[0.07] dark:border-warning-400/20 dark:bg-warning-400/[0.06]",
    iconClass: "text-warning-700 dark:text-warning-400",
    titleClass: "text-warning-900 dark:text-warning-400",
    textClass: "text-warning-900/75 dark:text-warning-400/70",
  },
  info: {
    icon: "info-circle",
    shell: "border-coollabs/20 bg-coollabs/[0.055] dark:border-brand-light/15 dark:bg-brand/[0.06]",
    iconClass: "text-coollabs dark:text-brand-light",
    titleClass: "text-coollabs dark:text-brand-light",
    textClass: "text-neutral-600 dark:text-fg-dim",
  },
} as const;

/** <x-callout type="warning|info"> (not dismissible). */
export function Callout({ type = "warning", title, children, className = "" }: { type?: keyof typeof CALLOUT_STYLES; title: string; children: ReactNode; className?: string }) {
  const style = CALLOUT_STYLES[type];
  return (
    <div className={`relative rounded-lg border px-3 py-2.5 ${style.shell} ${className}`}>
      <div className="flex items-start gap-2.5">
        <Reicon name={style.icon} className={`mt-0.5 size-4 shrink-0 ${style.iconClass}`} />
        <div className="min-w-0 flex-1 ">
          <div className={`text-[12px] font-semibold ${style.titleClass}`}>{title}</div>
          <div className={`mt-0.5 text-[12px] leading-5 ${style.textClass}`}>{children}</div>
        </div>
      </div>
    </div>
  );
}

/** <x-deprecated-badge>. */
export function DeprecatedBadge() {
  return (
    <span className="inline-flex items-center">
      <span className="px-2 py-0.5 text-xs font-medium leading-normal rounded-full bg-warning/15 text-warning border border-warning/30">Deprecated</span>
    </span>
  );
}

/** <x-copy-button>. */
export function CopyButton({ value, label = "Copy to clipboard", className = "" }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`icon-button group shrink-0 ${className}`.trim()}
      disabled={!value}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      <span className="inline-flex transition-transform duration-150 ease-out group-active:scale-75">
        <Reicon name="copy" className="size-3.5" {...(copied ? { style: HIDDEN } : {})} />
        <Reicon name="check" className="size-3.5 text-success" {...(copied ? {} : { style: HIDDEN })} />
      </span>
    </button>
  );
}

/** The error under a field (@error). */
export function FieldError({ message }: { message?: string | undefined }) {
  if (!message) return null;
  return (
    <label className="label">
      <span className="text-red-500 label-text-alt">{message}</span>
    </label>
  );
}

function Label({ label, required, helper }: { label: string; required?: boolean | undefined; helper?: string | undefined }) {
  return (
    <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
      <label className="mb-0! flex items-center gap-1 text-sm font-medium leading-4">
        {label} {required ? <span className="text-helper">*</span> : null}
      </label>
      {helper ? <Helper helper={helper} /> : null}
    </div>
  );
}

/** <x-forms.input> (text, password with its peek toggle, number with its stepper). */
export function FormInput(props: {
  id?: string;
  label?: string;
  value: string;
  onChange?: (v: string) => void;
  type?: "text" | "password" | "number";
  placeholder?: string;
  min?: number;
  max?: number;
  required?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  helper?: string;
  error?: string | undefined;
  loading?: boolean;
}) {
  const type = props.type ?? "text";
  const [peek, setPeek] = useState(false);
  const input = (inputType: string, className = "input") => (
    <input
      autoComplete="off"
      className={className}
      required={props.required}
      readOnly={props.readOnly}
      disabled={props.disabled}
      type={inputType}
      id={props.id}
      name={props.id}
      placeholder={props.placeholder ?? ""}
      {...(props.min !== undefined ? { min: props.min } : {})}
      {...(props.max !== undefined ? { max: props.max } : {})}
      value={props.value}
      onChange={(e) => props.onChange?.(e.target.value)}
    />
  );
  /** numberStepper.step(): one up or down within min and max. */
  const step = (by: number) => {
    const n = Number(props.value || 0) + by;
    const clamped = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, n));
    props.onChange?.(String(clamped));
  };
  let field: ReactNode;
  if (props.loading) {
    field = (
      <div className="input flex w-full items-center text-neutral-500 dark:text-fg-dim" aria-busy="true">
        <Loading />
      </div>
    );
  } else if (type === "password") {
    field = (
      <div className="relative">
        {input(peek ? "text" : "password", peek && !props.disabled ? "input truncate" : "input")}
        <button
          type="button"
          onClick={() => setPeek(!peek)}
          className="password-toggle flex absolute inset-y-0 right-0 z-10 items-center pr-2 cursor-pointer text-neutral-500 hover:text-black dark:text-neutral-400 dark:hover:text-white"
          aria-label="Toggle password visibility"
        >
          {peek ? <Reicon name="eye-off2" className="size-[18px]" /> : <Reicon name="eye" className="size-[18px]" />}
        </button>
      </div>
    );
  } else if (type === "number") {
    field = (
      <div className="relative">
        {input("number")}
        <div className="number-stepper">
          <button type="button" tabIndex={-1} aria-label="Decrease" onClick={() => step(-1)} disabled={props.disabled || props.readOnly}>
            <Reicon name="minus" className="size-3.5" />
          </button>
          <button type="button" tabIndex={-1} aria-label="Increase" onClick={() => step(1)} disabled={props.disabled || props.readOnly}>
            <Reicon name="plus" className="size-3.5" />
          </button>
        </div>
      </div>
    );
  } else {
    field = input("text");
  }
  return (
    <div className="w-full">
      {props.label ? <Label label={props.label} required={props.required} helper={props.helper} /> : null}
      {field}
      <FieldError message={props.error} />
    </div>
  );
}

/** <x-forms.textarea monospace>. */
export function FormTextarea(props: {
  id: string;
  label?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  error?: string | undefined;
}) {
  return (
    <div className="flex-1 form-control">
      {props.label ? <Label label={props.label} required={props.required} /> : null}
      <textarea
        placeholder={props.placeholder}
        spellCheck="false"
        className="input scrollbar font-mono"
        rows={props.rows ?? 10}
        required={props.required}
        disabled={props.disabled}
        id={props.id}
        name={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          // handleKeydown(): Tab inserts two spaces.
          if (e.key === "Tab") {
            e.preventDefault();
            e.currentTarget.setRangeText("  ", e.currentTarget.selectionStart, e.currentTarget.selectionStart, "end");
            props.onChange(e.currentTarget.value);
          }
        }}
      />
      <FieldError message={props.error} />
    </div>
  );
}

/**
 * <x-modal-input>: a trigger (the content slot) that opens a dialog. `open` /
 * `onOpenChange` make it controlled (Livewire's close-modal, wireOpen).
 */
export function ModalInput(props: {
  title: string;
  trigger?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subtitle?: string;
  children: ReactNode;
}) {
  const { open, onOpenChange } = props;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onOpenChange(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);
  return (
    <div className="relative h-auto w-auto">
      <div className="" onClick={() => onOpenChange(true)}>
        {props.trigger}
      </div>
      {createPortal(
        <div className="fixed inset-0 z-99 overflow-hidden" data-teleport-target="true" style={shown(open)}>
          <div className="absolute inset-0 w-full h-full bg-black/50 backdrop-blur-[2px]" style={shown(open)} onClick={() => onOpenChange(false)} />
          <div className="relative flex min-h-full items-start justify-center p-2 sm:items-center sm:p-4">
            <div
              className="application-settings-form application-settings-section relative flex max-h-[calc(100dvh-2rem)] w-full flex-col overflow-hidden lg:w-auto lg:min-w-2xl lg:max-w-4xl"
              style={{ boxShadow: "0 0 0 1px var(--coollabs-hairline), var(--shadow-modal)", ...(open ? {} : HIDDEN) }}
            >
              <header className="shrink-0 flex-wrap! sm:flex-nowrap!">
                <div className="min-w-0 flex-1 py-0.5">
                  <h3 className="truncate">{props.title}</h3>
                  {props.subtitle ? <p className="mt-1 text-xs text-neutral-500 dark:text-fg-dim">{props.subtitle}</p> : null}
                </div>
                <button
                  type="button"
                  className="order-2 sm:order-none flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-neutral-500 outline-0 transition-colors hover:bg-neutral-100 hover:text-black focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent dark:text-fg-faint dark:hover:bg-white/[0.06] dark:hover:text-fg"
                  onClick={() => onOpenChange(false)}
                >
                  <Reicon name="x" />
                </button>
              </header>
              <div className="application-settings-section-body min-h-0 flex-1 overflow-y-auto">{open ? props.children : null}</div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/**
 * <x-modal-confirmation> without checkboxes and without the password step
 * (confirmWithPassword false, as the private key dialogs pass): step 2, the
 * actions, optionally the text to type, then the submit.
 */
export function ModalConfirmation(props: {
  title: string;
  /** <x-slot:trigger>; without it, Coolify's default button (isErrorButton). */
  trigger?: ReactNode;
  buttonTitle?: string;
  disabled?: boolean;
  disabledTooltip?: string;
  actions: string[];
  /** confirmWithText with confirmationText; null for confirmWithText false. */
  confirmationText: string | null;
  confirmationLabel?: string;
  shortConfirmationLabel?: string;
  /** Replaces the default warning ({!! $warningMessage !!}: plain text here). */
  warningMessage?: string;
  step2ButtonText?: string;
  onSubmit: () => Promise<void>;
  /** Opens the dialog from outside ($dispatch('confirm-old-key-deletion')). */
  openRequest?: number;
}) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const reset = () => {
    setTyped("");
    setSubmitting(false);
  };
  useEffect(() => {
    if (props.openRequest) setOpen(true);
  }, [props.openRequest]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        reset();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  async function submit() {
    setSubmitting(true);
    setOpen(false);
    try {
      await props.onSubmit();
    } finally {
      reset();
    }
  }
  const needsText = props.confirmationText !== null;
  return (
    <div className={`relative h-auto max-w-full inline-flex w-auto${open ? " z-40" : ""}`}>
      {props.trigger ? (
        <div className="max-w-full inline-flex" onClick={() => setOpen(true)}>
          {props.trigger}
        </div>
      ) : props.disabled ? (
        <button className="button button-error" type="button" disabled title={props.disabledTooltip}>
          {props.buttonTitle ?? "Confirm Action"}
        </button>
      ) : (
        <button className="button button-error" type="button" onClick={() => setOpen(true)}>
          {props.buttonTitle ?? "Confirm Action"}
        </button>
      )}
      {createPortal(
        <div className="fixed inset-0 z-99 flex min-h-full items-center justify-center overflow-y-auto p-4" data-teleport-target="true" style={shown(open)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" style={shown(open)} />
          <div
            className="application-settings-form application-settings-section relative flex max-h-[calc(100dvh-2rem)] w-full flex-col lg:min-w-[36rem] lg:max-w-2xl"
            style={{ boxShadow: "0 0 0 1px var(--coollabs-hairline), var(--shadow-modal)", ...(open ? {} : HIDDEN) }}
          >
            <header className="flex-nowrap!">
              <h3 className="min-w-0 flex-1 truncate">{props.title}</h3>
              <button
                type="button"
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-black dark:text-fg-faint dark:hover:bg-white/[0.06] dark:hover:text-fg"
                onClick={() => (setOpen(false), reset())}
              >
                <Reicon name="x" />
              </button>
            </header>
            <div className="application-settings-section-body min-h-0 flex-1 overflow-y-auto">
              <div>
                <DangerCallout title="Warning">{props.warningMessage ?? "This operation is permanent and cannot be undone. Please think again before proceeding!"}</DangerCallout>
                <div className="mb-2 text-[12px] font-medium text-neutral-700 dark:text-fg-dim">The following actions will be performed:</div>
                <ul className="mb-4 space-y-2">
                  {props.actions.map((a) => (
                    <li key={a} className="flex items-start gap-2 text-[12px] leading-5 text-red-600 dark:text-red-400">
                      <span className="shrink-0" aria-hidden="true">
                        -
                      </span>
                      <span>{a}</span>
                    </li>
                  ))}
                </ul>
                {needsText ? (
                  <div className="mb-4">
                    <h4 className="mb-1 text-[12px] font-semibold">Confirm actions</h4>
                    <p className="mb-2 text-[12px] leading-5 text-neutral-500 dark:text-fg-dim">{props.confirmationLabel ?? "Please confirm the execution of the actions by entering the Name below"}</p>
                    <div className="relative mb-2">
                      <div className="relative">
                        <input type="text" readOnly className="input" value={props.confirmationText ?? ""} />
                        <CopyButton value={props.confirmationText ?? ""} className="absolute top-1/2 right-2 -translate-y-1/2" />
                      </div>
                    </div>
                    <label htmlFor="userConfirmationText" className="mt-4 mb-1.5 block text-[12px] font-medium text-neutral-700 dark:text-fg-dim">
                      {props.shortConfirmationLabel ?? "Name"}
                    </label>
                    <input type="text" className="input w-full" value={typed} onChange={(e) => setTyped(e.target.value)} />
                  </div>
                ) : null}
                <div className="mt-4 flex flex-wrap justify-end gap-2 border-t border-neutral-200 pt-4 dark:border-white/[0.08]">
                  <button className="button" type="button" onClick={() => (setOpen(false), reset())}>
                    Cancel
                  </button>
                  <button
                    className="button button-error w-auto"
                    type="button"
                    disabled={submitting || (needsText && typed !== props.confirmationText)}
                    onClick={() => void submit()}
                  >
                    <LoadingOnButton show={submitting} />
                    <span>{props.step2ButtonText ?? "Continue"}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/** <x-application.settings-section>: a card with a title (its helper as a popup), badges, actions and a body. */
export function SettingsSection(props: {
  id?: string;
  title: string;
  helper?: string;
  flush?: boolean;
  className?: string;
  badges?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const hasBody = props.children !== undefined && props.children !== null && props.children !== false;
  return (
    <section id={props.id} className={`application-settings-section${props.className ? ` ${props.className}` : ""}`} data-settings-section-title={props.title}>
      <header {...(hasBody ? {} : { className: "is-collapsed" })}>
        <div className={props.badges ? "min-w-0 py-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-1" : "min-w-0 py-0.5"}>
          {props.helper ? (
            <h3>
              <Helper helper={props.helper} label={`More information about ${props.title}`} trigger={<span className="underline underline-offset-4">{props.title}</span>} />
            </h3>
          ) : (
            <h3>{props.title}</h3>
          )}
          {props.badges}
        </div>
        {props.actions ? <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{props.actions}</div> : null}
      </header>
      {hasBody ? <div className={`application-settings-section-body${props.flush ? " is-flush" : ""}`}>{props.children}</div> : null}
    </section>
  );
}

/** <x-application.settings-subsection>: a titled part of a card, divided from the one before. */
export function SettingsSubsection({ id, title, helper, first = false, children }: { id?: string; title: string; helper?: string; first?: boolean; children: ReactNode }) {
  return (
    <section id={id} className={first ? undefined : "mt-5 border-t border-neutral-200 pt-5 dark:border-white/[0.07]"}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-1.5 text-sm! font-semibold! text-black dark:text-fg">
          {title}
          {helper ? <Helper helper={helper} label={`More information about ${title}`} /> : null}
        </h3>
      </div>
      {children}
    </section>
  );
}

export interface ListboxOption {
  value: string;
  label: string;
  description?: string;
}

/** <x-forms.listbox> (single value; optionally searchable): a trigger and a fixed panel of options. */
export function Listbox(props: {
  id: string;
  label?: string;
  helper?: string;
  required?: boolean;
  options: ListboxOption[];
  value: string | null;
  onChange: (value: string) => void;
  placeholder?: string;
  emptyText?: string;
  disabled?: boolean;
  error?: string | undefined;
  searchable?: boolean;
  searchPlaceholder?: string;
  searchEmptyText?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const current = props.options.find((o) => o.value === props.value);
  const label = current ? current.label : (props.placeholder ?? "Select…");
  const q = query.toLowerCase().trim();
  const visible = props.searchable && q !== "" ? props.options.filter((o) => [o.label, o.value, o.description].some((t) => String(t ?? "").toLowerCase().includes(q))) : props.options;

  // positionPanel(): below the trigger when it fits, else above; inside the viewport.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = trigger.current?.getBoundingClientRect();
      if (!r) return;
      const height = Math.min(panel.current?.scrollHeight ?? 256, 256);
      const fitsBelow = window.innerHeight - r.bottom - 4 >= height;
      const width = Math.min(Math.max(r.width, panel.current?.offsetWidth ?? 0), window.innerWidth - 24);
      setPosition({ top: fitsBelow ? r.bottom + 4 : Math.max(12, r.top - 4 - height), left: Math.min(Math.max(12, r.left), window.innerWidth - width - 12), width });
    };
    place();
    if (props.searchable) search.current?.focus();
    const onOutside = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!trigger.current?.contains(t) && !panel.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onOutside);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, props.searchable]);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  function choose(option: ListboxOption) {
    setOpen(false);
    if (option.value !== props.value) props.onChange(option.value);
  }

  return (
    <div className="w-full min-w-0">
      {props.label ? (
        <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
          <label htmlFor={`${props.id}-trigger`} className="mb-0! flex items-center gap-1.5 leading-4">
            {props.label}
            {props.required ? <span className="text-helper">*</span> : null}
          </label>
          {props.helper ? <Helper helper={props.helper} /> : null}
        </div>
      ) : null}
      <div className="relative min-w-0">
        <button
          ref={trigger}
          id={`${props.id}-trigger`}
          type="button"
          className="listbox-trigger"
          onClick={() => {
            setPosition(null);
            setOpen(!open);
          }}
          disabled={props.disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={label}
        >
          <span className="listbox-trigger-label flex items-center gap-2">
            <span className="min-w-0 truncate">{label}</span>
          </span>
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" className="size-3.5 shrink-0 opacity-60">
            <path strokeLinecap="round" strokeLinejoin="round" d="m8 9 4-4 4 4m0 6-4 4-4-4" />
          </svg>
        </button>
        {/* Teleported (the portal prop): the layout's dropdown handler toggles a panel next to its button. */}
        {createPortal(
        <div
          ref={panel}
          id={`${props.id}-panel`}
          className={`listbox-panel${props.searchable ? " searchable-listbox-panel" : ""}`}
          role="listbox"
          style={
            open
              ? { position: "fixed", zIndex: 9999, visibility: position ? "visible" : "hidden", ...(position ? { top: `${position.top}px`, left: `${position.left}px`, width: `${position.width}px` } : {}) }
              : { position: "fixed", zIndex: 9999, display: "none" }
          }
        >
          {props.searchable ? (
            <div className="searchable-listbox-search">
              <Reicon name="search" className="pointer-events-none absolute top-1/2 left-3 size-3 -translate-y-1/2 text-neutral-400 dark:text-fg-faint" />
              <input
                ref={search}
                type="search"
                autoComplete="off"
                placeholder={props.searchPlaceholder ?? "Search…"}
                className="searchable-listbox-search-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (visible.length === 1) choose(visible[0]!);
                  }
                }}
              />
            </div>
          ) : null}
          <div className={props.searchable ? "searchable-listbox-options" : undefined}>
            {visible.length === 0 ? (
              <div className="px-3 py-2 text-[13px] text-neutral-500 dark:text-fg-dim">
                {props.searchable && props.options.length > 0 ? (props.searchEmptyText ?? "No matching options") : (props.emptyText ?? "No options available.")}
              </div>
            ) : null}
            {open
              ? visible.map((o) => (
                  <div key={o.value}>
                    <button type="button" className="listbox-option" role="option" aria-selected={o.value === props.value} onClick={() => choose(o)}>
                      <span className="flex min-w-0 items-center gap-2 text-left">
                        <span className="flex min-w-0 flex-col items-start">
                          <span className="flex min-w-0 items-baseline gap-2">
                            <span className="truncate">{o.label}</span>
                          </span>
                          {o.description ? <span className="text-xs whitespace-normal text-neutral-500 dark:text-fg-dim">{o.description}</span> : null}
                        </span>
                      </span>
                      {o.value === props.value ? (
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth="2.5" stroke="currentColor" className="ml-auto size-3.5 shrink-0">
                          <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
                        </svg>
                      ) : null}
                    </button>
                  </div>
                ))
              : null}
          </div>
        </div>,
          document.body,
        )}
      </div>
      <FieldError message={props.error} />
    </div>
  );
}

/** <x-forms.collapsible>: "Advanced settings", closed at first. */
export function Collapsible({ title = "Advanced settings", className = "", contentClassName = "", children }: { title?: string; className?: string; contentClassName?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`flex flex-col gap-4 ${className}`.trim()}>
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-2 text-left text-sm font-medium hover:underline" aria-expanded={open}>
        <svg className={`size-4 transition-transform${open ? " rotate-90" : ""}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
            clipRule="evenodd"
          />
        </svg>
        {title}
      </button>
      <div className={`rounded-lg border border-neutral-200 p-4 dark:border-coolgray-400 ${contentClassName}`.trim()} style={shown(open)}>
        {children}
      </div>
    </div>
  );
}

/** <x-danger-zone>: the "Permanent" card with its action. */
export function DangerZone({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-red-200 bg-red-50 p-5 sm:flex-row sm:items-start sm:justify-between dark:border-red-500/25 dark:bg-red-500/[0.08]">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-sm font-semibold text-black dark:text-fg">{title}</h4>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-0.5 text-xs font-medium text-neutral-700 dark:border-white/[0.08] dark:bg-white/[0.06] dark:text-fg">
            <span className="size-1.5 rounded-full bg-red-500" />
            Permanent
          </span>
        </div>
        <div className="mt-2 max-w-2xl space-y-2 text-[13px] leading-5 text-neutral-600 dark:text-fg-dim">{children}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** <x-forms.button>: "button", highlighted or error; a disabled one explains why in its title. */
export function Button(props: {
  onClick?: () => void;
  type?: "button" | "submit";
  highlighted?: boolean;
  error?: boolean;
  disabled?: boolean;
  tooltip?: string | null;
  className?: string;
  children: ReactNode;
}) {
  const classes = ["button", props.highlighted ? "button-highlighted" : "", props.error ? "button-error" : "", props.className ?? ""].filter(Boolean).join(" ");
  return (
    <button type={props.type ?? "button"} className={classes} disabled={props.disabled} title={props.tooltip ?? undefined} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

/**
 * <x-unsaved-bar>: the floating "unsaved changes" pill while `dirty`; Enter
 * outside a textarea, button or link saves, Reset reloads the page.
 */
export function UnsavedBar({ dirty, saving, onSave, label = "You have changes that haven't been saved yet." }: { dirty: boolean; saving: boolean; onSave: () => void; label?: string }) {
  useEffect(() => {
    if (!dirty || saving) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.repeat || e.isComposing || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
      if ((e.target as Element | null)?.closest("textarea, button, a, select, [contenteditable=true]")) return;
      e.preventDefault();
      onSave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, saving, onSave]);
  const state = `${dirty ? " is-dirty" : ""}${saving ? " is-saving" : ""}`;
  return (
    <div
      className={`pointer-events-none fixed inset-x-3 bottom-[calc(var(--keyboard-inset,0px)+max(1.5rem,env(safe-area-inset-bottom,0px)+0.75rem))] z-[1000] flex max-w-full translate-y-6 scale-95 flex-col items-stretch gap-2 rounded-2xl border border-neutral-200 bg-white py-2.5 pr-2.5 pl-4 opacity-0 shadow-modal transition-[opacity,transform,scale] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] delay-0 dark:border-white/10 dark:bg-surface [&.is-dirty]:pointer-events-auto [&.is-dirty]:translate-y-0 [&.is-dirty]:scale-100 [&.is-dirty]:opacity-100 [&.is-dirty]:delay-300 [&.is-saving]:pointer-events-none [&.is-saving]:translate-y-6 [&.is-saving]:scale-95 [&.is-saving]:opacity-0 [&.is-saving]:duration-200 [&.is-saving]:ease-in [&.is-saving]:delay-0 sm:inset-x-auto sm:left-1/2 sm:bottom-6 sm:w-max sm:max-w-none sm:-translate-x-1/2 sm:flex-row sm:items-center sm:gap-8 sm:py-2 sm:pl-5 sm:pr-2${state}`}
    >
      <span className="text-[13px] font-semibold leading-snug text-neutral-800 dark:text-fg sm:whitespace-nowrap">{label}</span>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="h-8 rounded-lg bg-neutral-100 px-3.5 text-[13px] font-medium text-neutral-700 transition-colors hover:bg-neutral-200 dark:bg-white/[0.07] dark:text-fg dark:hover:bg-white/[0.12]"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="button-highlighted flex h-8 items-center gap-2 rounded-lg px-4 text-[13px] font-semibold transition-[transform,background-color] active:scale-[0.98]"
        >
          <span>Save changes</span>
          <kbd className="rounded border border-current/20 bg-current/10 px-1.5 py-0.5 text-[10px] leading-none font-medium text-current">Enter</kbd>
        </button>
      </div>
    </div>
  );
}
