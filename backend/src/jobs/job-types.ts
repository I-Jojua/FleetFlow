export const QUEUE_NAMES = {
  demo: "fleetflow-demo",
  email: "fleetflow-email",
} as const;

export const JOB_NAMES = {
  demo: "process-demo",
  email: "send-auth-email",
} as const;

export interface DemoJobPayload {
  demoId: string;
  requestId?: string;
}

export interface DemoJobResult {
  demoId: string;
  processedAt: string;
}
