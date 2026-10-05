import { logger } from "./logger";
import { reconcilePendingAirtimeTopups } from "./airtime-service";

let timer: NodeJS.Timeout | undefined;
let running = false;

async function runReconciliation(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await reconcilePendingAirtimeTopups();
  } catch (error) {
    logger.error({ err: error }, "Airtime top-up reconciliation pass failed");
  } finally {
    running = false;
  }
}

export function startAirtimeReconciliationWorker(): void {
  if (timer) return;
  void runReconciliation();
  timer = setInterval(() => { void runReconciliation(); }, 30_000);
  timer.unref();
}

export function stopAirtimeReconciliationWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
