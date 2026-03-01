/**
 * Redis connection management.
 * Two connections: one for commands, one for pub/sub (Redis requires dedicated subscriber connections).
 */

import Redis from "ioredis";

let client: Redis | null = null;
let subscriber: Redis | null = null;

export const isRedisEnabled = () => !!process.env.REDIS_URL;

export function getRedisClient(): Redis {
  if (!client) {
    client = new Redis(process.env.REDIS_URL!, { connectionName: "openscad-cmd" });
    client.on("error", err => console.error("[Redis] Error:", err));
  }
  return client;
}

export function getRedisSubscriber(): Redis {
  if (!subscriber) {
    subscriber = new Redis(process.env.REDIS_URL!, {
      connectionName: "openscad-sub",
      maxRetriesPerRequest: null,
    });
    subscriber.on("error", err => console.error("[Redis sub] Error:", err));
  }
  return subscriber;
}

export async function closeRedis() {
  await Promise.all([client?.quit().catch(() => {}), subscriber?.quit().catch(() => {})]);
  client = subscriber = null;
}
