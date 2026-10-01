import { Router, type IRouter } from "express";
import healthRouter from "./health";
import publicPaymentsRouter from "./public-payments";
import adminPaymentsRouter from "./admin-payments";
import adminOperationsRouter from "./admin-operations";
import { requireAdmin } from "../middlewares/requireAdmin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(publicPaymentsRouter);
router.use(requireAdmin);
router.use(adminPaymentsRouter);
router.use(adminOperationsRouter);

export default router;
