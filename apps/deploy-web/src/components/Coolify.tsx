// Derived from coollabsio/coolify@91b7e3e:resources/views/components/{helper,modal-input,
// modal-confirmation,status-badge,empty,callout,copy-button,loading}.blade.php and
// resources/views/components/forms/{input,textarea,button}.blade.php (Apache-2.0), modified.
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
function DangerCallout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="relative rounded-lg border px-3 py-2.5 border-red-300/60 bg-red-50 dark:border-red-500/20 dark:bg-red-500/[0.07] mb-4">
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

/** <x-forms.input> (text). */
export function FormInput(props: {
  id?: string;
  label?: string;
  value: string;
  onChange?: (v: string) => void;
  required?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
  helper?: string;
  error?: string | undefined;
  loading?: boolean;
}) {
  return (
    <div className="w-full">
      {props.label ? <Label label={props.label} required={props.required} helper={props.helper} /> : null}
      {props.loading ? (
        <div className="input flex w-full items-center text-neutral-500 dark:text-fg-dim" aria-busy="true">
          <Loading />
        </div>
      ) : (
        <input
          autoComplete="off"
          className="input"
          required={props.required}
          readOnly={props.readOnly}
          disabled={props.disabled}
          type="text"
          id={props.id}
          name={props.id}
          placeholder=""
          value={props.value}
          onChange={(e) => props.onChange?.(e.target.value)}
        />
      )}
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
                <DangerCallout title="Warning">This operation is permanent and cannot be undone. Please think again before proceeding!</DangerCallout>
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
                    <p className="mb-2 text-[12px] leading-5 text-neutral-500 dark:text-fg-dim">Please confirm the execution of the actions by entering the Name below</p>
                    <div className="relative mb-2">
                      <div className="relative">
                        <input type="text" readOnly className="input" value={props.confirmationText ?? ""} />
                        <CopyButton value={props.confirmationText ?? ""} className="absolute top-1/2 right-2 -translate-y-1/2" />
                      </div>
                    </div>
                    <label htmlFor="userConfirmationText" className="mt-4 mb-1.5 block text-[12px] font-medium text-neutral-700 dark:text-fg-dim">
                      Name
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
