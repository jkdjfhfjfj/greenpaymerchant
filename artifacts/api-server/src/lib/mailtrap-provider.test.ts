import assert from "node:assert/strict";
import test from "node:test";
import {
  MAILTRAP_SEND_URL,
  MailtrapConfigurationError,
  submitMailtrapEmail,
} from "./mailtrap-provider";

const message = {
  fromEmail: "payments@greenpay.example",
  fromName: "Greenpay",
  toEmail: "customer@example.com",
  subject: "Payment receipt",
  text: "Confirmed payment",
  html: "<p>Confirmed payment</p>",
  category: "payment_receipt",
};

test("Mailtrap POST includes documented endpoint, bearer auth and explicit acceptance payload", async () => {
  let requestedUrl = "";
  let requestInit: RequestInit | undefined;
  const result = await submitMailtrapEmail(message, {
    env: { MAILTRAP_API_TOKEN: "test-only-token" },
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      requestInit = init;
      return new Response(JSON.stringify({ success: true, message_ids: ["accepted-id"] }), { status: 200 });
    },
  });
  assert.equal(requestedUrl, MAILTRAP_SEND_URL);
  assert.equal(requestInit?.method, "POST");
  assert.equal(new Headers(requestInit?.headers).get("authorization"), "Bearer test-only-token");
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    from: { email: message.fromEmail, name: "Greenpay" },
    to: [{ email: message.toEmail }],
    subject: message.subject,
    text: message.text,
    html: message.html,
    category: message.category,
  });
  assert.deepEqual(result, { kind: "accepted", messageId: "accepted-id" });
});

test("missing server credentials fail explicitly without making an HTTP request", async () => {
  let called = false;
  await assert.rejects(
    submitMailtrapEmail(message, {
      env: {},
      fetchImpl: async () => {
        called = true;
        return new Response("{}", { status: 200 });
      },
    }),
    MailtrapConfigurationError,
  );
  assert.equal(called, false);
});

test("transport errors and server errors stay uncertain rather than being retried", async () => {
  const env = { MAILTRAP_API_KEY: "test-only-key" };
  const timeout = await submitMailtrapEmail(message, {
    env,
    fetchImpl: async () => { throw new Error("test timeout"); },
  });
  const serverError = await submitMailtrapEmail(message, {
    env,
    fetchImpl: async () => new Response("temporary failure", { status: 503 }),
  });
  assert.equal(timeout.kind, "uncertain");
  assert.equal(serverError.kind, "uncertain");
});

test("provider acceptance must be explicit; definite rate-limit rejections are safely retryable", async () => {
  const env = { MAILTRAP_API_TOKEN: "test-only-token" };
  const unclear = await submitMailtrapEmail(message, {
    env,
    fetchImpl: async () => new Response(JSON.stringify({ success: false }), { status: 200 }),
  });
  const throttled = await submitMailtrapEmail(message, {
    env,
    fetchImpl: async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "3" },
    }),
  });
  assert.deepEqual(unclear, {
    kind: "uncertain",
    message: "Mailtrap returned no explicit acceptance confirmation; delivery is held for review.",
  });
  assert.deepEqual(throttled, {
    kind: "rejected",
    retryable: true,
    retryAfterMs: 3000,
    message: "Mailtrap rate-limited the request.",
  });
});