import { eq } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { GetPublicPlatformBrandingResponse } from "@workspace/api-zod";
import { db, platformSettingsTable } from "@workspace/db";

const router: IRouter = Router();

router.get("/public/platform-branding", async (_req, res): Promise<void> => {
  const [settings] = await db.select().from(platformSettingsTable)
    .where(eq(platformSettingsTable.id, 1)).limit(1);
  const branding = settings
    ? {
      platformName: settings.platformName,
      baseCurrency: settings.baseCurrency,
      contactEmail: settings.contactEmail,
      contactPhone: settings.contactPhone,
      contactAddress: settings.contactAddress,
      contactWhatsapp: settings.contactWhatsapp,
      logoUrl: settings.logoUrl,
      faviconUrl: settings.faviconUrl,
    }
    : {
      platformName: "Greenpay",
      baseCurrency: "USD",
      contactEmail: "support@greenpay.africa",
      contactPhone: "",
      contactAddress: "",
      contactWhatsapp: "",
      logoUrl: null,
      faviconUrl: null,
    };
  res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
  res.json(GetPublicPlatformBrandingResponse.parse(branding));
});

export default router;