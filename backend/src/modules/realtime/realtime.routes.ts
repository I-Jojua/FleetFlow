import { Router } from "express";
import { authenticate } from "../auth/auth.middleware.js";
import { realtimeTicketRateLimiter } from "../../middleware/rate-limit.middleware.js";
import { createRealtimeTicket } from "./realtime.controller.js";

const router = Router();

router.post("/ticket", authenticate, realtimeTicketRateLimiter, createRealtimeTicket);

export default router;
