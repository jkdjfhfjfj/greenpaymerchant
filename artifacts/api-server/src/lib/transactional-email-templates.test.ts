import assert from "node:assert/strict";
import test from "node:test";
import { renderTransactionalEmail } from "./transactional-email-templates";

test("Greenpay customer receipt preserves the authoritative original amount and currency", () => {
  const receipt = renderTransactionalEmail("payment_receipt", {
    reference: "GP-RECEIPT-1",
    amount: "123456.70",
    currency: "SLL",
    customerName: "Ama",
    receiptUrl: null,
  });
  assert.match(receipt.subject, /Greenpay/);
  assert.match(receipt.text, /123456\.70 SLL/);
  assert.match(receipt.text, /original payment amount and currency exactly as confirmed/);
  assert.doesNotMatch(receipt.text, /USD/);
});

test("email template escapes untrusted HTML while retaining support reply content", () => {
  const reply = renderTransactionalEmail("support_reply", {
    ticketReference: "GP-ABC",
    subject: "Help",
    body: '<script>alert("bad")</script>',
  });
  assert.doesNotMatch(reply.html, /<script>/);
  assert.match(reply.html, /&lt;script&gt;/);
  assert.match(reply.text, /<script>/);
});

test("receipt and invitation templates omit links without an approved URL", () => {
  const receipt = renderTransactionalEmail("payment_receipt", {
    reference: "GP-RECEIPT-2",
    amount: "1",
    currency: "SLL",
    receiptUrl: null,
  });
  const invitation = renderTransactionalEmail("team_invitation", {
    businessName: "Kono Trading",
    inviteUrl: null,
    role: "finance",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });
  assert.doesNotMatch(receipt.html, /href=/);
  assert.doesNotMatch(invitation.html, /href=/);
});

test("email links are restricted to the explicitly configured deployment origin", () => {
  const previous = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = "https://app.greenpay.example";
  try {
    const externalReceipt = renderTransactionalEmail("payment_receipt", {
      reference: "GP-RECEIPT-3",
      amount: "1",
      currency: "SLL",
      receiptUrl: "https://attacker.example/status/GP-RECEIPT-3",
    });
    const officialReceipt = renderTransactionalEmail("payment_receipt", {
      reference: "GP-RECEIPT-4",
      amount: "1",
      currency: "SLL",
      receiptUrl: "https://app.greenpay.example/status/GP-RECEIPT-4",
    });
    assert.doesNotMatch(externalReceipt.html, /href=/);
    assert.match(officialReceipt.html, /href="https:\/\/app\.greenpay\.example\/status\/GP-RECEIPT-4"/);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = previous;
  }
});

test("invoice reminders include the outstanding balance and only an approved payment link", () => {
  const previous = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = "https://app.greenpay.example";
  try {
    const reminder = renderTransactionalEmail("invoice_reminder", {
      customerName: "Ama",
      businessName: "Kono Trading",
      invoiceReference: "INV-42",
      amount: "75.00",
      currency: "USD",
      dueDate: "2030-03-01",
      paymentUrl: "https://app.greenpay.example/pay/current-balance",
    });
    assert.match(reminder.text, /Remaining balance: 75\.00 USD/);
    assert.match(reminder.html, /href="https:\/\/app\.greenpay\.example\/pay\/current-balance"/);

    const unapproved = renderTransactionalEmail("invoice_reminder", {
      customerName: "Ama",
      businessName: "Kono Trading",
      invoiceReference: "INV-42",
      amount: "75.00",
      currency: "USD",
      paymentUrl: "https://attacker.example/pay",
    });
    assert.doesNotMatch(unapproved.html, /href=/);
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_APP_URL;
    else process.env.PUBLIC_APP_URL = previous;
  }
});