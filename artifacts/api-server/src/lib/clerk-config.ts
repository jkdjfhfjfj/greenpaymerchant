export type ClerkProviderMode = "managed" | "external";

export function getClerkProviderMode(): ClerkProviderMode {
  const configured = process.env.CLERK_PROVIDER_MODE?.trim().toLowerCase() || "managed";
  if (configured === "managed" || configured === "external") return configured;
  throw new Error("CLERK_PROVIDER_MODE must be either managed or external.");
}

export function getActiveClerkSecretKey(): string | null {
  const mode = getClerkProviderMode();
  const value = mode === "external"
    ? process.env.EXTERNAL_CLERK_SECRET_KEY
    : process.env.CLERK_SECRET_KEY;
  return value?.trim() || null;
}

export function getActiveClerkPublishableKey(): string | null {
  const mode = getClerkProviderMode();
  const value = mode === "external"
    ? process.env.VITE_EXTERNAL_CLERK_PUBLISHABLE_KEY
    : process.env.CLERK_PUBLISHABLE_KEY;
  return value?.trim() || null;
}

export function getLegacyClerkSecretKey(): string | null {
  if (getClerkProviderMode() !== "external") return null;
  const value = process.env.LEGACY_CLERK_SECRET_KEY ?? process.env.CLERK_SECRET_KEY;
  return value?.trim() || null;
}