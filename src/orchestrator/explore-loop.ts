/**
 * The attack-surface exploration loop. The unit of work is an attack surface
 * (one or more APIs for a single harness). A Surveyor agent maps the project's
 * surfaces into the ledger; then, until the time/token budget is spent, the loop
 * picks the next pending surface and runs an inner loop:
 *
 *   generate harness for the surface
 *     → verify (CORRECTNESS gate: fuzz, reject false-positive crashes)
 *     → assess (SUFFICIENCY gate: an independent agent judges, from first
 *       principles, whether the harness can thoroughly explore the surface)
 *
 * A surface is "done" (and its harness submitted) only when a harness is BOTH
 * correct AND sufficient. Both gates feed the same generator with feedback.
 */

import * as fs from "fs";
import * as path from "path";
import { Config, RunState, RunCtx, AttackSurface, SurfaceStatus, AgentStats, SourceVersion } from "../types";
import { LibCrs } from "../libcrs/client";
import { runGeneration, runSurvey, runAssessment, SurveyedSurface } from "../agent/claude";
import { surfacePrompt } from "../agent/prompts";
import { verify } from "../verifier/index";
import { listNewHarnesses } from "../verifier/fuzz-runner";
import { withinBudget } from "../verifier/budget";
import { writeState } from "../verifier/state";
import { log } from "../util/log";
import { mkdirp, dirHasNonEmptyFile, readFileOr, copyDirContents } from "../util/fs";
import { ledgerDir, harnessesDir, ledgerIndexPath, loadLedger, renderLedger, selectNextPending, resumeEnabled } from "../ledger";
import {
  snapshotGeneration, snapshotLedger, snapshotSubmitted, snapshotTranscript,
  attemptDir, attemptRel, harnessDir, surveyDir, writeJson,
} from "../report";
import { RunJournal, SurfaceRecord, AttemptRecord, SurveySurface } from "../journal";
import { writeEntry } from "../entry-html";

