import { sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", async (req, res): Promise<void> => {
  try {
    await db.execute(sql`select 1`);
    res.json(HealthCheckResponse.parse({ status: "ok", database: "ready" }));
  } catch (error) {
    req.log.warn({ err: error }, "Database health check failed");
    res.status(503).json(HealthCheckResponse.parse({ status: "unavailable", database: "unavailable" }));
  }
});

export default router;
