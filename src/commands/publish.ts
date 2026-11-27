import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type {
  BenchReport,
  BlindCard,
  EvalConfig,
  PublishedTraceEntry,
  VerifyReport,
} from "../types.js";
import { auditBundle } from "./audit.js";
import { computeBundleSha256 } from "../utils/git.js";
import { execSyncSafe } from "../utils/exec.js";
import {
  checkHasDetailedDebrief,
  estimateBundleValue,
  formatRangeUsd,
} from "../valuation/estimate.js";
import { c, printHeader, printInfo, printPass, printWarn } from "../utils/format.js";

export interface PublishOptions {
  bundleDir: string;
  board: boolean;
  boardRepo: string;
  gist: boolean;
  outFile?: string;
  author?: string;
  dryRun: boolean;
  json: boolean;
}

/**
 * Builds a strictly blind trace entry.
 * Source code, prompts, diffs, debrief prose, and raw stdout/stderr are NEVER included.
 */
export function buildPublishedTrace(
  bundleDir: string,
  author?: string
): PublishedTraceEntry {
  const absDir = path.resolve(bundleDir);
  const evalYamlPath = path.join(absDir, "eval.yaml");
  if (!fs.existsSync(evalYamlPath)) {
    throw new Error(`Missing eval.yaml in ${absDir}`);
  }
  const config = YAML.parse(fs.readFileSync(evalYamlPath, "utf8")) as EvalConfig;
  const bundleSha = computeBundleSha256(absDir);

  let verifyReport: VerifyReport | null = null;
  const verifyPath = path.join(absDir, "private", "verify-report.json");
  if (fs.existsSync(verifyPath)) {
    try {
      verifyReport = JSON.parse(fs.readFileSync(verifyPath, "utf8")) as VerifyReport;
    } catch {
      verifyReport = null;
    }
  }
  const verifyValid = Boolean(
    verifyReport && verifyReport.passed && verifyReport.bundle_sha256 === bundleSha
  );

  let benchReport: BenchReport | null = null;
  const benchPath = path.join(absDir, "private", "bench-report.json");
  if (fs.existsSync(benchPath)) {
    try {
      benchReport = JSON.parse(fs.readFileSync(benchPath, "utf8")) as BenchReport;
    } catch {
      benchReport = null;
    }
  }
  const benchValid = Boolean(benchReport && benchReport.bundle_sha256 === bundleSha);

  let valuation = estimateBundleValue({
    config,
    verifyReport,
    verifyMatchesChecksum: verifyValid,
    benchReport,
    benchMatchesChecksum: benchValid,
    hasDetailedDebrief: checkHasDetailedDebrief(absDir),
  });
  const cardPath = path.join(absDir, "card.json");
  if (fs.existsSync(cardPath)) {
    try {
      const card = JSON.parse(fs.readFileSync(cardPath, "utf8")) as BlindCard;
      if (card.bundle_sha256 === bundleSha && card.valuation) {
        valuation = card.valuation;
      }
    } catch {
      // fallback to computed valuation
    }
  }

  const agents = (benchValid && benchReport ? benchReport.agents : []).map((a) => ({
    agent: a.agent,
    passed: a.passed,
    trials: a.trials,
    pass_rate: a.pass_rate,
    avg_solve_ms: a.avg_solve_ms,
    avg_insertions: a.avg_insertions,
    avg_deletions: a.avg_deletions,
    trials_detail: a.results.map((r) => ({
      trial: r.trial,
      passed: r.passed,
      solve_duration_ms: r.solve_duration_ms,
      grade_duration_ms: r.grade_duration_ms,
      files_changed: r.files_changed,
      insertions: r.insertions,
      deletions: r.deletions,
      failure_class: r.failure_class ?? (r.passed ? "PASS" : "TEST_FAILURE"),
    })),
  }));

  return {
    spec_version: config.spec_version,
    id: config.id,
    visibility: "blind",
    published_at: new Date().toISOString(),
    ...(author ? { author } : {}),
    stack: config.stack,
    category: config.category,
    complexity: {
      files_changed: config.source?.files_changed ?? 0,
      insertions: config.source?.insertions ?? 0,
      deletions: config.source?.deletions ?? 0,
    },
    verification: {
      verified: verifyValid,
      sandbox: verifyValid && verifyReport ? verifyReport.sandbox : "unverified",
      network_isolated: verifyValid && verifyReport ? verifyReport.network_isolated : false,
      gold_pass_rate:
        verifyValid && verifyReport
          ? `${verifyReport.gold_checks.runs_passed}/${verifyReport.gold_checks.runs_requested}`
          : "0/0",
      verified_at: verifyValid && verifyReport ? verifyReport.verified_at : null,
    },
    valuation,
    bundle_sha256: bundleSha,
    license: config.ownership?.license ?? "private-vault",
    agents,
  };
}

