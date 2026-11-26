# Task: Fix Refresh-Token Rotation Race & Family Reuse Revocation

## Problem Statement

Our SaaS authentication service rotates refresh tokens on every use, but users with multiple open browser tabs get randomly logged out when two tabs trigger a refresh concurrently. At the same time, we do not currently revoke the rest of a session family when an attacker replays an expired/stolen refresh token.

## Expected Behavior

Update `createSessionManager({ graceWindowMs })` to support both concurrent-tab grace replay and family-wide theft revocation:

1. **Grace-window idempotency:** When an already-rotated token `T1` is passed to `rotate(T1, now)` within `0 <= (now - rotatedAt) <= graceWindowMs` **and** its direct replacement `T2` is still the active (unrotated) head of the family, return `{ token: T2, familyId, userId, replayedWithinGrace: true }` without minting a new token or revoking the family. Normal rotations must return `replayedWithinGrace: false`.
2. **Reuse detection & family revocation:** If an already-rotated token is presented to `rotate()` *outside* `graceWindowMs`, OR if its direct child has already been rotated further (i.e., an ancestor >1 hop behind the current head is replayed, even within `graceWindowMs`), immediately revoke the entire `familyId` and throw an Error.
3. **Post-revocation enforcement:** Once a `familyId` is revoked:
   - `isFamilyRevoked(familyId)` must return `true` (and `false` otherwise).
   - `isActive(token)` must return `false` for all tokens in that family (including the previously active head).
   - Any further `rotate()` call using any token in that family must throw an Error.

## Constraints

- Preserve existing `issue`, `rotate`, and `isActive` signatures and baseline behavior.
- All tests run strictly offline.
