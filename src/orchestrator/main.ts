/**
 * Entrypoint for the harness-gen run phase.
 *
 *   config → log dirs → reference source → Claude setup (CLAUDE.md + Stop hook)
 *   → derive (target, commit) → explore attack surfaces until the budget is spent.
 *
 * The exploration loop submits each surface's harness once it is both correct
 * (no false-positive crashes) and sufficient (thoroughly exercises the surface).
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { loadConfig } from "./config";
import { setupSource, readSourceVersion } from "./source";
import { runExploration } from "./explore-loop";
import { makeLibCrs } from "../libcrs/client";
import { buildClaudeEnv, writeClaudeJson, setupGlobalGitignore, writeStopHookSettings } from "../agent/claude-env";
import { renderClaudeMd } from "../agent/prompts";
import { mkdirp } from "../util/fs";
import { log, initLogFile } from "../util/log";
import { writeSummary, writeJson } from "../report";
import { deriveCommit, readProjectMeta } from "../ledger";

async function main(): Promise<void> {
  const c = loadConfig();

  for (const d of [c.paths.work, c.paths.agent, c.paths.verifier, c.paths.harness, c.paths.src, c.paths.report]) {
    mkdirp(d);
  }
  // Mirror the structured log into the persisted report before anything else runs.
  initLogFile(path.join(c.paths.report, "run.jsonl"));

  log.info("harness-gen starting", {
    target: c.target,
    language: c.language,
    sanitizer: c.sanitizer,
    budget: c.budget,
  });

  const libcrs = makeLibCrs();

  for (const d of [path.join(os.homedir(), ".claude"), c.paths.agent]) {
    try {
      await libcrs.registerLogDir(d);
    } catch (e) {
      log.warn("registerLogDir failed", { dir: d, error: String(e) });
    }
  }
  if (!(await setupSource(libcrs, c.paths.src))) {
    log.error("source setup failed");
    process.exit(1);
  }

  // Claude Code setup: auth env, trust config, CLAUDE.md + Stop hook in the session cwd.
  writeClaudeJson(c.paths.src);
  setupGlobalGitignore();
  const env = buildClaudeEnv(c);
  fs.writeFileSync(path.join(c.paths.src, "CLAUDE.md"), renderClaudeMd(c));
  writeStopHookSettings(c.paths.src, path.join(__dirname, "..", "hooks", "stop-gate.js"));

  const commit = await deriveCommit(c.paths.src);
  const { projectId, mainRepo } = await readProjectMeta(libcrs, c);
  // Real upstream branch+commit (captured at build time, before libCRS stripped .git); display-only.
  const sourceVersion = readSourceVersion(c.paths.src, mainRepo);
  log.info("target version", { target: c.target, projectId, commit, sourceVersion });

  const state = await runExploration(c, libcrs, env, commit, projectId, sourceVersion);

  // Persist the final state + a human-readable summary for offline analysis.
  writeJson(path.join(c.paths.report, "state.json"), state);
  writeSummary(c, state);
  log.info("done", { surfaces: state.surfaces.length, submitted: state.submittedCount });
}

main().catch((e) => {
  log.error("fatal", { error: String(e), stack: e instanceof Error ? e.stack : undefined });
  process.exit(1);
});
