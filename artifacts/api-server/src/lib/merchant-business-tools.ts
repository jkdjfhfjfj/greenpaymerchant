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

export function parseStatementMonth(value: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}$/.test(value)) return null;
  const [year, month] = value.split("-").map(Number);
  if (month < 1 || month > 12) return null;
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
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