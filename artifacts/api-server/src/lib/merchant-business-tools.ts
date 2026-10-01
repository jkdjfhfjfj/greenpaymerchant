import type { InvoiceLineRecord } from "@workspace/db";

export function calculateInvoiceLines(lines: Array<{ description: string; quantity: number; unitAmount: number }>): {
  lines: InvoiceLineRecord[];
  total: number;
} {
  if (!Array.isArray(lines) || lines.length < 1 || lines.length > 100) {
    throw Object.assign(new Error("Invoices must contain between 1 and 100 line items."), { statusCode: 400 });
  }
  let totalCents = 0n;
  const priced = lines.map((line) => {
    if (!Number.isFinite(line.quantity) || line.quantity <= 0 || line.quantity > 100_000) {
      throw Object.assign(new Error("Line item quantities must be greater than zero and no more than 100,000."), { statusCode: 400 });
    }
    if (!Number.isFinite(line.unitAmount) || line.unitAmount < 0 || line.unitAmount > 100_000_000) {
      throw Object.assign(new Error("Unit amounts must be finite, non-negative, and no more than 100,000,000."), { statusCode: 400 });
    }
    const unitCents = amountCentsInteger(line.unitAmount);
    const lineCents = multiplyAndRound(unitCents, line.quantity);
    totalCents += lineCents;
    return {
      description: line.description.trim(),
      quantity: line.quantity,
      unitAmount: safeCents(unitCents) / 100,
      total: safeCents(lineCents) / 100,
    };
  });
  return { lines: priced, total: safeCents(totalCents) / 100 };
}

export function amountCents(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw Object.assign(new Error("Amounts must be finite and non-negative."), { statusCode: 400 });
  return safeCents(amountCentsInteger(value));
}

function amountCentsInteger(value: number): bigint {
  const { numerator, denominator } = decimalFraction(value);
  return roundRatio(numerator * 100n, denominator);
}

function multiplyAndRound(cents: bigint, quantity: number): bigint {
  const { numerator, denominator } = decimalFraction(quantity);
  return roundRatio(cents * numerator, denominator);
}

function decimalFraction(value: number): { numerator: bigint; denominator: bigint } {
  const [mantissa, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = exponentText ? Number(exponentText) : 0;
  const [whole, fraction = ""] = mantissa!.split(".");
  const digits = BigInt(`${whole}${fraction}`);
  const decimalPower = exponent - fraction.length;
  if (decimalPower >= 0) return { numerator: digits * (10n ** BigInt(decimalPower)), denominator: 1n };
  return { numerator: digits, denominator: 10n ** BigInt(-decimalPower) };
}

function roundRatio(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function safeCents(cents: bigint): number {
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw Object.assign(new Error("The invoice total is too large to represent precisely in cents."), { statusCode: 400 });
  }
  return Number(cents);
}

export function invoicePaymentStatus(status: string, paidAmount: number, total: number): string {
  if (status === "void" || status === "draft") return status;
  return paidAmount >= total ? "paid" : paidAmount > 0 ? "partially_paid" : "sent";
}

export function invoiceOutstandingAmount(total: number, paidAmount: number): number {
  if (!Number.isFinite(total) || !Number.isFinite(paidAmount) || total < 0 || paidAmount < 0) {
    throw Object.assign(new Error("Invoice balances must be finite and non-negative."), { statusCode: 400 });
  }
  return Math.max(0, Math.round((total - paidAmount) * 100) / 100);
}

export function caseAttachmentName(value: string, contentType: string): string {
  const name = value.trim().replaceAll("\\", "/").split("/").at(-1) ?? "";
  const extension = contentType === "application/pdf" ? ".pdf"
    : contentType === "image/png" ? ".png"
      : contentType === "image/jpeg" ? ".jpg" : "";
  if (!extension || !name || name.length > 180 || /[\u0000-\u001f\u007f]/.test(name) ||
      !name.toLowerCase().endsWith(extension) && !(contentType === "image/jpeg" && name.toLowerCase().endsWith(".jpeg"))) {
    throw Object.assign(new Error("Choose a PDF, PNG, or JPEG file with a matching file extension."), { statusCode: 400 });
  }
  return name;
}

export function csvSafeCell(value: string | number | null | undefined): string {
  let text = String(value ?? "");
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function parseStatementMonth(value: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}$/.test(value)) return null;
  const [year, month] = value.split("-").map(Number);
  if (month < 1 || month > 12) return null;
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

export function confirmedStatementRows<T extends { status: string }>(
  rows: T[],
  confirmedStatuses: readonly string[],
): T[] {
  const allowed = new Set(confirmedStatuses);
  return rows.filter((row) => allowed.has(row.status));
}

export function statementCashDate<T extends { createdAt: Date; confirmedAt: Date | null }>(row: T) {
  return {
    cashDate: row.confirmedAt ?? row.createdAt,
    cashDateBasis: row.confirmedAt ? "confirmed_at" as const : "legacy_created_at" as const,
  };
}

export function confirmedWalletPayoutsInMonth<
  T extends { status: string; completedAt: Date | null },
>(
  rows: T[],
  confirmedStatuses: readonly string[],
  start: Date,
  end: Date,
): T[] {
  return confirmedStatementRows(rows, confirmedStatuses).filter((row) =>
    row.completedAt !== null && row.completedAt >= start && row.completedAt < end);
}

export function confirmedStatementPayouts<
  T extends { reference: string; status: string },
  U extends { reference: string },
>(
  legacyPayouts: T[],
  walletPayouts: U[],
  confirmedStatuses: readonly string[],
): T[] {
  const walletBackedReferences = new Set(walletPayouts.map((row) => row.reference));
  return confirmedStatementRows(legacyPayouts, confirmedStatuses)
    .filter((row) => !walletBackedReferences.has(row.reference));
}

export function validateEvidenceUrl(value: string | undefined): string | null {
  if (!value) return null;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw Object.assign(new Error("Evidence links must be public HTTP or HTTPS URLs without embedded credentials."), { statusCode: 400 });
  }
  return url.toString();
}

export function ownsBusinessResource(resourceMerchantId: number, currentMerchantId: number): boolean {
  return resourceMerchantId === currentMerchantId;
}