function renderBlindTraceMarkdown(entry: PublishedTraceEntry): string {
  const agentRows =
    entry.agents.length > 0
      ? entry.agents
          .map((a) => {
            const pct = Math.round(a.pass_rate * 100);
            const classes = Array.from(new Set(a.trials_detail.map((t) => t.failure_class))).join(", ");
            return `| \`${a.agent}\` | ${a.passed}/${a.trials} (${pct}%) | ${a.avg_solve_ms}ms | +${a.avg_insertions} / -${a.avg_deletions} | \`${classes}\` |`;
          })
          .join("\n")
      : "| _No benchmark runs recorded_ | - | - | - | - |";

  const valLine = entry.valuation
    ? `Tier **${entry.valuation.tier}** (${entry.valuation.score}/100) · ${formatRangeUsd(entry.valuation)}`
    : "_Not estimated_";

  return `## evalkit Blind Trace: \`${entry.id}\`

> Blind Trace only: zero source code, prompts, diffs, or raw stdout are published, keeping this eval uncontaminated.

- **Visibility:** \`blind\`
- **Stack:** ${entry.stack.map((s) => `\`${s}\``).join(", ")}
- **Category:** \`${entry.category}\`
- **Complexity:** ${entry.complexity.files_changed} file(s), +${entry.complexity.insertions} / -${entry.complexity.deletions}
- **Verification:** ${entry.verification.verified ? `VERIFIED (${entry.verification.gold_pass_rate}, ${entry.verification.sandbox})` : "UNVERIFIED"}
- **Signal / Est. Value:** ${valLine}
- **Bundle SHA-256:** \`${entry.bundle_sha256}\`

### Blind Agent Execution Telemetry

| Agent | Pass Rate | Avg Solve | Avg Diff | Outcomes |
| :--- | :--- | :--- | :--- | :--- |
${agentRows}

<!-- EVALKIT_BOARD_JSON_START -->
\`\`\`json
${JSON.stringify(entry, null, 2)}
\`\`\`
<!-- EVALKIT_BOARD_JSON_END -->
`;
}

