
import { Router, Request, Response } from "express";

const router = Router();

router.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "FleetFlow API is running!",
    data: {
      status: "healthy",
      service: "FleetFlow Backend",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    },
  });
});

export default router;
