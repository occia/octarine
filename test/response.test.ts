import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readBuildResponse, readPovResponse } from "../src/libcrs/response";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "resp-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("response parsing", () => {
  it("reads a successful build response", () => {
    fs.writeFileSync(path.join(dir, "retcode"), "0\n");
    fs.writeFileSync(path.join(dir, "rebuild_id"), "42\n");
    fs.writeFileSync(path.join(dir, "stderr.log"), "warn\n");
    const r = readBuildResponse(dir);
    expect(r.retcode).toBe(0);
    expect(r.rebuildId).toBe("42");
    expect(r.stderrLog).toContain("warn");
  });

  it("defaults to retcode 1 and no rebuildId when missing", () => {
    const r = readBuildResponse(dir);
    expect(r.retcode).toBe(1);
    expect(r.rebuildId).toBeUndefined();
  });

  it("reads a pov response retcode", () => {
    fs.writeFileSync(path.join(dir, "retcode"), "1");
    expect(readPovResponse(dir).retcode).toBe(1);
  });
});