export function runPublish(options: PublishOptions): number {
  const absDir = path.resolve(options.bundleDir);
  const evalYamlPath = path.join(absDir, "eval.yaml");
  if (!fs.existsSync(evalYamlPath)) {
    throw new Error(`Missing eval.yaml in ${absDir}`);
  }

  // Enforce audit gate before publishing anywhere
  const audit = auditBundle(absDir);
  if (!audit.passed) {
    throw new Error(
      `Bundle failed audit with ${audit.errorCount} error(s). Run \`evalkit audit "${absDir}"\` first.`
    );
  }

  const entry = buildPublishedTrace(absDir, options.author);
  const markdown = renderBlindTraceMarkdown(entry);

  if (options.outFile) {
    const outPath = path.resolve(options.outFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    if (outPath.endsWith(".md")) {
      fs.writeFileSync(outPath, markdown, "utf8");
    } else {
      fs.writeFileSync(outPath, JSON.stringify(entry, null, 2), "utf8");
    }
    if (!options.json) {
      printPass(`Wrote blind trace artifact → ${path.relative(process.cwd(), outPath)}`);
    }
  }

  if (options.dryRun) {
    if (options.json) {
      console.log(JSON.stringify({ dry_run: true, entry }, null, 2));
    } else {
      printHeader(`Blind trace preview: ${entry.id}`);
      printWarn("Dry run — nothing was uploaded. Zero source code, diffs, or prompts included.");
      printInfo(
        `Agents: ${entry.agents.map((a) => `${a.agent}=${a.passed}/${a.trials}`).join(", ") || "none"}`
      );
      printInfo(`Size: ${Buffer.byteLength(markdown, "utf8")} bytes`);
      console.log(c.dim("\n" + JSON.stringify(entry, null, 2).slice(0, 1200) + "\n"));
    }
    return 0;
  }

  if (options.gist) {
    const ghCheck = execSyncSafe("which", ["gh"], { timeoutMs: 3_000 });
    if (ghCheck.exitCode !== 0) {
      throw new Error("GitHub CLI (`gh`) is required for --gist publishing.");
    }
    const tmpFile = path.join(os.tmpdir(), `evalkit-blind-trace-${entry.id}-${Date.now()}.md`);
    try {
      fs.writeFileSync(tmpFile, markdown, "utf8");
      const gistRes = execSyncSafe(
        "gh",
        [
          "gist",
          "create",
          "--public",
          "--desc",
          `evalkit blind trace: ${entry.id}`,
          tmpFile,
        ],
        { timeoutMs: 30_000 }
      );
      if (gistRes.exitCode !== 0) {
        throw new Error(`gh gist create failed: ${gistRes.stderr.trim()}`);
      }
      const gistUrl = gistRes.stdout.trim();
      if (options.json) {
        console.log(JSON.stringify({ published: true, target: "gist", url: gistUrl, entry }, null, 2));
      } else {
        printPass(`Published blind trace Gist → ${gistUrl}`);
      }
      return 0;
    } finally {
      if (fs.existsSync(tmpFile)) fs.rmSync(tmpFile, { force: true });
    }
  }

  if (options.board) {
    const ghCheck = execSyncSafe("which", ["gh"], { timeoutMs: 3_000 });
    if (ghCheck.exitCode !== 0) {
      throw new Error("GitHub CLI (`gh`) is required for --board publishing.");
    }
    const title = `[Board] ${entry.id} (blind · ${entry.stack.slice(0, 3).join(", ")})`;
    const res = execSyncSafe(
      "gh",
      [
        "issue",
        "create",
        "--repo",
        options.boardRepo,
        "--label",
        "evalkit-board",
        "--title",
        title,
        "--body",
        markdown,
      ],
      { timeoutMs: 30_000 }
    );
    if (res.exitCode !== 0) {
      throw new Error(`Publishing to board failed: ${res.stderr.trim()}`);
    }
    const issueUrl = res.stdout.trim();
    const boardLink = `https://${options.boardRepo.split("/")[0]}.github.io/${options.boardRepo.split("/")[1]}/#task=${encodeURIComponent(entry.id)}`;
    if (options.json) {
      console.log(
        JSON.stringify(
          { published: true, target: "board", issue_url: issueUrl, board_url: boardLink, entry },
          null,
          2
        )
      );
    } else {
      printHeader(`Published blind trace to evalkit Board`);
      printPass(`GitHub Board Issue → ${issueUrl}`);
      printPass(`Live Board Link    → ${boardLink}`);
      console.log("");
    }
    return 0;
  }

  if (!options.outFile) {
    if (options.json) {
      console.log(JSON.stringify({ published: false, entry }, null, 2));
    } else {
      printHeader(`Built blind trace for ${entry.id}`);
      printInfo("Pass `--board` (publish to live GitHub Pages board), `--gist` (create shareable Gist), or `--out <file.json|md>` to save locally.");
      console.log("");
    }
  }
  return 0;
}
