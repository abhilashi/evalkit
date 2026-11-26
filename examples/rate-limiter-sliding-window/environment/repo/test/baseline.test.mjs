import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/limiter.mjs";

test("allows requests up to limit within a single window", () => {
  const rl = createRateLimiter({ limit: 2, windowMs: 1000 });
  assert.deepEqual(rl.check("tenant:a", 100), { allowed: true, remaining: 1, retryAfterMs: 0 });
  assert.deepEqual(rl.check("tenant:a", 200), { allowed: true, remaining: 0, retryAfterMs: 0 });
  const blocked = rl.check("tenant:a", 300);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
});
