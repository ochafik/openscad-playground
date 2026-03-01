/**
 * Command queue for routing tool actions to app instances.
 *
 * Supports:
 * - Fire-and-forget commands (state flows back via model context updates)
 * - Request-response commands (server blocks until client submits result)
 * - Long-polling (server parks poll request until commands arrive)
 *
 * Two backends: InMemoryBackend (default) and RedisBackend (when REDIS_URL is set).
 */

import { isRedisEnabled, getRedisClient, getRedisSubscriber } from "./redis-client.js";

// ─── Command types ──────────────────────────────────────────────────────

export type OpenSCADCommand =
  // Fire-and-forget commands
  | { type: "write_source"; content: string }
  | { type: "edit_source"; old_text: string; new_text: string }
  | { type: "read_source" }
  | { type: "set_camera"; view?: string; theta?: number; phi?: number }
  | { type: "set_var"; name: string; value: unknown }
  | { type: "set_vars"; vars: Record<string, unknown> }
  | { type: "render" }
  | { type: "zoom"; factor: number }
  | { type: "auto_fit" }
  // Request-response commands (carry requestId)
  | { type: "get_screenshot"; requestId: string }
  | { type: "get_state"; requestId: string };

export const ACTIONS = [
  "write_source", "edit_source", "read_source",
  "set_camera", "set_var", "set_vars", "render",
  "zoom", "auto_fit",
  "get_screenshot", "get_state",
] as const;

export type Action = typeof ACTIONS[number];

// ─── Backend interface ──────────────────────────────────────────────────

interface CommandQueueBackend {
  createQueue(viewUUID: string): Promise<void>;
  hasQueue(viewUUID: string): Promise<boolean>;
  enqueueCommand(viewUUID: string, command: OpenSCADCommand): Promise<void>;
  waitForCommands(viewUUID: string): Promise<void>;
  dequeueCommands(viewUUID: string): Promise<OpenSCADCommand[]>;
  waitForResult(requestId: string): Promise<unknown>;
  submitResult(requestId: string, data: unknown): Promise<boolean>;
  shutdown(): Promise<void>;
}

// ─── Constants ──────────────────────────────────────────────────────────

const COMMAND_TTL_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;
const POLL_BATCH_WAIT_MS = 200;
const LONG_POLL_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 15_000;

// ─── InMemoryBackend ────────────────────────────────────────────────────

class InMemoryBackend implements CommandQueueBackend {
  private queues = new Map<string, { commands: OpenSCADCommand[]; lastActivity: number }>();
  private pollWaiters = new Map<string, () => void>();
  private pendingRequests = new Map<string, {
    resolve: (data: unknown) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private sweepTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [uuid, entry] of this.queues) {
        if (now - entry.lastActivity > COMMAND_TTL_MS) {
          this.queues.delete(uuid);
        }
      }
    }, SWEEP_INTERVAL_MS);

    if (typeof this.sweepTimer === "object" && "unref" in this.sweepTimer) {
      this.sweepTimer.unref();
    }
  }

  async createQueue(viewUUID: string): Promise<void> {
    if (!this.queues.has(viewUUID)) {
      this.queues.set(viewUUID, { commands: [], lastActivity: Date.now() });
    }
  }

  async hasQueue(viewUUID: string): Promise<boolean> {
    return this.queues.has(viewUUID);
  }

  async enqueueCommand(viewUUID: string, command: OpenSCADCommand): Promise<void> {
    let entry = this.queues.get(viewUUID);
    if (!entry) {
      entry = { commands: [], lastActivity: Date.now() };
      this.queues.set(viewUUID, entry);
    }
    entry.commands.push(command);
    entry.lastActivity = Date.now();

    const wake = this.pollWaiters.get(viewUUID);
    if (wake) {
      this.pollWaiters.delete(viewUUID);
      wake();
    }
  }

  async waitForCommands(viewUUID: string): Promise<void> {
    const entry = this.queues.get(viewUUID);
    if (entry && entry.commands.length > 0) {
      return new Promise(r => setTimeout(r, POLL_BATCH_WAIT_MS));
    }

    return new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.pollWaiters.delete(viewUUID);
        resolve();
      }, LONG_POLL_TIMEOUT_MS);

      const prev = this.pollWaiters.get(viewUUID);
      if (prev) prev();

      this.pollWaiters.set(viewUUID, () => {
        clearTimeout(timer);
        setTimeout(resolve, POLL_BATCH_WAIT_MS);
      });
    });
  }

  async dequeueCommands(viewUUID: string): Promise<OpenSCADCommand[]> {
    const entry = this.queues.get(viewUUID);
    if (!entry) return [];
    entry.lastActivity = Date.now();
    if (entry.commands.length === 0) return [];
    const commands = entry.commands;
    entry.commands = [];
    return commands;
  }

  async waitForResult(requestId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request ${requestId} timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
    });
  }

  async submitResult(requestId: string, data: unknown): Promise<boolean> {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;
    this.pendingRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(data);
    return true;
  }

  async shutdown(): Promise<void> {
    clearInterval(this.sweepTimer);
  }
}

// ─── RedisBackend ───────────────────────────────────────────────────────

const REDIS_TTL_SECONDS = 60;

