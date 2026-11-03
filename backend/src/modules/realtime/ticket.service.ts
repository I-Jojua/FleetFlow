import { createHash, randomBytes } from "node:crypto";
import { ensureRedisConnected, redis } from "../../config/redis.js";

const TICKET_TTL_SECONDS = 30;
const TICKET_PREFIX = "fleetflow:realtime:ticket:";
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function ticketKey(ticket: string) {
  return `${TICKET_PREFIX}${createHash("sha256").update(ticket).digest("hex")}`;
}

export interface RealtimeTicketStore {
  set(key: string, value: string, expiryMode: "EX", seconds: number, condition: "NX"): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
}

export function createRealtimeTicketService(
  store: RealtimeTicketStore,
  ttlSeconds = TICKET_TTL_SECONDS,
) {
  return {
    async issue(userId: string) {
      const ticket = randomBytes(32).toString("base64url");
      const result = await store.set(ticketKey(ticket), userId, "EX", ttlSeconds, "NX");
      if (result !== "OK") throw new Error("REALTIME_UNAVAILABLE");
      return { ticket, expiresInSeconds: ttlSeconds };
    },
    async consume(ticket: string) {
      if (!TICKET_PATTERN.test(ticket)) return null;
      return store.getdel(ticketKey(ticket));
    },
  };
}

const ticketService = createRealtimeTicketService(redis);

export async function issueRealtimeTicket(userId: string) {
  try {
    await ensureRedisConnected();
    return await ticketService.issue(userId);
  } catch {
    throw new Error("REALTIME_UNAVAILABLE");
  }
}

export async function consumeRealtimeTicket(ticket: string) {
  await ensureRedisConnected();
  return ticketService.consume(ticket);
}
