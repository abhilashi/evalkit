import fs from "node:fs";
import path from "node:path";
import type { BlindCard } from "../types.js";
import { auditBundle } from "./audit.js";
import { computeBundleSha256 } from "../utils/git.js";
import { execSyncSafe } from "../utils/exec.js";
import { formatRangeUsd } from "../valuation/estimate.js";
import { c, printFail, printHeader, printInfo, printPass, printWarn } from "../utils/format.js";

export interface SubmitOptions {
  bundleDir: string;
  endpoint?: string;
  apiKey?: string;
  githubIssue: boolean;
  githubRepo: string;
  fullBundle: boolean;
  dryRun: boolean;
  json: boolean;
}

function buildIssueBody(card: BlindCard): string {
  const benchLines =
    card.benchmark && card.benchmark.results.length > 0
      ? card.benchmark.results
          .map(
            (r) =>
              `- **${r.agent}**: ${r.passed}/${r.trials} (${Math.round(r.pass_rate * 100)}%, avg ${r.avg_solve_ms}ms)`
          )
          .join("\n")
      : "- _Not benchmarked yet_";

  return `## Private Vault / Blind Scorecard Submission

> Submitted via \`evalkit submit --github-issue\`. Contains **only** the blind \`card.json\` metadata — zero source code or prompts are exposed publicly.

- **Task ID:** \`${card.id}\`
- **Category:** \`${card.category}\`
- **Stack:** ${card.stack.map((s) => `\`${s}\``).join(", ")}
- **Diff Complexity:** ${card.complexity.files_changed} file(s), +${card.complexity.insertions} / -${card.complexity.deletions}
- **Verification:** ${card.verification.verified ? `VERIFIED (${card.verification.gold_pass_rate}, ${card.verification.sandbox})` : "UNVERIFIED"}
- **Signal / Est. Value:** ${card.valuation ? `Tier ${card.valuation.tier} (${card.valuation.score}/100) · ${formatRangeUsd(card.valuation)}` : "_Not estimated_"}
- **IP Attestation:** ${card.ownership.author_attestation ? "Confirmed" : "Missing"} (\`${card.ownership.license}\`)
- **Bundle SHA-256:** \`${card.bundle_sha256}\`

### Benchmark Results
${benchLines}

### Raw Blind Scorecard (\`card.json\`)
\`\`\`json
${JSON.stringify(card, null, 2)}
\`\`\`
`;
}

