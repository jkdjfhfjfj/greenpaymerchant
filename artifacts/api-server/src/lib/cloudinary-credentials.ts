import type { CloudinaryEnvironment } from "./cloudinary-upload";

export type ProviderCredentialReader = (
  provider: string,
  key: string,
) => Promise<string | null>;

export async function resolveCloudinaryEnvironment(
  readCredential: ProviderCredentialReader,
): Promise<CloudinaryEnvironment> {
  const [cloudName, apiKey, apiSecret] = await Promise.all([
    readCredential("cloudinary", "CLOUDINARY_CLOUD_NAME"),
    readCredential("cloudinary", "CLOUDINARY_API_KEY"),
    readCredential("cloudinary", "CLOUDINARY_API_SECRET"),
  ]);

  return {
    CLOUDINARY_CLOUD_NAME: cloudName ?? undefined,
    CLOUDINARY_API_KEY: apiKey ?? undefined,
    CLOUDINARY_API_SECRET: apiSecret ?? undefined,
  };
}