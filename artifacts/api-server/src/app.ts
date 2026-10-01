import express, { type Express } from "express";
import cors from "cors";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import webhookReceiverRouter from "./routes/webhook-receiver";
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

const app: Express = express();

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

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.use("/api", activityAuditMiddleware);
app.use("/api", requireSameOriginForCookieMutations);
app.use("/api", router);

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
