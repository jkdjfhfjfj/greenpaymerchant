import app from "./app";
import { logger } from "./lib/logger";
import { startTransactionalEmailWorker, stopTransactionalEmailWorker } from "./lib/transactional-email-worker";
import {
  startMerchantWebhookOutboxWorker,
  stopMerchantWebhookOutboxWorker,
} from "./lib/outbound-webhooks";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startMerchantWebhookOutboxWorker();
  startTransactionalEmailWorker();
});

server.once("close", stopMerchantWebhookOutboxWorker);
server.once("close", stopTransactionalEmailWorker);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  stopMerchantWebhookOutboxWorker();
  stopTransactionalEmailWorker();
  server.close((error) => {
    if (error) {
      logger.error({ errorKind: error.name }, "HTTP server failed during graceful shutdown");
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
