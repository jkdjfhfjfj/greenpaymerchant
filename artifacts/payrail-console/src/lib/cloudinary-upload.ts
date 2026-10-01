export interface CloudinaryUploadSignature {
  cloudName: string;
  apiKey: string;
  timestamp: number;
  signature: string;
  folder: string;
}

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);
const ALLOWED_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'ico']);

export function validateBrandImage(file: File) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!ALLOWED_IMAGE_TYPES.has(file.type) && !ALLOWED_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error('Choose a PNG, JPEG, WebP, or ICO image.');
  }
  if (file.size <= 0 || file.size > MAX_IMAGE_SIZE) {
    throw new Error('Image files must be smaller than 5 MB.');
  }
}

export async function uploadBrandImage(file: File, signature: CloudinaryUploadSignature) {
  validateBrandImage(file);
  const body = new FormData();
  body.append('file', file);
  body.append('api_key', signature.apiKey);
  body.append('timestamp', String(signature.timestamp));
  body.append('folder', signature.folder);
  body.append('signature', signature.signature);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(signature.cloudName)}/image/upload`, {
    method: 'POST',
    body,
  });
  const result = await response.json().catch(() => null) as {
    secure_url?: unknown;
    error?: { message?: unknown };
  } | null;
  if (!response.ok) {
    const message = typeof result?.error?.message === 'string' ? result.error.message : 'Cloudinary rejected the image upload.';
    throw new Error(message);
  }
  if (typeof result?.secure_url !== 'string') {
    throw new Error('Cloudinary did not return a secure image URL.');
  }
  const secureUrl = new URL(result.secure_url);
  if (secureUrl.protocol !== 'https:') {
    throw new Error('Cloudinary returned an insecure image URL.');
  }
  return secureUrl.toString();
}