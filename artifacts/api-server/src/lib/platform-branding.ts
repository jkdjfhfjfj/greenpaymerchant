export function cleanPublicUrl(value: string | null | undefined, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a complete URL.`);
  }
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if ((url.protocol !== "https:" && !localHttp) || url.username || url.password) {
    throw new Error(`${label} must use HTTPS and cannot contain credentials.`);
  }
  if (url.search || url.hash) {
    throw new Error(`${label} must not contain query parameters or fragments.`);
  }
  return url.toString();
}

export function normalizeWhatsAppContact(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https:\/\/wa\.me\/\d{7,15}\/?$/i.test(trimmed)) {
    const url = new URL(trimmed);
    return `https://wa.me/${url.pathname.replaceAll("/", "")}`;
  }
  if (!/^\+?[1-9][0-9 ()-]{6,19}$/.test(trimmed)) {
    throw new Error("WhatsApp contact must be an international phone number or an https://wa.me link.");
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    throw new Error("WhatsApp phone contact must contain between 7 and 15 digits.");
  }
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}