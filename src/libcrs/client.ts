/**
 * Typed wrapper over the `libCRS` CLI (invoked as a subprocess).
 *
 * The `runner` is injectable so the client can be unit-tested by asserting argv.
 * Commands that exit with a build/pov code
 * (build-project, run-pov) never throw — callers read the parsed response dir.
 * Pure I/O commands throw on a non-zero exit.
 */

import { ProcRunner, runCapture } from "../util/proc";
import { mkdirp } from "../util/fs";
import { BuildResult, RunPovResult, readBuildResponse, readPovResponse } from "./response";

export interface BuildProjectArgs {
  responseDir: string;
  fuzzProjDir?: string;
  targetSourceDir?: string;
}

export interface RunPovArgs {
  povFile: string;
  responseDir: string;
  harness: string;
  rebuildId?: string;
}

export interface SubmitHarnessArgs {
  fuzzProjDir: string;
  targetSourceDir?: string;
  name?: string;
}

export interface LibCrs {
  downloadSource(kind: "fuzz-proj" | "target-source", dst: string): Promise<void>;
  downloadBuildOutput(srcPath: string, dst: string, rebuildId?: string): Promise<void>;
  buildProject(args: BuildProjectArgs): Promise<BuildResult>;
  runPov(args: RunPovArgs): Promise<RunPovResult>;
  submitHarness(args: SubmitHarnessArgs): Promise<void>;
  registerLogDir(dir: string): Promise<void>;
}

const BIN = "libCRS";

export function makeLibCrs(runner: ProcRunner = runCapture): LibCrs {
  async function io(args: string[]): Promise<void> {
    const r = await runner(BIN, args);
    if (r.code !== 0) {
      throw new Error(`libCRS ${args[0]} failed (code ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`);
    }
  }

  return {
    downloadSource: (kind, dst) => {
      mkdirp(dst);
      return io(["download-source", kind, dst]);
    },

    downloadBuildOutput: (srcPath, dst, rebuildId) => {
      mkdirp(dst);
      const args = ["download-build-output", srcPath, dst];
      if (rebuildId) args.push("--rebuild-id", rebuildId);
      return io(args);
    },

    buildProject: async ({ responseDir, fuzzProjDir, targetSourceDir }) => {
      mkdirp(responseDir);
      const args = ["build-project", "--response-dir", responseDir];
      if (fuzzProjDir) args.push("--fuzz-proj-dir", fuzzProjDir);
      if (targetSourceDir) args.push("--target-source-dir", targetSourceDir);
      // build-project exits with the build code; the response dir is authoritative.
      await runner(BIN, args);
      return readBuildResponse(responseDir);
    },

    runPov: async ({ povFile, responseDir, harness, rebuildId }) => {
      mkdirp(responseDir);
      const args = ["run-pov", povFile, responseDir, "--harness", harness];
      if (rebuildId) args.push("--rebuild-id", rebuildId);
      await runner(BIN, args);
      return readPovResponse(responseDir);
    },

    submitHarness: ({ fuzzProjDir, targetSourceDir, name }) => {
      const args = ["submit-harness", "--fuzz-proj-dir", fuzzProjDir];
      if (targetSourceDir) args.push("--target-source-dir", targetSourceDir);
      if (name) args.push("--name", name);
      return io(args);
    },

    registerLogDir: (dir) => io(["register-log-dir", dir]),
  };
}
