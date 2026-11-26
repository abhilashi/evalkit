import test from "node:test";
import assert from "node:assert/strict";
import { createLedger } from "../src/ledger.mjs";
import { processBillingWebhook } from "../src/webhooks.mjs";

test("duplicate invoice.paid and charge.refunded deliveries are idempotent per ledger", () => {
  const ledgerA = createLedger();
  const ledgerB = createLedger();

  const paid = {
    id: "evt_paid_1",
    type: "invoice.paid",
    customerId: "cus_9",
    chargeId: "ch_9",
    amountCents: 5000,
  };

  assert.deepEqual(processBillingWebhook(ledgerA, paid), {
    applied: true,
    duplicate: false,
    balance: 5000,
  });
  assert.deepEqual(processBillingWebhook(ledgerA, paid), {
    applied: false,
    duplicate: true,
    balance: 5000,
  });

  // Separate ledger instance must remain isolated (no global dedupe state)
  assert.deepEqual(processBillingWebhook(ledgerB, paid), {
    applied: true,
    duplicate: false,
    balance: 5000,
  });

  const refund = {
    id: "evt_ref_1",
    type: "charge.refunded",
    customerId: "cus_9",
    chargeId: "ch_9",
    amountCents: 2000,
  };
  assert.deepEqual(processBillingWebhook(ledgerA, refund), {
    applied: true,
    duplicate: false,
    balance: 3000,
  });
  assert.deepEqual(processBillingWebhook(ledgerA, refund), {
    applied: false,
    duplicate: true,
    balance: 3000,
  });
});

test("rejects over-refunds, unknown charges, and invalid payloads without poisoning dedupe state", () => {
  const ledger = createLedger();
  processBillingWebhook(ledger, {
    id: "evt_paid_2",
    type: "invoice.paid",
    customerId: "cus_2",
    chargeId: "ch_2",
    amountCents: 3000,
  });

  // Partial refund succeeds
  processBillingWebhook(ledger, {
    id: "evt_ref_2a",
    type: "charge.refunded",
    customerId: "cus_2",
    chargeId: "ch_2",
    amountCents: 2000,
  });

  // Second partial refund exceeding remaining 1000 must throw
  assert.throws(() =>
    processBillingWebhook(ledger, {
      id: "evt_ref_2b",
      type: "charge.refunded",
      customerId: "cus_2",
      chargeId: "ch_2",
      amountCents: 1500,
    })
  );
  assert.equal(ledger.balances.get("cus_2"), 1000);

  // Unknown charge refund must throw
  assert.throws(() =>
    processBillingWebhook(ledger, {
      id: "evt_ref_unknown",
      type: "charge.refunded",
      customerId: "cus_2",
      chargeId: "ch_missing",
      amountCents: 500,
    })
  );

  // Non-positive amounts or missing IDs must throw
  assert.throws(() =>
    processBillingWebhook(ledger, {
      id: "",
      type: "invoice.paid",
      customerId: "cus_2",
      chargeId: "ch_2",
      amountCents: 500,
    })
  );
  assert.throws(() =>
    processBillingWebhook(ledger, {
      id: "evt_zero",
      type: "invoice.paid",
      customerId: "cus_2",
      chargeId: "ch_2",
      amountCents: 0,
    })
  );
});
