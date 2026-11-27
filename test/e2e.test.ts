import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_PATH = path.join(PROJECT_ROOT, "dist", "cli.js");

function runCli(args: string[], cwd?: string) {
  return spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: cwd ?? PROJECT_ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
}

function runCliAsync(
  args: string[],
  cwd?: string
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: cwd ?? PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => resolve({ status: code, stdout, stderr }));
  });
}

function git(args: string[], cwd: string) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

function createSampleIndieRepo(rootDir: string): { baseCommit: string; fixCommit: string } {
  fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "test"), { recursive: true });

  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify(
      {
        name: "indie-billing-app",
        version: "0.1.0",
        type: "module",
        scripts: { test: "node --test" },
        dependencies: { stripe: "^17.0.0" },
      },
      null,
      2
    )
  );

  // Simulate an accidentally tracked .env with a realistic synthetic secret
  const fakeStripeKey = ["sk", "live", "51AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("_");
  fs.writeFileSync(
    path.join(rootDir, ".env"),
    `STRIPE_SECRET_KEY=${fakeStripeKey}\nPORT=3000\n`
  );

  fs.writeFileSync(
    path.join(rootDir, "src", "store.mjs"),
    `export function createStore() {
  return {
    balances: new Map(),
  };
}
`
  );

  fs.writeFileSync(
    path.join(rootDir, "src", "webhooks.mjs"),
    `export function applyCreditWebhook(store, event) {
  if (event.type !== "invoice.paid") {
    return { applied: false };
  }
  const current = store.balances.get(event.customerId) ?? 0;
  store.balances.set(event.customerId, current + event.amountCents);
  return { applied: true, balance: current + event.amountCents };
}
`
  );

  // Baseline passing regression test
  fs.writeFileSync(
    path.join(rootDir, "test", "health.test.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.mjs";
import { applyCreditWebhook } from "../src/webhooks.mjs";

test("ignores non-invoice events", () => {
  const store = createStore();
  const res = applyCreditWebhook(store, {
    id: "evt_0",
    type: "customer.updated",
    customerId: "cus_1",
    amountCents: 500,
  });
  assert.equal(res.applied, false);
  assert.equal(store.balances.get("cus_1"), undefined);
});
`
  );

  git(["init", "-q"], rootDir);
  git(["config", "user.email", "indie@example.com"], rootDir);
  git(["config", "user.name", "Indie Dev"], rootDir);
  git(["add", "-A"], rootDir);
  git(["commit", "-q", "-m", "Initial indie billing service"], rootDir);
  const baseCommit = git(["rev-parse", "HEAD"], rootDir);

  // Commit 2: Fix duplicate webhook double-crediting bug across 2 files + add test
  fs.writeFileSync(
    path.join(rootDir, "src", "store.mjs"),
    `export function createStore() {
  return {
    balances: new Map(),
    processedEvents: new Set(),
  };
}
`
  );

  fs.writeFileSync(
    path.join(rootDir, "src", "webhooks.mjs"),
    `export function applyCreditWebhook(store, event) {
  if (event.type !== "invoice.paid") {
    return { applied: false };
  }
  if (!event.id || typeof event.amountCents !== "number" || event.amountCents < 0) {
    throw new Error("Invalid invoice.paid webhook payload");
  }
  if (!store.processedEvents) {
    store.processedEvents = new Set();
  }
  if (store.processedEvents.has(event.id)) {
    return {
      applied: false,
      duplicate: true,
      balance: store.balances.get(event.customerId) ?? 0,
    };
  }
  store.processedEvents.add(event.id);
  const current = store.balances.get(event.customerId) ?? 0;
  const next = current + event.amountCents;
  store.balances.set(event.customerId, next);
  return { applied: true, duplicate: false, balance: next };
}
`
  );

  fs.writeFileSync(
    path.join(rootDir, "test", "webhooks.test.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/store.mjs";
import { applyCreditWebhook } from "../src/webhooks.mjs";

test("prevents duplicate invoice.paid webhooks from double-crediting balance", () => {
  const store = createStore();
  const event = {
    id: "evt_duplicate_123",
    type: "invoice.paid",
    customerId: "cus_42",
    amountCents: 2500,
  };

  const first = applyCreditWebhook(store, event);
  assert.equal(first.applied, true);
  assert.equal(first.balance, 2500);

  const replay = applyCreditWebhook(store, event);
  assert.equal(replay.applied, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.balance, 2500);
  assert.equal(store.balances.get("cus_42"), 2500);
});

test("rejects negative amounts or missing event IDs", () => {
  const store = createStore();
  assert.throws(() =>
    applyCreditWebhook(store, {
      id: "",
      type: "invoice.paid",
      customerId: "cus_42",
      amountCents: 100,
    })
  );
  assert.throws(() =>
    applyCreditWebhook(store, {
      id: "evt_neg",
      type: "invoice.paid",
      customerId: "cus_42",
      amountCents: -10,
    })
  );
});
`
  );

  git(["add", "-A"], rootDir);
  git(["commit", "-q", "-m", "fix: prevent duplicate Stripe webhook race from double-crediting"], rootDir);
  const fixCommit = git(["rev-parse", "HEAD"], rootDir);

  return { baseCommit, fixCommit };
}

test("full evalkit lifecycle: mine -> init -> audit -> verify -> bench -> pack -> leaderboard -> submit -> install-skill", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evalkit-e2e-"));
  const repoDir = path.join(tmpRoot, "indie-billing-app");
  const bundleDir = path.join(tmpRoot, "evals", "webhook-idempotency");
  const skillInstallDir = path.join(tmpRoot, "installed-skill");

  try {
    const { fixCommit } = createSampleIndieRepo(repoDir);

    // 1. MINE
    const mineRes = runCli(["mine", "--repo", repoDir, "--json"]);
    assert.equal(mineRes.status, 0, mineRes.stderr);
    const mineData = JSON.parse(mineRes.stdout);
    assert.equal(mineData.candidates.length, 1);
    assert.equal(mineData.candidates[0].hash, fixCommit);
    assert.equal(mineData.candidates[0].touchesTests, true);

    // 2. INIT
    const initRes = runCli([
      "init",
      "--repo",
      repoDir,
      "--from",
      "HEAD~1",
      "--to",
      "HEAD",
      "--out",
      bundleDir,
      "--id",
      "webhook-idempotency",
    ]);
    assert.equal(initRes.status, 0, initRes.stderr);

    // Verify .env was stripped and .env.example was created without the secret
    assert.equal(fs.existsSync(path.join(bundleDir, "environment", "repo", ".env")), false);
    const envExample = fs.readFileSync(
      path.join(bundleDir, "environment", "repo", ".env.example"),
      "utf8"
    );
    assert.match(envExample, /STRIPE_SECRET_KEY=REPLACE_ME/);
    assert.doesNotMatch(envExample, /sk_live_/);

    // Verify git history was squashed to 1 commit and fix_commit does not exist inside snapshot
    const snapshotRepo = path.join(bundleDir, "environment", "repo");
    const commitCount = git(["rev-list", "--count", "--all"], snapshotRepo);
    assert.equal(commitCount, "1");

    // Verify test file was extracted into grading/tests/
    assert.equal(
      fs.existsSync(path.join(bundleDir, "grading", "tests", "test", "webhooks.test.mjs")),
      true
    );

    // 3. AUDIT should fail initially due to unfilled prompt.md placeholders
    const initialAudit = runCli(["audit", bundleDir, "--json"]);
    assert.equal(initialAudit.status, 1);
    const initialAuditJson = JSON.parse(initialAudit.stdout);
    assert.equal(initialAuditJson.passed, false);
    assert.ok(initialAuditJson.issues.some((i: { category: string }) => i.category === "prompt-leak"));

    // Inject a leaked synthetic secret temporarily and confirm audit catches it
    const secretFile = path.join(bundleDir, "environment", "repo", "src", "leak.mjs");
    const fakeOpenAiKey = ["sk", "proj", "99887766554433221100aabbccddeeff112233"].join("-");
    fs.writeFileSync(secretFile, `export const apiKey = "${fakeOpenAiKey}";\n`);
    const leakAudit = runCli(["audit", bundleDir, "--json"]);
    assert.equal(leakAudit.status, 1);
    const leakAuditJson = JSON.parse(leakAudit.stdout);
    assert.ok(leakAuditJson.issues.some((i: { category: string }) => i.category === "secret"));
    fs.rmSync(secretFile);

    // Author clean, leak-free prompt.md and private/debrief.md
    fs.writeFileSync(
      path.join(bundleDir, "prompt.md"),
      `# Task: Enforce Idempotent Credit Webhook Processing

## Problem Statement

When payment providers retry an \`invoice.paid\` webhook delivery with the same event \`id\`, our billing handler credits the customer's balance multiple times instead of treating duplicate deliveries idempotently.

## Expected Behavior

- Processing an \`invoice.paid\` event with a valid non-empty \`id\` and non-negative numeric \`amountCents\` must credit the customer once and return \`{ applied: true, duplicate: false, balance }\`.
- Re-delivering an \`invoice.paid\` event with an already processed \`id\` must NOT change the customer's balance and must return \`{ applied: false, duplicate: true, balance }\` with the current balance.
- Missing/empty \`id\` or negative/non-numeric \`amountCents\` on \`invoice.paid\` events must throw an error.
- Non-\`invoice.paid\` events must continue to be ignored and return \`{ applied: false }\`.

## Constraints

- Do not break existing tests.
- All tests run strictly offline without external API calls.
`
    );

    fs.writeFileSync(
      path.join(bundleDir, "private", "debrief.md"),
      `# Frontier Failure Debrief

## 1. Root Cause & Non-Obvious Trap
Webhook retries happened concurrently and sequentially without tracking processed event IDs on the store instance.

## 2. Naive Fixes That Fail
Deduplicating by customerId + amount breaks legitimate repeat invoices of the same amount.

## 3. Where AI Coding Agents Got Stuck
Agents often added a module-level global Set instead of storing processed IDs per store instance, breaking test isolation.
`
    );

    // Re-run audit in strict mode — must pass cleanly!
    const cleanAudit = runCli(["audit", bundleDir, "--strict", "--json"]);
    assert.equal(cleanAudit.status, 0, cleanAudit.stdout);
    const cleanAuditJson = JSON.parse(cleanAudit.stdout);
    assert.equal(cleanAuditJson.passed, true);
    assert.equal(cleanAuditJson.errorCount, 0);
    assert.equal(cleanAuditJson.warningCount, 0);

    // 4. VERIFY in local sandbox mode (3 consecutive gold runs)
    const verifyRes = runCli(["verify", bundleDir, "--mode", "local", "--runs", "3", "--json"]);
    assert.equal(verifyRes.status, 0, `${verifyRes.stdout}\n${verifyRes.stderr}`);
    const verifyJson = JSON.parse(verifyRes.stdout);
    assert.equal(verifyJson.passed, true);
    assert.equal(verifyJson.base_check.failed_as_expected, true);
    assert.equal(verifyJson.gold_checks.runs_passed, 3);
    assert.equal(verifyJson.gold_checks.all_passed, true);

    // 5. BENCH across noop, oracle, and a custom --cmd adapter (2 trials each)
    const benchRes = runCli([
      "bench",
      bundleDir,
      "--agents",
      "noop,oracle",
      "--cmd",
      "naive-bot=printf '\\n// naive attempt\\n' >> src/webhooks.mjs",
      "--trials",
      "2",
      "--grade-mode",
      "local",
      "--json",
    ]);
    assert.equal(benchRes.status, 0, `${benchRes.stdout}\n${benchRes.stderr}`);
    const benchJson = JSON.parse(benchRes.stdout);
    assert.equal(benchJson.trials_per_agent, 2);
    assert.equal(benchJson.agents.length, 3);
    const noopSummary = benchJson.agents.find((a: { agent: string }) => a.agent === "noop");
    const oracleSummary = benchJson.agents.find((a: { agent: string }) => a.agent === "oracle");
    const naiveSummary = benchJson.agents.find((a: { agent: string }) => a.agent === "naive-bot");
    assert.equal(noopSummary.passed, 0);
    assert.equal(noopSummary.pass_rate, 0);
    assert.equal(oracleSummary.passed, 2);
    assert.equal(oracleSummary.pass_rate, 1);
    assert.equal(naiveSummary.passed, 0);
    assert.ok(naiveSummary.avg_insertions >= 1);

    // 5.5. ESTIMATE before packing — naive-bot failed 0/2 under local sandbox
    const estRes = runCli(["estimate", bundleDir, "--json"]);
    assert.equal(estRes.status, 0, `${estRes.stdout}\n${estRes.stderr}`);
    const estJson = JSON.parse(estRes.stdout);
    assert.equal(estJson.valuation.frontier_agents_tested, 1);
    assert.equal(estJson.valuation.frontier_pass_rate, 0);
    assert.equal(estJson.valuation.tier, "B");
    assert.ok(estJson.valuation.indicative_range_usd.min >= 100);

    // 6. PACK without --attest-ip must be blocked
    const packNoAttest = runCli(["pack", bundleDir, "--json"]);
    assert.equal(packNoAttest.status, 1);
    assert.equal(JSON.parse(packNoAttest.stdout).reason, "missing_ip_attestation");

    // 7. PACK with --attest-ip must succeed without breaking verify checksum and embed benchmark scores
    const packRes = runCli([
      "pack",
      bundleDir,
      "--attest-ip",
      "--license",
      "private-vault",
      "--json",
    ]);
    assert.equal(packRes.status, 0, `${packRes.stdout}\n${packRes.stderr}`);
    const packJson = JSON.parse(packRes.stdout);
    assert.equal(packJson.packed, true);
    assert.equal(fs.existsSync(packJson.archivePath), true);
    assert.equal(fs.existsSync(packJson.cardPath), true);
    assert.equal(packJson.card.verification.verified, true);
    assert.equal(packJson.card.verification.gold_pass_rate, "3/3");
    assert.equal(packJson.card.ownership.author_attestation, true);
    assert.ok(packJson.card.benchmark);
    assert.equal(packJson.card.benchmark.results.length, 3);
    assert.ok(packJson.card.valuation);
    assert.equal(packJson.card.valuation.tier, "B");
    assert.equal(packJson.card.valuation.frontier_agents_tested, 1);
    assert.equal(
      packJson.card.benchmark.results.find((r: { agent: string }) => r.agent === "oracle").passed,
      2
    );

    // 8. PUBLISH strictly outputs blind trace with Agent Alias identity (zero code, prompts, diffs, or raw stdout)
    const traceOutPath = path.join(tmpRoot, "trace-blind.json");
    const pubBlind = runCli([
      "publish",
      bundleDir,
      "--agent",
      "neon-warden",
      "--rig",
      "claude-code · opus",
      "--out",
      traceOutPath,
      "--dry-run",
      "--json",
    ]);
    assert.equal(pubBlind.status, 0, `${pubBlind.stdout}\n${pubBlind.stderr}`);
    const blindEntry = JSON.parse(fs.readFileSync(traceOutPath, "utf8"));
    assert.equal(blindEntry.visibility, "blind");
    assert.equal(blindEntry.agent_alias, "neon-warden");
    assert.equal(blindEntry.agent_rig, "claude-code · opus");
    assert.equal(blindEntry.operator, undefined);
    assert.equal(blindEntry.prompt_markdown, undefined);
    assert.equal(blindEntry.debrief_summary, undefined);
    assert.equal(blindEntry.agents.length, 3);
    assert.equal(blindEntry.agents[0].trials_detail[0].patch_preview, undefined);
    assert.equal(blindEntry.agents[0].trials_detail[0].solve_output_tail, undefined);
    assert.equal(blindEntry.agents[0].trials_detail[0].grade_output_tail, undefined);
    assert.ok(blindEntry.agents[0].trials_detail[0].failure_class);

    // 8.5. BOUNTIES local feed check
    const bountiesRes = runCli([
      "bounties",
      "--source",
      path.join(PROJECT_ROOT, "bounties.json"),
      "--json",
    ]);
    assert.equal(bountiesRes.status, 0, `${bountiesRes.stdout}\n${bountiesRes.stderr}`);
    const bountiesJson = JSON.parse(bountiesRes.stdout);
    assert.ok(Array.isArray(bountiesJson.bounties) && bountiesJson.bounties.length >= 1);

    // 9. LEADERBOARD generation from packed bundle (strictly blind)
    const leaderboardOut = path.join(tmpRoot, "site");
    const lbRes = runCli([
      "leaderboard",
      path.dirname(bundleDir),
      "--out",
      leaderboardOut,
      "--json",
    ]);
    assert.equal(lbRes.status, 0, `${lbRes.stdout}\n${lbRes.stderr}`);
    const lbJson = JSON.parse(lbRes.stdout);
    assert.equal(lbJson.summary.total_tasks, 1);
    assert.equal(lbJson.summary.verified_tasks, 1);
    const boardData = JSON.parse(fs.readFileSync(path.join(leaderboardOut, "data.json"), "utf8"));
    assert.equal(boardData.entries[0].visibility, "blind");
    assert.equal(boardData.entries[0].prompt_markdown, undefined);
    assert.equal(fs.existsSync(path.join(leaderboardOut, "index.html")), true);
    assert.equal(fs.existsSync(path.join(leaderboardOut, "llms.txt")), true);
    assert.equal(fs.existsSync(path.join(leaderboardOut, "SKILL.md")), true);
    assert.equal(fs.existsSync(path.join(leaderboardOut, "bounties.json")), true);

    // 10. SUBMIT dry-run + live local HTTP intake test
    const drySubmit = runCli(["submit", bundleDir, "--dry-run", "--json"]);
    assert.equal(drySubmit.status, 0, `${drySubmit.stdout}\n${drySubmit.stderr}`);
    const dryJson = JSON.parse(drySubmit.stdout);
    assert.equal(dryJson.dry_run, true);
    assert.equal(dryJson.includes_source_code, false);

    let receivedCardId = "";
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          card?: { id?: string };
        };
        receivedCardId = parsed.card?.id ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ accepted: true, task_id: receivedCardId }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      const endpoint = `http://127.0.0.1:${addr.port}/submit`;
      const submitRes = await runCliAsync(["submit", bundleDir, "--endpoint", endpoint, "--json"]);
      assert.equal(submitRes.status, 0, `${submitRes.stdout}\n${submitRes.stderr}`);
      const submitJson = JSON.parse(submitRes.stdout);
      assert.equal(submitJson.submitted, true);
      assert.equal(submitJson.mode, "https-blind-card");
      assert.equal(receivedCardId, "webhook-idempotency");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // 10. INSTALL-SKILL to a custom directory
    const skillRes = runCli(["install-skill", "--target", skillInstallDir]);
    assert.equal(skillRes.status, 0, skillRes.stderr);
    assert.equal(fs.existsSync(path.join(skillInstallDir, "SKILL.md")), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
