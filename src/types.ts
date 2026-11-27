export type TaskCategory = "bugfix" | "feature" | "refactor" | "migration" | "perf";
export type GradingType = "deterministic" | "hybrid";
export type SandboxMode = "docker-offline" | "local";

export interface EvalConfig {
  spec_version: string;
  id: string;
  title: string;
  stack: string[];
  category: TaskCategory;
  source: {
    base_commit: string;
    fix_commit: string;
    captured_at: string;
    files_changed: number;
    insertions: number;
    deletions: number;
  };
  timeouts: {
    solve_sec: number;
    verify_sec: number;
  };
  grading: {
    type: GradingType;
    network_access: boolean;
    flakiness_runs: number;
  };
  ownership: {
    author_attestation: boolean;
    license: "private-vault" | "mit" | "apache-2.0";
  };
}

export interface CandidateCommit {
  hash: string;
  shortHash: string;
  parentHash: string;
  date: string;
  subject: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  touchesTests: boolean;
  score: number;
  reasons: string[];
}

export interface SecretFinding {
  file: string;
  line: number;
  rule: string;
  severity: "error" | "warning";
  snippet: string;
}

export interface AuditIssue {
  category: "secret" | "pii" | "git-leak" | "prompt-leak" | "structure";
  severity: "error" | "warning";
  file?: string;
  line?: number;
  message: string;
}

export interface AuditReport {
  bundleDir: string;
  passed: boolean;
  errorCount: number;
  warningCount: number;
  filesScanned: number;
  issues: AuditIssue[];
}

export interface VerifyRunResult {
  run: number;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  outputTail: string;
}

export interface VerifyReport {
  spec_version: string;
  id: string;
  verified_at: string;
  sandbox: SandboxMode;
  network_isolated: boolean;
  bundle_sha256: string;
  passed: boolean;
  base_check: {
    failed_as_expected: boolean;
    exit_code: number;
    duration_ms: number;
    output_tail: string;
  };
  gold_checks: {
    runs_requested: number;
    runs_passed: number;
    all_passed: boolean;
    results: VerifyRunResult[];
  };
}

export interface BenchTrialResult {
  trial: number;
  passed: boolean;
  solve_exit_code: number;
  grade_exit_code: number;
  solve_duration_ms: number;
  grade_duration_ms: number;
  files_changed: number;
  insertions: number;
  deletions: number;
  solve_timed_out: boolean;
  output_tail: string;
}

export interface BenchAgentSummary {
  agent: string;
  passed: number;
  trials: number;
  pass_rate: number;
  avg_solve_ms: number;
  avg_insertions: number;
  avg_deletions: number;
  results: BenchTrialResult[];
}

export interface BenchReport {
  spec_version: string;
  id: string;
  benchmarked_at: string;
  bundle_sha256: string;
  grade_sandbox: SandboxMode;
  network_isolated_grading: boolean;
  trials_per_agent: number;
  agents: BenchAgentSummary[];
}

export type ValuationTier = "S" | "A" | "B" | "C" | "UNBENCHMARKED" | "NOT_ELIGIBLE";

export interface ValuationBreakdownItem {
  factor: string;
  points: number;
  max_points: number;
  note: string;
}

export interface BundleValuation {
  tier: ValuationTier;
  score: number;
  max_score: number;
  indicative_range_usd: { min: number; max: number } | null;
  frontier_agents_tested: number;
  frontier_pass_rate: number | null;
  breakdown: ValuationBreakdownItem[];
  upgrade_hints: string[];
  disclaimer: string;
}

export interface BlindCard {
  spec_version: string;
  id: string;
  stack: string[];
  category: TaskCategory;
  complexity: {
    files_changed: number;
    insertions: number;
    deletions: number;
  };
  verification: {
    verified: boolean;
    sandbox: SandboxMode | "unverified";
    network_isolated: boolean;
    gold_pass_rate: string;
    verified_at: string | null;
  };
  benchmark?: {
    benchmarked_at: string;
    grade_sandbox: SandboxMode;
    trials_per_agent: number;
    results: Array<{
      agent: string;
      passed: number;
      trials: number;
      pass_rate: number;
      avg_solve_ms: number;
    }>;
  };
  valuation?: BundleValuation;
  ownership: {
    author_attestation: boolean;
    license: string;
  };
  bundle_sha256: string;
  packed_at: string;
}
