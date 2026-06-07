/** Resolve a typed Config from the environment the OSS-CRS framework injects. */

import * as fs from "fs";
import * as path from "path";
import { Config, Language } from "../types";

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function envBool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return def;
  return raw === "1" || raw.toLowerCase() === "true";
}

function readLlmKey(): string {
  const file = process.env.OSS_CRS_LLM_API_KEY_FILE;
  if (file) {
    try {
      return fs.readFileSync(file, "utf8").trim();
    } catch {
      /* fall through */
    }
  }
  return process.env.OSS_CRS_LLM_API_KEY ?? "";
}

export function loadConfig(): Config {
  const work = process.env.HARNESS_GEN_WORK_DIR ?? "/work";
  const src = process.env.HARNESS_GEN_SRC_DIR ?? "/src";
  const harness = path.join(work, "harness-proj");
  const agent = path.join(work, "agent");
  const verifier = path.join(work, "verifier");
  // Persist the run report to the framework's mounted log dir when present, so it
  // survives the container; fall back to the (scratch) work dir for local dev.
  const report = process.env.OSS_CRS_LOG_DIR
    ? path.join(process.env.OSS_CRS_LOG_DIR, "report")
    : path.join(work, "report");

  const lang = (process.env.FUZZING_LANGUAGE ?? "c").toLowerCase();
  const language: Language = lang === "c++" || lang === "cpp" ? "c++" : lang === "jvm" ? "jvm" : "c";

  return {
    target: process.env.OSS_CRS_TARGET ?? "",
    language,
    sanitizer: process.env.SANITIZER ?? "address",
    llmApiUrl: process.env.OSS_CRS_LLM_API_URL ?? "",
    llmApiKey: readLlmKey(),
    oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
    paths: {
      work,
      src,
      harness,
      agent,
      verifier,
      state: path.join(verifier, "state.json"),
      buildResp: path.join(agent, "build-resp"),
      report,
    },
    budget: {
      maxWallTimeSec: envInt("HARNESS_GEN_MAX_WALLTIME_SEC", 0),
      perFuzzSec: envInt("HARNESS_GEN_FUZZ_SEC", 180),
      maxSurfaceAttempts: envInt("HARNESS_GEN_MAX_SURFACE_ATTEMPTS", 5),
      maxCostUsd: Number(process.env.HARNESS_GEN_MAX_COST_USD ?? 0) || 0, // USD; 0 = no cost cap
      genTimeoutSec: envInt("HARNESS_GEN_GEN_TIMEOUT_SEC", 0), // per-generation wall cap; 0 = unbounded
    },
    fuzz: {
      forkJobs: envInt("HARNESS_GEN_FORK_JOBS", 0),
    },
    analysisConcurrency: envInt("HARNESS_GEN_ANALYSIS_CONCURRENCY", 3),
    treatUncertainAsDirty: envBool("HARNESS_GEN_TREAT_UNCERTAIN_DIRTY", true),
  };
}
