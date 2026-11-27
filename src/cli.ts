#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { TaskCategory } from "./types.js";
import { runMine } from "./commands/mine.js";
import { runInit } from "./commands/init.js";
import { runAudit } from "./commands/audit.js";
import { runVerify } from "./commands/verify.js";
import { runBench } from "./commands/bench.js";
import { runEstimate } from "./commands/estimate.js";
import { runPack } from "./commands/pack.js";
import { runLeaderboard } from "./commands/leaderboard.js";
import { runSubmit } from "./commands/submit.js";
import { runInstallSkill } from "./commands/install-skill.js";
import { c, printFail } from "./utils/format.js";

const VERSION = "0.4.0";

function printHelp(): void {
  console.log(`
${c.bold("evalkit")} ${c.dim(`v${VERSION}`)} — Turn real-world bugs & AI agent failure states into verifiable eval environments.

${c.bold("USAGE")}
  evalkit <command> [options]

${c.bold("COMMANDS")}
  ${c.cyan("install-skill")}  Install the universal Agent Skill (Antigravity, Claude Code, Cursor, Codex)
  ${c.cyan("mine")}           Scan git history to rank high-signal bugfix/feature commits
  ${c.cyan("init")}           Snapshot a git commit range into a clean, isolated eval bundle
  ${c.cyan("audit")}          Scan a bundle for secrets, PII, git-history leaks, and prompt leaks
  ${c.cyan("verify")}         Run deterministic base-fail + 3x gold-pass verification (Docker offline or local)
  ${c.cyan("bench")}          Benchmark coding agents (claude, codex, gemini, custom) on a bundle
  ${c.cyan("estimate")}       Compute Signal Score (0–100), Tier, and indicative market value range
  ${c.cyan("pack")}           Validate, attest IP ownership, generate blind scorecard (card.json) + .tar.gz
  ${c.cyan("leaderboard")}    Generate a static HTML + JSON leaderboard from verified card.json bundles
  ${c.cyan("submit")}         Submit a blind scorecard (or full bundle) to the Private Vault or GitHub

${c.bold("EXAMPLES")}
  evalkit install-skill --target auto
  evalkit mine --repo ./my-indie-app --top 5
  evalkit init --repo ./my-indie-app --from HEAD~1 --to HEAD --out ./evals/webhook-race
  evalkit audit ./evals/webhook-race
  evalkit verify ./evals/webhook-race --runs 3
  evalkit bench ./evals/webhook-race --agents claude,codex,gemini --trials 3
  evalkit pack ./evals/webhook-race --attest-ip --license private-vault
  evalkit leaderboard ./examples --out ./docs
  evalkit submit ./evals/webhook-race --dry-run

Run ${c.dim("evalkit <command> --help")} for command-specific flags.
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    printHelp();
    process.exitCode = 0;
    return;
  }
  if (cmd === "-v" || cmd === "--version") {
    console.log(VERSION);
    process.exitCode = 0;
    return;
  }

  const subArgs = argv.slice(1);

  try {
    let exitCode = 0;

    switch (cmd) {
      case "mine": {
        const { values, positionals } = parseArgs({
          args: subArgs,
          allowPositionals: true,
          options: {
            repo: { type: "string", short: "r" },
            limit: { type: "string", default: "100" },
            top: { type: "string", default: "8" },
            json: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
          },
        });
        if (values.help) {
          console.log(
            "Usage: evalkit mine [repo-path] [--repo <path>] [--limit 100] [--top 8] [--json]"
          );
          process.exitCode = 0;
          return;
        }
        exitCode = runMine({
          repo: values.repo ?? positionals[0] ?? ".",
          limit: Number.parseInt(values.limit, 10) || 100,
          top: Number.parseInt(values.top, 10) || 8,
          json: values.json,
        });
        break;
      }

      case "init": {
        const { values, positionals } = parseArgs({
          args: subArgs,
          allowPositionals: true,
          options: {
            repo: { type: "string", short: "r" },
            from: { type: "string", default: "HEAD~1" },
            to: { type: "string", default: "HEAD" },
            out: { type: "string", short: "o" },
            id: { type: "string" },
            category: { type: "string", default: "bugfix" },
            "no-extract-tests": { type: "boolean", default: false },
            force: { type: "boolean", short: "f", default: false },
            help: { type: "boolean", short: "h", default: false },
          },
        });
        if (values.help) {
          console.log(
            "Usage: evalkit init [repo-path] [--from HEAD~1] [--to HEAD] [--out <dir>] [--id <slug>] [--category bugfix|feature|refactor|migration|perf] [--no-extract-tests] [--force]"
          );
          process.exitCode = 0;
          return;
        }
        const validCategories: TaskCategory[] = [
          "bugfix",
          "feature",
          "refactor",
          "migration",
          "perf",
        ];
        const category = validCategories.includes(values.category as TaskCategory)
          ? (values.category as TaskCategory)
          : "bugfix";

        exitCode = runInit({
          repo: values.repo ?? positionals[0] ?? ".",
          from: values.from,
          to: values.to,
          out: values.out,
          id: values.id,
          category,
          extractTests: !values["no-extract-tests"],
          force: values.force,
        });
        break;
      }

      case "audit": {
        const { values, positionals } = parseArgs({
          args: subArgs,
          allowPositionals: true,
          options: {
            json: { type: "boolean", default: false },
            strict: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
          },
        });
        if (values.help || !positionals[0]) {
          console.log("Usage: evalkit audit <bundle-dir> [--strict] [--json]");
          process.exitCode = values.help ? 0 : 1;
          return;
        }
        exitCode = runAudit({
          bundleDir: positionals[0],
          json: values.json,
          strict: values.strict,
        });
        break;
      }

      case "verify": {
        const { values, positionals } = parseArgs({
          args: subArgs,
          allowPositionals: true,
          options: {
            mode: { type: "string", default: "auto" },
            runs: { type: "string" },
            timeout: { type: "string" },
            "keep-image": { type: "boolean", default: false },
            json: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
          },
        });
        if (values.help || !positionals[0]) {
          console.log(
            "Usage: evalkit verify <bundle-dir> [--mode auto|docker|local] [--runs 3] [--timeout 180] [--keep-image] [--json]"
          );
          process.exitCode = values.help ? 0 : 1;
          return;
        }
        const mode =
          values.mode === "docker" || values.mode === "local" ? values.mode : "auto";
        exitCode = runVerify({
          bundleDir: positionals[0],
          mode,
          runs: values.runs ? Number.parseInt(values.runs, 10) : undefined,
          timeoutSec: values.timeout ? Number.parseInt(values.timeout, 10) : undefined,
          keepImage: values["keep-image"],
          json: values.json,
        });
        break;
      }

      case "bench": {
        const { values, positionals } = parseArgs({
          args: subArgs,
          allowPositionals: true,
          options: {
            agents: { type: "string", short: "a" },
            cmd: { type: "string", multiple: true },
            trials: { type: "string", short: "k", default: "1" },
            "grade-mode": { type: "string", default: "auto" },
            "solve-timeout": { type: "string" },
            "verify-timeout": { type: "string" },
            json: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
          },
        });
        if (values.help || !positionals[0]) {
          console.log(
            'Usage: evalkit bench <bundle-dir> [--agents claude,codex,gemini,opencode,oracle,noop] [--cmd "label=command"]... [--trials 3] [--grade-mode auto|docker|local] [--solve-timeout 600] [--verify-timeout 180] [--json]'
          );
          process.exitCode = values.help ? 0 : 1;
          return;
        }
        const agents = values.agents
          ? values.agents
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        const gradeMode =
          values["grade-mode"] === "docker" || values["grade-mode"] === "local"
            ? values["grade-mode"]
            : "auto";
        exitCode = runBench({
          bundleDir: positionals[0],
          agents,
          customCmds: values.cmd ?? [],
          trials: Number.parseInt(values.trials, 10) || 1,
          gradeMode,
          solveTimeoutSec: values["solve-timeout"]
            ? Number.parseInt(values["solve-timeout"], 10)
            : undefined,
          verifyTimeoutSec: values["verify-timeout"]
            ? Number.parseInt(values["verify-timeout"], 10)
            : undefined,
          json: values.json,
        });
        break;
      }

      case "estimate":
      case "value": {
        const { values, positionals } = parseArgs({
          args: subArgs,
          allowPositionals: true,
          options: {
            json: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
          },
        });
        if (values.help || !positionals[0]) {
          console.log("Usage: evalkit estimate <bundle-dir> [--json]");
          process.exitCode = values.help ? 0 : 1;
          return;
        }
        exitCode = runEstimate({
          bundleDir: positionals[0],
          json: values.json,
        });
        break;
      }

      case "pack": {
        const { values, positionals } = parseArgs({
          args: subArgs,
          allowPositionals: true,
          options: {
            out: { type: "string", short: "o" },
            "attest-ip": { type: "boolean", default: false },
            license: { type: "string" },
            "skip-verify": { type: "boolean", default: false },
            json: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
          },
        });
        if (values.help || !positionals[0]) {
          console.log(
            "Usage: evalkit pack <bundle-dir> [--out <archive.tar.gz>] [--attest-ip] [--license private-vault|mit|apache-2.0] [--skip-verify] [--json]"
          );
          process.exitCode = values.help ? 0 : 1;
          return;
        }
        const license =
          values.license === "private-vault" ||
          values.license === "mit" ||
          values.license === "apache-2.0"
            ? values.license
            : undefined;
        exitCode = runPack({
          bundleDir: positionals[0],
          out: values.out,
          attestIp: values["attest-ip"],
          license,
          skipVerify: values["skip-verify"],
          json: values.json,
        });
        break;
      }

      case "leaderboard": {
        const { values, positionals } = parseArgs({
          args: subArgs,
          allowPositionals: true,
          options: {
            out: { type: "string", short: "o", default: "./docs" },
            title: { type: "string", default: "evalkit — Real-World Indie Coding Evals" },
            "repo-url": { type: "string", default: "https://github.com/abhilashi/evalkit" },
            json: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
          },
        });
        if (values.help) {
          console.log(
            'Usage: evalkit leaderboard [evals-dir] [--out ./docs] [--title "..."] [--repo-url "..."] [--json]'
          );
          process.exitCode = 0;
          return;
        }
        exitCode = runLeaderboard({
          dir: positionals[0] ?? "./examples",
          outDir: values.out,
          title: values.title,
          repoUrl: values["repo-url"],
          json: values.json,
        });
        break;
      }

      case "submit": {
        const { values, positionals } = parseArgs({
          args: subArgs,
          allowPositionals: true,
          options: {
            endpoint: { type: "string", short: "e" },
            "api-key": { type: "string" },
            "github-issue": { type: "boolean", default: false },
            "github-repo": { type: "string", default: "abhilashi/evalkit" },
            "full-bundle": { type: "boolean", default: false },
            "dry-run": { type: "boolean", default: false },
            json: { type: "boolean", default: false },
            help: { type: "boolean", short: "h", default: false },
          },
        });
        if (values.help || !positionals[0]) {
          console.log(
            "Usage: evalkit submit <bundle-dir> [--endpoint <url>] [--github-issue] [--github-repo owner/repo] [--full-bundle] [--dry-run] [--json]"
          );
          process.exitCode = values.help ? 0 : 1;
          return;
        }
        exitCode = await runSubmit({
          bundleDir: positionals[0],
          endpoint: values.endpoint,
          apiKey: values["api-key"],
          githubIssue: values["github-issue"],
          githubRepo: values["github-repo"],
          fullBundle: values["full-bundle"],
          dryRun: values["dry-run"],
          json: values.json,
        });
        break;
      }

      case "install-skill": {
        const { values } = parseArgs({
          args: subArgs,
          allowPositionals: false,
          options: {
            target: { type: "string", short: "t", default: "auto" },
            project: { type: "boolean", short: "p", default: false },
            help: { type: "boolean", short: "h", default: false },
          },
        });
        if (values.help) {
          console.log(
            "Usage: evalkit install-skill [--target auto|antigravity|claude|cursor|codex|all|<path>] [--project]"
          );
          process.exitCode = 0;
          return;
        }
        exitCode = runInstallSkill({
          target: values.target,
          project: values.project,
        });
        break;
      }

      default: {
        printFail(`Unknown command: ${cmd}`);
        printHelp();
        exitCode = 1;
      }
    }

    process.exitCode = exitCode;
  } catch (err) {
    printFail((err as Error).message || String(err));
    process.exitCode = 1;
  }
}

void main();
