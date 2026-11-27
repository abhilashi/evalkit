---
name: evalkit
description: Turn real-world bugs, hard refactors, and moments where AI coding agents got stuck into clean, offline-reproducible, verified eval environments using the evalkit CLI. Use when a user wants to turn a git commit, PR, recent bug fix, or side project into an eval bundle, benchmark, or RL environment.
---

# evalkit — Project-to-Eval Authoring Skill

You are helping a developer turn a real-world engineering task (especially a bug or edge case where frontier AI coding agents struggled) into a **reproducible, leak-free, verified eval bundle** using `evalkit`.

## Core Principles (Never Violate)

1. **Zero Leaks:** The evaluated agent only sees `environment/repo/` (pinned at `base_commit`) and `prompt.md`. Never mention internal file paths, function names, or patch hints in `prompt.md` unless they are part of the external public contract.
2. **Spec-Test Alignment:** Every single assertion checked in `grading/tests/` MUST be unambiguously derivable from `prompt.md`. If a test checks a specific HTTP status code, error key, route, DOM selector, or edge case, `prompt.md` must specify that contract.
3. **Offline Determinism:** Both solving and grading must succeed under `--network=none`. Stub external APIs (Stripe, Supabase, Clerk, OpenAI, S3, email providers) inside `environment/mocks/` or test fixtures.
4. **Never Skip Mechanical Gates:** Always run `evalkit audit` and `evalkit verify` before declaring the bundle done.

---

## Step-by-Step Workflow

### Step 1: Identify the Task Commit Range
* **Live capture ("AI just got stuck on this"):** Use the recent broken -> fixed commits (typically `--from HEAD~1 --to HEAD` or `<base-branch>..HEAD`). If the fix is uncommitted, ask the user if they want to commit it first or create a temporary branch commit.
* **Graveyard mining (older repo):** Run:
  ```bash
  evalkit mine --repo . --top 8
  ```
  Present the top 3-5 candidate commits to the user and let them pick one. Prioritize multi-file bug fixes, race conditions, UI/state bugs, and auth/data edge cases over generic boilerplate.

### Step 2: Scaffold the Clean Snapshot
Run `evalkit init`:
```bash
evalkit init --repo . --from <base_commit> --to <fix_commit> --out ./evals/<slug>
```
This exports a single-commit clean snapshot (stripping `.env*` and future git history), detects the stack, extracts any changed test files into `grading/tests/`, and saves the reference fix to `private/gold.patch`.

### Step 3: Author `prompt.md` (Leak-Free Specification)
Read `private/gold.patch` and the surrounding files in `environment/repo/`, then rewrite `prompt.md` completely (removing all `TODO` / `EVALKIT` markers):
* Describe the **user-visible problem or feature requirement** clearly.
* Specify all **observable contracts** (inputs, outputs, API shapes, status codes, UI interactions, edge cases).
* **Do NOT** copy code snippets from `private/gold.patch` or dictate internal implementation details.

### Step 4: Build Deterministic Hidden Tests & Offline Mocks
Inspect `grading/tests/` and `grading/verify.sh`:
* If the commit didn't include tests (common in indie repos), write minimal, crisp, deterministic fail-to-pass tests in `grading/tests/` (Vitest/Jest/`node --test`/pytest/Playwright) that:
  1. **Fail** on `environment/repo/` (at `base_commit`) specifically because of the bug/missing behavior.
  2. **Pass** reliably 3/3 times after `private/gold.patch` is applied.
  3. Include at least one regression check so a trivial stub cannot pass.
* If the repo calls external SaaS APIs, add lightweight offline stubs/mocks in `environment/mocks/` or inside the test harness so `verify.sh` passes under `--network=none`.
* Update `environment/Dockerfile` if extra build steps, DB fixtures, or Playwright browsers are required during image build.

### Step 5: Capture the 90-Second Frontier Debrief
Ask the user **3 short questions** (all at once in a single message) to complete `private/debrief.md`:
1. What was the real root cause, and what made it non-obvious?
2. What plausible first-pass fixes break subtle edge cases?
3. If an AI coding agent tried this first, where did it get stuck or loop?

Fill in `private/debrief.md` and refine `grading/rubric.yaml` with their answers.

### Step 6: Adversarial Spec-Test Alignment Review
Before verifying, perform a strict self-audit pretending you have **never seen `private/gold.patch`**:
* Read ONLY `prompt.md` and `grading/tests/*`.
* For every assertion in `grading/tests/*`, verify: *"Could a skilled senior engineer reading only `prompt.md` know this exact requirement?"*
* Fix any hidden assumptions in `prompt.md` or relax overly brittle assertions (e.g., exact wording of prose messages) in `grading/tests/`.

### Step 7: Run Mechanical Verification & Audit
Run both gates:
```bash
evalkit audit ./evals/<slug>
evalkit verify ./evals/<slug> --runs 3
```
* If `audit` flags secrets, local paths (`/Users/...`), or unfilled placeholders, scrub them and re-run `audit`.
* If Docker isn't running locally, inform the user and offer `--mode local` for quick iteration — while reminding them to run full Docker `--network=none` verification before packing for submission.
* Do not stop until `base_check` **fails cleanly** and `gold_checks` **pass 3/3**.

### Step 8: Benchmark Frontier Agents (Optional but High-Signal)
If the user wants to test whether frontier models actually fail on this task (and stamp difficulty onto `card.json`):
```bash
evalkit bench ./evals/<slug> --agents claude,codex,gemini --trials 3
# or sanity-check the bench harness without spending tokens:
evalkit bench ./evals/<slug> --agents noop,oracle --trials 1
```
Bench results are saved to `private/bench-report.json` and automatically embedded into `card.json` when packing.

### Step 9: Estimate Value, Pack & Generate Blind Scorecard
Run `evalkit estimate ./evals/<slug>` to review the transparent `0–100` Signal Score, Tier, indicative market range, and any upgrade hints (e.g., running Docker `--network=none` verification or benchmarking 2+ frontier models).

Once `audit` and `verify` both pass, confirm with the user that they own the IP / have rights to license the code, then run:
```bash
evalkit pack ./evals/<slug> --attest-ip --license private-vault
```
Show the user the generated `card.json` (the blind scorecard containing only stack, complexity, verification status, optional frontier benchmark pass rates, indicative valuation tier, and SHA-256 — safe to share publicly without leaking code or prompt) and the path to the `.evalkit.tar.gz` archive.

### Step 10: Optional Blind Trace Board / Private Vault Publishing
If the user wants to share their blind trace on the live Community Board or submit to a vault endpoint:
```bash
# Preview blind trace payload first (zero code, prompts, diffs, or stdout):
evalkit publish ./evals/<slug> --dry-run

# Publish directly to the live Blind Trace Board:
evalkit publish ./evals/<slug> --board

# Or submit directly to a configured Private Vault HTTPS endpoint:
evalkit submit ./evals/<slug> --endpoint "$EVALKIT_VAULT_URL"
```
