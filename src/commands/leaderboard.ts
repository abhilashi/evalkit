import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { BlindCard, EvalConfig, PublishedTraceEntry } from "../types.js";
import { buildPublishedTrace } from "./publish.js";
import { printHeader, printInfo, printPass, printWarn } from "../utils/format.js";

export interface LeaderboardOptions {
  dir: string;
  outDir: string;
  title: string;
  repoUrl: string;
  json: boolean;
}

export interface BoardData {
  generated_at: string;
  title: string;
  repo_url: string;
  github_repo: string;
  summary: {
    total_tasks: number;
    verified_tasks: number;
    public_traces: number;
    redacted_traces: number;
    stacks: string[];
    categories: string[];
  };
  agent_leaderboard: Array<{
    agent: string;
    tasks_evaluated: number;
    total_passed: number;
    total_trials: number;
    overall_pass_rate: number;
    avg_solve_ms: number;
  }>;
  entries: PublishedTraceEntry[];
}

function parseGithubRepoSlug(repoUrl: string): string {
  const m = repoUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/i);
  return m ? m[1] : "abhilashi/evalkit";
}

function cardToTraceEntry(card: BlindCard): PublishedTraceEntry {
  return {
    spec_version: card.spec_version,
    id: card.id,
    visibility: "redacted",
    published_at: card.packed_at,
    stack: card.stack,
    category: card.category,
    complexity: card.complexity,
    verification: card.verification,
    valuation: card.valuation,
    bundle_sha256: card.bundle_sha256,
    license: card.ownership?.license ?? "private-vault",
    agents: (card.benchmark?.results ?? []).map((r) => ({
      agent: r.agent,
      passed: r.passed,
      trials: r.trials,
      pass_rate: r.pass_rate,
      avg_solve_ms: r.avg_solve_ms,
      avg_insertions: 0,
      avg_deletions: 0,
      trials_detail: [],
    })),
  };
}

function loadEntryFromDir(bundleDir: string): PublishedTraceEntry | null {
  const evalYamlPath = path.join(bundleDir, "eval.yaml");
  const cardPath = path.join(bundleDir, "card.json");

  if (fs.existsSync(evalYamlPath)) {
    try {
      const cfg = YAML.parse(fs.readFileSync(evalYamlPath, "utf8")) as EvalConfig;
      const visibility =
        cfg.ownership?.license === "private-vault" ? "redacted" : "public";
      return buildPublishedTrace(bundleDir, visibility);
    } catch {
      // fallback to card.json
    }
  }

  if (fs.existsSync(cardPath)) {
    try {
      const card = JSON.parse(fs.readFileSync(cardPath, "utf8")) as BlindCard;
      return cardToTraceEntry(card);
    } catch {
      return null;
    }
  }

  return null;
}

function collectEntries(rootDir: string): PublishedTraceEntry[] {
  const entries: PublishedTraceEntry[] = [];
  if (!fs.existsSync(rootDir)) return entries;

  const direct = loadEntryFromDir(rootDir);
  if (direct) entries.push(direct);

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const loaded = loadEntryFromDir(path.join(rootDir, entry.name));
    if (loaded) entries.push(loaded);
  }

  // Also load any standalone *.json PublishedTraceEntry files under board/entries if present
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (entry.name === "card.json" || entry.name === "data.json") continue;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(path.join(rootDir, entry.name), "utf8")
      ) as PublishedTraceEntry;
      if (parsed?.id && parsed?.bundle_sha256) {
        entries.push(parsed);
      }
    } catch {
      // ignore non-trace json
    }
  }

  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

