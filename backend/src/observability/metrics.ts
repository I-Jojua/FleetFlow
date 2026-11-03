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
  realtime: {
    activeConnections: number;
    rejectedConnections: number;
    activeSubscriptions: number;
    pubSubConnections: number;
    publishedBroadcasts: number;
    failedBroadcasts: number;
    gpsIngestions: number;
    gpsProcessingMs: { count: number; sum: number; max: number };
    backpressureEvents: number;
  };
  dispatch: { recommendations: number; failures: number; durationMs: { count: number; sum: number; max: number } };
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
  const realtime = {
    activeConnections: 0,
    rejectedConnections: 0,
    activeSubscriptions: 0,
    pubSubConnections: 0,
    publishedBroadcasts: 0,
    failedBroadcasts: 0,
    gpsIngestions: 0,
    gpsProcessingMs: { count: 0, sum: 0, max: 0 },
    backpressureEvents: 0,
  };
  const dispatch = { recommendations: 0, failures: 0, durationMs: { count: 0, sum: 0, max: 0 } };

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

    changeActiveConnections(delta: number) {
      realtime.activeConnections = Math.max(0, realtime.activeConnections + delta);
    },
    recordRejectedConnection() { realtime.rejectedConnections += 1; },
    changeActiveSubscriptions(delta: number) {
      realtime.activeSubscriptions = Math.max(0, realtime.activeSubscriptions + delta);
    },
    changePubSubConnections(delta: number) {
      realtime.pubSubConnections = Math.max(0, realtime.pubSubConnections + delta);
    },
    recordPublishedBroadcast() { realtime.publishedBroadcasts += 1; },
    recordFailedBroadcast() { realtime.failedBroadcasts += 1; },
    recordBackpressureEvent() { realtime.backpressureEvents += 1; },
    recordGpsIngestion(durationMs: number) {
      const duration = Math.max(0, durationMs);
      realtime.gpsIngestions += 1;
      realtime.gpsProcessingMs.count += 1;
      realtime.gpsProcessingMs.sum += duration;
      realtime.gpsProcessingMs.max = Math.max(realtime.gpsProcessingMs.max, duration);
    },
    recordDispatchRecommendation(durationMs: number, failed = false) {
      if (failed) dispatch.failures += 1;
      else dispatch.recommendations += 1;
      const duration = Math.max(0, durationMs);
      dispatch.durationMs.count += 1;
      dispatch.durationMs.sum += duration;
      dispatch.durationMs.max = Math.max(dispatch.durationMs.max, duration);
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
        realtime: {
          ...realtime,
          gpsProcessingMs: { ...realtime.gpsProcessingMs },
        },
        dispatch: { ...dispatch, durationMs: { ...dispatch.durationMs } },
      };
    },
  };
}

export const metrics = createMetricsRecorder();
