# evalkit

[![CI](https://github.com/abhilashi/evalkit/actions/workflows/ci.yml/badge.svg)](https://github.com/abhilashi/evalkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Turn real-world bugs and AI agent failure states in any git repo into reproducible, verified eval environments.**

When AI generates most of the code, **the frontier failure boundary is the dataset**: the exact moments where coding agents loop, break regressions, or fail on messy full-stack apps and a developer has to step in.

`evalkit` pairs an **open-source CLI** with a **universal Agent Skill (`SKILL.md`)** so any developer can package a real commit range — live right after fixing a gnarly bug, or mined from a side-project graveyard — into an offline-reproducible, leak-free, 3x-verified eval bundle and benchmark coding agents against it in minutes.

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

## Why `evalkit`?

- **Built for real messy repos** — TypeScript, Next.js, Postgres, Playwright, Python, Go, Rust (not just toy algorithms).
- **Split architecture:** Your AI coding agent handles judgment work (mining commits, drafting a leak-free prompt, authoring missing tests, capturing your 90-second debrief); the deterministic CLI enforces hard mechanical guarantees.
- **Zero-leak snapshotting:** Exports `base_commit` via `git archive` into a fresh single-commit repo so evaluated agents can never run `git log` to read `fix_commit` or deleted secrets.
- **Offline determinism:** Verifies inside Docker with `--network=none` that `base_commit` fails cleanly and `gold.patch` passes 3/3 times with zero flakiness.
- **Built-in multi-agent benchmarking (`evalkit bench`):** Pit `claude`, `codex`, `gemini`, `opencode`, or any custom CLI agent against your own real bugs and print a shareable scorecard.
- **Blind Scorecard (`card.json`):** Exports a shareable metadata card (stack, diff complexity, verification proof, frontier pass rates, SHA-256) without leaking your code or prompt.

---

## CLI Workflow

### 1. Mine a repo for high-signal commits
Turn an abandoned side project into high-signal evals:

```bash
evalkit mine --repo ./my-indie-app --top 8
```

### 2. Initialize a clean eval bundle
Snapshots `base_commit`, strips `.env*` & keys, detects stack, extracts changed tests into `grading/tests/`, and scaffolds the full bundle:

```bash
evalkit init --repo ./my-indie-app --from HEAD~1 --to HEAD --out ./evals/webhook-race
```

### 3. Audit for secrets, PII, git leaks, and prompt leaks
Scans every text file with built-in secret/entropy rules, checks git history squashing, and catches unfilled placeholders or copied diff lines in `prompt.md`:

```bash
evalkit audit ./evals/webhook-race
```

### 4. Verify determinism (base fails + gold passes 3/3)
Runs the verification oracle inside an offline Docker container (`--network=none`), or in a temporary local sandbox (`--mode local`) while iterating:

```bash
evalkit verify ./evals/webhook-race --runs 3
# or without Docker running during fast local iteration:
evalkit verify ./evals/webhook-race --mode local --runs 3
```

### 5. Benchmark coding agents on your task
Run installed coding agents (or any custom command) inside an isolated copy of `base_commit` — with `grading/` and `private/` strictly hidden — then grade every agent's produced patch offline:

```bash
# Built-in adapters: claude, codex, gemini, opencode, oracle, noop
evalkit bench ./evals/webhook-race --agents claude,codex,gemini --trials 3

# Or benchmark any custom agent / script / MCP setup:
evalkit bench ./evals/webhook-race \
  --cmd "my-agent=python run_agent.py {prompt_file}" \
  --agents oracle,noop
```

Example scorecard output:

```text
▸ evalkit bench — webhook-race (node, typescript, stripe) [docker-offline]

  Agent           Pass Rate       Avg Solve   Avg Diff      Status
  ──────────────────────────────────────────────────────────────────
  noop            0/3 (0%)        0ms         +0 / -0       FAIL
  claude          0/3 (0%)        41.2s       +19 / -4      FAIL
  codex           1/3 (33%)       36.8s       +24 / -6      PARTIAL
  oracle          3/3 (100%)      12ms        +28 / -5      PASS
```

### 6. Pack into a vault-ready archive + Blind Scorecard
Enforces `audit` + fresh verification checksum + IP ownership attestation, automatically embeds matching benchmark results into `card.json`, and outputs `<id>.evalkit.tar.gz`:

```bash
evalkit pack ./evals/webhook-race --attest-ip --license private-vault
```

---

## Open Bundle Specification (`v0.1`)

```text
<task-id>/
├── eval.yaml              # Metadata, stack tags, timeouts, IP attestation & license
├── prompt.md              # Clean problem statement shown to the agent (zero leaks)
├── card.json              # Generated Blind Scorecard (safe to share publicly)
├── environment/
│   ├── Dockerfile         # Reproducible offline image pinned at base_commit
│   ├── repo/              # Clean single-commit snapshot at base_commit
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

## Roadmap: Open Tool → Private Vault

1. **v0.1 (Shipped):** Universal Agent Skill + CLI + Open Bundle Spec + secret/leak auditing + Docker `--network=none` deterministic verification.
2. **v0.2 (Shipped):** `evalkit bench` multi-agent runner (`claude`, `codex`, `gemini`, `opencode`, `--cmd`), benchmark scores embedded in `card.json`, CI, and 1-command `npx` install.
3. **v0.3 (Next):** Curated open-source teaser benchmark (25–50 real indie full-stack tasks + public leaderboard) & opt-in `evalkit submit --vault` for private held-out licensing and developer bounties.

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
