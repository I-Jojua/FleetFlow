import type { Server } from "node:http";
import { logger } from "../utils/logger.js";

export interface GracefulShutdownDependencies {
  server: Pick<Server, "close" | "closeAllConnections">;
  timeoutMs: number;
  closeDatabase: () => Promise<unknown>;
  closeRedis: () => Promise<unknown>;
  onExit?: (code: number) => void;
  log?: typeof logger;
}

export function createGracefulShutdown({
  server,
  timeoutMs,
  closeDatabase,
  closeRedis,
  onExit = () => undefined,
  log = logger,
}: GracefulShutdownDependencies) {
  let shutdownPromise: Promise<void> | undefined;

  return (signal: "SIGTERM" | "SIGINT"): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      log.info("shutdown_started", { signal });
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const serverClosed = await new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          server.closeAllConnections();
          resolve(false);
        }, timeoutMs);

        try {
          server.close((error?: Error) => {
            if (timer) clearTimeout(timer);
            resolve(!error);
          });
        } catch {
          if (timer) clearTimeout(timer);
          resolve(false);
        }
      });

      if (timer) clearTimeout(timer);
      const dependencies = await Promise.allSettled([
        closeDatabase(),
        closeRedis(),
      ]);
      const dependenciesClosed = dependencies.every((result) => result.status === "fulfilled");
      const exitCode = serverClosed && dependenciesClosed && !timedOut ? 0 : 1;

      if (!dependenciesClosed) {
        log.warn("shutdown_dependency_close_failed", {
          database: dependencies[0].status,
          redis: dependencies[1].status,
        });
      }
      log.info("shutdown_completed", { signal, timedOut, exitCode });
      onExit(exitCode);
    })();

    return shutdownPromise;
  };
}
