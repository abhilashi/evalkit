export function createRateLimiter({ limit, windowMs }) {
  const buckets = new Map();

  function check(key, now = Date.now()) {
    const windowId = Math.floor(now / windowMs);
    const bucketKey = `${key}:${windowId}`;
    const count = buckets.get(bucketKey) ?? 0;

    if (count >= limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: windowMs,
      };
    }

    buckets.set(bucketKey, count + 1);
    return {
      allowed: true,
      remaining: limit - (count + 1),
      retryAfterMs: 0,
    };
  }

  function activeKeyCount() {
    return buckets.size;
  }

  return { check, activeKeyCount };
}
