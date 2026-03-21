import { Redis } from 'ioredis';

let _redis: Redis | null = null;

export function getRedisClient(): Redis {
  if (!_redis) {
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    _redis = new Redis(url, { maxRetriesPerRequest: null });
  }
  return _redis;
}

export function disconnectRedis(): void {
  if (_redis) {
    _redis.disconnect();
    _redis = null;
  }
}

export function createRedisConnection(): Redis {
  const url = process.env.REDIS_URL || 'redis://localhost:6379';
  return new Redis(url, { maxRetriesPerRequest: null });
}

// Returns a plain config object for BullMQ (avoids ioredis version conflicts)
export function getRedisConnectionConfig(): { host: string; port: number; maxRetriesPerRequest: null } {
  const url = new URL(process.env.REDIS_URL || 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: parseInt(url.port || '6379', 10),
    maxRetriesPerRequest: null,
  };
}
