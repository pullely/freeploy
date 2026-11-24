// Derived from coollabsio/coolify@91b7e3e:resources/views/components/reicon.blade.php (Apache-2.0), modified.
// <x-reicon name="…" class="…" />: the glyph inside Coolify's svg wrapper.
import { REICON_PATHS } from "./generated/reicon-paths";

export function Reicon({ name, className = "", style }: { name: string; className?: string; style?: { display: "none" } }) {
  const isDanger = name === "danger";
  const svg = REICON_PATHS[isDanger ? "shield-alert" : name] ?? "";
  const classes = ["size-4", isDanger ? "text-error" : "", className].filter(Boolean).join(" ");
  return <svg className={classes} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={style} dangerouslySetInnerHTML={{ __html: svg }} />;
}
