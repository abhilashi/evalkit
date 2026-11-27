import fs from "node:fs";
import path from "node:path";
import type { BlindCard } from "../types.js";
import { printHeader, printInfo, printPass, printWarn } from "../utils/format.js";

export interface LeaderboardOptions {
  dir: string;
  outDir: string;
  title: string;
  repoUrl: string;
  json: boolean;
}

export interface LeaderboardData {
  generated_at: string;
  title: string;
  repo_url: string;
  summary: {
    total_tasks: number;
    verified_tasks: number;
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
  tasks: BlindCard[];
}

function collectCards(rootDir: string): BlindCard[] {
  const cards: BlindCard[] = [];
  if (!fs.existsSync(rootDir)) return cards;

  // Check if rootDir itself has a card.json
  const directCard = path.join(rootDir, "card.json");
  if (fs.existsSync(directCard)) {
    try {
      cards.push(JSON.parse(fs.readFileSync(directCard, "utf8")) as BlindCard);
    } catch {
      // ignore invalid
    }
  }

  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const cardPath = path.join(rootDir, entry.name, "card.json");
    if (!fs.existsSync(cardPath)) continue;
    try {
      cards.push(JSON.parse(fs.readFileSync(cardPath, "utf8")) as BlindCard);
    } catch {
      // ignore invalid card.json
    }
  }

  cards.sort((a, b) => a.id.localeCompare(b.id));
  return cards;
}

