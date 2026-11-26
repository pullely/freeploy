// DP-102: SelectTeam's mount() and selectTeam() on Freeploy's org switching, the Maintenance Mode confirmation's copy,
// the Swarm form, and the service Domains page's groups and search.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  domainGroups,
  maintenanceConfirmation,
  matchesDomainSearch,
  selectTeam,
  selectTeamMount,
  serviceApplicationOptions,
  swarmDirty,
  swarmFormOf,
  teamInitial,
  type ServiceDomainApp,
  type ServiceDomainRow,
} from "../src/lib/config-subpages.ts";

const org = (slug: string, name = slug) => ({ id: `org_${slug}`, name, slug });

test("SelectTeam::mount(): a current team, or at most one team, goes to the dashboard; the only team becomes current", () => {
  assert.deepEqual(selectTeamMount([], null), { action: "redirect", store: null });
  assert.deepEqual(selectTeamMount([org("a")], null), { action: "redirect", store: "a" });
  assert.deepEqual(selectTeamMount([org("a")], "a"), { action: "redirect", store: null });
  // The stored team is gone (left, or deleted): the only one is used.
  assert.deepEqual(selectTeamMount([org("a")], "gone"), { action: "redirect", store: "a" });
  assert.deepEqual(selectTeamMount([org("a"), org("b")], "b"), { action: "redirect", store: null });
  assert.deepEqual(selectTeamMount([org("a"), org("b")], null), { action: "show" });
  assert.deepEqual(selectTeamMount([org("a"), org("b")], "gone"), { action: "show" });
});

test("SelectTeam::selectTeam(): only one of the user's teams; the initial is the name's first letter, upper-cased", () => {
  assert.equal(selectTeam([org("a"), org("b")], "b"), "b");
  assert.equal(selectTeam([org("a")], "other"), null);
  assert.equal(teamInitial("ünited"), "Ü");
  assert.equal(teamInitial(""), "");
});

test("maintenance.blade.php: the toggle's confirmation, on and off", () => {
  assert.deepEqual(maintenanceConfirmation(false), {
    title: "Enable maintenance mode?",
    buttonTitle: "Enable maintenance",
    step2ButtonText: "Enable maintenance",
    isErrorButton: true,
    warningMessage: "Visitors cannot reach this resource until you disable maintenance mode.",
    actions: ["All domains of this resource show the maintenance page with a 503 status.", "The containers keep running."],
  });
  assert.equal(maintenanceConfirmation(true).title, "Disable maintenance mode?");
  assert.equal(maintenanceConfirmation(true).isErrorButton, false);
  assert.deepEqual(maintenanceConfirmation(true).actions, ["All domains of this resource serve the resource again."]);
});

test("Swarm: the form of the stored settings, and what makes it unsaved", () => {
  const saved = { swarmReplicas: 2, swarmPlacementConstraints: null, isSwarmOnlyWorkerNodes: true };
  const form = swarmFormOf(saved);
  assert.deepEqual(form, { swarmReplicas: "2", swarmPlacementConstraints: "", isSwarmOnlyWorkerNodes: true });
  assert.equal(swarmDirty(form, saved), false);
  assert.equal(swarmDirty({ ...form, swarmReplicas: "3" }, saved), true);
  assert.equal(swarmDirty({ ...form, swarmPlacementConstraints: "placement:" }, saved), true);
  // The node placement saves itself (instantSave): it never leaves the form unsaved.
  assert.equal(swarmDirty({ ...form, isSwarmOnlyWorkerNodes: false }, saved), false);
});

const app = (uuid: string, name: string, extra: Partial<ServiceDomainApp> = {}): ServiceDomainApp => ({ uuid, name, heading: name[0]!.toUpperCase() + name.slice(1), image: null, requiredPort: null, redirect: "both", isForceHttpsEnabled: true, isPermanentRedirectEnabled: false, ...extra });
const row = (serviceApplicationUuid: string, url: string, dnsStatus = "pending"): ServiceDomainRow => ({
  serviceApplicationUuid, serviceName: serviceApplicationUuid, url, publicUrl: url, internalPort: null, hasPortOverride: false, dnsStatus, dnsMessage: "", expectedIp: null, checkedAt: null, isNoindexed: false, parts: { scheme: "https", host: "", port: "", path: "" },
});

test("domains.blade.php: the rows grouped by application in their order, each group's https flag and search value", () => {
  const apps = [app("a", "api"), app("w", "web", { image: "nginx:alpine" })];
  // The failed DNS checks come first (buildDomainRows()), so the web group is first.
  const groups = domainGroups([row("w", "https://web.example.com", "failed"), row("a", "http://api.example.com"), row("w", "http://www.web.example.com")], apps);
  assert.deepEqual(groups.map((g) => [g.app.uuid, g.rows.map((r) => r.url), g.hasHttpsDomains, g.searchValue]), [
    ["w", ["https://web.example.com", "http://www.web.example.com"], true, "Web https://web.example.com http://www.web.example.com"],
    ["a", ["http://api.example.com"], false, "Api http://api.example.com"],
  ]);
  // A row of an application that is gone is not shown.
  assert.deepEqual(domainGroups([row("x", "https://x.example.com")], apps), []);
  assert.equal(matchesDomainSearch("Web https://web.example.com", "  WEB "), true);
  assert.equal(matchesDomainSearch("Web https://web.example.com", "api"), false);
  assert.equal(matchesDomainSearch("anything", " "), true);
  assert.deepEqual(serviceApplicationOptions(apps), [
    { value: "a", label: "api" },
    { value: "w", label: "web (nginx:alpine)" },
  ]);
});