export async function runExploration(
  c: Config,
  libcrs: LibCrs,
  env: NodeJS.ProcessEnv,
  commit: string,
  projectId: string,
  sourceVersion?: SourceVersion,
): Promise<RunState> {
  const now = () => Date.now();
  const start = now();
  const dir = ledgerDir(projectId, commit);
  mkdirp(dir);

  // 1. Build the surface map. If a ledger already exists for this (project, commit), RESUME from it
  // and SKIP the survey — the map is already known, so we go straight to working pending surfaces.
  // Re-surveying is only for re-analysis (e.g. the commit changed), a future feature. A fresh run
  // (no ledger) runs the surveyor to build the map.
  // Cross-run resume is a local-testing hack (the /hack-memory mount). In the real OSS-CRS env
  // (IN_OSS_CRS_ENV set) it is unsupported: skip the memory scan entirely and always start fresh.
  const existing = resumeEnabled() ? loadLedger(dir) : [];
  if (!resumeEnabled()) log.info("cross-run resume disabled (IN_OSS_CRS_ENV) — starting fresh, no memory scan");
  let surfaces: AttackSurface[];
  let surveyStats: AgentStats = { durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let surveyTranscriptRel: string | undefined;
  const surveySkipped = existing.length > 0;

  if (surveySkipped) {
    // Cut-off (in_progress) surfaces from a hard-killed prior run are redone from scratch.
    surfaces = existing.map((s) =>
      s.status === "in_progress" ? { ...s, status: "pending" as const, attempts: 0, lastFeedback: undefined } : s,
    );
    log.info("resuming from ledger — skipping survey", {
      ledgerDir: dir,
      surfaces: surfaces.length,
      done: surfaces.filter((s) => s.status === "done").length,
      failed: surfaces.filter((s) => s.status === "failed").length,
      pending: surfaces.filter((s) => s.status === "pending").length,
    });
  } else {
    const existingText = readFileOr(ledgerIndexPath(dir), "");
    log.info("surveying attack surfaces (fresh — no prior ledger)", { ledgerDir: dir });
    const surveyed = await runSurvey(c, env, existingText);
    surfaces = mergeSurfaces(existing, surveyed.surfaces);
    surveyStats = surveyed.stats;
    surveyTranscriptRel = snapshotTranscript(
      c,
      surveyed.sessionId ? [surveyed.sessionId] : [],
      surveyDir(c),
      "transcript",
      `${c.target} — attack-surface survey`,
    );
  }
  renderLedger(dir, c.target, commit, surfaces, sourceVersion);
  log.info("surfaces ready", {
    surfaces: surfaces.length,
    pending: surfaces.filter((s) => s.status === "pending").length,
    covered: surfaces.filter((s) => s.status === "covered").length,
    surveySkipped,
  });

  const journal: RunJournal = {
    target: c.target,
    commit,
    sourceVersion,
    language: c.language,
    sanitizer: c.sanitizer,
    budget: { ...c.budget },
    startedAtMs: start,
    startedAtLabel: formatRunTime(start),
    endedAtMs: start,
    survey: {
      stats: surveyStats,
      total: surfaces.length,
      covered: surfaces.filter((s) => s.status === "covered").length,
      pending: surfaces.filter((s) => s.status === "pending").length,
      surfaces: surveyList(surfaces),
      transcriptRel: surveyTranscriptRel,
      skipped: surveySkipped,
    },
    surfaces: [],
  };
  const flush = () => {
    journal.endedAtMs = now();
    journal.survey.surfaces = surveyList(surfaces); // keep statuses live as surfaces progress
    writeEntry(c, journal);
  };
  flush();

  const state: RunState = {
    schema: 2,
    target: c.target,
    commit,
    sourceVersion,
    startedAtMs: start,
    surfaces: summarize(surfaces),
    submittedCount: 0,
    updatedAtMs: start,
  };
  writeState(c.paths.state, state, now());

  // Cumulative LLM cost (survey + generations + assessments) for the cost-budget gate.
  let spentUsd = surveyStats.costUsd;

  // 2. Explore surfaces until the budget (wall-time OR cost) is spent or none remain pending.
  while (withinBudget(c.budget, start, now(), spentUsd)) {
    const s = selectNextPending(surfaces);
    if (!s) {
      log.info("no pending surfaces remain");
      break;
    }
    s.status = "in_progress";
    renderLedger(dir, c.target, commit, surfaces, sourceVersion);
    log.info("surface start", { id: s.id, title: s.title, apis: s.apis });
    const srec: SurfaceRecord = {
      id: s.id, title: s.title, apis: s.apis, priority: s.priority, status: s.status, attempts: [],
    };
    journal.surfaces.push(srec);

    let feedback = "";
    while (withinBudget(c.budget, start, now(), spentUsd) && s.attempts < c.budget.maxSurfaceAttempts) {
      s.attempts++;
      const ctx: RunCtx = { surfaceId: s.id, attempt: s.attempts };
      log.info("surface attempt", { id: s.id, attempt: s.attempts });

      // Start each attempt from a clean candidate; the agent re-downloads fuzz-proj.
      fs.rmSync(c.paths.buildResp, { recursive: true, force: true });
      fs.rmSync(path.join(c.paths.agent, "new-harnesses.txt"), { force: true });
      fs.rmSync(c.paths.harness, { recursive: true, force: true });
      mkdirp(c.paths.harness);

      const gen = await runGeneration(c, env, surfacePrompt(c, s, feedback));
      snapshotGeneration(c, ctx);
      const arec: AttemptRecord = { attempt: s.attempts, dir: attemptRel(ctx), generation: gen.stats, outcome: "correctness-failed" };
      arec.conversationRel = snapshotTranscript(
        c, gen.sessionIds, attemptDir(c, ctx), "conversation",
        `${c.target} — ${s.id} · attempt ${s.attempts} · generation`,
      );
      srec.attempts.push(arec);
      spentUsd += gen.stats.costUsd;

      // CORRECTNESS gate (build-gate is inside verify; build_failed/no_harness => not clean).
      const tVerify = now();
      const verdict = await verify(c, libcrs, env, ctx);
      const cov = verdict.coverage ?? { edges: 0, features: 0, corpusSize: 0 };
      arec.verify = {
        durationMs: now() - tVerify, clean: verdict.clean, reason: verdict.reason,
        edges: cov.edges, features: cov.features, corpus: cov.corpusSize, crashGroups: verdict.groups.length,
      };
      // Record the built harness name as soon as it exists (even on a failed attempt) so the
      // report's per-harness artifacts (fuzz.log/coverage) are linkable for every attempt.
      arec.harnessName = listNewHarnesses(c)[0] ?? arec.harnessName;
      // Snapshot the crash-attribution agents' conversations (one per crash group, when crashes
      // occurred) — the verify step IS agentic whenever it has to judge false-positive vs real bug.
      const attrSessionIds = verdict.groups.map((g) => g.sessionId).filter((x): x is string => !!x);
      if (attrSessionIds.length) {
        arec.verifyConversationRel = snapshotTranscript(
          c, attrSessionIds, attemptDir(c, ctx), "attribution-conversation",
          `${c.target} — ${s.id} · attempt ${s.attempts} · crash attribution`,
        );
      }
      writeJson(path.join(attemptDir(c, ctx), "verdict.json"), verdict);
      log.info("correctness verdict", { id: s.id, attempt: s.attempts, clean: verdict.clean, reason: verdict.reason });
      if (!verdict.clean) {
        feedback = verdict.findings;
        s.lastFeedback = feedback;
        arec.outcome = "correctness-failed";
        flush();
        continue;
      }

      // SUFFICIENCY gate.
      const harnessName = listNewHarnesses(c)[0];
      if (!harnessName) {
        feedback = "No harness binary name was recorded in new-harnesses.txt.";
        s.lastFeedback = feedback;
        arec.outcome = "no-harness";
        flush();
        continue;
      }
      arec.harnessName = harnessName;
      const assessment = await runAssessment(c, env, {
        surfaceTitle: s.title,
        apis: s.apis,
        harnessName,
        harnessSourceDir: path.join(c.paths.harness, "fuzz-proj"),
        fuzzLogPath: path.join(harnessDir(c, ctx, harnessName), "fuzz.log"),
        coverage: verdict.coverage ?? { edges: 0, features: 0, corpusSize: 0 },
      });
      arec.assess = { ...assessment.stats, sufficient: assessment.verdict.sufficient, reasoning: assessment.verdict.reasoning };
      spentUsd += assessment.stats.costUsd;
      writeJson(path.join(attemptDir(c, ctx), "assessment.json"), { ...assessment.verdict, stats: assessment.stats });
      arec.assessConversationRel = snapshotTranscript(
        c, assessment.sessionId ? [assessment.sessionId] : [], attemptDir(c, ctx), "assessment-conversation",
        `${c.target} — ${s.id} · attempt ${s.attempts} · assessment`,
      );
      log.info("sufficiency verdict", { id: s.id, attempt: s.attempts, sufficient: assessment.verdict.sufficient });

      if (assessment.verdict.sufficient) {
        srec.harnessSrcRel = snapshotSubmitted(c, s.id);
        storeHarness(c, projectId, commit, s.id); // persist the confirmed harness to cross-run memory
        await submit(c, libcrs, s.id);
        s.status = "done";
        s.harnessName = harnessName;
        s.lastFeedback = assessment.verdict.reasoning;
        srec.status = "done";
        srec.harnessName = harnessName;
        state.submittedCount++;
        arec.outcome = "submitted";
        log.info("surface done — harness submitted", { id: s.id, harness: harnessName });
        flush();
        break;
      }
      feedback = assessment.verdict.feedback ?? "Improve how thoroughly the harness exercises this surface.";
      s.lastFeedback = feedback;
      arec.outcome = "insufficient";
      flush();
    }

    if (s.status === "in_progress") {
      if (s.attempts >= c.budget.maxSurfaceAttempts) {
        // Genuinely exhausted every attempt → a FINAL failure; next run skips it.
        s.status = "failed";
        log.warn("surface failed (attempts exhausted)", { id: s.id, attempts: s.attempts, reason: (s.lastFeedback ?? "").slice(0, 160) });
      } else {
        // The time/token budget cut it off mid-work → not a final status; next run redoes it
        // from scratch (left pending, attempts/feedback reset on the next survey merge).
        s.status = "pending";
        s.lastFeedback = undefined;
        log.info("surface cut off by budget — left pending for next run", { id: s.id, attempts: s.attempts });
      }
    }
    srec.status = s.status;
    state.surfaces = summarize(surfaces);
    renderLedger(dir, c.target, commit, surfaces, sourceVersion);
    snapshotLedger(c, dir); // incremental: a hard-killed run still ships report/ledger/
    writeState(c.paths.state, state, now());
    flush();
    log.info("budget status", { spentUsd: Math.round(spentUsd * 100) / 100, maxCostUsd: c.budget.maxCostUsd, elapsedSec: Math.round((now() - start) / 1000) });
  }

  if (c.budget.maxCostUsd > 0 && spentUsd >= c.budget.maxCostUsd) {
    log.warn("cost budget reached — stopping run", { spentUsd: Math.round(spentUsd * 100) / 100, maxCostUsd: c.budget.maxCostUsd });
  }
  state.surfaces = summarize(surfaces);
  writeState(c.paths.state, state, now());
  snapshotLedger(c, dir);
  flush();
  log.info("exploration complete", {
    done: surfaces.filter((s) => s.status === "done").length,
    submitted: state.submittedCount,
    surfaces: surfaces.length,
    spentUsd: Math.round(spentUsd * 100) / 100,
  });
  return state;
}

/** Persist a confirmed (done) surface's harness sources into cross-run memory. Best-effort —
 *  memory is a convenience for later resume/refine, never worth failing the run over. */
function storeHarness(c: Config, projectId: string, commit: string, surfaceId: string): void {
  try {
    const slug = surfaceId.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 80) || "x";
    copyDirContents(path.join(c.paths.harness, "fuzz-proj"), path.join(harnessesDir(projectId, commit), slug));
  } catch {
    /* best-effort */
  }
}

