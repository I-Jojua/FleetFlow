import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "node:path";

import healthRoutes from "./modules/health/health.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import deliveryRoutes from "./modules/deliveries/delivery.routes.js";
import driverRoutes from "./modules/drivers/driver.routes.js";
import customerRoutes from "./modules/customers/customer.routes.js";
import notificationRoutes from "./modules/notifications/notification.routes.js";
import auditRoutes from "./modules/audit/audit.routes.js";
import docsRoutes from "./modules/docs/docs.routes.js";
import realtimeRoutes from "./modules/realtime/realtime.routes.js";
import dispatchRoutes from "./modules/dispatch/dispatch.routes.js";
import vehicleRoutes from "./modules/vehicles/vehicle.routes.js";
import driverWorkforceRoutes from "./modules/drivers/workforce.routes.js";
import { errorHandler, notFoundHandler } from "./middleware/error.middleware.js";
import { env } from "./config/env.js";
import { requestLogger } from "./middleware/request-logger.middleware.js";

const app = express();
const dashboardDirectory = path.resolve(__dirname, "../public/dashboard");

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

app.use("/api/v1/health", healthRoutes);
app.use("/api/v1/docs", docsRoutes);
app.use("/api/v1/realtime", realtimeRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/deliveries", deliveryRoutes);
app.use("/api/v1/dispatch", dispatchRoutes);
app.use("/api/v1/drivers", driverRoutes);
app.use("/api/v1/drivers", driverWorkforceRoutes);
app.use("/api/v1/vehicles", vehicleRoutes);
app.use("/api/v1/customers", customerRoutes);
app.use("/api/v1/notifications", notificationRoutes);
app.use("/api/v1/audit-logs", auditRoutes);

app.get("/", (_req, res, next) => {
  res.sendFile("index.html", { root: dashboardDirectory }, (error) => {
    if (error) next(error);
  });
});

app.use("/dashboard", express.static(dashboardDirectory, {
  fallthrough: true,
  maxAge: env.NODE_ENV === "production" ? "1h" : 0,
}));

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
