/**
 * Shared types for octarine.
 *
 * The CRS generates an OSS-Fuzz harness with Claude Code, then *verifies* it by
 * fuzzing: every crash group is root-caused and attributed to either the harness
 * (a false positive) or the target source (a real bug). A harness is submitted
 * only if no crash group is a false positive.
 */

export type Language = "c" | "c++" | "jvm";

/**
 * Real upstream source provenance, captured at BUILD time (in compile_target) from the clone's
 * `.git` — before libCRS strips `.git` when delivering the source to the CRS. This is the human
 * source identity (e.g. `master @ 32428ab` of github.com/libimobiledevice/libplist), distinct from
 * the synthetic content-hash `commit` used to key cross-run memory.
 */
export interface SourceVersion {
  /** Clone remote (== the project's main_repo). */
  repoUrl: string;
  /** Branch name at build time (e.g. "master"); "HEAD" when detached/unknown. */
  branch: string;
  /** Full upstream commit sha that was built. */
  commit: string;
  /** First 12 chars of `commit`, for display. */
  shortCommit: string;
  /** `git describe --tags --always`, when available. */
  describe?: string;
  /** Optional display note (e.g. when a commit was re-derived after the fact rather than captured at build). */
  note?: string;
}

/** Global limits for one exploration run. */
export interface Budget {
  /** Whole-run wall-time cap in seconds (0 = no cap) — the primary global bound. */
  maxWallTimeSec: number;
  /** libFuzzer -max_total_time per harness, in seconds. */
  perFuzzSec: number;
  /** Safety cap on generate→verify→assess attempts per attack surface. */
  maxSurfaceAttempts: number;
  /** Cumulative LLM cost cap for the run in USD (0 = no cap). Stop exploring once spend reaches it. */
  maxCostUsd: number;
  /** Per-generation wall-time cap in seconds (0 = unbounded). Bounds a single harness generation so
   *  one slow/non-converging attempt on a huge codebase can't consume the whole run. */
  genTimeoutSec: number;
}

/** libFuzzer campaign tuning. */
export interface FuzzConfig {
  /** -fork parallelism; 0 ⇒ auto from available CPUs. */
  forkJobs: number;
}

/** Fully-resolved configuration for a run, derived from the environment. */
export interface Config {
  target: string;
  language: Language;
  sanitizer: string;
  llmApiUrl: string;
  llmApiKey: string;
  oauthToken: string;
  paths: {
    work: string;
    src: string;
    harness: string;
    agent: string;
    verifier: string;
    state: string;
    buildResp: string;
    /** Mounted, persisted run-report dir (OSS_CRS_LOG_DIR/report) for offline analysis. */
    report: string;
  };
  budget: Budget;
  fuzz: FuzzConfig;
  /** Max concurrent analysis sub-agents. */
  analysisConcurrency: number;
  /** Treat `uncertain` crash groups as dirty (do not submit). */
  treatUncertainAsDirty: boolean;
}

/** Status of one attack surface in the ledger. */
// Final statuses (inherited across runs, skipped on resume): covered | done | failed.
// Non-final (redone on resume): pending | in_progress. A surface only becomes `failed` when it
// exhausts maxSurfaceAttempts; a surface cut off by the time/token budget mid-work is left
// `pending` so the next run redoes it from scratch.
export type SurfaceStatus = "covered" | "pending" | "in_progress" | "done" | "failed";

/** One attack surface = one or more APIs suitable for a single fuzz harness. */
export interface AttackSurface {
  id: string;
  title: string;
  apis: string[];
  rationale: string;
  /** Higher = surveyed as more valuable to fuzz next. */
  priority: number;
  status: SurfaceStatus;
  /** Binary name of the harness covering this surface, once done. */
  harnessName?: string;
  /** generate→verify→assess attempts spent on this surface. */
  attempts: number;
  /** Last correctness or sufficiency feedback (for resuming / reporting). */
  lastFeedback?: string;
}

/** The Assessor's judgment of whether a (correct) harness sufficiently explores a surface. */
export interface SufficiencyVerdict {
  sufficient: boolean;
  reasoning: string;
  /** Concrete improvement direction when not sufficient. */
  feedback?: string;
}

/** Identifies the report/work location for one generate→verify→assess attempt. */
export interface RunCtx {
  surfaceId: string;
  attempt: number;
}

/** Token / time / cost for one agent (`claude -p`) invocation. */
export interface AgentStats {
  durationMs: number;
  /** input tokens incl. cache creation + read. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** A normalized crash fingerprint extracted from sanitizer output. */
export interface CrashFrame {
  func: string;
  file?: string;
  line?: number;
}
export interface CrashSignature {
  /** e.g. "heap-buffer-overflow", "SEGV", "undefined-behavior", "leak", "timeout". */
  errorType: string;
  /** Top frames after dropping harness/runtime noise, used for grouping. */
  topFrames: CrashFrame[];
  /** Original SUMMARY: line, kept for reporting. */
  rawSummary?: string;
}

/** A set of crash artifacts sharing one signature. */
export interface CrashGroup {
  id: string;
  signature: CrashSignature;
  artifacts: string[];
  firstSeenMs: number;
}

export type Attribution = "false_positive" | "real_bug" | "uncertain";

/** Per-crash-group root-cause + attribution from an analysis sub-agent. */
export interface AttributionVerdict {
  groupId: string;
  attribution: Attribution;
  /** Where the natural fix belongs: harness ⇒ false positive, target ⇒ real bug. */
  fixLocation: "harness" | "target" | "none";
  explanation: string;
  /** Concrete direction fed back to the next generation round. */
  suggestedFixDirection?: string;
  /** claude session id of this attribution agent (so its conversation can be snapshotted). */
  sessionId?: string;
}

/** Coverage observed from libFuzzer's own counters (no coverage build in v1). */
export interface CoverageStats {
  edges: number;
  features: number;
  corpusSize: number;
}

export type VerdictReason =
  | "ok"
  | "false_positive"
  | "uncertain"
  | "build_failed"
  | "no_harness";

/** The verifier's decision for one round. */
export interface VerifierVerdict {
  /** true ⇒ safe to submit. */
  clean: boolean;
  reason: VerdictReason;
  groups: AttributionVerdict[];
  coverage?: CoverageStats;
  /** Human/agent-readable feedback used as the next round's prompt. */
  findings: string;
  round: number;
}

/** Run-level exploration state, written by the orchestrator for offline analysis. */
export interface RunState {
  schema: 2;
  target: string;
  /** Synthetic content-hash that keys cross-run memory (NOT the upstream commit). */
  commit: string;
  /** Real upstream branch+commit captured at build time (display); undefined for pre-capture runs. */
  sourceVersion?: SourceVersion;
  startedAtMs: number;
  surfaces: { id: string; title: string; status: SurfaceStatus; harnessName?: string; attempts: number }[];
  submittedCount: number;
  updatedAtMs: number;
}
