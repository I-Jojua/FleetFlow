import { closeQueueRegistry } from "./queue-registry.js";
import { submitDemoJob } from "./demo-job.service.js";
import { logger } from "../utils/logger.js";

async function main(): Promise<void> {
  const demoId = process.argv[2];
  try {
    if (!demoId) {
      throw new Error("A demo job ID argument is required.");
    }
    const submitted = await submitDemoJob({ demoId });
    logger.info("demo_job_cli_submitted", { jobId: submitted.jobId });
  } catch (error) {
    logger.error("demo_job_cli_failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    process.exitCode = 1;
  } finally {
    await closeQueueRegistry();
  }
}

void main().catch((error: unknown) => {
  logger.error("demo_job_cli_shutdown_failed", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
  process.exitCode = 1;
});
