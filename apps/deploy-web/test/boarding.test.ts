// Boarding's steps in the URL (DP-75, src/lib/boarding.ts): Coolify's #[Url(as: 'step')] $currentState.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARDING_STEPS, boardingStep, boardingUrl, NOT_AVAILABLE } from "../src/lib/boarding.ts";

test("the step comes from ?step=, the welcome screen when it is missing or unknown", () => {
  assert.equal(boardingStep(""), "welcome");
  assert.equal(boardingStep("?step=create-project"), "create-project");
  assert.equal(boardingStep("?step=validate-server&x=1"), "validate-server");
  assert.equal(boardingStep("?step=nope"), "welcome");
  assert.equal(boardingStep("?step="), "welcome");
  assert.deepEqual(BOARDING_STEPS.map((s) => boardingStep(`?step=${s}`)), [...BOARDING_STEPS]);
});

test("a step's URL keeps the other parameters; the welcome screen has none", () => {
  assert.equal(boardingUrl("https://deploy.example.com/onboarding", "private-key"), "https://deploy.example.com/onboarding?step=private-key");
  assert.equal(boardingUrl("https://deploy.example.com/onboarding?step=private-key&a=1", "create-server"), "https://deploy.example.com/onboarding?step=create-server&a=1");
  assert.equal(boardingUrl("https://deploy.example.com/onboarding?step=create-server", "welcome"), "https://deploy.example.com/onboarding");
});

test("what Freeploy cannot do yet says so", () => {
  for (const message of Object.values(NOT_AVAILABLE)) assert.match(message, /not available yet/);
});
