import { getAuth } from "@clerk/express";
import type { Request, RequestHandler, Response } from "express";
import { db, adminAuditLogTable } from "@workspace/db";

const ALWAYS_EXCLUDED_ROUTE_PARTS = [
  "/healthz",
  "/__clerk",
];
const POLLING_READ_ROUTE_PARTS = [
  "/admin/audit-log",
  "/dashboard",
  "/providers/status",
  "/wallets",
  "/admin/payout-requests",
  "/settlements",
  "/notifications",
  "/merchant/kyc",
  "/me",
  "/platform-status",
  "/public/transactions/",
] as const;

function containsRoutePart(route: string, part: string): boolean {
  const routeSegments = route.split("/").filter(Boolean);
  const partSegments = part.split("/").filter(Boolean);
  return partSegments.length > 0 && routeSegments.some((_, start) =>
    partSegments.every((segment, offset) => routeSegments[start + offset] === segment));
}

export function shouldAuditActivity(method: string, route: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "OPTIONS" || normalizedMethod === "HEAD") return false;
  if (ALWAYS_EXCLUDED_ROUTE_PARTS.some((part) => containsRoutePart(route, part))) return false;
  if (normalizedMethod === "GET" && POLLING_READ_ROUTE_PARTS.some((part) => containsRoutePart(route, part))) return false;
  return true;
}

export function safeRoutePattern(baseUrl: string, path: unknown): string | null {
  if (typeof path !== "string") return null;
  const route = `${baseUrl}${path}`.replace(/\/{2,}/g, "/");
  if (!route.startsWith("/") || route.includes("?") || route.length > 250) return null;
  return route;
}

export function activityAction(type: "user" | "api", method: string, route: string): string {
  const normalizedMethod = method.toUpperCase();
  const verb = normalizedMethod === "GET" ? "read"
    : normalizedMethod === "POST" ? "create"
      : normalizedMethod === "PATCH" || normalizedMethod === "PUT" ? "update"
        : normalizedMethod === "DELETE" ? "delete" : normalizedMethod.toLowerCase();
  const operation = route.replace(/\/:[^/]+/g, "/param").replace(/[^a-z0-9]+/gi, ".")
    .replace(/^\.+|\.+$/g, "").toLowerCase();
  return `${type}.${verb}.${operation}`.slice(0, 100);
}

function safeRoute(req: Request, mountedBaseUrl: string): string | null {
  const baseUrl = req.baseUrl.length >= mountedBaseUrl.length ? req.baseUrl : mountedBaseUrl;
  return safeRoutePattern(baseUrl, req.route?.path);
}

function actorFor(req: Request, res: Response): { actor: string; type: "user" | "api" } | null {
  const apiKey = res.locals.apiKey as { id?: number } | undefined;
  const merchant = res.locals.merchant as { id?: number } | undefined;
  if (apiKey?.id && merchant?.id) {
    return { actor: `api-key:${apiKey.id}/merchant:${merchant.id}`, type: "api" };
  }
  try {
    const userId = getAuth(req).userId;
    if (userId) return { actor: userId.slice(0, 128), type: "user" };
  } catch {
    return null;
  }
  return null;
}

export const activityAuditMiddleware: RequestHandler = (req, res, next) => {
  const mountedBaseUrl = req.baseUrl;
  res.once("finish", () => {
    const route = safeRoute(req, mountedBaseUrl);
    if (!route || !shouldAuditActivity(req.method, route)) return;
    const actor = actorFor(req, res);
    if (!actor) return;

    const method = req.method.toUpperCase().slice(0, 10);
    const action = activityAction(actor.type, method, route);
    const target = `route:${route}`.slice(0, 200);
    void db.insert(adminAuditLogTable).values({
      actor: actor.actor,
      action,
      target,
      method,
      route,
      statusCode: res.statusCode,
      details: `Request completed with HTTP ${res.statusCode}.`,
    }).catch((error: unknown) => {
      req.log.warn({ err: error, route, statusCode: res.statusCode }, "Unable to persist request activity audit");
    });
  });
  next();
};