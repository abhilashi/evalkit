import test from "node:test";
import assert from "node:assert/strict";
import { createSessionManager } from "../src/sessions.mjs";

test("issues and rotates a valid refresh token", () => {
  const auth = createSessionManager();
  const s1 = auth.issue("user_1", 1000);
  assert.equal(auth.isActive(s1.token), true);

  const s2 = auth.rotate(s1.token, 2000);
  assert.notEqual(s2.token, s1.token);
  assert.equal(s2.familyId, s1.familyId);
  assert.equal(auth.isActive(s2.token), true);
  assert.equal(auth.isActive(s1.token), false);
});
