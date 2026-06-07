/** Drive one root-cause + attribution sub-agent per crash group (bounded concurrency). */

import * as path from "path";
import { AttributionVerdict, Config, CrashGroup } from "../types";
import { mapLimit } from "../util/proc";
import { runAnalysis } from "../agent/claude";
import { analysisPrompt } from "../agent/prompts";
import { log } from "../util/log";

export interface GroupAnalysisInput {
  group: CrashGroup;
  /** Harness binary whose representative artifact we analyze. */
  harness: string;
  /** Sanitizer trace of the representative artifact. */
  trace: string;
}

export function analyzeGroups(
  c: Config,
  env: NodeJS.ProcessEnv,
  inputs: GroupAnalysisInput[],
): Promise<AttributionVerdict[]> {
  return mapLimit(inputs, c.analysisConcurrency, async ({ group, harness, trace }) => {
    const prompt = analysisPrompt({
      target: c.target,
      harnessName: harness,
      harnessSourceDir: path.join(c.paths.harness, "fuzz-proj"),
      targetSourceDir: c.paths.src,
      crashInputPath: group.artifacts[0],
      asanTrace: trace,
    });
    const verdict = await runAnalysis(c, env, group.id, prompt);
    log.info("crash group analyzed", {
      group: group.id,
      attribution: verdict.attribution,
      fixLocation: verdict.fixLocation,
    });
    return verdict;
  });
}
