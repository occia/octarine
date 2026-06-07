/** Invoke the `claude` CLI for the two roles: harness generation and crash analysis. */

import * as path from "path";
import * as fs from "fs";
import { Config, AttributionVerdict, SufficiencyVerdict, CoverageStats, AgentStats } from "../types";
import { runStreaming, runCapture } from "../util/proc";
import { mkdirp } from "../util/fs";
import { log } from "../util/log";
import { ANALYSIS_SCHEMA, SURVEY_SCHEMA, ASSESS_SCHEMA, surveyPrompt, assessmentPrompt } from "./prompts";

const ZERO_STATS: AgentStats = { durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };

/** Pull token/cost stats out of a claude result object (json or stream-json result event). */
function extractUsage(obj: Record<string, unknown>): AgentStats {
  const u = (obj.usage ?? {}) as Record<string, number>;
  return {
    durationMs: typeof obj.duration_ms === "number" ? obj.duration_ms : 0,
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
    costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : 0,
  };
}

/**
 * Stats for one generation from its stream-json log. A generation contains several `result` events
 * because the Stop hook re-invokes/continues `claude` until the harness validates (build retries).
 * Crucially, `total_cost_usd` and the token usage are reported CUMULATIVELY for the conversation —
 * each successive result event carries the running total, not that turn's delta. So the generation's
 * real cost/usage is the MAX (last) result event, NOT the sum: summing multiply-counts by the number
 * of turns (a 37-turn gdal generation summed to ~$1167 when it actually cost ~$32).
 */
export function statsFromStreamLog(text: string): AgentStats {
  let best: AgentStats = { durationMs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  let found = false;
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{") || !s.includes('"type":"result"')) continue;
    try {
      const u = extractUsage(JSON.parse(s) as Record<string, unknown>);
      best = {
        durationMs: Math.max(best.durationMs, u.durationMs),
        inputTokens: Math.max(best.inputTokens, u.inputTokens),
        outputTokens: Math.max(best.outputTokens, u.outputTokens),
        costUsd: Math.max(best.costUsd, u.costUsd),
      };
      found = true;
    } catch {
      /* keep scanning */
    }
  }
  return found ? best : ZERO_STATS;
}

/** Unique claude session ids referenced in a stream-json log, in first-seen order. One generation
 *  can span several sessions (the Stop hook re-invokes `claude -p`); each has its own canonical
 *  transcript at ~/.claude/projects/<proj>/<id>.jsonl. */
export function sessionIdsFromStreamLog(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const re = /"session_id"\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      ids.push(m[1]);
    }
  }
  return ids;
}

/**
 * Run one generation session. Real mode spawns `claude -p` (cwd = srcDir, which
 * holds CLAUDE.md + the Stop hook). The agent writes its harness under
 * harness/fuzz-proj and builds via libCRS into buildResp. Returns the run stats
 * plus the session ids touched (so the orchestrator can snapshot the transcripts).
 */
export async function runGeneration(
  c: Config,
  env: NodeJS.ProcessEnv,
  prompt: string,
): Promise<{ stats: AgentStats; sessionIds: string[] }> {
  const systemPrompt =
    `You are an expert fuzzing engineer creating a new coverage-maximizing harness for ` +
    `OSS-Fuzz project \`${c.target}\` (${c.language}). Read and follow CLAUDE.md.`;

  mkdirp(c.paths.agent);
  const logFile = path.join(c.paths.agent, "claude_stdout.log");
  // Truncate per generation: runStreaming appends (so the Stop hook's multiple
  // sessions of THIS generation accumulate), but the file must start empty each
  // call so the snapshot and the summed stats isolate one attempt — otherwise it
  // grows across the whole run and per-attempt time/tokens become cumulative.
  fs.writeFileSync(logFile, "");
  const result = await runStreaming(
    "claude",
    [
      "-p",
      "--verbose",
      "--dangerously-skip-permissions",
      "--output-format", "stream-json",
      "--append-system-prompt", systemPrompt,
    ],
    {
      cwd: c.paths.src,
      env,
      input: prompt,
      logFile,
      timeoutMs: c.budget.genTimeoutSec > 0 ? c.budget.genTimeoutSec * 1000 : 0,
    },
  );
  if (result.timedOut) log.warn("generation timed out — capped by genTimeoutSec", { genTimeoutSec: c.budget.genTimeoutSec });
  log.info("generation session ended", { code: result.code, timedOut: result.timedOut });
  let logText = "";
  try {
    logText = fs.readFileSync(logFile, "utf8");
  } catch {
    /* logFile may not exist if claude never started */
  }
  if (result.code !== 0) {
    // Surface the agent's own output (stream-json goes to logFile) so a failed
    // session is diagnosable from the orchestrator log alone.
    log.warn("generation failed", { stderrTail: result.stderr.slice(-800), outputTail: logText.slice(-2500) });
  }
  return { stats: statsFromStreamLog(logText), sessionIds: sessionIdsFromStreamLog(logText) };
}

/**
 * Root-cause + attribute one crash group. Real mode runs a one-shot
 * `claude -p --output-format json --json-schema ...` in the verifier work dir
 * (no CLAUDE.md / Stop hook there), reading harness + target source.
 */
export async function runAnalysis(
  c: Config,
  env: NodeJS.ProcessEnv,
  groupId: string,
  prompt: string,
): Promise<AttributionVerdict> {
  const r = await runCapture(
    "claude",
    [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format", "json",
      "--json-schema", JSON.stringify(ANALYSIS_SCHEMA),
      "--max-turns", "40",
    ],
    { cwd: c.paths.verifier, env, input: prompt, timeoutMs: 0 },
  );
  return parseAttribution(groupId, r.stdout, r.stderr);
}

