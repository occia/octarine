import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeLibCrs } from "../src/libcrs/client";
import { ProcRunner, RunResult } from "../src/util/proc";

function recorder(write?: (args: string[]) => void): { calls: string[][]; runner: ProcRunner } {
  const calls: string[][] = [];
  const runner: ProcRunner = async (_cmd, args): Promise<RunResult> => {
    calls.push(args);
    if (write) write(args);
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
  return { calls, runner };
}

let tmp: string;
beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lc-"))));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("libCRS client argv", () => {
  it("builds download-build-output with --rebuild-id", async () => {
    const { calls, runner } = recorder();
    await makeLibCrs(runner).downloadBuildOutput("build", path.join(tmp, "out"), "42");
    expect(calls[0]).toEqual(["download-build-output", "build", path.join(tmp, "out"), "--rebuild-id", "42"]);
  });

  it("builds build-project argv and parses the response dir", async () => {
    const rd = path.join(tmp, "resp");
    const { calls, runner } = recorder(() => {
      fs.writeFileSync(path.join(rd, "retcode"), "0");
      fs.writeFileSync(path.join(rd, "rebuild_id"), "7");
    });
    const res = await makeLibCrs(runner).buildProject({ responseDir: rd, fuzzProjDir: "/fp" });
    expect(calls[0]).toEqual(["build-project", "--response-dir", rd, "--fuzz-proj-dir", "/fp"]);
    expect(res).toMatchObject({ retcode: 0, rebuildId: "7" });
  });

  it("builds submit-harness argv with optional name", async () => {
    const { calls, runner } = recorder();
    await makeLibCrs(runner).submitHarness({ fuzzProjDir: "/fp", name: "proj" });
    expect(calls[0]).toEqual(["submit-harness", "--fuzz-proj-dir", "/fp", "--name", "proj"]);
  });

  it("throws on a non-zero pure-IO command", async () => {
    const failing: ProcRunner = async () => ({ code: 2, stdout: "", stderr: "boom", timedOut: false });
    await expect(makeLibCrs(failing).downloadSource("fuzz-proj", path.join(tmp, "fp"))).rejects.toThrow(/boom/);
  });
});
