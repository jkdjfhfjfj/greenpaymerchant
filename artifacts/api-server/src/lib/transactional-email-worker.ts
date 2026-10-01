import {
  dispatchQueuedTransactionalEmails,
  processFinancialNotificationEvents,
} from "./mailtrap-delivery";
import { logger } from "./logger";

let timer: ReturnType<typeof setInterval> | null = null;
let degraded = false;

async function runBatch(): Promise<void> {
  const [financial, email] = await Promise.allSettled([
    processFinancialNotificationEvents(25),
    dispatchQueuedTransactionalEmails(25),
  ]);
  degraded = financial.status === "rejected" || email.status === "rejected" ||
    (financial.status === "fulfilled" && financial.value.retried > 0);
  if (financial.status === "rejected") {
    logger.error({
      error: financial.reason instanceof Error ? financial.reason.message : "Unknown financial notification worker failure.",
    }, "Financial notification worker failed");
  } else if (financial.value.retried > 0) {
    logger.warn({ retried: financial.value.retried }, "Financial notification events were persisted for retry");
  }
  if (email.status === "rejected") {
    logger.error({
      error: email.reason instanceof Error ? email.reason.message : "Unknown Mailtrap worker failure.",
    }, "Mailtrap transactional email worker failed");
  }
}

/** Start one in-process dispatcher; leased claims keep multi-instance delivery safe. */
export function startTransactionalEmailWorker(): void {
  if (timer) return;
  timer = setInterval(() => { void runBatch(); }, 15_000);
  timer.unref?.();
  void runBatch();
}

/** Stop this process's timer; any in-flight leased provider submission completes normally. */
export function stopTransactionalEmailWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export function transactionalEmailWorkerStatus(): "running" | "stopped" | "degraded" {
  if (!timer) return "stopped";
  return degraded ? "degraded" : "running";
}