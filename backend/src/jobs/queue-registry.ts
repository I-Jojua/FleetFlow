import { Queue, type ConnectionOptions } from "bullmq";
import { env } from "../config/env.js";
import { getBullMqRedisConnectionOptions } from "../config/redis.js";
import { logger } from "../utils/logger.js";
import { buildDefaultJobOptions } from "./job-settings.js";
import { JOB_NAMES, QUEUE_NAMES, type DemoJobPayload, type DemoJobResult } from "./job-types.js";
import type { EmailJobPayload, EmailDeliveryResult } from "../modules/email/email.types.js";

export interface QueueRegistryOptions {
  prefix?: string;
  redisUrl?: string;
  settings?: typeof env;
  connection?: ConnectionOptions;
  log?: typeof logger;
}

export function createQueueRegistry(options: QueueRegistryOptions = {}) {
  const settings = options.settings ?? env;
  const log = options.log ?? logger;
  const demo = new Queue<DemoJobPayload, DemoJobResult, typeof JOB_NAMES.demo>(QUEUE_NAMES.demo, {
    connection: options.connection ?? getBullMqRedisConnectionOptions(options.redisUrl),
    prefix: options.prefix ?? "fleetflow",
    defaultJobOptions: buildDefaultJobOptions(settings),
  });
  const email = new Queue<EmailJobPayload, EmailDeliveryResult, typeof JOB_NAMES.email>(QUEUE_NAMES.email, {
    connection: options.connection ?? getBullMqRedisConnectionOptions(options.redisUrl),
    prefix: options.prefix ?? "fleetflow",
    defaultJobOptions: buildDefaultJobOptions(settings),
  });

  demo.on("error", (error) => {
    log.error("job_queue_error", {
      queue: QUEUE_NAMES.demo,
      errorType: error.name,
    });
  });
  email.on("error", (error) => {
    log.error("job_queue_error", {
      queue: QUEUE_NAMES.email,
      errorType: error.name,
    });
  });

  return {
    queues: { demo, email },
    async close() {
      await Promise.all([demo.close(), email.close()]);
    },
  };
}

export type QueueRegistry = ReturnType<typeof createQueueRegistry>;

let defaultRegistry: QueueRegistry | undefined;

/** One producer registry per API process; individual workers use their own BullMQ connections. */
export function getQueueRegistry(): QueueRegistry {
  defaultRegistry ??= createQueueRegistry();
  return defaultRegistry;
}

export async function closeQueueRegistry(): Promise<void> {
  const registry = defaultRegistry;
  defaultRegistry = undefined;
  await registry?.close();
}
