/**
 * Run an OSS-Fuzz libFuzzer campaign for one harness and collect crash artifacts
 * + a coverage snapshot (from libFuzzer's own cov/ft counters — no coverage
 * build needed). Also reproduces a single artifact to recover its sanitizer
 * trace for grouping.
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { Config, CoverageStats, RunCtx } from "../types";
import { runStreaming, runCapture } from "../util/proc";
import { mkdirp } from "../util/fs";
import { log } from "../util/log";
import { harnessDir, writeJson } from "../report";

const ARTIFACT_RE = /^(crash|leak|oom|timeout)-/;

/** New harness binary names the agent recorded (one per line). */
export function listNewHarnesses(c: Config): string[] {
  const file = path.join(c.paths.agent, "new-harnesses.txt");
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function forkJobs(c: Config): number {
  if (c.fuzz.forkJobs > 0) return c.fuzz.forkJobs;
  const n = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, n - 1);
}

function listArtifacts(crashDir: string): string[] {
  try {
    return fs
      .readdirSync(crashDir)
      .filter((f) => ARTIFACT_RE.test(f))
      .map((f) => path.join(crashDir, f));
  } catch {
    return [];
  }
}

export interface CampaignResult {
  artifacts: string[];
  coverage: CoverageStats;
}

export async function runCampaign(c: Config, outDir: string, harness: string, ctx: RunCtx): Promise<CampaignResult> {
  // Crash artifacts + fuzz log go to the persisted report dir; corpus stays in the
  // (transient) work dir since it can be large and is not needed for offline analysis.
  const hdir = harnessDir(c, ctx, harness);
  const crashDir = path.join(hdir, "crashes");
  const corpusDir = path.join(c.paths.verifier, "corpus", harness);
  mkdirp(crashDir);
  mkdirp(corpusDir);

  // Seed corpus if the build provided one.
  const seed = path.join(outDir, `${harness}_seed_corpus`);
  if (fs.existsSync(seed)) {
    await runCapture("cp", ["-rn", `${seed}/.`, corpusDir]);
  }

  const cov: CoverageStats = { edges: 0, features: 0, corpusSize: 0 };
  const logFile = path.join(hdir, "fuzz.log");
  const bin = path.join(outDir, harness);

  log.info("fuzzing harness", { harness, attempt: ctx.attempt, sec: c.budget.perFuzzSec, fork: forkJobs(c) });
  const r = await runStreaming(
    bin,
    [
      corpusDir,
      `-artifact_prefix=${crashDir}/`,
      `-max_total_time=${c.budget.perFuzzSec}`,
      `-fork=${forkJobs(c)}`,
      "-ignore_crashes=1",
      "-ignore_timeouts=1",
      "-ignore_ooms=1",
      "-detect_leaks=0",
      "-close_fd_mask=3",
      "-reload=1",
      "-print_final_stats=1",
    ],
    {
      cwd: c.paths.verifier,
      env: process.env,
      logFile,
      timeoutMs: (c.budget.perFuzzSec + 120) * 1000,
      onStderrLine: (line) => updateCoverage(cov, line),
    },
  );
  log.info("campaign ended", { harness, code: r.code, timedOut: r.timedOut, ...cov });
  writeJson(path.join(hdir, "coverage.json"), cov);
  return { artifacts: listArtifacts(crashDir), coverage: cov };
}

/** Parse libFuzzer progress lines (`... cov: N ft: N corp: N/...`) for a coverage snapshot. */
function updateCoverage(cov: CoverageStats, line: string): void {
  const c = line.match(/\bcov:\s*(\d+)/);
  const f = line.match(/\bft:\s*(\d+)/);
  const p = line.match(/\bcorp:\s*(\d+)/);
  if (c) cov.edges = Math.max(cov.edges, parseInt(c[1], 10));
  if (f) cov.features = Math.max(cov.features, parseInt(f[1], 10));
  if (p) cov.corpusSize = Math.max(cov.corpusSize, parseInt(p[1], 10));
}

/** Reproduce a crashing input to recover its sanitizer trace (for grouping). */
export async function reproduceTrace(c: Config, outDir: string, harness: string, artifact: string): Promise<string> {
  const bin = path.join(outDir, harness);
  const r = await runCapture(bin, [artifact], {
    cwd: c.paths.verifier,
    env: { ...process.env, ASAN_OPTIONS: "abort_on_error=1:detect_leaks=0" },
    timeoutMs: 60_000,
  });
  // The reproduction re-triggers the crash; the sanitizer report is on stderr.
  return r.stderr;
}
