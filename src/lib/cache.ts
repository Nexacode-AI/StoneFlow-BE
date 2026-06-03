import redis from './redis';

const PREFIX = 'stone:';

/**
 * Fetch from cache if available, otherwise run fn(), store result, return it.
 * Falls back to fn() transparently when Redis is unavailable.
 */
export async function withCache<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<T> {
  const fullKey = PREFIX + key;

  if (redis) {
    try {
      const cached = await redis.get<T>(fullKey);
      if (cached !== null && cached !== undefined) return cached;
    } catch { /* Redis error — fall through to DB */ }
  }

  const result = await fn();

  if (redis) {
    try {
      await redis.set(fullKey, result, { ex: ttlSeconds });
    } catch { /* ignore write errors */ }
  }

  return result;
}

/** Delete one or more cache keys. */
export async function invalidate(...keys: string[]): Promise<void> {
  if (!redis || keys.length === 0) return;
  try {
    await redis.del(...keys.map(k => PREFIX + k));
  } catch { /* ignore */ }
}

/** Delete all keys matching a prefix pattern (e.g. "jobs:list"). */
export async function invalidatePattern(pattern: string): Promise<void> {
  if (!redis) return;
  try {
    const keys = await redis.keys(PREFIX + pattern + '*');
    if (keys.length > 0) await redis.del(...keys);
  } catch { /* ignore */ }
}
