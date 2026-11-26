import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { EvalConfig, TaskCategory } from "../types.js";
import {
  assertGitRepo,
  exportCleanSnapshot,
  extractFileAtCommit,
  getCommitSubject,
  getDiffBetween,
  resolveCommit,
  slugify,
} from "../utils/git.js";
import { detectStack, generateDockerfile, generateVerifyScript } from "../docker/detect.js";
import { scanDirectoryForSecrets } from "../scanner/secrets.js";
import { c, printHeader, printInfo, printPass, printWarn } from "../utils/format.js";

export interface InitOptions {
  repo: string;
  from: string;
  to: string;
  out?: string;
  id?: string;
  category: TaskCategory;
  extractTests: boolean;
  force: boolean;
}

export function runInit(options: InitOptions): number {
  const repoRoot = assertGitRepo(path.resolve(options.repo));
  const baseCommit = resolveCommit(repoRoot, options.from);
  const fixCommit = resolveCommit(repoRoot, options.to);

  if (baseCommit === fixCommit) {
    throw new Error(`--from (${options.from}) and --to (${options.to}) resolve to the same commit.`);
  }

  const subject = getCommitSubject(repoRoot, fixCommit) || "Untitled task";
  const id = slugify(options.id || `${path.basename(repoRoot)}-${subject}`);
  const outDir = path.resolve(options.out || path.join(process.cwd(), "evals", id));

  if (fs.existsSync(outDir)) {
    if (!options.force) {
      throw new Error(`Output directory already exists: ${outDir} (pass --force to overwrite)`);
    }
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  printHeader(`Initializing eval bundle: ${id}`);

  const diff = getDiffBetween(repoRoot, baseCommit, fixCommit, true);
  if (diff.filesChanged === 0) {
    throw new Error("No non-lockfile changes found between --from and --to.");
  }

  const envDir = path.join(outDir, "environment");
  const repoSnapshotDir = path.join(envDir, "repo");
  const mocksDir = path.join(envDir, "mocks");
  const gradingDir = path.join(outDir, "grading");
  const gradingTestsDir = path.join(gradingDir, "tests");
  const privateDir = path.join(outDir, "private");

  fs.mkdirSync(mocksDir, { recursive: true });
  fs.mkdirSync(gradingTestsDir, { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true });

  // 1. Clean snapshot at base_commit (no git history leak, stripped secrets)
  const { strippedFiles } = exportCleanSnapshot(repoRoot, baseCommit, repoSnapshotDir);
  printPass(`Exported clean snapshot at ${baseCommit.slice(0, 8)} (single-commit history, zero future leaks)`);
  if (strippedFiles.length > 0) {
    printWarn(`Stripped ${strippedFiles.length} sensitive file(s): ${strippedFiles.join(", ")}`);
  }

  // 2. Detect stack from snapshot
  const stack = detectStack(repoSnapshotDir);
  printPass(`Detected stack: ${stack.tags.join(", ")}`);
  if (stack.externalServices.length > 0) {
    printWarn(
      `Detected external API dependencies (${stack.externalServices.join(", ")}). Add offline stubs in environment/mocks/ so --network=none passes.`
    );
  }

  // 3. Separate gold patch vs hidden test files
  const extractedTestFiles: string[] = [];
  if (options.extractTests && diff.testFiles.length > 0 && diff.codeFiles.length > 0) {
    for (const relTest of diff.testFiles) {
      const content = extractFileAtCommit(repoRoot, fixCommit, relTest);
      if (content !== null) {
        const dest = path.join(gradingTestsDir, relTest);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, content);
        extractedTestFiles.push(relTest);
      }
    }
    fs.writeFileSync(path.join(privateDir, "gold.patch"), diff.codePatch, "utf8");
    printPass(
      `Extracted ${extractedTestFiles.length} test file(s) into grading/tests/ and saved code-only private/gold.patch`
    );
  } else {
    fs.writeFileSync(path.join(privateDir, "gold.patch"), diff.patch, "utf8");
    if (diff.testFiles.length === 0) {
      printWarn("No test files changed in this diff — author deterministic fail-to-pass tests in grading/tests/");
    } else {
      printPass("Saved private/gold.patch");
    }
  }

  // 4. Write eval.yaml
  const config: EvalConfig = {
    spec_version: "0.1",
    id,
    title: subject,
    stack: stack.tags,
    category: options.category,
    source: {
      base_commit: baseCommit,
      fix_commit: fixCommit,
      captured_at: new Date().toISOString(),
      files_changed: diff.filesChanged,
      insertions: diff.insertions,
      deletions: diff.deletions,
    },
    timeouts: {
      solve_sec: 1200,
      verify_sec: 180,
    },
    grading: {
      type: "deterministic",
      network_access: false,
      flakiness_runs: 3,
    },
    ownership: {
      author_attestation: false,
      license: "private-vault",
    },
  };
  fs.writeFileSync(path.join(outDir, "eval.yaml"), YAML.stringify(config), "utf8");

  // 5. Write Dockerfile & mocks README
  fs.writeFileSync(path.join(envDir, "Dockerfile"), generateDockerfile(stack), "utf8");
  fs.writeFileSync(
    path.join(mocksDir, "README.md"),
    `# Offline Mocks & Fixtures

Containers run under \`--network=none\` during solving and grading.
Place local HTTP mocks, seed SQL scripts, or Playwright route fixtures here.

${
  stack.externalServices.length > 0
    ? `Detected external services to stub: ${stack.externalServices.join(", ")}\n`
    : "No third-party SaaS SDKs auto-detected.\n"
}`,
    "utf8"
  );

  // 6. Write grading/verify.sh + grading/rubric.yaml
  const verifyPath = path.join(gradingDir, "verify.sh");
  fs.writeFileSync(verifyPath, generateVerifyScript(stack, extractedTestFiles), "utf8");
  fs.chmodSync(verifyPath, 0o755);

  const rubric = {
    version: "0.1",
    criteria: [
      {
        id: "functional-correctness",
        weight: 0.7,
        description: "All hidden fail-to-pass verification assertions succeed deterministically offline.",
      },
      {
        id: "no-regressions",
        weight: 0.2,
        description: "Existing behavior and regression tests remain green.",
      },
      {
        id: "root-cause-fix",
        weight: 0.1,
        description: "Addresses the underlying root cause rather than hardcoding test inputs or bypassing checks.",
      },
    ],
  };
  fs.writeFileSync(path.join(gradingDir, "rubric.yaml"), YAML.stringify(rubric), "utf8");

  // 7. Write prompt.md template (with explicit EVALKIT TODO markers so audit catches unfilled prompts!)
  const promptTemplate = `# Task: ${subject}

<!-- EVALKIT: Replace every TODO below with clear, user-visible behavior & exact contracts.
     NEVER leak internal filenames, variable names, or line-level solution hints from gold.patch.
     EVERY assertion checked in grading/tests/ MUST be unambiguously stated here. -->

## Problem Statement

TODO: Describe the user-visible bug, failing workflow, or feature requirement in plain language.

## Expected Behavior

- TODO: State exact observable behavior, API contracts, status codes, return shapes, or UI states.
- TODO: Specify edge cases that the hidden verification tests enforce.

## Constraints

- Do not break existing functionality or tests.
- All code and tests must work without external network access.
`;
  fs.writeFileSync(path.join(outDir, "prompt.md"), promptTemplate, "utf8");

  // 8. Write private/debrief.md template
  const debriefTemplate = `# Frontier Failure Debrief: ${id}

<!-- EVALKIT: Fill this out in ~90 seconds while context is fresh.
     This file stays strictly in private/ and is never shown to evaluated agents. -->

## 1. Root Cause & Non-Obvious Trap
TODO: What was the actual root cause, and why was it harder than it looked?

## 2. Naive Fixes That Fail
TODO: What plausible first-pass fixes break subtle edge cases?

## 3. Where AI Coding Agents Got Stuck (if captured live)
TODO: Which models/agents tried this, what loop or hallucination did they hit, and what unblocked it?
`;
  fs.writeFileSync(path.join(privateDir, "debrief.md"), debriefTemplate, "utf8");

  // 9. Write private/metadata.json
  fs.writeFileSync(
    path.join(privateDir, "metadata.json"),
    JSON.stringify(
      {
        id,
        source_repo_name: path.basename(repoRoot),
        base_commit: baseCommit,
        fix_commit: fixCommit,
        commit_subject: subject,
        code_files: diff.codeFiles,
        test_files: diff.testFiles,
        extracted_test_files: extractedTestFiles,
        stack,
      },
      null,
      2
    ),
    "utf8"
  );

  // 10. Quick immediate secret scan warning
  const scan = scanDirectoryForSecrets(outDir);
  const secretErrors = scan.issues.filter((i) => i.category === "secret" && i.severity === "error");
  if (secretErrors.length > 0) {
    printWarn(
      `Initial secret scan found ${secretErrors.length} potential secret(s)! Run ${c.bold(`evalkit audit "${outDir}"`)} to inspect and scrub them.`
    );
  }

  printHeader("Next steps");
  printInfo(`Bundle created at: ${outDir}`);
  printInfo(`1. Refine ${c.bold("prompt.md")}, ${c.bold("grading/tests/")}, ${c.bold("grading/verify.sh")}, and ${c.bold("private/debrief.md")}`);
  printInfo(`2. Run ${c.bold(`evalkit audit "${outDir}"`)} to verify zero secrets/leaks`);
  printInfo(`3. Run ${c.bold(`evalkit verify "${outDir}"`)} to prove base fails & gold passes 3/3`);
  console.log("");

  return 0;
}
