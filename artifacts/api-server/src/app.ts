import express, { type Express } from "express";
import cors from "cors";
import { clerkMiddleware } from "@clerk/express";
import cookieParser from "cookie-parser";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import webhookReceiverRouter from "./routes/webhook-receiver";
import healthRouter from "./routes/health";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import { ApiError } from "./lib/greenpay-provider";
import { requireSameOriginForCookieMutations, trustedBrowserOrigins } from "./middlewares/csrf";
import { originIsAllowed } from "./lib/origin-policy";
import { activityAuditMiddleware } from "./middlewares/activity-audit";
import { noindexApiResponses, publicSeoRouter } from "./routes/public-content";
import {
  getActiveClerkPublishableKey,
  getActiveClerkSecretKey,
  getClerkProviderMode,
} from "./lib/clerk-config";
import { legacyClerkIdentityLinkMiddleware } from "./middlewares/legacyClerkIdentityLink";

const app: Express = express();
const clerkProviderMode = getClerkProviderMode();
const activeClerkPublishableKey = getActiveClerkPublishableKey();
const activeClerkSecretKey = getActiveClerkSecretKey();
if (clerkProviderMode === "external" && (!activeClerkPublishableKey || !activeClerkSecretKey)) {
  throw new Error("External Clerk mode requires VITE_EXTERNAL_CLERK_PUBLISHABLE_KEY and EXTERNAL_CLERK_SECRET_KEY.");
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());
app.use("/api", noindexApiResponses);
app.use(publicSeoRouter);
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    callback(null, originIsAllowed(origin, trustedBrowserOrigins()));
  },
}));
app.use("/api/webhooks", express.raw({ type: "application/json", limit: "1mb" }), webhookReceiverRouter);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use("/api", healthRouter);

app.use(
  clerkMiddleware((req) => ({
    ...(activeClerkSecretKey ? { secretKey: activeClerkSecretKey } : {}),
    publishableKey: clerkProviderMode === "external"
      ? activeClerkPublishableKey!
      : publishableKeyFromHost(
        getClerkProxyHost(req) ?? "",
        process.env.CLERK_PUBLISHABLE_KEY,
      ),
  })),
);

app.use("/api", legacyClerkIdentityLinkMiddleware);
app.use("/api", activityAuditMiddleware);
app.use("/api", requireSameOriginForCookieMutations);
app.use("/api", router);

if (process.env.NODE_ENV === "production") {
  const consoleRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../payrail-console/dist/public",
  );
  app.use(express.static(consoleRoot));
  app.get(/.*/, (req, res, next) => {
    const isApiPath = req.path === "/api" || req.path.startsWith("/api/");
    const isClerkProxyPath = req.path === CLERK_PROXY_PATH || req.path.startsWith(`${CLERK_PROXY_PATH}/`);
    if (req.method !== "GET" || isApiPath || isClerkProxyPath || req.path.includes(".")) {
      next();
      return;
    }
    res.sendFile(path.join(consoleRoot, "index.html"), (error) => {
      if (error) next(error);
    });
  });
}

app.use((error: unknown, req: express.Request, res: express.Response, _next: express.NextFunction): void => {
  if (error instanceof ApiError) {
    req.log.warn({ statusCode: error.statusCode, err: error.message }, "Greenpay API request rejected");
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  req.log.error({ err: error }, "Unhandled Greenpay API error");
  res.status(500).json({ error: "An unexpected server error occurred." });
});

export default app;
