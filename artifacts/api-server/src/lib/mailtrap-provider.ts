export const MAILTRAP_SEND_URL = "https://send.api.mailtrap.io/api/send";

export type MailtrapMessage = {
  fromEmail: string;
  fromName: string;
  toEmail: string;
  subject: string;
  text: string;
  html: string;
  category: string;
};

export type MailtrapSubmission =
  | { kind: "accepted"; messageId: string | null }
  | { kind: "rejected"; retryable: boolean; retryAfterMs?: number; message: string }
  | { kind: "uncertain"; message: string };

export class MailtrapConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailtrapConfigurationError";
  }
}

export function mailtrapToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = env.MAILTRAP_API_TOKEN?.trim() || env.MAILTRAP_API_KEY?.trim();
  return token || null;
}

export function hasMailtrapToken(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(mailtrapToken(env));
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60 * 60 * 1000);
  const when = Date.parse(value);
  if (Number.isNaN(when)) return undefined;
  return Math.min(Math.max(0, when - Date.now()), 60 * 60 * 1000);
}

function safeResponseMessage(status: number): string {
  if (status === 401 || status === 403) return "Mailtrap rejected the server credentials.";
  if (status === 429) return "Mailtrap rate-limited the request.";
  if (status >= 500) return "Mailtrap returned a server error; provider acceptance could not be ruled out.";
  return `Mailtrap rejected the message with HTTP ${status}.`;
}

/**
 * Sends through Mailtrap's official transactional Email Sending API:
 * POST https://send.api.mailtrap.io/api/send with Bearer authorization.
 * See https://docs.mailtrap.io/developers/email-sending/transactional and
 * https://github.com/mailtrap/mailtrap-openapi/blob/main/specs/email-sending-transactional.openapi.yml.
 *
 * Mailtrap's public sending contract does not document an idempotency key. Any
 * transport failure or server-side error is therefore uncertain and must not
 * be submitted again automatically.
 */
export async function submitMailtrapEmail(
  message: MailtrapMessage,
  options: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<MailtrapSubmission> {
  const env = options.env ?? process.env;
  const token = mailtrapToken(env);
  if (!token) {
    throw new MailtrapConfigurationError(
      "Mailtrap email delivery is not configured. Set MAILTRAP_API_TOKEN (or MAILTRAP_API_KEY) on the API server.",
    );
  }
  if (!message.fromEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.fromEmail)) {
    throw new MailtrapConfigurationError(
      "A verified sender email is required. Configure and verify FROM_EMAIL in Mailtrap, then confirm it in admin email-delivery settings.",
    );
  }

  const requestBody = {
    from: { email: message.fromEmail, name: message.fromName },
    to: [{ email: message.toEmail }],
    subject: message.subject,
    text: message.text,
    html: message.html,
    category: message.category,
  };
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(MAILTRAP_SEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return {
      kind: "uncertain",
      message: "The Mailtrap request ended without a response. Provider acceptance is unknown; automatic retry is held.",
    };
  }

  if (response.status >= 500) {
    return { kind: "uncertain", message: safeResponseMessage(response.status) };
  }
  if (!response.ok) {
    return {
      kind: "rejected",
      retryable: response.status === 429,
      ...(response.status === 429
        ? { retryAfterMs: retryAfterMilliseconds(response.headers.get("retry-after")) }
        : {}),
      message: safeResponseMessage(response.status),
    };
  }

  let payload: { success?: unknown; message_ids?: unknown } | null = null;
  try {
    payload = await response.json() as { success?: unknown; message_ids?: unknown };
  } catch {
    return {
      kind: "uncertain",
      message: "Mailtrap returned success without a readable acceptance receipt; delivery is held for review.",
    };
  }
  if (payload?.success !== true) {
    return {
      kind: "uncertain",
      message: "Mailtrap returned no explicit acceptance confirmation; delivery is held for review.",
    };
  }
  const ids = Array.isArray(payload.message_ids) ? payload.message_ids : [];
  const messageId = ids.length && typeof ids[0] === "string" ? ids[0].slice(0, 200) : null;
  return { kind: "accepted", messageId };
}