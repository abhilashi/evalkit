import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type {
  BenchAgentSummary,
  BenchReport,
  BenchTrialResult,
  BlindCard,
  EvalConfig,
  SandboxMode,
} from "../types.js";
import { execSyncSafe, isDockerAvailable, tailOutput } from "../utils/exec.js";
import { computeBundleSha256 } from "../utils/git.js";
import { c, printFail, printHeader, printInfo, printPass, printWarn } from "../utils/format.js";

export interface BenchOptions {
  bundleDir: string;
  agents: string[];
  customCmds: string[];
  trials: number;
  gradeMode: "auto" | "docker" | "local";
  solveTimeoutSec?: number;
  verifyTimeoutSec?: number;
  json: boolean;
}

interface AgentRunner {
  name: string;
  kind: "builtin-noop" | "builtin-oracle" | "cli" | "custom";
  cmd?: string;
  buildArgs?: (promptText: string, promptFile: string) => string[];
  shellCmd?: string;
}

function buildCleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "NODE_TEST_CONTEXT" || k.startsWith("npm_")) continue;
    clean[k] = v;
  }
  return { ...clean, ...extra };
}

function isCommandOnPath(bin: string): boolean {
  const res = execSyncSafe("which", [bin], { timeoutMs: 3_000 });
  return res.exitCode === 0 && res.stdout.trim().length > 0;
}

const BUILTIN_CLI_ADAPTERS: Record<
  string,
  { bin: string; buildArgs: (promptText: string, promptFile: string) => string[] }
> = {
  claude: {
    bin: "claude",
    buildArgs: (promptText) => [
      "-p",
      promptText,
      "--dangerously-skip-permissions",
      "--output-format",
      "text",
    ],
  },
  "claude-code": {
    bin: "claude",
    buildArgs: (promptText) => [
      "-p",
      promptText,
      "--dangerously-skip-permissions",
      "--output-format",
      "text",
    ],
  },
  codex: {
    bin: "codex",
    buildArgs: (promptText) => ["exec", "--full-auto", promptText],
  },
  gemini: {
    bin: "gemini",
    buildArgs: (promptText) => ["-p", promptText, "--yolo"],
  },
  opencode: {
    bin: "opencode",
    buildArgs: (promptText) => ["run", promptText],
  },
};

function resolveRunners(agentSpecs: string[], customCmds: string[]): AgentRunner[] {
  const runners: AgentRunner[] = [];

  for (const raw of agentSpecs) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if (name === "noop") {
      runners.push({ name: "noop", kind: "builtin-noop" });
      continue;
    }
    if (name === "oracle") {
      runners.push({ name: "oracle", kind: "builtin-oracle" });
      continue;
    }
    const adapter = BUILTIN_CLI_ADAPTERS[name];
    if (!adapter) {
      throw new Error(
        `Unknown agent "${raw}". Built-in agents: claude, codex, gemini, opencode, oracle, noop. Or pass --cmd "name=your command".`
      );
    }
    if (!isCommandOnPath(adapter.bin)) {
      throw new Error(
        `Agent CLI "${adapter.bin}" was not found on PATH. Install it or choose another agent.`
      );
    }
    runners.push({
      name,
      kind: "cli",
      cmd: adapter.bin,
      buildArgs: adapter.buildArgs,
    });
  }

  for (const spec of customCmds) {
    const eqIdx = spec.indexOf("=");
    if (eqIdx <= 0 || eqIdx === spec.length - 1) {
      throw new Error(`Invalid --cmd "${spec}". Expected format: --cmd "label=command"`);
    }
    const name = spec.slice(0, eqIdx).trim();
    const shellCmd = spec.slice(eqIdx + 1).trim();
    runners.push({ name, kind: "custom", shellCmd });
  }

  // If user passed neither --agents nor --cmd, auto-detect installed CLIs or fallback to noop+oracle
  if (runners.length === 0) {
    const autoCandidates = ["claude", "codex", "gemini", "opencode"];
    for (const candidate of autoCandidates) {
      const adapter = BUILTIN_CLI_ADAPTERS[candidate];
      if (isCommandOnPath(adapter.bin)) {
        runners.push({
          name: candidate,
          kind: "cli",
          cmd: adapter.bin,
          buildArgs: adapter.buildArgs,
        });
      }
    }
    if (runners.length === 0) {
      throw new Error(
        'No supported agent CLIs (claude, codex, gemini, opencode) found on PATH. Pass --agents oracle,noop to test the harness or --cmd "my-agent=..." for a custom runner.'
      );
    }
  }

  return runners;
}

