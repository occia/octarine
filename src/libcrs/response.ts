/** Parse the files libCRS writes into a response directory. */

import * as path from "path";
import { readFileOr } from "../util/fs";

export interface BuildResult {
  /** Build exit code from response-dir/retcode (0 = success). 1 if missing. */
  retcode: number;
  /** Present on a successful build; needed to fetch the freshly-built $OUT. */
  rebuildId?: string;
  stdoutLog: string;
  stderrLog: string;
  responseDir: string;
}

export interface RunPovResult {
  /** 0 = no crash; non-zero = sanitizer caught a crash. */
  retcode: number;
  stdoutLog: string;
  stderrLog: string;
}

function readRetcode(dir: string): number {
  const raw = readFileOr(path.join(dir, "retcode"), "").trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : 1;
}

export function readBuildResponse(responseDir: string): BuildResult {
  const rebuildId = readFileOr(path.join(responseDir, "rebuild_id"), "").trim();
  return {
    retcode: readRetcode(responseDir),
    rebuildId: rebuildId || undefined,
    stdoutLog: readFileOr(path.join(responseDir, "stdout.log"), ""),
    stderrLog: readFileOr(path.join(responseDir, "stderr.log"), ""),
    responseDir,
  };
}

export function readPovResponse(responseDir: string): RunPovResult {
  return {
    retcode: readRetcode(responseDir),
    stdoutLog: readFileOr(path.join(responseDir, "stdout.log"), ""),
    stderrLog: readFileOr(path.join(responseDir, "stderr.log"), ""),
  };
}
