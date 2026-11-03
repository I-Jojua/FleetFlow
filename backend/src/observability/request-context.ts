import { AsyncLocalStorage } from "node:async_hooks";

interface RequestContext {
  requestId: string;
  ipAddress?: string;
}

const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  requestId: string,
  callback: () => T,
  ipAddress?: string,
): T {
  return requestContext.run({ requestId, ...(ipAddress ? { ipAddress } : {}) }, callback);
}

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function getRequestIpAddress(): string | undefined {
  return requestContext.getStore()?.ipAddress;
}
