import { providerCredential } from "./credential-runtime";
import type { CloudinaryEnvironment } from "./cloudinary-upload";

export async function resolveCloudinaryEnvironment(): Promise<CloudinaryEnvironment> {
  const [cloudName, apiKey, apiSecret] = await Promise.all([
    providerCredential("cloudinary", "CLOUDINARY_CLOUD_NAME"),
    providerCredential("cloudinary", "CLOUDINARY_API_KEY"),
    providerCredential("cloudinary", "CLOUDINARY_API_SECRET"),
  ]);

  return {
    CLOUDINARY_CLOUD_NAME: cloudName ?? undefined,
    CLOUDINARY_API_KEY: apiKey ?? undefined,
    CLOUDINARY_API_SECRET: apiSecret ?? undefined,
  };
}