function parseAttribution(groupId: string, stdout: string, stderr: string): AttributionVerdict {
  const uncertain = (why: string): AttributionVerdict => ({
    groupId,
    attribution: "uncertain",
    fixLocation: "none",
    explanation: `analysis inconclusive: ${why}`,
  });
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(stdout);
  } catch {
    return uncertain(`unparseable analyzer output (stderr: ${stderr.slice(0, 200)})`);
  }
  const sessionId = typeof obj.session_id === "string" ? obj.session_id : undefined;
  const s = (obj.structured_output ?? obj) as Record<string, unknown>;
  const attribution = s.attribution;
  if (attribution !== "false_positive" && attribution !== "real_bug" && attribution !== "uncertain") {
    return { ...uncertain("missing/invalid attribution field"), sessionId };
  }
  const fixLocation =
    s.fixLocation === "harness" || s.fixLocation === "target" || s.fixLocation === "none"
      ? s.fixLocation
      : "none";
  return {
    groupId,
    attribution,
    fixLocation,
    explanation: typeof s.explanation === "string" ? s.explanation : "",
    suggestedFixDirection: typeof s.suggestedFixDirection === "string" ? s.suggestedFixDirection : undefined,
    sessionId,
  };
}

/**
 * One-shot structured agent: `claude -p --output-format json --json-schema`, free
 * to use tools across turns (cwd = srcDir so it can read the target source), then
 * return validated structured output. Returns null on unparseable output.
 */
async function runStructuredAgent(
  c: Config,
  env: NodeJS.ProcessEnv,
  schema: unknown,
  prompt: string,
  maxTurns: number,
): Promise<{ data: Record<string, unknown> | null; stats: AgentStats; sessionId?: string }> {
  const r = await runCapture(
    "claude",
    [
      "-p",
      "--dangerously-skip-permissions",
      "--output-format", "json",
      "--json-schema", JSON.stringify(schema),
      "--max-turns", String(maxTurns),
    ],
    { cwd: c.paths.src, env, input: prompt, timeoutMs: 0 },
  );
  try {
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    const sessionId = typeof obj.session_id === "string" ? obj.session_id : undefined;
    return { data: (obj.structured_output ?? obj) as Record<string, unknown>, stats: extractUsage(obj), sessionId };
  } catch {
    return { data: null, stats: ZERO_STATS };
  }
}

/** One attack surface as proposed by the Surveyor. */
export interface SurveyedSurface {
  id: string;
  title: string;
  apis: string[];
  rationale: string;
  priority: number;
  coveredByExisting: boolean;
}

function validSurveyed(x: unknown): x is SurveyedSurface {
  const s = x as Record<string, unknown>;
  return (
    !!s &&
    typeof s.id === "string" &&
    typeof s.title === "string" &&
    Array.isArray(s.apis) &&
    typeof s.priority === "number" &&
    typeof s.coveredByExisting === "boolean"
  );
}

/** Surveyor: map the project's attack surfaces (reads target source + existing harnesses). */
export async function runSurvey(
  c: Config,
  env: NodeJS.ProcessEnv,
  existingLedger: string,
): Promise<{ surfaces: SurveyedSurface[]; stats: AgentStats; sessionId?: string }> {
  const { data, stats, sessionId } = await runStructuredAgent(c, env, SURVEY_SCHEMA, surveyPrompt(c, existingLedger), 80);
  const raw = Array.isArray(data?.surfaces) ? (data!.surfaces as unknown[]) : [];
  const surfaces = raw.filter(validSurveyed).map((s) => ({
    id: s.id,
    title: s.title,
    apis: s.apis.map(String),
    rationale: typeof s.rationale === "string" ? s.rationale : "",
    priority: s.priority,
    coveredByExisting: s.coveredByExisting,
  }));
  return { surfaces, stats, sessionId };
}

/** Assessor: judge whether a (correct) harness sufficiently explores its attack surface. */
export async function runAssessment(
  c: Config,
  env: NodeJS.ProcessEnv,
  args: {
    surfaceTitle: string;
    apis: string[];
    harnessName: string;
    harnessSourceDir: string;
    fuzzLogPath: string;
    coverage: CoverageStats;
  },
): Promise<{ verdict: SufficiencyVerdict; stats: AgentStats; sessionId?: string }> {
  const prompt = assessmentPrompt({
    target: c.target,
    surfaceTitle: args.surfaceTitle,
    apis: args.apis,
    harnessName: args.harnessName,
    harnessSourceDir: args.harnessSourceDir,
    targetSourceDir: c.paths.src,
    fuzzLogPath: args.fuzzLogPath,
    coverage: args.coverage,
  });
  const { data, stats, sessionId } = await runStructuredAgent(c, env, ASSESS_SCHEMA, prompt, 40);
  if (!data || typeof data.sufficient !== "boolean") {
    return {
      verdict: {
        sufficient: false,
        reasoning: "assessment inconclusive (unparseable assessor output)",
        feedback: "The assessor could not produce a verdict; re-examine that the harness drives the API meaningfully.",
      },
      stats,
      sessionId,
    };
  }
  return {
    verdict: {
      sufficient: data.sufficient === true,
      reasoning: typeof data.reasoning === "string" ? data.reasoning : "",
      feedback: typeof data.feedback === "string" ? data.feedback : undefined,
    },
    stats,
    sessionId,
  };
}
