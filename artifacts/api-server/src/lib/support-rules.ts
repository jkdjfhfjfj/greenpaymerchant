const categories = new Set(["payments", "account", "verification", "technical", "other"]);
const attemptsByIp = new Map<string, { count: number; resetAt: number }>();
const contactLimit = 5;
const contactWindowMs = 10 * 60 * 1000;

export function boundedText(value: unknown, min: number, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= min && normalized.length <= max ? normalized : null;
}

export function validEmail(value: unknown): string | null {
  const email = boundedText(value, 3, 254);
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.toLowerCase() : null;
}

export function categoryOf(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "other";
  return typeof value === "string" && categories.has(value) ? value : null;
}

export function redactSupportText(value: string): string {
  return value
    .replace(/\b(api[_ -]?key|secret[_ -]?key|password|authorization|access[_ -]?token|account[_ -]?number)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk_(?:live|test)_|pk_(?:live|test)_|whsec_)[A-Za-z0-9_-]+\b/gi, "[REDACTED KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]+\b/gi, "Bearer [REDACTED]");
}

export function allowContactSubmission(ip: string, now = Date.now()): boolean {
  const previous = attemptsByIp.get(ip);
  if (!previous || previous.resetAt <= now) {
    attemptsByIp.set(ip, { count: 1, resetAt: now + contactWindowMs });
    return true;
  }
  if (previous.count >= contactLimit) return false;
  previous.count += 1;
  if (attemptsByIp.size > 5000) {
    for (const [key, item] of attemptsByIp) if (item.resetAt <= now) attemptsByIp.delete(key);
  }
  return true;
}