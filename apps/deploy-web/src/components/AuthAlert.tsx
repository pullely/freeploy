// Derived from coollabsio/coolify@91b7e3e:resources/views/components/auth/alert.blade.php (Apache-2.0), modified.
import type { ReactNode } from "react";
import { Reicon } from "./Reicon";

const STYLES = {
  success: "border-success/35 bg-success/10 text-success",
  error: "border-error/35 bg-error/10 text-error",
  warning: "border-warning/35 bg-warning/10 text-warning",
  info: "border-neutral-300 bg-neutral-100 text-neutral-700 dark:border-white/10 dark:bg-white/[0.04] dark:text-fg-dim",
} as const;
const ICONS = { success: "check-circle", error: "alert-circle", warning: "alert-triangle", info: "info-circle" } as const;

export function AuthAlert({ type = "info", children }: { type?: keyof typeof STYLES; children: ReactNode }) {
  return (
    <div className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm ${STYLES[type]}`}>
      <Reicon name={ICONS[type]} className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 leading-5">{children}</div>
    </div>
  );
}

/** Laravel's `$errors->all()` block: one <p> per message. */
export function ErrorList({ errors }: { errors: string[] }) {
  if (!errors.length) return null;
  return (
    <AuthAlert type="error">
      <div className="flex flex-col gap-1">
        {errors.map((e, i) => (
          <p key={i}>{e}</p>
        ))}
      </div>
    </AuthAlert>
  );
}
