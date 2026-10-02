import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ClerkProvider, Show, SignIn, SignUp, useAuth, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  Activity, ArrowDownLeft, ArrowDownRight, ArrowLeft, ArrowRight, ArrowUpRight, Banknote,
  Bell, Check, CheckCircle2, ChevronDown, CircleAlert, CircleHelp, Clock3, Copy, CreditCard,
  ExternalLink, FileClock, Filter, Globe2, Headphones, KeyRound, LayoutDashboard, Link2,
  LoaderCircle, LockKeyhole, LogOut, Menu, MoreHorizontal, Plus, Radio, RefreshCw, Search,
  Send, Settings2, ShieldCheck, SlidersHorizontal, Sparkles, WalletCards, Webhook, X,
} from 'lucide-react';
import {
  useGetDashboard, useListTransactions, useCreateTransaction, useGetTransaction,
  useVerifyTransaction, useRefundTransaction, useListPaymentLinks, useCreatePaymentLink,
  useUpdatePaymentLink, useDeletePaymentLink, useGetPublicPaymentLink, useCheckoutPaymentLink,
  useListPayouts, useCreatePayout, useListPayoutMethods, useListBanks, useListSettlements,
  useListCustomers, useListWebhookEvents, useReplayWebhookEvent, useGetProviderStatus,
  getGetTransactionQueryKey, useListAdminMerchants, useListSupportedCurrencies,
} from '@workspace/api-client-react';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { formatFinancialAmount as currency } from '@/lib/money-format';
import HomePage from '@/pages/home';
import { useAccess, Gate, Async, errMsg, CURRENCIES, currencyAmountStep, currencyMinorUnits } from '@/components/kit';
import { PlatformBrand, PlatformBrandingProvider, usePlatformBranding } from '@/components/platform-brand';
import { NotificationBell } from '@/components/notification-bell';
import { ContactPage } from '@/pages/contact';
import { SupportPage } from '@/pages/support';
import { AdminSupportPage } from '@/pages/admin-support';
import { ProfilePage } from '@/pages/profile';
import { NotificationsPage } from '@/pages/notifications';
import { PlatformStatusPage } from '@/pages/platform-status';
import { VerificationLimitsPage } from '@/pages/verification-limits';
import { DeveloperDocsPage, PublicApiDocsPage } from '@/pages/developer-docs';
import { WalletPage, PayoutRequestsPage, AdminWalletsPage, AdminPayoutRequestsPage } from '@/pages/wallets';
import { InvoicePage, InvoiceDetailPage, StatementsPage, CasesPage, AdminCasesPage, PublicReceiptPage } from '@/pages/business-tools';
import { MerchantTeamPage, AcceptTeamInvitePage } from '@/pages/team';
import { MerchantDashboardPage, MerchantPage, KycPage, MerchantLinksPage, MerchantTransactionsPage, MerchantPayoutsPage } from '@/pages/merchant';
import { DevelopersPage, ExchangePage } from '@/pages/developers';
import { StatusPage, AuthSetupScreen } from '@/pages/status';
import { AdminSummaryPage, AdminMerchantsPage, AdminMerchantControlsPage, AdminFeesPage, AdminExchangePage, AdminCredentialsPage, AdminSettingsPage, AdminAuditPage, AdminPlatformAdminsPage } from '@/pages/admin';
import { AdminEmailDeliveryPage } from '@/pages/admin-email-delivery';
import { AdminContentPage, PublicHelpPage, PublicContentPage, PublicContentIndexPage } from '@/pages/content';
import { Route, Switch, Redirect, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(window.location.hostname, import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string) {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}


const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#294c43',
    colorForeground: '#263d37',
    colorMutedForeground: '#71817b',
    colorDanger: '#b74943',
    colorBackground: '#fffdf8',
    colorInput: '#fffdf8',
    colorInputForeground: '#263d37',
    colorNeutral: '#d7d9cf',
    fontFamily: 'DM Sans',
    borderRadius: '0.85rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#fffdf8] rounded-2xl w-[440px] max-w-full overflow-hidden border border-[#e4e1d7]',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#263d37] font-semibold tracking-tight',
    headerSubtitle: 'text-[#71817b]',
    socialButtonsBlockButtonText: 'text-[#263d37] font-medium',
    formFieldLabel: 'text-[#364a43] font-medium',
    footerActionLink: 'text-[#294c43] font-semibold',
    footerActionText: 'text-[#71817b]',
    dividerText: 'text-[#71817b]',
    identityPreviewEditButton: 'text-[#294c43]',
    formFieldSuccessText: 'text-[#3e806b]',
    alertText: 'text-[#9d413c]',
    logoBox: 'rounded-xl',
    logoImage: 'rounded-xl',
    socialButtonsBlockButton: 'border-[#deded4] bg-[#fffdf8] hover:bg-[#f5f3eb]',
    formButtonPrimary: 'bg-[#294c43] hover:bg-[#203d36] text-white shadow-none',
    formFieldInput: 'border-[#d8d8ce] bg-[#fffdf8] text-[#263d37]',
    footerAction: 'border-t border-[#e6e3da]',
    dividerLine: 'bg-[#e6e3da]',
    alert: 'border-[#e8c8c4] bg-[#fbf0ed]',
    otpCodeFieldInput: 'border-[#d8d8ce] bg-[#fffdf8] text-[#263d37]',
    formFieldRow: 'gap-1.5',
    main: 'gap-5',
  },
};

type IconComponent = typeof LayoutDashboard;
type NavItem = { label: string; href: string; icon: IconComponent };
const navSections: { title: string; items: NavItem[] }[] = [
  { title: 'WORKSPACE', items: [
    { label: 'Operations', href: '/operations', icon: LayoutDashboard },
    { label: 'Transactions', href: '/transactions', icon: ArrowDownLeft },
    { label: 'Payment links', href: '/payment-links', icon: Link2 },
    { label: 'Payouts', href: '/payouts', icon: Send },
  ] },
  { title: 'RECONCILIATION', items: [
    { label: 'Settlements', href: '/settlements', icon: FileClock },
    { label: 'Customers', href: '/customers', icon: CreditCard },
  ] },
  { title: 'MERCHANT', items: [
    { label: 'Overview', href: '/merchant/dashboard', icon: LayoutDashboard },
    { label: 'Profile', href: '/merchant', icon: WalletCards },
    { label: 'Verification', href: '/merchant/kyc', icon: ShieldCheck },
    { label: 'My links', href: '/merchant/payment-links', icon: Link2 },
    { label: 'My transactions', href: '/merchant/transactions', icon: ArrowDownLeft },
    { label: 'My payouts', href: '/merchant/payouts', icon: Send },
    { label: 'Wallets & conversion', href: '/wallets', icon: Banknote },
    { label: 'Payout requests', href: '/payout-requests', icon: Send },
    { label: 'Invoices', href: '/invoices', icon: FileClock },
    { label: 'Monthly statements', href: '/statements', icon: FileClock },
    { label: 'Refunds & disputes', href: '/cases', icon: CircleHelp },
    { label: 'Team access', href: '/team', icon: Globe2 },
    { label: 'API access', href: '/developers', icon: KeyRound },
    { label: 'API docs & playground', href: '/developers/docs', icon: KeyRound },
  ] },
  { title: 'ACCOUNT', items: [
    { label: 'My profile', href: '/profile', icon: CreditCard },
    { label: 'Notifications', href: '/notifications', icon: Bell },
    { label: 'Support tickets', href: '/support', icon: Headphones },
    { label: 'Platform status', href: '/platform-status', icon: Activity },
  ] },
  { title: 'DEVELOPERS', items: [
    { label: 'Webhooks', href: '/webhooks', icon: Webhook },
    { label: 'Settings', href: '/settings', icon: Settings2 },
  ] },
];

const adminSection: { title: string; items: NavItem[] } = { title: 'PLATFORM ADMIN', items: [
  { label: 'Admin summary', href: '/admin', icon: Activity },
  { label: 'Merchants', href: '/admin/merchants', icon: Globe2 },
  { label: 'Fees', href: '/admin/fees', icon: SlidersHorizontal },
  { label: 'Rates', href: '/admin/exchange', icon: RefreshCw },
  { label: 'Credentials', href: '/admin/credentials', icon: LockKeyhole },
  { label: 'Controls', href: '/admin/settings', icon: Settings2 },
  { label: 'Audit log', href: '/admin/audit', icon: FileClock },
  { label: 'Platform administrators', href: '/admin/administrators', icon: ShieldCheck },
  { label: 'Verification limits', href: '/admin/verification-limits', icon: ShieldCheck },
  { label: 'Funded wallets', href: '/admin/wallets', icon: WalletCards },
  { label: 'Payout approvals', href: '/admin/payout-requests', icon: Send },
  { label: 'Refund & dispute cases', href: '/admin/cases', icon: CircleHelp },
  { label: 'Support inbox', href: '/admin/support', icon: Headphones },
  { label: 'Email delivery', href: '/admin/email-delivery', icon: Send },
  { label: 'Public content', href: '/admin/content', icon: FileClock },
] };
const pageInfo: Record<string, { title: string; subtitle: string }> = {
  '/admin/email-delivery': { title: 'Email delivery', subtitle: '' },
  '/admin/content': { title: 'Public content', subtitle: '' },
  '/wallets': { title: 'Wallets & conversion', subtitle: '' }, '/payout-requests': { title: 'Payout requests', subtitle: '' },
  '/invoices': { title: 'Invoices', subtitle: '' }, '/statements': { title: 'Monthly statements', subtitle: '' },
  '/cases': { title: 'Refunds & disputes', subtitle: '' }, '/team': { title: 'Team access', subtitle: '' },
  '/profile': { title: 'My profile', subtitle: '' }, '/support': { title: 'Support tickets', subtitle: '' },
  '/notifications': { title: 'Notifications', subtitle: '' }, '/developers/docs': { title: 'API documentation', subtitle: '' },
  '/admin/wallets': { title: 'Funded wallets', subtitle: '' }, '/admin/payout-requests': { title: 'Payout approvals', subtitle: '' },
  '/admin/cases': { title: 'Refund & dispute cases', subtitle: '' }, '/admin/support': { title: 'Support inbox', subtitle: '' },
  '/admin/verification-limits': { title: 'Verification limits', subtitle: '' },
  '/contact': { title: 'Contact', subtitle: '' }, '/platform-status': { title: 'Platform status', subtitle: '' },
  '/merchant': { title: 'Merchant profile', subtitle: '' }, '/merchant/kyc': { title: 'Verification', subtitle: '' },
  '/merchant/dashboard': { title: 'Overview', subtitle: 'A clear view of collections and links for your business.' },
  '/merchant/payment-links': { title: 'My payment links', subtitle: '' }, '/merchant/transactions': { title: 'My transactions', subtitle: '' }, '/merchant/payouts': { title: 'Admin-operated payouts', subtitle: '' },
  '/developers': { title: 'API access', subtitle: '' }, '/exchange': { title: 'Exchange quotes', subtitle: '' },
  '/admin': { title: 'Admin summary', subtitle: '' }, '/admin/merchants': { title: 'Merchants', subtitle: '' }, '/admin/fees': { title: 'Fees', subtitle: '' },
  '/admin/exchange': { title: 'Rates', subtitle: '' }, '/admin/credentials': { title: 'Credentials', subtitle: '' }, '/admin/settings': { title: 'Controls', subtitle: '' }, '/admin/audit': { title: 'Audit log', subtitle: '' },
  '/admin/administrators': { title: 'Platform administrators', subtitle: '' },
  '/operations': { title: 'Operations', subtitle: 'A clear view of money moving through your business.' }, '/': { title: 'Overview', subtitle: 'A clear view of money moving through your business.' },
  '/transactions': { title: 'Transactions', subtitle: 'Search, verify and resolve collection activity.' },
  '/payment-links': { title: 'Payment links', subtitle: 'Simple, shareable ways to collect across markets.' },
  '/payouts': { title: 'Payouts', subtitle: 'Send funds out with a clear review trail.' },
  '/settlements': { title: 'Settlements', subtitle: 'Track provider balances through the T+3 cycle.' },
  '/customers': { title: 'Customers', subtitle: 'Understand the people behind each payment.' },
  '/webhooks': { title: 'Webhooks', subtitle: 'Inspect delivery outcomes and safely replay events.' },
  '/settings': { title: 'Provider readiness', subtitle: 'Collection and payout access, by provider.' },
};

