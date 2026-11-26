# evalkit

**Turn real-world bugs and AI agent failure states in any git repo into reproducible, verified eval environments.**

When AI generates most of the code, **the frontier failure boundary is the dataset**: the exact moments where coding agents loop, break regressions, or fail on messy full-stack apps and a developer has to step in.

`evalkit` combines an **open-source CLI** with a **universal Agent Skill (`SKILL.md`)** so any developer can package a real commit range — live right after fixing a gnarly bug, or mined from a side-project graveyard — into an offline-reproducible, leak-free, 3x-verified eval bundle in minutes.

---

## Why `evalkit`?

- **Built for real messy repos** — TypeScript, Next.js, Postgres, Playwright, Python, Go, Rust (not just toy algorithms).
- **Split architecture:** Your AI coding agent handles the judgment work (mining commits, drafting a leak-free prompt, authoring missing tests, capturing your 90-second debrief); the deterministic CLI enforces hard mechanical guarantees.
- **Zero-leak snapshotting:** Exports `base_commit` via `git archive` into a fresh single-commit repo so evaluated agents can never run `git log` to read `fix_commit` or deleted secrets.
- **Offline determinism:** Verifies inside Docker with `--network=none` that `base_commit` fails cleanly and `gold.patch` passes 3/3 times with zero flakiness.
- **Blind Scorecard (`card.json`):** Exports a shareable metadata card (stack, diff complexity, verification proof, SHA-256) without leaking your code or prompt.

---

## Quickstart

### 1. Build / install locally

```bash
npm install
npm run build
npm link   # exposes `evalkit` globally in your terminal
```

### 2. Install the universal Agent Skill

Installs `SKILL.md` into your coding agent(s) (Antigravity, Claude Code, Cursor, Codex):

```bash
evalkit install-skill --target auto
# or target a specific tool:
evalkit install-skill --target claude
evalkit install-skill --target antigravity
evalkit install-skill --target all
```

Then open your coding agent in any git repo and say:
> *"Turn the bug I just fixed into a verified eval using evalkit."*

---

## CLI Workflow

### Mine a repo for high-signal commits
Great for turning an abandoned side project into high-signal evals:

```bash
evalkit mine --repo ./my-indie-app --top 8
```

### Initialize a clean eval bundle
Snapshots `base_commit`, strips `.env*` & keys, detects stack, extracts changed tests into `grading/tests/`, and scaffolds the full bundle:

```bash
evalkit init --repo ./my-indie-app --from HEAD~1 --to HEAD --out ./evals/webhook-race
```

### Audit for secrets, PII, git leaks, and prompt leaks
Scans every text file in the bundle with built-in secret/entropy rules, checks git history squashing, and catches unfilled placeholders or copied diff lines in `prompt.md`:

```bash
evalkit audit ./evals/webhook-race
```

### Verify determinism (base fails + gold passes 3/3)
Runs the full verification oracle inside an offline Docker container (`--network=none`), or in a temporary local sandbox (`--mode local`) while iterating:

```bash
evalkit verify ./evals/webhook-race --runs 3
# or without Docker running during fast local iteration:
evalkit verify ./evals/webhook-race --mode local --runs 3
```

### Pack into a vault-ready archive + Blind Scorecard
Enforces `audit` + fresh verification checksum + IP ownership attestation, then outputs `card.json` and `<id>.evalkit.tar.gz`:

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
    └── verify-report.json # Signed verification run telemetry & bundle SHA-256
```

---

## Roadmap: Open Tool → Private Vault

1. **v0.1 (Now — Open Source):** Universal Agent Skill + CLI + Open Bundle Spec + local/Docker deterministic verification.
2. **v0.2 (Local Bench & Teaser Leaderboard):** `evalkit bench` runner to score Claude / GPT / Gemini / local models on your own repo + 25–50 curated open-source indie full-stack benchmark tasks.
3. **v0.3 (Private Held-Out Vault):** Opt-in `evalkit submit --vault` with cloud sandbox verification, frontier difficulty scoring, standing lab bounties, and author payouts — keeping submitted tasks strictly private and uncontaminated.

---

## License

MIT
