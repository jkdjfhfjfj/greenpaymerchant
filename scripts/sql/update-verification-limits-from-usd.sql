-- Set verification tier caps from USD equivalents using the latest current
-- USD -> currency rates in greenpay_wallet_fx_rates.
--
-- This upserts only the listed collection-catalog currencies; unrelated
-- verification-limit rows are preserved. Missing/stale FX rates abort the
-- transaction before any limits are changed.
--
-- SLL is intentionally excluded. Do not apply an FX conversion to SLL until
-- the provider confirms which numeric denomination its SLL requests use.
--
-- Run this against the intended database only after reviewing the target and
-- current rate cache. Amounts are rounded down to the currency's minor-unit
-- precision so the resulting cap does not exceed its USD equivalent.

BEGIN;

DO $check_rates$
DECLARE
  missing_currencies text;
BEGIN
  SELECT string_agg(c.currency, ', ' ORDER BY c.currency)
  INTO missing_currencies
  FROM (VALUES
    ('KES'), ('NGN'), ('GHS'), ('TZS'), ('XOF'), ('RWF'),
    ('UGX'), ('ZMW'), ('MWK'), ('CDF'), ('MZN'), ('XAF')
  ) AS c(currency)
  WHERE NOT EXISTS (
    SELECT 1
    FROM greenpay_wallet_fx_rates AS f
    WHERE f.from_currency = 'USD'
      AND f.to_currency = c.currency
      AND f.rate > 0
      AND f.fetched_at <= now()
      AND f.expires_at > now()
      AND f.source_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      AND (f.source_date::date::timestamp AT TIME ZONE 'UTC')
        BETWEEN now() - interval '48 hours' AND now() + interval '1 minute'
  );

  IF missing_currencies IS NOT NULL THEN
    RAISE EXCEPTION 'No current USD FX rate for: %. No limits were changed.', missing_currencies;
  END IF;

  RAISE NOTICE 'SLL is excluded because its amount denomination is unverified.';
END
$check_rates$;

WITH currencies(currency, minor_units) AS (
  VALUES
    ('USD', 2),
    ('KES', 0),
    ('NGN', 2),
    ('GHS', 2),
    ('TZS', 2),
    ('XOF', 0),
    ('RWF', 0),
    ('UGX', 0),
    ('ZMW', 2),
    ('MWK', 2),
    ('CDF', 2),
    ('MZN', 2),
    ('XAF', 0)
),
usd_limits(
  tier,
  single_collection_usd,
  daily_collections_usd,
  monthly_collections_usd,
  payout_usd,
  conversion_usd
) AS (
  VALUES
    ('unverified', 100::numeric, 200::numeric, 1000::numeric, 200::numeric, 200::numeric),
    ('kyc',        500::numeric, 500::numeric, 2000::numeric, 500::numeric, 500::numeric),
    ('kyb',       1000::numeric, 2000::numeric, 10000::numeric, 2000::numeric, 2000::numeric)
),
current_fx_rates AS (
  SELECT DISTINCT ON (f.to_currency)
    f.to_currency AS currency,
    f.rate
  FROM greenpay_wallet_fx_rates AS f
  WHERE f.from_currency = 'USD'
    AND f.fetched_at <= now()
    AND f.expires_at > now()
    AND f.rate > 0
    AND f.source_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND (f.source_date::date::timestamp AT TIME ZONE 'UTC')
      BETWEEN now() - interval '48 hours' AND now() + interval '1 minute'
  ORDER BY f.to_currency, f.fetched_at DESC, f.id DESC
),
resolved_rates AS (
  SELECT 'USD'::varchar AS currency, 1::numeric AS rate
  UNION ALL
  SELECT currency, rate
  FROM current_fx_rates
)
INSERT INTO greenpay_verification_tier_limits (
  tier,
  currency,
  collection_per_transaction_limit,
  collection_daily_limit,
  collection_monthly_limit,
  payout_limit,
  conversion_limit,
  updated_at
)
SELECT
  limits.tier,
  currencies.currency,
  floor(limits.single_collection_usd * resolved_rates.rate * power(10::numeric, currencies.minor_units))
    / power(10::numeric, currencies.minor_units),
  floor(limits.daily_collections_usd * resolved_rates.rate * power(10::numeric, currencies.minor_units))
    / power(10::numeric, currencies.minor_units),
  floor(limits.monthly_collections_usd * resolved_rates.rate * power(10::numeric, currencies.minor_units))
    / power(10::numeric, currencies.minor_units),
  floor(limits.payout_usd * resolved_rates.rate * power(10::numeric, currencies.minor_units))
    / power(10::numeric, currencies.minor_units),
  floor(limits.conversion_usd * resolved_rates.rate * power(10::numeric, currencies.minor_units))
    / power(10::numeric, currencies.minor_units),
  now()
FROM currencies
JOIN resolved_rates ON resolved_rates.currency = currencies.currency
CROSS JOIN usd_limits AS limits
ON CONFLICT (tier, currency) DO UPDATE SET
  collection_per_transaction_limit = EXCLUDED.collection_per_transaction_limit,
  collection_daily_limit = EXCLUDED.collection_daily_limit,
  collection_monthly_limit = EXCLUDED.collection_monthly_limit,
  payout_limit = EXCLUDED.payout_limit,
  conversion_limit = EXCLUDED.conversion_limit,
  updated_at = now()
RETURNING
  tier,
  currency,
  collection_per_transaction_limit,
  collection_daily_limit,
  collection_monthly_limit,
  payout_limit,
  conversion_limit,
  updated_at;

COMMIT;