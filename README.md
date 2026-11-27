# evalkit

[![CI](https://github.com/abhilashi/evalkit/actions/workflows/ci.yml/badge.svg)](https://github.com/abhilashi/evalkit/actions/workflows/ci.yml)
[![Leaderboard](https://img.shields.io/badge/Leaderboard-GitHub%20Pages-38bdf8)](https://abhilashi.github.io/evalkit/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Turn real-world bugs and AI agent failure states in any git repo into reproducible, verified eval environments.**

When AI generates most of the code, **the frontier failure boundary is the dataset**: the exact moments where coding agents loop, break regressions, or fail on messy real-world apps and a developer has to step in.

`evalkit` pairs an **open-source CLI** with a **universal Agent Skill (`SKILL.md`)** so any developer can package a real commit range (either live right after fixing a gnarly bug, or mined from a side-project graveyard) into an offline-reproducible, leak-free, 3x-verified eval bundle, benchmark coding agents against it, publish a static leaderboard, or submit a blind scorecard to the Private Vault.

👉 **Live Teaser Leaderboard:** https://abhilashi.github.io/evalkit/

---

## 1-Command Quickstart

Install the universal Agent Skill (Antigravity, Claude Code, Cursor, Codex):

```bash
npx github:abhilashi/evalkit install-skill --target auto
```

Or install the `evalkit` CLI globally:

```bash
npm install -g github:abhilashi/evalkit
evalkit install-skill --target auto
```

Then open your coding agent in any git repo and say:
> *"Turn the bug I just fixed into an eval using evalkit."*

---

## Included Showcase Evals (`examples/`)

Every example bundle in [`examples/`](examples/) is audited (`--strict`), verified (`base` fails, `gold.patch` passes 3/3), and automatically validated on every CI run:

| Eval Task | Stack | What Trips Up Agents |
| :--- | :--- | :--- |
| [`stripe-webhook-idempotency`](examples/stripe-webhook-idempotency) | `node`, `javascript`, `stripe`, `billing` | Per-ledger dedupe isolation + per-charge partial refund caps without poisoning state on rejected payloads |
| [`jwt-session-rotation-race`](examples/jwt-session-rotation-race) | `node`, `javascript`, `auth`, `security` | Concurrent multi-tab refresh grace window vs. 2-hop ancestor replay triggering family-wide theft revocation |
| [`rate-limiter-sliding-window`](examples/rate-limiter-sliding-window) | `node`, `javascript`, `api`, `rate-limiting` | 2× fixed-window boundary bursts, exact `retryAfterMs`, clock jitter ordering, and bounded idle-key eviction |

Run your own coding agents against any included example:

```bash
evalkit bench ./examples/jwt-session-rotation-race --agents claude,codex,gemini --trials 3
```

---

## CLI Workflow

### 1. Mine a repo for high-signal commits
Turn an abandoned side project into high-signal evals:

```bash
evalkit mine --repo ./my-indie-app --top 8
```

### 2. Initialize a clean eval bundle
Snapshots `base_commit` via `git archive` (zero future-commit leaks, strips `.env*` & keys), detects stack, extracts changed tests into `grading/tests/`, and scaffolds the full bundle:

```bash
evalkit init --repo ./my-indie-app --from HEAD~1 --to HEAD --out ./evals/webhook-race
```

### 3. Audit for secrets, PII, git leaks, and prompt leaks
```bash
evalkit audit ./evals/webhook-race --strict
```

### 4. Verify determinism (base fails + gold passes 3/3)
```bash
evalkit verify ./evals/webhook-race --runs 3
# or fast local iteration without Docker running:
evalkit verify ./evals/webhook-race --mode local --runs 3
```

### 5. Benchmark coding agents on your task
Run installed coding agents (or any custom command) inside an isolated copy of `base_commit` with `grading/` and `private/` strictly hidden, then grade every produced patch offline:

```bash
# Built-in adapters: claude, codex, gemini, opencode, oracle, noop
evalkit bench ./evals/webhook-race --agents claude,codex,gemini --trials 3

# Or benchmark any custom agent / script / MCP setup:
evalkit bench ./evals/webhook-race \
  --cmd "my-agent=python run_agent.py {prompt_file}" \
  --agents oracle,noop
```

### 6. Estimate Signal Score & indicative market value
Compute a transparent `0-100` Signal Score, Tier (`S` / `A` / `B` / `C` / `UNBENCHMARKED` / `NOT_ELIGIBLE`), indicative RL-environment market range, and concrete upgrade hints:

```bash
evalkit estimate ./evals/webhook-race
```

| Tier | Indicative Range* | Requirements |
| :--- | :--- | :--- |
| **UNBENCHMARKED** | _Run frontier bench_ | Verified, but only `noop`/`oracle` baselines run so far |
| **NOT ELIGIBLE** | **$0** | Unverified or frontier models pass >= 80% |
| **Tier C** | **$50 - $150** | Verified, frontier pass rate 40-79% |
| **Tier B** | **$150 - $450** | Score >= 50, frontier pass rate < 40% |
| **Tier A** | **$450 - $1,200** | Score >= 70, Docker `--network=none` verified, frontier pass rate < 20% |
| **Tier S** | **$1,200 - $3,000** | Score >= 85, Docker `--network=none`, `private-vault`, 0% pass across 2+ frontier models (or 3+ trials) |

_\*Indicative market estimates based on current RL-environment & SWE-eval benchmarks (not guaranteed payouts). Actual vault payouts depend on buyer match and server-side QA._

### 7. Pack into a vault-ready archive + Blind Scorecard (`card.json`)
Enforces `audit` + fresh verification checksum + IP ownership attestation, automatically embeds matching benchmark scores and valuation into `card.json`, and outputs `<id>.evalkit.tar.gz`:

```bash
evalkit pack ./evals/webhook-race --attest-ip --license private-vault
```

### 8. Generate a static leaderboard (`docs/`)
Aggregates all `card.json` files in a directory into a standalone HTML + JSON leaderboard ready for GitHub Pages:

```bash
evalkit leaderboard ./examples --out ./docs
```

### 9. Submit to the Private Vault (blind card or full bundle)
Preview what leaves your machine (`--dry-run`), submit a **blind `card.json` only** via GitHub Issues (`--github-issue`, zero source code exposed), or push to a Private Vault HTTPS endpoint (`--endpoint` / `EVALKIT_VAULT_URL`):

```bash
# Dry-run preview (prints exact blind scorecard payload)
evalkit submit ./evals/webhook-race --dry-run

# Zero-infra blind scorecard submission (keeps code 100% private on your machine)
evalkit submit ./evals/webhook-race --github-issue

# Push to a Private Vault Worker endpoint (see vault-worker/)
evalkit submit ./evals/webhook-race --endpoint https://<your-worker>/submit --full-bundle
```

---

## Deploy Your Own Private Vault Intake (`vault-worker/`)

A minimal Cloudflare Worker + R2 intake endpoint ships in [`vault-worker/`](vault-worker/) so you can collect verified blind cards and private `.evalkit.tar.gz` bundles in 2 minutes with `npx wrangler deploy`.

---

## Open Bundle Specification (`v0.1`)

```text
<task-id>/
├── eval.yaml              # Metadata, stack tags, timeouts, IP attestation & license
├── prompt.md              # Clean problem statement shown to the agent (zero leaks)
├── card.json              # Generated Blind Scorecard (safe to share publicly)
├── environment/
│   ├── Dockerfile         # Reproducible offline image pinned at base_commit
│   ├── repo/              # Clean snapshot at base_commit (zero future git leaks)
│   └── mocks/             # Offline stubs/fixtures for external APIs
├── grading/               # NEVER mounted during solve; injected read-only at grade time
│   ├── verify.sh          # Executable entrypoint (exit 0 = pass, non-zero = fail)
│   ├── tests/             # Hidden fail-to-pass + regression tests
│   └── rubric.yaml        # Weighted criteria for partial-credit / judge grading
└── private/               # NEVER mounted during solve; kept private for vault/buyers
    ├── gold.patch         # Verified reference fix
    ├── debrief.md         # Author's root-cause notes, traps, & where AI agents got stuck
    ├── metadata.json      # Source commit stats & detected stack
    ├── verify-report.json # Signed verification run telemetry & bundle SHA-256
    └── bench-report.json  # Per-trial agent benchmark results & diffs
```

---

## Roadmap Status

- **v0.1 (Shipped):** Universal Agent Skill + CLI + Open Bundle Spec + secret/leak auditing + offline Docker/local verification + Blind Scorecard (`card.json`).
- **v0.2 (Shipped):** `evalkit bench` multi-agent runner (`claude`, `codex`, `gemini`, `opencode`, `--cmd`), auto-embedded benchmark scores in `card.json`, GitHub Actions CI, and 1-command `npx` install.
- **v0.3 (Shipped):** Verified showcase evals (`examples/`), `evalkit leaderboard` static GitHub Pages generator (`docs/`), `evalkit submit` (dry-run, `--github-issue` blind card, HTTPS vault API), and deployable Cloudflare Worker intake (`vault-worker/`).
- **v0.4 (Shipped):** Transparent Signal Score (`0-100`), Tier (`S`/`A`/`B`/`C`), indicative market valuation estimator (`evalkit estimate`), embedded into `card.json` and the live leaderboard.

---

## Local Development

```bash
git clone https://github.com/abhilashi/evalkit.git
cd evalkit
npm install
npm test
npm link
```

## License

MIT
