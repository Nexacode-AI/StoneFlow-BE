import { Redis } from '@upstash/redis';

// Returns null gracefully when env vars are missing (local dev without Redis)
function createClient(): Redis | null {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const redis = createClient();

if (redis) {
  console.log('[Redis] Upstash connected');
} else {
  console.log('[Redis] No UPSTASH_REDIS_REST_URL/TOKEN — caching disabled');
}

export default redis;
