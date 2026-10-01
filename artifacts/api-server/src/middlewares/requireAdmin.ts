import { getAuth } from "@clerk/express";
import type { RequestHandler } from "express";

export async function verifiedClerkEmail(userId: string): Promise<string | null> {
  const secret = process.env.CLERK_SECRET_KEY?.trim();
  if (!secret) return null;
  try {
    const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const user = await response.json() as {
      primary_email_address_id?: string;
      email_addresses?: Array<{ id?: string; email_address?: string; verification?: { status?: string } }>;
    };
    const primary = user.email_addresses?.find((item) => item.id === user.primary_email_address_id);
    if (primary?.verification?.status !== "verified" || !primary.email_address) return null;
    return primary.email_address.toLowerCase().trim();
  } catch {
    return null;
  }
}

export const requireSignedIn: RequestHandler = (req, res, next) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Sign in to access this resource." });
    return;
  }
  res.locals.clerkUserId = auth.userId;
  next();
};

export const requireAdmin: RequestHandler = async (req, res, next) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Sign in to access Greenpay operations." });
    return;
  }
  const allowedEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (allowedEmails.length === 0) {
    req.log.warn({ userId: auth.userId }, "Admin email allowlist is not configured");
    res.status(503).json({ error: "Greenpay admin access is not configured. Set ADMIN_EMAILS on the API server." });
    return;
  }
  const email = await verifiedClerkEmail(auth.userId);
  if (!email || !allowedEmails.includes(email)) {
    req.log.warn({ userId: auth.userId }, "Blocked user outside Greenpay admin allowlist");
    res.status(403).json({ error: "This account is not authorized for Greenpay operations." });
    return;
  }
  next();
};