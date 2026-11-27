import fs from "node:fs";
import path from "node:path";
import type {
  BenchReport,
  BundleValuation,
  EvalConfig,
  ValuationBreakdownItem,
  ValuationTier,
  VerifyReport,
} from "../types.js";

const BASELINE_AGENTS = new Set(["noop", "oracle"]);

const HIGH_DEMAND_STACKS = new Set([
  "typescript",
  "nextjs",
  "react",
  "playwright",
  "postgres",
  "rust",
  "go",
  "stripe",
  "billing",
  "auth",
  "security",
  "docker",
  "kubernetes",
  "terraform",
  "api",
  "rate-limiting",
  "supabase",
]);

const PLACEHOLDER_RE = /\b(TODO:|TBD)\b|<!--\s*EVALKIT:/i;

export const VALUATION_DISCLAIMER =
  "Indicative market estimate based on RL-environment & SWE-eval benchmarks; not a guaranteed payout. Actual payouts depend on buyer match and server-side QA.";

export interface EstimateInput {
  config: EvalConfig;
  verifyReport: VerifyReport | null;
  verifyMatchesChecksum: boolean;
  benchReport: BenchReport | null;
  benchMatchesChecksum: boolean;
  hasDetailedDebrief: boolean;
}

export function checkHasDetailedDebrief(bundleDir: string): boolean {
  const debriefPath = path.join(bundleDir, "private", "debrief.md");
  if (!fs.existsSync(debriefPath)) return false;
  const text = fs.readFileSync(debriefPath, "utf8");
  if (PLACEHOLDER_RE.test(text)) return false;
  const words = text
    .replace(/[#>*`_\-\n]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return words.length >= 40;
}

export function estimateBundleValue(input: EstimateInput): BundleValuation {
  const breakdown: ValuationBreakdownItem[] = [];
  const upgradeHints: string[] = [];

  const isVerified =
    input.verifyReport !== null &&
    input.verifyReport.passed &&
    input.verifyMatchesChecksum;
  const isDockerOffline =
    isVerified && input.verifyReport!.sandbox === "docker-offline";

  // 1. Verification & Isolation (max 25 pts)
  let verifyPts = 0;
  let verifyNote = "Not verified yet";
  if (isDockerOffline) {
    const goldRuns = input.verifyReport!.gold_checks.runs_passed;
    verifyPts = goldRuns >= 3 ? 25 : 20;
    verifyNote = `Docker --network=none verified (${goldRuns}/${input.verifyReport!.gold_checks.runs_requested})`;
    if (goldRuns < 3) {
      upgradeHints.push("Re-run `evalkit verify --runs 3` for full anti-flakiness credit (+5 pts)");
    }
  } else if (isVerified) {
    verifyPts = 12;
    verifyNote = `Local sandbox verified (${input.verifyReport!.gold_checks.runs_passed}/${input.verifyReport!.gold_checks.runs_requested})`;
    upgradeHints.push(
      "Run `evalkit verify` with Docker (`--network=none`) for +13 pts & Tier A/S eligibility"
    );
  } else {
    upgradeHints.push("Run `evalkit verify` so base fails and gold.patch passes 3/3");
  }
  breakdown.push({
    factor: "Offline Verification",
    points: verifyPts,
    max_points: 25,
    note: verifyNote,
  });

  // 2. Frontier Difficulty (max 35 pts; strictly excludes noop/oracle baselines)
  const validBench =
    input.benchReport !== null && input.benchMatchesChecksum
      ? input.benchReport
      : null;
  const frontierAgents = (validBench?.agents ?? []).filter(
    (a) => !BASELINE_AGENTS.has(a.agent.toLowerCase()) && a.trials > 0
  );

  let frontierPts = 0;
  let frontierNote = "No frontier agents benchmarked yet (only baselines)";
  let frontierPassRate: number | null = null;
  const totalFrontierTrials = frontierAgents.reduce((acc, a) => acc + a.trials, 0);
  const totalFrontierPassed = frontierAgents.reduce((acc, a) => acc + a.passed, 0);

  if (frontierAgents.length > 0 && totalFrontierTrials > 0) {
    frontierPassRate = Number((totalFrontierPassed / totalFrontierTrials).toFixed(3));
    const pct = Math.round(frontierPassRate * 100);

    if (frontierPassRate >= 0.8) {
      frontierPts = 0;
      frontierNote = `Too easy: frontier models passed ${totalFrontierPassed}/${totalFrontierTrials} (${pct}%)`;
    } else if (
      frontierPassRate === 0 &&
      (frontierAgents.length >= 2 || totalFrontierTrials >= 3)
    ) {
      frontierPts = 35;
      frontierNote = `All tested frontier runs failed (0/${totalFrontierTrials} across ${frontierAgents.length} agent(s))`;
    } else if (frontierPassRate === 0) {
      frontierPts = 28;
      frontierNote = `0/${totalFrontierTrials} passed on 1 agent — run 2+ models or 3 trials for max credit`;
      upgradeHints.push(
        "Benchmark at least 2 frontier agents (e.g. `--agents claude,codex,gemini --trials 3`) for +7 pts & Tier S eligibility"
      );
    } else if (frontierPassRate < 0.2) {
      frontierPts = 26;
      frontierNote = `Frontier-hard: ${totalFrontierPassed}/${totalFrontierTrials} (${pct}% pass rate)`;
    } else if (frontierPassRate < 0.4) {
      frontierPts = 18;
      frontierNote = `Challenging: ${totalFrontierPassed}/${totalFrontierTrials} (${pct}% pass rate)`;
    } else {
      frontierPts = 10;
      frontierNote = `Moderate: ${totalFrontierPassed}/${totalFrontierTrials} (${pct}% pass rate)`;
    }
  } else {
    upgradeHints.push(
      "Run `evalkit bench --agents claude,codex,gemini --trials 3` locally to unlock an indicative USD valuation"
    );
  }
  breakdown.push({
    factor: "Frontier Difficulty",
    points: frontierPts,
    max_points: 35,
    note: frontierNote,
  });

  // 3. Multi-File Complexity (max 15 pts)
  const filesChanged = input.config.source?.files_changed ?? 0;
  const churn =
    (input.config.source?.insertions ?? 0) + (input.config.source?.deletions ?? 0);
  let complexityPts = 0;
  let complexityNote = `${filesChanged} file(s), ${churn} changed lines`;
  if (filesChanged >= 3 && churn >= 40) {
    complexityPts = 15;
    complexityNote = `Multi-file engineering diff (${filesChanged} files, ${churn} LOC)`;
  } else if (filesChanged >= 2 && churn >= 20) {
    complexityPts = 10;
    complexityNote = `Multi-file diff (${filesChanged} files, ${churn} LOC)`;
  } else if (churn >= 20) {
    complexityPts = 5;
    complexityNote = `Single-file logic diff (${churn} LOC)`;
  } else {
    complexityPts = 2;
    complexityNote = `Small diff (${filesChanged} file(s), ${churn} LOC)`;
  }
  breakdown.push({
    factor: "Task Complexity",
    points: complexityPts,
    max_points: 15,
    note: complexityNote,
  });

  // 4. High-Demand Stack Bonus (max 10 pts)
  const matchedTags = (input.config.stack ?? []).filter((t) =>
    HIGH_DEMAND_STACKS.has(t.toLowerCase())
  );
  const stackPts = Math.min(10, matchedTags.length * 5);
  breakdown.push({
    factor: "Stack Demand",
    points: stackPts,
    max_points: 10,
    note:
      matchedTags.length > 0
        ? `High-demand stack tags: ${matchedTags.join(", ")}`
        : `General stack (${(input.config.stack ?? []).join(", ") || "untagged"})`,
  });

  // 5. Frontier Debrief (max 10 pts)
  const debriefPts = input.hasDetailedDebrief ? 10 : 0;
  if (!input.hasDetailedDebrief) {
    upgradeHints.push("Complete `private/debrief.md` with root-cause & agent-trap notes (+10 pts)");
  }
  breakdown.push({
    factor: "Author Debrief",
    points: debriefPts,
    max_points: 10,
    note: input.hasDetailedDebrief
      ? "Detailed root-cause & failure-mode debrief present"
      : "Missing or incomplete private/debrief.md",
  });

  // 6. Exclusivity / License (max 5 pts)
  const isPrivateVault = input.config.ownership?.license === "private-vault";
  const licensePts = isPrivateVault ? 5 : 0;
  if (!isPrivateVault) {
    upgradeHints.push(
      "Use `--license private-vault` for exclusive uncontaminated pricing (+5 pts)"
    );
  }
  breakdown.push({
    factor: "Vault Exclusivity",
    points: licensePts,
    max_points: 5,
    note: isPrivateVault
      ? "Private held-out license (uncontaminated)"
      : `Public OSS license (${input.config.ownership?.license ?? "unset"})`,
  });

  const totalScore = breakdown.reduce((acc, item) => acc + item.points, 0);

  // Determine Tier & Indicative USD Range
  let tier: ValuationTier;
  let rangeUsd: { min: number; max: number } | null;

  if (!isVerified) {
    tier = "NOT_ELIGIBLE";
    rangeUsd = { min: 0, max: 0 };
  } else if (frontierAgents.length === 0 || frontierPassRate === null) {
    tier = "UNBENCHMARKED";
    rangeUsd = null;
  } else if (frontierPassRate >= 0.8) {
    tier = "NOT_ELIGIBLE";
    rangeUsd = { min: 0, max: 0 };
  } else if (
    totalScore >= 85 &&
    isDockerOffline &&
    isPrivateVault &&
    frontierPassRate === 0 &&
    (frontierAgents.length >= 2 || totalFrontierTrials >= 3)
  ) {
    tier = "S";
    rangeUsd = { min: 1200, max: 3000 };
  } else if (totalScore >= 70 && isDockerOffline && frontierPassRate < 0.2) {
    tier = "A";
    rangeUsd = isPrivateVault ? { min: 450, max: 1200 } : { min: 250, max: 650 };
  } else if (totalScore >= 50 && frontierPassRate < 0.4) {
    tier = "B";
    rangeUsd = isPrivateVault ? { min: 150, max: 450 } : { min: 100, max: 250 };
  } else {
    tier = "C";
    rangeUsd = { min: 50, max: 150 };
  }

  return {
    tier,
    score: totalScore,
    max_score: 100,
    indicative_range_usd: rangeUsd,
    frontier_agents_tested: frontierAgents.length,
    frontier_pass_rate: frontierPassRate,
    breakdown,
    upgrade_hints: upgradeHints,
    disclaimer: VALUATION_DISCLAIMER,
  };
}

export function formatRangeUsd(valuation: BundleValuation): string {
  if (valuation.tier === "UNBENCHMARKED" || valuation.indicative_range_usd === null) {
    return "Run frontier bench to estimate";
  }
  const { min, max } = valuation.indicative_range_usd;
  if (min === 0 && max === 0) return "$0 (not eligible)";
  return `$${min.toLocaleString("en-US")} – $${max.toLocaleString("en-US")} (indicative)`;
}
