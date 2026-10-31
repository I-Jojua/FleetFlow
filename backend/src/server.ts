
import app from "./app.js";
import { env } from "./config/env.js";

const server = app.listen(env.PORT, () => {
  console.log(`
  =====================================
       FLEETFLOW API SERVER
  =====================================
       Environment: ${env.NODE_ENV}
       Port: ${env.PORT}
       URL: http://localhost:${env.PORT}
  =====================================
  `);
});

const shutdown = (signal: string) => {
  console.log(`${signal} received. Shutting down...`);

  server.close(() => {
    console.log("FleetFlow server stopped.");
    process.exit(0);
  });
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
