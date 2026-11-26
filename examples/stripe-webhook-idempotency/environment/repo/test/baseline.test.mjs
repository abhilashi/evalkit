import test from "node:test";
import assert from "node:assert/strict";
import { createLedger } from "../src/ledger.mjs";
import { processBillingWebhook } from "../src/webhooks.mjs";

test("ignores unrelated webhook event types", () => {
  const ledger = createLedger();
  const res = processBillingWebhook(ledger, {
    id: "evt_ignore_1",
    type: "customer.updated",
    customerId: "cus_1",
    amountCents: 1000,
  });
  assert.equal(res.applied, false);
  assert.equal(ledger.balances.get("cus_1"), undefined);
});