class RedisBackend implements CommandQueueBackend {
  /** Lua script: atomically LRANGE + DEL + refresh alive TTL */
  private static DEQUEUE_LUA = `
    local q = KEYS[1]
    local alive = KEYS[2]
    local ttl = tonumber(ARGV[1])
    local items = redis.call('LRANGE', q, 0, -1)
    if #items > 0 then
      redis.call('DEL', q)
    end
    redis.call('EXPIRE', alive, ttl)
    return items
  `;

  async createQueue(viewUUID: string): Promise<void> {
    const redis = getRedisClient();
    await redis.set(`osc:{${viewUUID}}:alive`, "1", "EX", REDIS_TTL_SECONDS);
  }

  async hasQueue(viewUUID: string): Promise<boolean> {
    const redis = getRedisClient();
    return (await redis.exists(`osc:{${viewUUID}}:alive`)) === 1;
  }

  async enqueueCommand(viewUUID: string, command: OpenSCADCommand): Promise<void> {
    const redis = getRedisClient();
    const qKey = `osc:{${viewUUID}}:q`;
    await redis.rpush(qKey, JSON.stringify(command));
    await redis.expire(qKey, REDIS_TTL_SECONDS);
    await redis.expire(`osc:{${viewUUID}}:alive`, REDIS_TTL_SECONDS);
    await redis.publish(`osc:wake:{${viewUUID}}`, "1");
  }

  async waitForCommands(viewUUID: string): Promise<void> {
    const redis = getRedisClient();
    const qKey = `osc:{${viewUUID}}:q`;

    // Check if commands already exist
    const len = await redis.llen(qKey);
    if (len > 0) {
      return new Promise(r => setTimeout(r, POLL_BATCH_WAIT_MS));
    }

    // Subscribe and wait for wakeup or timeout
    const sub = getRedisSubscriber();
    const channel = `osc:wake:{${viewUUID}}`;

    return new Promise<void>(resolve => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        sub.unsubscribe(channel).catch(() => {});
        sub.removeListener("message", onMessage);
        // Brief batch wait after wakeup
        setTimeout(resolve, POLL_BATCH_WAIT_MS);
      };

      const onMessage = (ch: string) => {
        if (ch === channel) done();
      };

      const timer = setTimeout(done, LONG_POLL_TIMEOUT_MS);

      sub.subscribe(channel).then(() => {
        // Re-check after subscribe to close race window
        redis.llen(qKey).then(postLen => {
          if (postLen > 0) done();
        });
      });

      sub.on("message", onMessage);
    });
  }

  async dequeueCommands(viewUUID: string): Promise<OpenSCADCommand[]> {
    const redis = getRedisClient();
    const qKey = `osc:{${viewUUID}}:q`;
    const aliveKey = `osc:{${viewUUID}}:alive`;

    const items = await redis.eval(
      RedisBackend.DEQUEUE_LUA,
      2,
      qKey,
      aliveKey,
      REDIS_TTL_SECONDS.toString(),
    ) as string[];

    return items.map(s => JSON.parse(s));
  }

  async waitForResult(requestId: string): Promise<unknown> {
    const sub = getRedisSubscriber();
    const channel = `osc:res:{${requestId}}`;

    return new Promise<unknown>((resolve, reject) => {
      let resolved = false;
      const done = (data?: unknown, err?: Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        sub.unsubscribe(channel).catch(() => {});
        sub.removeListener("message", onMessage);
        if (err) reject(err);
        else resolve(data);
      };

      const onMessage = (ch: string, message: string) => {
        if (ch === channel) {
          try {
            done(JSON.parse(message));
          } catch (e) {
            done(undefined, new Error(`Invalid result for ${requestId}: ${e}`));
          }
        }
      };

      const timer = setTimeout(
        () => done(undefined, new Error(`Request ${requestId} timed out after ${REQUEST_TIMEOUT_MS}ms`)),
        REQUEST_TIMEOUT_MS,
      );

      sub.subscribe(channel).catch(err => done(undefined, err));
      sub.on("message", onMessage);
    });
  }

  async submitResult(requestId: string, data: unknown): Promise<boolean> {
    const redis = getRedisClient();
    const channel = `osc:res:{${requestId}}`;
    const receiverCount = await redis.publish(channel, JSON.stringify(data));
    return receiverCount > 0;
  }

  async shutdown(): Promise<void> {
    // Redis connections are closed via closeRedis() in redis-client.ts
  }
}

// ─── Backend selection ──────────────────────────────────────────────────

const backend: CommandQueueBackend = isRedisEnabled() ? new RedisBackend() : new InMemoryBackend();

// ─── Public API (async wrappers) ────────────────────────────────────────

export function createQueue(viewUUID: string): Promise<void> {
  return backend.createQueue(viewUUID);
}

export function hasQueue(viewUUID: string): Promise<boolean> {
  return backend.hasQueue(viewUUID);
}

export function enqueueCommand(viewUUID: string, command: OpenSCADCommand): Promise<void> {
  return backend.enqueueCommand(viewUUID, command);
}

export function waitForCommands(viewUUID: string): Promise<void> {
  return backend.waitForCommands(viewUUID);
}

export function dequeueCommands(viewUUID: string): Promise<OpenSCADCommand[]> {
  return backend.dequeueCommands(viewUUID);
}

export function waitForResult(requestId: string): Promise<unknown> {
  return backend.waitForResult(requestId);
}

export function submitResult(requestId: string, data: unknown): Promise<boolean> {
  return backend.submitResult(requestId, data);
}

export function shutdownQueue(): Promise<void> {
  return backend.shutdown();
}
