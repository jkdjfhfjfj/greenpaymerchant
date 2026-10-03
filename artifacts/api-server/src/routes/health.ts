import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/healthz", (_req, res): void => {
  res.status(200).type("text/plain").send("OK");
});

export default router;