function dateTime(value?: string | null) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function dateOnly(value?: string | null) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function label(value?: string | null) {
  return (value || 'unknown').replaceAll('_', ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function StatusPill({ value }: { value?: string | null }) {
  const normalized = (value || 'unknown').toLowerCase();
  return <span className={`status-pill status-${normalized}`} data-testid={`status-${normalized}`}><i />{label(value)}</span>;
}

function Button({ children, variant = 'primary', className = '', onClick, type = 'button', disabled, testId }: {
  children: ReactNode; variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; className?: string;
  onClick?: () => void; type?: 'button' | 'submit'; disabled?: boolean; testId?: string;
}) {
  return <button type={type} onClick={onClick} disabled={disabled} data-testid={testId} className={`btn btn-${variant} ${className}`}>{children}</button>;
}

function PageHeading({ eyebrow, title, subtitle, action }: { eyebrow?: string; title: string; subtitle?: string; action?: ReactNode }) {
  return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{action && <div className="heading-action">{action}</div>}</div>;
}

function Panel({ children, className = '', title, subtitle, action }: { children: ReactNode; className?: string; title?: string; subtitle?: string; action?: ReactNode }) {
  return <section className={`panel ${className}`}>{(title || action) && <div className="panel-head"><div>{title && <h2>{title}</h2>}{subtitle && <p>{subtitle}</p>}</div>{action}</div>}{children}</section>;
}

function QueryState({ loading, error, retry, empty, children }: { loading?: boolean; error?: boolean; retry?: () => void; empty?: boolean; children?: ReactNode }) {
  if (loading) return <div className="loading-state"><div className="skeleton-line wide" /><div className="skeleton-line" /><div className="skeleton-line short" /></div>;
  if (error) return <div className="empty-state"><CircleAlert size={21} /><strong>We couldn’t load this view.</strong><span>Check the connection and try again.</span><Button variant="secondary" onClick={retry}>Retry</Button></div>;
  if (empty) return <div className="empty-state"><div className="empty-symbol"><Activity size={19} /></div><strong>Nothing here yet</strong><span>New activity will appear here as it reaches Greenpay.</span></div>;
  return <>{children}</>;
}

function Modal({ title, description, onClose, children, wide = false }: { title: string; description?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><div className="modal-head"><div><h2>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close dialog" data-testid="button-close-dialog"><X size={18} /></button></div>{children}</section></div>;
}

function Notice({ children, danger = false }: { children: ReactNode; danger?: boolean }) {
  return <div className={`notice ${danger ? 'notice-danger' : ''}`} role="status">{danger ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}{children}</div>;
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <PlatformBrand compact={compact} />;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (previousUserId.current !== undefined && previousUserId.current !== userId) client.clear();
      previousUserId.current = userId;
    });
    return unsubscribe;
  }, [addListener, client]);
  return null;
}

function SignInPage() {
  return <div className="auth-page"><div className="auth-side"><Brand /><div className="auth-story"><span className="eyebrow">GREENPAY / OPERATIONS</span><h1>Move money.<br />Know where it is.</h1><p>One calm place to follow every collection, settlement and payout.</p></div><div className="auth-foot">Payments infrastructure for the places business is growing.</div></div><div className="auth-main"><SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /></div></div>;
}

function SignUpPage() {
  return <div className="auth-page"><div className="auth-side"><Brand /><div className="auth-story"><span className="eyebrow">GREENPAY / OPERATIONS</span><h1>Build your<br />money movement.</h1><p>Start collecting across Africa with operations built for clarity.</p></div><div className="auth-foot">Payments infrastructure for the places business is growing.</div></div><div className="auth-main"><SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} /></div></div>;
}

