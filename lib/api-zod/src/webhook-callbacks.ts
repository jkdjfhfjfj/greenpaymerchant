export const PROVIDER_WEBHOOK_PATHS = {
  paystack: "/api/webhooks/paystack",
  payhero: "/api/webhooks/payhero",
  payzaapi: "/api/webhooks/payzaapi",
  didit: "/api/webhooks/didit",
  statum: "/api/webhooks/statum",
} as const;

export type ProviderWebhookProvider = keyof typeof PROVIDER_WEBHOOK_PATHS;
