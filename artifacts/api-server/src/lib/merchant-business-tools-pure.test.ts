import assert from "node:assert/strict";
import { test } from "node:test";
import {
  caseAttachmentName, confirmedStatementPayouts, confirmedStatementRows, confirmedWalletPayoutsInMonth,
  csvSafeCell, invoiceOutstandingAmount, statementCashDate,
} from "./merchant-business-tools";
import { payoutConfirmationTimestamp } from "./payment-safety";

test("invoice balances stay non-negative and rounded to currency cents", () => {
  assert.equal(invoiceOutstandingAmount(25, 7.12), 17.88);
  assert.equal(invoiceOutstandingAmount(25, 28), 0);
  assert.equal(invoiceOutstandingAmount(4.01, 4.005), 0);
  assert.throws(() => invoiceOutstandingAmount(Number.POSITIVE_INFINITY, 0), /finite and non-negative/);
});

test("private evidence filenames must match an allowed, safe extension", () => {
  assert.equal(caseAttachmentName("receipts/refund.pdf", "application/pdf"), "refund.pdf");
  assert.equal(caseAttachmentName("evidence.JPG", "image/jpeg"), "evidence.JPG");
  assert.throws(() => caseAttachmentName("statement.pdf", "image/png"), /matching file extension/);
  assert.throws(() => caseAttachmentName(" bad\nname.jpg", "image/jpeg"), /matching file extension/);
});

test("CSV output quotes content and neutralizes formula-leading values", () => {
  assert.equal(csvSafeCell("=HYPERLINK(\"https://unsafe.example\")"), '"\'=HYPERLINK(""https://unsafe.example"")"');
  assert.equal(csvSafeCell("  +SUM(A1:A2)"), '"\'  +SUM(A1:A2)"');
  assert.equal(csvSafeCell("ordinary, text"), '"ordinary, text"');
  assert.equal(csvSafeCell(null), '""');
});

test("statement confirmed facts exclude pending/recorded rows and deduplicate wallet payouts", () => {
  const confirmedStatuses = ["success", "completed", "processed"];
  const refunds = confirmedStatementRows([
    { reference: "RF-CONFIRMED", status: "processed" },
    { reference: "RF-RECORDED", status: "recorded" },
    { reference: "RF-PENDING", status: "pending" },
  ], confirmedStatuses);
  assert.deepEqual(refunds.map((refund) => refund.reference), ["RF-CONFIRMED"]);

  const legacyPayouts = [
    { reference: "PO-DUPLICATE", status: "success" },
    { reference: "PO-WALLET-PENDING", status: "processed" },
    { reference: "PO-LEGACY-ONLY", status: "completed" },
    { reference: "PO-PENDING", status: "pending" },
  ];
  const walletPayouts = [
    { reference: "PO-DUPLICATE", status: "completed" },
    { reference: "PO-WALLET-PENDING", status: "submitted" },
  ];
  const includedPayouts = confirmedStatementPayouts(legacyPayouts, walletPayouts, confirmedStatuses);
  assert.deepEqual(
    includedPayouts.map((payout) => payout.reference),
    ["PO-LEGACY-ONLY"],
  );
});

test("statement payout cash dates follow completion month and dedupe wallet-backed legacy facts across months", () => {
  const confirmedStatuses = ["success", "completed", "processed"];
  const marchStart = new Date("2026-03-01T00:00:00.000Z");
  const aprilStart = new Date("2026-04-01T00:00:00.000Z");
  const mayStart = new Date("2026-05-01T00:00:00.000Z");
  const walletRequest = {
    reference: "PO-CROSS-MONTH",
    status: "completed",
    amountMinor: 5_000n,
    feeMinor: 300n,
    createdAt: new Date("2026-03-31T23:59:00.000Z"),
    completedAt: aprilStart,
  };
  const olderWalletRequest = {
    ...walletRequest,
    reference: "PO-REQUEST-FEB-LEGACY-MAR",
    createdAt: new Date("2026-02-20T12:00:00.000Z"),
  };
  const legacyPayout = {
    reference: olderWalletRequest.reference,
    status: "completed",
    createdAt: new Date("2026-03-31T23:59:00.000Z"),
    confirmedAt: null,
  };

  const marchWalletCash = confirmedWalletPayoutsInMonth(
    [walletRequest], confirmedStatuses, marchStart, aprilStart,
  );
  const aprilWalletCash = confirmedWalletPayoutsInMonth(
    [walletRequest], confirmedStatuses, aprilStart, mayStart,
  );
  assert.equal(marchWalletCash.length, 0, "creation month is not wallet cash confirmation month");
  assert.equal(aprilWalletCash.length, 1, "wallet completion belongs to April even when requested in March");
  assert.equal(marchWalletCash.reduce((sum, row) => sum + Number(row.amountMinor), 0), 0);
  assert.equal(marchWalletCash.reduce((sum, row) => sum + Number(row.feeMinor), 0), 0,
    "wallet fees must not enter the request-creation month");
  assert.equal(aprilWalletCash.reduce((sum, row) => sum + Number(row.amountMinor) / 100, 0), 50);
  assert.equal(aprilWalletCash.reduce((sum, row) => sum + Number(row.feeMinor) / 100, 0), 3);
  assert.deepEqual(
    confirmedStatementPayouts([legacyPayout], [olderWalletRequest], confirmedStatuses),
    [],
    "known wallet-backed legacy rows are suppressed even if the wallet request was created in February",
  );

  const legacyCashDate = statementCashDate(legacyPayout);
  assert.equal(legacyCashDate.cashDate.toISOString(), "2026-03-31T23:59:00.000Z");
  assert.equal(legacyCashDate.cashDateBasis, "legacy_created_at");
  const confirmedCashDate = statementCashDate({
    ...legacyPayout,
    confirmedAt: aprilStart,
  });
  assert.equal(confirmedCashDate.cashDate.toISOString(), aprilStart.toISOString());
  assert.equal(confirmedCashDate.cashDateBasis, "confirmed_at");

  const sameMonthWallet = {
    ...walletRequest, reference: "PO-SAME-MONTH",
    createdAt: new Date("2026-03-02T00:00:00.000Z"),
    completedAt: new Date("2026-03-15T00:00:00.000Z"),
  };
  const sameMonthLegacy = { ...legacyPayout, reference: "PO-SAME-MONTH" };
  assert.equal(confirmedWalletPayoutsInMonth(
    [sameMonthWallet], confirmedStatuses, marchStart, aprilStart,
  ).length, 1);
  assert.deepEqual(
    confirmedStatementPayouts([sameMonthLegacy], [sameMonthWallet], confirmedStatuses),
    [],
    "same-period wallet cash is also deduplicated against the legacy payout row",
  );
});

test("payout confirmation timestamps are stamped once and never invented for legacy confirmed rows", () => {
  const firstConfirmation = new Date("2026-04-01T10:00:00.000Z");
  assert.equal(
    payoutConfirmationTimestamp("processing", null, "completed", firstConfirmation),
    firstConfirmation,
  );
  assert.equal(
    payoutConfirmationTimestamp("completed", null, "completed", firstConfirmation),
    null,
    "a previously confirmed legacy payout without a persisted confirmation date must retain no fabricated timestamp",
  );
  const prior = new Date("2026-03-31T10:00:00.000Z");
  assert.equal(
    payoutConfirmationTimestamp("completed", prior, "completed", firstConfirmation),
    prior,
    "replayed terminal confirmation preserves its first timestamp",
  );
});