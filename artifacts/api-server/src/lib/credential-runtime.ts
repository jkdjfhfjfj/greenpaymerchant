import { readProviderCredentials } from "./secure-storage";

const ENV_ALIASES: Record<string, string[]> = {
  PAYSTACK_SECRET_KEY: ["PAYSTACK_SECRET_KEY"],
  PAYHERO_USERNAME: ["PAYHERO_USERNAME"],
  PAYHERO_PASSWORD: ["PAYHERO_PASSWORD"],
  PAYHERO_BASIC_AUTH: ["PAYHERO_BASIC_AUTH", "PAYHERO_AUTH_TOKEN"],
  PAYHERO_AUTH_TOKEN: ["PAYHERO_BASIC_AUTH", "PAYHERO_AUTH_TOKEN"],
  PAYHERO_CHANNEL_ID: ["PAYHERO_CHANNEL_ID"],
  PAYZAAPI_API_KEY: ["PAYZAAPI_API_KEY", "PAYZA_SECRET_KEY", "PAYZAAPI_SECRET_KEY"],
  PAYZA_PUBLIC_KEY: ["PAYZA_PUBLIC_KEY", "PAYZAAPI_PUBLIC_KEY"],
  PAYZA_SECRET_KEY: ["PAYZA_SECRET_KEY", "PAYZAAPI_API_KEY", "PAYZAAPI_SECRET_KEY"],
  PAYZA_WEBHOOK_SECRET: ["PAYZA_WEBHOOK_SECRET", "PAYZAAPI_WEBHOOK_SECRET"],
  DIDIT_API_KEY: ["DIDIT_API_KEY"],
  DIDIT_WORKFLOW_ID: ["DIDIT_WORKFLOW_ID"],
  DIDIT_KYB_WORKFLOW_ID: ["DIDIT_KYB_WORKFLOW_ID"],
  CURRENCYAPI_API_KEY: ["CURRENCYAPI_API_KEY"],
  GEOAPIFY_API_KEY: ["GEOAPIFY_API_KEY"],
  CLOUDINARY_CLOUD_NAME: ["CLOUDINARY_CLOUD_NAME"],
  CLOUDINARY_API_KEY: ["CLOUDINARY_API_KEY"],
  CLOUDINARY_API_SECRET: ["CLOUDINARY_API_SECRET"],
};

export async function providerCredential(provider: string, key: string): Promise<string | null> {
  const stored = await readProviderCredentials(provider);
  if (stored) {
    if (!stored.enabled) return null;
    const aliases = [key, ...(ENV_ALIASES[key] ?? [])];
    for (const alias of aliases) {
      const value = stored.credentials[alias]?.trim();
      if (value) return value;
    }
  }
  for (const alias of ENV_ALIASES[key] ?? [key]) {
    const value = process.env[alias]?.trim();
    if (value) return value;
  }
  return null;
}

export async function providerEnabled(provider: string): Promise<boolean> {
  const stored = await readProviderCredentials(provider);
  return stored ? stored.enabled : true;
}

export function providerCredentialFields(provider: string): string[] {
  switch (provider) {
    case "paystack": return ["PAYSTACK_SECRET_KEY"];
    case "payhero": return ["PAYHERO_USERNAME", "PAYHERO_PASSWORD", "PAYHERO_CHANNEL_ID"];
    case "payzaapi": return ["PAYZAAPI_API_KEY", "PAYZA_PUBLIC_KEY", "PAYZA_SECRET_KEY", "PAYZA_WEBHOOK_SECRET"];
    case "didit": return ["DIDIT_API_KEY", "DIDIT_WORKFLOW_ID", "DIDIT_KYB_WORKFLOW_ID"];
    case "currencyapi": return ["CURRENCYAPI_API_KEY"];
    case "geoapify": return ["GEOAPIFY_API_KEY"];
    case "cloudinary": return ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];
    default: return [];
  }
}