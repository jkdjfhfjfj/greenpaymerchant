const FX_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const FX_FETCH_TIMEOUT_MS = 8_000;

export type WalletFxRateCandidate = {
  rate: number;
  source: string;
  sourceDate: string;
};

type Fetcher = typeof fetch;

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function sourcePublicationDateIsFresh(sourceDate: string | undefined, now: Date): boolean {
  if (!sourceDate || !/^\d{4}-\d{2}-\d{2}$/.test(sourceDate)) return false;
  const sourceDay = new Date(`${sourceDate}T00:00:00.000Z`);
  return !Number.isNaN(sourceDay.getTime()) &&
    sourceDay.toISOString().slice(0, 10) === sourceDate &&
    sourceDay.getTime() <= now.getTime() + 60_000 &&
    now.getTime() - sourceDay.getTime() <= FX_MAX_AGE_MS;
}

function publicationDate(value: unknown): string | undefined {
  const text = stringValue(value);
  if (!text) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10);
}

function candidate(rateValue: unknown, dateValue: unknown, source: string, now: Date): WalletFxRateCandidate | null {
  const rate = numberValue(rateValue);
  const sourceDate = publicationDate(dateValue);
  if (!rate || rate <= 0 || !sourceDate || !sourcePublicationDateIsFresh(sourceDate, now)) return null;
  return { rate, source, sourceDate };
}

async function readJson(fetcher: Fetcher, url: string, headers: Record<string, string> = {}) {
  const response = await fetcher(url, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(FX_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("FX source unavailable.");
  return asObject(await response.json());
}

async function currencyApiRate(
  from: string,
  to: string,
  apiKey: string,
  now: Date,
  fetcher: Fetcher,
): Promise<WalletFxRateCandidate | null> {
  const url = new URL("https://api.currencyapi.com/v3/latest");
  url.searchParams.set("base_currency", from);
  url.searchParams.set("currencies", to);
  const body = await readJson(fetcher, url.toString(), { apikey: apiKey });
  const meta = asObject(body.meta);
  const data = asObject(asObject(body.data)[to]);
  return candidate(data.value, meta.last_updated_at, "CurrencyAPI live rates", now);
}

async function openExchangeRatesRate(
  from: string,
  to: string,
  now: Date,
  fetcher: Fetcher,
): Promise<WalletFxRateCandidate | null> {
  const body = await readJson(fetcher, `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`);
  if (body.result !== "success" || stringValue(body.base_code)?.toUpperCase() !== from) return null;
  return candidate(
    asObject(body.rates)[to],
    body.time_last_update_utc,
    "ExchangeRate-API public feed",
    now,
  );
}

async function frankfurterRate(
  from: string,
  to: string,
  now: Date,
  fetcher: Fetcher,
): Promise<WalletFxRateCandidate | null> {
  const endpoints = [
    `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`,
    `https://api.frankfurter.app/latest?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  ];
  for (const url of endpoints) {
    try {
      const body = await readJson(fetcher, url);
      const rate = candidate(asObject(body.rates)[to], body.date, "Frankfurter reference rates", now);
      if (rate) return rate;
    } catch {
      // Try the public mirror before moving to the next provider.
    }
  }
  return null;
}

async function fawazRate(
  from: string,
  to: string,
  now: Date,
  fetcher: Fetcher,
): Promise<WalletFxRateCandidate | null> {
  const baseCode = from.toLowerCase();
  const targetCode = to.toLowerCase();
  const endpoints = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/${baseCode}.json`,
    `https://raw.githubusercontent.com/fawazahmed0/currency-api/latest/v1/currencies/${baseCode}.json`,
  ];
  for (const url of endpoints) {
    try {
      const body = await readJson(fetcher, url);
      const rate = candidate(
        asObject(body[baseCode])[targetCode],
        body.date,
        "Fawaz currency-api daily reference rates",
        now,
      );
      if (rate) return rate;
    } catch {
      // Try the mirror before moving to the next provider.
    }
  }
  return null;
}

export async function fetchWalletFxRateCandidate(
  from: string,
  to: string,
  apiKey: string | null,
  now: Date,
  fetcher: Fetcher = fetch,
): Promise<WalletFxRateCandidate | null> {
  const attempts: Array<() => Promise<WalletFxRateCandidate | null>> = [
    ...(apiKey ? [() => currencyApiRate(from, to, apiKey, now, fetcher)] : []),
    () => openExchangeRatesRate(from, to, now, fetcher),
    () => frankfurterRate(from, to, now, fetcher),
    () => fawazRate(from, to, now, fetcher),
  ];
  for (const attempt of attempts) {
    try {
      const rate = await attempt();
      if (rate) return rate;
    } catch {
      // A failed or stale source does not prevent trying the next public feed.
    }
  }
  return null;
}