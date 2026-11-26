import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";
import { execSyncSafe } from "./exec.js";
import type { CandidateCommit } from "../types.js";

const LOCKFILE_RE =
  /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|uv\.lock|go\.sum)$/;

const TEST_FILE_RE =
  /(^|\/)(__tests__|tests?|spec|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py|rs)$/;

const BUGFIX_WORDS_RE =
  /\b(fix|bug|race|leak|crash|broken|regression|edge[- ]?case|fallback|retry|deadlock|hydration|cors|auth|webhook|timeout|revert)\b/i;

const CHORE_WORDS_RE =
  /^(chore|docs|style|ci|build|bump|release|fmt|format|lint|typo|wip|merge)\b/i;

export function assertGitRepo(repoDir: string): string {
  const res = execSyncSafe("git", ["rev-parse", "--show-toplevel"], { cwd: repoDir });
  if (res.exitCode !== 0) {
    throw new Error(`Not a git repository: ${repoDir}\n${res.stderr.trim()}`);
  }
  return res.stdout.trim();
}

export function resolveCommit(repoDir: string, ref: string): string {
  const res = execSyncSafe("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: repoDir,
  });
  if (res.exitCode !== 0) {
    throw new Error(`Unable to resolve git ref "${ref}" in ${repoDir}`);
  }
  return res.stdout.trim();
}

export function getCommitSubject(repoDir: string, ref: string): string {
  const res = execSyncSafe("git", ["log", "-1", "--pretty=%s", ref], { cwd: repoDir });
  return res.exitCode === 0 ? res.stdout.trim() : "";
}

export interface DiffSummary {
  patch: string;
  codePatch: string;
  testFiles: string[];
  codeFiles: string[];
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export function getDiffBetween(
  repoDir: string,
  baseRef: string,
  fixRef: string,
  excludeLockfiles = true
): DiffSummary {
  const numstatRes = execSyncSafe(
    "git",
    ["diff", "--numstat", baseRef, fixRef],
    { cwd: repoDir }
  );
  if (numstatRes.exitCode !== 0) {
    throw new Error(`git diff --numstat failed: ${numstatRes.stderr}`);
  }

  const allFiles: string[] = [];
  const testFiles: string[] = [];
  const codeFiles: string[] = [];
  let insertions = 0;
  let deletions = 0;

  for (const line of numstatRes.stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const ins = parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10) || 0;
    const del = parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10) || 0;
    const filePath = parts.slice(2).join("\t");

    if (excludeLockfiles && LOCKFILE_RE.test(filePath)) {
      continue;
    }

    allFiles.push(filePath);
    insertions += ins;
    deletions += del;

    if (TEST_FILE_RE.test(filePath)) {
      testFiles.push(filePath);
    } else {
      codeFiles.push(filePath);
    }
  }

  const fullPatchArgs = ["diff", "--binary", baseRef, fixRef, "--", ...allFiles];
  const fullPatchRes =
    allFiles.length > 0
      ? execSyncSafe("git", fullPatchArgs, { cwd: repoDir })
      : { exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false };

  const codePatchRes =
    codeFiles.length > 0
      ? execSyncSafe("git", ["diff", "--binary", baseRef, fixRef, "--", ...codeFiles], {
          cwd: repoDir,
        })
      : { exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false };

  return {
    patch: fullPatchRes.stdout,
    codePatch: codePatchRes.stdout,
    testFiles,
    codeFiles,
    filesChanged: allFiles.length,
    insertions,
    deletions,
  };
}

/**
 * Exports a clean snapshot of `baseRef` using `git archive` so NO future commits
 * or deleted historical secrets leak into the eval environment.
 */
