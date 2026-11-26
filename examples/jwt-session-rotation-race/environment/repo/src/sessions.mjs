import crypto from "node:crypto";

export function createSessionManager({ graceWindowMs = 5000 } = {}) {
  const tokens = new Map();

  function issue(userId, now = Date.now()) {
    const familyId = crypto.randomUUID();
    const token = crypto.randomUUID();
    tokens.set(token, {
      token,
      userId,
      familyId,
      used: false,
      createdAt: now,
    });
    return { token, familyId, userId };
  }

  function rotate(refreshToken, now = Date.now()) {
    const record = tokens.get(refreshToken);
    if (!record) {
      throw new Error("Invalid refresh token");
    }
    if (record.used) {
      throw new Error("Refresh token already used");
    }
    record.used = true;
    const nextToken = crypto.randomUUID();
    tokens.set(nextToken, {
      token: nextToken,
      userId: record.userId,
      familyId: record.familyId,
      used: false,
      createdAt: now,
    });
    return { token: nextToken, familyId: record.familyId, userId: record.userId };
  }

  function isActive(refreshToken) {
    const record = tokens.get(refreshToken);
    return Boolean(record && !record.used);
  }

  return { issue, rotate, isActive, graceWindowMs };
}
