/**
 * Run report: organize every observable artifact of a run under one mounted
 * directory (OSS_CRS_LOG_DIR/report) so a finished run can be analyzed offline.
 *
 *   report/
 *     run.jsonl                                  full orchestrator timeline
 *     summary.md                                 human-readable run summary
 *     state.json                                 final RunState
 *     ledger/                                    snapshot of the attack-surface ledger md set
 *     surface-<id>/attempt-<n>/
 *       generation.log                           the agent's `claude -p` session stream
 *       build-resp/                              retcode, rebuild_id, build stdout/stderr
 *       verdict.json                             correctness verdict + findings
 *       assessment.json                          sufficiency verdict (when reached)
 *       crash-groups.json / attributions.json    (only if crashes)
 *       harness-<name>/
 *         fuzz.log                               libFuzzer output
 *         coverage.json                          edges / features / corpus
 *         crashes/  + crash-<groupId>.trace      (only if crashes)
 *
 * All writes are best-effort: report bookkeeping must never fail the run.
 */

import * as path from "path";
import * as fs from "fs";
import { Config, RunState, RunCtx } from "./types";
import { mkdirp, writeFileAtomic, copyDirContents } from "./util/fs";
import { loadSessionsJsonl, writeTranscriptFiles, renderMarkdownFile, renderMarkdownTree } from "./transcript";
import { sourceIdentityMd } from "./util/version";

const slug = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 80) || "x";

export function surfaceDir(c: Config, surfaceId: string): string {
  return path.join(c.paths.report, `surface-${slug(surfaceId)}`);
}

export function surveyDir(c: Config): string {
  return path.join(c.paths.report, "survey");
}

/**
 * Snapshot an agent's Claude-Code conversation into the report: load the canonical session
 * transcript(s) from ~/.claude/projects, write `<name>.jsonl` (raw) + `<name>.html` (rendered)
 * into destDirAbs, and return the report-relative path to the rendered html (or undefined when
 * no transcript was found). Best-effort — never throws.
 */
export function snapshotTranscript(
  c: Config,
  sessionIds: string[],
  destDirAbs: string,
  name: string,
  title: string,
): string | undefined {
  try {
    const ids = (sessionIds ?? []).filter(Boolean);
    if (!ids.length) return undefined;
    const jsonl = loadSessionsJsonl(ids);
    if (!writeTranscriptFiles(destDirAbs, name, jsonl, title)) return undefined;
    return path.relative(c.paths.report, path.join(destDirAbs, `${name}.html`));
  } catch {
    return undefined;
  }
}

export function attemptDir(c: Config, ctx: RunCtx): string {
  return path.join(surfaceDir(c, ctx.surfaceId), `attempt-${ctx.attempt}`);
}

export function harnessDir(c: Config, ctx: RunCtx, harness: string): string {
  return path.join(attemptDir(c, ctx), `harness-${harness}`);
}

/** Report-relative path of an attempt dir (for entry.html links). */
export function attemptRel(ctx: RunCtx): string {
  return `surface-${slug(ctx.surfaceId)}/attempt-${ctx.attempt}`;
}

/** Copy the submitted candidate (fuzz-proj) into the report so the folder is self-contained.
 *  Returns the report-relative dir, or undefined on failure. */
export function snapshotSubmitted(c: Config, surfaceId: string): string | undefined {
  const rel = `surface-${slug(surfaceId)}/submitted`;
  try {
    copyDirContents(path.join(c.paths.harness, "fuzz-proj"), path.join(c.paths.report, rel));
    return rel;
  } catch {
    return undefined;
  }
}

export function writeJson(file: string, obj: unknown): void {
  try {
    writeFileAtomic(file, JSON.stringify(obj, null, 2) + "\n");
  } catch {
    /* best-effort */
  }
}

export function writeText(file: string, text: string): void {
  try {
    writeFileAtomic(file, text);
  } catch {
    /* best-effort */
  }
}

/** Snapshot the agent's generation stdout + build response into the attempt dir. */
export function snapshotGeneration(c: Config, ctx: RunCtx): void {
  const rd = attemptDir(c, ctx);
  try {
    const gen = path.join(c.paths.agent, "claude_stdout.log");
    if (fs.existsSync(gen)) {
      mkdirp(rd);
      fs.copyFileSync(gen, path.join(rd, "generation.log"));
    }
    if (fs.existsSync(c.paths.buildResp)) {
      copyDirContents(c.paths.buildResp, path.join(rd, "build-resp"));
    }
  } catch {
    /* best-effort */
  }
}

/** Copy the live ledger md set into the report and render each .md to a sibling .html
 *  (so the ledger is browsable offline instead of opening as raw text). */
export function snapshotLedger(c: Config, ledgerDirPath: string): void {
  try {
    if (!fs.existsSync(ledgerDirPath)) return;
    const dst = path.join(c.paths.report, "ledger");
    copyDirContents(ledgerDirPath, dst);
    renderMarkdownTree(dst);
  } catch {
    /* best-effort */
  }
}

/** Write a human-readable run summary from the final state. */
export function writeSummary(c: Config, state: RunState): void {
  const elapsedMin = ((state.updatedAtMs - state.startedAtMs) / 60000).toFixed(1);
  const byStatus = (st: string) => state.surfaces.filter((s) => s.status === st).length;
  const rows = state.surfaces
    .map((s) => `| ${s.id} | ${s.status} | ${s.harnessName ?? "-"} | ${s.attempts} | ${s.title.replace(/\|/g, "/")} |`);
  const lines = [
    `# octarine run report`,
    ``,
    `- source: ${sourceIdentityMd(state.target, state.commit, state.sourceVersion, true)}`,
    `- language: ${c.language}   sanitizer: ${c.sanitizer}`,
    `- budget: perFuzzSec=${c.budget.perFuzzSec} maxWallTimeSec=${c.budget.maxWallTimeSec} maxSurfaceAttempts=${c.budget.maxSurfaceAttempts}`,
    `- elapsed: ${elapsedMin} min`,
    `- surfaces: ${state.surfaces.length} (done=${byStatus("done")} pending=${byStatus("pending")} failed=${byStatus("failed")} covered=${byStatus("covered")})`,
    `- harnesses submitted: ${state.submittedCount}`,
    ``,
    `## Surfaces`,
    `| id | status | harness | attempts | title |`,
    `|---|---|---|---|---|`,
    ...rows,
    ``,
    `## Layout`,
    `- run.jsonl                          full orchestrator timeline`,
    `- state.json                         final RunState`,
    `- ledger/                            attack-surface ledger md set`,
    `- surface-<id>/attempt-<n>/          generation.log, build-resp/, verdict.json, assessment.json`,
    `- surface-<id>/attempt-<n>/harness-<name>/   fuzz.log, coverage.json, crashes/, crash-*.trace`,
    ``,
  ];
  const mdPath = path.join(c.paths.report, "summary.md");
  writeText(mdPath, lines.join("\n"));
  renderMarkdownFile(mdPath, `${state.target} — run summary`); // also write summary.html (browsable)
}
