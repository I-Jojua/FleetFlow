import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { UserRole } from "../../generated/prisma/client.js";
import { env } from "../../config/env.js";
import { prisma } from "../../config/prisma.js";
import { ensureRedisConnected, redis } from "../../config/redis.js";
import { isStaffRole } from "../auth/authorization.js";
import { consumeRealtimeTicket } from "./ticket.service.js";
import { realtimeClientMessageSchema, realtimeLocationEventSchema, type RealtimeLocationEvent } from "./realtime.validation.js";
import { logger } from "../../utils/logger.js";
import { metrics } from "../../observability/metrics.js";

const REALTIME_PATH = "/api/v1/realtime/socket";
const LOCATION_CHANNEL = "fleetflow:realtime:driver-locations:v1";
const MAX_SUBSCRIPTIONS_PER_SOCKET = 50;
const MAX_MESSAGES_PER_MINUTE = 60;
const HEARTBEAT_INTERVAL_MS = 30_000;

interface Principal {
  id: string;
  role: UserRole;
}

interface ClientContext extends Principal {
  deliveryIds: Set<string>;
  activeDrivers: boolean;
  windowStartedAt: number;
  messagesInWindow: number;
  alive: boolean;
  metricsReleased: boolean;
  releaseIpSlot: () => void;
}

export interface RealtimeGatewayOptions {
  maxConnections?: number;
  maxConnectionsPerIp?: number;
  maxBufferedBytes?: number;
}

