import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runStreaming, runCapture } from "../src/util/proc";

let tmp: string;
beforeEach(() => (tmp = fs.mkdtempSync(path.join(os.tmpdir(), "proc-"))));
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("runStreaming", () => {
  // Regression: runStreaming must forward `input` to the child's stdin, the same
  // way runCapture does. The generation agent (`claude -p`) reads its prompt from
  // stdin; dropping it makes claude exit with "no stdin data received".
  it("forwards input to child stdin", async () => {
    const logFile = path.join(tmp, "out.log");
    const r = await runStreaming("cat", [], { input: "hello-stdin\n", logFile });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(logFile, "utf8")).toContain("hello-stdin");
  });

  it("streams stdout to the log file", async () => {
    const logFile = path.join(tmp, "out.log");
    const r = await runStreaming("sh", ["-c", "echo streamed-line"], { logFile });
    expect(r.code).toBe(0);
    expect(fs.readFileSync(logFile, "utf8")).toContain("streamed-line");
  });

  it("invokes onStderrLine per stderr line", async () => {
    const logFile = path.join(tmp, "out.log");
    const lines: string[] = [];
    await runStreaming("sh", ["-c", "echo a 1>&2; echo b 1>&2"], {
      logFile,
      onStderrLine: (l) => lines.push(l),
    });
    expect(lines).toContain("a");
    expect(lines).toContain("b");
  });
});

describe("runCapture", () => {
  it("captures stdout and forwards stdin", async () => {
    const r = await runCapture("cat", [], { input: "echoed" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("echoed");
  });
});
