// Derived from coollabsio/coolify@91b7e3e:resources/views/components/toast.blade.php (Apache-2.0), modified.
// window.toast(message, { type, description }): Livewire's dispatch('success' |
// 'error' | 'info' | 'warning', message) becomes a toast of that type.
export type ToastType = "success" | "info" | "warning" | "danger" | "default";
export interface ToastDetail {
  type: ToastType;
  message: string;
  description: string;
}

export function toast(message: string, options: { type?: ToastType; description?: string } = {}): void {
  window.dispatchEvent(new CustomEvent<ToastDetail>("toast-show", { detail: { type: options.type ?? "default", message, description: options.description ?? "" } }));
}

/** Livewire's dispatch('success' | 'error', …) as Coolify's layout maps them. */
export const notify = {
  success: (message: string) => toast(message, { type: "success" }),
  error: (message: string) => toast(message, { type: "danger" }),
};