function writeUpgradeError(socket: import("node:stream").Duplex, status: number, reason: string) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function sendJson(
  socket: WebSocket,
  message: unknown,
  maxBufferedBytes: number,
  enforceBackpressure = false,
) {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (enforceBackpressure && socket.bufferedAmount >= maxBufferedBytes) {
    metrics.recordBackpressureEvent();
    socket.close(1013, "slow consumer; reconnect and resume from location history");
    return;
  }
  try {
    socket.send(JSON.stringify(message), (error) => {
      if (error) {
        if (enforceBackpressure) metrics.recordFailedBroadcast();
        logger.warn("realtime_socket_send_failed", { errorType: error.name });
      }
    });
  } catch (error) {
    logger.warn("realtime_socket_send_failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

function originAllowed(request: IncomingMessage) {
  const origin = request.headers.origin;
  return !origin || (typeof origin === "string" && env.CORS_ALLOWED_ORIGINS.includes(origin));
}

export function createRealtimeGateway(server: Server, options: RealtimeGatewayOptions = {}) {
  const maxConnections = options.maxConnections ?? env.REALTIME_MAX_CONNECTIONS;
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? env.REALTIME_MAX_CONNECTIONS_PER_IP;
  const maxBufferedBytes = options.maxBufferedBytes ?? env.REALTIME_MAX_BUFFERED_BYTES;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4_096, perMessageDeflate: false });
  const subscriber = redis.duplicate();
  const contexts = new Map<WebSocket, ClientContext>();
  const deliverySubscribers = new Map<string, Set<WebSocket>>();
  const connectionCountsByIp = new Map<string, number>();
  const pendingSockets = new Set<import("node:stream").Duplex>();
  let pendingConnections = 0;
  let activeDriverSubscribers = new Set<WebSocket>();
  let channelSubscribed = false;
  let subscriptionAttempt: Promise<void> | undefined;
  let pubSubConnected = false;
  let started = false;
  let closed = false;

  const removeFromDelivery = (socket: WebSocket, deliveryId: string) => {
    const members = deliverySubscribers.get(deliveryId);
    if (members?.delete(socket)) metrics.changeActiveSubscriptions(-1);
    if (members?.size === 0) deliverySubscribers.delete(deliveryId);
    contexts.get(socket)?.deliveryIds.delete(deliveryId);
  };

  const currentUser = async (userId: string) => prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, status: true },
  });

  const canSubscribeToDelivery = (principal: Principal, delivery: {
    customerId: string;
    driverId: string | null;
  }) => isStaffRole(principal.role) ||
    (principal.role === "CUSTOMER" && delivery.customerId === principal.id) ||
    (principal.role === "DRIVER" && delivery.driverId === principal.id);

  const handleClientMessage = async (socket: WebSocket, context: ClientContext, raw: string) => {
    const now = Date.now();
    if (now - context.windowStartedAt >= 60_000) {
      context.windowStartedAt = now;
      context.messagesInWindow = 0;
    }
    context.messagesInWindow += 1;
    if (context.messagesInWindow > MAX_MESSAGES_PER_MINUTE) {
      socket.close(1008, "message rate limit exceeded");
      return;
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
        sendJson(socket, { type: "error", code: "INVALID_MESSAGE" }, maxBufferedBytes);
      return;
    }
    const parsed = realtimeClientMessageSchema.safeParse(decoded);
    if (!parsed.success) {
      sendJson(socket, { type: "error", code: "INVALID_MESSAGE" }, maxBufferedBytes);
      return;
    }

    const user = await currentUser(context.id);
    if (!user || user.status !== "ACTIVE") {
      socket.close(1008, "account is not active");
      return;
    }
    context.role = user.role;

    switch (parsed.data.type) {
      case "subscribe_delivery": {
        const delivery = await prisma.delivery.findUnique({
          where: { id: parsed.data.deliveryId },
          select: { customerId: true, driverId: true },
        });
        if (!delivery || !canSubscribeToDelivery(context, delivery)) {
          sendJson(socket, { type: "subscription_error", code: "SUBSCRIPTION_FORBIDDEN" }, maxBufferedBytes);
          return;
        }
        if (context.deliveryIds.size >= MAX_SUBSCRIPTIONS_PER_SOCKET && !context.deliveryIds.has(parsed.data.deliveryId)) {
          sendJson(socket, { type: "subscription_error", code: "SUBSCRIPTION_LIMIT_REACHED" }, maxBufferedBytes);
          return;
        }
        if (!context.deliveryIds.has(parsed.data.deliveryId)) metrics.changeActiveSubscriptions(1);
        context.deliveryIds.add(parsed.data.deliveryId);
        const members = deliverySubscribers.get(parsed.data.deliveryId) ?? new Set<WebSocket>();
        members.add(socket);
        deliverySubscribers.set(parsed.data.deliveryId, members);
        sendJson(socket, { type: "subscribed", scope: "delivery", deliveryId: parsed.data.deliveryId }, maxBufferedBytes);
        return;
      }
      case "unsubscribe_delivery":
        removeFromDelivery(socket, parsed.data.deliveryId);
        sendJson(socket, { type: "unsubscribed", scope: "delivery", deliveryId: parsed.data.deliveryId }, maxBufferedBytes);
        return;
      case "subscribe_active_drivers":
        if (!isStaffRole(context.role)) {
          sendJson(socket, { type: "subscription_error", code: "SUBSCRIPTION_FORBIDDEN" }, maxBufferedBytes);
          return;
        }
        if (!context.activeDrivers) metrics.changeActiveSubscriptions(1);
        context.activeDrivers = true;
        activeDriverSubscribers.add(socket);
        sendJson(socket, { type: "subscribed", scope: "active_drivers" }, maxBufferedBytes);
        return;
      case "unsubscribe_active_drivers":
        if (context.activeDrivers) metrics.changeActiveSubscriptions(-1);
        context.activeDrivers = false;
        activeDriverSubscribers.delete(socket);
        sendJson(socket, { type: "unsubscribed", scope: "active_drivers" }, maxBufferedBytes);
        return;
    }
  };

  const handleConnection = (socket: WebSocket, principal: Principal, releaseIpSlot: () => void) => {
    const context: ClientContext = {
      ...principal,
      deliveryIds: new Set(),
      activeDrivers: false,
      windowStartedAt: Date.now(),
      messagesInWindow: 0,
      alive: true,
      metricsReleased: false,
      releaseIpSlot,
    };
    contexts.set(socket, context);
    metrics.changeActiveConnections(1);
    sendJson(socket, { type: "connected", reconnect: "Request a new ticket and re-subscribe after reconnecting." }, maxBufferedBytes);
    socket.on("pong", () => { context.alive = true; });
    let messageChain = Promise.resolve();
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        sendJson(socket, { type: "error", code: "TEXT_MESSAGES_ONLY" }, maxBufferedBytes);
        return;
      }
      messageChain = messageChain.then(() => handleClientMessage(socket, context, data.toString())).catch((error: unknown) => {
        logger.warn("realtime_message_failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        sendJson(socket, { type: "error", code: "REQUEST_FAILED" }, maxBufferedBytes);
      });
    });
    const releaseConnectionState = () => {
      if (context.metricsReleased) return;
      context.metricsReleased = true;
      for (const deliveryId of context.deliveryIds) removeFromDelivery(socket, deliveryId);
      if (context.activeDrivers) metrics.changeActiveSubscriptions(-1);
      activeDriverSubscribers.delete(socket);
      contexts.delete(socket);
      metrics.changeActiveConnections(-1);
      releaseIpSlot();
    };
    socket.on("close", releaseConnectionState);
    socket.on("error", (error) => logger.warn("realtime_socket_error", { errorType: error.name }));
  };

  const handleLocationEvent = async (event: RealtimeLocationEvent) => {
    const deliveries = deliverySubscribers.get(event.deliveryId);
    const interestedSockets = new Set<WebSocket>([
      ...(deliveries ?? []),
      ...activeDriverSubscribers,
    ]);
    if (interestedSockets.size === 0) return;

    const delivery = await prisma.delivery.findUnique({
      where: { id: event.deliveryId },
      select: { id: true, customerId: true, driverId: true, status: true },
    });
    const users = await prisma.user.findMany({
      where: { id: { in: [...interestedSockets].map((socket) => contexts.get(socket)?.id).filter((id): id is string => Boolean(id)) } },
      select: { id: true, role: true, status: true },
    });
    const usersById = new Map(users.map((user) => [user.id, user]));
    const deliveryIsLive = Boolean(delivery && ["PICKED_UP", "IN_TRANSIT"].includes(delivery.status));

    for (const socket of interestedSockets) {
      const context = contexts.get(socket);
      if (!context) continue;
      const user = usersById.get(context.id);
      if (!user || user.status !== "ACTIVE") {
        socket.close(1008, "account is not active");
        continue;
      }
      context.role = user.role;

      const wantsDelivery = context.deliveryIds.has(event.deliveryId);
      const authorizedDelivery = Boolean(delivery && deliveryIsLive && canSubscribeToDelivery(context, delivery));
      const wantsActiveFleet = context.activeDrivers;
      const authorizedFleet = isStaffRole(context.role);
      if (wantsDelivery && !authorizedDelivery) {
        removeFromDelivery(socket, event.deliveryId);
        sendJson(socket, { type: "subscription_revoked", scope: "delivery", deliveryId: event.deliveryId }, maxBufferedBytes);
        continue;
      }
      if (wantsActiveFleet && !authorizedFleet) {
        if (context.activeDrivers) metrics.changeActiveSubscriptions(-1);
        context.activeDrivers = false;
        activeDriverSubscribers.delete(socket);
        sendJson(socket, { type: "subscription_revoked", scope: "active_drivers" }, maxBufferedBytes);
        continue;
      }
      if ((wantsDelivery && authorizedDelivery) || (wantsActiveFleet && authorizedFleet)) {
        sendJson(socket, event, maxBufferedBytes, true);
      }
    }
  };

  const onRedisMessage = (channel: string, message: string) => {
    if (channel !== LOCATION_CHANNEL) return;
    let decoded: unknown;
    try { decoded = JSON.parse(message); } catch { return; }
    const parsed = realtimeLocationEventSchema.safeParse(decoded);
    if (!parsed.success) return;
    void handleLocationEvent(parsed.data).catch((error) => {
      logger.warn("realtime_broadcast_failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    });
  };

  const setPubSubConnected = (connected: boolean) => {
    if (pubSubConnected === connected) return;
    pubSubConnected = connected;
    metrics.changePubSubConnections(connected ? 1 : -1);
  };

  const subscribeChannel = async () => {
    if (channelSubscribed || closed) return;
    if (subscriptionAttempt) return subscriptionAttempt;
    subscriptionAttempt = (async () => {
      try {
        await subscriber.subscribe(LOCATION_CHANNEL);
        channelSubscribed = true;
        setPubSubConnected(true);
      } catch (error) {
        logger.warn("realtime_redis_subscribe_failed", {
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
      } finally {
        subscriptionAttempt = undefined;
      }
    })();
    return subscriptionAttempt;
  };

  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      const context = contexts.get(socket);
      if (!context) continue;
      if (!context.alive) {
        socket.terminate();
        continue;
      }
      context.alive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const upgradeHandler = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const reject = (status: number, reason: string, release?: () => void) => {
      metrics.recordRejectedConnection();
      release?.();
      writeUpgradeError(socket, status, reason);
    };
    let url: URL;
    try { url = new URL(request.url ?? "/", "http://fleetflow.local"); } catch {
      reject(400, "Bad Request");
      return;
    }
    if (url.pathname !== REALTIME_PATH) return;
    if (!originAllowed(request)) {
      reject(403, "Forbidden");
      return;
    }

    const peerIp = request.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "unknown";
    if (contexts.size + pendingConnections >= maxConnections) {
      reject(503, "Service Unavailable");
      return;
    }
    if ((connectionCountsByIp.get(peerIp) ?? 0) >= maxConnectionsPerIp) {
      reject(429, "Too Many Requests");
      return;
    }
    pendingConnections += 1;
    connectionCountsByIp.set(peerIp, (connectionCountsByIp.get(peerIp) ?? 0) + 1);
    pendingSockets.add(socket);
    let reservationPending = true;
    let websocketEstablished = false;
    const releasePendingReservation = () => {
      if (!reservationPending) return;
      reservationPending = false;
      pendingConnections = Math.max(0, pendingConnections - 1);
      const nextCount = (connectionCountsByIp.get(peerIp) ?? 1) - 1;
      if (nextCount <= 0) connectionCountsByIp.delete(peerIp);
      else connectionCountsByIp.set(peerIp, nextCount);
      pendingSockets.delete(socket);
      socket.off("close", releaseReservationOnSocketEnd);
      socket.off("error", releaseReservationOnSocketEnd);
    };
    const transferReservationToActiveConnection = () => {
      if (!reservationPending) return false;
      reservationPending = false;
      pendingConnections = Math.max(0, pendingConnections - 1);
      pendingSockets.delete(socket);
      return true;
    };
    let activeIpSlotReleased = false;
    const releaseActiveIpSlot = () => {
      if (activeIpSlotReleased) return;
      activeIpSlotReleased = true;
      const nextCount = (connectionCountsByIp.get(peerIp) ?? 1) - 1;
      if (nextCount <= 0) connectionCountsByIp.delete(peerIp);
      else connectionCountsByIp.set(peerIp, nextCount);
    };
    const releaseReservationOnSocketEnd = () => {
      if (reservationPending) releasePendingReservation();
      else if (!websocketEstablished) releaseActiveIpSlot();
    };
    socket.once("close", releaseReservationOnSocketEnd);
    socket.once("error", releaseReservationOnSocketEnd);

    void (async () => {
      const ticket = url.searchParams.get("ticket");
      if (!ticket) {
        reject(401, "Unauthorized", releasePendingReservation);
        return;
      }

      let userId: string | null;
      try {
        userId = await consumeRealtimeTicket(ticket);
      } catch {
        reject(503, "Service Unavailable", releasePendingReservation);
        return;
      }
      if (!userId) {
        reject(401, "Unauthorized", releasePendingReservation);
        return;
      }

      let user: Awaited<ReturnType<typeof currentUser>>;
      try { user = await currentUser(userId); } catch {
        reject(503, "Service Unavailable", releasePendingReservation);
        return;
      }
      if (!user || user.status !== "ACTIVE") {
        reject(401, "Unauthorized", releasePendingReservation);
        return;
      }
      if (socket.destroyed) {
        releasePendingReservation();
        return;
      }
      if (!transferReservationToActiveConnection()) return;

      try {
        sockets.handleUpgrade(request, socket, head, (websocket) => {
          websocketEstablished = true;
          socket.off("close", releaseReservationOnSocketEnd);
          socket.off("error", releaseReservationOnSocketEnd);
          handleConnection(websocket, { id: user.id, role: user.role }, releaseActiveIpSlot);
        });
      } catch (error) {
        releaseActiveIpSlot();
        throw error;
      }
    })().catch((error) => {
      logger.warn("realtime_upgrade_failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
      reject(503, "Service Unavailable", releasePendingReservation);
    });
  };

  return {
    async start() {
      if (started || closed) return;
      started = true;
      server.on("upgrade", upgradeHandler);
      sockets.on("error", (error) => logger.warn("realtime_server_error", { errorType: error.name }));
      subscriber.on("message", onRedisMessage);
      subscriber.on("ready", () => { void subscribeChannel(); });
      subscriber.on("close", () => { channelSubscribed = false; setPubSubConnected(false); });
      subscriber.on("end", () => { channelSubscribed = false; setPubSubConnected(false); });
      subscriber.on("error", (error: Error) => {
        setPubSubConnected(false);
        logger.warn("realtime_redis_error", { errorType: error.name });
      });
      if (subscriber.status === "wait") {
        await subscriber.connect().then(subscribeChannel).catch((error: unknown) => {
          logger.warn("realtime_redis_connect_failed", {
            errorType: error instanceof Error ? error.name : "UnknownError",
          });
        });
      } else if (subscriber.status === "ready") {
        await subscribeChannel();
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      server.off("upgrade", upgradeHandler);
      clearInterval(heartbeat);
      for (const socket of sockets.clients) socket.close(1001, "server shutting down");
      for (const socket of pendingSockets) socket.destroy();
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          for (const socket of sockets.clients) socket.terminate();
          resolve();
        }, 1_000);
        timeout.unref();
        sockets.close(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
      for (const [socket, context] of contexts) {
        if (context.metricsReleased) continue;
        context.metricsReleased = true;
        for (const deliveryId of context.deliveryIds) removeFromDelivery(socket, deliveryId);
        if (context.activeDrivers) metrics.changeActiveSubscriptions(-1);
        metrics.changeActiveConnections(-1);
        context.releaseIpSlot();
      }
      subscriber.off("message", onRedisMessage);
      subscriber.disconnect();
      setPubSubConnected(false);
      contexts.clear();
      deliverySubscribers.clear();
      activeDriverSubscribers.clear();
    },
  };
}

export async function publishDriverLocationUpdate(location: {
  id: string;
  driverId: string;
  deliveryId: string | null;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  recordedAt: Date;
  requestId?: string;
}) {
  if (!location.deliveryId) return;
  const event: RealtimeLocationEvent = {
    type: "driver_location",
    driverId: location.driverId,
    deliveryId: location.deliveryId,
    latitude: location.latitude,
    longitude: location.longitude,
    accuracy: location.accuracy,
    recordedAt: location.recordedAt.toISOString(),
    ...(location.requestId ? { requestId: location.requestId } : {}),
  };
  let publishTimedOut = false;
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const publishOperation = (async () => {
      await ensureRedisConnected();
      if (publishTimedOut) return;
      await redis.publish(LOCATION_CHANNEL, JSON.stringify(event));
      if (!publishTimedOut) metrics.recordPublishedBroadcast();
    })();
    await Promise.race([
      publishOperation,
      new Promise<never>((_, reject) => {
        publishTimer = setTimeout(() => {
          publishTimedOut = true;
          reject(new Error("REALTIME_PUBLISH_TIMEOUT"));
        }, env.REALTIME_PUBLISH_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    // Persisted history remains authoritative if the transient fan-out is unavailable.
    metrics.recordFailedBroadcast();
    logger.warn("realtime_location_publish_failed", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    if (publishTimer) clearTimeout(publishTimer);
  }
}