/** Submit one surface's harness (the agent's current fuzz-proj), namespaced by surface id. */
async function submit(c: Config, libcrs: LibCrs, name: string): Promise<void> {
  const fuzzProj = path.join(c.paths.harness, "fuzz-proj");
  const targetSrc = path.join(c.paths.harness, "target-source");
  await libcrs.submitHarness({
    fuzzProjDir: fuzzProj,
    targetSourceDir: dirHasNonEmptyFile(targetSrc) ? targetSrc : undefined,
    name: name || c.target || undefined,
  });
}

/** Merge a fresh survey with prior ledger state, preserving final (done/failed/covered) work. */
function mergeSurfaces(existing: AttackSurface[], surveyed: SurveyedSurface[]): AttackSurface[] {
  const prior = new Map(existing.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: AttackSurface[] = [];
  for (const sv of surveyed) {
    seen.add(sv.id);
    const p = prior.get(sv.id);
    let status: SurfaceStatus;
    let harnessName: string | undefined;
    if (p && (p.status === "done" || p.status === "failed" || p.status === "covered")) {
      status = p.status;
      harnessName = p.harnessName;
    } else {
      status = sv.coveredByExisting ? "covered" : "pending";
    }
    out.push({
      id: sv.id,
      title: sv.title,
      apis: sv.apis,
      rationale: sv.rationale,
      priority: sv.priority,
      status,
      harnessName,
      attempts: 0,
    });
  }
  // Keep prior final (done/failed) surfaces the survey did not re-list.
  for (const p of existing) {
    if (!seen.has(p.id) && (p.status === "done" || p.status === "failed")) out.push(p);
  }
  return out;
}

/** Human-readable, timezone-aware run start stamp (e.g. "2026-06-05 16:01:36 UTC"). */
function formatRunTime(ms: number): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  try {
    return new Date(ms).toLocaleString("sv-SE", { timeZone: tz }).replace("T", " ") + " " + tz;
  } catch {
    return new Date(ms).toISOString().replace("T", " ").replace(/\..*/, "") + " UTC";
  }
}

/** The full surveyed surface list (with live statuses) for the entry.html survey table. */
function surveyList(surfaces: AttackSurface[]): SurveySurface[] {
  return surfaces.map((s) => ({ id: s.id, title: s.title, apis: s.apis, priority: s.priority, status: s.status }));
}

function summarize(surfaces: AttackSurface[]): RunState["surfaces"] {
  return surfaces.map((s) => ({
    id: s.id,
    title: s.title,
    status: s.status,
    harnessName: s.harnessName,
    attempts: s.attempts,
  }));
}