function Protected({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <div className="auth-loading"><div className="skeleton-line" /><div className="skeleton-line short" /></div>;
  if (!isSignedIn) return <Redirect to="/" />;
  return <>{children}</>;
}

function RoleHome() {
  const access = useAccess();
  if (access.isLoading || access.isError) return <AppShell><Async q={access}>{null}</Async></AppShell>;
  return <Redirect to={access.isAdmin ? '/admin' : '/merchant/dashboard'} />;
}

function DashboardRoot() {
  return <><Show when="signed-in"><Protected><RoleHome /></Protected></Show><Show when="signed-out"><Welcome /></Show></>;
}

function AppShell({ children }: { children: ReactNode }) {
  const [location, setLocation] = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [newCollectionOpen, setNewCollectionOpen] = useState(false);
  const { user } = useUser();
  const { signOut } = useClerk();
  const access = useAccess();
  const branding = usePlatformBranding();
  const merchantOnly = navSections.filter((section) => section.title === 'MERCHANT' || section.title === 'ACCOUNT');
  const sections = access.isAdmin ? [...navSections, adminSection] : merchantOnly;
  const active = pageInfo[location] || (location.startsWith('/invoices/') ? { title: 'Invoice details', subtitle: '' } : { title: 'Workspace', subtitle: '' });
  return <div className="app-shell">
    <aside className={`sidebar ${menuOpen ? 'sidebar-open' : ''}`}>
      <div className="sidebar-brand"><Brand /><button className="mobile-close icon-button" onClick={() => setMenuOpen(false)} aria-label="Close navigation"><X size={18} /></button></div>
      <div className="workspace-switch"><span className="workspace-avatar">K</span><span className="workspace-copy"><strong>{access.merchant?.businessName || 'No merchant yet'}</strong><small>{access.isAdmin ? 'Platform administrator' : access.merchant ? 'Merchant workspace' : 'Onboarding needed'}</small></span><ChevronDown size={15} /></div>
      <nav className="main-nav" aria-label="Main navigation">{sections.map((section) => <div className="nav-section" key={section.title}><div className="nav-label">{section.title}</div>{section.items.map((item) => { const Icon = item.icon; const current = location === item.href; return <a key={item.href} href={item.href} className={`nav-item ${current ? 'nav-active' : ''}`} onClick={(event) => { event.preventDefault(); setLocation(item.href); setMenuOpen(false); }} data-testid={`nav-${item.label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={17} strokeWidth={1.8} /><span>{item.label}</span>{item.href === '/webhooks' && <span className="nav-dot" />}</a>; })}</div>)}</nav>
      <div className="sidebar-bottom"><a className="help-link" href={`${basePath}/support`}><Headphones size={16} />Contact support</a><div className="profile-row"><div className="profile-avatar">{user?.firstName?.[0] || user?.primaryEmailAddress?.emailAddress?.[0] || 'O'}</div><a className="profile-name" href={`${basePath}/profile`}><strong>{user?.fullName || 'Operations user'}</strong><small>{user?.primaryEmailAddress?.emailAddress || 'Signed in'}</small></a><button className="icon-button profile-logout" onClick={() => signOut({ redirectUrl: basePath || '/' })} aria-label="Sign out" title="Sign out" data-testid="button-sign-out"><LogOut size={16} /></button></div></div>
    </aside>
    {menuOpen && <button className="mobile-scrim" aria-label="Close menu" onClick={() => setMenuOpen(false)} />}
    <main className="main-column"><header className="topbar"><button className="mobile-menu icon-button" aria-label="Open navigation" onClick={() => setMenuOpen(true)} data-testid="button-open-navigation"><Menu size={19} /></button><div className="breadcrumbs"><span>{branding.platformName}</span><span className="crumb-sep">/</span><strong>{active.title}</strong></div><div className="topbar-right"><div className="environment"><span />Workspace</div><NotificationBell /><div className="top-divider" /><a className="top-user" href={`${basePath}/profile`} aria-label="Open your profile"><span>{user?.firstName || 'Operator'}</span><div className="profile-avatar profile-avatar-small">{user?.firstName?.[0] || 'O'}</div></a></div></header><div className="page-content">{children}</div><footer className="app-footer"><a href={basePath || '/'} aria-label={`Powered by ${branding.platformName} — visit homepage`}>Powered by {branding.platformName}</a><span>Dates shown in your device timezone <span className="footer-sep">·</span> <a href={`${basePath}/support`}>Support</a></span></footer></main>
    {newCollectionOpen && <CollectionModal onClose={() => setNewCollectionOpen(false)} />}
  </div>;
}

function Welcome() {
  return <HomePage />;
}

function isCurrencyAmountValid(amount: number, code: string) {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  const scaled = amount * 10 ** currencyMinorUnits(code);
  return Math.abs(scaled - Math.round(scaled)) <= Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
}

function CollectionModal({ onClose }: { onClose: () => void }) {
  const mutation = useCreateTransaction();
  const currencyCatalog = useListSupportedCurrencies();
  const supportedCurrencies = currencyCatalog.data?.items ?? [];
  const [currencyCode, setCurrencyCode] = useState('USD');
  const [paymentMethodId, setPaymentMethodId] = useState('');
  const [checkout, setCheckout] = useState<{ url: string | null; provider: string; reference: string } | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const currencyOption = supportedCurrencies.find((item) => item.code === currencyCode);
  const paymentMethods = currencyOption?.paymentMethods ?? [];
  const selectedMethod = paymentMethods.find((item) => item.id === paymentMethodId && item.ready)
    ?? paymentMethods.find((item) => item.ready);
  const selectedMethodId = selectedMethod?.id ?? '';
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!currencyOption?.collectionReady || !selectedMethod) {
      setError(currencyOption?.comingSoon
        ? `${currencyCode} collections are coming soon. Choose another currency.`
        : `Payments are not currently available in ${currencyCode}. Refresh availability or choose another currency.`);
      return;
    }
    const form = new FormData(event.currentTarget);
    const amount = Number(form.get('amount'));
    if (!isCurrencyAmountValid(amount, currencyCode)) {
      setError(`Enter a positive ${currencyCode} amount with at most ${currencyMinorUnits(currencyCode)} decimal places.`);
      return;
    }
    const phone = String(form.get('phone') || '').trim();
    if (selectedMethod.requiresPhone && !phone) { setError('Enter a phone number to continue with this payment method.'); return; }
    mutation.mutate({ data: { amount, currency: currencyCode, paymentMethod: selectedMethod.id, customerEmail: String(form.get('email')), customerName: String(form.get('name') || ''), customerPhone: phone, description: String(form.get('description') || '') } }, {
      onSuccess: (result) => { setCheckout({ url: result.checkoutUrl, provider: result.transaction.provider, reference: result.transaction.reference }); setWorking(false); },
      onError: (failure) => { setWorking(false); setError(errMsg(failure)); },
    });
    setWorking(true);
  }
  return <Modal title={checkout ? 'Collection initiated' : 'Start a collection'} description={checkout ? 'The payment session is ready. Continue to payment or complete the prompt on your phone.' : 'Greenpay will route this payment using the configured currency path.'} onClose={onClose}>
    {checkout ? <div className="form-stack"><div className="route-confirm"><CheckCircle2 size={20} /><div><strong>{checkout.provider === 'payhero' ? 'M-Pesa prompt requested' : 'Checkout session created'}</strong><span>{checkout.provider === 'payhero' ? `Check the customer’s phone to complete payment. Reference ${checkout.reference}.` : 'No payment is marked successful until the provider confirms it.'}</span></div></div>{checkout.url && <a href={checkout.url} target="_blank" rel="noreferrer" className="btn btn-primary btn-full">Open checkout <ExternalLink size={15} /></a>}<Button variant="secondary" className="btn-full" onClick={onClose}>Close</Button></div> : <form className="form-stack" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Amount"><input name="amount" type="number" min={currencyMinorUnits(currencyCode) === 0 ? '1' : '0.01'} step={currencyAmountStep(currencyCode)} placeholder="0.00" required data-testid="input-collection-amount" /></Field>
        <Field label="Currency"><select name="currency" value={currencyCode} onChange={(event) => { setCurrencyCode(event.target.value); setPaymentMethodId(''); }} disabled={currencyCatalog.isLoading || !supportedCurrencies.length} data-testid="select-collection-currency">
          {supportedCurrencies.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}{item.comingSoon ? ' · Coming soon' : item.collectionReady ? '' : ' · unavailable'}</option>)}
        </select></Field>
      </div>
      <Field label="Payment method"><select value={selectedMethodId} onChange={(event) => setPaymentMethodId(event.target.value)} disabled={!paymentMethods.some((item) => item.ready)} data-testid="select-collection-payment-method">
        {selectedMethodId === '' && <option value="">{currencyOption?.comingSoon ? 'Coming soon' : currencyOption?.collectionReady ? 'No payment method available' : 'Payment method unavailable'}</option>}
        {paymentMethods.map((method) => <option key={method.id} value={method.id} disabled={!method.ready}>{method.label}{method.ready ? '' : currencyOption?.comingSoon ? ' · Coming soon' : ' · unavailable'}</option>)}
      </select></Field>
      {selectedMethod && <span className="sub">{selectedMethod.id === 'mobile_prompt'
        ? 'Mobile money is requested through an M-Pesa prompt on the customer’s phone.'
        : 'The secure hosted checkout shows the payment options supported for this currency. USD is not guaranteed to be card-only.'}</span>}
      {currencyCatalog.isLoading && <span className="sub">Loading supported currencies and payment options…</span>}
      {currencyCatalog.isError && <div className="provider-warning"><CircleAlert size={15} /><span>Payment availability could not be checked.</span><Button variant="secondary" disabled={currencyCatalog.isFetching} onClick={() => { void currencyCatalog.refetch(); }}>{currencyCatalog.isFetching ? 'Checking…' : 'Retry'}</Button></div>}
      {currencyOption && currencyOption.comingSoon && <div className="provider-warning"><CircleAlert size={15} /><span>Coming soon: new collections in {currencyOption.code} are disabled by the platform administrator.</span></div>}
      {currencyOption && !currencyOption.comingSoon && !currencyOption.collectionReady && <div className="provider-warning"><CircleAlert size={15} /><span>Payments are not currently available in {currencyOption.code}. This deployment has no ready payment method for this currency.</span><Button variant="secondary" disabled={currencyCatalog.isFetching} onClick={() => { void currencyCatalog.refetch(); }}>{currencyCatalog.isFetching ? 'Checking…' : 'Refresh availability'}</Button></div>}
      {currencyOption?.collectionReady && !paymentMethods.some((item) => item.ready) && <div className="provider-warning"><CircleAlert size={15} /><span>No payment method is currently available for {currencyOption.code}.</span><Button variant="secondary" disabled={currencyCatalog.isFetching} onClick={() => { void currencyCatalog.refetch(); }}>{currencyCatalog.isFetching ? 'Checking…' : 'Refresh availability'}</Button></div>}
      <Field label="Customer email"><input name="email" type="email" placeholder="finance@example.com" required data-testid="input-collection-email" /></Field>
      <Field label="Customer name"><input name="name" placeholder="Full name" data-testid="input-collection-name" /></Field>
      <Field label={`Customer phone${selectedMethod?.requiresPhone ? ' (required)' : ' (optional)'}`}><input name="phone" type="tel" placeholder="+254…" required={selectedMethod?.requiresPhone} data-testid="input-collection-phone" /></Field>
      <Field label="Description"><input name="description" placeholder="Invoice or order reference" data-testid="input-collection-description" /></Field>
      <RouteHint currencyCode={currencyCode} paymentMethodId={selectedMethodId} /><ProviderNote /><ErrorLine error={error} />
      <Button type="submit" disabled={working || currencyCatalog.isLoading || !currencyOption?.collectionReady || !selectedMethod} className="btn-full">{working ? <><LoaderCircle className="spin" size={16} /> Starting collection</> : <>Create checkout <ArrowRight size={15} /></>}</Button>
    </form>}
  </Modal>;
}

function Field({ label: title, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{title}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function ErrorLine({ error }: { error: string }) {
  return error ? <div className="form-error" role="alert"><CircleAlert size={15} />{error}</div> : null;
}

function RouteHint({ currencyCode, paymentMethodId }: { currencyCode: string; paymentMethodId: string }) {
  const selected = currencyCode.toUpperCase();
  const hint = selected === 'USD' && paymentMethodId === 'hosted_checkout'
    ? 'USD uses secure hosted checkout; available payment options appear on the next page.'
    : selected === 'KES' && paymentMethodId === 'mobile_prompt'
      ? 'A mobile money prompt will be sent to the customer’s phone.'
      : `${selected} uses the secure payment method selected above.`;
  return <div className="route-hint"><span className="route-hint-dot" /><span>{hint}</span></div>;
}

function ProviderNote() {
  const { data } = useGetProviderStatus();
  const unavailable = (data?.items || []).filter((item) => !item.configured || !item.collectionsEnabled);
  if (!unavailable.length) return null;
  return <div className="provider-warning"><CircleAlert size={15} /><span>Some collection routes are not ready: {unavailable.map((item) => item.provider).join(', ')}. Requests for disabled routes may not start.</span></div>;
}

function Dashboard() {
  const { data, isLoading, isError, refetch } = useGetDashboard();
  const [collectionOpen, setCollectionOpen] = useState(false);
  return <><PageHeading eyebrow="TUESDAY · OPERATIONS SNAPSHOT" title="Good morning." subtitle="Here's what moved across your payment rails today." action={<Button onClick={() => setCollectionOpen(true)} testId="button-new-collection"><Plus size={16} /> New collection</Button>} />
    <div className="metric-grid">
      <MetricCard title="Payments today" value={data?.paymentsToday?.toLocaleString() || '—'} detail="Confirmed provider events" icon={ArrowDownRight} loading={isLoading} tone="mint" />
      <MetricCard title="Success rate" value={data ? `${data.successRate.toFixed(1)}%` : '—'} detail="Across completed payment attempts" icon={CheckCircle2} loading={isLoading} tone="cream" />
      <MetricCard title="Pending settlement" value={data?.pendingSettlements?.toLocaleString() || '—'} detail="Items with a T+3 target" icon={Clock3} loading={isLoading} tone="blue" />
      <MetricCard title="Due for review" value={data?.settlementsDue?.toLocaleString() || '—'} detail="Settlement items to reconcile" icon={CircleAlert} loading={isLoading} tone="peach" />
    </div>
    <div className="dashboard-main-grid"><Panel title="Volume by currency" subtitle="Today's gross collections" className="currency-panel"><QueryState loading={isLoading} error={isError} retry={() => { void refetch(); }} empty={!data?.volumeByCurrency?.length}><div className="currency-list">{(data?.volumeByCurrency || []).map((item, index) => <div className="currency-volume" key={item.currency} data-testid={`currency-volume-${item.currency}`}><span className={`currency-icon currency-icon-${index % 4}`}>{item.currency.slice(0, 1)}</span><div className="currency-info"><strong>{item.currency}</strong><span>{item.count.toLocaleString()} collections</span></div><div className="currency-bar"><i style={{ width: `${Math.max(9, Math.min(100, data?.volumeByCurrency?.length ? (item.amount / Math.max(...data.volumeByCurrency.map((entry) => entry.amount))) * 100 : 9))}%` }} /></div><strong className="currency-total">{currency(item.amount, item.currency)}</strong></div>)}</div></QueryState></Panel>
      <Panel title="Provider routes" subtitle="Current collection readiness" action={<a className="panel-link" href="/settings">Manage <ArrowRight size={13} /></a>}><QueryState loading={isLoading} error={isError} retry={() => { void refetch(); }} empty={!data?.providerStatus?.length}><div className="provider-list">{(data?.providerStatus || []).map((provider) => <div className="provider-line" key={provider.provider}><div className={`provider-glyph glyph-${provider.provider}`}>{provider.provider === 'paystack' ? 'P' : provider.provider === 'payhero' ? 'H' : 'Pz'}</div><div className="provider-line-copy"><strong>{label(provider.provider)}</strong><span>{provider.currencies.join(' · ') || 'No currencies reported'}</span></div><StatusPill value={provider.configured && provider.collectionsEnabled ? 'ready' : 'disabled'} /></div>)}</div></QueryState></Panel></div>
    <Panel title="Recent collections" subtitle="Most recent payment activity" action={<a className="panel-link" href="/transactions">View all <ArrowRight size={13} /></a>}><QueryState loading={isLoading} error={isError} retry={() => { void refetch(); }} empty={!data?.recentTransactions?.length}><TransactionTable items={data?.recentTransactions || []} compact /></QueryState></Panel>
    {collectionOpen && <CollectionModal onClose={() => setCollectionOpen(false)} />}
  </>;
}

function MetricCard({ title, value, detail, icon: Icon, loading, tone }: { title: string; value: string; detail: string; icon: IconComponent; loading?: boolean; tone: string }) {
  return <section className={`metric-card tone-${tone}`}><div className="metric-top"><span>{title}</span><span className="metric-icon"><Icon size={17} /></span></div>{loading ? <div className="skeleton-line metric-skeleton" /> : <div className="metric-value" data-testid={`metric-${title.toLowerCase().replaceAll(' ', '-')}`}>{value}</div>}<div className="metric-detail">{detail}</div></section>;
}

function TransactionTable({ items, compact = false, onSelect }: { items: any[]; compact?: boolean; onSelect?: (reference: string) => void }) {
  return <div className="table-scroll"><table className="data-table"><thead><tr><th>Payment</th><th>Customer</th><th>Route</th><th>Amount</th><th>Status</th><th>Created</th>{!compact && <th />}</tr></thead><tbody>{items.map((item) => <tr key={item.reference} data-testid={`row-transaction-${item.reference}`} onClick={() => onSelect?.(item.reference)} className={onSelect ? 'table-row-clickable' : ''}><td><strong className="mono ref-cell">{item.reference}</strong><small>{item.description || item.paymentMethod || 'Collection'}</small></td><td><strong>{item.customerName || item.customerEmail}</strong><small>{item.customerName ? item.customerEmail : item.customerPhone || 'Customer'}</small></td><td><span className="provider-cell"><span className={`provider-mini provider-${item.provider}`} />{label(item.provider)}</span></td><td><strong className="amount-cell">{currency(item.amount, item.currency)}</strong><small>{item.currency}</small></td><td><StatusPill value={item.status} /></td><td><span className="date-cell">{dateTime(item.createdAt)}</span></td>{!compact && <td><button className="table-more" aria-label={`Open ${item.reference}`} onClick={(event) => { event.stopPropagation(); onSelect?.(item.reference); }}><ArrowUpRight size={15} /></button></td>}</tr>)}</tbody></table></div>;
}

function Transactions() {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [currencyFilter, setCurrencyFilter] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState('');
  const params = useMemo(() => ({ search: search || undefined, status: (status || undefined) as any, currency: currencyFilter || undefined, page, perPage: 20 }), [search, status, currencyFilter, page]);
  const query = useListTransactions(params);
  return <><PageHeading eyebrow="COLLECTIONS / LEDGER" title="Transactions" subtitle="Search, verify and resolve collection activity." action={<Button onClick={() => { const element = document.querySelector<HTMLInputElement>('[data-testid="input-transaction-search"]'); element?.focus(); }} variant="secondary"><Search size={15} /> Find a payment</Button>} />
    <Panel className="filter-panel"><div className="toolbar-filters"><label className="search-box"><Search size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search reference, email or customer" data-testid="input-transaction-search" /></label><label className="select-wrap"><Filter size={14} /><select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} data-testid="select-transaction-status"><option value="">All statuses</option><option value="pending">Pending</option><option value="success">Succeeded</option><option value="failed">Failed</option><option value="refunded">Refunded</option><option value="cancelled">Cancelled</option></select></label><label className="select-wrap"><Globe2 size={14} /><select value={currencyFilter} onChange={(event) => { setCurrencyFilter(event.target.value); setPage(1); }} data-testid="select-transaction-currency"><option value="">All currencies</option>{CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}</select></label><Button variant="quiet" className="filter-clear" onClick={() => { setSearch(''); setStatus(''); setCurrencyFilter(''); setPage(1); }}><X size={14} /> Clear</Button></div></Panel>
    <Panel className="table-panel"><div className="list-meta"><span>{query.data?.total ?? 0} transaction{query.data?.total === 1 ? '' : 's'}</span><span className="mono">PAGE {query.data?.page || page}</span></div><QueryState loading={query.isLoading} error={query.isError} retry={() => { void query.refetch(); }} empty={!query.data?.items?.length}><TransactionTable items={query.data?.items || []} onSelect={setSelected} /><div className="pagination"><span>Showing {query.data?.items.length ? (page - 1) * (query.data?.perPage || 20) + 1 : 0}–{Math.min(page * (query.data?.perPage || 20), query.data?.total || 0)} of {query.data?.total || 0}</span><div><Button variant="secondary" disabled={page <= 1} onClick={() => setPage((current) => current - 1)}>Previous</Button><Button variant="secondary" disabled={!query.data || page * query.data.perPage >= query.data.total} onClick={() => setPage((current) => current + 1)}>Next <ArrowRight size={13} /></Button></div></div></QueryState></Panel>
    {selected && <TransactionDetail reference={selected} onClose={() => setSelected('')} />}
  </>;
}

function TransactionDetail({ reference, onClose }: { reference: string; onClose: () => void }) {
  const query = useGetTransaction(reference, { query: { enabled: Boolean(reference), queryKey: getGetTransactionQueryKey(reference) } });
  const verify = useVerifyTransaction();
  const refund = useRefundTransaction();
  const [refundOpen, setRefundOpen] = useState(false);
  const [message, setMessage] = useState('');
  const transaction = query.data;
  function submitRefund(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!transaction) return;
    const form = new FormData(event.currentTarget);
    const amount = String(form.get('amount') || '').trim();
    const reason = String(form.get('reason') || '');
    if (amount && !isCurrencyAmountValid(Number(amount), transaction.currency)) {
      setMessage(`Enter a positive ${transaction.currency} refund amount with at most ${currencyMinorUnits(transaction.currency)} decimal places.`);
      return;
    }
    refund.mutate({ reference, data: { ...(amount ? { amount: Number(amount) } : {}), reason } }, {
      onSuccess: (r) => { setMessage(r.status === 'processed' ? `Refund ${r.reference} reported as processed by the server.` : r.status === 'manual_required' ? `Refund ${r.reference} needs manual action. No customer funds have been returned yet.` : `Refund ${r.reference} is ${r.status.replaceAll('_', ' ')}. This is a recorded request; customer funds are not confirmed returned.`); setRefundOpen(false); void query.refetch(); },
      onError: (err) => setMessage(errMsg(err)),
    });
  }
  return <div className="modal-backdrop detail-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="detail-drawer" role="dialog" aria-modal="true" aria-label="Transaction details">
      <div className="drawer-head"><div><span className="eyebrow">PAYMENT RECORD</span><h2>Transaction details</h2></div><button className="icon-button" onClick={onClose} aria-label="Close details"><X size={18} /></button></div>
      <QueryState loading={query.isLoading} error={query.isError} retry={() => { void query.refetch(); }} empty={!transaction}>
        <>{transaction && <>
          <div className="transaction-amount"><div className="eyebrow">GROSS AMOUNT</div><strong>{currency(transaction.amount, transaction.currency)}</strong><div><StatusPill value={transaction.status} /><span className="mono">{transaction.reference}</span></div></div>
          <div className="drawer-actions"><Button variant="secondary" disabled={verify.isPending} onClick={() => verify.mutate({ reference }, { onSuccess: () => { setMessage('Provider verification complete.'); void query.refetch(); }, onError: () => setMessage('Provider verification failed. Try again later.') })}><RefreshCw size={14} />{verify.isPending ? 'Verifying' : 'Verify'}</Button><Button variant="danger" disabled={transaction.status !== 'success'} onClick={() => setRefundOpen((open) => !open)}><ArrowDownLeft size={14} /> Refund</Button></div>
          {refundOpen && <form className="refund-form" onSubmit={submitRefund}>
            <strong>Record a refund</strong>
            <Field label="Amount (leave blank for full refund)"><input name="amount" type="number" min={currencyMinorUnits(transaction.currency) === 0 ? '1' : '0.01'} max={transaction.amount} step={currencyAmountStep(transaction.currency)} placeholder={String(transaction.amount)} /></Field>
            <Field label="Reason"><input name="reason" placeholder="Reason for refund" /></Field>
            <Button type="submit" disabled={refund.isPending}>{refund.isPending ? 'Submitting…' : 'Submit refund'}</Button>
          </form>}
          {message && <Notice danger={message.includes('failed') || message.includes('could not')}>{message}</Notice>}
          <div className="detail-section"><div className="detail-section-heading">Payment details</div><DetailRow label="Customer" value={transaction.customerName || '—'} /><DetailRow label="Email" value={transaction.customerEmail} /><DetailRow label="Phone" value={transaction.customerPhone || '—'} /><DetailRow label="Method" value={transaction.paymentMethod || '—'} /><DetailRow label="Provider" value={label(transaction.provider)} /><DetailRow label="Description" value={transaction.description || '—'} /></div>
          <div className="detail-section"><div className="detail-section-heading">Settlement timeline</div><DetailRow label="Gross amount" value={currency(transaction.amount, transaction.currency)} /><DetailRow label="Fee" value={currency(transaction.fee, transaction.currency)} /><DetailRow label="Net amount" value={currency(transaction.netAmount, transaction.currency)} /><DetailRow label="Expected settlement" value={dateTime(transaction.settlementAt)} /><DetailRow label="Settlement status" value={label(transaction.settlementStatus)} /><DetailRow label="Created" value={dateTime(transaction.createdAt)} /><DetailRow label="Paid" value={dateTime(transaction.paidAt)} /></div>
        </>}</>
      </QueryState>
    </section>
  </div>;
}

function DetailRow({ label: title, value }: { label: string; value: string }) {
  return <div className="detail-row"><span>{title}</span><strong>{value}</strong></div>;
}

type PaymentLinkCurrencyTotal = { currency: string; amount: number };
type PaymentLinkTotalsSource = {
  currency: string;
  totalPaid: number;
  totalPaidByCurrency?: PaymentLinkCurrencyTotal[] | null;
};

function LinkCollectedTotals({ link, format }: {
  link: PaymentLinkTotalsSource;
  format: (amount: number, currencyCode: string) => string;
}) {
  const totals = Array.isArray(link.totalPaidByCurrency)
    ? link.totalPaidByCurrency
    : [{ currency: link.currency, amount: link.totalPaid }];
  return totals.length
    ? <>{totals.map((total) => <span key={total.currency} style={{ display: 'block' }}>{format(total.amount, total.currency)}</span>)}</>
    : <>—</>;
}

function PaymentLinks() {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const params = useMemo(() => ({ search: search || undefined }), [search]);
  const query = useListPaymentLinks(params);
  const update = useUpdatePaymentLink();
  const remove = useDeletePaymentLink();
  const [notice, setNotice] = useState('');
  const items = query.data?.items ?? [];
  const visibleItems = items.filter((item) => statusFilter === 'all' || item.status === statusFilter);
  const activeCount = items.filter((item) => item.status === 'active').length;
  const paymentCount = items.reduce((total, item) => total + item.paidCount, 0);
  async function share(url: string) {
    try { await navigator.clipboard.writeText(url); setNotice('Payment link copied to clipboard.'); }
    catch { setNotice('Could not copy automatically. Open the link to copy it manually.'); }
  }
  return <><PageHeading eyebrow="COLLECTIONS / SELF-SERVE" title="Payment links" subtitle="Create a checkout page, then share it wherever customers are." action={<Button onClick={() => setCreateOpen(true)}><Plus size={16} /> Create payment link</Button>} />
    <div className="link-summary-strip"><div className="link-summary-copy"><span className="strip-icon"><Link2 size={17} /></span><div><strong>One link, ready to share</strong><span>Set a fixed price or let customers choose the amount. Payments remain in the link’s selected currency.</span></div></div><div className="strip-route"><span className="route-hint-dot" /> Secure, currency-based checkout <ArrowRight size={14} /></div></div>
    <div className="link-insights" aria-label="Payment link summary">
      <article><span>Matching links</span><strong>{items.length}</strong><small>Based on the current search</small></article>
      <article><span>Active links</span><strong>{activeCount}</strong><small>Ready to accept payments</small></article>
      <article><span>Payments recorded</span><strong>{paymentCount}</strong><small>Across matching links</small></article>
    </div>
    {notice && <div className="inline-notice"><CheckCircle2 size={15} />{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notification"><X size={14} /></button></div>}
    <div className="links-toolbar">
      <label className="search-box"><Search size={16} /><input aria-label="Search payment links" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search links by name" data-testid="input-payment-link-search" /></label>
      <div className="link-filter-group" role="group" aria-label="Filter payment links">
        {(['all', 'active', 'paused'] as const).map((filter) => <button key={filter} type="button" className={`link-filter ${statusFilter === filter ? 'is-selected' : ''}`} aria-pressed={statusFilter === filter} onClick={() => setStatusFilter(filter)}>{filter === 'all' ? 'All links' : filter === 'active' ? 'Active' : 'Paused'}</button>)}
      </div>
      <span className="list-count">{visibleItems.length} of {items.length} links</span>
    </div>
    <QueryState loading={query.isLoading} error={query.isError} retry={() => { void query.refetch(); }} empty={!items.length}>
      {visibleItems.length
        ? <div className="links-grid">{visibleItems.map((item) => <article key={item.id} className="link-card" data-testid={`card-payment-link-${item.id}`}>
          <div className="link-card-top"><span className="link-card-icon"><Link2 size={17} /></span><StatusPill value={item.status} /></div>
          <div className="link-card-copy"><h2>{item.name}</h2><p>{item.description || 'No description added'}</p></div>
          <div className="link-price">{item.amountType === 'fixed' ? currency(item.amount, item.currency) : 'Customer chooses'}<small>{item.amountType === 'fixed' ? `Fixed in ${item.currency}` : `Payer selects currency · ${item.currency} default`}</small></div>
          <div className="link-performance"><div><strong>{item.paidCount}</strong><span>payments</span></div><div><strong><LinkCollectedTotals link={item} format={currency} /></strong><span>collected</span></div><div><strong>{item.expiresAt ? dateOnly(item.expiresAt) : 'Never'}</strong><span>expires</span></div></div>
          <div className="link-url"><span className="mono" title={item.url}>{item.url}</span><button className="icon-button" title="Copy payment link" aria-label="Copy payment link" onClick={() => { void share(item.url); }} data-testid={`button-copy-link-${item.id}`}><Copy size={15} /></button></div>
          <div className="link-card-actions"><Button variant="secondary" onClick={() => { void share(item.url); }}><Copy size={14} /> Share</Button><Button variant="quiet" onClick={() => setEditing(item)}><SlidersHorizontal size={14} /> Edit</Button>{item.status === 'active' ? <Button variant="quiet" disabled={update.isPending} onClick={() => update.mutate({ id: item.id, data: { status: 'paused' } }, { onSuccess: () => { setNotice('Payment link paused.'); void query.refetch(); }, onError: () => setNotice('Could not pause this payment link.') })}>Pause</Button> : item.status === 'paused' ? <Button variant="quiet" disabled={update.isPending} onClick={() => update.mutate({ id: item.id, data: { status: 'active' } }, { onSuccess: () => { setNotice('Payment link resumed.'); void query.refetch(); }, onError: () => setNotice('Could not resume this payment link.') })}>Resume</Button> : null}<Button variant="quiet" className="archive-action" disabled={remove.isPending} onClick={() => { if (window.confirm(`Archive “${item.name}”? Existing payment records will remain available.`)) remove.mutate({ id: item.id }, { onSuccess: () => { setNotice('Payment link archived.'); void query.refetch(); }, onError: () => setNotice('Could not archive this payment link.') }); }}>Archive</Button></div>
        </article>)}</div>
        : <div className="links-filter-empty"><strong>No links match this filter</strong><span>Choose another status or clear your search.</span><Button variant="secondary" onClick={() => { setStatusFilter('all'); setSearch(''); }}>Clear filters</Button></div>}
    </QueryState>
    {createOpen && <PaymentLinkForm onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void query.refetch(); }} />}
    {editing && <PaymentLinkEdit link={editing} onClose={() => setEditing(null)} onUpdated={() => { setEditing(null); void query.refetch(); }} />}
  </>;
}

function PaymentLinkForm({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const create = useCreatePaymentLink();
  const currencyCatalog = useListSupportedCurrencies();
  const supportedCurrencies = currencyCatalog.data?.items ?? [];
  const [error, setError] = useState('');
  const [currencyCode, setCurrencyCode] = useState('USD');
  const [amountType, setAmountType] = useState<'fixed' | 'customer_choice'>('fixed');
  const selectedCurrency = supportedCurrencies.find((item) => item.code === currencyCode);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCurrency) {
      setError('Load the supported currency list before creating this payment link.');
      return;
    }
    const form = new FormData(event.currentTarget);
    const submittedAmountType = String(form.get('amountType')) as 'fixed' | 'customer_choice';
    const amount = Number(form.get('amount'));
    const currency = String(form.get('currency'));
    const payload = { name: String(form.get('name')), description: String(form.get('description') || ''), amountType: submittedAmountType, currency, ...(submittedAmountType === 'fixed' ? { amount } : {}), ...(form.get('expiresAt') ? { expiresAt: String(form.get('expiresAt')) } : {}) };
    if (submittedAmountType === 'fixed' && !isCurrencyAmountValid(amount, currency)) {
      setError(`Enter a positive ${currency} amount with at most ${currencyMinorUnits(currency)} decimal places.`);
      return;
    }
    create.mutate({ data: payload }, { onSuccess: onCreated, onError: () => setError('Could not create the payment link. Check the form and try again.') });
  }
  return <Modal title="Create payment link" description="Fixed-price links keep the currency you choose. Customer-choice links can offer the supported currencies to the payer." onClose={onClose}>
    <form className="form-stack" onSubmit={submit}>
      <Field label="Link name"><input name="name" placeholder="e.g. May studio retainer" required data-testid="input-link-name" /></Field>
      <Field label="Description"><textarea name="description" placeholder="What is this payment for?" rows={2} data-testid="input-link-description" /></Field>
      <div className="form-grid">
        <Field label="Amount type"><select name="amountType" value={amountType} onChange={(event) => setAmountType(event.target.value as 'fixed' | 'customer_choice')} data-testid="select-link-amount-type"><option value="fixed">Fixed amount</option><option value="customer_choice">Customer chooses</option></select></Field>
        <Field label="Link currency"><select name="currency" value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value)} disabled={currencyCatalog.isLoading || !supportedCurrencies.length} data-testid="select-link-currency">
          {supportedCurrencies.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.name}{item.comingSoon ? ' · Coming soon' : item.collectionReady ? '' : ' · unavailable'}</option>)}
        </select></Field>
      </div>
      {currencyCatalog.isLoading && <span className="sub">Loading supported currencies and payment availability…</span>}
      {currencyCatalog.isError && <div className="provider-warning"><CircleAlert size={15} /><span>Supported currencies could not be loaded.</span><Button variant="secondary" disabled={currencyCatalog.isFetching} onClick={() => { void currencyCatalog.refetch(); }}>{currencyCatalog.isFetching ? 'Checking…' : 'Retry'}</Button></div>}
      {selectedCurrency && !selectedCurrency.collectionReady && <div className="provider-warning"><CircleAlert size={15} /><span>{selectedCurrency.comingSoon ? `Coming soon: new collections in ${selectedCurrency.code} are disabled. You can still create or edit this payment link; existing links remain visible.` : `Checkout in ${selectedCurrency.code} is not currently available. You can create the link now; payments will be unavailable until this currency route is enabled.`}</span></div>}
      {amountType === 'fixed' && <Field label="Amount"><input name="amount" type="number" min={currencyMinorUnits(currencyCode) === 0 ? '1' : '0.01'} step={currencyAmountStep(currencyCode)} placeholder="0.00" required data-testid="input-link-amount" /></Field>}
      <Field label="Expires on (optional)"><input name="expiresAt" type="date" data-testid="input-link-expiry" /></Field>
      <ErrorLine error={error} />
      <div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={create.isPending || currencyCatalog.isLoading || !selectedCurrency}>{create.isPending ? 'Creating…' : 'Create link'} <ArrowRight size={14} /></Button></div>
    </form>
  </Modal>;
}

function PaymentLinkEdit({ link, onClose, onUpdated }: { link: any; onClose: () => void; onUpdated: () => void }) {
  const update = useUpdatePaymentLink();
  const [error, setError] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const expires = String(form.get('expiresAt') || '');
    update.mutate({ id: link.id, data: { name: String(form.get('name')), description: String(form.get('description') || ''), expiresAt: expires ? new Date(`${expires}T23:59:59`).toISOString() : null } }, { onSuccess: onUpdated, onError: () => setError('Could not update this payment link.') });
  }
  return <Modal title="Edit payment link" description="Update the details customers see." onClose={onClose}><form className="form-stack" onSubmit={submit}><Field label="Link name"><input name="name" defaultValue={link.name} required data-testid="input-edit-link-name" /></Field><Field label="Description"><textarea name="description" defaultValue={link.description || ''} rows={3} data-testid="input-edit-link-description" /></Field><Field label="Expires on"><input name="expiresAt" type="date" defaultValue={link.expiresAt ? new Date(link.expiresAt).toISOString().slice(0, 10) : ''} data-testid="input-edit-link-expiry" /></Field><ErrorLine error={error} /><div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={update.isPending}>{update.isPending ? 'Saving…' : 'Save changes'}</Button></div></form></Modal>;
}

function Payouts() {
  const [currencyCode, setCurrencyCode] = useState('KES');
  const [status, setStatus] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const params = useMemo(() => ({ currency: undefined, status: (status || undefined) as any }), [status]);
  const query = useListPayouts(params);
  const methodsParams = useMemo(() => ({ currency: currencyCode }), [currencyCode]);
  const methods = useListPayoutMethods(methodsParams);
  const bankParams = useMemo(() => ({ country: currencyCode === 'KES' ? 'KE' : currencyCode === 'NGN' ? 'NG' : currencyCode === 'GHS' ? 'GH' : 'KE' }), [currencyCode]);
  const banks = useListBanks(bankParams);
  const [selected, setSelected] = useState<any>(null);
  return <><PageHeading eyebrow="OUTBOUND / DISBURSEMENT" title="Payouts" subtitle="Create a payout and keep every transfer accountable." action={<Button onClick={() => setCreateOpen(true)} disabled={methods.data?.available === false}><Plus size={16} /> Create payout</Button>} />
    <div className="payout-intro"><div className="payout-intro-icon"><WalletCards size={19} /></div><div><strong>Payzaapi payouts</strong><span>Available methods and fees are fetched live for each currency.</span></div><div className="payout-intro-meta"><span>Minimum withdrawal</span><strong>{methods.data?.available ? currency(methods.data.minimumWithdrawal, methods.data.currency) : '—'}</strong></div></div>
    <div className="toolbar-filters payout-filters"><label className="select-wrap"><Globe2 size={14} /><select value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value)} data-testid="select-payout-currency">{CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}</select></label><label className="select-wrap"><Filter size={14} /><select value={status} onChange={(event) => setStatus(event.target.value)} data-testid="select-payout-status"><option value="">All statuses</option><option value="pending">Pending</option><option value="processing">Processing</option><option value="approved">Approved</option><option value="completed">Completed</option><option value="failed">Failed</option><option value="rejected">Rejected</option></select></label><span className="filter-note">{methods.isLoading ? 'Checking methods…' : methods.data?.available ? `${methods.data.methods.length} method${methods.data.methods.length === 1 ? '' : 's'} available for ${currencyCode}` : 'Payout method unavailable for this currency'}</span></div>
    <Panel title="Payout queue" subtitle="Latest outbound transfers" className="table-panel"><QueryState loading={query.isLoading} error={query.isError} retry={() => { void query.refetch(); }} empty={!query.data?.items?.length}><div className="table-scroll"><table className="data-table"><thead><tr><th>Transfer</th><th>Recipient</th><th>Method</th><th>Amount</th><th>Provider</th><th>Status</th><th>Created</th></tr></thead><tbody>{(query.data?.items || []).map((item) => <tr key={item.id} onClick={() => setSelected(item)} className="table-row-clickable" data-testid={`row-payout-${item.id}`}><td><strong className="mono ref-cell">{item.reference}</strong><small>{item.currency}</small></td><td><strong>{item.accountName}</strong><small>{item.maskedAccount || 'Account details protected'}</small></td><td>{label(item.method)}</td><td><strong className="amount-cell">{currency(item.amount, item.currency)}</strong><small>Net {currency(item.netAmount, item.currency)}</small></td><td>{label(item.provider)}</td><td><StatusPill value={item.status} /></td><td>{dateTime(item.createdAt)}</td></tr>)}</tbody></table></div></QueryState></Panel>
    {createOpen && <PayoutForm currencyCode={currencyCode} methods={methods.data} banks={banks.data?.banks || []} onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); void query.refetch(); }} />}
    {selected && <Modal title="Payout review" description="Confirm transfer details before acting outside this console." onClose={() => setSelected(null)}><div className="transaction-amount"><span className="eyebrow">PAYOUT AMOUNT</span><strong>{currency(selected.amount, selected.currency)}</strong><div><StatusPill value={selected.status} /><span className="mono">{selected.reference}</span></div></div><div className="detail-section"><DetailRow label="Recipient" value={selected.accountName} /><DetailRow label="Account" value={selected.maskedAccount || 'Protected'} /><DetailRow label="Method" value={label(selected.method)} /><DetailRow label="Provider" value={label(selected.provider)} /><DetailRow label="Fee" value={currency(selected.fee, selected.currency)} /><DetailRow label="Net payout" value={currency(selected.netAmount, selected.currency)} /><DetailRow label="Created" value={dateTime(selected.createdAt)} /></div><div className="provider-warning"><LockKeyhole size={15} />Payout review and approval actions are controlled by provider-side status. This console does not create an approval action.</div></Modal>}
  </>;
}

function PayoutForm({ currencyCode, methods, banks, onClose, onCreated }: { currencyCode: string; methods: any; banks: any[]; onClose: () => void; onCreated: () => void }) {
  const create = useCreatePayout();
  const intentKey = useRef(crypto.randomUUID());
  const merchants = useListAdminMerchants();
  const [merchantId, setMerchantId] = useState('');
  const [method, setMethod] = useState(methods?.methods?.[0]?.value || '');
  const [error, setError] = useState('');
  const [bankFields, setBankFields] = useState({ code: '', name: '' });
  const selectedMethod = methods?.methods?.find((item: any) => item.value === method);
  const minimumAmount = currencyMinorUnits(currencyCode) === 0
    ? Math.ceil(Math.max(methods?.minimumWithdrawal || 0, 1))
    : Math.max(methods?.minimumWithdrawal || 0, 0.01);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const amount = Number(form.get('amount'));
    if (!methods?.available || !method) { setError('No payout method is available for this currency.'); return; }
    if (!isCurrencyAmountValid(amount, currencyCode)) {
      setError(`Enter a positive ${currencyCode} payout amount with at most ${currencyMinorUnits(currencyCode)} decimal places.`);
      return;
    }
    if (amount < (methods.minimumWithdrawal || 0)) { setError(`The minimum payout is ${currency(methods.minimumWithdrawal, currencyCode)}.`); return; }
    const fundingSource: 'merchant_wallet' | 'platform' = merchantId ? 'merchant_wallet' : 'platform';
    const payload = { fundingSource, idempotencyKey: intentKey.current, ...(merchantId ? { merchantId: Number(merchantId) } : {}), amount, currency: currencyCode, method, accountNumber: String(form.get('accountNumber')), accountName: String(form.get('accountName')), ...(bankFields.code ? { bankCode: bankFields.code, bankName: bankFields.name } : {}) };
    create.mutate({ data: payload }, { onSuccess: onCreated, onError: (err) => setError(errMsg(err)) });
  }
  return <Modal title="Create payout" description="Merchant payouts reserve funded wallet balances. Platform payouts use external platform funds, not merchant wallets." onClose={onClose}>
    <form className="form-stack" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Amount"><input name="amount" type="number" min={minimumAmount} step={currencyAmountStep(currencyCode)} placeholder="0.00" required data-testid="input-payout-amount" /></Field>
        <Field label="Currency"><input value={currencyCode} readOnly /></Field>
      </div>
      <Field label="Attribute to merchant (optional)"><select value={merchantId} onChange={(event) => setMerchantId(event.target.value)} data-testid="select-payout-merchant"><option value="">Platform payout (no merchant)</option>{(merchants.data?.items || []).map((m) => <option key={m.id} value={m.id}>{m.businessName}</option>)}</select></Field>
      <Field label="Payout method"><select value={method} onChange={(event) => setMethod(event.target.value)} required data-testid="select-payout-method">{(methods?.methods || []).map((item: any) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
      <Field label="Account name"><input name="accountName" placeholder="Account holder name" required data-testid="input-payout-account-name" /></Field>
      <Field label="Account number"><input name="accountNumber" placeholder="Account number or wallet" required data-testid="input-payout-account-number" /></Field>
      {selectedMethod?.requiresBankFields && <Field label="Bank"><select value={bankFields.code} onChange={(event) => { const selected = banks.find((bank) => bank.code === event.target.value); setBankFields({ code: event.target.value, name: selected?.name || '' }); }} required data-testid="select-payout-bank"><option value="">Choose a bank</option>{banks.map((bank) => <option value={bank.code} key={bank.code}>{bank.name}</option>)}</select></Field>}
      <div className="fee-quote"><span>Provider fee</span><strong>{methods?.fee?.type === 'percent' ? `${methods.fee.amount}%` : currency(methods?.fee?.amount, currencyCode)}</strong></div>
      <ErrorLine error={error} />
      <div className="form-actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" disabled={create.isPending || !methods?.available}>{create.isPending ? 'Creating…' : 'Create payout'} <ArrowRight size={14} /></Button></div>
    </form>
  </Modal>;
}

function Settlements() {
  const [status, setStatus] = useState('');
  const [currencyCode, setCurrencyCode] = useState('');
  const params = useMemo(() => ({ status: (status || undefined) as any, currency: currencyCode || undefined }), [status, currencyCode]);
  const query = useListSettlements(params);
  const rows = query.data?.items || [];
  const dueCount = rows.filter((item) => item.status === 'due').length;
  const openCount = rows.filter((item) => item.status !== 'settled').length;
  return <><PageHeading eyebrow="RECONCILIATION / T+3" title="Settlements" subtitle="Know what has landed, what is due and what needs a closer look." />
    <div className="settlement-summary"><div><span className="summary-icon"><Clock3 size={17} /></span><div><span>Open settlement items</span><strong>{openCount}</strong></div></div><div><span className="summary-divider" /><div><span>Due for review</span><strong>{dueCount} <small>items</small></strong></div></div><div className="summary-explainer"><FileClock size={15} /><span>T+3 is a tracking target. Actual settlement timing is provider-controlled.</span></div></div>
    <div className="toolbar-filters"><label className="select-wrap"><Filter size={14} /><select value={status} onChange={(event) => setStatus(event.target.value)} data-testid="select-settlement-status"><option value="">All statuses</option><option value="pending">Pending</option><option value="due">Due</option><option value="settled">Settled</option><option value="held">Held</option></select></label><label className="select-wrap"><Globe2 size={14} /><select value={currencyCode} onChange={(event) => setCurrencyCode(event.target.value)} data-testid="select-settlement-currency"><option value="">All currencies</option>{CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}</select></label></div>
    <Panel title="Settlement ledger" subtitle="Provider-level view of collection proceeds" className="table-panel"><QueryState loading={query.isLoading} error={query.isError} retry={() => { void query.refetch(); }} empty={!rows.length}><div className="table-scroll"><table className="data-table"><thead><tr><th>Reference</th><th>Provider</th><th>Gross</th><th>Net to settle</th><th>Expected by</th><th>Settled on</th><th>Method</th><th>Status</th></tr></thead><tbody>{rows.map((item) => <tr key={item.id} data-testid={`row-settlement-${item.id}`}><td><strong className="mono ref-cell">{item.reference}</strong></td><td><span className="provider-cell"><span className={`provider-mini provider-${item.provider}`} />{label(item.provider)}</span></td><td>{currency(item.amount, item.currency)}</td><td><strong className="amount-cell">{currency(item.netAmount, item.currency)}</strong></td><td>{dateOnly(item.expectedAt)}</td><td>{dateOnly(item.settledAt)}</td><td>{item.payoutMethod || '—'}</td><td><StatusPill value={item.status} /></td></tr>)}</tbody></table></div><div className="ledger-note"><CircleHelp size={15} /><span>Expected dates are calculated by the provider route. Bank holidays can affect the final settlement time.</span></div></QueryState></Panel>
  </>;
}

function Customers() {
  const [search, setSearch] = useState('');
  const params = useMemo(() => ({ search: search || undefined }), [search]);
  const query = useListCustomers(params);
  const items = query.data?.items || [];
  const orders = items.reduce((sum, item) => sum + item.orderCount, 0);
  const currenciesUsed = new Set(items.flatMap((item) => item.currencySummary.split(' · ').map((entry: string) => entry.trim().split(/\s+/)[0]).filter(Boolean))).size;
  return <><PageHeading eyebrow="RELATIONSHIPS / DIRECTORY" title="Customers" subtitle="A quick read of who pays, how often and in which currencies." />
    <div className="customer-metrics"><div><span>Customers in view</span><strong>{query.data?.items?.length ?? '—'}</strong></div><div><span>Currencies used</span><strong>{currenciesUsed}</strong></div><div><span>Orders in view</span><strong>{orders.toLocaleString()}</strong></div></div>
    <div className="list-toolbar"><label className="search-box"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name, email or phone" data-testid="input-customer-search" /></label><span className="list-count">Customers</span></div>
    <Panel className="table-panel"><QueryState loading={query.isLoading} error={query.isError} retry={() => { void query.refetch(); }} empty={!items.length}><div className="table-scroll"><table className="data-table"><thead><tr><th>Customer</th><th>Phone</th><th>Orders</th><th>Currency mix</th><th>Last payment</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} data-testid={`row-customer-${item.id}`}><td><div className="customer-cell"><span className="customer-avatar">{item.name.split(' ').map((word: string) => word[0]).slice(0, 2).join('')}</span><div><strong>{item.name}</strong><small>{item.email}</small></div></div></td><td>{item.phone || '—'}</td><td><strong>{item.orderCount}</strong></td><td><span className="currency-summary">{item.currencySummary || '—'}</span></td><td>{dateTime(item.lastPaymentAt)}</td></tr>)}</tbody></table></div></QueryState></Panel>
  </>;
}

function Webhooks() {
  const [status, setStatus] = useState('');
  const params = useMemo(() => ({ status: (status || undefined) as any }), [status]);
  const query = useListWebhookEvents(params);
  const replay = useReplayWebhookEvent();
  const [notice, setNotice] = useState('');
  const items = query.data?.items || [];
  const failedCount = items.filter((item) => item.status === 'failed').length;
  return <><PageHeading eyebrow="INTEGRATIONS / DELIVERY LOG" title="Webhooks" subtitle="Provider events are the source of truth. Inspect failures before replaying." action={<a className="btn btn-secondary" href="/settings"><Settings2 size={15} /> Provider settings</a>} />
    <div className="webhook-summary"><div className="webhook-summary-icon"><Webhook size={18} /></div><div><strong>{failedCount} failed event{failedCount === 1 ? '' : 's'}</strong><span>{failedCount ? 'Review the latest error, then replay the event.' : 'No failed events in the current view.'}</span></div><span className="webhook-live"><i /> Receiving events</span></div>
    {notice && <div className="inline-notice"><CheckCircle2 size={15} />{notice}<button onClick={() => setNotice('')} aria-label="Dismiss notification"><X size={14} /></button></div>}
    <div className="toolbar-filters"><label className="select-wrap"><Filter size={14} /><select value={status} onChange={(event) => setStatus(event.target.value)} data-testid="select-webhook-status"><option value="">All event outcomes</option><option value="processed">Processed</option><option value="failed">Failed</option><option value="ignored">Ignored</option></select></label><span className="filter-note">{items.length} events in view</span></div>
    <Panel title="Event delivery" subtitle="Inbound events from connected providers" className="table-panel"><QueryState loading={query.isLoading} error={query.isError} retry={() => { void query.refetch(); }} empty={!items.length}><div className="table-scroll"><table className="data-table"><thead><tr><th>Provider event</th><th>Reference</th><th>Delivery</th><th>HTTP</th><th>Attempts</th><th>Received</th><th>Last error</th><th>Action</th></tr></thead><tbody>{items.map((item) => <tr key={item.id} data-testid={`row-webhook-${item.id}`}><td><strong>{item.event}</strong><small>{label(item.provider)}</small></td><td className="mono">{item.reference || '—'}</td><td><StatusPill value={item.status} /></td><td>{item.httpStatus || '—'}</td><td>{item.attempts}</td><td>{dateTime(item.receivedAt)}</td><td><span className="error-snippet" title={item.lastError || ''}>{item.lastError || '—'}</span></td><td>{item.status === 'failed' ? <Button variant="secondary" className="compact-btn" disabled={replay.isPending} onClick={() => replay.mutate({ id: item.id }, { onSuccess: () => { setNotice(`Replay requested for ${item.event}.`); void query.refetch(); }, onError: () => setNotice(`Could not replay ${item.event}. Check provider configuration.`) })} testId={`button-replay-webhook-${item.id}`}><RefreshCw size={13} /> Replay</Button> : <span className="muted-dash">—</span>}</td></tr>)}</tbody></table></div></QueryState></Panel>
  </>;
}

function Settings() {
  const query = useGetProviderStatus();
  const providers = query.data?.items || [];
  const ready = providers.filter((item) => item.configured).length;
  return <><PageHeading eyebrow="CONFIGURATION / PROVIDERS" title="Provider readiness" subtitle="Know what is configured before anyone expects a payment to move." />
    <div className="readiness-banner"><div className="readiness-banner-mark"><ShieldCheck size={20} /></div><div><strong>{query.isLoading ? 'Checking provider access…' : `${ready} of ${providers.length} providers configured`}</strong><span>Credentials are represented as readiness only; secrets are never displayed here.</span></div><span className={`readiness-state ${ready === providers.length && providers.length ? 'ready' : 'needs-attention'}`}><i />{ready === providers.length && providers.length ? 'Ready' : 'Action needed'}</span></div>
    <QueryState loading={query.isLoading} error={query.isError} retry={() => { void query.refetch(); }} empty={!providers.length}><div className="settings-provider-list">{providers.map((provider) => <article className="settings-provider-card" key={provider.provider} data-testid={`provider-card-${provider.provider}`}><div className="settings-provider-top"><div className={`provider-glyph glyph-${provider.provider}`}>{provider.provider === 'paystack' ? 'P' : provider.provider === 'payhero' ? 'H' : 'Pz'}</div><div className="settings-provider-title"><h2>{label(provider.provider)}</h2><span>{provider.mode === 'unknown' ? 'Mode unavailable' : `${label(provider.mode)} mode`}</span></div><StatusPill value={provider.configured ? 'configured' : 'not configured'} /></div><div className="provider-capabilities"><div><span>Collection</span><StatusPill value={provider.collectionsEnabled ? 'enabled' : 'disabled'} /></div><div><span>Payouts</span><StatusPill value={provider.payoutsEnabled ? 'enabled' : 'disabled'} /></div></div><div className="provider-currencies"><span className="eyebrow">SUPPORTED CURRENCIES</span><div>{provider.currencies.length ? provider.currencies.map((code) => <span key={code}>{code}</span>) : <em>No currencies available</em>}</div></div><div className={`provider-credentials ${provider.configured ? 'credential-ok' : 'credential-missing'}`}>{provider.configured ? <><CheckCircle2 size={15} /> Credentials configured</> : <><KeyRound size={15} /> Provider credentials are missing</>}</div>{provider.note && <p className="provider-admin-note">{provider.note}</p>}</article>)}</div></QueryState>
    <Panel title="How currency routing works" subtitle="Collection routes are selected automatically from the transaction currency." className="routing-panel"><div className="routing-rule"><span>USD</span><ArrowRight size={14} /><strong>Paystack</strong><small>USD collections</small></div><div className="routing-rule"><span>KES</span><ArrowRight size={14} /><strong>PayHero</strong><small>Kenyan shilling collections</small></div><div className="routing-rule"><span>Other</span><ArrowRight size={14} /><strong>Payzaapi</strong><small>All other collection currencies</small></div></Panel>
  </>;
}

function PublicCheckout() {
  const branding = usePlatformBranding();
  const slug = window.location.pathname.split('/').filter(Boolean).at(-1) || '';
  const query = useGetPublicPaymentLink(slug);
  const checkout = useCheckoutPaymentLink();
  const [error, setError] = useState('');
  const [currencySelection, setCurrencySelection] = useState('');
  const [paymentMethodSelection, setPaymentMethodSelection] = useState('');
  const [checkoutResult, setCheckoutResult] = useState<{ url: string | null; reference: string; nextAction: 'redirect' | 'mobile_prompt' | 'check_status' } | null>(null);
  const link = query.data;
  const invoiceBalance = typeof link?.invoiceOutstandingAmount === 'number' ? link.invoiceOutstandingAmount : null;
  const availableCurrencies = link?.availableCurrencies ?? [];
  const hasReadyCurrencyOption = availableCurrencies.some((item) => item.collectionReady);
  const canChooseCurrency = link?.amountType === 'customer_choice' && invoiceBalance === null;
  const currencyCode = canChooseCurrency && availableCurrencies.some((item) => item.code === currencySelection)
    ? currencySelection
    : link?.currency ?? '';
  const currencyOption = availableCurrencies.find((item) => item.code === currencyCode);
  const paymentMethods = currencyOption?.paymentMethods ?? [];
  const selectedMethod = paymentMethods.find((item) => item.id === paymentMethodSelection && item.ready)
    ?? paymentMethods.find((item) => item.ready);
  const selectedMethodId = selectedMethod?.id ?? '';
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    if (!link || !currencyOption?.collectionReady || !selectedMethod) {
      setError(`Payments are not currently available in ${currencyCode || 'this currency'}. Refresh availability or contact the merchant.`);
      return;
    }
    const form = new FormData(event.currentTarget);
    const amount = Number(form.get('amount'));
    if ((link.amountType === 'customer_choice' || invoiceBalance !== null) && !isCurrencyAmountValid(amount, currencyCode)) {
      setError(`Enter a positive ${currencyCode} amount with at most ${currencyMinorUnits(currencyCode)} decimal places.`);
      return;
    }
    if (invoiceBalance !== null && amount > invoiceBalance) {
      setError('The payment cannot exceed the outstanding invoice balance. Refresh this page if another payment has been made.');
      return;
    }
    const customerPhone = String(form.get('phone') || '').trim();
    if (selectedMethod.requiresPhone && !customerPhone) {
      setError('Enter a phone number to continue with this payment method.');
      return;
    }
    checkout.mutate({ slug, data: {
      currency: currencyCode,
      paymentMethod: selectedMethod.id,
      customerEmail: String(form.get('email')),
      customerName: String(form.get('name') || ''),
      customerPhone,
      ...(link.amountType === 'customer_choice' || invoiceBalance !== null ? { amount } : {}),
    } }, {
      onSuccess: (result) => setCheckoutResult({ url: result.checkoutUrl, reference: result.reference, nextAction: result.nextAction }),
      onError: (failure) => setError(errMsg(failure)),
    });
  }
  return (
    <div className="checkout-page">
      <header className="checkout-header"><Brand /></header>
      <main className="checkout-card">
        {link && <div className="customer-shop-brand" data-testid="checkout-shop-brand">
          {link.shopLogoUrl
            ? <img src={link.shopLogoUrl} alt={`${link.shopName || branding.platformName} shop image`} />
            : <span className="customer-shop-placeholder">{(link.shopName || branding.platformName).slice(0, 1).toUpperCase()}</span>}
          <div className="customer-shop-name"><span>PAYING</span><strong>{link.shopName || branding.platformName}</strong></div>
        </div>}
        <QueryState loading={query.isLoading} error={query.isError} retry={() => { void query.refetch(); }} empty={!link}>
          {link && (checkoutResult ? (
            <div className="checkout-success">
              <div className="checkout-success-icon"><ArrowUpRight size={21} /></div>
              <span className="eyebrow">{checkoutResult.nextAction === 'mobile_prompt' ? 'PAYMENT REQUEST SENT' : 'PAYMENT SESSION READY'}</span>
              <h1>{checkoutResult.nextAction === 'mobile_prompt' ? 'Check your phone' : checkoutResult.url ? 'Continue to payment' : 'Check your payment status'}</h1>
              <p>{checkoutResult.nextAction === 'mobile_prompt'
                ? 'Approve the payment request on your phone to continue. Your payment is only complete after confirmation.'
                : checkoutResult.url ? 'Your payment session is ready. Continue to the secure payment page to complete it.'
                  : 'Your payment request has been submitted. Open its status page to check for confirmation.'}</p>
              <span className="checkout-trust">Reference: <span className="mono">{checkoutResult.reference}</span></span>
              {checkoutResult.url && <a href={checkoutResult.url} className="btn btn-primary btn-full" target="_blank" rel="noreferrer" data-testid="link-checkout-continue">Continue to secure payment <ArrowRight size={15} /></a>}
              <a href={`${basePath}/status/${encodeURIComponent(checkoutResult.reference)}`} className="text-link" data-testid="link-checkout-status">View payment status <ArrowRight size={15} /></a>
              <span className="checkout-trust">{branding.platformName} only marks your payment successful once it has been confirmed.</span>
            </div>
          ) : (
            <>
              <span className="eyebrow">PAYMENT REQUEST</span>
              <h1>{link.name}</h1>
              <p className="checkout-description">{link.description || 'Complete your details to continue to secure payment.'}</p>
               <div className="checkout-price">{invoiceBalance !== null ? currency(invoiceBalance, link.currency) : link.amountType === 'fixed' ? currency(link.amount, link.currency) : 'Pay what you choose'}<span>{invoiceBalance !== null ? 'Outstanding invoice balance · full or partial payment' : link.amountType === 'customer_choice' ? 'Choose your payment currency below · no currency conversion is applied' : `${link.currency} · fixed one-time payment`}</span></div>
              <form className="form-stack checkout-form" onSubmit={submit}>
                {canChooseCurrency
                  ? <Field label="Payment currency"><select value={currencyCode} onChange={(event) => {
                    const nextCode = event.target.value;
                    setCurrencySelection(nextCode);
                    setPaymentMethodSelection(availableCurrencies.find((item) => item.code === nextCode)?.paymentMethods.find((item) => item.ready)?.id ?? '');
                    setError('');
                  }} data-testid="select-checkout-currency">
                      {availableCurrencies.map((item) => <option key={item.code} value={item.code} disabled={!item.collectionReady}>{item.code} · {item.name}{item.comingSoon ? ' · Coming soon' : item.collectionReady ? '' : ' · unavailable'}</option>)}
                  </select></Field>
                  : <Field label="Payment currency"><input value={`${link.currency} · ${invoiceBalance !== null ? 'invoice amount; currency locked' : 'fixed amount; currency locked'}`} readOnly /></Field>}
                <Field label="Payment method"><select value={selectedMethodId} onChange={(event) => setPaymentMethodSelection(event.target.value)} disabled={!paymentMethods.some((item) => item.ready)} required data-testid="select-checkout-payment-method">
                  {selectedMethodId === '' && <option value="">{currencyOption?.comingSoon ? 'Coming soon' : currencyOption?.collectionReady ? 'No payment method available' : 'No payment method available right now'}</option>}
                  {paymentMethods.map((method) => <option key={method.id} value={method.id} disabled={!method.ready}>{method.label}{method.requiresPhone ? ' · phone required' : ''}{method.ready ? '' : currencyOption?.comingSoon ? ' · Coming soon' : ' · unavailable'}</option>)}
                </select></Field>
                {selectedMethod && <span className="checkout-trust">{selectedMethod.id === 'mobile_prompt'
                  ? 'Mobile money is requested through a secure M-Pesa prompt on your phone.'
                  : 'The secure checkout shows any card, mobile-money, or bank options available for this currency.'}</span>}
                {(link.amountType === 'customer_choice' || invoiceBalance !== null) && <Field label={invoiceBalance !== null ? `Payment amount (${currencyCode}), up to ${currency(invoiceBalance, link.currency)}` : `Amount (${currencyCode})`}><input key={currencyCode} name="amount" type="number" min={currencyMinorUnits(currencyCode) === 0 ? '1' : '0.01'} max={invoiceBalance ?? undefined} defaultValue={invoiceBalance ?? undefined} step={currencyAmountStep(currencyCode)} placeholder="0.00" required data-testid="input-checkout-amount" /></Field>}
                <Field label="Email address"><input type="email" name="email" placeholder="you@example.com" autoComplete="email" required data-testid="input-checkout-email" /></Field>
                <Field label="Full name"><input name="name" placeholder="Name on payment" autoComplete="name" required data-testid="input-checkout-name" /></Field>
                <Field label={`Phone${selectedMethod?.requiresPhone ? ' (required for this method)' : ' (optional)'}`}><input name="phone" type="tel" placeholder="+254…" autoComplete="tel" required={selectedMethod?.requiresPhone} data-testid="input-checkout-phone" /></Field>
                {currencyOption && currencyOption.comingSoon && <div className="provider-warning"><CircleAlert size={15} /><span>Coming soon: collections in {currencyOption.code} are not enabled yet. This payment link remains visible, but cannot collect until the currency is launched.</span></div>}
                {currencyOption && !currencyOption.comingSoon && (!currencyOption.collectionReady || !paymentMethods.some((item) => item.ready)) && <div className="provider-warning"><CircleAlert size={15} /><span>{currencyOption.collectionReady
                  ? `No payment method is currently available for ${currencyOption.code}.`
                  : canChooseCurrency && hasReadyCurrencyOption
                    ? `Checkout in ${currencyOption.code} is not currently available. Choose another currency or refresh availability.`
                    : `Payments are not currently available for this payment link. Refresh availability or contact the merchant.`}</span><Button variant="secondary" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{query.isFetching ? 'Checking…' : 'Refresh availability'}</Button></div>}
                {!currencyOption && <div className="provider-warning"><CircleAlert size={15} /><span>The available payment options could not be loaded. Refresh this page before continuing.</span><Button variant="secondary" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{query.isFetching ? 'Checking…' : 'Retry'}</Button></div>}
                <ErrorLine error={error} />
                <Button type="submit" className="btn-full" disabled={checkout.isPending || query.isFetching || !currencyOption?.collectionReady || !selectedMethod} data-testid="button-checkout-submit">{checkout.isPending ? 'Preparing secure checkout…' : <>Continue to payment <ArrowRight size={15} /></>}</Button>
              </form>
            </>
          ))}
        </QueryState>
      </main>
      <footer className="checkout-bottom">
        <span className="checkout-security-note"><LockKeyhole size={13} /> Secure checkout</span>
        <a href={basePath || '/'} data-testid="link-checkout-home">Powered by <strong>{branding.platformName}</strong></a>
      </footer>
    </div>
  );
}

const wrap = (C: () => ReactNode) => () => <Protected><AppShell><C /></AppShell></Protected>;
const protectedRoutes: [string, () => ReactNode][] = [
  ['/admin/merchants/:merchantId/controls', AdminMerchantControlsPage],
  ['/admin/email-delivery', AdminEmailDeliveryPage], ['/admin/content', AdminContentPage],
  ['/merchant/dashboard', MerchantDashboardPage], ['/merchant', MerchantPage], ['/merchant/kyc', KycPage], ['/merchant/payment-links', MerchantLinksPage], ['/merchant/transactions', MerchantTransactionsPage], ['/merchant/payouts', MerchantPayoutsPage],
  ['/developers', DevelopersPage], ['/exchange', ExchangePage], ['/admin', AdminSummaryPage], ['/admin/merchants', AdminMerchantsPage], ['/admin/fees', AdminFeesPage],
  ['/admin/exchange', AdminExchangePage], ['/admin/credentials', AdminCredentialsPage], ['/admin/settings', AdminSettingsPage], ['/admin/audit', AdminAuditPage],
  ['/admin/administrators', AdminPlatformAdminsPage],
  ['/support', SupportPage], ['/admin/support', AdminSupportPage], ['/profile', ProfilePage], ['/notifications', NotificationsPage],
  ['/admin/verification-limits', VerificationLimitsPage], ['/developers/docs', DeveloperDocsPage],
  ['/wallets', WalletPage], ['/payout-requests', PayoutRequestsPage], ['/admin/wallets', AdminWalletsPage], ['/admin/payout-requests', AdminPayoutRequestsPage],
  ['/invoices', InvoicePage], ['/invoices/:id', InvoiceDetailPage], ['/statements', StatementsPage], ['/cases', CasesPage], ['/admin/cases', AdminCasesPage],
  ['/team', MerchantTeamPage],
];
protectedRoutes.push(['/operations', () => <Gate need="admin"><Dashboard /></Gate>]);
const protectedRouteElements = protectedRoutes.map(([path, C]) => <Route key={path} path={path} component={wrap(() => path.startsWith('/admin') ? <Gate need="admin"><C /></Gate> : <C />)} />);
const publicContentRoutes = [
  <Route key="api-docs" path="/api-docs" component={PublicApiDocsPage} />,
  <Route key="learn" path="/learn" component={PublicHelpPage} />,
  <Route key="learn-detail" path="/learn/:slug" component={() => <PublicContentPage kind="faq" />} />,
  <Route key="guides" path="/guides" component={() => <PublicContentIndexPage kind="guide" />} />,
  <Route key="guide-detail" path="/guides/:slug" component={() => <PublicContentPage kind="guide" />} />,
  <Route key="articles" path="/articles" component={() => <PublicContentIndexPage kind="article" />} />,
  <Route key="article-detail" path="/articles/:slug" component={() => <PublicContentPage kind="article" />} />,
];
const extraRoutes = [...publicContentRoutes, ...protectedRouteElements];

function PublicOnlyApp() {
  return <TooltipProvider><Switch>{publicContentRoutes}<Route path="/" component={HomePage} /><Route path="/contact" component={ContactPage} /><Route path="/platform-status" component={PlatformStatusPage} /><Route path="/receipt/:reference" component={PublicReceiptPage} /><Route path="/pay/:slug" component={PublicCheckout} /><Route path="/status/:reference" component={StatusPage} /><Route component={AuthSetupScreen} /></Switch><Toaster /></TooltipProvider>;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  const branding = usePlatformBranding();
  const appearance = { ...clerkAppearance, options: { ...clerkAppearance.options, logoImageUrl: branding.logoUrl || clerkAppearance.options.logoImageUrl } };
  return <ClerkProvider publishableKey={clerkPubKey} proxyUrl={clerkProxyUrl} appearance={appearance} signInUrl={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} localization={{ signIn: { start: { title: 'Welcome back', subtitle: `Sign in to access your ${branding.platformName} workspace` } }, signUp: { start: { title: 'Create your workspace', subtitle: 'Bring payments operations into one clear view' } } }} routerPush={(to) => setLocation(stripBase(to))} routerReplace={(to) => setLocation(stripBase(to), { replace: true })}><TooltipProvider><ClerkQueryClientCacheInvalidator /><Switch><Route path="/" component={DashboardRoot} /><Route path="/transactions"><Protected><AppShell><Gate need="admin"><Transactions /></Gate></AppShell></Protected></Route><Route path="/payment-links"><Protected><AppShell><Gate need="admin"><PaymentLinks /></Gate></AppShell></Protected></Route><Route path="/payouts"><Protected><AppShell><Gate need="admin"><Payouts /></Gate></AppShell></Protected></Route><Route path="/settlements"><Protected><AppShell><Gate need="admin"><Settlements /></Gate></AppShell></Protected></Route><Route path="/customers"><Protected><AppShell><Gate need="admin"><Customers /></Gate></AppShell></Protected></Route><Route path="/webhooks"><Protected><AppShell><Gate need="admin"><Webhooks /></Gate></AppShell></Protected></Route><Route path="/settings"><Protected><AppShell><Gate need="admin"><Settings /></Gate></AppShell></Protected></Route>{extraRoutes}<Route path="/contact" component={ContactPage} /><Route path="/platform-status" component={PlatformStatusPage} /><Route path="/receipt/:reference" component={PublicReceiptPage} /><Route path="/team/accept" component={AcceptTeamInvitePage} /><Route path="/pay/:slug" component={PublicCheckout} /><Route path="/status/:reference" component={StatusPage} /><Route path="/sign-in/*?" component={SignInPage} /><Route path="/sign-up/*?" component={SignUpPage} /><Route component={NotFound} /></Switch><Toaster /></TooltipProvider></ClerkProvider>;
}

function PageMetadata() {
  const [location] = useLocation();
  const { platformName } = usePlatformBranding();
  useEffect(() => {
    const publicContent = /^\/(?:learn|guides|articles)(?:\/|$)/.test(location);
    if (publicContent) return;
    const indexable = location === '/' || location === '/contact';
    let robots = document.querySelector<HTMLMetaElement>('meta[name="robots"]');
    if (!robots) { robots = document.createElement('meta'); robots.name = 'robots'; document.head.appendChild(robots); }
    robots.content = indexable ? 'index, follow' : 'noindex, nofollow';
    const title = pageInfo[location]?.title
      || (location.startsWith('/invoices/') ? 'Invoice details' : location.startsWith('/receipt/') ? 'Payment receipt'
      : location.startsWith('/pay/') ? 'Secure checkout' : location.startsWith('/status/') ? 'Payment status'
      : location.startsWith('/sign-in') ? 'Sign in' : location.startsWith('/sign-up') ? 'Create your account'
      : location === '/team/accept' ? 'Accept team invitation' : 'Workspace');
    document.title = location === '/' ? `${platformName} | Payments for African businesses` : `${title} · ${platformName}`;
    const descriptions: Record<string, string> = {
      '/': `${platformName} helps businesses collect payments, create payment links, and track transaction and settlement status.`,
      '/contact': `Contact ${platformName} for help with payment collection, merchant onboarding, and platform support.`,
    };
    const descriptionText = descriptions[location] || `${title} in ${platformName}.`;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description) description.content = descriptionText;
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (indexable) {
      const canonicalUrl = new URL(`${basePath}${location === '/' ? '/' : location}`, window.location.origin).toString();
      const canonicalLink = canonical ?? document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'canonical' }));
      canonicalLink.href = canonicalUrl;
      const ogUrl = document.querySelector<HTMLMetaElement>('meta[property="og:url"]');
      if (ogUrl) ogUrl.content = canonicalUrl;
      const ogTitle = document.querySelector<HTMLMetaElement>('meta[property="og:title"]');
      if (ogTitle) ogTitle.content = document.title;
      const ogDescription = document.querySelector<HTMLMetaElement>('meta[property="og:description"]');
      if (ogDescription) ogDescription.content = descriptionText;
      const twitterTitle = document.querySelector<HTMLMetaElement>('meta[name="twitter:title"]');
      if (twitterTitle) twitterTitle.content = document.title;
      const twitterDescription = document.querySelector<HTMLMetaElement>('meta[name="twitter:description"]');
      if (twitterDescription) twitterDescription.content = descriptionText;
    } else {
      canonical?.remove();
    }
  }, [location, platformName]);
  return null;
}

function AppRoutes() {
  const [location] = useLocation();
  // Payers do not need dashboard authentication to pay or check confirmation.
  // Keep the auth SDK's lifecycle outside these publicly shared pages.
  const isPayerPage = /^\/(?:pay|status|receipt)\//.test(location);
  return clerkPubKey && !isPayerPage ? <ClerkProviderWithRoutes /> : <PublicOnlyApp />;
}

function App() {
  return <QueryClientProvider client={queryClient}><PlatformBrandingProvider><WouterRouter base={basePath}><PageMetadata /><AppRoutes /></WouterRouter></PlatformBrandingProvider></QueryClientProvider>;
}

export default App;