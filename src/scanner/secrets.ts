import fs from "node:fs";
import path from "node:path";
import type { AuditIssue } from "../types.js";
import { walkFiles } from "../utils/git.js";

interface SecretRule {
  id: string;
  regex: RegExp;
  severity: "error" | "warning";
  category: "secret" | "pii";
  description: string;
}

const SECRET_RULES: SecretRule[] = [
  {
    id: "private-key",
    regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
    severity: "error",
    category: "secret",
    description: "Private key material detected",
  },
  {
    id: "openai-key",
    regex: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/,
    severity: "error",
    category: "secret",
    description: "Possible OpenAI API key",
  },
  {
    id: "anthropic-key",
    regex: /\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{20,}\b/,
    severity: "error",
    category: "secret",
    description: "Possible Anthropic API key",
  },
  {
    id: "stripe-live-key",
    regex: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/,
    severity: "error",
    category: "secret",
    description: "Stripe live secret/restricted key",
  },
  {
    id: "stripe-webhook-secret",
    regex: /\bwhsec_[0-9a-zA-Z]{24,}\b/,
    severity: "error",
    category: "secret",
    description: "Stripe webhook signing secret",
  },
  {
    id: "aws-access-key",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    severity: "error",
    category: "secret",
    description: "AWS access key ID",
  },
  {
    id: "github-token",
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
    severity: "error",
    category: "secret",
    description: "GitHub personal access token",
  },
  {
    id: "google-api-key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/,
    severity: "error",
    category: "secret",
    description: "Google API key",
  },
  {
    id: "slack-token",
    regex: /\bxox[baprs]-[0-9A-Za-z-]{15,}\b/,
    severity: "error",
    category: "secret",
    description: "Slack token",
  },
  {
    id: "jwt-token",
    regex: /\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}\b/,
    severity: "error",
    category: "secret",
    description: "Hardcoded JWT token (e.g., Supabase service role or auth token)",
  },
  {
    id: "db-url-with-password",
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s'"]+:(?!REPLACE_ME|password|postgres|test|dummy|local|example)[^@\s'"]{6,}@(?!localhost\b|127\.0\.0\.1\b|postgres\b|db\b|redis\b)[^\s'"]+/,
    severity: "error",
    category: "secret",
    description: "Remote database connection string with credentials",
  },
  {
    id: "local-abs-path",
    regex: /(?:\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/|C:\\Users\\[A-Za-z0-9._-]+\\)/,
    severity: "warning",
    category: "pii",
    description: "Hardcoded local user directory path (may leak username or break portability)",
  },
];

const GENERIC_ASSIGNMENT_RE =
  /(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|signing[_-]?secret)\s*[:=]\s*['"]([A-Za-z0-9_/+=-]{20,})['"]/i;

const PLACEHOLDER_RE =
  /(example|dummy|sample|test|mock|fake|placeholder|replace_me|your_|xxx|000000|123456|changeme|localhost)/i;

const BINARY_EXT_RE =
  /\.(png|jpg|jpeg|gif|webp|ico|pdf|woff2?|ttf|eot|zip|tar|gz|zst|mp4|mp3|wav|sqlite|db|wasm)$/i;

function shannonEntropy(str: string): number {
  const counts = new Map<string, number>();
  for (const ch of str) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function maskSnippet(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= 80) return trimmed;
  return `${trimmed.slice(0, 77)}...`;
}

export function scanDirectoryForSecrets(rootDir: string): {
  filesScanned: number;
  issues: AuditIssue[];
} {
  const issues: AuditIssue[] = [];
  let filesScanned = 0;

  walkFiles(rootDir, (absPath, relPath) => {
    if (BINARY_EXT_RE.test(relPath)) return;
    if (relPath.endsWith(".tar.gz")) return;

    const stat = fs.statSync(absPath);
    if (stat.size > 2 * 1024 * 1024) return; // skip huge files > 2MB

    const raw = fs.readFileSync(absPath);
    // Quick binary check (NUL byte in first 4KB)
    const probeLen = Math.min(raw.length, 4096);
    for (let i = 0; i < probeLen; i++) {
      if (raw[i] === 0) return;
    }

    filesScanned++;
    const content = raw.toString("utf8");
    const lines = content.split("\n");

    const baseName = path.basename(relPath);
    if (/^\.env(\..+)?$/i.test(baseName) && !/^\.env\.(example|sample|template)$/i.test(baseName)) {
      issues.push({
        category: "secret",
        severity: "error",
        file: relPath,
        message: `Live env file "${baseName}" must be stripped before packing`,
      });
    }

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      const lineNo = idx + 1;

      for (const rule of SECRET_RULES) {
        const match = rule.regex.exec(line);
        if (!match) continue;
        if (rule.category === "secret" && PLACEHOLDER_RE.test(match[0])) continue;

        issues.push({
          category: rule.category,
          severity: rule.severity,
          file: relPath,
          line: lineNo,
          message: `${rule.description} (${rule.id}): ${maskSnippet(line)}`,
        });
      }

      const genericMatch = GENERIC_ASSIGNMENT_RE.exec(line);
      if (genericMatch) {
        const candidateValue = genericMatch[1];
        if (!PLACEHOLDER_RE.test(candidateValue) && shannonEntropy(candidateValue) >= 3.8) {
          issues.push({
            category: "secret",
            severity: "error",
            file: relPath,
            line: lineNo,
            message: `High-entropy secret assignment detected: ${maskSnippet(line)}`,
          });
        }
      }
    }
  });

  return { filesScanned, issues };
}
