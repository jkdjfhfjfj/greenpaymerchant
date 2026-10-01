import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { and, eq } from "drizzle-orm";
import { CreateMerchantCaseBody, CreateMerchantInvoiceBody } from "@workspace/api-zod";
import {
  db, merchantInvoiceRemindersTable, merchantInvoicesTable, merchantSupportCasesTable,
  pool,
} from "@workspace/db";
import {
  amountCents, calculateInvoiceLines, invoicePaymentStatus, ownsBusinessResource, parseStatementMonth,
  validateEvidenceUrl,
} from "./merchant-business-tools";
import { assertCollectionAmountPrecision } from "./greenpay-collection";

after(async () => {
  await pool.end();
});

test("invoice line totals use rounded cents and status follows confirmed payment facts", () => {
  const computed = calculateInvoiceLines([
    { description: "  First item  ", quantity: 2, unitAmount: 1.005 },
    { description: "Second item", quantity: 1.5, unitAmount: 3.33 },
  ]);
  assert.equal(computed.lines[0]?.description, "First item");
  assert.equal(computed.lines[0]?.unitAmount, 1.01);
  assert.equal(computed.lines[0]?.total, 2.02);
  assert.equal(computed.total, 7.02);
  assert.equal(amountCents(1.005), 101);
  assert.equal(amountCents(2.675), 268);
  assert.equal(calculateInvoiceLines([{ description: "Fractional quantity", quantity: 2.005, unitAmount: 1.01 }]).total, 2.03);
  assert.throws(() => calculateInvoiceLines([{ description: "Bad quantity", quantity: 0, unitAmount: 1 }]), /quantities must be greater than zero/);
  assert.throws(() => calculateInvoiceLines([{ description: "Excess quantity", quantity: 100_001, unitAmount: 1 }]), /no more than 100,000/);
  assert.doesNotThrow(() => assertCollectionAmountPrecision(computed.total, "USD"));
  assert.throws(() => assertCollectionAmountPrecision(10.25, "KES"), /whole units/);
  const wholeCurrencyInvoice = calculateInvoiceLines([{ description: "Whole unit currency", quantity: 1, unitAmount: 10.005 }]);
  assert.equal(wholeCurrencyInvoice.total, 10.01);
  assert.throws(() => assertCollectionAmountPrecision(wholeCurrencyInvoice.total, "KES"), /whole units/);
  assert.equal(invoicePaymentStatus("sent", 0, 20), "sent");
  assert.equal(invoicePaymentStatus("sent", 4, 20), "partially_paid");
  assert.equal(invoicePaymentStatus("sent", 20, 20), "paid");
  assert.equal(invoicePaymentStatus("void", 20, 20), "void");
  assert.equal(invoicePaymentStatus("draft", 0, 20), "draft");
});

test("statement period, evidence URLs and merchant ownership validation are strict", () => {
  assert.equal(parseStatementMonth("2026-00"), null);
  assert.equal(parseStatementMonth("2026-13"), null);
  assert.equal(parseStatementMonth("2026-04")?.start.toISOString(), "2026-04-01T00:00:00.000Z");
  assert.equal(validateEvidenceUrl("https://evidence.example/report"), "https://evidence.example/report");
  assert.throws(() => validateEvidenceUrl("javascript:alert(1)"), /HTTP or HTTPS/);
  assert.throws(() => validateEvidenceUrl("https://user:password@example.com/file"), /without embedded credentials/);
  assert.equal(ownsBusinessResource(17, 17), true);
  assert.equal(ownsBusinessResource(17, 18), false);
});

test("generated invoice and case schemas reject invalid financial and evidence inputs", () => {
  const invoice = CreateMerchantInvoiceBody.safeParse({
    customerName: "Customer",
    customerEmail: "customer@example.invalid",
    currency: "USD",
    dueDate: "2026-04-30",
    lines: [{ description: "Service", quantity: 1, unitAmount: 12.5 }],
  });
  assert.equal(invoice.success, true);
  const badInvoice = CreateMerchantInvoiceBody.safeParse({
    customerName: "Customer",
    customerEmail: "not-an-email",
    currency: "USD",
    dueDate: "not-a-date",
    lines: [{ description: "Service", quantity: -1, unitAmount: -2 }],
  });
  assert.equal(badInvoice.success, false);
  const badCase = CreateMerchantCaseBody.safeParse({
    kind: "refund",
    transactionReference: "",
    message: "",
    evidenceUrl: "javascript:alert(1)",
  });
  assert.equal(badCase.success, false);
});

