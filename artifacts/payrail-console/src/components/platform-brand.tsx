import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useGetPublicPlatformBranding } from '@workspace/api-client-react';

export interface PlatformBranding {
  platformName: string;
  baseCurrency: string;
  contactEmail: string;
  contactPhone: string;
  contactAddress: string;
  contactWhatsapp: string;
  logoUrl: string | null;
  faviconUrl: string | null;
}

const defaultBranding: PlatformBranding = {
  platformName: 'Greenpay',
  baseCurrency: 'USD',
  contactEmail: 'support@greenpay.africa',
  contactPhone: '',
  contactAddress: '',
  contactWhatsapp: '',
  logoUrl: null,
  faviconUrl: null,
};

const PlatformBrandingContext = createContext<PlatformBranding>(defaultBranding);

export function PlatformBrandingProvider({ children }: { children: ReactNode }) {
  const brandingQuery = useGetPublicPlatformBranding();
  const branding: PlatformBranding = brandingQuery.data
    ? { ...brandingQuery.data, logoUrl: brandingQuery.data.logoUrl ?? null, faviconUrl: brandingQuery.data.faviconUrl ?? null }
    : defaultBranding;

  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) return;
    if (branding.faviconUrl) icon.href = branding.faviconUrl;
    else icon.href = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/favicon.svg`;
  }, [branding.faviconUrl]);

  return <PlatformBrandingContext.Provider value={branding}>{children}</PlatformBrandingContext.Provider>;
}

export function usePlatformBranding() {
  return useContext(PlatformBrandingContext);
}

export function PlatformBrand({ compact = false, variant = 'console' }: { compact?: boolean; variant?: 'console' | 'home' }) {
  const branding = usePlatformBranding();
  return (
    <span className={variant === 'home' ? 'hp-brand' : 'brand'} data-testid="brand-platform">
      {branding.logoUrl
        ? <img src={branding.logoUrl} alt="" className={variant === 'home' ? 'hp-logo' : 'brand-logo'} style={{ height: 24, maxWidth: compact ? 32 : 160, objectFit: 'contain' }} data-testid="img-platform-logo" />
        : variant === 'home'
          ? <span className="hp-mark" aria-hidden="true"><i /><i /><i /></span>
          : <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>}
      {!compact && <span className={variant === 'home' ? 'hp-word' : 'brand-name'} data-testid="text-platform-name">{branding.platformName}</span>}
    </span>
  );
}