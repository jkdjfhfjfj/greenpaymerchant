import { useState, type ChangeEvent } from 'react';
import { ImageUp, LoaderCircle } from 'lucide-react';
import { uploadBrandImage, type CloudinaryUploadSignature } from '@/lib/cloudinary-upload';

export function CloudinaryImageUpload({
  label,
  value,
  description,
  disabled = false,
  getSignature,
  onUploaded,
}: {
  label: string;
  value: string;
  description: string;
  disabled?: boolean;
  getSignature: () => Promise<CloudinaryUploadSignature>;
  onUploaded: (url: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setError('');
    setUploading(true);
    try {
      const credentials = await getSignature();
      const url = await uploadBrandImage(file, credentials);
      onUploaded(url);
      input.value = '';
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Image upload failed. Try again.');
    } finally {
      setUploading(false);
    }
  }

  return <div className="cloudinary-upload">
    <label className="field">
      <span>{label}</span>
      <input type="file" accept="image/png,image/jpeg,image/webp,image/x-icon,.ico" disabled={disabled || uploading} onChange={(event) => { void handleFile(event); }} />
      <small>{uploading ? 'Uploading image…' : description}</small>
    </label>
    {value && <img className="cloudinary-image-preview" src={value} alt={`${label} preview`} />}
    {uploading && <span className="cloudinary-upload-status" role="status"><LoaderCircle size={14} className="spin" /> Uploading to Cloudinary…</span>}
    {error && <span className="form-error" role="alert">{error}</span>}
    {!uploading && <span className="cloudinary-upload-hint"><ImageUp size={14} /> PNG, JPEG, WebP, or ICO · max 5 MB</span>}
  </div>;
}