test("invoice and reminder persistence remains tenant-scoped with explicit unconfigured delivery", async () => {
  const merchantId = 1_900_000_000 + Math.floor(Math.random() * 10_000_000);
  const reference = `INV-TEST-${randomUUID()}`;
  let invoiceId: number | undefined;
  try {
    const [invoice] = await db.insert(merchantInvoicesTable).values({
      merchantId,
      reference,
      customerName: "Persistence test customer",
      customerEmail: "private@example.invalid",
      currency: "USD",
      dueDate: "2026-04-30",
      lines: [{ description: "Service", quantity: 1, unitAmount: 7.25, total: 7.25 }],
      subtotal: 7.25,
      total: 7.25,
      status: "sent",
    }).returning();
    invoiceId = invoice.id;

    const [owned] = await db.select().from(merchantInvoicesTable).where(and(
      eq(merchantInvoicesTable.id, invoice.id),
      eq(merchantInvoicesTable.merchantId, merchantId),
    )).limit(1);
    const [otherTenant] = await db.select().from(merchantInvoicesTable).where(and(
      eq(merchantInvoicesTable.id, invoice.id),
      eq(merchantInvoicesTable.merchantId, merchantId + 1),
    )).limit(1);
    assert.equal(owned?.id, invoice.id);
    assert.equal(otherTenant, undefined);

    const [reminder] = await db.insert(merchantInvoiceRemindersTable).values({
      merchantId, invoiceId: invoice.id, deliveryStatus: "unconfigured",
      message: "Email delivery is not configured; no email was sent.",
    }).returning();
    assert.equal(reminder.deliveryStatus, "unconfigured");
    assert.equal(reminder.attemptedAt, null);

    const [edited] = await db.update(merchantInvoicesTable).set({
      note: "Saved edit", status: "void",
    }).where(and(eq(merchantInvoicesTable.id, invoice.id), eq(merchantInvoicesTable.merchantId, merchantId))).returning();
    assert.equal(edited.note, "Saved edit");
    assert.equal(edited.status, "void");
    await db.delete(merchantInvoiceRemindersTable).where(eq(merchantInvoiceRemindersTable.id, reminder.id));
  } finally {
    if (invoiceId) {
      await db.delete(merchantInvoiceRemindersTable).where(eq(merchantInvoiceRemindersTable.invoiceId, invoiceId));
      await db.delete(merchantInvoicesTable).where(eq(merchantInvoicesTable.id, invoiceId));
    }
  }
});

test("case thread text and URL evidence persist without crossing merchant ownership", async () => {
  const merchantId = 1_900_000_000 + Math.floor(Math.random() * 10_000_000);
  let caseId: number | undefined;
  try {
    const [created] = await db.insert(merchantSupportCasesTable).values({
      merchantId,
      kind: "dispute",
      transactionReference: `TX-${randomUUID()}`,
      status: "requested",
      financialMovement: "requested",
      messages: [{
        id: randomUUID(), authorRole: "merchant", message: "Please review this dispute.",
        evidenceUrl: "https://evidence.example/dispute", createdAt: new Date().toISOString(),
      }],
    }).returning();
    caseId = created.id;
    const [ownerView] = await db.select().from(merchantSupportCasesTable).where(and(
      eq(merchantSupportCasesTable.id, created.id), eq(merchantSupportCasesTable.merchantId, merchantId),
    ));
    const [foreignView] = await db.select().from(merchantSupportCasesTable).where(and(
      eq(merchantSupportCasesTable.id, created.id), eq(merchantSupportCasesTable.merchantId, merchantId + 1),
    ));
    assert.equal(ownerView.messages[0]?.evidenceUrl, "https://evidence.example/dispute");
    assert.equal(foreignView, undefined);
    const [reviewed] = await db.update(merchantSupportCasesTable).set({
      status: "in_review",
      financialMovement: "recorded",
      messages: [...created.messages, {
        id: randomUUID(), authorRole: "admin", message: "Review opened; no funds moved.",
        evidenceUrl: null, createdAt: new Date().toISOString(),
      }],
    }).where(eq(merchantSupportCasesTable.id, created.id)).returning();
    assert.equal(reviewed.status, "in_review");
    assert.equal(reviewed.financialMovement, "recorded");
    assert.equal(reviewed.messages.length, 2);
  } finally {
    if (caseId) await db.delete(merchantSupportCasesTable).where(eq(merchantSupportCasesTable.id, caseId));
  }
});