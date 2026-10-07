import assert from "node:assert/strict";
import { test } from "node:test";
import { apiKeyEnvironmentAllowed } from "./security-policy";

test("live keys are accepted only by live API routes", () => {
  assert.equal(apiKeyEnvironmentAllowed("live", "live"), true);
  assert.equal(apiKeyEnvironmentAllowed("live", "sandbox"), false);
});

test("sandbox keys are accepted only by sandbox API routes", () => {
  assert.equal(apiKeyEnvironmentAllowed("sandbox", "sandbox"), true);
  assert.equal(apiKeyEnvironmentAllowed("sandbox", "live"), false);
});

test("environment checks reject missing or unknown key environments", () => {
  assert.equal(apiKeyEnvironmentAllowed(undefined, "live"), false);
  assert.equal(apiKeyEnvironmentAllowed("unknown", "sandbox"), false);
});
