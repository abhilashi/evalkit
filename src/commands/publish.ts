import crypto from "node:crypto";
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
  agentAlias?: string;
  agentRig?: string;
  operator?: string;
  board: boolean;
  boardRepo: string;
  gist: boolean;
  outFile?: string;
  dryRun: boolean;
  json: boolean;
}

const ADJECTIVES = [
  "neon",
  "cobalt",
  "obsidian",
  "quantum",
  "velvet",
  "crimson",
  "astral",
  "kinetic",
  "silent",
  "iron",
  "hyper",
  "solar",
];

const NOUNS = [
  "warden",
  "fox",
  "falcon",
  "sentinel",
  "cipher",
  "spark",
  "vector",
  "oracle",
  "ghost",
  "runner",
  "nexus",
  "pulse",
];

/**
 * Generates or loads a persistent pseudonymous agent alias stored in ~/.evalkit/agent.json
 * so developers keep a consistent Agent identity on the social board without exposing their real GitHub name.
 */
export function resolveOrCreateAgentAlias(explicitAlias?: string): string {
  const cleaned = explicitAlias
    ?.replace(/^@/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (cleaned) return cleaned;

  const configPath = path.join(os.homedir(), ".evalkit", "agent.json");
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        agent_alias?: string;
      };
      if (parsed.agent_alias && /^[a-z0-9_-]{2,32}$/i.test(parsed.agent_alias)) {
        return parsed.agent_alias;
      }
    } catch {
      // ignore corrupted config
    }
  }

  const bytes = crypto.randomBytes(3);
  const adj = ADJECTIVES[bytes[0] % ADJECTIVES.length];
  const noun = NOUNS[bytes[1] % NOUNS.length];
  const num = String(bytes[2] % 100).padStart(2, "0");
  const generated = `${adj}-${noun}-${num}`;

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ agent_alias: generated, created_at: new Date().toISOString() }, null, 2),
      "utf8"
    );
  } catch {
    // non-fatal if home dir is read-only
  }

  return generated;
}

/**
 * Builds a strictly blind trace entry.
 * Source code, prompts, diffs, debrief prose, and raw stdout/stderr are NEVER included.
 */
export function buildPublishedTrace(
  bundleDir: string,
  meta: { agentAlias?: string; agentRig?: string; operator?: string } = {}
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

  const agentAlias = resolveOrCreateAgentAlias(meta.agentAlias);
  const cleanedOperator = meta.operator?.replace(/^@/, "").trim() || undefined;
  const openForVault =
    config.ownership?.vault_open ?? config.ownership?.license === "private-vault";

  return {
    spec_version: config.spec_version,
    id: config.id,
    visibility: "blind",
    published_at: new Date().toISOString(),
    agent_alias: agentAlias,
    ...(meta.agentRig ? { agent_rig: meta.agentRig.trim() } : {}),
    ...(cleanedOperator ? { operator: cleanedOperator } : {}),
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
    vault: {
      open_for_licensing: openForVault,
      ...(config.ownership?.reserve_non_exclusive_usd !== undefined
        ? { reserve_non_exclusive_usd: config.ownership.reserve_non_exclusive_usd }
        : {}),
      ...(config.ownership?.reserve_exclusive_usd !== undefined
        ? { reserve_exclusive_usd: config.ownership.reserve_exclusive_usd }
        : {}),
      ...(config.ownership?.allow_rl_training !== undefined
        ? { allow_rl_training: config.ownership.allow_rl_training }
        : {}),
    },
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

- **Agent Alias:** \`@${entry.agent_alias}\`${entry.agent_rig ? ` (${entry.agent_rig})` : ""}${entry.operator ? ` · operator: \`@${entry.operator}\`` : ""}
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

  const audit = auditBundle(absDir);
  if (!audit.passed) {
    throw new Error(
      `Bundle failed audit with ${audit.errorCount} error(s). Run \`evalkit audit "${absDir}"\` first.`
    );
  }

  const entry = buildPublishedTrace(absDir, {
    agentAlias: options.agentAlias,
    agentRig: options.agentRig,
    operator: options.operator,
  });
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
      printHeader(`Blind trace preview: ${entry.id} by @${entry.agent_alias}`);
      printWarn("Dry run — nothing was uploaded. Zero source code, diffs, or prompts included.");
      printInfo(
        `Agents tested: ${entry.agents.map((a) => `${a.agent}=${a.passed}/${a.trials}`).join(", ") || "none"}`
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
          `evalkit blind trace (@${entry.agent_alias}): ${entry.id}`,
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
        printPass(`Published blind trace Gist (@${entry.agent_alias}) → ${gistUrl}`);
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
    const title = `[Board] @${entry.agent_alias} · ${entry.id} (${entry.stack.slice(0, 3).join(", ")})`;
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
    const [owner, repo] = options.boardRepo.split("/");
    const boardLink = `https://${owner}.github.io/${repo}/#task=${encodeURIComponent(entry.id)}`;
    const agentLink = `https://${owner}.github.io/${repo}/#agent=${encodeURIComponent(entry.agent_alias)}`;
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            published: true,
            target: "board",
            issue_url: issueUrl,
            board_url: boardLink,
            agent_url: agentLink,
            entry,
          },
          null,
          2
        )
      );
    } else {
      printHeader(`Published blind trace by @${entry.agent_alias}`);
      printPass(`GitHub Board Post  → ${issueUrl}`);
      printPass(`Live Trophy Link   → ${boardLink}`);
      printPass(`Agent Profile Link → ${agentLink}`);
      console.log("");
    }
    return 0;
  }

  if (!options.outFile) {
    if (options.json) {
      console.log(JSON.stringify({ published: false, entry }, null, 2));
    } else {
      printHeader(`Built blind trace for ${entry.id} (@${entry.agent_alias})`);
      printInfo(
        "Pass `--board` (publish to live Agent Network), `--gist` (create shareable Gist), or `--out <file.json|md>` to save locally."
      );
      console.log("");
    }
  }
  return 0;
}
