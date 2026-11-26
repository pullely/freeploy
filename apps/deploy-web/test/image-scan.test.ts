// DP-114: the Security pages' state as Livewire's properties keep it, the queries that carry it, the state changes of the
// pages' methods, the ignore modal's options and the export menu's copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  countOf,
  environmentOfPath,
  exportMenu,
  fleetQuery,
  fleetStateFromUrl,
  fleetUrl,
  ignoreModal,
  INITIAL_FINDINGS,
  INITIAL_FLEET,
  INITIAL_PACKAGES,
  resetFindingFilters,
  resetFleetFilters,
  resourceQuery,
  sbomFromPath,
  sbomPath,
  selectImage,
  serversNotScanningTitle,
  setFindings,
  setFixState,
  severityBadge,
  showImageFindings,
  showPackageImage,
  splitSentence,
  toggleFleet,
  togglePackageType,
  toggleSeverity,
  whyMoreText,
  otherFixesText,
} from "../src/lib/image-scan.ts";

test("a resource page's state travels as the query the API reads", () => {
  assert.equal(resourceQuery(INITIAL_FINDINGS, INITIAL_PACKAGES), "");
  const f = { ...INITIAL_FINDINGS, fixState: "no_fix", severities: ["critical", "high"], images: ["nginx:alpine"], view: "cve", search: "zlib", showIgnored: true, page: 2, perPage: 25 };
  const p = { ...INITIAL_PACKAGES, search: "open", types: ["apk"], images: ["nginx:alpine"], page: 3, perPage: 50 };
  assert.equal(
    resourceQuery(f, p),
    "?fixState=no_fix&severities=critical%2Chigh&images=nginx%3Aalpine&view=cve&search=zlib&showIgnored=1&page=2&perPage=25&packagesSearch=open&packagesTypes=apk&packagesImages=nginx%3Aalpine&packagesPage=3&packagesPerPage=50",
  );
});

test("the findings' methods change the state as Livewire's do", () => {
  const paged = { ...INITIAL_FINDINGS, page: 4, showIgnored: true };
  assert.deepEqual(setFixState(paged, "no_fix"), { ...INITIAL_FINDINGS, fixState: "no_fix" });
  assert.equal(setFixState(paged, "open").fixState, "fixed");
  assert.deepEqual(toggleSeverity(INITIAL_FINDINGS, "high").severities, ["high"]);
  assert.deepEqual(toggleSeverity({ ...INITIAL_FINDINGS, severities: ["high"] }, "high").severities, []);
  assert.equal(toggleSeverity(INITIAL_FINDINGS, "urgent"), INITIAL_FINDINGS);
  assert.deepEqual(resetFindingFilters({ ...paged, severities: ["low"], search: "x" }), { ...paged, severities: [], search: "x", page: 1 });
  const refs = ["nginx:alpine", "redis:7"];
  assert.deepEqual(selectImage(paged, "redis:7", refs), { ...paged, images: ["redis:7"], showIgnored: false, page: 1 });
  assert.deepEqual(selectImage({ ...paged, images: ["redis:7"] }, "", refs).images, []);
  assert.equal(showImageFindings(paged, "mysql:8", refs), paged);
  assert.equal(setFindings(paged, { search: "a" }).page, 1);
  assert.equal(setFindings(paged, { page: 3 }).page, 3);
  assert.deepEqual(togglePackageType(INITIAL_PACKAGES, "apk").types, ["apk"]);
  assert.deepEqual(showPackageImage({ ...INITIAL_PACKAGES, images: ["a"] }, "").images, []);
});

test("the team page's filters, query and address", () => {
  assert.deepEqual(toggleFleet(INITIAL_FLEET, "statuses", "update_now").statuses, ["update_now"]);
  assert.equal(toggleFleet(INITIAL_FLEET, "statuses", "broken"), INITIAL_FLEET);
  const s = { ...INITIAL_FLEET, search: "CVE-1", statuses: ["ok"], servers: ["s1"], projects: ["p1"], showNotChecked: true, page: 2, perPage: 50 };
  assert.equal(fleetQuery(s), "?search=CVE-1&statuses=ok&servers=s1&projects=p1&showNotChecked=1&page=2&perPage=50");
  assert.deepEqual(resetFleetFilters(s), { ...s, servers: [], projects: [], statuses: [], page: 1 });
  // #[Url]: search, statuses and showNotChecked only.
  assert.equal(fleetUrl(s), "/vulnerabilities?search=CVE-1&statuses=ok&showNotChecked=1");
  assert.equal(fleetUrl(INITIAL_FLEET), "/vulnerabilities");
  assert.deepEqual(fleetStateFromUrl("?search=x&statuses=ok,bad&showNotChecked=1"), { ...INITIAL_FLEET, search: "x", statuses: ["ok"], showNotChecked: true });
});

test("the views' copy", () => {
  assert.deepEqual(exportMenu(1, "finding"), { intro: "The 1 finding in this list, from all pages.", markdownDone: "Copied 1 finding as Markdown.", idsDone: "Copied the IDs of 1 finding.", noClipboard: "The clipboard needs HTTPS or localhost.", copyFailed: "Could not copy the list." });
  assert.equal(exportMenu(1234, "resource").intro, "The 1,234 resources in this list, from all pages.");
  assert.deepEqual([severityBadge("critical"), severityBadge("bogus"), severityBadge("low", 3)], [{ type: "severity-critical", label: "Critical" }, { type: "neutral", label: "Unknown" }, { type: "severity-low", label: "3 low" }]);
  assert.deepEqual(ignoreModal("package", false, false), {
    title: "Ignore package",
    scopeOptions: [{ value: "resource", label: "This resource" }],
    expiresOptions: [{ value: "30", label: "30 days" }, { value: "90", label: "90 days" }],
    expiresHelper: "Attackers are using or are likely to use this problem, so its ignore expires.",
  });
  assert.deepEqual(ignoreModal("vulnerability", true, true).scopeOptions.map((o) => o.label), ["This resource", "All team resources"]);
  assert.deepEqual(ignoreModal("vulnerability", true, true).expiresOptions.at(-1), { value: "never", label: "Never" });
  assert.deepEqual(splitSentence("nginx:alpine has a fix.", "nginx:alpine"), { ref: "nginx:alpine", rest: " has a fix." });
  assert.deepEqual(splitSentence("This app has a fix.", "nginx:alpine"), { ref: null, rest: "This app has a fix." });
  assert.deepEqual([whyMoreText(1), whyMoreText(2), otherFixesText(1), otherFixesText(3)], ["1 more problem this update fixes", "2 more problems this update fixes", "1 other fix", "3 other fixes"]);
  assert.deepEqual([countOf(1, "package"), countOf(1200, "finding")], ["1 package", "1,200 findings"]);
  assert.deepEqual([serversNotScanningTitle(1), serversNotScanningTitle(2)], ["1 server does not scan images.", "2 servers do not scan images."]);
});

test("an SBOM download's route", () => {
  const resource = "/project/p1/environment/e1/application/a1";
  assert.equal(sbomPath(resource, "scan 1", "spdx"), `${resource}/vulnerabilities/sbom/scan%201/spdx`);
  assert.deepEqual(sbomFromPath(`${resource}/vulnerabilities/sbom/scan%201/spdx`), { resourcePath: resource, scanUuid: "scan 1", format: "spdx" });
  assert.equal(sbomFromPath(`${resource}/vulnerabilities`), null);
  assert.equal(environmentOfPath(`${resource}/vulnerabilities/sbom/s/cyclonedx`), "e1");
});