export function exportCleanSnapshot(
  repoDir: string,
  baseRef: string,
  destDir: string
): { strippedFiles: string[] } {
  fs.mkdirSync(destDir, { recursive: true });

  // Write tar to temp file and extract cleanly so binary files stay intact
  const tmpTar = path.join(path.dirname(destDir), `.snapshot-${Date.now()}.tar`);
  try {
    const rawArchive = execSyncSafe(
      "git",
      ["archive", "--format=tar", "-o", tmpTar, baseRef],
      { cwd: repoDir }
    );
    if (rawArchive.exitCode !== 0) {
      throw new Error(`git archive failed for ${baseRef}: ${rawArchive.stderr}`);
    }
    const untar = execSyncSafe("tar", ["-xf", tmpTar, "-C", destDir]);
    if (untar.exitCode !== 0) {
      throw new Error(`tar extract failed: ${untar.stderr}`);
    }
  } finally {
    if (fs.existsSync(tmpTar)) fs.rmSync(tmpTar, { force: true });
  }

  // Strip sensitive env/key files if any were tracked in git
  const strippedFiles: string[] = [];
  walkFiles(destDir, (absPath, relPath) => {
    const base = path.basename(relPath);
    if (
      (/^\.env(\..+)?$/i.test(base) && !/^\.env\.(example|sample|template)$/i.test(base)) ||
      /\.(pem|key|p12|pfx)$/i.test(base) ||
      base === ".npmrc" ||
      base === ".pypirc"
    ) {
      if (/^\.env(\..+)?$/i.test(base)) {
        // Preserve variable names as .env.example if not already present
        const examplePath = path.join(path.dirname(absPath), ".env.example");
        if (!fs.existsSync(examplePath)) {
          const content = fs.readFileSync(absPath, "utf8");
          const sanitized = content
            .split("\n")
            .map((line) => {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
                return line;
              }
              const key = trimmed.slice(0, trimmed.indexOf("="));
              return `${key}=REPLACE_ME`;
            })
            .join("\n");
          fs.writeFileSync(examplePath, sanitized, "utf8");
        }
      }
      fs.rmSync(absPath, { force: true });
      strippedFiles.push(relPath);
    }
  });

  // Initialize a fresh single-commit git repo inside snapshot so agents can run `git diff`/`git status`
  execSyncSafe("git", ["init", "-q"], { cwd: destDir });
  execSyncSafe("git", ["config", "user.email", "evalkit@local"], { cwd: destDir });
  execSyncSafe("git", ["config", "user.name", "evalkit"], { cwd: destDir });
  execSyncSafe("git", ["add", "-A"], { cwd: destDir });
  execSyncSafe("git", ["commit", "-q", "-m", "Initial task snapshot"], { cwd: destDir });

  return { strippedFiles };
}

export function extractFileAtCommit(
  repoDir: string,
  ref: string,
  relPath: string
): Buffer | null {
  const res = execSyncSafe("git", ["show", `${ref}:${relPath}`], { cwd: repoDir });
  if (res.exitCode !== 0) return null;
  return Buffer.from(res.stdout, "utf8");
}

