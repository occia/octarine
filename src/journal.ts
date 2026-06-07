/**
 * The run journal: the structured, execution-ordered summary the entry.html is
 * rendered from. The explore-loop fills it as it runs (per-step time + tokens +
 * outcomes); journal.json is written alongside entry.html for machine use.
 */

import { AgentStats, SourceVersion } from "./types";

export interface VerifyStats {
  durationMs: number;
  clean: boolean;
  reason: string;
  edges: number;
  features: number;
  corpus: number;
  crashGroups: number;
}

export interface AssessStats extends AgentStats {
  sufficient: boolean;
  reasoning: string;
}

export interface AttemptRecord {
  attempt: number;
  /** report-relative dir: surface-<slug>/attempt-<n>. */
  dir: string;
  generation: AgentStats;
  harnessName?: string;
  verify?: VerifyStats;
  assess?: AssessStats;
  /** submitted | correctness-failed | insufficient | no-harness */
  outcome: string;
  /** report-relative path to the rendered generation conversation html (raw jsonl alongside). */
  conversationRel?: string;
  /** report-relative path to the rendered crash-attribution conversation(s) html (verify step). */
  verifyConversationRel?: string;
  /** report-relative path to the rendered assessment conversation html. */
  assessConversationRel?: string;
}

/** One attack surface as listed by the survey (the full map, not just the worked ones). */
export interface SurveySurface {
  id: string;
  title: string;
  apis: string[];
  priority: number;
  status: string;
}

export interface SurfaceRecord {
  id: string;
  title: string;
  apis: string[];
  priority: number;
  status: string;
  harnessName?: string;
  /** report-relative dir holding the submitted harness sources (self-contained). */
  harnessSrcRel?: string;
  attempts: AttemptRecord[];
}

export interface RunJournal {
  target: string;
  /** Synthetic content-hash that keys cross-run memory (NOT the upstream commit). */
  commit: string;
  /** Real upstream branch+commit captured at build time (display); undefined for pre-capture runs. */
  sourceVersion?: SourceVersion;
  language: string;
  sanitizer: string;
  budget: { maxWallTimeSec: number; perFuzzSec: number; maxSurfaceAttempts: number };
  startedAtMs: number;
  /** human-readable run start, timezone-aware (e.g. "2026-06-05 16:01:36 UTC") — this run's stamp. */
  startedAtLabel?: string;
  endedAtMs: number;
  survey: {
    stats: AgentStats;
    total: number;
    covered: number;
    pending: number;
    /** the full surveyed surface list (id/title/apis/priority/status), for the entry.html survey table. */
    surfaces?: SurveySurface[];
    /** report-relative path to the rendered survey conversation html. */
    transcriptRel?: string;
    /** true when the survey was SKIPPED because this run resumed from an existing ledger. */
    skipped?: boolean;
  };
  surfaces: SurfaceRecord[];
}

export interface Totals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  done: number;
  failed: number;
  submitted: number;
  elapsedMin: number;
}

export function totals(j: RunJournal): Totals {
  let inTok = j.survey.stats.inputTokens;
  let outTok = j.survey.stats.outputTokens;
  let cost = j.survey.stats.costUsd;
  let submitted = 0;
  for (const s of j.surfaces) {
    for (const a of s.attempts) {
      inTok += a.generation.inputTokens + (a.assess?.inputTokens ?? 0);
      outTok += a.generation.outputTokens + (a.assess?.outputTokens ?? 0);
      cost += a.generation.costUsd + (a.assess?.costUsd ?? 0);
      if (a.outcome === "submitted") submitted++;
    }
  }
  return {
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd: cost,
    done: j.surfaces.filter((s) => s.status === "done").length,
    failed: j.surfaces.filter((s) => s.status === "failed").length,
    submitted,
    elapsedMin: (j.endedAtMs - j.startedAtMs) / 60000,
  };
}
