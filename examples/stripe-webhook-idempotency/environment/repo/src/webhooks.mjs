export function processBillingWebhook(ledger, event) {
  if (event.type === "invoice.paid") {
    const cur = ledger.balances.get(event.customerId) ?? 0;
    const next = cur + event.amountCents;
    ledger.balances.set(event.customerId, next);
    return { applied: true, duplicate: false, balance: next };
  }
  if (event.type === "charge.refunded") {
    const cur = ledger.balances.get(event.customerId) ?? 0;
    const next = cur - event.amountCents;
    ledger.balances.set(event.customerId, next);
    return { applied: true, duplicate: false, balance: next };
  }
  return { applied: false, duplicate: false };
}