export function mineCandidateCommits(
  repoDir: string,
  limit = 100,
  top = 10
): CandidateCommit[] {
  const logRes = execSyncSafe(
    "git",
    [
      "log",
      "--no-merges",
      `-n`,
      String(limit),
      "--pretty=format:===COMMIT===%n%H|%h|%P|%cs|%s",
      "--numstat",
    ],
    { cwd: repoDir }
  );
  if (logRes.exitCode !== 0) {
    throw new Error(`git log failed: ${logRes.stderr}`);
  }

  const blocks = logRes.stdout.split("===COMMIT===\n").filter(Boolean);
  const candidates: CandidateCommit[] = [];

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const header = lines[0];
    if (!header) continue;
    const [hash, shortHash, parents, date, ...subjectParts] = header.split("|");
    const subject = subjectParts.join("|").trim();
    const parentHash = (parents || "").trim().split(" ")[0];
    if (!parentHash) continue; // skip root commit

    let filesChanged = 0;
    let insertions = 0;
    let deletions = 0;
    let touchesTests = false;
    let nonLockFiles = 0;

    for (const statLine of lines.slice(1)) {
      if (!statLine.trim()) continue;
      const parts = statLine.split("\t");
      if (parts.length < 3) continue;
      const filePath = parts.slice(2).join("\t");
      if (LOCKFILE_RE.test(filePath)) continue;
      nonLockFiles++;
      filesChanged++;
      insertions += parts[0] === "-" ? 0 : Number.parseInt(parts[0], 10) || 0;
      deletions += parts[1] === "-" ? 0 : Number.parseInt(parts[1], 10) || 0;
      if (TEST_FILE_RE.test(filePath)) touchesTests = true;
    }

    if (nonLockFiles === 0) continue;

    const totalChurn = insertions + deletions;
    if (totalChurn < 8 || totalChurn > 1800) continue; // skip 1-line typos and massive rewrites

    let score = 0;
    const reasons: string[] = [];

    if (BUGFIX_WORDS_RE.test(subject)) {
      score += 30;
      reasons.push("bugfix/edge-case signal in commit message");
    }
    if (CHORE_WORDS_RE.test(subject)) {
      score -= 25;
      reasons.push("chore/docs/style prefix penalty");
    }
    if (filesChanged >= 2 && filesChanged <= 12) {
      score += 25;
      reasons.push(`multi-file change (${filesChanged} files)`);
    } else if (filesChanged > 12) {
      score += 5;
      reasons.push(`broad change (${filesChanged} files)`);
    }
    if (totalChurn >= 25 && totalChurn <= 450) {
      score += 20;
      reasons.push(`sweet-spot diff size (+${insertions}/-${deletions})`);
    }
    if (touchesTests) {
      score += 25;
      reasons.push("includes test changes");
    }
    if (deletions >= 5 && insertions >= 10) {
      score += 10;
      reasons.push("modifies existing logic (not pure additive boilerplate)");
    }

    if (score > 10) {
      candidates.push({
        hash,
        shortHash,
        parentHash,
        date,
        subject,
        filesChanged,
        insertions,
        deletions,
        touchesTests,
        score,
        reasons,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, top);
}

export function walkFiles(
  rootDir: string,
  cb: (absPath: string, relPath: string) => void,
  ignoreDirs: Set<string> = new Set([".git", "node_modules", ".next", "dist", "__pycache__", ".venv", "target"])
): void {
  if (!fs.existsSync(rootDir)) return;
  const stack: string[] = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absPath = path.join(current, entry.name);
      const relPath = path.relative(rootDir, absPath);
      if (entry.isDirectory()) {
        if (!ignoreDirs.has(entry.name)) {
          stack.push(absPath);
        }
      } else if (entry.isFile()) {
        cb(absPath, relPath);
      }
    }
  }
}

export function computeBundleSha256(bundleDir: string): string {
  const hash = crypto.createHash("sha256");
  const files: Array<{ absPath: string; relPath: string }> = [];

  walkFiles(bundleDir, (absPath, relPath) => {
    // Exclude ephemeral verification/benchmark reports and generated cards from content hash
    if (
      relPath === path.join("private", "verify-report.json") ||
      relPath === path.join("private", "bench-report.json") ||
      relPath === "card.json" ||
      relPath.endsWith(".tar.gz")
    ) {
      return;
    }
    files.push({ absPath, relPath });
  });

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  for (const f of files) {
    hash.update(f.relPath);
    hash.update("\0");
    if (f.relPath === "eval.yaml") {
      // Exclude ownership attestation/license metadata so `pack --attest-ip`
      // does not invalidate a passing verification checksum.
      try {
        const parsed = YAML.parse(fs.readFileSync(f.absPath, "utf8")) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          const { ownership: _ignored, ...technical } = parsed;
          hash.update(JSON.stringify(technical));
        } else {
          hash.update(fs.readFileSync(f.absPath));
        }
      } catch {
        hash.update(fs.readFileSync(f.absPath));
      }
    } else {
      hash.update(fs.readFileSync(f.absPath));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "eval-task";
}
