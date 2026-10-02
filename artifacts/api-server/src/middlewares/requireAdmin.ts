import { getAuth } from "@clerk/express";
import type { RequestHandler } from "express";
import { fetchClerkUser, resolvePlatformAdmin, verifiedPrimaryEmail } from "../lib/platform-admin";

export async function verifiedClerkEmail(userId: string): Promise<string | null> {
  try {
    return verifiedPrimaryEmail(await fetchClerkUser(userId));
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
  try {
    const resolved = await resolvePlatformAdmin(auth.userId);
    if (resolved.isAdmin) {
      res.locals.clerkUserId = auth.userId;
      next();
      return;
    }
    req.log.warn({ userId: auth.userId }, "Blocked user without Greenpay platform-admin access");
    res.status(403).json({ error: "This account is not authorized for Greenpay operations." });
  } catch (error) {
    req.log.error({ err: error, userId: auth.userId }, "Could not resolve Greenpay platform-admin access");
    res.status(503).json({ error: "Greenpay admin access could not be verified. Try again shortly." });
  }
};