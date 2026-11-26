# Frontier Failure Debrief: rate-limiter-sliding-window

## 1. Root Cause & Non-Obvious Trap
Fixed-window buckets allow 2x boundary bursts and leak memory indefinitely because each `key:windowId` creates a new Map entry that is never deleted.

## 2. Naive Fixes That Fail
- Only pruning the *current* `key` on `check(key, now)` still leaks memory forever for one-shot ephemeral tenant/IP keys.
- Simply appending `now` with `.push(now)` breaks `oldest = timestamps[0]` under minor NTP/clock skew where `now` arrives slightly out of order.
- Recording blocked requests into the sliding window causes a permanent lockout loop under continuous retries.

## 3. Where AI Coding Agents Got Stuck
Agents regularly forget to evict *other* idle keys (failing the bounded memory check) or get the boundary condition (`<` vs `<=` on `now - windowMs`) off by 1ms.
