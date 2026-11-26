import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { AuditIssue, AuditReport, EvalConfig } from "../types.js";
import { execSyncSafe } from "../utils/exec.js";
import { scanDirectoryForSecrets } from "../scanner/secrets.js";
import { lintDebrief, lintPrompt } from "../scanner/prompt-lint.js";
import { c, printFail, printHeader, printInfo, printPass, printWarn } from "../utils/format.js";

export interface AuditOptions {
  bundleDir: string;
  json: boolean;
  strict: boolean;
}

export function auditBundle(bundleDir: string): AuditReport {
  const absDir = path.resolve(bundleDir);
  const issues: AuditIssue[] = [];

  // 1. Required structure
  const requiredPaths = [
    "eval.yaml",
    "prompt.md",
    "environment/Dockerfile",
    "environment/repo",
    "grading/verify.sh",
    "private/gold.patch",
  ];
  for (const rel of requiredPaths) {
    if (!fs.existsSync(path.join(absDir, rel))) {
      issues.push({
        category: "structure",
        severity: "error",
        file: rel,
        message: `Missing required path: ${rel}`,
      });
    }
  }

  // 2. Validate eval.yaml schema
  const evalYamlPath = path.join(absDir, "eval.yaml");
  let parsedConfig: Partial<EvalConfig> | null = null;
  if (fs.existsSync(evalYamlPath)) {
    try {
      parsedConfig = YAML.parse(fs.readFileSync(evalYamlPath, "utf8")) as Partial<EvalConfig>;
      if (!parsedConfig?.id || !parsedConfig?.spec_version || !Array.isArray(parsedConfig?.stack)) {
        issues.push({
          category: "structure",
          severity: "error",
          file: "eval.yaml",
          message: "eval.yaml must define spec_version, id, and stack[]",
        });
      }
    } catch (err) {
      issues.push({
        category: "structure",
        severity: "error",
        file: "eval.yaml",
        message: `Invalid YAML in eval.yaml: ${(err as Error).message}`,
      });
    }
  }

  // 3. Check grading/verify.sh is executable
  const verifyPath = path.join(absDir, "grading", "verify.sh");
  if (fs.existsSync(verifyPath)) {
    const mode = fs.statSync(verifyPath).mode;
    if ((mode & 0o111) === 0) {
      issues.push({
        category: "structure",
        severity: "error",
        file: "grading/verify.sh",
        message: "grading/verify.sh is not executable (run chmod +x grading/verify.sh)",
      });
    }
  }

  // 4. Check private/gold.patch is non-empty
  const patchPath = path.join(absDir, "private", "gold.patch");
  if (fs.existsSync(patchPath)) {
    const patchContent = fs.readFileSync(patchPath, "utf8").trim();
    if (!patchContent) {
      issues.push({
        category: "structure",
        severity: "error",
        file: "private/gold.patch",
        message: "private/gold.patch is empty",
      });
    }
  }

  // 5. Git history leak check inside environment/repo
  const repoDir = path.join(absDir, "environment", "repo");
  const dotGitDir = path.join(repoDir, ".git");
  if (fs.existsSync(dotGitDir)) {
    const countRes = execSyncSafe("git", ["rev-list", "--count", "--all"], { cwd: repoDir });
    const commitCount = Number.parseInt(countRes.stdout.trim(), 10);
    if (!Number.isNaN(commitCount) && commitCount > 1) {
      issues.push({
        category: "git-leak",
        severity: "error",
        file: "environment/repo/.git",
        message: `Snapshot repo contains ${commitCount} commits — squash to a single snapshot commit to avoid leaking future commits or historical secrets`,
      });
    }
    if (parsedConfig?.source?.fix_commit) {
      const fixCheck = execSyncSafe(
        "git",
        ["cat-file", "-e", `${parsedConfig.source.fix_commit}^{commit}`],
        { cwd: repoDir }
      );
      if (fixCheck.exitCode === 0) {
        issues.push({
          category: "git-leak",
          severity: "error",
          file: "environment/repo/.git",
          message: `CRITICAL: fix_commit ${parsedConfig.source.fix_commit.slice(0, 8)} exists inside environment/repo/.git!`,
        });
      }
    }
  }

  // 6. Secret & PII scan across entire bundle
  const secretScan = scanDirectoryForSecrets(absDir);
  issues.push(...secretScan.issues);

  // 7. Prompt & debrief linting
  issues.push(...lintPrompt(absDir));
  issues.push(...lintDebrief(absDir));

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  return {
    bundleDir: absDir,
    passed: errorCount === 0,
    errorCount,
    warningCount,
    filesScanned: secretScan.filesScanned,
    issues,
  };
}

export function runAudit(options: AuditOptions): number {
  const report = auditBundle(options.bundleDir);
  const failed = !report.passed || (options.strict && report.warningCount > 0);

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return failed ? 1 : 0;
  }

  printHeader(`Audit report: ${path.basename(report.bundleDir)}`);
  printInfo(`Scanned ${report.filesScanned} text file(s)`);

  if (report.issues.length === 0) {
    printPass("All checks passed — zero secrets, zero git leaks, valid structure and prompt.");
    console.log("");
    return 0;
  }

  for (const issue of report.issues) {
    const loc = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}` : "";
    const tag = `[${issue.category}]`;
    const line = `${c.dim(tag)} ${loc ? `${c.bold(loc)} — ` : ""}${issue.message}`;
    if (issue.severity === "error") {
      printFail(line);
    } else {
      printWarn(line);
    }
  }

  console.log("");
  if (failed) {
    printFail(
      `Audit FAILED (${report.errorCount} error(s), ${report.warningCount} warning(s))`
    );
    return 1;
  }

  printPass(
    `Audit PASSED with ${report.warningCount} warning(s) (pass --strict to treat warnings as errors)`
  );
  return 0;
}
