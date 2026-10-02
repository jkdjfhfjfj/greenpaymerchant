import { getAuth } from "@clerk/express";
import type { RequestHandler } from "express";
import { getClerkProviderMode } from "../lib/clerk-config";
import { linkLegacyClerkIdentityOnFirstSignIn } from "../lib/legacy-clerk-identity-linking";

export const legacyClerkIdentityLinkMiddleware: RequestHandler = (req, _res, next) => {
  if (getClerkProviderMode() !== "external") {
    next();
    return;
  }

  const externalUserId = getAuth(req).userId;
  if (!externalUserId) {
    next();
    return;
  }

  void linkLegacyClerkIdentityOnFirstSignIn(externalUserId)
    .then(({ resolution }) => {
      if (resolution === "ambiguous" || resolution === "conflict") {
        req.log.warn({ resolution }, "Legacy Clerk records were not linked");
      }
      next();
    })
    .catch((error: unknown) => {
      req.log.error(
        { errorKind: error instanceof Error ? error.name : "unknown" },
        "Legacy Clerk identity linking failed; the signed-in account remains unchanged",
      );
      next();
    });
};