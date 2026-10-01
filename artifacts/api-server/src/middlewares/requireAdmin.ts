import { getAuth } from "@clerk/express";
import type { RequestHandler } from "express";

export const requireAdmin: RequestHandler = (req, res, next) => {
  const auth = getAuth(req);
  if (!auth.userId) {
    res.status(401).json({ error: "Sign in to access Greenpay operations." });
    return;
  }

  const claims = auth.sessionClaims as Record<string, unknown> | undefined;
  const email = typeof claims?.email === "string" ? claims.email.toLowerCase().trim() : "";
  const verified = claims?.email_verified === true || claims?.email_verified === "true";
  const allowedEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (allowedEmails.length === 0) {
    req.log.warn({ userId: auth.userId }, "Admin email allowlist is not configured");
    res.status(503).json({ error: "Greenpay admin access is not configured. Set ADMIN_EMAILS on the API server." });
    return;
  }
  if (!email || !verified || !allowedEmails.includes(email)) {
    req.log.warn({ userId: auth.userId }, "Blocked user outside Greenpay admin allowlist");
    res.status(403).json({ error: "This account is not authorized for Greenpay operations." });
    return;
  }
  next();
};