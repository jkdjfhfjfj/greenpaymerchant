import { useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  useCreateMerchantAirtimePurchase,
  useCreateMerchantAirtimeTopup,
  useGetMerchantAirtimeDashboard,
  getGetMerchantAirtimeDashboardQueryKey,
} from '@workspace/api-client-react';
import {
  CreateMerchantAirtimePurchaseBody,
  CreateMerchantAirtimeTopupBody,
} from '@workspace/api-zod';
import { ArrowDownToLine, ArrowUpRight, Clock3, ShieldCheck, Smartphone, Wallet } from 'lucide-react';
import { Async, Btn, Card, Err, Gate, Heading, Modal, Note, Pill, fmtDate, money } from '@/components/kit';
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';

const topupSchema = CreateMerchantAirtimeTopupBody.extend({
  phoneNumber: z.string().trim().min(9).max(20),
});
const purchaseSchema = CreateMerchantAirtimePurchaseBody.extend({
  phoneNumber: z.string().trim().min(9).max(20),
});

type TopupData = z.infer<typeof topupSchema>;
type PurchaseData = z.infer<typeof purchaseSchema>;
type RequestAttempt<T> = { data: T; key: string };

function makeRequestKey() {
  return crypto.randomUUID();
}

function normalizedPhone(value: string) {
  return value.replace(/[^\d+]/g, '');
}

function displayDate(value?: string | null) {
  return fmtDate(value);
}

