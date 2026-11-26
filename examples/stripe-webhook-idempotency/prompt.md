# Task: Enforce Idempotent Billing Webhooks & Refund Reconciliation

## Problem Statement

Our billing webhook processor currently applies every incoming `invoice.paid` and `charge.refunded` event unconditionally. When payment webhooks are retried or partial refunds exceed the original charge amount, customer credit balances drift and over-debit.

## Expected Behavior

Update `processBillingWebhook(ledger, event)` and `createLedger()` to enforce the following guarantees:

1. **Per-ledger idempotency:** Each `ledger` instance must independently track processed event IDs (do not use module-level global state shared across ledgers). Re-delivering an already processed `invoice.paid` or `charge.refunded` event `id` must not modify balances and must return `{ applied: false, duplicate: true, balance }` with the customer's current balance.
2. **Charge-level refund caps:** Both `invoice.paid` and `charge.refunded` events require a non-empty `chargeId`. Track total paid and refunded amounts per `chargeId`. A `charge.refunded` event for an unknown `chargeId` or whose cumulative refunded amount would exceed the paid amount for that `chargeId` must throw an Error and must not modify balances or mark the event as processed.
3. **Payload validation:** For `invoice.paid` and `charge.refunded`, missing/empty `id`, missing/empty `customerId`, missing/empty `chargeId`, or non-numeric / `<= 0` `amountCents` must throw an Error.
4. **Unrelated events:** Events whose `type` is neither `invoice.paid` nor `charge.refunded` must still be ignored and return `{ applied: false, duplicate: false }`.

## Constraints

- Keep existing passing tests green.
- Everything runs strictly offline with zero external network calls.
