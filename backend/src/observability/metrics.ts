const DURATION_BUCKETS_MS = [50, 100, 250, 500, 1_000, 2_500, 5_000] as const;
type DependencyName = "database" | "redis";
type Availability = "unknown" | "up" | "down";

export interface MetricsSnapshot {
  uptimeSeconds: number;
  requests: {
    total: number;
    errors: number;
    byStatus: Record<string, number>;
  };
  durationMs: {
    count: number;
    sum: number;
    max: number;
    buckets: Record<string, number>;
  };
  dependencies: Record<DependencyName, { status: Availability; checkedAt: string | null }>;
}

export function createMetricsRecorder(startedAt = Date.now()) {
  let requestCount = 0;
  let errorCount = 0;
  let durationCount = 0;
  let durationSum = 0;
  let durationMax = 0;
  const statusCounts = new Map<number, number>();
  const durationBuckets = new Map<number | "+Inf", number>();
  const dependencies: Record<DependencyName, { status: Availability; checkedAt: string | null }> = {
    database: { status: "unknown", checkedAt: null },
    redis: { status: "unknown", checkedAt: null },
  };

  for (const bucket of DURATION_BUCKETS_MS) durationBuckets.set(bucket, 0);
  durationBuckets.set("+Inf", 0);

  return {
    recordRequest(statusCode: number, durationMs: number) {
      requestCount += 1;
      if (statusCode >= 400) errorCount += 1;
      statusCounts.set(statusCode, (statusCounts.get(statusCode) ?? 0) + 1);

      const duration = Math.max(0, durationMs);
      durationCount += 1;
      durationSum += duration;
      durationMax = Math.max(durationMax, duration);
      const bucket = DURATION_BUCKETS_MS.find((limit) => duration <= limit) ?? "+Inf";
      durationBuckets.set(bucket, (durationBuckets.get(bucket) ?? 0) + 1);
    },

    setDependencyAvailability(name: DependencyName, available: boolean) {
      dependencies[name] = {
        status: available ? "up" : "down",
        checkedAt: new Date().toISOString(),
      };
    },

    snapshot(): MetricsSnapshot {
      return {
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        requests: {
          total: requestCount,
          errors: errorCount,
          byStatus: Object.fromEntries(
            [...statusCounts.entries()].sort(([left], [right]) => left - right)
              .map(([status, count]) => [String(status), count]),
          ),
        },
        durationMs: {
          count: durationCount,
          sum: durationSum,
          max: durationMax,
          buckets: Object.fromEntries(durationBuckets),
        },
        dependencies: {
          database: { ...dependencies.database },
          redis: { ...dependencies.redis },
        },
      };
    },
  };
}

export const metrics = createMetricsRecorder();
