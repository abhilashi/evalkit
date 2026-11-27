import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { BenchReport, BundleValuation, EvalConfig, VerifyReport } from "../types.js";
import { computeBundleSha256 } from "../utils/git.js";
import {
  checkHasDetailedDebrief,
  estimateBundleValue,
  formatRangeUsd,
} from "../valuation/estimate.js";
import { c, printHeader, printInfo, printWarn } from "../utils/format.js";

export interface EstimateCommandOptions {
  bundleDir: string;
  json: boolean;
}

export function evaluateBundleFromDisk(bundleDir: string): {
  config: EvalConfig;
  bundleSha: string;
  valuation: BundleValuation;
} {
  const absDir = path.resolve(bundleDir);
  const evalYamlPath = path.join(absDir, "eval.yaml");
  if (!fs.existsSync(evalYamlPath)) {
    throw new Error(`Missing eval.yaml in ${absDir}`);
  }

  const config = YAML.parse(fs.readFileSync(evalYamlPath, "utf8")) as EvalConfig;
  const bundleSha = computeBundleSha256(absDir);

  let verifyReport: VerifyReport | null = null;
  const verifyPath = path.join(absDir, "private", "verify-report.json");
  if (fs.existsSync(verifyPath)) {
    try {
      verifyReport = JSON.parse(fs.readFileSync(verifyPath, "utf8")) as VerifyReport;
    } catch {
      verifyReport = null;
    }
  }

  let benchReport: BenchReport | null = null;
  const benchPath = path.join(absDir, "private", "bench-report.json");
  if (fs.existsSync(benchPath)) {
    try {
      benchReport = JSON.parse(fs.readFileSync(benchPath, "utf8")) as BenchReport;
    } catch {
      benchReport = null;
    }
  }

  const valuation = estimateBundleValue({
    config,
    verifyReport,
    verifyMatchesChecksum: Boolean(verifyReport && verifyReport.bundle_sha256 === bundleSha),
    benchReport,
    benchMatchesChecksum: Boolean(benchReport && benchReport.bundle_sha256 === bundleSha),
    hasDetailedDebrief: checkHasDetailedDebrief(absDir),
  });

  return { config, bundleSha, valuation };
}

function pad(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function colorTier(tier: BundleValuation["tier"]): string {
  if (tier === "S" || tier === "A") return c.green(`TIER ${tier}`);
  if (tier === "B" || tier === "C") return c.cyan(`TIER ${tier}`);
  if (tier === "UNBENCHMARKED") return c.yellow("UNBENCHMARKED");
  return c.red("NOT ELIGIBLE");
}

export function printValuationSummary(id: string, valuation: BundleValuation): void {
  printHeader(`Valuation estimate — ${id}`);
  const filled = Math.round((valuation.score / valuation.max_score) * 20);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);

  console.log(`  Tier:         ${c.bold(colorTier(valuation.tier))}`);
  console.log(`  Signal Score: ${c.bold(`${valuation.score}/${valuation.max_score}`)}  [${bar}]`);
  console.log(`  Est. Value:   ${c.bold(formatRangeUsd(valuation))}`);
  console.log("");

  console.log(c.bold(`  ${pad("Factor", 22)}${pad("Points", 10)}Details`));
  console.log(c.dim("  " + "─".repeat(68)));
  for (const item of valuation.breakdown) {
    const pts = `${item.points}/${item.max_points}`;
    console.log(`  ${pad(item.factor, 22)}${pad(pts, 10)}${item.note}`);
  }

  if (valuation.upgrade_hints.length > 0) {
    console.log("");
    console.log(c.bold("  How to increase score / tier:"));
    for (const hint of valuation.upgrade_hints) {
      printInfo(hint);
    }
  }

  console.log("");
  printWarn(valuation.disclaimer);
  console.log("");
}

export function runEstimate(options: EstimateCommandOptions): number {
  const { config, bundleSha, valuation } = evaluateBundleFromDisk(options.bundleDir);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          id: config.id,
          bundle_sha256: bundleSha,
          valuation,
        },
        null,
        2
      )
    );
    return 0;
  }

  printValuationSummary(config.id, valuation);
  return 0;
}
