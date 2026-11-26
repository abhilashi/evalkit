import fs from "node:fs";
import path from "node:path";
import type { AuditIssue } from "../types.js";

const PLACEHOLDER_PATTERNS = [
  /\bTODO:/i,
  /\bTBD\b/,
  /<!--\s*EVALKIT:/i,
  /\[DESCRIBE\b/i,
  /\[REPLACE\b/i,
];

/**
 * Checks prompt.md for unfilled scaffolding placeholders, vague brevity,
 * and accidental code-diff leaks copied straight out of gold.patch.
 */
export function lintPrompt(bundleDir: string): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const promptPath = path.join(bundleDir, "prompt.md");
  const patchPath = path.join(bundleDir, "private", "gold.patch");

  if (!fs.existsSync(promptPath)) {
    issues.push({
      category: "structure",
      severity: "error",
      file: "prompt.md",
      message: "Missing required prompt.md",
    });
    return issues;
  }

  const promptText = fs.readFileSync(promptPath, "utf8");
  const lines = promptText.split("\n");

  for (let i = 0; i < lines.length; i++) {
    for (const pat of PLACEHOLDER_PATTERNS) {
      if (pat.test(lines[i])) {
        issues.push({
          category: "prompt-leak",
          severity: "error",
          file: "prompt.md",
          line: i + 1,
          message: `Unfilled template placeholder in prompt.md: "${lines[i].trim()}"`,
        });
        break;
      }
    }
  }

  const strippedWords = promptText.replace(/[#>*`_\-\n]+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (strippedWords.length < 30) {
    issues.push({
      category: "prompt-leak",
      severity: "warning",
      file: "prompt.md",
      message: `prompt.md is very short (${strippedWords.length} words) — likely underspecified for reliable agent evaluation`,
    });
  }

  // Check if substantial added lines from gold.patch appear verbatim inside prompt.md
  if (fs.existsSync(patchPath)) {
    const patchText = fs.readFileSync(patchPath, "utf8");
    const addedCodeLines = patchText
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1).trim())
      .filter((l) => l.length >= 28 && !/^(\/\/|\/\*|\*|#|\}|import\b|from\b)/.test(l));

    let leakedLines = 0;
    for (const codeLine of addedCodeLines) {
      if (promptText.includes(codeLine)) {
        leakedLines++;
        if (leakedLines <= 3) {
          issues.push({
            category: "prompt-leak",
            severity: "warning",
            file: "prompt.md",
            message: `prompt.md contains a verbatim added line from gold.patch: "${codeLine.slice(0, 70)}"`,
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Checks that debrief.md doesn't still contain unfilled placeholders.
 */
export function lintDebrief(bundleDir: string): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const debriefPath = path.join(bundleDir, "private", "debrief.md");
  if (!fs.existsSync(debriefPath)) {
    issues.push({
      category: "structure",
      severity: "warning",
      file: "private/debrief.md",
      message: "Missing private/debrief.md (recommended for high-value frontier failure context)",
    });
    return issues;
  }

  const text = fs.readFileSync(debriefPath, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const pat of PLACEHOLDER_PATTERNS) {
      if (pat.test(lines[i])) {
        issues.push({
          category: "structure",
          severity: "warning",
          file: "private/debrief.md",
          line: i + 1,
          message: `Unfilled debrief placeholder: "${lines[i].trim()}"`,
        });
        break;
      }
    }
  }
  return issues;
}
