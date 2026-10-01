import { Router, type IRouter } from "express";
import healthRouter from "./health";
import publicPaymentsRouter from "./public-payments";
import adminPaymentsRouter from "./admin-payments";
import adminOperationsRouter from "./admin-operations";
import { requireAdmin } from "../middlewares/requireAdmin";
import merchantPlatformRouter from "./merchant-platform";
import adminPlatformRouter from "./admin-platform";

const router: IRouter = Router();

router.use(healthRouter);
router.use(publicPaymentsRouter);
router.use(merchantPlatformRouter);
router.use(requireAdmin);
router.use(adminPaymentsRouter);
router.use(adminOperationsRouter);
router.use(adminPlatformRouter);

export default router;
