import test from "node:test";
import assert from "node:assert/strict";
import { estimateBundleValue } from "../dist/valuation/estimate.js";
import type { BenchReport, EvalConfig, VerifyReport } from "../dist/types.js";

function makeConfig(overrides: Partial<EvalConfig> = {}): EvalConfig {
  return {
    spec_version: "0.1",
    id: "test-task",
    title: "Test task",
    stack: ["typescript", "nextjs", "postgres"],
    category: "bugfix",
    source: {
      base_commit: "aaa",
      fix_commit: "bbb",
      captured_at: "2026-11-27T00:00:00.000Z",
      files_changed: 4,
      insertions: 65,
      deletions: 18,
    },
    timeouts: { solve_sec: 1200, verify_sec: 180 },
    grading: { type: "deterministic", network_access: false, flakiness_runs: 3 },
    ownership: { author_attestation: true, license: "private-vault" },
    ...overrides,
  };
}

function makeVerify(sandbox: "docker-offline" | "local" = "docker-offline", passed = true): VerifyReport {
  return {
    spec_version: "0.1",
    id: "test-task",
    verified_at: "2026-11-27T00:00:00.000Z",
    sandbox,
    network_isolated: sandbox === "docker-offline",
    bundle_sha256: "a".repeat(64),
    passed,
    base_check: { failed_as_expected: true, exit_code: 1, duration_ms: 100, output_tail: "" },
    gold_checks: { runs_requested: 3, runs_passed: passed ? 3 : 0, all_passed: passed, results: [] },
  };
}

function makeBench(agents: Array<{ agent: string; passed: number; trials: number }>): BenchReport {
  return {
    spec_version: "0.1",
    id: "test-task",
    benchmarked_at: "2026-11-27T00:00:00.000Z",
    bundle_sha256: "a".repeat(64),
    grade_sandbox: "docker-offline",
    network_isolated_grading: true,
    trials_per_agent: 3,
    agents: agents.map((a) => ({
      agent: a.agent,
      passed: a.passed,
      trials: a.trials,
      pass_rate: a.passed / a.trials,
      avg_solve_ms: 1000,
      avg_insertions: 10,
      avg_deletions: 2,
      results: [],
    })),
  };
}

test("returns NOT_ELIGIBLE ($0) when bundle is unverified", () => {
  const val = estimateBundleValue({
    config: makeConfig(),
    verifyReport: null,
    verifyMatchesChecksum: false,
    benchReport: null,
    benchMatchesChecksum: false,
    hasDetailedDebrief: true,
  });
  assert.equal(val.tier, "NOT_ELIGIBLE");
  assert.deepEqual(val.indicative_range_usd, { min: 0, max: 0 });
});

test("returns UNBENCHMARKED when only noop/oracle baselines ran", () => {
  const val = estimateBundleValue({
    config: makeConfig(),
    verifyReport: makeVerify("docker-offline"),
    verifyMatchesChecksum: true,
    benchReport: makeBench([
      { agent: "noop", passed: 0, trials: 3 },
      { agent: "oracle", passed: 3, trials: 3 },
    ]),
    benchMatchesChecksum: true,
    hasDetailedDebrief: true,
  });
  assert.equal(val.tier, "UNBENCHMARKED");
  assert.equal(val.indicative_range_usd, null);
  assert.equal(val.frontier_agents_tested, 0);
});

test("returns NOT_ELIGIBLE ($0) when frontier models pass >= 80%", () => {
  const val = estimateBundleValue({
    config: makeConfig(),
    verifyReport: makeVerify("docker-offline"),
    verifyMatchesChecksum: true,
    benchReport: makeBench([
      { agent: "claude", passed: 3, trials: 3 },
      { agent: "codex", passed: 2, trials: 3 },
    ]),
    benchMatchesChecksum: true,
    hasDetailedDebrief: true,
  });
  assert.equal(val.tier, "NOT_ELIGIBLE");
  assert.deepEqual(val.indicative_range_usd, { min: 0, max: 0 });
});

test("returns Tier S ($1,200-$3,000) for Docker offline, private-vault, detailed debrief, 0% across 2+ frontier models", () => {
  const val = estimateBundleValue({
    config: makeConfig(),
    verifyReport: makeVerify("docker-offline"),
    verifyMatchesChecksum: true,
    benchReport: makeBench([
      { agent: "claude", passed: 0, trials: 3 },
      { agent: "codex", passed: 0, trials: 3 },
    ]),
    benchMatchesChecksum: true,
    hasDetailedDebrief: true,
  });
  assert.equal(val.tier, "S");
  assert.equal(val.score, 100);
  assert.deepEqual(val.indicative_range_usd, { min: 1200, max: 3000 });
});

test("returns Tier A ($450-$1,200) for Docker offline with <20% frontier pass rate", () => {
  const val = estimateBundleValue({
    config: makeConfig(),
    verifyReport: makeVerify("docker-offline"),
    verifyMatchesChecksum: true,
    benchReport: makeBench([
      { agent: "claude", passed: 0, trials: 3 },
      { agent: "codex", passed: 1, trials: 3 },
    ]),
    benchMatchesChecksum: true,
    hasDetailedDebrief: true,
  });
  assert.equal(val.tier, "A");
  assert.deepEqual(val.indicative_range_usd, { min: 450, max: 1200 });
});

test("caps local-sandbox verified tasks below Tier A and provides Docker upgrade hint", () => {
  const val = estimateBundleValue({
    config: makeConfig(),
    verifyReport: makeVerify("local"),
    verifyMatchesChecksum: true,
    benchReport: makeBench([
      { agent: "claude", passed: 0, trials: 3 },
      { agent: "codex", passed: 0, trials: 3 },
    ]),
    benchMatchesChecksum: true,
    hasDetailedDebrief: true,
  });
  assert.equal(val.tier, "B");
  assert.deepEqual(val.indicative_range_usd, { min: 150, max: 450 });
  assert.ok(val.upgrade_hints.some((h) => h.includes("Docker")));
});

test("returns Tier C ($50-$150) for moderate 50% frontier pass rate", () => {
  const val = estimateBundleValue({
    config: makeConfig(),
    verifyReport: makeVerify("local"),
    verifyMatchesChecksum: true,
    benchReport: makeBench([{ agent: "claude", passed: 2, trials: 4 }]),
    benchMatchesChecksum: true,
    hasDetailedDebrief: false,
  });
  assert.equal(val.tier, "C");
  assert.deepEqual(val.indicative_range_usd, { min: 50, max: 150 });
});
