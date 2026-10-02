import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { inArray } from "drizzle-orm";
import { ListSettlementsQueryParams, ListSettlementsResponse } from "@workspace/api-zod";
import { db, pool, settlementsTable } from "@workspace/db";
import { filterSettlements } from "./greenpay-ledger";

after(async () => {
  await pool.end();
});

test("settlement history search reaches rows beyond 1,000 with bounded pages and confirmed dates", async () => {
  const marker = `settlement-history-${randomUUID()}`;
  const references = Array.from({ length: 1_005 }, (_, index) => `${marker}-${index}`);
  const fixtures = references.map((reference, index) => ({
    reference,
    provider: "paystack",
    amount: 100,
    netAmount: 98,
    currency: "USD",
    status: index >= 1_000 ? "settled" : "pending",
    expectedAt: new Date("2024-02-10T00:00:00.000Z"),
    settledAt: index >= 1_000 ? new Date("2024-02-12T15:30:00.000Z") : null,
  }));

  try {
    for (let start = 0; start < fixtures.length; start += 250) {
      await db.insert(settlementsTable).values(fixtures.slice(start, start + 250));
    }

    const firstPage = await filterSettlements({ search: marker, page: 1, perPage: 100 });
    assert.equal(firstPage.total, 1_005);
    assert.equal(firstPage.items.length, 100);
    assert.equal(firstPage.totalPages, 11);
    assert.ok(firstPage.currencies.includes("USD"));

    const lastPage = await filterSettlements({ search: marker, page: 11, perPage: 100 });
    assert.equal(lastPage.items.length, 5);
    assert.equal(lastPage.items[0]?.reference, references[1_000]);
    assert.equal(lastPage.items[0]?.settledAt?.toISOString(), "2024-02-12T15:30:00.000Z");
    ListSettlementsResponse.parse(lastPage);

    const settledOnly = await filterSettlements({
      search: marker,
      status: "settled",
      currency: "USD",
      expectedFrom: "2024-02-10",
      expectedTo: "2024-02-10",
      settledFrom: "2024-02-12",
      settledTo: "2024-02-12",
      page: 1,
      perPage: 100,
    });
    assert.equal(settledOnly.total, 5);
    assert.equal(settledOnly.items.every((item) => item.status === "settled" && item.settledAt !== null), true);
    assert.equal(ListSettlementsQueryParams.safeParse({ perPage: 101 }).success, false);
  } finally {
    await db.delete(settlementsTable).where(inArray(settlementsTable.reference, references));
  }
});