// Derived from coollabsio/coolify@91b7e3e:resources/views/layouts/base.blade.php (Apache-2.0), modified.
// Coolify reads the theme from localStorage before render ('dark' default,
// 'light', 'system') and toggles the `dark` class on <html>.
export function applyStoredTheme(): void {
  let theme = "dark";
  try {
    theme = localStorage.getItem("theme") === "purple" ? "custom" : localStorage.getItem("theme") || "dark";
  } catch {
    /* storage blocked: Coolify's default */
  }
  const isDark = theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
}
