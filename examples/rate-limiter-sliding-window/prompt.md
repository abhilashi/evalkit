# Task: Fix Rate Limiter Boundary Bursts, Retry-After Precision & Memory Leak

## Problem Statement

Our API gateway's in-memory rate limiter uses fixed time buckets (`Math.floor(now / windowMs)`). This causes three production issues:
1. Clients can send 2x the allowed limit across a window boundary (e.g., at `t=990ms` and `t=1010ms`).
2. Blocked responses always return the full `windowMs` as `retryAfterMs` instead of the exact time until a slot opens.
3. Old per-window bucket keys are never evicted, causing unbounded memory growth (`activeKeyCount()` grows forever).

## Expected Behavior

Refactor `createRateLimiter({ limit, windowMs })` to implement a true sliding-window log per key:

1. **Exact sliding window:** A request at timestamp `now` is allowed if strictly fewer than `limit` previous accepted requests for `key` occurred in the half-open interval `(now - windowMs, now]` (timestamps `<= now - windowMs` are expired).
2. **Exact `retryAfterMs`:** When blocked (`allowed: false, remaining: 0`), return `retryAfterMs = Math.max(1, oldestTimestampInWindow + windowMs - now)`. Do NOT record rejected requests into the window.
3. **Stale key eviction:** On `check(key, now)`, prune expired timestamps across stored keys and delete any key whose active timestamps become empty so `activeKeyCount()` only reflects keys with live requests in the current window.
4. **Backward clock jitter:** If a request arrives with `now` slightly earlier than a previously recorded timestamp for that key, maintain sorted order so `oldestTimestampInWindow` and `retryAfterMs` remain accurate and never negative.
5. **Config validation:** Throw an Error if `limit` is not a positive integer or `windowMs <= 0`.

## Constraints

- Preserve `check(key, now)` and `activeKeyCount()` return shapes and baseline test behavior.
- Zero external dependencies; strictly offline.
