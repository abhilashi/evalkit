#!/usr/bin/env node
import { parseArgs } from "node:util";
import type { TaskCategory } from "./types.js";
import { runMine } from "./commands/mine.js";
import { runInit } from "./commands/init.js";
import { runAudit } from "./commands/audit.js";
import { runVerify } from "./commands/verify.js";
import { runPack } from "./commands/pack.js";
import { runInstallSkill } from "./commands/install-skill.js";
import { c, printFail } from "./utils/format.js";

const VERSION = "0.1.0";

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
  ${c.cyan("pack")}           Validate, attest IP ownership, generate blind scorecard (card.json) + .tar.gz

${c.bold("EXAMPLES")}
  evalkit install-skill --target auto
  evalkit mine --repo ./my-indie-app --top 5
  evalkit init --repo ./my-indie-app --from HEAD~1 --to HEAD --out ./evals/webhook-race
  evalkit audit ./evals/webhook-race
  evalkit verify ./evals/webhook-race --runs 3
  evalkit pack ./evals/webhook-race --attest-ip --license private-vault

Run ${c.dim("evalkit <command> --help")} for command-specific flags.
`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    printHelp();
    process.exit(0);
  }
  if (cmd === "-v" || cmd === "--version") {
    console.log(VERSION);
    process.exit(0);
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
          process.exit(0);
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
          process.exit(0);
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
          process.exit(values.help ? 0 : 1);
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
          process.exit(values.help ? 0 : 1);
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
          process.exit(values.help ? 0 : 1);
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
          process.exit(0);
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

    process.exit(exitCode);
  } catch (err) {
    printFail((err as Error).message || String(err));
    process.exit(1);
  }
}

main();
