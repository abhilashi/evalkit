# Frontier Failure Debrief: jwt-session-rotation-race

## 1. Root Cause & Non-Obvious Trap
Refresh token rotation must distinguish benign parallel browser-tab races (replaying the immediate parent within a few seconds while the child is still the head) from genuine replay attacks (replaying after the grace window OR replaying an older ancestor two hops back).

## 2. Naive Fixes That Fail
- Allowing *any* token rotated within `graceWindowMs` to replay misses the 2-hop attack where `T1 -> T2 -> T3` all happened within 1 second and `T1` is replayed.
- Rejecting a reused token without revoking the entire `familyId` leaves the attacker's rotated child session active.

## 3. Where AI Coding Agents Got Stuck
Agents commonly forget the `childIsStillHead` check or mint a *brand new* token on grace replay instead of returning the exact existing child token idempotently.
