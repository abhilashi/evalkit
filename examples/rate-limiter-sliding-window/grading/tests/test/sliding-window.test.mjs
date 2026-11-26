import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../src/limiter.mjs";

test("prevents fixed-window boundary 2x burst spikes and returns exact retryAfterMs", () => {
  const rl = createRateLimiter({ limit: 3, windowMs: 1000 });

  // 3 requests right before the 1000ms boundary
  assert.equal(rl.check("api:user1", 900).allowed, true);
  assert.equal(rl.check("api:user1", 950).allowed, true);
  assert.equal(rl.check("api:user1", 990).allowed, true);

  // At t=1050 (new fixed window, but still inside sliding 1000ms window from 900!)
  const blocked = rl.check("api:user1", 1050);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterMs, 850); // oldest (900) + 1000 - 1050 = 850

  // At t=1900, the t=900 timestamp has expired (cutoff = 900, <= expires)
  const allowedAgain = rl.check("api:user1", 1900);
  assert.equal(allowedAgain.allowed, true);
  assert.equal(allowedAgain.remaining, 0);
});

test("evicts stale idle tenant keys so activeKeyCount stays bounded", () => {
  const rl = createRateLimiter({ limit: 5, windowMs: 1000 });
  for (let i = 0; i < 50; i++) {
    rl.check(`ephemeral:${i}`, 1000 + i);
  }
  assert.equal(rl.activeKeyCount(), 50);

  // Advance well past windowMs and check one active tenant
  rl.check("steady:tenant", 5000);
  assert.equal(rl.activeKeyCount(), 1);
});

test("handles minor backward clock skew without negative retryAfterMs", () => {
  const rl = createRateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(rl.check("skew:1", 2000).allowed, true);
  assert.equal(rl.check("skew:1", 1950).allowed, true);

  const blocked = rl.check("skew:1", 1960);
  assert.equal(blocked.allowed, false);
  // Oldest timestamp is 1950 -> 1950 + 1000 - 1960 = 990ms
  assert.equal(blocked.retryAfterMs, 990);
});
