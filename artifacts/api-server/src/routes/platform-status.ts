import { Router, type IRouter } from "express";
import { db, platformSettingsTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/platform-status", async (_req, res): Promise<void> => {
  const checkedAt = new Date();
  try {
    const [settings] = await db.select({
      paymentsEnabled: platformSettingsTable.paymentsEnabled,
      platformName: platformSettingsTable.platformName,
    }).from(platformSettingsTable).limit(1);
    const paymentsState = settings?.paymentsEnabled === false ? "degraded" : "operational";
    const platformName = settings?.platformName ?? "Greenpay";
    const services = [
      { name: `${platformName} API`, status: "operational", description: "Public API requests are being served." },
      { name: "Platform data", status: "operational", description: "Platform data services are responding." },
      {
        name: "Payment platform",
        status: paymentsState,
        description: paymentsState === "operational"
          ? "Payment platform availability is enabled."
          : "Payment platform activity is temporarily paused.",
      },
    ];
    res.json({
      status: paymentsState === "operational" ? "operational" : "degraded",
      checkedAt,
      services,
    });
  } catch {
    res.json({
      status: "degraded",
      checkedAt,
      services: [
        { name: "Greenpay API", status: "operational", description: "Public API requests are being served." },
        { name: "Platform data", status: "unavailable", description: "Platform data services are temporarily unavailable." },
        { name: "Payment platform", status: "degraded", description: "Payment availability cannot currently be confirmed." },
      ],
    });
  }
});

export default router;