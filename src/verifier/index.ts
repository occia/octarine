/**
 * Verify one candidate harness: ensure a green build (with a known rebuild_id),
 * fuzz each new harness, group crashes, attribute each group, and decide the
 * verdict. This is the heart of the CRS — it runs in the orchestrator process.
 */

import * as path from "path";
import * as fs from "fs";
import { Config, CoverageStats, VerifierVerdict, RunCtx } from "../types";
import { LibCrs } from "../libcrs/client";
import { readBuildResponse } from "../libcrs/response";
import { dirHasNonEmptyFile } from "../util/fs";
import { log } from "../util/log";
import { listNewHarnesses, runCampaign, reproduceTrace } from "./fuzz-runner";
import { parseSanitizerStderr } from "./crash-parser";
import { CrashItem, groupCrashes } from "./crash-grouping";
import { analyzeGroups, GroupAnalysisInput } from "./analysis";
import { decideVerdict } from "./verdict";
import { attemptDir, harnessDir, writeJson, writeText } from "../report";

/** Obtain a green build + a known rebuild_id, preferring the agent's build, else self-rebuilding. */
async function buildGate(c: Config, libcrs: LibCrs): Promise<{ rebuildId?: string; buildFailed: boolean }> {
  const agentBuild = readBuildResponse(c.paths.buildResp);
  if (agentBuild.retcode === 0 && agentBuild.rebuildId) {
    return { rebuildId: agentBuild.rebuildId, buildFailed: false };
  }

  const fuzzProj = path.join(c.paths.harness, "fuzz-proj");
  if (!dirHasNonEmptyFile(fuzzProj)) return { buildFailed: true };
  const targetSrc = path.join(c.paths.harness, "target-source");

  log.info("build-gate: self-rebuilding candidate for a known rebuild_id");
  const resp = await libcrs.buildProject({
    responseDir: path.join(c.paths.verifier, "build-resp"),
    fuzzProjDir: fuzzProj,
    targetSourceDir: dirHasNonEmptyFile(targetSrc) ? targetSrc : undefined,
  });
  if (resp.retcode === 0 && resp.rebuildId) return { rebuildId: resp.rebuildId, buildFailed: false };
  return { buildFailed: true };
}

function mergeCoverage(a: CoverageStats | undefined, b: CoverageStats): CoverageStats {
  if (!a) return b;
  return {
    edges: Math.max(a.edges, b.edges),
    features: Math.max(a.features, b.features),
    corpusSize: Math.max(a.corpusSize, b.corpusSize),
  };
}

export async function verify(
  c: Config,
  libcrs: LibCrs,
  env: NodeJS.ProcessEnv,
  ctx: RunCtx,
): Promise<VerifierVerdict> {
  const fuzzProj = path.join(c.paths.harness, "fuzz-proj");

  const gate = await buildGate(c, libcrs);
  if (gate.buildFailed || !gate.rebuildId) {
    return decideVerdict({ groups: [], groupsMeta: [], round: ctx.attempt, buildFailed: true, hadHarness: dirHasNonEmptyFile(fuzzProj), treatUncertainAsDirty: c.treatUncertainAsDirty });
  }

  const outDir = path.join(c.paths.verifier, "out");
  await libcrs.downloadBuildOutput("build", outDir, gate.rebuildId);

  const harnesses = listNewHarnesses(c).filter((h) => fs.existsSync(path.join(outDir, h)));
  if (harnesses.length === 0) {
    log.warn("no new harness binaries found to fuzz", { outDir });
    return decideVerdict({ groups: [], groupsMeta: [], round: ctx.attempt, buildFailed: false, hadHarness: false, treatUncertainAsDirty: c.treatUncertainAsDirty });
  }

  const items: CrashItem[] = [];
  const traceByArtifact = new Map<string, string>();
  const harnessByArtifact = new Map<string, string>();
  let coverage: CoverageStats | undefined;

  for (const h of harnesses) {
    const res = await runCampaign(c, outDir, h, ctx);
    coverage = mergeCoverage(coverage, res.coverage);
    for (const artifact of res.artifacts) {
      const trace = await reproduceTrace(c, outDir, h, artifact);
      const sig = parseSanitizerStderr(trace);
      if (!sig) continue;
      items.push({ sig, artifact, tsMs: Date.now() });
      traceByArtifact.set(artifact, trace);
      harnessByArtifact.set(artifact, h);
    }
  }

  const groups = groupCrashes(items);
  log.info("fuzzing complete", { harnesses: harnesses.length, crashGroups: groups.length, ...(coverage ?? {}) });

  // Persist each group's reproduced sanitizer trace + the grouped signatures.
  for (const g of groups) {
    const h = harnessByArtifact.get(g.artifacts[0])!;
    writeText(path.join(harnessDir(c, ctx, h), `crash-${g.id}.trace`), traceByArtifact.get(g.artifacts[0]) ?? "");
  }
  if (groups.length) writeJson(path.join(attemptDir(c, ctx), "crash-groups.json"), groups);

  const inputs: GroupAnalysisInput[] = groups.map((g) => ({
    group: g,
    harness: harnessByArtifact.get(g.artifacts[0])!,
    trace: traceByArtifact.get(g.artifacts[0])!,
  }));
  const attributions = inputs.length ? await analyzeGroups(c, env, inputs) : [];
  if (attributions.length) writeJson(path.join(attemptDir(c, ctx), "attributions.json"), attributions);

  return decideVerdict({
    groups: attributions,
    groupsMeta: groups,
    coverage,
    round: ctx.attempt,
    buildFailed: false,
    hadHarness: true,
    treatUncertainAsDirty: c.treatUncertainAsDirty,
  });
}
