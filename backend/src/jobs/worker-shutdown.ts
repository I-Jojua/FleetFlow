import type { Worker } from "bullmq";
import { logger } from "../utils/logger.js";

type ClosableWorker = Pick<Worker, "close">;

export function createWorkerShutdown(
  worker: ClosableWorker | ClosableWorker[],
  timeoutMs: number,
  dependencies: {
    log?: typeof logger;
    onExit?: (code: number) => void;
  } = {},
) {
  const log = dependencies.log ?? logger;
  const onExit = dependencies.onExit ?? ((code) => { process.exitCode = code; });
  let shutdownPromise: Promise<void> | undefined;

  return (signal: "SIGTERM" | "SIGINT"): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      log.info("job_worker_shutdown_started", { signal });
      const workers = Array.isArray(worker) ? worker : [worker];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const closed = await Promise.race([
        Promise.all(workers.map((item) => item.close())).then(() => true, () => false),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);

      const exitCode = closed ? 0 : 1;
      if (!closed) {
        log.error("job_worker_shutdown_failed", {
          signal,
          reason: "timeout_or_close_error",
        });
      } else {
        log.info("job_worker_shutdown_completed", { signal });
      }
      onExit(exitCode);
    })();

    return shutdownPromise;
  };
}
