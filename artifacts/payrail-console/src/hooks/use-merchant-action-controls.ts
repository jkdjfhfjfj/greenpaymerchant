import { useQuery } from '@tanstack/react-query';

export type MerchantActionKey =
  | 'collect'
  | 'createLinks'
  | 'refundRequests'
  | 'disputeRequests'
  | 'invoices'
  | 'reminders'
  | 'payoutRequests'
  | 'destinationChanges'
  | 'walletConversion'
  | 'teamManagement'
  | 'apiAccess';

export type MerchantActionControls = Record<MerchantActionKey, boolean>;
type MerchantActionControlsResponse = {
  merchantId: number;
  businessName: string;
  merchantStatus: 'pending' | 'active' | 'suspended' | 'closed';
  controls: MerchantActionControls;
  disabledReasons: Partial<Record<MerchantActionKey, string>>;
  role: 'owner' | 'finance' | 'viewer';
};

async function getMerchantActionControls(): Promise<MerchantActionControlsResponse> {
  const response = await fetch('/api/merchant/action-controls', {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });
  const payload = await response.json().catch(() => null) as { error?: string } | MerchantActionControlsResponse | null;
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : `Unable to load merchant permissions (${response.status}).`;
    throw new Error(message);
  }
  return payload as MerchantActionControlsResponse;
}

const OWNER_ONLY = new Set<MerchantActionKey>(['teamManagement', 'apiAccess']);

export function useMerchantActionCapability() {
  const query = useQuery({
    queryKey: ['merchant-action-controls'],
    queryFn: getMerchantActionControls,
    refetchInterval: 10000,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  function can(action: MerchantActionKey): boolean {
    if (!query.data || query.data.controls[action] !== true) return false;
    if (OWNER_ONLY.has(action)) return query.data.role === 'owner';
    return query.data.role === 'owner' || query.data.role === 'finance';
  }
  function disabledReason(action: MerchantActionKey): string | null {
    if (query.isLoading) return 'Loading current merchant permissions.';
    if (query.isError) return 'Merchant permissions could not be verified. Retry before continuing.';
    if (!query.data) return 'Merchant permissions are unavailable.';
    if (query.data.role === 'viewer') return 'Your read-only accountant role cannot make changes.';
    if (OWNER_ONLY.has(action) && query.data.role !== 'owner') return 'Only the merchant owner can perform this action.';
    if (!query.data.controls[action]) {
      return query.data.disabledReasons[action] ??
        'This action is currently unavailable. Refresh permissions or contact platform support.';
    }
    return null;
  }
  return { ...query, role: query.data?.role ?? null, controls: query.data?.controls, can, disabledReason };
}