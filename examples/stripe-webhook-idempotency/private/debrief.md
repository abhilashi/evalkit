# Frontier Failure Debrief: stripe-webhook-idempotency

## 1. Root Cause & Non-Obvious Trap
Webhook retries and multiple partial refunds against the same charge need per-ledger state for both processed event IDs and per-charge paid/refunded totals.

## 2. Naive Fixes That Fail
- Putting a `Set` at module scope breaks isolation between separate ledger instances in tests and multi-tenant workers.
- Marking an event ID as processed *before* validating refund limits silently swallows a rejected event if it is later corrected/retried.

## 3. Where AI Coding Agents Got Stuck
Agents frequently check `balance >= amountCents` globally per customer instead of enforcing refund caps per `chargeId`, which allows over-refunding one charge by draining credits from a different invoice.
