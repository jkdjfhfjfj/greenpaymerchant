import app from "./app";
import { logger } from "./lib/logger";
import { startTransactionalEmailWorker, stopTransactionalEmailWorker } from "./lib/transactional-email-worker";
import { startAirtimeReconciliationWorker, stopAirtimeReconciliationWorker } from "./lib/airtime-reconciliation-worker";
import {
  startMerchantWebhookOutboxWorker,
  stopMerchantWebhookOutboxWorker,
} from "./lib/outbound-webhooks";

const rawPort =
  process.env["PORT"] ??
  (process.env["NODE_ENV"] === "production" ? "10000" : undefined);

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required outside production.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, "0.0.0.0", (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startMerchantWebhookOutboxWorker();
  startTransactionalEmailWorker();
  startAirtimeReconciliationWorker();
});

server.once("close", stopMerchantWebhookOutboxWorker);
server.once("close", stopTransactionalEmailWorker);
server.once("close", stopAirtimeReconciliationWorker);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopMerchantWebhookOutboxWorker();
  stopTransactionalEmailWorker();
  stopAirtimeReconciliationWorker();
  server.close((error) => {
    if (error) {
      logger.error({ errorKind: error.name }, "HTTP server failed during graceful shutdown");
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
