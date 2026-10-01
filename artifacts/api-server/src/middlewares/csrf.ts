import type { RequestHandler } from "express";
import { getPublicAppUrl } from "../lib/greenpay-provider";
import { mutationRequiresSameOrigin, originIsAllowed } from "../lib/origin-policy";

export function trustedBrowserOrigins(): string[] {
  const configured = (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",").map((origin) => origin.trim()).filter(Boolean);
  try { configured.push(getPublicAppUrl()); } catch {}
  return [...new Set(configured)];
}

export const requireSameOriginForCookieMutations: RequestHandler = (req, res, next) => {
  if (!mutationRequiresSameOrigin(req.method, req.path)) {
    next();
    return;
  }
  const origin = req.get("origin");
  if (!origin) {
    res.status(403).json({ error: "A same-origin Origin header is required for this request." });
    return;
  }
  try {
    if (!originIsAllowed(origin, trustedBrowserOrigins())) {
      res.status(403).json({ error: "Cross-origin state-changing requests are not allowed." });
      return;
    }
  } catch {
    res.status(403).json({ error: "The request origin could not be verified." });
    return;
  }
  next();
};