function aggregateLeaderboard(
  cards: BlindCard[],
  title: string,
  repoUrl: string
): LeaderboardData {
  const stackSet = new Set<string>();
  const categorySet = new Set<string>();

  const agentStats = new Map<
    string,
    { tasks: number; passed: number; trials: number; totalSolveMs: number }
  >();

  for (const card of cards) {
    for (const s of card.stack ?? []) stackSet.add(s);
    if (card.category) categorySet.add(card.category);

    for (const res of card.benchmark?.results ?? []) {
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
    summary: {
      total_tasks: cards.length,
      verified_tasks: cards.filter((c) => c.verification?.verified).length,
      stacks: Array.from(stackSet).sort(),
      categories: Array.from(categorySet).sort(),
    },
    agent_leaderboard: agentLeaderboard,
    tasks: cards,
  };
}

function renderHtml(data: LeaderboardData): string {
  const embeddedJson = JSON.stringify(data).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${data.title}</title>
  <style>
    :root {
      --bg: #0b0e14;
      --surface: #121722;
      --surface-2: #182030;
      --border: #253047;
      --text: #e6edf7;
      --muted: #8ea0bc;
      --accent: #38bdf8;
      --green: #34d399;
      --amber: #fbbf24;
      --red: #f87171;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at top right, #162036 0%, var(--bg) 55%);
      color: var(--text);
      font-family: var(--sans);
      line-height: 1.55;
      min-height: 100vh;
    }
    .wrap {
      max-width: 1080px;
      margin: 0 auto;
      padding: 40px 20px 80px;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: flex-start;
      gap: 20px;
      margin-bottom: 32px;
      border-bottom: 1px solid var(--border);
      padding-bottom: 24px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-family: var(--mono);
      font-size: 13px;
      color: var(--accent);
      background: rgba(56, 189, 248, 0.1);
      border: 1px solid rgba(56, 189, 248, 0.25);
      padding: 4px 10px;
      border-radius: 999px;
      margin-bottom: 10px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 30px;
      letter-spacing: -0.02em;
    }
    .subtitle {
      margin: 0;
      color: var(--muted);
      max-width: 660px;
      font-size: 15px;
    }
    .actions {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 9px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      text-decoration: none;
      border: 1px solid var(--border);
      background: var(--surface);
      color: var(--text);
      cursor: pointer;
    }
    .btn.primary {
      background: var(--accent);
      color: #06131f;
      border-color: transparent;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 14px;
      margin-bottom: 28px;
    }
    .stat-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px 18px;
    }
    .stat-label {
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .stat-val {
      font-size: 26px;
      font-weight: 700;
      margin-top: 4px;
      font-family: var(--mono);
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 20px;
      margin-bottom: 24px;
    }
    .panel h2 {
      margin: 0 0 14px;
      font-size: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .bar-row {
      display: grid;
      grid-template-columns: 140px 1fr 110px;
      align-items: center;
      gap: 14px;
      margin-bottom: 12px;
      font-family: var(--mono);
      font-size: 13px;
    }
    .bar-track {
      height: 10px;
      background: var(--surface-2);
      border-radius: 999px;
      overflow: hidden;
      border: 1px solid var(--border);
    }
    .bar-fill {
      height: 100%;
      border-radius: 999px;
      background: linear-gradient(90deg, var(--accent), var(--green));
    }
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }
    .chip {
      padding: 5px 11px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--muted);
      font-size: 12px;
      font-family: var(--mono);
      cursor: pointer;
    }
    .chip.active {
      background: rgba(56, 189, 248, 0.16);
      color: var(--accent);
      border-color: var(--accent);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th {
      text-align: left;
      color: var(--muted);
      font-weight: 600;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    td {
      padding: 13px 12px;
      border-bottom: 1px solid rgba(37, 48, 71, 0.6);
      vertical-align: top;
    }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: var(--mono); }
    .tag {
      display: inline-block;
      font-family: var(--mono);
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 6px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      color: var(--text);
      margin: 0 4px 4px 0;
    }
    .badge {
      display: inline-block;
      font-family: var(--mono);
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 999px;
    }
    .badge.ok { background: rgba(52, 211, 153, 0.14); color: var(--green); }
    .badge.warn { background: rgba(251, 191, 36, 0.14); color: var(--amber); }
    .badge.fail { background: rgba(248, 113, 113, 0.14); color: var(--red); }
    .codebox {
      background: #070a0f;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
      font-family: var(--mono);
      font-size: 13px;
      overflow-x: auto;
      color: #c9d8ef;
    }
    .muted { color: var(--muted); font-size: 13px; }
    footer {
      margin-top: 32px;
      text-align: center;
      color: var(--muted);
      font-size: 12px;
      font-family: var(--mono);
    }
    @media (max-width: 720px) {
      .bar-row { grid-template-columns: 100px 1fr 85px; }
      table, thead, tbody, th, td, tr { display: block; }
      thead { display: none; }
      td { padding: 6px 0; border: none; }
      tr { padding: 12px 0; border-bottom: 1px solid var(--border); }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div>
        <div class="brand">evalkit · Blind Scorecard Leaderboard</div>
        <h1 id="title"></h1>
        <p class="subtitle">
          Real-world bugs &amp; AI agent failure states turned into deterministic, offline-verifiable eval environments.
          Every entry below is generated directly from verified <code>card.json</code> manifests.
        </p>
      </div>
      <div class="actions">
        <a class="btn" id="repoLink" href="#" target="_blank" rel="noreferrer">GitHub Repo</a>
        <a class="btn primary" href="#submit">Submit Your Eval</a>
      </div>
    </header>

    <section class="stats" id="stats"></section>

    <section class="panel">
      <h2>
        <span>Agent Pass Rates (Across Benchmarked Tasks)</span>
        <span class="muted mono" id="benchNote"></span>
      </h2>
      <div id="agentBars"></div>
    </section>

    <section class="panel">
      <h2>
        <span>Verified Eval Catalog (Blind Scorecards)</span>
        <span class="muted mono" id="taskCount"></span>
      </h2>
      <div class="filters" id="filters"></div>
      <table>
        <thead>
          <tr>
            <th>Task ID</th>
            <th>Stack</th>
            <th>Diff Complexity</th>
            <th>Oracle Verification</th>
            <th>Agent Scores</th>
            <th>Signal / Est. Value</th>
          </tr>
        </thead>
        <tbody id="taskBody"></tbody>
      </table>
      <p class="muted" style="margin:14px 0 0;font-size:12px">
        * Dollar ranges are indicative RL-environment / SWE-eval market estimates (not guaranteed payouts). Actual vault payouts depend on buyer match and server-side Docker QA.
      </p>
    </section>

    <section class="panel" id="submit">
      <h2>Submit a Real Indie Bug or Private Vault Task</h2>
      <p class="muted" style="margin-top:0">
        Turn any real bug where your AI coding agent got stuck into a verified eval in minutes — keep your code private and publish only your <code>card.json</code> blind scorecard, or submit directly to the Private Vault.
      </p>
      <div class="codebox">npx github:abhilashi/evalkit install-skill --target auto
evalkit init --repo . --from HEAD~1 --to HEAD --out ./evals/my-bug
evalkit audit ./evals/my-bug &amp;&amp; evalkit verify ./evals/my-bug
evalkit bench ./evals/my-bug --agents claude,codex,gemini --trials 3
evalkit pack ./evals/my-bug --attest-ip --license private-vault
evalkit submit ./evals/my-bug --github-issue</div>
    </section>

    <footer id="footer"></footer>
  </div>

  <script>
    const DATA = ${embeddedJson};

    document.getElementById("title").textContent = DATA.title;
    document.getElementById("repoLink").href = DATA.repo_url;
    document.getElementById("footer").textContent =
      "Generated by evalkit leaderboard · " + new Date(DATA.generated_at).toUTCString();

    const statsEl = document.getElementById("stats");
    const statItems = [
      ["Catalog Tasks", DATA.summary.total_tasks],
      ["Verified Tasks", DATA.summary.verified_tasks + "/" + DATA.summary.total_tasks],
      ["Stacks Covered", DATA.summary.stacks.length],
      ["Agents Benchmarked", DATA.agent_leaderboard.length]
    ];
    statsEl.innerHTML = statItems.map(([label, val]) =>
      '<div class="stat-card"><div class="stat-label">' + label + '</div><div class="stat-val">' + val + '</div></div>'
    ).join("");

    const barsEl = document.getElementById("agentBars");
    const benchNote = document.getElementById("benchNote");
    if (DATA.agent_leaderboard.length === 0) {
      barsEl.innerHTML = '<p class="muted">No benchmark runs recorded yet. Run <code>evalkit bench</code> on bundles and regenerate.</p>';
    } else {
      benchNote.textContent = "Includes built-in baselines (oracle/noop) + frontier runs";
      barsEl.innerHTML = DATA.agent_leaderboard.map((a) => {
        const pct = Math.round(a.overall_pass_rate * 100);
        return '<div class="bar-row">' +
          '<div><strong>' + a.agent + '</strong></div>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
          '<div style="text-align:right">' + a.total_passed + '/' + a.total_trials + ' (' + pct + '%)</div>' +
          '</div>';
      }).join("");
    }

    let activeStack = "all";
    const filtersEl = document.getElementById("filters");
    const taskBody = document.getElementById("taskBody");
    const taskCount = document.getElementById("taskCount");

    function renderFilters() {
      const stacks = ["all", ...DATA.summary.stacks];
      filtersEl.innerHTML = stacks.map((s) =>
        '<button class="chip ' + (activeStack === s ? "active" : "") + '" data-stack="' + s + '">' + s + '</button>'
      ).join("");
      filtersEl.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () => {
          activeStack = btn.getAttribute("data-stack");
          renderFilters();
          renderTable();
        });
      });
    }

    function renderTable() {
      const filtered = activeStack === "all"
        ? DATA.tasks
        : DATA.tasks.filter((t) => (t.stack || []).includes(activeStack));

      taskCount.textContent = filtered.length + " task(s)";
      if (filtered.length === 0) {
        taskBody.innerHTML = '<tr><td colspan="6" class="muted">No matching tasks.</td></tr>';
        return;
      }

      taskBody.innerHTML = filtered.map((t) => {
        const stacks = (t.stack || []).map((s) => '<span class="tag">' + s + '</span>').join("");
        const vBadge = t.verification && t.verification.verified
          ? '<span class="badge ok">VERIFIED ' + t.verification.gold_pass_rate + '</span>'
          : '<span class="badge warn">UNVERIFIED</span>';
        const sandboxNote = t.verification ? '<div class="muted mono" style="margin-top:4px;font-size:11px">' + t.verification.sandbox + '</div>' : '';
        const scores = (t.benchmark && t.benchmark.results && t.benchmark.results.length)
          ? t.benchmark.results.map((r) => {
              const cls = r.passed === r.trials ? "ok" : r.passed === 0 ? "fail" : "warn";
              return '<span class="badge ' + cls + '" style="margin:0 4px 4px 0">' + r.agent + ': ' + r.passed + '/' + r.trials + '</span>';
            }).join("")
          : '<span class="muted mono">not benchmarked</span>';

        let valHtml = '<span class="muted mono">—</span>';
        if (t.valuation) {
          const v = t.valuation;
          const tierCls = (v.tier === "S" || v.tier === "A") ? "ok" : (v.tier === "B" || v.tier === "C") ? "ok" : (v.tier === "UNBENCHMARKED" ? "warn" : "fail");
          const tierLabel = (v.tier === "S" || v.tier === "A" || v.tier === "B" || v.tier === "C") ? ("TIER " + v.tier) : v.tier;
          const rangeText = v.indicative_range_usd
            ? (v.indicative_range_usd.max === 0 ? "$0" : "$" + v.indicative_range_usd.min.toLocaleString() + "–$" + v.indicative_range_usd.max.toLocaleString() + "*")
            : "Run frontier bench";
          valHtml = '<span class="badge ' + tierCls + '">' + tierLabel + ' · ' + v.score + '/100</span>' +
            '<div class="muted mono" style="margin-top:4px;font-size:11px">' + rangeText + '</div>';
        }

        return '<tr>' +
          '<td><div class="mono"><strong>' + t.id + '</strong></div><div class="muted mono" style="font-size:11px">' + t.category + ' · ' + (t.bundle_sha256 || '').slice(0, 10) + '</div></td>' +
          '<td>' + stacks + '</td>' +
          '<td class="mono">' + t.complexity.files_changed + ' files<div class="muted" style="font-size:11px">+' + t.complexity.insertions + ' / -' + t.complexity.deletions + '</div></td>' +
          '<td>' + vBadge + sandboxNote + '</td>' +
          '<td>' + scores + '</td>' +
          '<td>' + valHtml + '</td>' +
          '</tr>';
      }).join("");
    }

    renderFilters();
    renderTable();
  </script>
