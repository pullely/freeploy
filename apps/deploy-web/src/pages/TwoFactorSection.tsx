// Derived from coollabsio/coolify@91b7e3e:resources/views/livewire/profile/index.blade.php
// (the two-factor section), components/status-badge.blade.php, forms/copy-input.blade.php
// and Laravel Fortify's twoFactorQrCodeSvg() (Apache-2.0 / MIT), modified.
// The section's three states: off (the generated markup), setup pending (QR
// code, one-time code, manual setup) and enabled (recovery codes, disable).
import { useState, type FormEvent, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { Reicon } from "../components/Reicon";

export interface TwoFactorState {
  enabled: boolean;
  pending: boolean;
  secret?: string;
  url?: string;
}

/** Fortify's QR code: 192 px, slate (45,55,72) on white, as an SVG of filled modules. */
export function QrSvg({ text }: { text: string }) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const d: string[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d.push(`M${c} ${r}h1v1h-1z`);
  return (
    <svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="192" height="192" viewBox={`-2 -2 ${n + 4} ${n + 4}`}>
      <rect x="-2" y="-2" width={n + 4} height={n + 4} fill="rgb(255,255,255)" />
      <path fill="rgb(45,55,72)" d={d.join("")} />
    </svg>
  );
}

function CopyInput({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="w-full">
      <div className="relative">
        <input type="text" value={text} readOnly onFocus={(e) => e.target.select()} className="input input-with-copy-button bg-white dark:bg-coolgray-100 dark:read-only:bg-coolgray-100 dark:read-only:text-white" />
        <button
          type="button"
          title="Copy to clipboard"
          aria-label="Copy to clipboard"
          className="icon-button group shrink-0 absolute top-1/2 right-2 -translate-y-1/2"
          onClick={() => void navigator.clipboard.writeText(text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
        >
          <span className="inline-flex transition-transform duration-150 ease-out group-active:scale-75">
            <Reicon name={copied ? "check" : "copy"} className={copied ? "size-3.5 text-success" : "size-3.5"} />
          </span>
        </button>
      </div>
    </div>
  );
}

/** <x-status-badge status="Enabled" type="success" />. */
export function EnabledBadge() {
  return (
    <span className="inline-flex max-w-full items-center whitespace-nowrap text-neutral-700 dark:text-fg gap-1.5 text-[13px]">
      <span className="relative flex size-1.5 shrink-0">
        <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
      </span>
      <span className="truncate">Enabled</span>
    </span>
  );
}

export function PendingSetup({ state, onConfirm }: { state: TwoFactorState; onConfirm: (e: FormEvent<HTMLFormElement>) => void }) {
  const [showCode, setShowCode] = useState(false);
  return (
    <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="flex aspect-square items-center justify-center rounded-[10px] border border-neutral-200 bg-white p-5 dark:border-white/[0.07]">
        {state.url ? <QrSvg text={state.url} /> : null}
      </div>
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-black dark:text-fg">Finish setup</h3>
          <p className="mt-1 text-sm text-neutral-500 dark:text-fg-dim">Scan the QR code, then enter the current code from your authenticator.</p>
        </div>
        <form action="/user/confirmed-two-factor-authentication" method="POST" className="flex items-end gap-2" onSubmit={onConfirm}>
          <div className="w-full min-w-0">
            <div className="mb-1.5 flex h-4 w-full items-center gap-1.5">
              <label htmlFor="code" className="mb-0! flex items-center gap-1 text-sm font-medium leading-4">
                One-time code<span className="text-helper">*</span>
              </label>
            </div>
            <input type="text" name="code" id="code" inputMode="numeric" pattern="[0-9]*" required autoFocus autoComplete="one-time-code" className="input" />
          </div>
          <button className="button" type="submit">
            Validate 2FA
          </button>
        </form>
        <div>
          {showCode ? (
            <div className="space-y-2 pb-3">
              <CopyInput text={state.secret ?? ""} />
              <CopyInput text={state.url ?? ""} />
            </div>
          ) : null}
          <button className="button" type="button" onClick={() => setShowCode(!showCode)}>
            <span>{showCode ? "Hide manual setup" : "Show manual setup"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export function EnabledBody({ codes, onRegenerate, onDisable }: { codes: string[] | null; onRegenerate: (e: FormEvent<HTMLFormElement>) => void; onDisable: (e: FormEvent<HTMLFormElement>) => void }): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <form action="/user/two-factor-recovery-codes" method="POST" onSubmit={onRegenerate}>
          <button className="button" type="submit">
            Regenerate recovery codes
          </button>
        </form>
        <form action="/user/two-factor-authentication" method="POST" onSubmit={onDisable}>
          <button className="button button-error" type="submit">
            Disable 2FA
          </button>
        </form>
      </div>
      {codes ? (
        <div className="grid gap-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4 font-mono text-xs text-neutral-700 sm:grid-cols-2 dark:border-white/[0.07] dark:bg-white/[0.05] dark:text-fg-dim">
          {codes.map((c) => (
            <div key={c}>{c}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