export async function runSubmit(options: SubmitOptions): Promise<number> {
  const bundleDir = path.resolve(options.bundleDir);
  const cardPath = path.join(bundleDir, "card.json");

  if (!fs.existsSync(cardPath)) {
    throw new Error(
      `Missing card.json in ${bundleDir}. Run \`evalkit pack "${bundleDir}" --attest-ip\` first.`
    );
  }

  const card = JSON.parse(fs.readFileSync(cardPath, "utf8")) as BlindCard;

  // 1. Re-run audit gate & checksum check before anything leaves the machine
  const audit = auditBundle(bundleDir);
  if (!audit.passed) {
    throw new Error(
      `Bundle failed audit with ${audit.errorCount} error(s). Run \`evalkit audit "${bundleDir}"\` and fix errors before submitting.`
    );
  }

  const currentSha = computeBundleSha256(bundleDir);
  if (card.bundle_sha256 !== currentSha) {
    throw new Error(
      `Bundle changed since card.json was generated (checksum mismatch). Re-run \`evalkit verify\` and \`evalkit pack\`.`
    );
  }

  if (!card.ownership?.author_attestation) {
    throw new Error(
      "Missing IP ownership attestation in card.json. Re-run `evalkit pack --attest-ip`."
    );
  }

  const endpoint = options.endpoint || process.env.EVALKIT_VAULT_URL;
  const apiKey = options.apiKey || process.env.EVALKIT_API_KEY;
  const archivePath = path.join(path.dirname(bundleDir), `${card.id}.evalkit.tar.gz`);

  if (options.fullBundle && !fs.existsSync(archivePath)) {
    throw new Error(
      `Archive not found at ${archivePath}. Re-run \`evalkit pack "${bundleDir}" --attest-ip\`.`
    );
  }

  if (!options.json) {
    printHeader(`Submitting eval bundle: ${card.id}`);
    printPass(`Audit passed & checksum verified (${currentSha.slice(0, 12)})`);
    printPass(
      `Payload mode: ${options.fullBundle ? "encrypted/compressed full bundle + blind card" : "blind card.json ONLY (zero source code uploaded)"}`
    );
  }

  // Dry-run preview
  if (options.dryRun) {
    const preview = {
      dry_run: true,
      mode: options.githubIssue ? "github-issue" : endpoint ? "https-endpoint" : "preview-only",
      target: options.githubIssue ? options.githubRepo : endpoint ?? "(set --endpoint or --github-issue)",
      includes_source_code: options.fullBundle,
      card,
    };
    if (options.json) {
      console.log(JSON.stringify(preview, null, 2));
    } else {
      printWarn("Dry run — nothing was transmitted.");
      printInfo(`Target: ${preview.target}`);
      printInfo(`Stack: ${card.stack.join(", ")} | Verified: ${card.verification.verified}`);
      console.log(c.dim("\n" + JSON.stringify(card, null, 2) + "\n"));
    }
    return 0;
  }

  // Mode A: Zero-infra blind card submission via GitHub Issue
  if (options.githubIssue) {
    if (options.fullBundle) {
      throw new Error(
        "--full-bundle cannot be combined with --github-issue (never post private code to public GitHub issues)."
      );
    }
    const ghCheck = execSyncSafe("which", ["gh"], { timeoutMs: 3_000 });
    if (ghCheck.exitCode !== 0) {
      throw new Error("GitHub CLI (`gh`) is required for --github-issue submission.");
    }

    const title = `[Vault Card] ${card.id} (${card.stack.slice(0, 3).join(", ")})`;
    const body = buildIssueBody(card);
    const res = execSyncSafe(
      "gh",
      ["issue", "create", "--repo", options.githubRepo, "--title", title, "--body", body],
      { timeoutMs: 30_000 }
    );
    if (res.exitCode !== 0) {
      throw new Error(`gh issue create failed: ${res.stderr.trim()}`);
    }

    const issueUrl = res.stdout.trim();
    if (options.json) {
      console.log(JSON.stringify({ submitted: true, mode: "github-issue", url: issueUrl, card }, null, 2));
    } else {
      printPass(`Blind scorecard submitted → ${issueUrl}`);
      console.log("");
    }
    return 0;
  }

  // Mode B: Vault HTTPS API submission (Cloudflare Worker / Private Vault server)
  if (!endpoint) {
    throw new Error(
      "No submission target specified. Pass `--github-issue` (blind card only), `--endpoint <url>` (or set EVALKIT_VAULT_URL), or `--dry-run` to preview."
    );
  }

  const headers: Record<string, string> = {
    "User-Agent": "evalkit-cli/0.3.0",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  let response: Response;
  if (options.fullBundle) {
    const form = new FormData();
    form.append("card", JSON.stringify(card));
    const archiveBytes = fs.readFileSync(archivePath);
    form.append(
      "bundle",
      new Blob([archiveBytes], { type: "application/gzip" }),
      path.basename(archivePath)
    );
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: form,
    });
  } else {
    headers["Content-Type"] = "application/json";
    response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ card }),
    });
  }

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Vault endpoint returned HTTP ${response.status}: ${responseText.slice(0, 300)}`);
  }

  let parsedResp: unknown = responseText;
  try {
    parsedResp = JSON.parse(responseText);
  } catch {
    // plain text response is fine
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          submitted: true,
          mode: options.fullBundle ? "https-full-bundle" : "https-blind-card",
          endpoint,
          status: response.status,
          response: parsedResp,
        },
        null,
        2
      )
    );
  } else {
    printPass(`Submitted successfully to ${endpoint} (HTTP ${response.status})`);
    console.log("");
  }

  return 0;
}
