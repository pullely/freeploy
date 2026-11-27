// DP-116: the image scanning settings pages' decisions — the rules' helpers per level, the inherit option of a level that
// inherits, the host findings' state and its query, the scanner's checkpoints, and the pages' own copy ("Freeploy" where
// Coolify's Blade says "Coolify").
import { test } from "node:test";
import assert from "node:assert/strict";
import { gateHelper, hostQuery, inheritedOptions, INITIAL_HOST, otherKernelsLine, removeUnusedSupported, rulesHelper, scanCostText, scannerCheckpoints, scanningSectionHelper, setHost } from "../src/lib/image-scan.ts";

test("scan-settings.blade.php's helpers of each level", () => {
  assert.equal(rulesHelper("instance"), "Defaults for every team. A team, server, or app can set its own value.");
  assert.equal(rulesHelper("team"), "Defaults for the servers and apps of this team. A server or app can set its own value.");
  assert.equal(rulesHelper("server"), "Defaults for the apps on this server. An app can set its own value.");
  assert.equal(rulesHelper("application"), "Rules for this app.");
  assert.equal(gateHelper("team"), "Default for apps. Stop a deploy when the new image has security problems.");
  assert.equal(gateHelper("application"), "Stop a deploy when the new image has security problems.");
});

test("<x-forms.inherited-listbox>: an inherit option for a level that inherits, none for the instance", () => {
  const options = [
    { value: "deploy", label: "Deploy anyway" },
    { value: "block", label: "Block the deploy" },
  ];
  assert.deepEqual(inheritedOptions(null, options), options);
  assert.deepEqual(inheritedOptions("Use Coolify default (Deploy anyway)", options)[0], { value: "", label: "Use Coolify default (Deploy anyway)" });
});

test("HostVulnerabilities' state: the query and the first page after each change", () => {
  assert.equal(hostQuery(INITIAL_HOST), "");
  const s = setHost({ ...INITIAL_HOST, page: 3 }, { search: "openssl" });
  assert.equal(s.page, 1);
  assert.equal(hostQuery({ ...s, sortBy: "severity_desc", showOtherKernels: true, page: 2, perPage: 25 }), "?search=openssl&sortBy=severity_desc&showOtherKernels=1&page=2&perPage=25");
  assert.equal(setHost(s, { page: 4 }).page, 4);
});

test("the scanner's checkpoints: never got (Freeploy keeps no scanner state), and each state Coolify shows", () => {
  assert.deepEqual(scannerCheckpoints(null, null, "docker.io", null), { pull: { status: "idle", description: "Not done yet." }, database: { status: "idle", description: "Not done yet." } });
  assert.equal(scannerCheckpoints("failed", "pulling", "docker.io", null).pull.description, "Freeploy could not pull the scanner images. Check that the server can reach docker.io.");
  assert.equal(scannerCheckpoints("failed", "updating_database", "docker.io", null).database.description, "Freeploy could not download the vulnerability database.");
  assert.equal(scannerCheckpoints("ready", null, "docker.io", "2 days ago").database.description, "Database built 2 days ago.");
  assert.equal(scannerCheckpoints("pulling", null, "docker.io", null).database.status, "pending");
});

test("the server page's copy says Freeploy", () => {
  const cost = scanCostText("1", "1 GB");
  assert.equal(cost, "Scans use up to 1 CPU and 1 GB of memory while they run, and about 1.2 GB of disk, plus temporary space for one image.");
  const helper = scanningSectionHelper("Syft 1.55.0, Grype 0.121.0, regctl 0.11.7", null, null, cost);
  assert.match(helper, /Freeploy also scans the operating system packages/);
  assert.match(helper, /Freeploy downloads the latest vulnerability database every day/);
  assert.doesNotMatch(helper, /Coolify|Database built/);
  assert.equal(otherKernelsLine(1, false), "1 vulnerability in installed kernels that do not run hidden. No risk now.");
  assert.equal(otherKernelsLine(3, true), "3 vulnerabilities in installed kernels that do not run shown. No risk now.");
  assert.deepEqual(["apt", "dnf", "zypper", "apk", null].map(removeUnusedSupported), [true, true, true, false, false]);
});
