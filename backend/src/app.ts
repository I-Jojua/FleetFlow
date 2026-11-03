import express from "express";
import cors from "cors";
import helmet from "helmet";

import healthRoutes from "./modules/health/health.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import deliveryRoutes from "./modules/deliveries/delivery.routes.js";
import driverRoutes from "./modules/drivers/driver.routes.js";
import customerRoutes from "./modules/customers/customer.routes.js";
import notificationRoutes from "./modules/notifications/notification.routes.js";
import auditRoutes from "./modules/audit/audit.routes.js";
import docsRoutes from "./modules/docs/docs.routes.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";
import { env } from "./config/env.js";
import { requestLogger } from "./middleware/request-logger.middleware.js";

const app = express();

app.set("trust proxy", env.TRUST_PROXY_HOPS);

app.use(requestLogger);

app.use(helmet());

app.use(cors({
  origin(origin, callback) {
    if (!origin || env.CORS_ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: true,
}));

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => {
res.json({
success: true,
message: "Welcome to FleetFlow API",
version: "1.0.0",
});
});

app.use("/api/v1/health", healthRoutes);
app.use("/api/v1/docs", docsRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/deliveries", deliveryRoutes);
app.use("/api/v1/drivers", driverRoutes);
app.use("/api/v1/customers", customerRoutes);
app.use("/api/v1/notifications", notificationRoutes);
app.use("/api/v1/audit-logs", auditRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
