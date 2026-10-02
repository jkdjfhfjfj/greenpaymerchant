import assert from "node:assert/strict";
import test from "node:test";
import { fetchWalletFxRateBatchCandidate, fetchWalletFxRateCandidate } from "./wallet-fx-rates";

const now = new Date("2026-10-02T12:00:00.000Z");

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 503,
    json: async () => body,
  } as Response;
}

test("wallet FX rate uses a configured CurrencyAPI key before public fallbacks", async () => {
  const requests: Array<{ url: string; headers?: Record<string, string> }> = [];
  const rate = await fetchWalletFxRateCandidate("USD", "EUR", "masked-test-key", now, async (input, init) => {
    requests.push({ url: String(input), headers: init?.headers as Record<string, string> | undefined });
    return response({
      meta: { last_updated_at: "2026-10-02T10:00:00Z" },
      data: { EUR: { value: 0.92 } },
    });
  });

  assert.deepEqual(rate, {
    rate: 0.92,
    source: "CurrencyAPI live rates",
    sourceDate: "2026-10-02",
  });
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0]?.headers), /apikey/);
});

test("wallet FX rate falls back to Frankfurter when the first public feed is invalid", async () => {
  const requests: string[] = [];
  const rate = await fetchWalletFxRateCandidate("USD", "EUR", null, now, async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("open.er-api.com")) return response({ result: "error" });
    if (url.includes("frankfurter.dev")) {
      return response({ date: "2026-10-02", rates: { EUR: 0.91 } });
    }
    throw new Error(`Unexpected source: ${url}`);
  });

  assert.deepEqual(rate, {
    rate: 0.91,
    source: "Frankfurter reference rates",
    sourceDate: "2026-10-02",
  });
  assert.equal(requests.length, 2);
});

test("wallet FX rate rejects stale provider results and falls back to the next source", async () => {
  const rate = await fetchWalletFxRateCandidate("USD", "EUR", null, now, async (input) => {
    const url = String(input);
    if (url.includes("open.er-api.com")) {
      return response({
        result: "success",
        base_code: "USD",
        time_last_update_utc: "Tue, 28 Sep 2026 00:00:00 +0000",
        rates: { EUR: 0.89 },
      });
    }
    if (url.includes("frankfurter.dev")) {
      return response({ date: "2026-10-02", rates: { EUR: 0.91 } });
    }
    throw new Error(`Unexpected source: ${url}`);
  });

  assert.equal(rate?.source, "Frankfurter reference rates");
  assert.equal(rate?.rate, 0.91);
});

test("wallet FX rate batch loads multiple targets with one configured provider request", async () => {
  const requests: string[] = [];
  const rates = await fetchWalletFxRateBatchCandidate("USD", ["EUR", "GBP"], "masked-test-key", now, async (input) => {
    const url = String(input);
    requests.push(url);
    return response({
      meta: { last_updated_at: "2026-10-02T10:00:00Z" },
      data: { EUR: { value: 0.92 }, GBP: { value: 0.81 } },
    });
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0] ?? "", /currencies=EUR%2CGBP/);
  assert.deepEqual(Object.fromEntries(Object.entries(rates ?? {}).map(([currency, rate]) => [currency, rate.rate])), {
    EUR: 0.92,
    GBP: 0.81,
  });
  assert.equal(rates?.EUR?.source, "CurrencyAPI live rates");
  assert.equal(rates?.GBP?.sourceDate, "2026-10-02");
});

test("wallet FX rate batch rejects incomplete provider results and falls back to a complete feed", async () => {
  const requests: string[] = [];
  const rates = await fetchWalletFxRateBatchCandidate("USD", ["EUR", "GBP"], "masked-test-key", now, async (input) => {
    const url = String(input);
    requests.push(url);
    if (url.includes("currencyapi.com")) {
      return response({
        meta: { last_updated_at: "2026-10-02T10:00:00Z" },
        data: { EUR: { value: 0.92 } },
      });
    }
    return response({
      result: "success",
      base_code: "USD",
      time_last_update_utc: "Fri, 02 Oct 2026 00:00:00 +0000",
      rates: { EUR: 0.91, GBP: 0.80 },
    });
  });

  assert.equal(requests.length, 2);
  assert.equal(rates?.EUR?.source, "ExchangeRate-API public feed");
  assert.equal(rates?.GBP?.rate, 0.8);
});