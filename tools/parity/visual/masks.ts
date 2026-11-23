// The only regions the visual gate may ignore: values that differ between any
// two runs of the same system (timestamps, generated ids, metrics charts,
// avatars) and the brand mark. Masking anything else to hide a real
// difference is not allowed (ground rule: never add a mask to pass a gate).
import type { Page } from "playwright";

export const MASK_ATTR = "data-parity-mask";
export const MASK_SELECTOR = [
  `[${MASK_ATTR}]`,
  // brand marks: Coolify's logo/wordmark in the reference, Freeploy's in the port
  'img[src*="coolify-logo"]',
  'img[alt*="Coolify" i]',
  "[data-brand]",
  // avatars and charts
  'img[src*="/avatar"]',
  "canvas",
  ".apexcharts-canvas",
  "[x-ref=\"chart\"]",
].join(", ");

/** Mark leaf elements whose text is a generated id or a timestamp. */
export async function prepareMasks(page: Page): Promise<void> {
  await page.evaluate((attr) => {
    // A generated id has letters AND digits (cuid2); a long lowercase word
    // such as "excludedcontenttypes" is copy and must never be masked.
    const id = /^\s*(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{20,32}\s*$/;
    const ip = /\b\d{1,3}(\.\d{1,3}){3}\b/;
    const uuid = /^\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$/i;
    const time = /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|\b\d+ (seconds?|minutes?|hours?|days?) ago\b|\b\d{1,2}:\d{2}(:\d{2})?\s?(AM|PM)?\b/;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent ?? "";
      if (!t.trim()) continue;
      if (id.test(t) || uuid.test(t) || time.test(t) || ip.test(t)) n.parentElement?.setAttribute(attr, "");
    }
    for (const el of document.querySelectorAll("input[readonly], input[disabled]")) {
      const v = (el as HTMLInputElement).value;
      if (id.test(v) || uuid.test(v)) el.setAttribute(attr, "");
    }
  }, MASK_ATTR);
}
