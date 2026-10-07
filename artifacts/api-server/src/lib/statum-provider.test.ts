import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyStatumSubmission } from "./statum-provider";

test("Statum 5xx responses are returned as unresolved purchases rather than request errors", () => {
  assert.deepEqual(classifyStatumSubmission(502, { message: "Bad gateway" }), {
    kind: "unknown",
    reason: "Airtime purchase is awaiting provider confirmation. The reserved Greenpay balance remains held.",
  });
});

test("Statum insufficient provider airtime credit stays unresolved and retains the reservation", () => {
  assert.deepEqual(classifyStatumSubmission(400, { result_desc: "Insufficient account balance" }), {
    kind: "unknown",
    reason: "Airtime purchase is awaiting confirmation because provider airtime is unavailable. The Greenpay balance remains reserved; do not retry with a new request.",
  });
});

test("a Statum request ID is accepted for callback reconciliation, while definitive input errors are rejected", () => {
  assert.deepEqual(classifyStatumSubmission(502, { request_id: "statum-request-1" }), {
    kind: "accepted",
    requestId: "statum-request-1",
  });
  assert.deepEqual(classifyStatumSubmission(400, { result_desc: "Invalid destination number" }), {
    kind: "rejected",
    reason: "Invalid destination number",
  });
});
