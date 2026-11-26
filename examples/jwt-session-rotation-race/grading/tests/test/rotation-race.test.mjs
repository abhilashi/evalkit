import test from "node:test";
import assert from "node:assert/strict";
import { createSessionManager } from "../src/sessions.mjs";

test("concurrent tabs rotating the same token within graceWindowMs get the same child token without revocation", () => {
  const auth = createSessionManager({ graceWindowMs: 5000 });
  const t1 = auth.issue("user_a", 10_000);

  // Tab 1 rotates at t=11_000
  const tab1 = auth.rotate(t1.token, 11_000);
  assert.equal(tab1.replayedWithinGrace, false);

  // Tab 2 had stale t1 in memory and rotates 800ms later
  const tab2 = auth.rotate(t1.token, 11_800);
  assert.equal(tab2.token, tab1.token);
  assert.equal(tab2.replayedWithinGrace, true);
  assert.equal(auth.isFamilyRevoked(t1.familyId), false);
  assert.equal(auth.isActive(tab1.token), true);
});

test("reusing a rotated token after graceWindowMs revokes the entire token family including the active head", () => {
  const auth = createSessionManager({ graceWindowMs: 5000 });
  const t1 = auth.issue("user_b", 10_000);
  const t2 = auth.rotate(t1.token, 11_000);

  // Attacker replays t1 after grace window expires (t=17_000)
  assert.throws(() => auth.rotate(t1.token, 17_000));
  assert.equal(auth.isFamilyRevoked(t1.familyId), true);
  assert.equal(auth.isActive(t2.token), false);

  // Even the legitimate head token t2 must now be rejected
  assert.throws(() => auth.rotate(t2.token, 17_500));
});

test("reusing an older ancestor (>1 hop behind head) revokes the family even within graceWindowMs", () => {
  const auth = createSessionManager({ graceWindowMs: 5000 });
  const t1 = auth.issue("user_c", 10_000);
  const t2 = auth.rotate(t1.token, 10_500);
  const t3 = auth.rotate(t2.token, 11_000);

  // Replaying t1 at 11_200 (still within 5s of 10_500, but t2 was already rotated to t3) must revoke family!
  assert.throws(() => auth.rotate(t1.token, 11_200));
  assert.equal(auth.isFamilyRevoked(t1.familyId), true);
  assert.equal(auth.isActive(t3.token), false);
});
