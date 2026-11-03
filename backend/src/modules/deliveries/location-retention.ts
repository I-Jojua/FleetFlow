import { env } from "../../config/env.js";
import { prisma } from "../../config/prisma.js";
import { logger } from "../../utils/logger.js";

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface LocationRetentionDependencies {
  deleteBefore: (cutoff: Date) => Promise<number>;
  retentionDays: number;
  intervalMs?: number;
  now?: () => Date;
  log?: typeof logger;
}

export function createLocationRetentionWorker({
  deleteBefore,
  retentionDays,
  intervalMs = RETENTION_INTERVAL_MS,
  now = () => new Date(),
  log = logger,
}: LocationRetentionDependencies) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeRun: Promise<void> | undefined;

  const runOnce = async () => {
    if (activeRun) return activeRun;
    activeRun = (async () => {
      const cutoff = new Date(now().getTime() - retentionDays * 24 * 60 * 60 * 1_000);
      try {
        const deleted = await deleteBefore(cutoff);
        log.info("gps_location_retention_completed", { deleted });
      } catch (error) {
        log.warn("gps_location_retention_failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      }
    })().finally(() => { activeRun = undefined; });
    return activeRun;
  };

  return {
    runOnce,
    start() {
      if (timer) return;
      void runOnce();
      timer = setInterval(() => { void runOnce(); }, intervalMs);
      timer.unref?.();
    },
    async close() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await activeRun;
    },
  };
}

export const locationRetentionWorker = createLocationRetentionWorker({
  deleteBefore: async (cutoff) => {
    const result = await prisma.driverLocation.deleteMany({ where: { recordedAt: { lt: cutoff } } });
    return result.count;
  },
  retentionDays: env.GPS_LOCATION_RETENTION_DAYS,
});
