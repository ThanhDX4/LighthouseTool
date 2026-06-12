import type { Redis } from "ioredis";

export function createRedisTokenStore(redis: Redis) {
  return {
    get: (key: string) => redis.get(key),
    set: (key: string, value: string, ttlSeconds = 3600) => redis.set(key, value, "EX", ttlSeconds)
  };
}