function AirtimeContent() {
  const queryClient = useQueryClient();
  const [topupConfirmation, setTopupConfirmation] = useState<{
    reference: string;
    phoneNumber: string;
    amount: number;
    status: string;
  } | null>(null);
  const dashboard = useGetMerchantAirtimeDashboard({
    query: {
      queryKey: getGetMerchantAirtimeDashboardQueryKey(),
      refetchInterval: (query) => query.state.data?.topups.some((item) =>
        item.status === 'initiating' || item.status === 'pending',
      ) ? 3_000 : 15_000,
    },
  });
  const [topupAttempt, setTopupAttempt] = useState<RequestAttempt<TopupData> | null>(null);
  const [purchaseAttempt, setPurchaseAttempt] = useState<RequestAttempt<PurchaseData> | null>(null);
  const topupKeyRef = useRef('');
  const purchaseKeyRef = useRef('');

  const topupForm = useForm<TopupData>({
    resolver: zodResolver(topupSchema),
    defaultValues: { phoneNumber: '', amount: 0 },
  });
  const purchaseForm = useForm<PurchaseData>({
    resolver: zodResolver(purchaseSchema),
    defaultValues: { phoneNumber: '', amount: 0 },
  });

  const topup = useCreateMerchantAirtimeTopup({
    request: {
      headers: {
        get 'Idempotency-Key'() {
          return topupKeyRef.current;
        },
      },
    },
    mutation: {
      onSuccess: async ({ topup }) => {
        setTopupConfirmation({
          reference: topup.reference,
          phoneNumber: topup.phoneNumber,
          amount: topup.amount,
          status: topup.status,
        });
        setTopupAttempt(null);
        topupKeyRef.current = makeRequestKey();
        topupForm.reset();
        await queryClient.invalidateQueries({ queryKey: getGetMerchantAirtimeDashboardQueryKey() });
      },
    },
  });
  const purchase = useCreateMerchantAirtimePurchase({
    request: {
      headers: {
        get 'Idempotency-Key'() {
          return purchaseKeyRef.current;
        },
      },
    },
    mutation: {
      onSuccess: async () => {
        setPurchaseAttempt(null);
        purchaseKeyRef.current = makeRequestKey();
        purchaseForm.reset();
        await queryClient.invalidateQueries({ queryKey: getGetMerchantAirtimeDashboardQueryKey() });
      },
    },
  });

  const data = dashboard.data;
  const confirmedTopup = topupConfirmation
    ? data?.topups.find((item) => item.reference === topupConfirmation.reference)
    : undefined;
  const topupStatus = confirmedTopup?.status ?? topupConfirmation?.status;
  const processingPurchases = data?.purchases.filter((item) =>
    ['submitting', 'pending', 'unknown'].includes(item.status),
  ) ?? [];

  function submitTopup(values: TopupData) {
    const attempt = topupAttempt ?? { data: values, key: makeRequestKey() };
    topupKeyRef.current = attempt.key;
    setTopupAttempt(attempt);
    topup.mutate({ data: attempt.data });
  }

  function requestPurchase(values: PurchaseData) {
    if (values.amount > (data?.wallet.availableBalance ?? 0)) {
      purchaseForm.setError('root', {
        message: 'This amount is above the available airtime balance. Fund the airtime wallet or enter a lower amount.',
      });
      return;
    }
    const samePendingRequest = processingPurchases.some((item) =>
      normalizedPhone(item.phoneNumber) === normalizedPhone(values.phoneNumber)
      && item.amount === values.amount,
    );
    if (samePendingRequest) {
      purchaseForm.setError('root', {
        message: 'A purchase for this recipient and amount is still processing. Wait for its final status before trying again.',
      });
      return;
    }
    purchaseForm.clearErrors('root');
    setPurchaseAttempt({ data: values, key: makeRequestKey() });
  }

  function confirmPurchase() {
    if (!purchaseAttempt || purchase.isPending) return;
    purchaseKeyRef.current = purchaseAttempt.key;
    purchase.mutate({ data: purchaseAttempt.data });
  }

  function closePurchaseConfirmation() {
    if (purchase.isPending || purchase.isError) return;
    setPurchaseAttempt(null);
    purchase.reset();
  }

  return (
    <>
      <Heading
        eyebrow="MERCHANT · KENYA"
        title="Airtime wallet"
        subtitle="A dedicated KES balance for airtime—kept separate from your payment and settlement funds."
      />

      <section
        className="airtime-availability panel mb-4 flex flex-col gap-3 border border-[var(--line)] bg-white p-4 sm:flex-row sm:items-center sm:justify-between"
        aria-label="Airtime availability"
        data-testid="airtime-availability"
      >
        <div>
          <strong className="block text-sm">Discounted airtime · Kenya (KES) only</strong>
          <span className="sub">Other countries and currencies are coming soon. Greenpay confirms the final wallet charge for each purchase.</span>
        </div>
        <div className="flex flex-wrap gap-2" aria-label="Supported airtime networks">
          {['Safaricom', 'Airtel', 'Telkom'].map((network) => (
            <span
              key={network}
              className="rounded-full border border-[var(--line)] px-3 py-1 text-xs font-medium text-[var(--ink)]"
            >
              {network}
            </span>
          ))}
        </div>
      </section>

      {topupConfirmation && topupStatus && (
        <div className="mb-4" data-testid="airtime-topup-confirmation">
          <Note
            tone={topupStatus === 'succeeded' ? 'ok' : topupStatus === 'failed' ? 'danger' : 'warn'}
          >
            {topupStatus === 'succeeded' ? (
              <span>
                <strong>Payment confirmed.</strong> {money(topupConfirmation.amount, 'KES')} has been credited to your airtime wallet.
              </span>
            ) : topupStatus === 'failed' ? (
              <span>
                <strong>Funding failed.</strong> The M-Pesa payment did not complete, so no airtime balance was added.
              </span>
            ) : topupStatus === 'unknown' ? (
              <span>
                <strong>Payment status not confirmed yet.</strong> No balance has been credited. Greenpay is checking the M-Pesa payment; do not start a duplicate request.
              </span>
            ) : (
              <span>
                <strong>M-Pesa prompt sent to {topupConfirmation.phoneNumber}.</strong> Waiting for payment confirmation. Your wallet will be credited automatically after the payment is verified.
              </span>
            )}
            <span className="block text-xs">Reference: {topupConfirmation.reference}</span>
          </Note>
        </div>
      )}

      <Async q={dashboard}>
        {data && (
          <div className="airtime-workspace flex flex-col gap-1" data-testid="airtime-dashboard">
            <section className="airtime-wallet panel mb-4 border-[var(--forest)] bg-[var(--forest)] p-5 text-[var(--paper)] shadow-sm" aria-label="Airtime wallet balances">
              <div className="airtime-wallet-heading flex flex-wrap items-center gap-3">
                <span className="airtime-wallet-icon grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-[var(--gold)] text-[var(--ink)]"><Wallet size={19} /></span>
                <div className="min-w-0 flex-1">
                  <div className="eyebrow text-[var(--gold)]">SEPARATE OPERATING BALANCE</div>
                  <h2 className="mt-1 text-lg font-semibold tracking-tight">Your airtime wallet</h2>
                </div>
                <div className="airtime-wallet-updated flex items-center gap-1.5 text-xs text-white/70" data-testid="text-airtime-wallet-updated">
                  <Clock3 size={14} /> Updated {displayDate(data.wallet.updatedAt)}
                </div>
              </div>
              <div className="airtime-balance-grid mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="airtime-available rounded-xl border border-white/15 bg-white/10 p-4" data-testid="metric-airtime-available-balance">
                  <span className="block text-xs font-medium text-white/75">Available to spend</span>
                  <strong className="mt-1 block text-3xl font-semibold tracking-tight">{money(data.wallet.availableBalance, data.wallet.currency)}</strong>
                  <small className="mt-1 block text-xs text-white/65">Ready for manual airtime purchases</small>
                </div>
                <div className="airtime-reserved rounded-xl border border-white/15 bg-black/10 p-4" data-testid="metric-airtime-reserved-balance">
                  <span className="block text-xs font-medium text-white/75">Reserved</span>
                  <strong className="mt-1 block text-3xl font-semibold tracking-tight">{money(data.wallet.reservedBalance, data.wallet.currency)}</strong>
                  <small className="mt-1 block text-xs text-white/65">Held while Greenpay confirms a result</small>
                </div>
              </div>
              <div className="airtime-wallet-foot mt-4 flex items-start gap-2 border-t border-white/15 pt-3 text-xs leading-5 text-white/75">
                <ShieldCheck size={15} />
                <span>Funding and airtime spend stay within this wallet. Payment collections and settlements are not used.</span>
              </div>
            </section>

            {processingPurchases.length > 0 && (
              <Note tone="warn">
                <span data-testid="text-airtime-purchase-processing">
                  {processingPurchases.length === 1
                    ? 'One purchase is processing or has an uncertain result.'
                    : `${processingPurchases.length} purchases are processing or have uncertain results.`}
                  {' '}Funds remain reserved. Do not submit a purchase again while its result is pending or unknown.
                </span>
              </Note>
            )}

            <div className="airtime-action-grid grid grid-cols-1 gap-1 xl:grid-cols-2 xl:gap-4">
              <Card
                title="Fund airtime wallet"
                subtitle="An M-Pesa payment prompt will be sent to the number you enter. The balance updates after payment is confirmed."
                className="airtime-action-card airtime-fund-card"
              >
                <Form {...topupForm}>
                  <form className="form-stack airtime-form" onSubmit={topupForm.handleSubmit(submitTopup)} noValidate>
                    <FormField
                      control={topupForm.control}
                      name="phoneNumber"
                      render={({ field }) => (
                        <FormItem className="field">
                          <FormLabel> M-Pesa phone number </FormLabel>
                          <FormControl>
                            <input
                              {...field}
                              type="tel"
                              autoComplete="tel"
                              placeholder="0712 345 678"
                              disabled={Boolean(topupAttempt)}
                              data-testid="input-airtime-topup-phone"
                            />
                          </FormControl>
                          <FormDescription>Kenyan mobile number, for example 0712 345 678 or 254712345678.</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={topupForm.control}
                      name="amount"
                      render={({ field }) => (
                        <FormItem className="field">
                          <FormLabel>Amount (KES)</FormLabel>
                          <FormControl>
                            <input
                              ref={field.ref}
                              name={field.name}
                              onBlur={field.onBlur}
                              onChange={(event) => field.onChange(event.target.valueAsNumber)}
                              value={field.value || ''}
                              type="number"
                              min="1"
                              step="1"
                              inputMode="numeric"
                              placeholder="1,000"
                              disabled={Boolean(topupAttempt)}
                              data-testid="input-airtime-topup-amount"
                            />
                          </FormControl>
                          <FormDescription>Enter a whole number of shillings.</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {topup.error && <Err error={topup.error} />}
                    {topupAttempt && topup.isError && (
                      <Note tone="warn">
                        The funding result could not be confirmed. Retry this same request to reuse its idempotency key, or check recent top-ups before starting another.
                      </Note>
                    )}
                    <Btn type="submit" disabled={topup.isPending} testId="button-airtime-topup">
                      <ArrowDownToLine size={16} />
                      {topup.isPending ? 'Starting M-Pesa prompt…' : topupAttempt ? 'Retry same funding request' : 'Send M-Pesa prompt'}
                    </Btn>
                  </form>
                </Form>
              </Card>

              <Card
                title="Buy airtime"
                subtitle="Send discounted KES airtime to Safaricom, Airtel, or Telkom using this wallet."
                className="airtime-action-card airtime-buy-card"
              >
                <Form {...purchaseForm}>
                  <form className="form-stack airtime-form" onSubmit={purchaseForm.handleSubmit(requestPurchase)} noValidate>
                    <FormField
                      control={purchaseForm.control}
                      name="phoneNumber"
                      render={({ field }) => (
                        <FormItem className="field">
                          <FormLabel>Recipient phone number</FormLabel>
                          <FormControl>
                            <input
                              {...field}
                              type="tel"
                              autoComplete="tel"
                              placeholder="0712 345 678"
                              disabled={Boolean(purchaseAttempt)}
                              data-testid="input-airtime-purchase-phone"
                            />
                          </FormControl>
                          <FormDescription>Kenyan mobile number, for example 0712 345 678 or 254712345678.</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={purchaseForm.control}
                      name="amount"
                      render={({ field }) => (
                        <FormItem className="field">
                          <FormLabel>Amount (KES)</FormLabel>
                          <FormControl>
                            <input
                              ref={field.ref}
                              name={field.name}
                              onBlur={field.onBlur}
                              onChange={(event) => field.onChange(event.target.valueAsNumber)}
                              value={field.value || ''}
                              type="number"
                              min="1"
                              step="1"
                              inputMode="numeric"
                              placeholder="500"
                              disabled={Boolean(purchaseAttempt)}
                              data-testid="input-airtime-purchase-amount"
                            />
                          </FormControl>
                          <FormDescription>Enter a whole number of shillings.</FormDescription>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {purchaseForm.formState.errors.root?.message && (
                      <Note tone="warn">
                        <span role="alert" data-testid="text-airtime-purchase-duplicate-warning">
                          {purchaseForm.formState.errors.root.message}
                        </span>
                      </Note>
                    )}
                    {purchase.error && <Err error={purchase.error} />}
                    {purchaseAttempt && purchase.isError && (
                      <Note tone="warn">
                        We could not confirm the result. Retry only through the confirmation below; it will reuse the same request key. Do not start a second purchase.
                      </Note>
                    )}
                    <Btn
                      type="submit"
                      disabled={Boolean(purchaseAttempt) || purchase.isPending}
                      testId="button-airtime-purchase"
                    >
                      <ArrowUpRight size={16} />
                      Review purchase
                    </Btn>
                  </form>
                </Form>
              </Card>
            </div>

            <Card
              title="Recent wallet funding"
              subtitle="A top-up is available to spend only after the M-Pesa payment is confirmed."
              className="airtime-history-card"
            >
              {data.topups.length === 0 ? (
                <div className="empty-state" data-testid="empty-airtime-topups">
                  <div className="empty-symbol"><ArrowDownToLine size={18} /></div>
                  <strong>No airtime funding yet</strong>
                  <span>Confirmed M-Pesa wallet top-ups will appear here.</span>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="dt">
                    <thead>
                      <tr><th>Phone</th><th>Amount</th><th>Status</th><th>Reference</th><th>External payment reference</th><th>Created</th><th>Updated</th></tr>
                    </thead>
                    <tbody>
                      {data.topups.map((item) => (
                        <tr key={item.reference} data-testid={`row-airtime-topup-${item.reference}`}>
                          <td>{item.phoneNumber}</td>
                          <td>{money(item.amount, data.wallet.currency)}</td>
                          <td><Pill value={item.status} /></td>
                          <td className="mono">{item.reference}</td>
                          <td className="mono">{item.providerReference || 'Not available'}</td>
                          <td>{displayDate(item.createdAt)}</td>
                          <td>{displayDate(item.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card
              title="Recent airtime purchases"
              subtitle="The full request amount remains reserved until Greenpay reports a final result."
              className="airtime-history-card"
            >
              {data.purchases.length === 0 ? (
                <div className="empty-state" data-testid="empty-airtime-purchases">
                  <div className="empty-symbol"><Smartphone size={18} /></div>
                  <strong>No airtime purchases yet</strong>
                  <span>Manual and API airtime purchases will appear here.</span>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="dt">
                    <thead>
                      <tr><th>Recipient</th><th>Requested</th><th>Charged</th><th>Status</th><th>Reference</th><th>Greenpay request</th><th>Created</th><th>Updated</th></tr>
                    </thead>
                    <tbody>
                      {data.purchases.map((item) => (
                        <tr key={item.reference} data-testid={`row-airtime-purchase-${item.reference}`}>
                          <td>
                            {item.phoneNumber}
                            {item.resultDescription && <span className="sub" data-testid={`text-airtime-result-${item.reference}`}>{item.resultDescription}</span>}
                          </td>
                          <td>{money(item.amount, data.wallet.currency)}</td>
                          <td>{item.charge === null ? 'Not reported' : money(item.charge, data.wallet.currency)}</td>
                          <td><Pill value={item.status} /></td>
                          <td className="mono">{item.reference}</td>
                          <td className="mono">{item.providerRequestId || 'Not available'}</td>
                          <td>{displayDate(item.createdAt)}</td>
                          <td>{displayDate(item.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        )}
      </Async>

      {purchaseAttempt && (
        <Modal
          title="Confirm airtime purchase"
          description={`Send ${money(purchaseAttempt.data.amount, 'KES')} airtime to ${purchaseAttempt.data.phoneNumber}? This uses your separate airtime wallet. If Greenpay is still processing or its response is uncertain, do not submit the purchase again.`}
          onClose={closePurchaseConfirmation}
        >
          {purchase.error && <Err error={purchase.error} />}
          {purchase.isError && (
            <Note tone="warn">
              This result could not be confirmed. Retrying below reuses the same request key; do not create a second purchase.
            </Note>
          )}
          <div className="row-actions">
            <Btn
              variant="secondary"
              onClick={closePurchaseConfirmation}
              disabled={purchase.isPending || purchase.isError}
              testId="button-cancel-airtime-purchase"
            >
              Cancel
            </Btn>
            <Btn
              variant="danger"
              disabled={purchase.isPending}
              onClick={confirmPurchase}
              testId="button-confirm-airtime-purchase"
            >
              {purchase.isPending ? 'Sending to Greenpay…' : purchase.isError ? 'Retry same request' : 'Confirm and buy'}
            </Btn>
          </div>
        </Modal>
      )}
    </>
  );
}

export function MerchantAirtimePage() {
  return <Gate need="merchant"><AirtimeContent /></Gate>;
}