function aggregateBoard(
  entries: PublishedTraceEntry[],
  title: string,
  repoUrl: string
): BoardData {
  const stackSet = new Set<string>();
  const categorySet = new Set<string>();
  const agentStats = new Map<
    string,
    { tasks: number; passed: number; trials: number; totalSolveMs: number }
  >();

  for (const item of entries) {
    for (const s of item.stack ?? []) stackSet.add(s);
    if (item.category) categorySet.add(item.category);

    for (const res of item.agents ?? []) {
      const prev = agentStats.get(res.agent) ?? {
        tasks: 0,
        passed: 0,
        trials: 0,
        totalSolveMs: 0,
      };
      prev.tasks += 1;
      prev.passed += res.passed;
      prev.trials += res.trials;
      prev.totalSolveMs += res.avg_solve_ms;
      agentStats.set(res.agent, prev);
    }
  }

  const agentLeaderboard = Array.from(agentStats.entries())
    .map(([agent, st]) => ({
      agent,
      tasks_evaluated: st.tasks,
      total_passed: st.passed,
      total_trials: st.trials,
      overall_pass_rate:
        st.trials > 0 ? Number((st.passed / st.trials).toFixed(3)) : 0,
      avg_solve_ms: st.tasks > 0 ? Math.round(st.totalSolveMs / st.tasks) : 0,
    }))
    .sort((a, b) => b.overall_pass_rate - a.overall_pass_rate || a.agent.localeCompare(b.agent));

  return {
    generated_at: new Date().toISOString(),
    title,
    repo_url: repoUrl,
    github_repo: parseGithubRepoSlug(repoUrl),
    summary: {
      total_tasks: entries.length,
      verified_tasks: entries.filter((e) => e.verification?.verified).length,
      public_traces: entries.filter((e) => e.visibility === "public").length,
      redacted_traces: entries.filter((e) => e.visibility === "redacted").length,
      stacks: Array.from(stackSet).sort(),
      categories: Array.from(categorySet).sort(),
    },
    agent_leaderboard: agentLeaderboard,
    entries,
  };
}

