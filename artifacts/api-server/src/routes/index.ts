import { Router, type IRouter } from "express";
import healthRouter from "./health";
import publicPaymentsRouter from "./public-payments";
import adminPaymentsRouter from "./admin-payments";
import adminOperationsRouter from "./admin-operations";
import { requireAdmin } from "../middlewares/requireAdmin";
import merchantPlatformRouter from "./merchant-platform";
import adminPlatformRouter from "./admin-platform";
import supportRouter from "./support";
import platformStatusRouter from "./platform-status";
import publicBrandingRouter from "./public-branding";
import merchantTeamRouter from "./merchant-team";
import merchantBusinessToolsRouter from "./merchant-business-tools";
import { merchantWalletRouter, adminWalletRouter } from "./wallets";
import adminEmailDeliveryRouter from "./admin-email-delivery";
import { contentApiRouter } from "./public-content";

const router: IRouter = Router();

router.use(healthRouter);
router.use(publicPaymentsRouter);
router.use(publicBrandingRouter);
router.use(contentApiRouter);
router.use(platformStatusRouter);
router.use(supportRouter);
router.use(merchantTeamRouter);
router.use(merchantBusinessToolsRouter);
router.use(merchantWalletRouter);
router.use(merchantPlatformRouter);
router.use(requireAdmin);
router.use(adminEmailDeliveryRouter);
router.use(adminWalletRouter);
router.use(adminPaymentsRouter);
router.use(adminOperationsRouter);
router.use(adminPlatformRouter);

export default router;