</body>
</html>
`;
}

export function runLeaderboard(options: LeaderboardOptions): number {
  const srcDir = path.resolve(options.dir);
  const outDir = path.resolve(options.outDir);

  const cards = collectCards(srcDir);
  if (cards.length === 0 && !options.json) {
    printWarn(`No card.json files found under ${srcDir}. Run \`evalkit pack\` on your bundles first.`);
  }

  const data = aggregateLeaderboard(cards, options.title, options.repoUrl);

  fs.mkdirSync(outDir, { recursive: true });
  const dataPath = path.join(outDir, "data.json");
  const htmlPath = path.join(outDir, "index.html");
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), "utf8");
  fs.writeFileSync(htmlPath, renderHtml(data), "utf8");

  if (options.json) {
    console.log(JSON.stringify({ outDir, dataPath, htmlPath, summary: data.summary }, null, 2));
    return 0;
  }

  printHeader(`Generated evalkit leaderboard (${cards.length} task(s))`);
  printPass(`Data manifest: ${path.relative(process.cwd(), dataPath)}`);
  printPass(`Static page:   ${path.relative(process.cwd(), htmlPath)}`);
  printInfo(`Agents tracked: ${data.agent_leaderboard.map((a) => a.agent).join(", ") || "none"}`);
  console.log("");
  return 0;
}