function renderHtml(data: BoardData): string {
  const embeddedJson = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${data.title}</title>
  <style>
    :root {
      --bg: #0a0d12;
      --surface: #111622;
      --surface-2: #171f2f;
      --border: #243047;
      --text: #e6edf7;
      --muted: #8ea0bc;
      --accent: #38bdf8;
      --purple: #a78bfa;
      --green: #34d399;
      --amber: #fbbf24;
      --red: #f87171;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at top right, #152238 0%, var(--bg) 52%);
      color: var(--text);
      font-family: var(--sans);
      line-height: 1.55;
      min-height: 100vh;
    }
    .wrap { max-width: 1140px; margin: 0 auto; padding: 36px 20px 80px; }
    header {
      display: flex; flex-wrap: wrap; justify-content: space-between;
      align-items: flex-start; gap: 20px; margin-bottom: 28px;
      border-bottom: 1px solid var(--border); padding-bottom: 22px;
    }
    .brand {
      display: inline-flex; align-items: center; gap: 8px;
      font-family: var(--mono); font-size: 12px; color: var(--accent);
      background: rgba(56, 189, 248, 0.1); border: 1px solid rgba(56, 189, 248, 0.25);
      padding: 4px 10px; border-radius: 999px; margin-bottom: 10px;
    }
    h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: -0.02em; }
    .subtitle { margin: 0; color: var(--muted); max-width: 680px; font-size: 14px; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .btn {
      display: inline-flex; align-items: center; gap: 7px; padding: 8px 14px;
      border-radius: 8px; font-size: 13px; font-weight: 600; text-decoration: none;
      border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer;
    }
    .btn:hover { border-color: var(--accent); }
    .btn.primary { background: var(--accent); color: #05131f; border-color: transparent; }
    .stats {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(175px, 1fr));
      gap: 12px; margin-bottom: 24px;
    }
    .stat-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 12px; padding: 14px 16px;
    }
    .stat-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-val { font-size: 24px; font-weight: 700; margin-top: 4px; font-family: var(--mono); }
    .panel {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 14px; padding: 20px; margin-bottom: 22px;
    }
    .panel h2 {
      margin: 0 0 14px; font-size: 15px; display: flex;
      justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;
    }
    .bar-row {
      display: grid; grid-template-columns: 140px 1fr 110px;
      align-items: center; gap: 14px; margin-bottom: 10px;
      font-family: var(--mono); font-size: 13px;
    }
    .bar-track {
      height: 10px; background: var(--surface-2); border-radius: 999px;
      overflow: hidden; border: 1px solid var(--border);
    }
    .bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent), var(--green)); }
    .toolbar {
      display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
      justify-content: space-between; margin-bottom: 14px;
    }
    .tabs { display: flex; flex-wrap: wrap; gap: 6px; }
    .controls { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    input[type="search"], select {
      background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
      padding: 7px 11px; border-radius: 8px; font-size: 13px; font-family: var(--sans);
    }
    .filters { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 14px; }
    .chip {
      padding: 5px 10px; border-radius: 999px; border: 1px solid var(--border);
      background: var(--surface-2); color: var(--muted); font-size: 12px;
      font-family: var(--mono); cursor: pointer;
    }
    .chip.active { background: rgba(56, 189, 248, 0.16); color: var(--accent); border-color: var(--accent); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th {
      text-align: left; color: var(--muted); font-weight: 600; padding: 10px 10px;
      border-bottom: 1px solid var(--border); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em;
    }
    td { padding: 12px 10px; border-bottom: 1px solid rgba(36, 48, 71, 0.6); vertical-align: top; }
    tbody tr { cursor: pointer; transition: background 0.12s ease; }
    tbody tr:hover { background: rgba(56, 189, 248, 0.06); }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: var(--mono); }
    .tag {
      display: inline-block; font-family: var(--mono); font-size: 11px;
      padding: 2px 6px; border-radius: 6px; background: var(--surface-2);
      border: 1px solid var(--border); color: var(--text); margin: 0 4px 4px 0;
    }
    .badge {
      display: inline-block; font-family: var(--mono); font-size: 11px;
      font-weight: 600; padding: 2px 8px; border-radius: 999px;
    }
    .badge.ok { background: rgba(52, 211, 153, 0.14); color: var(--green); }
    .badge.warn { background: rgba(251, 191, 36, 0.14); color: var(--amber); }
    .badge.fail { background: rgba(248, 113, 113, 0.14); color: var(--red); }
    .badge.vault { background: rgba(167, 139, 250, 0.15); color: var(--purple); }
    .badge.pub { background: rgba(56, 189, 248, 0.14); color: var(--accent); }
    .codebox {
      background: #06090e; border: 1px solid var(--border); border-radius: 10px;
      padding: 13px 15px; font-family: var(--mono); font-size: 12.5px;
      overflow-x: auto; color: #c9d8ef; white-space: pre-wrap; word-break: break-word;
    }
    .muted { color: var(--muted); font-size: 13px; }
    .live-pill {
      display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono);
      font-size: 11px; color: var(--muted);
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); display: inline-block; }
    /* Modal Trace Inspector */
    .modal-backdrop {
      position: fixed; inset: 0; background: rgba(4, 7, 12, 0.78);
      backdrop-filter: blur(4px); display: none; justify-content: flex-end; z-index: 50;
    }
    .modal-backdrop.open { display: flex; }
    .drawer {
      width: min(760px, 100vw); height: 100vh; overflow-y: auto;
      background: #0d121c; border-left: 1px solid var(--border);
      padding: 24px 24px 60px; box-shadow: -12px 0 40px rgba(0,0,0,0.5);
    }
    .drawer-head {
      display: flex; justify-content: space-between; align-items: flex-start;
      gap: 12px; border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 18px;
    }
    .section-title {
      font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--muted); margin: 20px 0 8px; font-family: var(--mono);
    }
    .trial-card {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; padding: 12px 14px; margin-bottom: 10px;
    }
    .trial-head {
      display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px;
      font-family: var(--mono); font-size: 12px; margin-bottom: 8px;
    }
    .val-grid { display: grid; gap: 8px; }
    .val-row {
      display: grid; grid-template-columns: 155px 60px 1fr; gap: 10px;
      font-size: 12.5px; align-items: center;
    }
    footer {
      margin-top: 32px; text-align: center; color: var(--muted);
      font-size: 12px; font-family: var(--mono);
    }
    @media (max-width: 780px) {
      .bar-row { grid-template-columns: 95px 1fr 85px; }
      table, thead, tbody, th, td, tr { display: block; }
      thead { display: none; }
      td { padding: 5px 0; border: none; }
      tr { padding: 12px 0; border-bottom: 1px solid var(--border); }
      .val-row { grid-template-columns: 1fr; gap: 2px; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <div class="brand">evalkit · Community Trace &amp; Eval Board</div>
        <h1 id="title"></h1>
        <p class="subtitle">
          Click any task to inspect agent failure traces, Signal Score breakdown, and verification proof.
          Open-source bundles publish full traces; Private Vault entries publish redacted blind telemetry only.
        </p>
      </div>
      <div class="actions">
        <a class="btn" id="repoLink" href="#" target="_blank" rel="noreferrer">GitHub Repo</a>
        <a class="btn primary" href="#publish">Publish Your Trace</a>
      </div>
    </header>

    <section class="stats" id="stats"></section>

    <section class="panel">
      <h2>
        <span>Agent Pass Rates</span>
        <span class="live-pill" id="liveStatus"><span class="dot"></span> Loading community board...</span>
      </h2>
      <div id="agentBars"></div>
    </section>

    <section class="panel">
      <h2>
        <span>Published Evals &amp; Failure Traces</span>
        <span class="muted mono" id="taskCount"></span>
      </h2>

      <div class="toolbar">
        <div class="tabs" id="visTabs"></div>
        <div class="controls">
          <input type="search" id="searchInput" placeholder="Search id, stack, author..." />
          <select id="sortSelect">
            <option value="score">Sort: Highest Signal Score</option>
            <option value="hardest">Sort: Hardest (Lowest Pass %)</option>
            <option value="newest">Sort: Newest Published</option>
          </select>
        </div>
      </div>

      <div class="filters" id="stackFilters"></div>

      <table>
        <thead>
          <tr>
            <th>Eval / Visibility</th>
            <th>Stack</th>
            <th>Complexity</th>
            <th>Oracle Proof</th>
            <th>Agent Traces</th>
            <th>Signal / Est. Value</th>
          </tr>
        </thead>
        <tbody id="taskBody"></tbody>
      </table>
      <p class="muted" style="margin:14px 0 0;font-size:12px">
        * Click any row to inspect the full or redacted failure trace. Dollar ranges are indicative RL-environment market estimates, not guaranteed payouts.
      </p>
    </section>

    <section class="panel" id="publish">
      <h2>Publish Your Own Eval Trace to This Board</h2>
      <p class="muted" style="margin-top:0">
        Anyone can publish directly from their terminal. Private Vault bundles default to <code>--redacted</code> (zero code or prompts leave your machine); open-source bundles publish interactive traces.
      </p>
      <div class="codebox">npx github:abhilashi/evalkit install-skill --target auto
evalkit init --repo . --from HEAD~1 --to HEAD --out ./evals/my-bug
evalkit audit ./evals/my-bug &amp;&amp; evalkit verify ./evals/my-bug
evalkit bench ./evals/my-bug --agents claude,codex,gemini --trials 3
evalkit pack ./evals/my-bug --attest-ip --license private-vault
evalkit publish ./evals/my-bug --board</div>
    </section>

    <footer id="footer"></footer>
  </div>

  <div class="modal-backdrop" id="modalBackdrop">
    <div class="drawer" id="drawer"></div>
  </div>

  <script>
    const STATIC_DATA = ${embeddedJson};
    let ALL_ENTRIES = STATIC_DATA.entries.map((e) => ({ ...e, _source: "verified-showcase" }));
    let activeVis = "all";
    let activeStack = "all";
    let searchQuery = "";
    let sortBy = "score";
    let activeModalAgent = null;

    function esc(str) {
      return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function fmtMs(ms) {
      if (!ms || ms < 1000) return (ms || 0) + "ms";
      return (ms / 1000).toFixed(1) + "s";
    }

    function fmtRange(v) {
      if (!v) return "Not estimated";
      if (v.tier === "UNBENCHMARKED" || !v.indicative_range_usd) return "Run frontier bench";
      if (v.indicative_range_usd.max === 0) return "$0 (not eligible)";
      return "$" + v.indicative_range_usd.min.toLocaleString() + " - $" + v.indicative_range_usd.max.toLocaleString() + "*";
    }

    function getFrontierPassRate(entry) {
      const frontier = (entry.agents || []).filter((a) => a.agent !== "noop" && a.agent !== "oracle" && a.trials > 0);
      if (frontier.length === 0) return 2; // sort unbenchmarked after hardest
      const passed = frontier.reduce((s, a) => s + a.passed, 0);
      const trials = frontier.reduce((s, a) => s + a.trials, 0);
      return trials > 0 ? passed / trials : 2;
    }

    function computeAgentSummary(entries) {
      const map = new Map();
      for (const e of entries) {
        for (const a of (e.agents || [])) {
          const prev = map.get(a.agent) || { passed: 0, trials: 0 };
          prev.passed += a.passed || 0;
          prev.trials += a.trials || 0;
          map.set(a.agent, prev);
        }
      }
      return Array.from(map.entries())
        .map(([agent, st]) => ({
          agent,
          passed: st.passed,
          trials: st.trials,
          rate: st.trials > 0 ? st.passed / st.trials : 0
        }))
        .sort((a, b) => b.rate - a.rate || a.agent.localeCompare(b.agent));
    }

    function renderStatsAndBars() {
      const stacks = new Set();
      ALL_ENTRIES.forEach((e) => (e.stack || []).forEach((s) => stacks.add(s)));
      const verified = ALL_ENTRIES.filter((e) => e.verification && e.verification.verified).length;
      const agents = computeAgentSummary(ALL_ENTRIES);

      document.getElementById("stats").innerHTML = [
        ["Published Evals", ALL_ENTRIES.length],
        ["Verified Bundles", verified + "/" + ALL_ENTRIES.length],
        ["Public / Vault", ALL_ENTRIES.filter((e) => e.visibility === "public").length + " / " + ALL_ENTRIES.filter((e) => e.visibility === "redacted").length],
        ["Stacks Covered", stacks.size]
      ].map(([l, v]) => '<div class="stat-card"><div class="stat-label">' + esc(l) + '</div><div class="stat-val">' + esc(v) + '</div></div>').join("");

      const barsEl = document.getElementById("agentBars");
      if (agents.length === 0) {
        barsEl.innerHTML = '<p class="muted">No benchmark traces recorded yet.</p>';
      } else {
        barsEl.innerHTML = agents.map((a) => {
          const pct = Math.round(a.rate * 100);
          return '<div class="bar-row">' +
            '<div><strong>' + esc(a.agent) + '</strong></div>' +
            '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
            '<div style="text-align:right">' + a.passed + '/' + a.trials + ' (' + pct + '%)</div>' +
            '</div>';
        }).join("");
      }
    }

    function renderFilters() {
      const visOptions = [
        ["all", "All (" + ALL_ENTRIES.length + ")"],
        ["public", "Public Traces"],
        ["redacted", "Private Vault (Redacted)"],
        ["community", "Community Published"]
      ];
      const visEl = document.getElementById("visTabs");
      visEl.innerHTML = visOptions.map(([k, label]) =>
        '<button class="chip ' + (activeVis === k ? "active" : "") + '" data-vis="' + k + '">' + esc(label) + '</button>'
      ).join("");
      visEl.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () => {
          activeVis = btn.getAttribute("data-vis");
          renderFilters();
          renderTable();
        });
      });

      const stackSet = new Set();
      ALL_ENTRIES.forEach((e) => (e.stack || []).forEach((s) => stackSet.add(s)));
      const stacks = ["all", ...Array.from(stackSet).sort()];
      const sfEl = document.getElementById("stackFilters");
      sfEl.innerHTML = stacks.map((s) =>
        '<button class="chip ' + (activeStack === s ? "active" : "") + '" data-stack="' + esc(s) + '">' + esc(s) + '</button>'
      ).join("");
      sfEl.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () => {
          activeStack = btn.getAttribute("data-stack");
          renderFilters();
          renderTable();
        });
      });
    }

    function renderTable() {
      let list = ALL_ENTRIES.slice();
      if (activeVis === "public") list = list.filter((e) => e.visibility === "public");
      if (activeVis === "redacted") list = list.filter((e) => e.visibility === "redacted");
      if (activeVis === "community") list = list.filter((e) => e._source === "community");
      if (activeStack !== "all") list = list.filter((e) => (e.stack || []).includes(activeStack));
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        list = list.filter((e) =>
          (e.id || "").toLowerCase().includes(q) ||
          (e.author || "").toLowerCase().includes(q) ||
          (e.category || "").toLowerCase().includes(q) ||
          (e.stack || []).some((s) => s.toLowerCase().includes(q))
        );
      }

      if (sortBy === "score") {
        list.sort((a, b) => ((b.valuation && b.valuation.score) || 0) - ((a.valuation && a.valuation.score) || 0));
      } else if (sortBy === "hardest") {
        list.sort((a, b) => getFrontierPassRate(a) - getFrontierPassRate(b));
      } else {
        list.sort((a, b) => String(b.published_at || "").localeCompare(String(a.published_at || "")));
      }

      document.getElementById("taskCount").textContent = list.length + " task(s)";
      const tbody = document.getElementById("taskBody");
      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" class="muted">No matching eval traces.</td></tr>';
        return;
      }

      tbody.innerHTML = list.map((t) => {
        const visBadge = t.visibility === "public"
          ? '<span class="badge pub">PUBLIC TRACE</span>'
          : '<span class="badge vault">VAULT · REDACTED</span>';
        const srcBadge = t._source === "community"
          ? ' <span class="badge warn">@' + esc(t.author || "community") + '</span>'
          : '';
        const stacks = (t.stack || []).map((s) => '<span class="tag">' + esc(s) + '</span>').join("");
        const vBadge = t.verification && t.verification.verified
          ? '<span class="badge ok">VERIFIED ' + esc(t.verification.gold_pass_rate) + '</span>'
          : '<span class="badge warn">UNVERIFIED</span>';
        const sandboxNote = t.verification ? '<div class="muted mono" style="margin-top:4px;font-size:11px">' + esc(t.verification.sandbox) + '</div>' : '';
        const scores = (t.agents && t.agents.length)
          ? t.agents.map((r) => {
              const cls = r.passed === r.trials ? "ok" : r.passed === 0 ? "fail" : "warn";
              return '<span class="badge ' + cls + '" style="margin:0 4px 4px 0">' + esc(r.agent) + ': ' + r.passed + '/' + r.trials + '</span>';
            }).join("")
          : '<span class="muted mono">not benchmarked</span>';

        let valHtml = '<span class="muted mono">-</span>';
        if (t.valuation) {
          const v = t.valuation;
          const tierCls = (v.tier === "S" || v.tier === "A" || v.tier === "B" || v.tier === "C") ? "ok" : (v.tier === "UNBENCHMARKED" ? "warn" : "fail");
          const tierLabel = ["S","A","B","C"].includes(v.tier) ? ("TIER " + v.tier) : v.tier;
          valHtml = '<span class="badge ' + tierCls + '">' + esc(tierLabel) + ' · ' + v.score + '/100</span>' +
            '<div class="muted mono" style="margin-top:4px;font-size:11px">' + esc(fmtRange(v)) + '</div>';
        }

        return '<tr data-id="' + esc(t.id) + '">' +
          '<td><div class="mono"><strong>' + esc(t.id) + '</strong></div><div style="margin-top:4px">' + visBadge + srcBadge + '</div></td>' +
          '<td>' + stacks + '</td>' +
          '<td class="mono">' + (t.complexity ? t.complexity.files_changed : 0) + ' files<div class="muted" style="font-size:11px">+' + (t.complexity ? t.complexity.insertions : 0) + ' / -' + (t.complexity ? t.complexity.deletions : 0) + '</div></td>' +
          '<td>' + vBadge + sandboxNote + '</td>' +
          '<td>' + scores + '</td>' +
          '<td>' + valHtml + '</td>' +
          '</tr>';
      }).join("");

      tbody.querySelectorAll("tr[data-id]").forEach((row) => {
        row.addEventListener("click", () => {
          const id = row.getAttribute("data-id");
          const entry = ALL_ENTRIES.find((e) => e.id === id);
          if (entry) openDrawer(entry);
        });
      });
    }

    function openDrawer(entry) {
      window.location.hash = "task=" + encodeURIComponent(entry.id);
      const agents = entry.agents || [];
      if (!activeModalAgent || !agents.some((a) => a.agent === activeModalAgent)) {
        activeModalAgent = agents[0] ? agents[0].agent : null;
      }

      const drawer = document.getElementById("drawer");
      const shareUrl = window.location.href;
      const buyUrl = STATIC_DATA.repo_url + "/issues/new?title=" + encodeURIComponent("[Vault Inquiry] " + entry.id) +
        "&body=" + encodeURIComponent("Interested in licensing eval bundle \`" + entry.id + "\` (SHA-256: \`" + entry.bundle_sha256 + "\`).");

      const valBlock = entry.valuation ? (
        '<div class="section-title">Signal Score &amp; Indicative Valuation (' + entry.valuation.score + '/100 · ' + esc(fmtRange(entry.valuation)) + ')</div>' +
        '<div class="val-grid">' +
        (entry.valuation.breakdown || []).map((b) =>
          '<div class="val-row"><div class="mono"><strong>' + esc(b.factor) + '</strong></div><div class="mono">' + b.points + '/' + b.max_points + '</div><div class="muted">' + esc(b.note) + '</div></div>'
        ).join("") +
        '</div>'
      ) : '';

      const agentTabs = agents.length > 0 ? (
        '<div class="filters" id="drawerAgentTabs">' +
        agents.map((a) =>
          '<button class="chip ' + (a.agent === activeModalAgent ? "active" : "") + '" data-agent="' + esc(a.agent) + '">' +
          esc(a.agent) + ' (' + a.passed + '/' + a.trials + ')</button>'
        ).join("") + '</div>'
      ) : '<p class="muted">No agent trials recorded yet.</p>';

      const selectedAgent = agents.find((a) => a.agent === activeModalAgent);
      let trialsHtml = '';
      if (selectedAgent) {
        const details = selectedAgent.trials_detail || [];
        if (details.length === 0) {
          trialsHtml = '<p class="muted">Summary only: ' + selectedAgent.passed + '/' + selectedAgent.trials + ' passed (avg ' + fmtMs(selectedAgent.avg_solve_ms) + ').</p>';
        } else {
          trialsHtml = details.map((tr) => {
            const cls = tr.passed ? "ok" : "fail";
            let extra = '';
            if (entry.visibility === "public") {
              if (tr.solve_output_tail) {
                extra += '<div class="muted mono" style="font-size:11px;margin:8px 0 4px">Agent Solve Output</div><div class="codebox">' + esc(tr.solve_output_tail) + '</div>';
              }
              if (tr.grade_output_tail) {
                extra += '<div class="muted mono" style="font-size:11px;margin:8px 0 4px">Grading Verifier Output</div><div class="codebox">' + esc(tr.grade_output_tail) + '</div>';
              }
              if (tr.patch_preview) {
                extra += '<div class="muted mono" style="font-size:11px;margin:8px 0 4px">Produced Diff</div><div class="codebox">' + esc(tr.patch_preview) + '</div>';
              }
            } else {
              extra = '<div class="muted" style="font-size:12px">Redacted Vault Trace: code diffs &amp; stdout withheld to prevent holdout contamination.</div>';
            }
            return '<div class="trial-card">' +
              '<div class="trial-head">' +
              '<div><span class="badge ' + cls + '">' + esc(tr.failure_class || (tr.passed ? "PASS" : "FAIL")) + '</span> Trial #' + tr.trial + '</div>' +
              '<div class="muted">solve ' + fmtMs(tr.solve_duration_ms) + ' · grade ' + fmtMs(tr.grade_duration_ms) + ' · ' + tr.files_changed + ' files (+' + tr.insertions + '/-' + tr.deletions + ')</div>' +
              '</div>' + extra + '</div>';
          }).join("");
        }
      }

      const publicDocs = entry.visibility === "public" ? (
        (entry.prompt_markdown ? '<div class="section-title">Task Prompt (Shown to Agent)</div><div class="codebox">' + esc(entry.prompt_markdown) + '</div>' : '') +
        (entry.debrief_summary ? '<div class="section-title">Author Debrief</div><div class="codebox">' + esc(entry.debrief_summary) + '</div>' : '')
      ) : (
        '<div class="section-title">Private Vault Holdout</div>' +
        '<div class="trial-card"><p class="muted" style="margin:0 0 10px">Prompt, source snapshot, hidden tests, and gold patch stay strictly private to keep this environment uncontaminated.</p>' +
        '<a class="btn primary" href="' + esc(buyUrl) + '" target="_blank" rel="noreferrer">Request Vault Access / License</a></div>'
      );

      const issueLink = entry._issue_url
        ? '<a class="btn" href="' + esc(entry._issue_url) + '" target="_blank" rel="noreferrer">GitHub Post</a>'
        : '';

      drawer.innerHTML =
        '<div class="drawer-head">' +
          '<div>' +
            '<div style="margin-bottom:6px">' +
              (entry.visibility === "public" ? '<span class="badge pub">PUBLIC TRACE</span>' : '<span class="badge vault">PRIVATE VAULT · REDACTED</span>') +
              ' <span class="badge ok">' + esc(entry.category) + '</span>' +
            '</div>' +
            '<h2 style="margin:0 0 4px;font-size:20px" class="mono">' + esc(entry.id) + '</h2>' +
            '<div class="muted mono" style="font-size:11px">SHA-256: ' + esc(entry.bundle_sha256) + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="btn" id="copyLinkBtn">Copy Link</button>' +
            issueLink +
            '<button class="btn" id="closeDrawerBtn">Close</button>' +
          '</div>' +
        '</div>' +
        '<div style="margin-bottom:12px">' + (entry.stack || []).map((s) => '<span class="tag">' + esc(s) + '</span>').join("") + '</div>' +
        valBlock +
        '<div class="section-title">Agent Execution Traces</div>' +
        agentTabs + trialsHtml +
        publicDocs;

      document.getElementById("modalBackdrop").classList.add("open");
      document.getElementById("closeDrawerBtn").addEventListener("click", closeDrawer);
      document.getElementById("copyLinkBtn").addEventListener("click", () => {
        navigator.clipboard.writeText(shareUrl).then(() => {
          document.getElementById("copyLinkBtn").textContent = "Copied!";
        });
      });
      drawer.querySelectorAll("#drawerAgentTabs button").forEach((btn) => {
        btn.addEventListener("click", () => {
          activeModalAgent = btn.getAttribute("data-agent");
          openDrawer(entry);
        });
      });
    }

    function closeDrawer() {
      document.getElementById("modalBackdrop").classList.remove("open");
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }

    document.getElementById("modalBackdrop").addEventListener("click", (e) => {
      if (e.target.id === "modalBackdrop") closeDrawer();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeDrawer();
    });

    async function fetchCommunityPosts() {
      const statusEl = document.getElementById("liveStatus");
      try {
        const res = await fetch(
          "https://api.github.com/repos/" + STATIC_DATA.github_repo + "/issues?labels=evalkit-board&state=open&per_page=50",
          { headers: { Accept: "application/vnd.github+json" } }
        );
        if (!res.ok) throw new Error("HTTP " + res.status);
        const issues = await res.json();
        let added = 0;
        const existingHashes = new Set(ALL_ENTRIES.map((e) => e.bundle_sha256));

        for (const issue of issues) {
          const body = issue.body || "";
          const match = body.match(/<!-- EVALKIT_BOARD_JSON_START -->\\s*\`\`\`json\\s*([\\s\\S]*?)\\s*\`\`\`\\s*<!-- EVALKIT_BOARD_JSON_END -->/);
          if (!match) continue;
          try {
            const parsed = JSON.parse(match[1]);
            if (
              typeof parsed.id === "string" &&
              typeof parsed.bundle_sha256 === "string" &&
              /^[a-f0-9]{64}$/i.test(parsed.bundle_sha256) &&
              Array.isArray(parsed.stack) &&
              !existingHashes.has(parsed.bundle_sha256)
            ) {
              existingHashes.add(parsed.bundle_sha256);
              ALL_ENTRIES.push({
                ...parsed,
                author: parsed.author || (issue.user && issue.user.login) || "community",
                _source: "community",
                _issue_url: issue.html_url
              });
              added++;
            }
          } catch {
            // ignore malformed issue json
          }
        }
        statusEl.innerHTML = '<span class="dot"></span> Live synced (' + added + ' community post' + (added === 1 ? '' : 's') + ')';
        if (added > 0) {
          renderStatsAndBars();
          renderFilters();
          renderTable();
          checkDeepLink();
        }
      } catch {
        statusEl.innerHTML = '<span class="dot" style="background:var(--amber)"></span> Showing verified static catalog';
      }
    }

    function checkDeepLink() {
      const m = window.location.hash.match(/task=([^&]+)/);
      if (!m) return;
      const targetId = decodeURIComponent(m[1]);
      const found = ALL_ENTRIES.find((e) => e.id === targetId);
      if (found) openDrawer(found);
    }

    document.getElementById("title").textContent = STATIC_DATA.title;
    document.getElementById("repoLink").href = STATIC_DATA.repo_url;
    document.getElementById("footer").textContent =
      "Generated by evalkit · " + new Date(STATIC_DATA.generated_at).toUTCString();

    document.getElementById("searchInput").addEventListener("input", (e) => {
      searchQuery = e.target.value.trim();
      renderTable();
    });
    document.getElementById("sortSelect").addEventListener("change", (e) => {
      sortBy = e.target.value;
      renderTable();
    });

    renderStatsAndBars();
    renderFilters();
    renderTable();
    checkDeepLink();
    fetchCommunityPosts();
  </script>
</body>
</html>
`;
}

export function runLeaderboard(options: LeaderboardOptions): number {
  const srcDir = path.resolve(options.dir);
  const outDir = path.resolve(options.outDir);

  const entries = collectEntries(srcDir);
  if (entries.length === 0 && !options.json) {
    printWarn(`No eval bundles or card.json files found under ${srcDir}.`);
  }

  const data = aggregateBoard(entries, options.title, options.repoUrl);

  fs.mkdirSync(outDir, { recursive: true });
  const dataPath = path.join(outDir, "data.json");
  const htmlPath = path.join(outDir, "index.html");
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), "utf8");
  fs.writeFileSync(htmlPath, renderHtml(data), "utf8");

  if (options.json) {
    console.log(JSON.stringify({ outDir, dataPath, htmlPath, summary: data.summary }, null, 2));
    return 0;
  }

  printHeader(`Generated Community Trace & Eval Board (${entries.length} task(s))`);
  printPass(`Data manifest: ${path.relative(process.cwd(), dataPath)}`);
  printPass(`Board site:    ${path.relative(process.cwd(), htmlPath)}`);
  printInfo(`Agents tracked: ${data.agent_leaderboard.map((a) => a.agent).join(", ") || "none"}`);
  console.log("");
  return 0;
}
