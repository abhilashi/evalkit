import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { EvalConfig, SandboxMode, VerifyReport, VerifyRunResult } from "../types.js";
import { execSyncSafe, isDockerAvailable, tailOutput } from "../utils/exec.js";
import { computeBundleSha256, ensureSingleCommitGit } from "../utils/git.js";
import { c, printFail, printHeader, printInfo, printPass, printWarn } from "../utils/format.js";

export interface VerifyOptions {
  bundleDir: string;
  mode: "auto" | "docker" | "local";
  runs?: number;
  timeoutSec?: number;
  keepImage: boolean;
  json: boolean;
}

function readEvalConfig(bundleDir: string): EvalConfig {
  const yamlPath = path.join(bundleDir, "eval.yaml");
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`Missing eval.yaml in ${bundleDir}`);
  }
  return YAML.parse(fs.readFileSync(yamlPath, "utf8")) as EvalConfig;
}

function copyDirRecursive(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true, force: true });
}

function buildCleanVerifyEnv(workspaceDir: string, gradingDir: string): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "NODE_TEST_CONTEXT" || k.startsWith("npm_")) continue;
    clean[k] = v;
  }
  clean.WORKSPACE_DIR = workspaceDir;
  clean.GRADING_DIR = gradingDir;
  return clean;
}

