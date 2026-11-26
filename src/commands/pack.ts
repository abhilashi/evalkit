import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { BenchReport, BlindCard, EvalConfig, VerifyReport } from "../types.js";
import { auditBundle } from "./audit.js";
import { computeBundleSha256 } from "../utils/git.js";
import { execSyncSafe } from "../utils/exec.js";
import { c, printFail, printHeader, printInfo, printPass, printWarn } from "../utils/format.js";

export interface PackOptions {
  bundleDir: string;
  out?: string;
  attestIp: boolean;
  license?: "private-vault" | "mit" | "apache-2.0";
  skipVerify: boolean;
  json: boolean;
}

export function runPack(options: PackOptions): number {
  const bundleDir = path.resolve(options.bundleDir);
  const evalYamlPath = path.join(bundleDir, "eval.yaml");
  if (!fs.existsSync(evalYamlPath)) {
    throw new Error(`Missing eval.yaml in ${bundleDir}`);
  }

  const config = YAML.parse(fs.readFileSync(evalYamlPath, "utf8")) as EvalConfig;
  let configChanged = false;

  if (options.attestIp && !config.ownership?.author_attestation) {
    config.ownership = {
      ...(config.ownership ?? { license: "private-vault" }),
      author_attestation: true,
    };
    configChanged = true;
  }
  if (options.license && config.ownership?.license !== options.license) {
    config.ownership = {
      ...(config.ownership ?? { author_attestation: false }),
      license: options.license,
    };
    configChanged = true;
  }

  if (configChanged) {
    fs.writeFileSync(evalYamlPath, YAML.stringify(config), "utf8");
  }

  if (!options.json) {
    printHeader(`Packing eval bundle: ${config.id}`);
  }

  // 1. Audit gate (blocks packing on any error)
  const audit = auditBundle(bundleDir);
  if (!audit.passed) {
    if (!options.json) {
      printFail(`Audit failed with ${audit.errorCount} error(s). Run evalkit audit first.`);
      for (const issue of audit.issues.filter((i) => i.severity === "error")) {
        printFail(`[${issue.category}] ${issue.file ?? ""}: ${issue.message}`);
      }
    } else {
      console.log(JSON.stringify({ packed: false, reason: "audit_failed", audit }, null, 2));
    }
    return 1;
  }
  if (!options.json) printPass("Audit gate passed (zero secrets, zero git leaks)");

  // 2. Ownership attestation check
  if (!config.ownership?.author_attestation) {
    const msg =
      "IP ownership attestation is not set. Re-run with --attest-ip to confirm you own or have rights to license this code.";
    if (options.json) {
      console.log(JSON.stringify({ packed: false, reason: "missing_ip_attestation", message: msg }, null, 2));
    } else {
      printFail(msg);
    }
    return 1;
  }
  if (!options.json) printPass(`IP attestation confirmed (license: ${config.ownership.license})`);

  // 3. Verification report check
  const currentSha = computeBundleSha256(bundleDir);
  const reportPath = path.join(bundleDir, "private", "verify-report.json");
  let verifyReport: VerifyReport | null = null;

  if (fs.existsSync(reportPath)) {
    verifyReport = JSON.parse(fs.readFileSync(reportPath, "utf8")) as VerifyReport;
  }

  const verifyValid =
    verifyReport !== null &&
    verifyReport.passed &&
    verifyReport.bundle_sha256 === currentSha;

  if (!verifyValid && !options.skipVerify) {
    const reason = !verifyReport
      ? "Bundle has not been verified yet. Run `evalkit verify` first (or pass --skip-verify)."
      : !verifyReport.passed
        ? "Latest verification failed. Fix failing tests and re-run `evalkit verify`."
        : "Bundle files changed since last verification (checksum mismatch). Re-run `evalkit verify`.";
    if (options.json) {
      console.log(JSON.stringify({ packed: false, reason: "unverified", message: reason }, null, 2));
    } else {
      printFail(reason);
    }
    return 1;
  }

  if (!verifyValid && options.skipVerify && !options.json) {
    printWarn("Packing without a fresh passing verify report (--skip-verify).");
  } else if (verifyValid && !options.json) {
    printPass(
      `Verification matches checksum (${verifyReport!.sandbox}, gold ${verifyReport!.gold_checks.runs_passed}/${verifyReport!.gold_checks.runs_requested})`
    );
  }

  // 4. Attach fresh benchmark scorecard if private/bench-report.json matches bundle checksum
  const benchReportPath = path.join(bundleDir, "private", "bench-report.json");
  let benchmarkSection: BlindCard["benchmark"] | undefined;
  if (fs.existsSync(benchReportPath)) {
    try {
      const bench = JSON.parse(fs.readFileSync(benchReportPath, "utf8")) as BenchReport;
      if (bench.bundle_sha256 === currentSha) {
        benchmarkSection = {
          benchmarked_at: bench.benchmarked_at,
          grade_sandbox: bench.grade_sandbox,
          trials_per_agent: bench.trials_per_agent,
          results: bench.agents.map((a) => ({
            agent: a.agent,
            passed: a.passed,
            trials: a.trials,
            pass_rate: a.pass_rate,
            avg_solve_ms: a.avg_solve_ms,
          })),
        };
        if (!options.json) {
          printPass(`Embedded benchmark scores for ${bench.agents.length} agent(s) into card.json`);
        }
      }
    } catch {
      // Ignore malformed bench report
    }
  }

  // 5. Write Blind Scorecard (card.json) — safe to share publicly without leaking code or prompt
  const card: BlindCard = {
    spec_version: config.spec_version,
    id: config.id,
    stack: config.stack,
    category: config.category,
    complexity: {
      files_changed: config.source?.files_changed ?? 0,
      insertions: config.source?.insertions ?? 0,
      deletions: config.source?.deletions ?? 0,
    },
    verification: {
      verified: verifyValid,
      sandbox: verifyValid && verifyReport ? verifyReport.sandbox : "unverified",
      network_isolated: verifyValid && verifyReport ? verifyReport.network_isolated : false,
      gold_pass_rate:
        verifyValid && verifyReport
          ? `${verifyReport.gold_checks.runs_passed}/${verifyReport.gold_checks.runs_requested}`
          : "0/0",
      verified_at: verifyValid && verifyReport ? verifyReport.verified_at : null,
    },
    ...(benchmarkSection ? { benchmark: benchmarkSection } : {}),
    ownership: {
      author_attestation: config.ownership.author_attestation,
      license: config.ownership.license,
    },
    bundle_sha256: currentSha,
    packed_at: new Date().toISOString(),
  };

  const cardPath = path.join(bundleDir, "card.json");
  fs.writeFileSync(cardPath, JSON.stringify(card, null, 2), "utf8");

  // 5. Create compressed tarball
  const archivePath = path.resolve(
    options.out || path.join(path.dirname(bundleDir), `${config.id}.evalkit.tar.gz`)
  );
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });

  const tarRes = execSyncSafe("tar", [
    "-czf",
    archivePath,
    "-C",
    path.dirname(bundleDir),
    "--exclude=node_modules",
    "--exclude=.next",
    "--exclude=*.evalkit.tar.gz",
    path.basename(bundleDir),
  ]);
  if (tarRes.exitCode !== 0) {
    throw new Error(`Failed to pack archive: ${tarRes.stderr}`);
  }

  const sizeKb = Math.max(1, Math.round(fs.statSync(archivePath).size / 1024));

  if (options.json) {
    console.log(JSON.stringify({ packed: true, archivePath, sizeKb, cardPath, card }, null, 2));
    return 0;
  }

  printPass(`Blind scorecard written: ${path.relative(process.cwd(), cardPath)}`);
  printPass(`Archive created: ${path.relative(process.cwd(), archivePath)} (${sizeKb} KB)`);
  printInfo(`SHA-256: ${c.dim(currentSha)}`);
  console.log("");
  return 0;
}