function captureWorkspacePatch(
  workspaceDir: string,
  patchOutPath: string
): { filesChanged: number; insertions: number; deletions: number } {
  execSyncSafe("git", ["add", "-A"], { cwd: workspaceDir, timeoutMs: 15_000 });
  const statRes = execSyncSafe("git", ["diff", "--cached", "--numstat"], {
    cwd: workspaceDir,
    timeoutMs: 15_000,
  });

  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  for (const line of statRes.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    filesChanged++;
    insertions += parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10) || 0;
    deletions += parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10) || 0;
  }

  const diffRes = execSyncSafe("git", ["diff", "--cached", "--binary"], {
    cwd: workspaceDir,
    timeoutMs: 15_000,
  });
  fs.writeFileSync(patchOutPath, diffRes.stdout, "utf8");
  return { filesChanged, insertions, deletions };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function pad(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function printScorecardTable(config: EvalConfig, report: BenchReport): void {
  printHeader(
    `evalkit bench — ${config.id} (${config.stack.join(", ")}) [${report.grade_sandbox}]`
  );
  console.log("");

  const header = `  ${pad("Agent", 16)}${pad("Pass Rate", 16)}${pad("Avg Solve", 12)}${pad("Avg Diff", 14)}Status`;
  console.log(c.bold(header));
  console.log(c.dim("  " + "─".repeat(66)));

  for (const a of report.agents) {
    const pct = Math.round(a.pass_rate * 100);
    const rateStr = `${a.passed}/${a.trials} (${pct}%)`;
    const diffStr = `+${a.avg_insertions} / -${a.avg_deletions}`;
    const status =
      a.passed === a.trials
        ? c.green("PASS")
        : a.passed === 0
          ? c.red("FAIL")
          : c.yellow("PARTIAL");

    console.log(
      `  ${c.bold(pad(a.agent, 16))}${pad(rateStr, 16)}${pad(formatDuration(a.avg_solve_ms), 12)}${pad(diffStr, 14)}${status}`
    );
  }
  console.log("");
}

export function runBench(options: BenchOptions): number {
  const bundleDir = path.resolve(options.bundleDir);
  const evalYamlPath = path.join(bundleDir, "eval.yaml");
  const promptPath = path.join(bundleDir, "prompt.md");
  const repoSrc = path.join(bundleDir, "environment", "repo");
  const envDir = path.join(bundleDir, "environment");
  const gradingDir = path.join(bundleDir, "grading");
  const verifyScript = path.join(gradingDir, "verify.sh");
  const goldPatchPath = path.join(bundleDir, "private", "gold.patch");

  if (!fs.existsSync(evalYamlPath)) throw new Error(`Missing ${evalYamlPath}`);
  if (!fs.existsSync(promptPath)) throw new Error(`Missing ${promptPath}`);
  if (!fs.existsSync(repoSrc)) throw new Error(`Missing ${repoSrc}`);
  if (!fs.existsSync(verifyScript)) throw new Error(`Missing ${verifyScript}`);

  const config = YAML.parse(fs.readFileSync(evalYamlPath, "utf8")) as EvalConfig;
  const promptText = fs.readFileSync(promptPath, "utf8");
  const runners = resolveRunners(options.agents, options.customCmds);

  const trials = Math.max(1, options.trials);
  const solveTimeoutMs = (options.solveTimeoutSec ?? config.timeouts?.solve_sec ?? 600) * 1000;
  const verifyTimeoutMs = (options.verifyTimeoutSec ?? config.timeouts?.verify_sec ?? 180) * 1000;

  let gradeSandbox: SandboxMode;
  if (options.gradeMode === "docker") {
    if (!isDockerAvailable()) {
      throw new Error(
        "Docker daemon is not running. Start Docker or pass --grade-mode local."
      );
    }
    gradeSandbox = "docker-offline";
  } else if (options.gradeMode === "local") {
    gradeSandbox = "local";
  } else {
    gradeSandbox = isDockerAvailable() ? "docker-offline" : "local";
  }

  const bundleSha = computeBundleSha256(bundleDir);
  const imageTag = `evalkit-bench-${config.id.replace(/[^a-z0-9._-]/g, "-")}:${bundleSha.slice(0, 12)}`;

  if (!options.json) {
    printHeader(`Benchmarking ${config.id} across ${runners.length} agent(s) × ${trials} trial(s)`);
    if (gradeSandbox === "local") {
      printWarn("Grading in local temp sandbox (Docker not active — network not isolated during grading).");
    } else {
      printInfo(`Building offline grading image ${imageTag}...`);
    }
  }

  if (gradeSandbox === "docker-offline") {
    const buildRes = execSyncSafe("docker", ["build", "-t", imageTag, envDir], {
      timeoutMs: Math.max(verifyTimeoutMs * 3, 600_000),
    });
    if (buildRes.exitCode !== 0) {
      throw new Error(
        `Docker build failed:\n${tailOutput(buildRes.stdout, buildRes.stderr, 40)}`
      );
    }
    if (!options.json) printPass(`Built grading image (${formatDuration(buildRes.durationMs)})`);
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "evalkit-bench-"));
  const agentSummaries: BenchAgentSummary[] = [];

  try {
    // Copy prompt to a neutral temp path outside the bundle so agents cannot traverse into grading/ or private/
    const safePromptPath = path.join(tmpRoot, "prompt.md");
    fs.writeFileSync(safePromptPath, promptText, "utf8");

    for (const runner of runners) {
      const trialResults: BenchTrialResult[] = [];

      for (let t = 1; t <= trials; t++) {
        if (!options.json) {
          printInfo(`Running ${c.bold(runner.name)} (trial ${t}/${trials})...`);
        }

        const trialRoot = path.join(tmpRoot, `${runner.name.replace(/[^a-z0-9_-]/gi, "_")}-${t}`);
        const workspaceDir = path.join(trialRoot, "workspace");
        const agentPatchPath = path.join(trialRoot, "agent.patch");
        fs.mkdirSync(trialRoot, { recursive: true });
        fs.cpSync(repoSrc, workspaceDir, { recursive: true, force: true });

        // 1. Solve phase (isolated workspace containing ONLY base_commit)
        let solveExit = 0;
        let solveDurationMs = 0;
        let solveTimedOut = false;

        if (runner.kind === "builtin-noop") {
          solveExit = 0;
          solveDurationMs = 0;
        } else if (runner.kind === "builtin-oracle") {
          const applyRes = execSyncSafe(
            "git",
            ["apply", "--whitespace=nowarn", goldPatchPath],
            { cwd: workspaceDir, timeoutMs: 30_000 }
          );
          solveExit = applyRes.exitCode;
          solveDurationMs = applyRes.durationMs;
        } else if (runner.kind === "cli" && runner.cmd && runner.buildArgs) {
          const solveRes = execSyncSafe(
            runner.cmd,
            runner.buildArgs(promptText, safePromptPath),
            {
              cwd: workspaceDir,
              timeoutMs: solveTimeoutMs,
              env: buildCleanEnv({
                EVALKIT_PROMPT_FILE: safePromptPath,
                EVALKIT_WORKSPACE: workspaceDir,
              }),
            }
          );
          solveExit = solveRes.exitCode;
          solveDurationMs = solveRes.durationMs;
          solveTimedOut = solveRes.timedOut;
        } else if (runner.kind === "custom" && runner.shellCmd) {
          const interpolated = runner.shellCmd
            .replace(/\{prompt_file\}/g, safePromptPath)
            .replace(/\{workspace\}/g, workspaceDir);
          const solveRes = execSyncSafe("bash", ["-lc", interpolated], {
            cwd: workspaceDir,
            timeoutMs: solveTimeoutMs,
            input: promptText,
            env: buildCleanEnv({
              EVALKIT_PROMPT_FILE: safePromptPath,
              EVALKIT_WORKSPACE: workspaceDir,
            }),
          });
          solveExit = solveRes.exitCode;
          solveDurationMs = solveRes.durationMs;
          solveTimedOut = solveRes.timedOut;
        }

        // 2. Capture produced patch
        const diffStats = captureWorkspacePatch(workspaceDir, agentPatchPath);

        // 3. Grade phase (isolated from agent, offline in Docker mode)
        let gradeExit = 1;
        let gradeDurationMs = 0;
        let outputTail = "";

        if (gradeSandbox === "docker-offline") {
          const hasPatch = fs.statSync(agentPatchPath).size > 0;
          const dockerArgs = [
            "run",
            "--rm",
            "--network=none",
            "-v",
            `${gradingDir}:/grading:ro`,
            "-e",
            "WORKSPACE_DIR=/workspace",
            "-e",
            "GRADING_DIR=/grading",
          ];
          let cmdStr = "cd /workspace && bash /grading/verify.sh";
          if (hasPatch) {
            dockerArgs.push("-v", `${agentPatchPath}:/tmp/agent.patch:ro`);
            cmdStr =
              "cd /workspace && git apply --whitespace=nowarn /tmp/agent.patch && bash /grading/verify.sh";
          }
          dockerArgs.push(imageTag, "bash", "-c", cmdStr);
          const gradeRes = execSyncSafe("docker", dockerArgs, {
            timeoutMs: verifyTimeoutMs,
          });
          gradeExit = gradeRes.exitCode;
          gradeDurationMs = gradeRes.durationMs;
          outputTail = tailOutput(gradeRes.stdout, gradeRes.stderr);
        } else {
          const gradeRes = execSyncSafe("bash", [verifyScript], {
            cwd: workspaceDir,
            timeoutMs: verifyTimeoutMs,
            env: buildCleanEnv({
              WORKSPACE_DIR: workspaceDir,
              GRADING_DIR: gradingDir,
            }),
          });
          gradeExit = gradeRes.exitCode;
          gradeDurationMs = gradeRes.durationMs;
          outputTail = tailOutput(gradeRes.stdout, gradeRes.stderr);
        }

        const passed = gradeExit === 0;
        trialResults.push({
          trial: t,
          passed,
          solve_exit_code: solveExit,
          grade_exit_code: gradeExit,
          solve_duration_ms: solveDurationMs,
          grade_duration_ms: gradeDurationMs,
          files_changed: diffStats.filesChanged,
          insertions: diffStats.insertions,
          deletions: diffStats.deletions,
          solve_timed_out: solveTimedOut,
          output_tail: outputTail,
        });

        if (!options.json) {
          const badge = passed ? c.green("PASS") : c.red("FAIL");
          printInfo(
            `  Trial ${t}/${trials}: ${badge} (solve ${formatDuration(solveDurationMs)}, diff +${diffStats.insertions}/-${diffStats.deletions})`
          );
        }
      }

      const passedCount = trialResults.filter((r) => r.passed).length;
      const avgSolveMs = Math.round(
        trialResults.reduce((acc, r) => acc + r.solve_duration_ms, 0) / trials
      );
      const avgIns = Math.round(
        trialResults.reduce((acc, r) => acc + r.insertions, 0) / trials
      );
      const avgDel = Math.round(
        trialResults.reduce((acc, r) => acc + r.deletions, 0) / trials
      );

      agentSummaries.push({
        agent: runner.name,
        passed: passedCount,
        trials,
        pass_rate: Number((passedCount / trials).toFixed(3)),
        avg_solve_ms: avgSolveMs,
        avg_insertions: avgIns,
        avg_deletions: avgDel,
        results: trialResults,
      });
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (gradeSandbox === "docker-offline") {
      execSyncSafe("docker", ["rmi", "-f", imageTag], { timeoutMs: 15_000 });
    }
  }

  const report: BenchReport = {
    spec_version: config.spec_version,
    id: config.id,
    benchmarked_at: new Date().toISOString(),
    bundle_sha256: bundleSha,
    grade_sandbox: gradeSandbox,
    network_isolated_grading: gradeSandbox === "docker-offline",
    trials_per_agent: trials,
    agents: agentSummaries,
  };

  const reportPath = path.join(bundleDir, "private", "bench-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

  // If card.json already exists and matches this bundle, refresh its benchmark block automatically
  const cardPath = path.join(bundleDir, "card.json");
  if (fs.existsSync(cardPath)) {
    try {
      const card = JSON.parse(fs.readFileSync(cardPath, "utf8")) as BlindCard;
      if (card.bundle_sha256 === bundleSha) {
        card.benchmark = {
          benchmarked_at: report.benchmarked_at,
          grade_sandbox: report.grade_sandbox,
          trials_per_agent: report.trials_per_agent,
          results: report.agents.map((a) => ({
            agent: a.agent,
            passed: a.passed,
            trials: a.trials,
            pass_rate: a.pass_rate,
            avg_solve_ms: a.avg_solve_ms,
          })),
        };
        fs.writeFileSync(cardPath, JSON.stringify(card, null, 2), "utf8");
      }
    } catch {
      // Ignore invalid existing card.json
    }
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  printScorecardTable(config, report);
  printInfo(`Full report saved to ${path.relative(process.cwd(), reportPath)}`);
  console.log("");
  return 0;
}