function verifyInLocalSandbox(
  bundleDir: string,
  config: EvalConfig,
  runs: number,
  timeoutMs: number,
  quiet: boolean
): VerifyReport {
  const repoSrc = path.join(bundleDir, "environment", "repo");
  const gradingDir = path.join(bundleDir, "grading");
  const verifyScript = path.join(gradingDir, "verify.sh");
  const patchPath = path.join(bundleDir, "private", "gold.patch");

  if (!fs.existsSync(repoSrc)) throw new Error(`Missing ${repoSrc}`);
  if (!fs.existsSync(verifyScript)) throw new Error(`Missing ${verifyScript}`);
  if (!fs.existsSync(patchPath)) throw new Error(`Missing ${patchPath}`);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evalkit-verify-"));
  try {
    // 1. Base check (MUST FAIL)
    if (!quiet) printInfo("Running base_commit verification (expecting failure)...");
    const baseDir = path.join(tmpRoot, "base");
    copyDirRecursive(repoSrc, baseDir);

    const baseRes = execSyncSafe("bash", [verifyScript], {
      cwd: baseDir,
      timeoutMs,
      env: buildCleanVerifyEnv(baseDir, gradingDir),
    });
    const baseFailedAsExpected = baseRes.exitCode !== 0 && !baseRes.timedOut;
    if (!quiet) {
      if (baseFailedAsExpected) {
        printPass(`Base check failed as expected (exit ${baseRes.exitCode}, ${baseRes.durationMs}ms)`);
      } else {
        printFail(
          `Base check unexpectedly ${baseRes.timedOut ? "timed out" : "PASSED (exit 0)"} — hidden tests must fail before gold.patch!`
        );
      }
    }

    // 2. Gold oracle checks (MUST PASS N/N)
    const goldResults: VerifyRunResult[] = [];
    for (let i = 1; i <= runs; i++) {
      if (!quiet) printInfo(`Running gold oracle pass ${i}/${runs}...`);
      const runDir = path.join(tmpRoot, `gold-${i}`);
      copyDirRecursive(repoSrc, runDir);
      ensureSingleCommitGit(runDir);

      const applyRes = execSyncSafe("git", ["apply", "--whitespace=nowarn", patchPath], {
        cwd: runDir,
        timeoutMs: 30_000,
      });
      if (applyRes.exitCode !== 0) {
        goldResults.push({
          run: i,
          passed: false,
          exitCode: applyRes.exitCode,
          durationMs: applyRes.durationMs,
          outputTail: `git apply failed:\n${tailOutput(applyRes.stdout, applyRes.stderr)}`,
        });
        if (!quiet) printFail(`Run ${i}/${runs}: git apply failed`);
        continue;
      }

      const runRes = execSyncSafe("bash", [verifyScript], {
        cwd: runDir,
        timeoutMs,
        env: buildCleanVerifyEnv(runDir, gradingDir),
      });
      const ok = runRes.exitCode === 0 && !runRes.timedOut;
      goldResults.push({
        run: i,
        passed: ok,
        exitCode: runRes.exitCode,
        durationMs: runRes.durationMs,
        outputTail: tailOutput(runRes.stdout, runRes.stderr),
      });
      if (!quiet) {
        if (ok) {
          printPass(`Gold run ${i}/${runs} passed (${runRes.durationMs}ms)`);
        } else {
          printFail(`Gold run ${i}/${runs} FAILED (exit ${runRes.exitCode}, ${runRes.durationMs}ms)`);
        }
      }
    }

    const runsPassed = goldResults.filter((r) => r.passed).length;
    const allGoldPassed = runsPassed === runs;
    const bundleSha = computeBundleSha256(bundleDir);

    return {
      spec_version: config.spec_version,
      id: config.id,
      verified_at: new Date().toISOString(),
      sandbox: "local",
      network_isolated: false,
      bundle_sha256: bundleSha,
      passed: baseFailedAsExpected && allGoldPassed,
      base_check: {
        failed_as_expected: baseFailedAsExpected,
        exit_code: baseRes.exitCode,
        duration_ms: baseRes.durationMs,
        output_tail: tailOutput(baseRes.stdout, baseRes.stderr),
      },
      gold_checks: {
        runs_requested: runs,
        runs_passed: runsPassed,
        all_passed: allGoldPassed,
        results: goldResults,
      },
    };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

function verifyInDockerOffline(
  bundleDir: string,
  config: EvalConfig,
  runs: number,
  timeoutMs: number,
  keepImage: boolean,
  quiet: boolean
): VerifyReport {
  const envDir = path.join(bundleDir, "environment");
  const gradingDir = path.join(bundleDir, "grading");
  const patchPath = path.join(bundleDir, "private", "gold.patch");
  const bundleSha = computeBundleSha256(bundleDir);
  const imageTag = `evalkit-${config.id.replace(/[^a-z0-9._-]/g, "-")}:${bundleSha.slice(0, 12)}`;

  if (!quiet) printInfo(`Building Docker image ${imageTag}...`);
  const buildRes = execSyncSafe("docker", ["build", "-t", imageTag, envDir], {
    timeoutMs: Math.max(timeoutMs * 3, 600_000),
  });
  if (buildRes.exitCode !== 0) {
    throw new Error(
      `Docker build failed:\n${tailOutput(buildRes.stdout, buildRes.stderr, 40)}`
    );
  }
  if (!quiet) printPass(`Built image (${buildRes.durationMs}ms)`);

  try {
    // 1. Base check under --network=none (MUST FAIL)
    if (!quiet) printInfo("Running base_commit inside container (--network=none, expecting failure)...");
    const baseRes = execSyncSafe(
      "docker",
      [
        "run",
        "--rm",
        "--network=none",
        "-v",
        `${gradingDir}:/grading:ro`,
        "-e",
        "WORKSPACE_DIR=/workspace",
        "-e",
        "GRADING_DIR=/grading",
        imageTag,
        "bash",
        "/grading/verify.sh",
      ],
      { timeoutMs }
    );
    const baseFailedAsExpected = baseRes.exitCode !== 0 && !baseRes.timedOut;
    if (!quiet) {
      if (baseFailedAsExpected) {
        printPass(`Base check failed as expected offline (exit ${baseRes.exitCode}, ${baseRes.durationMs}ms)`);
      } else {
        printFail(
          `Base check unexpectedly ${baseRes.timedOut ? "timed out" : "PASSED (exit 0)"}!`
        );
      }
    }

    // 2. Gold oracle runs under --network=none (MUST PASS N/N)
    const goldResults: VerifyRunResult[] = [];
    for (let i = 1; i <= runs; i++) {
      if (!quiet) printInfo(`Running gold oracle pass ${i}/${runs} (--network=none)...`);
      const runRes = execSyncSafe(
        "docker",
        [
          "run",
          "--rm",
          "--network=none",
          "-v",
          `${gradingDir}:/grading:ro`,
          "-v",
          `${patchPath}:/tmp/gold.patch:ro`,
          "-e",
          "WORKSPACE_DIR=/workspace",
          "-e",
          "GRADING_DIR=/grading",
          imageTag,
          "bash",
          "-c",
          "cd /workspace && git apply --whitespace=nowarn /tmp/gold.patch && bash /grading/verify.sh",
        ],
        { timeoutMs }
      );
      const ok = runRes.exitCode === 0 && !runRes.timedOut;
      goldResults.push({
        run: i,
        passed: ok,
        exitCode: runRes.exitCode,
        durationMs: runRes.durationMs,
        outputTail: tailOutput(runRes.stdout, runRes.stderr),
      });
      if (!quiet) {
        if (ok) {
          printPass(`Gold run ${i}/${runs} passed offline (${runRes.durationMs}ms)`);
        } else {
          printFail(`Gold run ${i}/${runs} FAILED offline (exit ${runRes.exitCode}, ${runRes.durationMs}ms)`);
        }
      }
    }

    const runsPassed = goldResults.filter((r) => r.passed).length;
    const allGoldPassed = runsPassed === runs;

    return {
      spec_version: config.spec_version,
      id: config.id,
      verified_at: new Date().toISOString(),
      sandbox: "docker-offline",
      network_isolated: true,
      bundle_sha256: bundleSha,
      passed: baseFailedAsExpected && allGoldPassed,
      base_check: {
        failed_as_expected: baseFailedAsExpected,
        exit_code: baseRes.exitCode,
        duration_ms: baseRes.durationMs,
        output_tail: tailOutput(baseRes.stdout, baseRes.stderr),
      },
      gold_checks: {
        runs_requested: runs,
        runs_passed: runsPassed,
        all_passed: allGoldPassed,
        results: goldResults,
      },
    };
  } finally {
    if (!keepImage) {
      execSyncSafe("docker", ["rmi", "-f", imageTag], { timeoutMs: 15_000 });
    }
  }
}

export function runVerify(options: VerifyOptions): number {
  const bundleDir = path.resolve(options.bundleDir);
  const config = readEvalConfig(bundleDir);
  const runs = options.runs ?? config.grading?.flakiness_runs ?? 3;
  const timeoutMs = (options.timeoutSec ?? config.timeouts?.verify_sec ?? 180) * 1000;

  let chosenSandbox: SandboxMode;
  if (options.mode === "docker") {
    if (!isDockerAvailable()) {
      throw new Error(
        "Docker daemon is not running. Start Docker Desktop / dockerd, or pass --mode local for non-containerized verification."
      );
    }
    chosenSandbox = "docker-offline";
  } else if (options.mode === "local") {
    chosenSandbox = "local";
  } else {
    if (isDockerAvailable()) {
      chosenSandbox = "docker-offline";
    } else {
      throw new Error(
        "Docker daemon is not running. Start Docker for true offline (--network=none) verification, or explicitly pass --mode local to run in a local temp sandbox."
      );
    }
  }

  if (!options.json) {
    printHeader(`Verifying eval bundle: ${config.id} (${chosenSandbox})`);
    if (chosenSandbox === "local") {
      printWarn(
        "Running in local temp sandbox (network is NOT isolated). Re-run with Docker before vault submission."
      );
    }
  }

  const report =
    chosenSandbox === "docker-offline"
      ? verifyInDockerOffline(bundleDir, config, runs, timeoutMs, options.keepImage, options.json)
      : verifyInLocalSandbox(bundleDir, config, runs, timeoutMs, options.json);

  const reportPath = path.join(bundleDir, "private", "verify-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return report.passed ? 0 : 1;
  }

  console.log("");
  if (report.passed) {
    printPass(
      `${c.bold("VERIFIED")} — base fails cleanly, gold passes ${report.gold_checks.runs_passed}/${report.gold_checks.runs_requested} (${report.sandbox})`
    );
    printInfo(`Report saved to ${path.relative(process.cwd(), reportPath)}`);
    console.log("");
    return 0;
  }

  printFail(
    `${c.bold("VERIFICATION FAILED")} — base_failed=${report.base_check.failed_as_expected}, gold=${report.gold_checks.runs_passed}/${report.gold_checks.runs_requested}`
  );
  if (!report.base_check.failed_as_expected && report.base_check.output_tail) {
    console.log(c.dim("\n--- Base output ---\n" + report.base_check.output_tail));
  }
  const failedGold = report.gold_checks.results.find((r) => !r.passed);
  if (failedGold?.outputTail) {
    console.log(c.dim("\n--- First failing gold run output ---\n" + failedGold.outputTail));
  }
  console.log("");
  return 1;
}
