import { useEffect, useMemo, useState } from 'react';
import { Plus, Save, Trash2 } from 'lucide-react';
import {
  getGetAdminVerificationLimitsQueryKey, useGetAdminVerificationLimits, useUpdateAdminVerificationLimits,
  type VerificationTierLimit, type VerificationTierLimitInput,
} from '@workspace/api-client-react';
import { Async, Btn, Card, CURRENCIES, Err, Field, Gate, Heading, Note, fmtDate, nice, useInvalidateAll } from '@/components/kit';

type LimitField = keyof Pick<VerificationTierLimitInput,
  'collectionPerTransactionLimit' | 'collectionDailyLimit' | 'collectionMonthlyLimit' | 'payoutLimit' | 'conversionLimit'>;

const fields: { key: LimitField; label: string }[] = [
  { key: 'collectionPerTransactionLimit', label: 'Single collection' },
  { key: 'collectionDailyLimit', label: 'Daily collections' },
  { key: 'collectionMonthlyLimit', label: 'Monthly collections' },
  { key: 'payoutLimit', label: 'Payout' },
  { key: 'conversionLimit', label: 'Conversion' },
];

function editRow(row: VerificationTierLimit): VerificationTierLimitInput {
  return {
    tier: row.tier, currency: row.currency,
    collectionPerTransactionLimit: row.collectionPerTransactionLimit,
    collectionDailyLimit: row.collectionDailyLimit,
    collectionMonthlyLimit: row.collectionMonthlyLimit,
    payoutLimit: row.payoutLimit, conversionLimit: row.conversionLimit,
  };
}

export function VerificationLimitsPage() {
  return <Gate need="admin"><VerificationLimitsInner /></Gate>;
}

function VerificationLimitsInner() {
  const q = useGetAdminVerificationLimits({ query: {
    queryKey: getGetAdminVerificationLimitsQueryKey(), refetchOnWindowFocus: false,
  } });
  const save = useUpdateAdminVerificationLimits();
  const invalidate = useInvalidateAll();
  const [items, setItems] = useState<VerificationTierLimitInput[]>([]);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (q.data && !initialized) {
      setItems(q.data.items.map(editRow));
      setInitialized(true);
    }
  }, [q.data, initialized]);

  const duplicate = useMemo(() => new Set(items.map((row) => `${row.tier}:${row.currency}`)).size !== items.length, [items]);

  function addRow() {
    setItems((current) => [...current, {
      tier: 'unverified', currency: CURRENCIES[0] ?? '',
      collectionPerTransactionLimit: null, collectionDailyLimit: null,
      collectionMonthlyLimit: null, payoutLimit: null, conversionLimit: null,
    }]);
  }

  function updateRow(index: number, patch: Partial<VerificationTierLimitInput>) {
    setItems((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  }

  function submit() {
    save.mutate({ data: { items } }, {
      onSuccess: (result) => {
        setItems(result.items.map(editRow));
        setInitialized(true);
        void invalidate();
      },
    });
  }

  const empty = initialized && items.length === 0;
  return <>
    <Heading eyebrow="ADMIN / VERIFICATION" title="Verification limits" subtitle="Configure collection, payout and conversion limits for each verification tier and currency." action={<Btn onClick={addRow} testId="button-add-verification-limit"><Plus size={15} />Add currency tier</Btn>} />
    <Async q={q} empty={empty} emptyTitle="No verification limits configured" emptyBody="Add a tier and currency row before enabling financial activity for merchants.">
      <div className="form-stack">
        <Note tone="warn">An empty amount means no tier-specific cap. Limits are checked and reserved by the server during financial operations; these settings do not grant or remove merchant features.</Note>
        <Card title="Tier and currency matrix" subtitle="Use one row per tier and currency. Daily and monthly totals count pending reservations and completed collections.">
          <div className="table-wrap"><table className="dt"><thead><tr><th>Tier</th><th>Currency</th>{fields.map((field) => <th key={field.key}>{field.label}</th>)}<th>Updated</th><th /></tr></thead><tbody>
            {items.map((row, index) => {
              const persisted = q.data?.items.find((entry) => entry.tier === row.tier && entry.currency === row.currency);
              return <tr key={`${index}-${row.tier}-${row.currency}`}>
                <td><select aria-label={`Tier row ${index + 1}`} value={row.tier} onChange={(event) => updateRow(index, { tier: event.target.value as VerificationTierLimitInput['tier'] })}>
                  {(['unverified', 'kyc', 'kyb'] as const).map((tier) => <option key={tier} value={tier}>{nice(tier)}</option>)}
                </select></td>
                <td><select aria-label={`Currency row ${index + 1}`} value={row.currency} onChange={(event) => updateRow(index, { currency: event.target.value })}>
                  {CURRENCIES.map((currency: string) => <option key={currency} value={currency}>{currency}</option>)}
                </select></td>
                {fields.map((field) => <td key={field.key}>
                  <input
                    aria-label={`${field.label} ${row.tier} ${row.currency} cap`}
                    type="number" min="0" step="0.01"
                    value={row[field.key] ?? ''}
                    onChange={(event) => updateRow(index, { [field.key]: event.currentTarget.value === '' ? null : Number(event.currentTarget.value) })}
                    style={{ minWidth: 115 }}
                  />
                </td>)}
                <td>{fmtDate(persisted?.updatedAt)}</td>
                <td><Btn variant="quiet" small onClick={() => setItems((current) => current.filter((_, rowIndex) => rowIndex !== index))} testId={`button-remove-verification-limit-${index}`}><Trash2 size={13} />Remove</Btn></td>
              </tr>;
            })}
          </tbody></table></div>
          {!items.length && <div style={{ padding: 18 }}><Field label="No tier/currency rows yet"><span className="sub">Add a row to configure the active monetary limits.</span></Field></div>}
          <div className="row-actions" style={{ justifyContent: 'space-between', marginTop: 16 }}>
            <Btn variant="secondary" onClick={addRow}><Plus size={14} />Add another row</Btn>
            <div><Err error={duplicate ? 'Remove duplicate tier and currency rows before saving.' : save.error} /><Btn disabled={!items.length || duplicate || save.isPending} onClick={submit} testId="button-save-verification-limits"><Save size={14} />{save.isPending ? 'Saving limits…' : 'Save limits'}</Btn></div>
          </div>
        </Card>
      </div>
    </Async>
  </>;
}